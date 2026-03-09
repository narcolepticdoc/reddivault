// Cloudflare Worker — Reddit feed CORS proxy
// Deploy at: https://workers.cloudflare.com
// Set your PWA domain in ALLOWED_ORIGIN below, then deploy.

const ALLOWED_ORIGIN = 'https://reddivault.vercel.app';

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
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

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Reddit returned ${response.status}`, detail: body.slice(0, 200) }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Cache-Control': 'no-store',
      }
    });
  }
};
