# Anime Frame

Make an **L** with each hand to form a frame, and everything inside it turns into a cartoon, live.

**Try it:** https://anime-frame.subhamkumar.chatgpt.site/

Inspired by [this demo](https://x.com/sarahli/status/2106949829243133954).

## Features

- **Hand-made frame:** MediaPipe tracks both hands; the frame follows your fingers whether the L's point up, down, or one of each.
- **Live restyle with [Decart](https://decart.ai):** Anime, Pixar-style toon, or your own prompt, applied to the camera in real time (`lucy-restyle-2`). **⚡ Fast** switches to `lucy-2.5` in fast mode (lower latency, billed at 2×).
- **Custom prompts:** type a style, keep **Enhance** on, and it applies live without reconnecting. The ⓘ button has prompt tips from Decart's docs.
- **Offline filter:** a WebGL2 cartoon filter (smooth skin, ink outlines, soft background blur). It's the stand-in while Decart connects, and the only look that needs no API key.
- **Video files:** upload or drag in a video instead of using the camera. Formats the browser can't play (AVI, WMV, ProRes, ...) are converted with ffmpeg first.
- **Record:** saves the output as MP4 in your Downloads folder.
- **Up to 5 Decart keys with fallback:** keys are tried in order, and if one is invalid or its session fails, the next takes over. Each key has a **Test** button that opens a real ~2 s session.

## Run it locally

Needs Python 3, and ffmpeg for converting unusual video formats and saving recordings (`brew install ffmpeg`).

```bash
python3 serve.py
```

Open http://localhost:8000, then add your Decart API key under **⚙ Decart keys**, or put it in `.env`:

```bash
DECART_API_KEY=your-key-here
```

Extra fallback keys go in `DECART_API_KEY_2` … `DECART_API_KEY_5`. `.env` is git-ignored.

### How keys stay safe

Following [Decart's guidance](https://docs.platform.decart.ai/sdks/javascript-realtime) for browser apps, permanent keys never reach the page. `serve.py` keeps them, exchanges them for 5-minute client tokens limited to the two models and this page's origin, and only answers requests from the page itself. The settings panel shows masked keys only.

The hosted version works differently: visitors bring their own keys, which stay in the browser tab and are exchanged for tokens by a small worker (see [PUBLISHING.md](PUBLISHING.md)).

## Files

| File | What it does |
| --- | --- |
| `index.html` | The app: camera or video source, frame drawing, controls |
| `handframe.js` | Turns two hands' landmarks into the frame |
| `toon.js` | Offline WebGL2 cartoon filter |
| `live.js` | Decart realtime sessions, key fallback, connection test |
| `serve.py` | Local server: token minting, key storage, video conversion, saving recordings |
| `hosting/`, `scripts/` | Build for the hosted version (`npm run build`) |
| `mvp1/` | Frozen snapshot of the first version |

Third-party code: `hosting/vendor/ffmpeg` is [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.15 (MIT). The app loads MediaPipe Tasks Vision and the Decart SDK from jsDelivr at runtime.
