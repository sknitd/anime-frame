#!/usr/bin/env python3
"""Local server for Anime Frame.

Serves this folder on http://localhost:8000 and:
- keeps up to 5 Decart API keys in .env (DECART_API_KEY, DECART_API_KEY_2 .. _5) and mints
  short-lived client tokens at /api/decart-token, trying the keys in order, so permanent keys
  never reach the browser;
- converts uploaded videos the browser can't play (AVI, WMV, MKV, ProRes, ...) to H.264 MP4
  with ffmpeg at /api/convert;
- saves recordings from the page to ~/Downloads as MP4 at /api/save-recording.
Nothing is sent anywhere except the token requests to Decart.
"""
import http.server
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV = ROOT / ".env"
PORT = int(os.environ.get("PORT", "8000"))
MODELS = ["lucy-restyle-2", "lucy-2.5"]   # standard restyle, and fast mode
KEY_NAMES = ["DECART_API_KEY"] + [f"DECART_API_KEY_{i}" for i in range(2, 6)]
KEY_RE = re.compile(r"^[A-Za-z0-9_.\-]{8,300}$")
MAX_UPLOAD = 4 << 30                      # 4 GB
env_lock = threading.Lock()


def read_env():
    values, lines = {}, []
    if ENV.exists():
        lines = ENV.read_text().splitlines()
        for line in lines:
            name, sep, value = line.partition("=")
            if sep:
                values[name.strip()] = value.strip().strip("\"'")
    return values, lines


def read_keys():
    with env_lock:
        values, _ = read_env()
    keys = [values.get(n, "") for n in KEY_NAMES]
    if not any(keys) and os.environ.get("DECART_API_KEY"):
        keys[0] = os.environ["DECART_API_KEY"].strip()
    return keys


def write_keys(keys):
    with env_lock:
        _, lines = read_env()
        kept = [l for l in lines if l.partition("=")[0].strip() not in KEY_NAMES]
        ENV.write_text("\n".join(kept + [f"{n}={k}" for n, k in zip(KEY_NAMES, keys) if k]) + "\n")
        os.chmod(ENV, 0o600)


def masked(key):
    return f"{key[:9]}…{key[-4:]}" if key else ""


class MintError(Exception):
    pass


