// api/reddit-feed.js
// Vercel serverless function — proxies Reddit private feed JSON to avoid CORS issues.
// The PWA calls /api/reddit-feed?url=<encoded feed url> and this fetches it server-side.

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Validate it's a Reddit URL with a feed token — refuse anything else
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!parsed.hostname.endsWith('reddit.com')) {
    return res.status(403).json({ error: 'Only reddit.com URLs are allowed' });
  }

  if (!parsed.searchParams.has('feed')) {
    return res.status(403).json({ error: 'Missing feed token' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RedditVault/1.0 (personal saved items manager)',
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Reddit returned ${response.status}` });
    }

    const data = await response.json();

    // Pass through with CORS headers so PWA can read it
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: `Proxy fetch failed: ${err.message}` });
  }
}
