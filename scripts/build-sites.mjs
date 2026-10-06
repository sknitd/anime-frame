import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFile(resolve(root, path), 'utf8');
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Publishing adapter could not find: ${before.slice(0, 80)}`);
  return source.replace(before, after);
}

let html = await read('index.html');
html = replace(html, '<title>Anime Frame</title>', '<title>Anime Frame</title>\n<meta name="description" content="Turn your camera or video into live anime and cartoon effects inside a frame made with your hands.">');
html = replace(html,
  "import { createFrameTracker } from \"./handframe.js\";",
  "import { createFrameTracker } from \"./handframe.js\";\nimport { keyList, changeKeys, convertVideo, downloadVideo } from './public-client.js';");
html = replace(html,
  'Works on your camera or on a video file.</p>',
  'Works on your camera or on a video file. Live effects use your own Decart API key; the offline filter works without a key.</p>');
html = replace(html,
  'Stored in anime-frame/.env on this computer; the page only sees masked keys. Test opens a real session for a few seconds.',
  'Your keys stay in this browser tab until you close it. They are sent securely to mint temporary Decart tokens and are never saved on the server. Test uses a few seconds of your Decart credits.');
html = replace(html,
  'Record the output; saved to your Downloads folder as MP4',
  'Record the output and download it as MP4');
html = replace(html,
  `      const res = await fetch('/api/convert', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name), 'X-Anime-Frame': '1' }, body: file });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || \`conversion failed (\${res.status})\`);
      url = URL.createObjectURL(await res.blob());`,
  `      url = URL.createObjectURL(await convertVideo(file, message => say(esc(message))));`);

const recordingStart = html.indexOf('async function saveRecording(blob) {');
const recordingEnd = html.indexOf("$('rec').onclick", recordingStart);
if (recordingStart < 0 || recordingEnd < 0) throw new Error('Could not adapt recording downloads.');
html = html.slice(0, recordingStart) + `async function saveRecording(blob) {
  if (!blob.size) { flash('⚠ nothing was recorded'); return; }
  try {
    if (!/mp4/.test(blob.type)) {
      flash('💾 preparing your MP4 download…', 0);
      blob = await convertVideo(blob, message => flash(esc(message), 0));
    }
    const extension = downloadVideo(blob);
    flash(\`💾 recording downloaded as \${extension.toUpperCase()}\`, 7000);
  } catch (error) {
    downloadVideo(blob);
    flash(\`💾 original recording downloaded · \${esc(error.message || error)}\`, 10000);
  }
}
` + html.slice(recordingEnd);

html = replace(html,
  `    const res = await fetch('/api/keys');
    keySlots = (await res.json()).keys;`,
  `    keySlots = keyList();`);
html = replace(html, "couldn\\'t reach serve.py", "couldn\\'t load your keys");
html = replace(html,
  `  const res = await post('/api/keys', { set });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { flash(\`⚠ \${esc(j.error || 'could not save keys')}\`); return false; }
  keySlots = j.keys; renderKeys(); live.resetKeys();`,
  `  let j;
  try { j = changeKeys({ set }); }
  catch (error) { flash(\`⚠ \${esc(error.message)}\`); return false; }
  keySlots = j.keys; renderKeys(); live.resetKeys();`);
html = replace(html,
  `    const res = await post('/api/keys', { remove: [i] });
    if (res.ok) { keySlots = (await res.json()).keys; delete keyStatus[i]; renderKeys(); live.resetKeys(); }`,
  `    keySlots = changeKeys({ remove: [i] }).keys; delete keyStatus[i]; renderKeys(); live.resetKeys();`);
html = replace(html, 'recording (saved to ~/Downloads as MP4 by the local server)', 'recording (downloaded to this device)');
html = replace(html, 'Decart keys (kept by the local server; the page sees masked values only)', 'Decart keys (saved in this browser session)');

let live = await read('live.js');
const tokenStart = live.indexOf('async function token(from) {');
const tokenEnd = live.indexOf('\nfunction openSession', tokenStart);
if (tokenStart < 0 || tokenEnd < 0) throw new Error('Could not adapt the Decart token request.');
live = "import { requestToken } from './public-client.js';\n" + live.slice(0, tokenStart) + 'async function token(from) { return requestToken({ from }); }\n' + live.slice(tokenEnd);
live = replace(live,
  `  const res = await fetch('/api/keys/test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anime-Frame': '1' }, body: JSON.stringify({ index }) });
  const tok = await res.json().catch(() => ({}));
  if (!tok.ok) return { ok: false, error: tok.error || \`test failed (\${res.status})\` };`,
  `  let tok;
  try { tok = await requestToken({ index }); }
  catch (error) { return { ok: false, error: error.message }; }`);

const assets = {
  '/index.html': { body: html, type: 'text/html; charset=utf-8' },
  '/live.js': { body: live, type: 'text/javascript; charset=utf-8' },
};
for (const [url, source] of [['/toon.js', 'toon.js'], ['/handframe.js', 'handframe.js'], ['/public-client.js', 'hosting/public-client.js']]) {
  assets[url] = { body: await read(source), type: 'text/javascript; charset=utf-8' };
}
for (const filename of await readdir(resolve(root, 'hosting/vendor/ffmpeg'))) {
  if (filename.endsWith('.js')) assets[`/vendor/ffmpeg/${filename}`] = { body: await read(`hosting/vendor/ffmpeg/${filename}`), type: 'text/javascript; charset=utf-8' };
}
const worker = `const ASSETS = ${JSON.stringify(assets)};\n` + await read('hosting/worker.js');
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), worker);
await writeFile(resolve(root, 'dist/.openai/hosting.json'), await read('.openai/hosting.json'));
console.log(`Built Anime Frame: ${Object.keys(assets).length} browser assets and Decart token endpoint.`);
