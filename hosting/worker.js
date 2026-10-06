const MODELS = ['lucy-restyle-2', 'lucy-2.5'];
const KEY_RE = /^[A-Za-z0-9_.\-]{8,300}$/;

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function mint(key, origin) {
  const response = await fetch('https://api.decart.ai/v1/client/tokens', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300, allowedModels: MODELS, allowedOrigins: [origin] }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.apiKey !== 'string') {
    throw new Error(`Decart rejected this key (${response.status}). Check the key and its available credits.`);
  }
  return data;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const siteOrigin = env.PUBLIC_SITE_ORIGIN || url.origin;
    if (url.pathname === '/api/decart-token') {
      if (request.method !== 'POST') return json(405, { error: 'Use POST to request a token.' });
      if (request.headers.get('Origin') !== siteOrigin || request.headers.get('X-Anime-Frame') !== '1') {
        return json(403, { error: 'Open Anime Frame to request a live session.' });
      }
      if (Number(request.headers.get('Content-Length') || 0) > 4096) return json(413, { error: 'Request too large.' });
      let input;
      try {
        const text = await request.text();
        if (text.length > 4096) return json(413, { error: 'Request too large.' });
        input = JSON.parse(text);
      } catch { return json(400, { error: 'Invalid token request.' }); }
      const keys = input?.keys;
      if (!Array.isArray(keys) || keys.length !== 5 || keys.some(k => typeof k !== 'string' || (k && !KEY_RE.test(k)))) {
        return json(400, { error: 'Enter a valid Decart API key in Decart keys.' });
      }
      const testing = Number.isInteger(input.index);
      const start = testing ? input.index : (input.from ?? 0);
      if (!Number.isInteger(start) || start < 0 || start > 5 || (testing && start > 4)) {
        return json(400, { error: 'Invalid key slot.' });
      }
      if (!keys.some(Boolean)) return json(400, { error: 'Add your own Decart API key in ⚙ Decart keys, or choose Filter only (offline).' });
      const errors = [];
      for (let i = start; i < (testing ? start + 1 : keys.length); i++) {
        if (!keys[i]) continue;
        try {
          const token = await mint(keys[i], siteOrigin);
          return json(200, { apiKey: token.apiKey, expiresAt: token.expiresAt, index: i });
        } catch (error) {
          errors.push(`Key ${i + 1}: ${error.name === 'TimeoutError' ? 'Decart timed out.' : error.message === 'Failed to fetch' ? 'Could not reach Decart.' : error.message}`);
        }
      }
      return json(502, { error: errors.join(' ') || 'No more keys to try.', exhausted: true });
    }
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Endpoint not found.' });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const asset = ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: {
        'Content-Type': asset.type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
      },
    });
  },
};
