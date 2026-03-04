// popup.js - RedditVault Sync Extension

let config = { supabaseUrl: '', supabaseKey: '' };
let stats = { fetched: 0, newItems: 0 };
let isSyncing = false;

// ─── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  config = await loadConfig();

  if (!config.supabaseUrl || !config.supabaseKey) {
    showSection('setup');
  } else {
    showSection('main');
    updateStatus('ready', 'Ready to sync');
  }

  document.getElementById('save-config-btn').addEventListener('click', saveConfig);
  document.getElementById('sync-btn').addEventListener('click', startSync);
  document.getElementById('config-btn').addEventListener('click', () => showSection('setup'));
});

function showSection(which) {
  document.getElementById('setup-section').style.display = which === 'setup' ? 'block' : 'none';
  document.getElementById('main-section').style.display = which === 'main' ? 'block' : 'none';

  if (which === 'setup' && config.supabaseUrl) {
    document.getElementById('setup-url').value = config.supabaseUrl;
    document.getElementById('setup-key').value = config.supabaseKey;
  }
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
async function loadConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['supabaseUrl', 'supabaseKey'], data => {
      resolve({ supabaseUrl: data.supabaseUrl || '', supabaseKey: data.supabaseKey || '' });
    });
  });
}

async function saveConfig() {
  const url = document.getElementById('setup-url').value.trim();
  const key = document.getElementById('setup-key').value.trim();
  if (!url || !key) { alert('Please fill in both fields.'); return; }

  config = { supabaseUrl: url, supabaseKey: key };
  chrome.storage.local.set({ supabaseUrl: url, supabaseKey: key });

  log('Configuration saved ✓', 'success');
  showSection('main');
  updateStatus('ready', 'Configured — ready to sync');
}

// ─── STATUS ──────────────────────────────────────────────────────────────────
function updateStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = `dot ${state === 'syncing' ? 'yellow' : state === 'ready' || state === 'done' ? 'green' : 'red'}`;
  label.textContent = text;
}

function setProgress(pct) {
  const wrap = document.getElementById('progress-wrap');
  const fill = document.getElementById('progress-fill');
  if (pct === null) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  fill.style.width = pct + '%';
}

