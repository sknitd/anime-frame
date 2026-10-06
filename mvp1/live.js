// Live restyle through Decart's realtime API (WebRTC): the camera goes up, a restyled stream comes back
// frame by frame. The page asks the local server (serve.py) for a short-lived client token, so the
// permanent API key never reaches the browser.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@decartai/sdk@0.2.5/+esm';
const MODEL = 'lucy-restyle-2';

export const STYLES = {
  anime: { label: 'Anime', prompt: 'Korean webtoon anime style: clean thin line art, soft cel shading, smooth skin, large expressive eyes, soft pastel lighting' },
  pixar: { label: 'Pixar toon', prompt: 'Pixar 3D animated movie style: stylized cartoon character with big expressive eyes, soft rounded features, smooth skin, warm cinematic lighting' },
};

// videoEl receives the restyled stream; draw it like any other video.
export function createLive(videoEl) {
  const st = { rt: null, state: 'idle', err: '', queue: null, connecting: false };
  let sdk = null;

  function cleanup() {
    try { st.rt?.disconnect(); } catch {}
    st.rt = null; st.state = 'idle'; st.queue = null;
    videoEl.srcObject = null;
  }

  async function connect(stream, style) {
    if (st.rt || st.connecting) return;
    st.connecting = true; st.err = ''; st.state = 'connecting';
    try {
      sdk ??= await import(SDK_URL);
      const res = await fetch('/api/decart-token');
      const tok = await res.json().catch(() => ({}));
      if (!res.ok || !tok.apiKey) throw new Error(tok.error || `token request failed (${res.status}); is serve.py running?`);
      const client = sdk.createDecartClient({ apiKey: tok.apiKey });
      st.rt = await client.realtime.connect(stream, {
        model: sdk.models.realtime(MODEL),
        onRemoteStream: (remote) => { videoEl.srcObject = remote; videoEl.play().catch(() => {}); },
        onConnectionChange: (s) => { st.state = s; if (s === 'disconnected') cleanup(); },
        onQueuePosition: (q) => { st.queue = q; },
        initialState: { prompt: { text: STYLES[style].prompt, enhance: true } },
      });
      st.rt.on('error', (e) => { st.err = e?.message || String(e); });
      st.rt.on('sessionEnded', (e) => { st.err = `session ended (${e?.reason || 'unknown'})`; cleanup(); });
    } catch (e) {
      st.err = e?.message || String(e);
      cleanup();
      throw e;
    } finally {
      st.connecting = false;
    }
  }

  function setStyle(style) {
    st.rt?.setPrompt(STYLES[style].prompt, { enhance: true }).catch((e) => { st.err = e?.message || String(e); });
  }

  // true once restyled frames are actually arriving
  const ready = () => !!st.rt && (st.state === 'connected' || st.state === 'generating')
    && videoEl.readyState >= 2 && videoEl.videoWidth > 0;

  return { st, connect, setStyle, disconnect: cleanup, ready };
}
