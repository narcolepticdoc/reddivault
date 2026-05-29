// Cloudflare Worker — Reddit feed CORS proxy
// Deploy at: https://workers.cloudflare.com

// Allowed origins — exact matches or hostname suffix patterns.
// The request Origin is checked against this list and reflected back if it matches,
// so multiple origins and Vercel preview URLs are all supported.
const ALLOWED_ORIGINS = [
  'https://reddivault.vercel.app',       // production
];
const ALLOWED_ORIGIN_SUFFIXES = [
  '-narcolepticdocs-projects.vercel.app', // narcolepticdocs Vercel preview deployments
  'localhost',                            // local development
];

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  try {
    const host = new URL(origin).hostname;
    if (ALLOWED_ORIGIN_SUFFIXES.some(s => host === s || host.endsWith(s))) return origin;
  } catch {}
  return null;
}

export default {
  async fetch(request) {
    const allowedOrigin = getAllowedOrigin(request);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin || 'null',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        }
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!allowedOrigin) {
      return new Response('Origin not allowed', { status: 403 });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) return new Response('Missing url param', { status: 400 });

    // Validate it's a Reddit feed URL
    let parsed;
    try { parsed = new URL(target); } catch {
      return new Response('Invalid URL', { status: 400 });
    }
    if (!parsed.hostname.endsWith('reddit.com')) {
      return new Response('Only reddit.com URLs allowed', { status: 403 });
    }
    if (!parsed.searchParams.has('feed')) {
      return new Response('Missing feed token', { status: 403 });
    }

    // Use a descriptive, non-browser User-Agent per Reddit's API guidelines
    // (`<platform>:<app ID>:<version> (by /u/<username>)`) rather than a fake
    // browser string, which Reddit penalises.
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'web:reddivault:v0.9.10 (+https://reddivault.vercel.app)',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Reddit returned ${response.status}`, detail: body.slice(0, 200) }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin' }
      });
    }

    // Pass the body through unchanged. Reddit's private feed is served as
    // Atom XML (.rss), so don't assume JSON — forward the raw text and
    // preserve the upstream Content-Type.
    const body = await response.text();
    const contentType = response.headers.get('Content-Type') || 'application/atom+xml; charset=utf-8';
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': allowedOrigin,
        'Cache-Control': 'no-store',
        'Vary': 'Origin',
      }
    });
  }
};
