// feed.js — part of RedditVault (auto-split from the original single-file PWA).
import { mapRedditChild } from './bookmarklet.js';
import { pushImportantPreferences, pushToSupabase, syncFromSupabase } from './cloud.js';
import { loadData } from './core.js';
import { render } from './render.js';
import { db, state, syncLog } from './state.js';
import { renderMarkdown, showToast, sleep } from './util.js';

export async function saveSupabaseConfig() {
  const url = document.getElementById('sb-url')?.value?.trim();
  const key = document.getElementById('sb-key')?.value?.trim();
  if (!url || !key) { showToast('Please fill in both fields', 'error'); return; }
  await db.config.put({ key: 'supabaseUrl', value: url });
  await db.config.put({ key: 'supabaseKey', value: key });
  state.supabaseUrl = url;
  state.supabaseKey = key;
  syncLog('saveSupabaseConfig: credentials saved — triggering full sync');
  showToast('Saved! Testing connection...', 'success');
  await syncFromSupabase();
}

// Persist the expected Reddit username (baked into the bookmarklet for the
// logged-in-account check). Strips a leading "u/" or "/u/" if pasted.
export async function saveFeedUrl() {
  const raw = document.getElementById('feed-url')?.value?.trim();
  if (!raw) { showToast('Please paste your Reddit feed URL', 'error'); return; }
  let feedUrl = raw;
  if (!feedUrl.includes('feed=') || !feedUrl.includes('reddit.com')) {
    showToast('URL should be from reddit.com and contain a feed= parameter — copy it from old.reddit.com/prefs/feeds/', 'error');
    return;
  }
  await db.config.put({ key: 'redditFeedUrl', value: feedUrl });
  state.redditFeedUrl = feedUrl;

  const proxyRaw = document.getElementById('feed-proxy-url')?.value?.trim() || '';
  await db.config.put({ key: 'feedProxyUrl', value: proxyRaw });
  state.feedProxyUrl = proxyRaw;

  const proxyType = document.querySelector('input[name="proxy-type"]:checked')?.value || 'cloudflare';
  await db.config.put({ key: 'feedProxyType', value: proxyType });
  state.feedProxyType = proxyType;

  const feedFormat = document.querySelector('input[name="feed-format"]:checked')?.value || 'rss';
  await db.config.put({ key: 'feedFormat', value: feedFormat });
  state.feedFormat = feedFormat;

  // Sync to cloud
  await pushImportantPreferences();

  showToast('Settings saved!', 'success');
  render();
}

export async function autoFeedSyncIfDue() {
  if (!state.autoFeedSync) return;
  if (!state.redditFeedUrl) return;
  if (state.feedSyncing) return;
  const lastFeedSync = await db.config.get('lastFeedSync');
  const lastMs = lastFeedSync ? new Date(lastFeedSync.value).getTime() : 0;
  const intervalMs = (state.autoFeedSyncInterval || 60) * 60 * 1000;
  if (Date.now() - lastMs < intervalMs) {
    syncLog(`autoFeedSync: skipped — last sync was ${Math.round((Date.now()-lastMs)/60000)}min ago (interval=${state.autoFeedSyncInterval}min)`);
    return;
  }
  syncLog(`autoFeedSync: due — triggering feed sync`);
  await syncFromFeed();
}

export function _buildProxyUrl(feedUrl) {
  if (state.feedProxyType === 'corsfix') {
    // CORSfix syntax: https://proxy.corsfix.com/?{full-url} (no encoding)
    return `https://proxy.corsfix.com/?${feedUrl}`;
  }
  // Cloudflare Worker syntax: {workerUrl}?url={encoded-url}
  const base = state.feedProxyUrl || '/api/reddit-feed';
  return `${base}?url=${encodeURIComponent(feedUrl)}`;
}

