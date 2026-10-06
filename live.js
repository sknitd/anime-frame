// Live restyle through Decart's realtime API (WebRTC): the camera goes up, a restyled stream comes back
// frame by frame. The page asks the local server (serve.py) for a short-lived client token, so the
// permanent API keys never reach the browser. The server holds up to 5 keys; if one fails (bad key,
// no credits) the next one takes over.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@decartai/sdk@0.2.5/+esm';

// Standard: the dedicated restyle model. Fast: lucy-2.5 in fast mode (lower latency, billed at 2x);
// the restyle model has no fast tier, and lucy-2.5 takes "transform / change the style" edit prompts.
const MODES = {
  standard: { model: 'lucy-restyle-2' },
  fast: { model: 'lucy-2.5', speed: 'fast' },
};

// Prompts avoid studio names: lucy-2.5's content filter refuses them as copyrighted IP.
export const STYLES = {
  anime: {
    label: 'Anime',
    standard: 'Korean webtoon anime style: clean thin line art, soft cel shading, smooth skin, large expressive eyes, soft pastel lighting',
    fast: 'Change the style of the video to a Korean webtoon anime illustration with clean thin line art, soft cel shading, smooth skin and large expressive eyes',
  },
  pixar: {
    label: 'Pixar toon',
    standard: '3D animated feature film style: stylized cartoon character with big expressive eyes, soft rounded features, smooth skin, warm cinematic lighting, high quality 3D render',
    fast: 'Change the style of the video to a 3D animated feature film with stylized cartoon characters, big expressive eyes, soft rounded features, smooth skin and warm cinematic lighting',
  },
};

let sdkPromise = null;
const loadSdk = () => (sdkPromise ??= import(SDK_URL));

// A refused prompt (moderation, length) is not a reason to switch keys; anything else at connect time may be.
const promptProblem = (msg) => /prompt|content|copyright|moderation|policy|too long/i.test(msg);
const keyProblem = (reason) => /credit|auth|key|quota|limit|forbidden|expired|payment/i.test(reason || '');

async function token(from) {
  const res = await fetch(`/api/decart-token?from=${from}`);
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.apiKey) {
    const err = new Error(tok.error || `token request failed (${res.status}); is serve.py running?`);
    err.exhausted = !!tok.exhausted;
    throw err;
  }
  return tok;   // { apiKey (client token), index (which saved key minted it) }
}

function openSession(sdk, apiKey, stream, fast, spec, handlers) {
  const mode = fast ? 'fast' : 'standard';
  return sdk.createDecartClient({ apiKey }).realtime.connect(stream, {
    model: sdk.models.realtime(MODES[mode].model),
    ...(MODES[mode].speed ? { speed: MODES[mode].speed } : {}),
    initialState: { prompt: { text: spec.prompt, enhance: spec.enhance !== false } },
    ...handlers,
  });
}

