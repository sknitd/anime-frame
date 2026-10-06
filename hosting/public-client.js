const KEY_STORE = 'animeFrame.decartSessionKeys';
const KEY_RE = /^[A-Za-z0-9_.\-]{8,300}$/;
let keys = ['', '', '', '', ''];
try {
  const saved = JSON.parse(sessionStorage.getItem(KEY_STORE));
  if (Array.isArray(saved) && saved.length === 5 && saved.every(k => typeof k === 'string' && (!k || KEY_RE.test(k)))) keys = saved;
} catch {}

export function keyList() {
  return keys.map((key, index) => ({ index, set: !!key, masked: key ? `${key.slice(0, 9)}…${key.slice(-4)}` : '' }));
}

export function changeKeys({ set = {}, remove = [] }) {
  const next = [...keys];
  for (const [slot, value] of Object.entries(set)) {
    const index = Number(slot), key = String(value).trim();
    if (!Number.isInteger(index) || index < 0 || index > 4 || !KEY_RE.test(key)) throw new Error(`Key ${index + 1} doesn't look like a Decart API key.`);
    next[index] = key;
  }
  for (const index of remove) {
    if (Number.isInteger(index) && index >= 0 && index < 5) next[index] = '';
  }
  keys = next;
  try { sessionStorage.setItem(KEY_STORE, JSON.stringify(keys)); } catch {}
  return { keys: keyList() };
}

export async function requestToken(options = {}) {
  const response = await fetch('/api/decart-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Anime-Frame': '1' },
    body: JSON.stringify({ ...options, keys }),
    cache: 'no-store',
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.apiKey) {
    const error = new Error(token.error || `Couldn't start a Decart session (${response.status}).`);
    error.exhausted = !!token.exhausted;
    throw error;
  }
  return token;
}

let conversionQueue = Promise.resolve();
let ffmpegPromise;
async function blobURL(url, type) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not download the video converter. Check your connection and try again.');
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
}

async function converter(notify) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      notify('Downloading the video converter…');
      const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
      const ffmpeg = new FFmpeg();
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
      const urls = await Promise.all([
        blobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        blobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      ]);
      try { await ffmpeg.load({ coreURL: urls[0], wasmURL: urls[1], classWorkerURL: '/vendor/ffmpeg/worker.js' }); }
      catch (error) { ffmpeg.terminate(); throw error; }
      finally { urls.forEach(url => URL.revokeObjectURL(url)); }
      return ffmpeg;
    })().catch(error => { ffmpegPromise = null; throw error; });
  }
  return ffmpegPromise;
}

export function convertVideo(blob, notify = () => {}) {
  const run = async () => {
    if (blob.size > 200 * 1024 * 1024) throw new Error('Browser conversion supports files up to 200 MB. Convert larger files to H.264 MP4 before uploading.');
    const ffmpeg = await converter(notify);
    const input = 'input.video', output = 'output.mp4';
    const progress = ({ progress }) => notify(`Converting video on your device… ${Math.min(99, Math.max(0, Math.round(progress * 100)))}%`);
    ffmpeg.on('progress', progress);
    try {
      await ffmpeg.writeFile(input, new Uint8Array(await blob.arrayBuffer()));
      notify('Converting video on your device…');
      const code = await ffmpeg.exec(['-i', input, '-map', '0:v:0', '-an', '-sn', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-movflags', '+faststart', output], 1800000);
      if (code !== 0) throw new Error('This video could not be converted. Try an H.264 MP4 or WebM file.');
      const data = await ffmpeg.readFile(output);
      return new Blob([data], { type: 'video/mp4' });
    } finally {
      ffmpeg.off('progress', progress);
      await ffmpeg.deleteFile(input).catch(() => {});
      await ffmpeg.deleteFile(output).catch(() => {});
    }
  };
  const result = conversionQueue.then(run, run);
  conversionQueue = result.catch(() => {});
  return result;
}

export function downloadVideo(blob) {
  const extension = /mp4/.test(blob.type) ? 'mp4' : 'webm';
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), { href: url, download: `anime-frame-${Date.now()}.${extension}` });
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return extension;
}