// Reddit's WAF ("network security") now blocks the .json private-feed
// endpoint with a 403 + HTML challenge page, while the .rss (Atom XML) feed
// still works. Normalise whatever feed URL the user saved to the .rss form so
// sync hits the endpoint Reddit allows. Also ensures the &user= param is
// present (the feed token alone does not always validate) by deriving the
// username from the /user/NAME/ path when needed.
export function _feedToRssUrl(feedUrl) {
  let u = feedUrl;
  if (/\.json(\?|$)/i.test(u)) {
    u = u.replace(/\.json(\?|$)/i, '.rss$1');
  } else if (!/\.rss(\?|$)/i.test(u)) {
    // No extension (e.g. .../saved?feed=...) — insert .rss before the query.
    u = u.replace(/(\/saved)(\?|$)/i, '$1.rss$2');
  }
  if (!/[?&]user=/.test(u)) {
    const m = u.match(/\/user\/([^/]+)\//);
    if (m) u += (u.includes('?') ? '&' : '?') + 'user=' + encodeURIComponent(m[1]);
  }
  return u;
}

// Counterpart of _feedToRssUrl for the legacy JSON endpoint (kept selectable
// via the RSS/JSON toggle in case Reddit changes which endpoint it blocks).
export function _feedToJsonUrl(feedUrl) {
  let u = feedUrl;
  if (/\.rss(\?|$)/i.test(u)) {
    u = u.replace(/\.rss(\?|$)/i, '.json$1');
  } else if (!/\.json(\?|$)/i.test(u)) {
    u = u.replace(/(\/saved)(\?|$)/i, '$1.json$2');
  }
  if (!/[?&]user=/.test(u)) {
    const m = u.match(/\/user\/([^/]+)\//);
    if (m) u += (u.includes('?') ? '&' : '?') + 'user=' + encodeURIComponent(m[1]);
  }
  return u;
}

// Convert a Reddit RSS <content> HTML body to Markdown so links and basic
// formatting survive (renderMarkdown turns it back into HTML for display).
// Reddit wraps the real body between <!-- SC_OFF --> and <!-- SC_ON -->; the
// trailing "submitted by … [link] [comments]" footer is dropped. Relative
// reddit links (/u/x, /r/y) are absolutised so renderMarkdown links them.
export function _rssContentToMarkdown(html) {
  if (!html) return '';
  let inner = html;
  const off = html.indexOf('<!-- SC_OFF -->');
  const on = html.indexOf('<!-- SC_ON -->');
  if (off !== -1 && on !== -1 && on > off) inner = html.slice(off + 15, on);
  const root = document.createElement('div');
  root.innerHTML = inner;

  const absolutize = (href) => {
    if (!href) return '';
    if (href.startsWith('/')) return 'https://www.reddit.com' + href;
    return href;
  };

  const walk = (node) => {
    let out = '';
    node.childNodes.forEach(child => {
      if (child.nodeType === 3) {            // text node
        out += child.textContent;
      } else if (child.nodeType === 1) {     // element
        const tag = child.tagName.toLowerCase();
        const kids = walk(child);
        switch (tag) {
          case 'a': {
            const href = absolutize(child.getAttribute('href') || '');
            out += /^https?:\/\//.test(href) ? `[${kids}](${href})` : kids;
            break;
          }
          case 'strong': case 'b': out += `**${kids}**`; break;
          case 'em': case 'i':     out += `*${kids}*`; break;
          case 'del': case 's':    out += `~~${kids}~~`; break;
          case 'code':             out += `\`${kids}\``; break;
          case 'pre':              out += `\n\`\`\`\n${child.textContent}\n\`\`\`\n`; break;
          case 'li':               out += `- ${kids}\n`; break;
          case 'blockquote':       out += kids.split('\n').map(l => l ? `> ${l}` : l).join('\n') + '\n'; break;
          case 'br':               out += '\n'; break;
          case 'h1':               out += `\n# ${kids}\n\n`; break;
          case 'h2':               out += `\n## ${kids}\n\n`; break;
          case 'h3':               out += `\n### ${kids}\n\n`; break;
          case 'p': case 'div':    out += `${kids}\n\n`; break;
          default:                 out += kids;
        }
      }
    });
    return out;
  };

  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

// Recover a link post's external destination URL: Reddit's content footer has
// an anchor whose text is exactly "[link]". For self-posts/comments it points
// back to the thread, which is the right fallback anyway.
export function _rssExternalLink(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const a = Array.from(tmp.getElementsByTagName('a')).find(x => x.textContent.trim() === '[link]');
  return a ? (a.getAttribute('href') || '') : '';
}

// Parse a Reddit Atom (.rss) feed into the same { kind, data } shape the feed
// sync loop already expects from the old JSON endpoint, so the downstream
// item-construction code is unchanged. kind: 't1' = comment, 't3' = post.
export function parseRedditFeedXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Could not parse Reddit feed (invalid XML)');
  }
  const entries = Array.from(doc.getElementsByTagName('entry'));
  return entries.map(entry => {
    const txt = (tag) => entry.getElementsByTagName(tag)[0]?.textContent || '';
    const id = txt('id').trim();                     // e.g. t3_abc123 / t1_def456
    const kind = id.startsWith('t1') ? 't1' : 't3';
    const author = txt('name').replace(/^\/?u\//, '').trim();
    const catEl = entry.getElementsByTagName('category')[0];
    const subreddit = (catEl?.getAttribute('term') || '').trim();
    const linkEl = entry.getElementsByTagName('link')[0];
    const href = linkEl?.getAttribute('href') || '';
    let permalink = href;
    try { permalink = new URL(href).pathname; } catch {}
    const title = txt('title').trim();
    const contentHtml = txt('content');
    const body = _rssContentToMarkdown(contentHtml);
    // For link posts the entry <link> is the comments page; recover the real
    // external destination from the footer's [link] anchor when present.
    const url = _rssExternalLink(contentHtml) || href;
    const published = txt('published') || txt('updated');
    const created = published ? Math.floor(new Date(published).getTime() / 1000) : null;
    return {
      kind,
      data: {
        name: id,
        title,
        // For comments the feed title is the parent-post title — reuse it so
        // the existing loop treats the comment as already having a title.
        link_title: kind === 't1' ? title : undefined,
        author,
        subreddit,
        url,
        permalink,
        body,
        selftext: body,
        score: 0,            // RSS omits score; enrichment fills it in
        created_utc: created,
      },
    };
  });
}

// Map a raw Reddit listing child (t1 = comment, t3 = post) to a RedditVault
// item. Single source of truth for both feed sync and the bookmarklet-inbox
// drain, so the two ingestion paths can never drift apart.
export async function syncFromFeed() {
  if (!state.redditFeedUrl) { showToast('No feed URL configured', 'error'); return; }
  if (state.feedSyncing) return;
  state.feedSyncing = true;
  state.feedSyncResult = null;
  state.feedSyncProgress = { page: 0, added: 0, skipped: 0 };
  render();

  let added = 0, skipped = 0, pages = 0;
  let after = null;
  const MAX_PAGES = 40; // safety cap — 40 × 25 = 1000 items

  // Build set of existing reddit_ids for fast dedup
  // Includes permanently deleted items so they are never re-inserted from feed
  const existing = new Set(state.items.map(i => i.redditId));
  const permanentlyDeleted = new Set(state.items.filter(i => i.isPermanentlyDeleted).map(i => i.redditId));

  // Feed format: 'rss' (default) or 'json'. Reddit currently WAF-blocks the
  // .json endpoint, so RSS is the working default; the toggle lets the user
  // switch if Reddit's behaviour changes. _feedTo*Url normalises whatever URL
  // the user saved (.json/.rss/no extension) to the selected endpoint.
  const format = state.feedFormat === 'json' ? 'json' : 'rss';

  syncLog(`feedSync: starting (${format})`);
  try {
    while (pages < MAX_PAGES) {
      let feedUrl = format === 'json'
        ? _feedToJsonUrl(state.redditFeedUrl)
        : _feedToRssUrl(state.redditFeedUrl);
      feedUrl += '&limit=25';
      if (after) feedUrl += `&after=${encodeURIComponent(after)}`;

      // Route through proxy (required — Reddit blocks direct cross-origin fetches)
      const url = _buildProxyUrl(feedUrl);
      syncLog(`feedSync: fetching via ${state.feedProxyType || 'cloudflare'} — ${url.slice(0, 120)}`);
      const res = await fetch(url);
      if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); detail = t.slice(0, 200); } catch(e) {}
        // Reddit blocks requests from datacenter IPs (proxies) with a 403 and
        // an HTML challenge/block page rather than JSON. Detect that and show a
        // clear, actionable message instead of dumping raw HTML at the user.
        const looksLikeRedditBlock = res.status === 403 && /<body|theme-beta|<!doctype|<html|network security/i.test(detail);
        if (looksLikeRedditBlock) {
          syncLog(`feedSync: HTTP 403 — Reddit block page (${state.feedProxyType || 'cloudflare'})`, 'error');
          throw new Error('Reddit blocked the feed request (HTTP 403). Check that your Private Feed URL and token are current — copy a fresh one from old.reddit.com/prefs/feeds/.');
        }
        syncLog(`feedSync: HTTP ${res.status} — ${detail}`, 'error');
        throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
      }
      const text = await res.text();
      let children, jsonAfter = null;
      if (format === 'json') {
        let json;
        try { json = JSON.parse(text); } catch(e) { throw new Error('Could not parse Reddit feed (invalid JSON) — Reddit may be returning its block page. Try the RSS format.'); }
        children = (json?.data?.children || []).map(c => ({ kind: c.kind, data: c.data }));
        jsonAfter = json?.data?.after || null;
      } else {
        children = parseRedditFeedXml(text);
      }
      if (children.length === 0) break; // no more items
      pages++;
      syncLog(`feedSync: page ${pages} — ${children.length} items from Reddit, ${existing.size} known locally`);
      state.feedSyncProgress = { page: pages, added, skipped };

      const newItems = [];
      for (const child of children) {
        const redditId = child.data.name; // already prefixed e.g. t3_abc123

        if (existing.has(redditId)) {
          skipped++;
          continue;
        }

        newItems.push(mapRedditChild(child, 'feed'));
        existing.add(redditId);
      }

      if (newItems.length > 0) {
        await db.items.bulkAdd(newItems);
        if (state.supabaseUrl && state.supabaseKey) {
          await pushToSupabase(newItems);
        }
        added += newItems.length;
        syncLog(`feedSync: added ${newItems.length} new items (${skipped} skipped on this page)`);
        state.feedSyncProgress = { page: pages, added, skipped };
      }

      // Pagination — JSON provides an explicit "after" cursor. The Atom feed
      // does not, so use the last entry's fullname (t3_…/t1_…); a short page
      // means we've reached the end of the feed.
      const prevAfter = after;
      after = format === 'json'
        ? jsonAfter
        : (children.length === 25 ? children[children.length - 1].data.name : null);
      if (!after || after === prevAfter) break;

      // If entire page was skipped (all known), stop — we've reached existing saves
      if (newItems.length === 0 && children.length > 0) {
        syncLog('feedSync: full page of known items — stopping pagination');
        break;
      }

      await sleep(300); // be gentle
    }

    await loadData();
    state.feedSyncResult = { added, skipped, pages };
    const feedSyncTs = new Date().toISOString();
    await db.config.put({ key: 'lastFeedSync', value: feedSyncTs });
    state.lastFeedSync = feedSyncTs;

    if (added > 0 && skipped === 0 && pages >= MAX_PAGES) {
      const msg = `${added} items added but no overlap found — may have unseen saves beyond Reddit's limit`;
      syncLog(`feedSync: ⚠️ ${msg}`, 'warn');
      showToast(`⚠️ ${added} items added but no overlap found — you may have unseen saves beyond Reddit's limit. Consider a fresh CSV export.`, 'warning');
    } else if (added > 0) {
      syncLog(`feedSync: complete — ${added} new item${added !== 1 ? 's' : ''} added, ${skipped} already known`, 'ok');
      showToast(`✅ Sync complete — ${added} new item${added !== 1 ? 's' : ''} added`, 'success');
    } else {
      syncLog(`feedSync: up to date — no new items (${skipped} already known, ${pages} page${pages !== 1 ? 's' : ''} checked)`, 'ok');
      showToast(`✅ Up to date — no new items found`, 'success');
    }

  } catch(e) {
    state.feedSyncResult = { added, skipped, pages, error: e.message };
    syncLog(`feedSync: failed — ${e.message}`, 'error');
    showToast(`Sync failed: ${e.message}`, 'error');
  }

  state.feedSyncing = false;
  state.feedSyncProgress = null;
  render();
}