// videoEl receives the restyled stream; draw it like any other video.
export function createLive(videoEl) {
  // tag: the look the session is actually showing (a refused prompt keeps the previous one);
  // key: which saved key (0-4) the session runs on
  const st = { rt: null, state: 'idle', err: '', queue: null, connecting: false, fast: false, tag: null, key: null };
  let sent = null, nextKey = 0, gen = 0;   // gen: bumped on every hang-up, so a connect still in flight knows it was cancelled

  function cleanup() {
    gen++;
    try { st.rt?.disconnect(); } catch {}
    sent?.getTracks().forEach((t) => t.stop());
    st.rt = null; st.state = 'idle'; st.queue = null; st.tag = null; sent = null;
    videoEl.srcObject = null;
  }

  // spec: { prompt, enhance, tag }
  async function connect(stream, spec, fast) {
    if (st.rt || st.connecting) return;
    st.connecting = true; st.err = ''; st.state = 'connecting'; st.fast = fast;
    const my = gen;
    let lastErr = '';
    try {
      const sdk = await loadSdk();
      for (;;) {
        const tok = await token(nextKey);   // the server skips keys that can't mint a token
        if (my !== gen) return;               // hung up while waiting
        // Send a clone: the SDK stops the tracks it published when the session ends, and that must not
        // stop the page's own camera.
        sent = new MediaStream(stream.getVideoTracks().map((t) => t.clone()));
        let client;
        try {
          client = await openSession(sdk, tok.apiKey, sent, fast, spec, {
            onRemoteStream: (remote) => { if (my === gen) { videoEl.srcObject = remote; videoEl.play().catch(() => {}); } },
            onConnectionChange: (s) => { if (my !== gen) return; st.state = s; if (s === 'disconnected') cleanup(); },
            onQueuePosition: (q) => { if (my === gen) st.queue = q; },
          });
          if (my !== gen) { try { client.disconnect(); } catch {} return; }   // hung up mid-connect: don't leave it billing
          st.rt = client;
        } catch (e) {
          sent?.getTracks().forEach((t) => t.stop()); sent = null;
          const msg = e?.message || String(e);
          if (promptProblem(msg)) throw e;
          nextKey = tok.index + 1;            // this key connected badly: try the next one
          lastErr = `key ${tok.index + 1}: ${msg}`;
          continue;
        }
        st.key = tok.index; st.tag = spec.tag;
        st.rt.on('error', (e) => { st.err = e?.message || String(e); });
        st.rt.on('sessionEnded', (e) => {
          st.err = `session ended (${e?.reason || 'unknown'})`;
          if (keyProblem(e?.reason)) nextKey = st.key + 1;   // e.g. out of credits: the page reconnects on the next key
          cleanup();
        });
        return;
      }
    } catch (e) {
      if (e.exhausted) nextKey = 0;           // every key failed; start from the first again next time
      if (my !== gen) return;
      st.err = e.exhausted && lastErr ? `${lastErr} (no more keys to try)` : (e?.message || String(e));
      cleanup();
      throw e;
    } finally {
      st.connecting = false;
    }
  }

  // change the look without reconnecting
  function setPrompt(spec) {
    if (!st.rt) return;
    st.rt.setPrompt(spec.prompt, { enhance: spec.enhance !== false })
      .then(() => { st.tag = spec.tag; st.err = ''; })
      .catch((e) => { st.err = e?.message || String(e); });
  }

  // true once restyled frames are actually arriving
  const ready = () => !!st.rt && (st.state === 'connected' || st.state === 'generating')
    && videoEl.readyState >= 2 && videoEl.videoWidth > 0;

  return { st, connect, setPrompt, disconnect: cleanup, ready, resetKeys: () => { nextKey = 0; } };
}

// Settings "Test": mint a token with one saved key, open a real session on a generated test pattern,
// and hang up as soon as it connects (a few seconds of streaming at most).
export async function testConnection(index, fast) {
  const t0 = performance.now();
  const res = await fetch('/api/keys/test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anime-Frame': '1' }, body: JSON.stringify({ index }) });
  const tok = await res.json().catch(() => ({}));
  if (!tok.ok) return { ok: false, error: tok.error || `test failed (${res.status})` };
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = canvas.getContext('2d');
  const paint = () => {
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, '#f6c1cc'); grad.addColorStop(1, '#8fb8de');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#222'; g.font = '28px sans-serif'; g.fillText(`connection test ${Date.now() % 1000}`, 30, 190);
  };
  paint();
  const timer = setInterval(paint, 66), stream = canvas.captureStream(15);
  let rt = null, finished = false;
  try {
    const sdk = await loadSdk();
    const result = await new Promise((resolve) => {
      const stop = setTimeout(() => resolve({ ok: false, error: 'no answer within 20 s' }), 20000);
      const finish = (r) => { clearTimeout(stop); resolve(r); };
      openSession(sdk, tok.apiKey, stream, fast, { prompt: STYLES.anime[fast ? 'fast' : 'standard'] }, {
        onRemoteStream: () => {},
        onConnectionChange: (s) => { if (s === 'connected' || s === 'generating') finish({ ok: true }); },
      }).then((client) => {
        if (finished) { try { client.disconnect(); } catch {} return; }   // answered after we gave up: hang up now
        rt = client;
        client.on('error', (e) => finish({ ok: false, error: e?.message || String(e) }));
        client.on('sessionEnded', (e) => finish({ ok: false, error: `session ended (${e?.reason || 'unknown'})` }));
        if (client.isConnected()) finish({ ok: true });
      }, (e) => finish({ ok: false, error: e?.message || String(e) }));
    });
    return { ...result, ms: Math.round(performance.now() - t0) };
  } finally {
    finished = true;
    try { rt?.disconnect(); } catch {}
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
  }
}