def mint(key, origin):
    """Exchange a permanent key for a 5-minute client token limited to our models and this page."""
    body = json.dumps({"expiresIn": 300, "allowedModels": MODELS, "allowedOrigins": [origin]}).encode()
    req = urllib.request.Request(
        "https://api.decart.ai/v1/client/tokens", data=body, method="POST",
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        raise MintError(f"{e.code} {e.read().decode(errors='replace')[:200]}")
    except Exception as e:  # network / TLS problems
        raise MintError(str(e))


def downloads_target(ext):
    folder = Path.home() / "Downloads"
    folder.mkdir(exist_ok=True)
    stem = "anime-frame-" + time.strftime("%Y-%m-%d_%H-%M-%S")
    path, n = folder / f"{stem}.{ext}", 2
    while path.exists():
        path, n = folder / f"{stem}-{n}.{ext}", n + 1
    return path


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def local(self):
        # only answer requests addressed to this machine (blocks DNS-rebinding pages)
        return (self.headers.get("Host") or "").rsplit(":", 1)[0] in ("localhost", "127.0.0.1")

    def origin(self):
        return f"http://{self.headers.get('Host')}"

    def do_GET(self):
        if not self.local():
            return self.send_error(403)
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/decart-token":
            return self.token(int((urllib.parse.parse_qs(url.query).get("from") or ["0"])[0] or 0))
        if url.path == "/api/keys":
            return self.json(200, self.key_list())
        # never serve the key file, other dotfiles, or this script
        if any(part.startswith(".") for part in url.path.split("/")) or url.path.endswith(".py"):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        # only the page itself may call these: same origin, plus a custom header that other sites
        # can't send without a CORS preflight (which this server never approves)
        sent_origin = self.headers.get("Origin")
        if not self.local() or (sent_origin and sent_origin != self.origin()) or self.headers.get("X-Anime-Frame") != "1":
            return self.send_error(403)
        url = urllib.parse.urlparse(self.path)
        routes = {"/api/convert": self.convert, "/api/keys": self.save_keys, "/api/keys/test": self.test_key,
                  "/api/save-recording": self.save_recording}
        if url.path in routes:
            return routes[url.path]()
        return self.send_error(404)

    # ---------- Decart keys ----------
    def key_list(self):
        return {"keys": [{"index": i, "set": bool(k), "masked": masked(k)} for i, k in enumerate(read_keys())]}

    def token(self, start):
        keys = read_keys()
        if not any(keys):
            return self.json(500, {"error": "no Decart API key set (open ⚙ Decart keys)"})
        errors = []
        for i in range(max(0, start), len(keys)):
            if not keys[i]:
                continue
            try:
                tok = mint(keys[i], self.origin())
                return self.json(200, {"apiKey": tok["apiKey"], "expiresAt": tok.get("expiresAt"), "index": i})
            except MintError as e:
                errors.append(f"key {i + 1}: {e}")
        return self.json(502, {"error": "; ".join(errors) or "no more keys to try", "exhausted": True})

    def save_keys(self):
        body = self.read_json()
        if body is None:
            return self.json(400, {"error": "bad request"})
        keys = read_keys()
        for idx, key in (body.get("set") or {}).items():
            i, key = int(idx), str(key).strip()
            if not 0 <= i < len(keys) or not KEY_RE.match(key):
                return self.json(400, {"error": f"key {int(idx) + 1} doesn't look like an API key"})
            keys[i] = key
        for i in body.get("remove") or []:
            if 0 <= int(i) < len(keys):
                keys[int(i)] = ""
        write_keys(keys)
        return self.json(200, self.key_list())

    def test_key(self):
        body = self.read_json() or {}
        i = int(body.get("index", -1))
        keys = read_keys()
        if not 0 <= i < len(keys) or not keys[i]:
            return self.json(400, {"ok": False, "error": "no key saved in this slot"})
        try:
            tok = mint(keys[i], self.origin())
            return self.json(200, {"ok": True, "apiKey": tok["apiKey"], "index": i})
        except MintError as e:
            return self.json(200, {"ok": False, "error": f"token request failed: {e}"})

    # ---------- video files ----------
    def receive(self, folder, name):
        """Stream the request body to a file (uploads can be large)."""
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_UPLOAD:
            return None
        path = Path(folder) / name
        with open(path, "wb") as f:
            left = length
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        return path

    def ffmpeg(self, src, dst, extra):
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return "ffmpeg isn't installed (brew install ffmpeg), then restart serve.py"
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-map", "0:v:0", "-an", "-sn",
               *extra, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", str(dst)]
        try:
            run = subprocess.run(cmd, capture_output=True, timeout=1800)
        except subprocess.TimeoutExpired:
            return "conversion took longer than 30 minutes"
        if run.returncode != 0 or not Path(dst).exists():
            why = run.stderr.decode(errors="replace").strip().splitlines()
            return "ffmpeg could not read this file: " + (why[-1] if why else "unknown error")
        return None

    def convert(self):
        suffix = Path(urllib.parse.unquote(self.headers.get("X-Filename") or "")).suffix[:12]
        with tempfile.TemporaryDirectory(prefix="anime-frame-") as tmp:
            src = self.receive(tmp, f"input{suffix}")
            if not src:
                return self.json(413, {"error": "video is empty or larger than 4 GB"})
            dst = Path(tmp) / "output.mp4"
            # first video stream only, fit within 1280x1280 (never upscale), H.264 that every browser plays
            err = self.ffmpeg(src, dst, ["-vf", "scale='min(iw,1280)':'min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2"])
            if err:
                return self.json(415, {"error": err})
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(dst.stat().st_size))
            self.end_headers()
            with open(dst, "rb") as f:
                shutil.copyfileobj(f, self.wfile)

    def save_recording(self):
        ext = re.sub(r"[^a-z0-9]", "", (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("ext") or ["webm"])[0])[:5] or "webm"
        with tempfile.TemporaryDirectory(prefix="anime-frame-rec-") as tmp:
            src = self.receive(tmp, f"recording.{ext}")
            if not src:
                return self.json(413, {"error": "recording is empty or larger than 4 GB"})
            dst = downloads_target("mp4")
            # browsers record WebM (no duration, plays poorly in QuickTime); re-encode to a standard MP4
            err = self.ffmpeg(src, dst, ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"])
            if err:
                dst.unlink(missing_ok=True)
                dst = downloads_target(ext)         # no ffmpeg / failed: keep the browser's file as is
                shutil.copyfile(src, dst)
        return self.json(200, {"path": str(dst).replace(str(Path.home()), "~", 1), "name": dst.name})

    # ---------- helpers ----------
    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 65536:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return None

    def json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"Anime Frame: http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