function log(msg, type = 'info') {
  const logEl = document.getElementById('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function updateStats(fetched, newItems) {
  document.getElementById('stat-fetched').textContent = fetched.toLocaleString();
  document.getElementById('stat-new').textContent = newItems.toLocaleString();
}

// ─── REDDIT FETCH ─────────────────────────────────────────────────────────────
async function fetchRedditSaved() {
  const allItems = [];
  let after = null;
  let page = 0;
  const MAX_PAGES = 40; // Reddit API max ~1000 items = 40 pages of 25

  log('Fetching saved items from Reddit...', 'info');

  // Reddit's saved listing does NOT expose when you saved an item — only when
  // the post was originally created. We record sync time as a proxy for saved_at.
  const syncTime = new Date().toISOString();

  while (page < MAX_PAGES) {
    const url = `https://www.reddit.com/user/me/saved.json?limit=100&raw_json=1${after ? `&after=${after}` : ''}`;

    let res;
    try {
      res = await fetch(url, {
        credentials: 'include', // Uses your logged-in Reddit session cookie!
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'RedditVault/1.0 (personal saved items manager)'
        }
      });
    } catch(e) {
      throw new Error('Network error — are you logged into Reddit?');
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error('Not logged in to Reddit, or session expired. Please log in to reddit.com in Chrome first.');
    }
    if (res.status === 429) {
      log('Rate limited — waiting 5 seconds...', 'info');
      await sleep(5000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Reddit API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const children = data?.data?.children || [];
    if (children.length === 0) {
      log('No more items found.', 'info');
      break;
    }

    for (const child of children) {
      const d = child.data;
      const isComment = child.kind === 't1';

      // post_created_at: when the original Reddit post/comment was made
      // created_utc is always present — this is the definitive post age
      const postCreatedAt = d.created_utc
        ? new Date(d.created_utc * 1000).toISOString()
        : null;

      // For comments: title comes from the parent post (link_title)
      // Fall back to first 120 chars of comment body if link_title missing
      const title = isComment
        ? (d.link_title || d.body?.substring(0, 120) || 'Saved Comment')
        : (d.title || 'Untitled Post');

      // For link posts: use the external destination URL
      // For text posts and comments: use the Reddit permalink
      const itemUrl = isComment
        ? `https://www.reddit.com${d.permalink}`
        : (d.url && !d.url.includes('reddit.com/r/') ? d.url : `https://www.reddit.com${d.permalink}`);

      allItems.push({
        reddit_id: d.name || d.id,
        type: isComment ? 'comment' : 'post',
        subreddit: d.subreddit || '',
        title,
        url: itemUrl,
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : itemUrl,
        body: isComment ? (d.body || '') : (d.selftext || ''),
        author: d.author || '',
        score: d.score || 0,
        saved_at: syncTime,             // When we synced (best proxy for save time)
        post_created_at: postCreatedAt, // When the Reddit post was originally made
        folder: null
      });
    }

    after = data?.data?.after;
    if (!after) break;

    page++;
    const progress = Math.min(95, (page / MAX_PAGES) * 100);
    setProgress(progress);
    updateStats(allItems.length, stats.newItems);
    log(`Page ${page}: ${allItems.length} items so far...`, 'info');

    // Be polite to Reddit's API — wait between requests
    await sleep(1000);
  }

  return allItems;
}

// ─── SUPABASE PUSH ────────────────────────────────────────────────────────────
async function pushToSupabase(items) {
  if (!items.length) return 0;

  const BATCH = 100;
  let totalNew = 0;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);

    const res = await fetch(`${config.supabaseUrl}/rest/v1/reddit_saves`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`,
        // merge-duplicates: safe to re-sync — won't create duplicates
        'Prefer': 'resolution=ignore-duplicates,return=representation'
      },
      body: JSON.stringify(batch)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase error ${res.status}: ${errText}`);
    }

    const returned = await res.json();
    totalNew += returned.filter(r => r.created_at === r.updated_at || !r.updated_at).length;

    setProgress(50 + (i / items.length) * 50);
    log(`Pushed batch ${Math.floor(i/BATCH)+1}/${Math.ceil(items.length/BATCH)} to Supabase`, 'info');
    await sleep(200);
  }

  return totalNew;
}

// ─── MAIN SYNC ────────────────────────────────────────────────────────────────
async function startSync() {
  if (isSyncing) return;
  isSyncing = true;

  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Syncing...';
  stats = { fetched: 0, newItems: 0 };
  updateStats(0, 0);
  setProgress(0);
  updateStatus('syncing', 'Syncing...');

  try {
    const items = await fetchRedditSaved();
    stats.fetched = items.length;
    updateStats(stats.fetched, 0);
    log(`✓ Fetched ${items.length} saved items from Reddit`, 'success');

    if (items.length === 0) {
      log('Nothing to sync.', 'info');
      updateStatus('done', 'Nothing to sync');
      setProgress(null);
      return;
    }

    log('Uploading to Supabase...', 'info');
    setProgress(50);
    const newCount = await pushToSupabase(items);
    stats.newItems = newCount;
    updateStats(stats.fetched, stats.newItems);

    setProgress(100);
    log(`✓ Done! ${newCount} new items added to cloud.`, 'success');
    updateStatus('done', `Sync complete — ${newCount} new items`);
    setTimeout(() => setProgress(null), 2000);

    chrome.storage.local.set({ lastSync: new Date().toISOString() });

  } catch(e) {
    log('❌ Error: ' + e.message, 'error');
    updateStatus('error', 'Sync failed');
    setProgress(null);
  } finally {
    isSyncing = false;
    btn.disabled = false;
    btn.textContent = '🔄 Sync Saved Items Now';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
