// render.js — part of RedditVault (auto-split from the original single-file PWA).
import { buildInboxBookmarklet, cspProbeBookmarklet, drainInbox, importPastedBookmarklet, saveRedditUsername, saveScoreRefreshLimit } from './bookmarklet.js';
import { pushAllToSupabase, pushImportantPreferences, syncFromSupabase } from './cloud.js';
import { clearAllData } from './core.js';
import { exportJSON, handleFileImport, repairCSVDuplicates, repairCommentTitles, repairItemTypes, repairSavedAtDates } from './dataio.js';
import { enrichTimeEstimate, enrichViaArcticShiftOnly, enrichViaRedditOnly, markAttemptedAsDead, resetAllEnrichment, resetDeadToPending, saveEnrichSettings, stopEnrichment, updateSpeedHints } from './enrich.js';
import { saveFeedUrl, saveSupabaseConfig, syncFromFeed } from './feed.js';
import { applySearch, checkSavedAtClumps, clearFilters, clearRecentlyViewed, commitSearch, deleteAllTrashed, deleteItemPermanently, deleteList, dislikeItem, doCreateList, doEditList, hasActiveFilters, newSearch, purgeDeletedItems, purgeSingleItem, removeSavedSearchByIndex, restoreDeletedItem, restoreItem, runListSearch, runSavedSearch, saveCurrentSearchAsList, setFilter, setRating, setSort, setSortList, showPage, toggleFavourite, toggleItemList, toggleTagChip, trackRecentlyViewed, trashAllDead } from './items.js';
import { buildTagDepGraph, extractTagTokens, filteredItems, getTagsContaining, itemMatchesTokens, optionsSummaryParts, parseSearchQuery, sortItems } from './search.js';
import { APP_VERSION, db, renderSyncLogEntries, state, syncLog } from './state.js';
import { applyZoomSetting, escHtml, fmtDate, fullUrl, renderMarkdown, showToast, stripUrlPunct } from './util.js';

export function render() {
  try {
    const content = document.getElementById('main-content');
    renderHeaderActions();
    switch(state.page) {
      case 'home':     content.innerHTML = renderHome(); break;
      case 'browse':   content.innerHTML = renderBrowse(); break;
      case 'recent':   content.innerHTML = renderRecent(); break;
      case 'lists':    content.innerHTML = renderLists(); break;
      case 'settings': content.innerHTML = renderSettings(); break;
    }
    attachEventListeners();
  } catch(err) {
    console.error('render() error:', err);
    _renderErrorFallback(err);
  }
}

export function _renderErrorFallback(err) {
  try {
    const content = document.getElementById('main-content');
    if (content) content.innerHTML = `
      <div style="padding:32px 20px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:18px;margin-bottom:8px">Something went wrong</div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Page: <strong>${escHtml(state.page)}</strong></div>
        <div style="font-size:12px;color:var(--danger);background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);
          border-radius:8px;padding:10px 14px;margin:12px 0 20px;text-align:left;font-family:monospace;word-break:break-all">
          ${escHtml(err?.message || String(err))}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:280px;margin:0 auto">
          <button class="btn btn-secondary" onclick="showPage('home')">🏠 Go to Home</button>
          <button class="btn btn-ghost" onclick="window.location.reload()">↺ Reload app</button>
        </div>
      </div>`;
  } catch(e) {
    // If even the fallback fails, reload is the last resort
    console.error('_renderErrorFallback failed:', e);
    window.location.reload();
  }
}

export function renderHeaderActions() {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

  const el = document.getElementById('header-actions');
  if (!state.supabaseUrl || !state.supabaseKey) {
    el.innerHTML = '';
    return;
  }

  if (state.syncStatus === 'syncing') {
    el.innerHTML = `
      <span style="font-size:11px;color:var(--warning);display:flex;align-items:center;gap:5px">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--warning);display:inline-block;animation:pulse 1s infinite"></span>
        Syncing
      </span>`;
    return;
  }

  let dot, label, title, logMsg;
  if (state.localDirty) {
    dot = '#f59e0b';
    label = 'Unsynced';
    title = 'Local changes not yet pushed to cloud';
    logMsg = 'warn:Indicator → Unsynced (localDirty)';
  } else if (state.cloudAhead) {
    dot = '#3b82f6';
    label = 'Pulling…';
    title = 'Cloud has newer data — pulling';
    logMsg = 'warn:Indicator → Pulling (cloudAhead)';
  } else if (state.syncStatus === 'disconnected') {
    dot = '#ef4444';
    label = 'Disconnected';
    title = 'Cloud connection issue — check Settings';
    logMsg = 'error:Indicator → Disconnected';
  } else {
    dot = '#22c55e';
    label = 'In sync';
    title = `Fully synced · last sync ${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : 'unknown'}`;
    logMsg = 'ok:Indicator → In sync';
  }
  // Only log when the indicator label actually changes
  if (logMsg && label !== state._lastIndicatorLabel) {
    state._lastIndicatorLabel = label;
    const [level, msg] = logMsg.split(':');
    syncLog(msg, level);
  }

  el.innerHTML = `
    <span style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:5px;cursor:pointer"
      title="${title}" onclick="showPage('settings')">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};display:inline-block"></span>
      ${label}
    </span>`;
}

export function renderHome() {
  const active = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted);
  const total = active.length;
  const starred = active.filter(i => i.isFavourite).length;
  const rated = active.filter(i => i.rating).length;
  const needsEnrich = active.filter(i => i.enrichStatus === 'pending').length;

  // Items saved in last 7 days, grouped by day
  const now = new Date();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentItems = active
    .filter(i => i.savedAt && i.savedAt > sevenDaysAgo)
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

  // Group into day buckets: 'Today', 'Yesterday', '2 days ago', …, '6 days ago'
  function dayBucketLabel(savedAt) {
    if (!savedAt) return null;
    const saved = new Date(savedAt);
    const diffMs = now - saved;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays} days ago`;
  }
  const recentBuckets = [];
  const seenBuckets = new Map();
  for (const item of recentItems) {
    const label = dayBucketLabel(item.savedAt);
    if (!label) continue;
    if (!seenBuckets.has(label)) {
      seenBuckets.set(label, recentBuckets.length);
      recentBuckets.push({ label, items: [] });
    }
    recentBuckets[seenBuckets.get(label)].items.push(item);
  }

  // Quick Access tiles — all lists, sorted by recency then count, cap at 6
  const allLists = state.lists
    .map(l => ({
      ...l,
      count: l.type === 'smart'
        ? (state.tagCache.get(l.id)?.count ?? 0)
        : state.itemLists.filter(il => il.listId === l.id).length,
      lastAccessedAt: l.lastAccessedAt || null
    }))
    .sort((a, b) => {
      // Recently accessed first, then by count
      if (a.lastAccessedAt && !b.lastAccessedAt) return -1;
      if (!a.lastAccessedAt && b.lastAccessedAt) return 1;
      if (a.lastAccessedAt && b.lastAccessedAt) {
        const diff = b.lastAccessedAt.localeCompare(a.lastAccessedAt);
        if (diff !== 0) return diff;
      }
      return b.count - a.count;
    });
  const visibleTags = allLists.slice(0, 6);
  const hiddenTagCount = allLists.length - visibleTags.length;

  function tagRecencyLabel(t) {
    if (!t.lastAccessedAt) return null;
    const ms = Date.now() - new Date(t.lastAccessedAt).getTime();
    const mins = ms / 60000;
    if (mins < 60) return 'just now';
    const hrs = mins / 60;
    if (hrs < 24) return 'today';
    const days = hrs / 24;
    if (days < 2) return '1d ago';
    if (days < 7) return `${Math.floor(days)}d ago`;
    if (days < 14) return '1w ago';
    return `${Math.floor(days/7)}w ago`;
  }

  if (total === 0) return `
    <div class="empty">
      <div class="empty-icon">📥</div>
      <h3>No saved items yet</h3>
      <p>Import your Reddit saved posts CSV or sync from the cloud to get started.</p>
      <br>
      <button class="btn btn-primary" onclick="showPage('settings')">Import CSV</button>
    </div>`;

  return `
    ${needsEnrich > 0 ? `
      <div class="enrich-banner">
        <div class="enrich-banner-text">
          <strong>⚡ ${needsEnrich} items need enrichment</strong>
          <span>Missing titles, subreddits, or post dates</span>
        </div>
        <button class="btn btn-warning btn-sm" onclick="showPage('settings')" style="white-space:nowrap">Enrich Now</button>
      </div>
    ` : ''}

    <!-- Library pulse -->
    <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px">Library</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:24px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 8px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;line-height:1;color:var(--text)">${total.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.2">Saved</div>
      </div>
      <div style="background:var(--surface);border:1px solid rgba(168,85,247,0.3);border-radius:14px;padding:12px 8px;text-align:center;background:rgba(168,85,247,0.08)">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;line-height:1;color:var(--accent2)">${starred.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.2">Starred</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 8px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;line-height:1;color:var(--text)">${rated.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.2">Rated</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 8px;text-align:center">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;line-height:1;color:var(--text)">${recentItems.length}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.2">This week</div>
      </div>
    </div>

    <!-- Quick Access -->
    ${visibleTags.length > 0 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted)">Quick Access</div>
        ${hiddenTagCount > 0 ? `<button class="btn btn-ghost btn-sm" onclick="showPage('lists')" style="font-size:11px">+${hiddenTagCount} more →</button>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
        ${visibleTags.map(t => {
          const recency = tagRecencyLabel(t);
          const isRecent = recency && ['just now','today','1d ago'].includes(recency);
          const typeIcon = t.type === 'smart' ? '🔍' : '📋';
          return `
          <div onclick="state.listView=${t.id};db.lists.update(${t.id},{lastAccessedAt:new Date().toISOString()});showPage('lists')"
            style="background:var(--surface);border:1px solid ${isRecent ? 'rgba(124,58,237,0.35)' : 'var(--border)'};border-radius:16px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:8px;-webkit-tap-highlight-color:transparent">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
              <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:14px;color:var(--text);line-height:1.2">
                <span style="margin-right:4px">${typeIcon}</span>${escHtml(t.name)}
              </div>
              ${recency ? `<div style="font-size:10px;color:${isRecent ? 'var(--accent2)' : 'var(--text-muted)'};background:${isRecent ? 'rgba(124,58,237,0.15)' : 'var(--surface2)'};border-radius:6px;padding:2px 6px;flex-shrink:0;white-space:nowrap">${recency}</div>` : ''}
            </div>
            <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:22px;color:var(--text-muted);line-height:1">
              ${t.count.toLocaleString()}<span style="font-size:11px;font-weight:400;margin-left:3px">items</span>
            </div>
          </div>`;
        }).join('')}
      </div>
    ` : ''}

    <!-- Saved this week -->
    ${recentBuckets.length > 0 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted)">Saved this week</div>
        <button class="btn btn-ghost btn-sm" onclick="newSearch({sortBy:'savedAt',sortDir:'desc'})" style="font-size:11px">See all →</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        ${recentBuckets.map(bucket => `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;padding-left:2px">${bucket.label}</div>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${bucket.items.map(item => `
                <div onclick="showPreview(${item.id})"
                  style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
                  <div style="font-size:14px;flex-shrink:0;margin-top:1px">${item.type === 'comment' ? '💬' : '📝'}</div>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:500;color:var(--text);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
                      ${escHtml(item.title || 'Untitled')}
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
                      ${item.subreddit ? `<span>r/${escHtml(item.subreddit)}</span>` : ''}
                      ${item.isFavourite ? '<span>⭐</span>' : ''}
                      ${item.rating ? `<span style="color:#f59e0b">${'★'.repeat(item.rating)}</span>` : ''}
                    </div>
                  </div>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    ` : ''}
  `;
}

// ─── MARKDOWN RENDERER ───────────────────────────────────────────────────────
// Strips trailing punctuation from URLs, but preserves ) if it balances an open paren.
export function renderRecent() {
  const list = state.recentlyViewed || [];
  const byId = new Map(state.items.map(i => [i.id, i]));
  const resolved = [];
  const keep = [];
  for (const entry of list) {
    const item = byId.get(entry.id);
    if (!item) continue; // purged — drop from history
    keep.push(entry);
    if (item.isPermanentlyDeleted || item.isDisliked) continue;
    resolved.push({ item, ts: entry.ts });
  }
  // Opportunistic cleanup of stale ids (purged items)
  if (keep.length !== list.length) {
    state.recentlyViewed = keep;
    db.config.put({ key: 'recentlyViewed', value: keep });
  }

  const header = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-family:'Syne',sans-serif;font-weight:600">🕘 Recently Viewed${resolved.length ? ` (${resolved.length})` : ''}</div>
      ${resolved.length > 0 ? `<button class="btn btn-ghost btn-sm"
        onclick="(state.confirmDestructive ? confirm('Clear recently viewed history?') : true) && clearRecentlyViewed()">Clear</button>` : ''}
    </div>`;

  if (resolved.length === 0) {
    return `
      ${header}
      <div class="empty">
        <div class="empty-icon">🕘</div>
        <h3>Nothing here yet</h3>
        <p>Items you preview or open will appear here.</p>
      </div>`;
  }

  const now = new Date();
  function bucket(ts) {
    const d = new Date(ts);
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 14) return 'Last week';
    if (diffDays < 30) return `${Math.floor(diffDays/7)} weeks ago`;
    return 'Older';
  }
  function relTs(ts) {
    const ms = Date.now() - new Date(ts).getTime();
    const mins = ms / 60000;
    if (mins < 1) return 'just now';
    if (mins < 60) return `${Math.floor(mins)}m ago`;
    const hrs = mins / 60;
    if (hrs < 24) return `${Math.floor(hrs)}h ago`;
    const days = hrs / 24;
    if (days < 7) return `${Math.floor(days)}d ago`;
    return `${Math.floor(days/7)}w ago`;
  }

  const buckets = [];
  const seen = new Map();
  for (const r of resolved) {
    const label = bucket(r.ts);
    if (!seen.has(label)) { seen.set(label, buckets.length); buckets.push({ label, items: [] }); }
    buckets[seen.get(label)].items.push(r);
  }

  return `
    ${header}
    <div style="display:flex;flex-direction:column;gap:16px">
      ${buckets.map(b => `
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;padding-left:2px">${escHtml(b.label)}</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${b.items.map(({ item, ts }) => `
              <div onclick="showPreview(${item.id})"
                style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;align-items:flex-start;gap:10px;cursor:pointer;-webkit-tap-highlight-color:transparent">
                <div style="font-size:14px;flex-shrink:0;margin-top:1px">${item.type === 'comment' ? '💬' : '📝'}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:500;color:var(--text);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
                    ${escHtml(item.title || 'Untitled')}
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">
                    ${item.subreddit ? `<span>r/${escHtml(item.subreddit)}</span>` : ''}
                    <span>${relTs(ts)}</span>
                  </div>
                </div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

// ─── POST PREVIEW ─────────────────────────────────────────────────────────────

export async function showPreview(itemId) {
  const item = await db.items.get(itemId);
  if (!item) return;
  trackRecentlyViewed(item.id);

  document.getElementById('preview-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.id = 'preview-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closePreview(); });

  const permalinkUrl = fullUrl(item.permalink || item.url || '');
  const hasBody = !!(item.body && item.body.trim());

  // Collect all external links for the "Open link" button/picker
  const externalLinks = [];
  // 1. Post-level URL (link posts)
  if (item.url && !item.url.includes('reddit.com')) {
    externalLinks.push({ label: item.url.length > 60 ? item.url.slice(0, 57) + '…' : item.url, url: fullUrl(item.url) });
  }
  // 2. Links from body text
  if (item.body) {
    // Named markdown links [text](url)
    const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
    for (const m of mdLinks) {
      const url = fullUrl(m[2]);
      if (!externalLinks.find(l => l.url === url)) {
        externalLinks.push({ label: m[1].slice(0, 60), url });
      }
    }
    // Bare URLs
    const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
    for (const m of bareLinks) {
      const url = fullUrl(stripUrlPunct(m[1]));
      if (!externalLinks.find(l => l.url === url)) {
        externalLinks.push({ label: url.length > 60 ? url.slice(0, 57) + '…' : url, url });
      }
    }
  }

  const metaHtml = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
      ${item.subreddit ? `<span class="subreddit-tag" style="cursor:pointer" onclick="closePreview();applySearch('r/${escHtml(item.subreddit)}')">r/${escHtml(item.subreddit)}</span>` : ''}
      ${item.isFavourite ? '<span style="color:#f59e0b">⭐</span>' : ''}
    </div>
    <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted);flex-wrap:wrap">
      ${item.author ? `<span>u/${escHtml(item.author)}</span>` : ''}
      ${item.postCreatedAt ? `<span>📅 ${fmtDate(item.postCreatedAt)}</span>` : ''}
      ${item.score != null ? `<span>⬆ ${item.score.toLocaleString()}</span>` : ''}
      ${item.rating ? `<span style="color:#f59e0b">${'★'.repeat(item.rating)}${'☆'.repeat(5-item.rating)}</span>` : ''}
    </div>`;

  const bodyHtml = hasBody
    ? renderMarkdown(item.body)
    : externalLinks.length
      ? `<div style="text-align:center;padding:40px 20px">
           <div style="font-size:48px;margin-bottom:16px">🔗</div>
           <div style="font-size:14px;color:var(--text-muted);word-break:break-all">${escHtml(externalLinks[0].url)}</div>
         </div>`
      : `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
           <div style="font-size:48px;margin-bottom:12px">📄</div>
           No local content — open on Reddit to read.
         </div>`;

  // Open link button: single link opens directly, multiple shows picker
  let openLinkBtn = '';
  if (externalLinks.length === 1) {
    openLinkBtn = `<a class="btn btn-primary" style="flex:1;justify-content:center;text-decoration:none"
      href="${escHtml(externalLinks[0].url)}" target="_blank" rel="noopener">🔗 Open link ↗</a>`;
  } else if (externalLinks.length > 1) {
    openLinkBtn = `<button class="btn btn-primary" style="flex:1;justify-content:center"
      onclick="showLinkPicker(${item.id})">🔗 Open link (${externalLinks.length}) ↗</button>`;
  }

  overlay.innerHTML = `
    <div class="preview-sheet" id="preview-sheet">
      <div class="preview-drag-handle"></div>
      <div class="preview-header">
        <div style="flex:1;min-width:0">
          ${metaHtml}
        </div>
        <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:22px;padding:0;line-height:1;flex-shrink:0;align-self:flex-start"
          onclick="closePreview()">✕</button>
      </div>
      <div class="preview-body">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:19px;line-height:1.3;margin-bottom:16px;color:var(--text)">
          ${escHtml(item.title || 'Untitled')}
        </div>
        ${bodyHtml}
      </div>
      <div class="preview-footer">
        ${openLinkBtn}
        <a class="btn ${openLinkBtn ? 'btn-ghost' : 'btn-primary'}" style="flex:1;justify-content:center;text-decoration:none"
          href="${escHtml(permalinkUrl)}" target="_blank" rel="noopener">📖 Open on Reddit ↗</a>
        <button class="btn btn-ghost" onclick="closePreview()">Close</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Swipe-to-dismiss gestures: swipe down from header/handle, or swipe right from left edge
  const sheet = overlay.querySelector('#preview-sheet');
  const header = sheet.querySelector('.preview-header');
  const handle = sheet.querySelector('.preview-drag-handle');
  let touchStartY = 0, touchStartX = 0, gestureMode = null, dismissed = false;
  // gestureMode: null (undecided) | 'down' | 'right' | 'none'

  function dismissSheet(direction) {
    if (dismissed) return;
    dismissed = true;
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    sheet.style.transform = direction === 'right' ? 'translateX(110%)' : 'translateY(110%)';
    overlay.style.transition = 'opacity 0.25s ease';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 280);
  }

  function snapBack() {
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    sheet.style.transform = '';
    overlay.style.background = '';
  }

  function onTouchStart(e) {
    if (dismissed) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    gestureMode = null;
    sheet.style.transition = 'none';
  }

  function onTouchMove(e) {
    if (dismissed) return;
    const dy = e.touches[0].clientY - touchStartY;
    const dx = e.touches[0].clientX - touchStartX;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    // Decide gesture mode on first meaningful movement
    if (gestureMode === null) {
      if (adx < 6 && ady < 6) return; // not moved enough yet
      const fromLeftEdge = touchStartX < 40;
      const headerBottom = header.getBoundingClientRect().bottom;
      const fromHeaderZone = touchStartY <= headerBottom;
      if (fromLeftEdge && dx > 0 && adx > ady) {
        gestureMode = 'right';
      } else if (fromHeaderZone && ady > adx) {
        gestureMode = 'down';
      } else {
        gestureMode = 'none'; // not a recognised gesture zone — ignore
      }
    }

    if (gestureMode === 'right') {
      if (dx < 0) return; // no leftward drag
      e.preventDefault();
      const progress = Math.min(dx / window.innerWidth, 1);
      sheet.style.transform = `translateX(${dx}px)`;
      overlay.style.background = `rgba(0,0,0,${0.85 * (1 - progress * 0.9)})`;
    } else if (gestureMode === 'down') {
      if (dy < 0) { sheet.style.transform = `translateY(${dy * 0.15}px)`; return; }
      e.preventDefault();
      const progress = Math.min(dy / window.innerHeight, 1);
      sheet.style.transform = `translateY(${dy}px)`;
      overlay.style.background = `rgba(0,0,0,${0.85 * (1 - progress * 0.8)})`;
    }
  }

  function onTouchEnd(e) {
    if (dismissed || gestureMode === null || gestureMode === 'none') return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (gestureMode === 'right' && dx > 80) {
      dismissSheet('right');
    } else if (gestureMode === 'down' && dy > 120) {
      dismissSheet('down');
    } else {
      snapBack();
    }
    gestureMode = null;
  }

  // Register on the whole overlay — gestureMode detection decides what to track.
  // Down swipes only commit when starting from header/handle (checked via touchStartY
  // falling within the header bounds), right-edge swipes work from anywhere.
  overlay.addEventListener('touchstart', onTouchStart, { passive: true });
  overlay.addEventListener('touchmove', onTouchMove, { passive: false });
  overlay.addEventListener('touchend', onTouchEnd, { passive: true });
}

export function closePreview() {
  document.getElementById('preview-overlay')?.remove();
}

export async function showLinkPicker(itemId) {
  const item = await db.items.get(itemId);
  if (!item) return;
  trackRecentlyViewed(item.id);

  // Re-derive links the same way showPreview does
  const links = [];
  if (item.url && !item.url.includes('reddit.com')) {
    links.push({ label: item.url.length > 70 ? item.url.slice(0, 67) + '…' : item.url, url: fullUrl(item.url) });
  }
  if (item.body) {
    const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
    for (const m of mdLinks) {
      const url = fullUrl(m[2]);
      if (!links.find(l => l.url === url)) links.push({ label: m[1].slice(0, 70), url });
    }
    const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
    for (const m of bareLinks) {
      const url = fullUrl(stripUrlPunct(m[1]));
      if (!links.find(l => l.url === url)) {
        links.push({ label: url.length > 70 ? url.slice(0, 67) + '…' : url, url });
      }
    }
  }

  const sheet = document.createElement('div');
  sheet.id = 'link-picker-overlay';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end';
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
  sheet.innerHTML = `
    <div style="background:var(--surface);border-radius:20px 20px 0 0;width:100%;padding:20px;max-height:70vh;overflow-y:auto">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:16px;font-size:16px">Choose a link</div>
      ${links.map((l, i) => `
        <a href="${escHtml(l.url)}" target="_blank" rel="noopener"
          style="display:block;padding:12px;border-radius:10px;background:var(--surface2);margin-bottom:8px;text-decoration:none;color:var(--text)"
          onclick="document.getElementById('link-picker-overlay')?.remove()">
          <div style="font-size:13px;color:var(--text);margin-bottom:2px">${escHtml(l.label)}</div>
          <div style="font-size:11px;color:var(--accent2);word-break:break-all">${escHtml(l.url)}</div>
        </a>`).join('')}
      <button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:4px"
        onclick="document.getElementById('link-picker-overlay')?.remove()">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
}

// ─── ITEM ACTIONS ────────────────────────────────────────────────────────────

export function renderSortControl(onChangeFn = 'setSort') {
  const opts = [
    { key: 'affinity',     label: '✦ Affinity' },
    { key: 'savedAt',      label: 'Date saved' },
    { key: 'postCreatedAt',label: 'Date posted' },
    { key: 'score',        label: 'Score' },
    { key: 'rating',       label: 'Rating' },
    { key: 'subreddit',    label: 'Subreddit' },
    { key: 'title',        label: 'Title' },
  ];
  const arrow = state.sortDir === 'desc' ? '↓' : '↑';
  const optHtml = opts.map(o =>
    `<option value="${o.key}" ${o.key === state.sortBy ? 'selected' : ''}>${o.label}</option>`
  ).join('');
  return `<div id="sort-control" style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
    <span>Sort:</span>
    <select style="background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:2px 6px;cursor:pointer"
      onchange="${onChangeFn}(this.value)">
      ${optHtml}
    </select>
    <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:0 2px"
      onclick="state.sortDir=state.sortDir==='desc'?'asc':'desc';${onChangeFn==='setSort'?'renderBrowseList()':'render()'}"
      title="Toggle direction">${arrow}</button>
  </div>`;
}

export function renderTrashView() {
  const items = filteredItems();

  if (state.showDeleted) {
    const deletedItems = state.items.filter(i => i.isPermanentlyDeleted)
      .sort((a, b) => new Date(b.deletedAt||0) - new Date(a.deletedAt||0));
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-family:'Syne',sans-serif;font-weight:600">🗑️ Deleted Items (${deletedItems.length})</div>
        <button class="btn btn-ghost btn-sm" onclick="state.showDeleted=false;render()">← Back</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        These items are hidden from your library. Restore to bring them back, or Purge to remove them from the database entirely.
      </p>
      ${deletedItems.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>No deleted items</h3></div>
      ` : `
        <button class="btn btn-danger btn-sm" style="width:100%;justify-content:center;margin-bottom:12px"
          onclick="if(confirm('Remove ${deletedItems.length} item${deletedItems.length!==1?'s':''} from the database entirely? If they still exist in your Reddit saves they may reappear on next feed sync.'))purgeDeletedItems()">
          ⚠️ Purge all from database
        </button>
        ${deletedItems.map(item => {
          const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
          const deletedStr = item.deletedAt ? new Date(item.deletedAt).toLocaleDateString() : '';
          return `
            <div class="card" style="border-color:rgba(239,68,68,0.15);opacity:0.8">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
                ${item.subreddit ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>` : ''}
                ${deletedStr ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">Deleted ${deletedStr}</span>` : ''}
              </div>
              <div onclick="showPreview(${item.id})" style="font-family:'Syne',sans-serif;font-weight:600;font-size:14px;color:var(--text);line-height:1.3;margin-bottom:8px;cursor:pointer">
                ${escHtml(item.title || 'Untitled')}
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-ghost btn-sm" onclick="showPreview(${item.id})">👁 View</button>
                <button class="btn btn-ghost btn-sm" onclick="restoreDeletedItem(${item.id})">↩ Restore</button>
                <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener">↗ Open</a>
                <button class="btn btn-danger btn-sm" onclick="if(confirm('Remove from database entirely? It may reappear on next feed sync.'))purgeSingleItem(${item.id})">⚠ Purge</button>
              </div>
            </div>`;
        }).join('')}
      `}
    `;
  }

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-family:'Syne',sans-serif;font-weight:600">🗑️ Trash (${items.length})</div>
      <div style="display:flex;gap:8px">
        ${items.length > 0 ? `<button class="btn btn-danger btn-sm" onclick="deleteAllTrashed()">Delete all</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="state.showTrash=false;render()">← Back</button>
      </div>
    </div>
    ${items.length === 0 ? `
      <div class="empty"><div class="empty-icon">🗑️</div><h3>Trash is empty</h3><p>Items you dislike will appear here.</p></div>
    ` : items.map(item => {
      const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
      return `
        <div class="card" style="border-color:rgba(239,68,68,0.2)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
            ${item.subreddit ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>` : ''}
            ${item.author ? `<span style="font-size:11px;color:var(--text-muted)">u/${escHtml(item.author)}</span>` : ''}
          </div>
          <div onclick="showPreview(${item.id})" style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px;color:var(--text);line-height:1.3;margin-bottom:8px;cursor:pointer">
            ${escHtml(item.title || 'Untitled')}
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick="showPreview(${item.id})">👁 View</button>
            <button class="btn btn-ghost btn-sm" onclick="restoreItem(${item.id})">↩ Restore</button>
            <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener">↗ Open</a>
            <button class="btn btn-danger btn-sm" onclick="if(confirm('Permanently delete this item?'))deleteItemPermanently(${item.id})">🗑 Delete</button>
          </div>
        </div>`;
    }).join('')}
    ${(() => {
      const deletedCount = state.items.filter(i => i.isPermanentlyDeleted).length;
      return deletedCount > 0 ? `
        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
          <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;opacity:0.7"
            onclick="state.showDeleted=true;render()">
            View ${deletedCount} deleted item${deletedCount!==1?'s':''}
          </button>
        </div>` : '';
    })()}
  `;
}

export function renderAuthorList() {
  // Build sorted author list — min 2 saves, sorted by count desc
  const authors = Object.entries(state.authorFreq)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (authors.length === 0) {
    return `<div class="empty"><div class="empty-icon">👤</div><h3>No repeat authors yet</h3>
      <p>Authors you've saved 2 or more times will appear here.</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="state.showAuthorList=false;render()">← Back</button>
    </div>`;
  }

  // Group into tiers
  const tiers = [
    { label: '🏆 10+ saves', min: 10, items: authors.filter(([_,c]) => c >= 10) },
    { label: '⭐ 5–9 saves',  min: 5,  items: authors.filter(([_,c]) => c >= 5 && c < 10) },
    { label: '👤 2–4 saves',  min: 2,  items: authors.filter(([_,c]) => c >= 2 && c < 5) },
  ].filter(t => t.items.length > 0);

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:18px">Frequent Authors</div>
      <button class="btn btn-ghost btn-sm" onclick="state.showAuthorList=false;render()">← Back</button>
    </div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
      ${authors.length} author${authors.length!==1?'s':''} saved multiple times. Tap any to search their posts.
    </p>
    ${tiers.map(tier => `
      <div style="margin-bottom:20px">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${tier.label}</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${tier.items.map(([author, count]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;cursor:pointer"
              onclick="state.showAuthorList=false;applySearch('u/${escHtml(author)}')">
              <span style="font-size:14px;color:var(--text)">u/${escHtml(author)}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;color:var(--text-muted)">${count} save${count!==1?'s':''}</span>
                <span style="font-size:12px;color:var(--accent2)">→</span>
              </div>
            </div>`).join('')}
        </div>
      </div>
    `).join('')}`;
}

export function renderBrowse() {
  _searchLookup = []; // reset lookup table for this render

  // Trash / deleted views take over the whole browse area
  if (state.showTrash || state.showDeleted) return renderTrashView();

  // Author list view
  if (state.showAuthorList) return renderAuthorList();

  const items = filteredItems();
  const q = state.search.trim();
  const deadCount = state.items.filter(i => i.enrichStatus === 'dead' && !i.isPermanentlyDeleted).length;
  const trashCount = state.items.filter(i => i.isDisliked && !i.isPermanentlyDeleted).length;
  const favCount = state.items.filter(i => i.isFavourite).length;
  const tagLists = state.lists.filter(l => l.isTag && l.type === 'smart').slice().sort((a,b) => (a.tagName||a.name).localeCompare(b.tagName||b.name));

  return `
    <!-- ── Editing list banner ──────────────────────────────────────────── -->
    ${state.editingListId ? (() => {
      const editingList = state.lists.find(l => l.id === state.editingListId);
      return editingList ? `
        <div style="background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span style="font-size:13px;color:var(--accent2)">✏️ Editing: <strong>${escHtml(editingList.name)}</strong></span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary btn-sm" onclick="saveCurrentSearchAsList(${state.editingListId})">Save as list</button>
            <button class="btn btn-ghost btn-sm" onclick="state.editingListId=null;newSearch()" title="Stop editing">✕</button>
          </div>
        </div>` : '';
    })() : ''}

    <!-- ── Tag chip tray ─────────────────────────────────────────────────── -->
    ${tagLists.length > 0 ? (() => {
      // When editing a tag, compute which tags would cause cycles
      const blockedTagIds = state.editingListId ? (() => {
        const graph = buildTagDepGraph();
        return getTagsContaining(state.editingListId, graph);
      })() : new Set();
      const visibleTags = (state.tagTrayCollapsed ? tagLists.filter(l => state.activeTagIds.includes(+l.id)) : tagLists)
        .filter(l => l.id !== state.editingListId); // hide the tag being edited
      return `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${visibleTags.map(l => {
            const active = state.activeTagIds.includes(+l.id);
            const cached = state.tagCache.get(l.id);
            const count = cached ? cached.count : 0;
            const blocked = blockedTagIds.has(l.id);
            return `<button
              style="display:inline-flex;align-items:center;gap:5px;background:${active?'var(--accent2)':blocked?'var(--surface2)':'var(--surface)'};border:1px solid ${active?'var(--accent2)':blocked?'rgba(255,255,255,0.1)':'var(--border)'};border-radius:20px;padding:4px 12px;font-size:12px;cursor:${blocked?'default':'pointer'};color:${active?'#fff':blocked?'var(--text-muted)':'var(--text)'};font-weight:${active?'600':'400'};opacity:${blocked?'0.5':'1'}"
              onclick="${blocked ? `showToast('Adding this tag would create a circular reference','warning')` : `toggleTagChip(${l.id})`}">
              #${escHtml(l.tagName || l.name)}
              <span style="font-size:10px;opacity:0.75">${count}</span>
            </button>`;
          }).join('')}
          ${state.activeTagIds.length > 0 ? `
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);margin-left:4px;cursor:pointer;user-select:none">
              <input type="checkbox" ${state.tagMode==='OR'?'checked':''}
                onchange="state.tagMode=this.checked?'OR':'AND';renderBrowseList();render()"
                style="width:14px;height:14px">
              OR
            </label>
            <button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:2px 6px"
              onclick="state.activeTagIds=[];state.tagMode='AND';renderBrowseList();render()">Clear</button>
          ` : ''}
          <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:12px"
            onclick="state.tagTrayCollapsed=!state.tagTrayCollapsed;render()">
            ${state.tagTrayCollapsed ? '▸ Show tags' : '▾ Collapse tags'}
          </button>
        </div>
      </div>`;
    })() : ''}

    <!-- ── Search input + filter toggle ────────────────────────────────── -->
    <div style="display:flex;gap:8px;align-items:stretch;margin-bottom:8px">
      <div class="search-wrap" style="flex:1;min-width:0">
        <span class="search-icon">🔍</span>
        <input class="input" id="search-input"
          placeholder='Search… "phrase"  a,b,c  *wild*  r/sub  u/name  -exclude'
          value="${escHtml(state.search)}"
          oninput="handleSearchInput(this.value)"
          onfocus="state.searchFocused=true"
          onblur="setTimeout(()=>{state.searchFocused=false},300)"
          onkeydown="if(event.key==='Enter'&&state.search.trim()){commitSearch(state.search);renderBrowseList();}"
          autocapitalize="none" autocorrect="off" spellcheck="false"
          style="width:100%;padding-right:${state.search ? '36px' : '12px'}">
        <button id="search-clear-x"
          style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;line-height:1;padding:0;display:${state.search ? 'block' : 'none'}"
          onclick="applySearch('')">✕</button>
      </div>
      <button onclick="state.showFilters=!state.showFilters;render()"
        style="background:${hasActiveFilters()?'var(--accent2)':'var(--surface)'};border:1px solid ${hasActiveFilters()?'var(--accent2)':'var(--border)'};border-radius:10px;padding:0 14px;height:44px;cursor:pointer;font-size:13px;color:${hasActiveFilters()?'#fff':'var(--text-muted)'};white-space:nowrap;flex-shrink:0;align-self:stretch">
        ${hasActiveFilters() ? '⚙️ Filters ●' : '⚙️ Filters'}
      </button>
    </div>
    <div style="min-height:18px;margin-top:4px;text-align:right">
      <button id="clear-search-btn" onclick="newSearch()"
        style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:0;opacity:0.7;visibility:${(state.search || state.activeTagIds.length > 0 || hasActiveFilters() || state.sortBy !== 'postCreatedAt' || state.sortDir !== 'desc') ? 'visible' : 'hidden'}">
        ✕ Clear search &amp; filters
      </button>
    </div>

    <!-- ── Search syntax hint ──────────────────────────────────────────── -->
    <details style="margin:-2px 0 8px;font-size:11px;color:var(--text-muted)">
      <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:4px;width:fit-content">
        <span style="opacity:0.5">ℹ︎ Search tips</span>
      </summary>
      <div style="margin-top:8px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;display:grid;gap:6px;line-height:1.8">
        <div><code style="color:var(--accent2);font-size:11px">python tutorial</code> <span style="color:var(--text-muted)">— both words must appear (AND)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">react, vue, svelte</code> <span style="color:var(--text-muted)">— any of these words (OR)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">(react, vue, svelte)</code> <span style="color:var(--text-muted)">— same as above, parentheses are optional for a pure OR search</span></div>
        <div><code style="color:var(--accent2);font-size:11px">(dogs, cats) horses cows</code> <span style="color:var(--text-muted)">— must contain horses AND cows AND at least one of dogs/cats (mixed AND + OR)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">"machine learning"</code> <span style="color:var(--text-muted)">— match this exact word or phrase anywhere in the text</span></div>
        <div><code style="color:var(--accent2);font-size:11px">-javascript</code> <span style="color:var(--text-muted)">— exclude this word</span></div>
        <div><code style="color:var(--accent2);font-size:11px">run*</code> <span style="color:var(--text-muted)">— words starting with "run" (running, runner…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">*ness</code> <span style="color:var(--text-muted)">— words ending with "ness" (happiness, darkness…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">*witch*</code> <span style="color:var(--text-muted)">— words containing "witch" (switch, bewitched…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">r/programming</code> <span style="color:var(--text-muted)">— filter by subreddit</span></div>
        <div><code style="color:var(--accent2);font-size:11px">u/username</code> <span style="color:var(--text-muted)">— filter by author</span></div>
        <div style="margin-top:2px;color:var(--text-muted);font-size:11px">Bare words search titles only (enable "Search body text" in Filters to include post/comment text). Use wildcards for partial matching or quotes for exact phrases. Use r: and u: to search by subreddit or author.</div>
      </div>
    </details>

    <!-- ── Recent searches ──────────────────────────────────────────────── -->
    ${state.recentSearches.length > 0 ? `
      <div style="margin:-2px 0 8px">
        <button onclick="state.recentSearchesOpen=!state.recentSearchesOpen;render()"
          style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:5px;padding:2px 0;color:var(--text-muted);font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase">
          <span style="transition:transform 0.15s;display:inline-block;transform:rotate(${state.recentSearchesOpen?'90':'0'}deg)">▶</span>
          Recent (${state.recentSearches.length})
        </button>
        ${state.recentSearchesOpen ? `
          <div id="recent-searches-row" style="margin-top:6px">
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${state.recentSearches.map(s => { const i = _sl(s); return `
                <div style="display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:12px;cursor:pointer;max-width:200px"
                  onclick="runSavedSearch(${i});state.recentSearchesOpen=false">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escHtml(s)}</span>
                  <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0;line-height:1;flex-shrink:0"
                    title="Remove" onclick="event.stopPropagation();removeSavedSearchByIndex(${i})">✕</button>
                </div>`; }).join('')}
            </div>
          </div>` : ''}
      </div>` : ''}

    <!-- ── Filter panel (slide-down) ────────────────────────────────────── -->
    ${state.showFilters ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:4px;display:grid;gap:12px">

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">TYPE</div>
            <div style="display:flex;gap:6px">
              ${['all','post','comment'].map(t => `
                <button class="filter-pill ${state.filterType===t?'active':''}" style="flex:1;justify-content:center"
                  onclick="state.filterType='${t}';render()">${t==='all'?'All':t==='post'?'📝 Posts':'💬 Comments'}</button>
              `).join('')}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:0;width:100%">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">MIN RATING</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="filter-pill ${state.filterRating===0?'active':''}" onclick="state.filterRating=0;render()" style="flex:1;justify-content:center;min-width:36px">Any</button>
              ${[1,2,3,4,5].map(n => `
                <button class="filter-pill ${state.filterRating===n?'active':''}" onclick="state.filterRating=${n};render()" style="flex:1;justify-content:center;min-width:36px;padding:6px 4px;font-size:11px">
                  ${'★'.repeat(n)}
                </button>`).join('')}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.filterFavourite?'checked':''} onchange="state.filterFavourite=this.checked;render()">
            ⭐ Favourites only
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.filterHasLinks?'checked':''} onchange="state.filterHasLinks=this.checked;render()">
            🔗 Has links
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.searchBody?'checked':''} onchange="state.searchBody=this.checked;renderBrowseList()">
            📄 Search body text
          </label>
        </div>

        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:11px;color:var(--text-muted);font-weight:600">DATE RANGE</div>
            <select class="input" style="width:auto;font-size:13px;padding:4px 8px;height:auto" onchange="state.filterDateField=this.value;render()">
              <option value="postCreatedAt" ${state.filterDateField==='postCreatedAt'?'selected':''}>Post date</option>
              <option value="savedAt" ${state.filterDateField==='savedAt'?'selected':''}>Saved date</option>
            </select>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <div style="flex:1;display:flex;flex-direction:column;gap:2px">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:0.04em">FROM</div>
              <input class="input" type="date" style="width:100%;font-size:16px;padding:8px 10px" value="${state.filterDateFrom}"
                onchange="state.filterDateFrom=this.value;render()">
            </div>
            <div style="color:var(--text-muted);font-size:14px;padding-top:16px">—</div>
            <div style="flex:1;display:flex;flex-direction:column;gap:2px">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:0.04em">TO</div>
              <input class="input" type="date" style="width:100%;font-size:16px;padding:8px 10px" value="${state.filterDateTo}"
                onchange="state.filterDateTo=this.value;render()">
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:100px;position:relative">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">SUBREDDIT</div>
            <input class="input" id="filter-subreddit-input" style="font-size:16px;width:100%" placeholder="e.g. programming"
              value="${escHtml(state.filterSubreddit)}"
              oninput="handleFilterSubreddit(this.value)"
              onblur="_hideFilterSuggestions()">
            <div id="subreddit-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:2px;
              box-shadow:0 4px 12px rgba(0,0,0,0.3);overflow:hidden"></div>
          </div>
          <div style="flex:1;min-width:100px;position:relative">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">AUTHOR</div>
            <input class="input" id="filter-author-input" style="font-size:16px;width:100%" placeholder="e.g. username"
              value="${escHtml(state.filterAuthor)}"
              oninput="handleFilterAuthor(this.value)"
              onblur="_hideFilterSuggestions()">
            <div id="author-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:2px;
              box-shadow:0 4px 12px rgba(0,0,0,0.3);overflow:hidden"></div>
          </div>
        </div>

        <button class="btn btn-ghost btn-sm" onclick="clearFilters()" style="width:100%;justify-content:center;color:var(--danger)">
          ✕ Clear all filters
        </button>
      </div>
    ` : ''}

    <!-- ── savedAt clump warning ──────────────────────────────────────── -->
    ${state.sortBy === 'savedAt' && (checkSavedAtClumps(), state.savedAtClumpy) ? `
      <div style="font-size:11px;color:var(--warning);background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:8px;padding:6px 10px;margin-bottom:6px;line-height:1.5">
        ⚠ Most items share a synthetic import date — sort order may not reflect when you actually saved things.
        <button onclick="showPage('settings')" style="background:none;border:none;cursor:pointer;color:var(--accent2);font-size:11px;padding:0;white-space:nowrap">Run the patch tool →</button>
      </div>` : ''}

    <!-- ── Result count + save search + sort ───────────────────────────── -->
    <div id="search-result-info" style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;margin-bottom:4px;min-height:24px;gap:8px">
      <span style="font-size:12px;color:var(--text-muted);flex-shrink:0">
        ${items.length.toLocaleString()} ${q ? 'result' : 'item'}${items.length!==1?'s':''}
      </span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
        ${(q || state.activeTagIds.length > 0) && !state.editingListId ? `
          <button style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent2);padding:2px 4px;white-space:nowrap"
            onclick="saveCurrentSearchAsList()">
            + Save as list</button>` : ''}
        ${renderSortControl()}
      </div>
    </div>

    <!-- ── Quick filter pills ───────────────────────────────────────────── -->
    <div class="filter-row">
      ${deadCount > 0 ? `<button class="filter-pill ${state.showDead?'active':''}" onclick="setFilter('dead')" style="${state.showDead?'':'opacity:0.6'}">⚰️ ${state.showDead ? 'Unavailable ✕' : `Unavailable (${deadCount})`}</button>` : ''}
      ${state.showDead && deadCount > 0 ? `<button class="filter-pill" onclick="trashAllDead()" style="color:var(--danger);border-color:var(--danger);opacity:0.85">🗑️ Trash all (${deadCount})</button>` : ''}
      ${trashCount > 0 ? `<button class="filter-pill" onclick="state.showTrash=true;render()" style="opacity:0.7">🗑️ Trash (${trashCount})</button>` : ''}
      <button class="filter-pill" onclick="state.showAuthorList=true;render()" style="opacity:0.8">👤 Authors</button>
    </div>

    <!-- ── Results ───────────────────────────────────────────────────────── -->
    <div id="browse-list">
      ${renderBrowseItems(items)}
    </div>
  `;
}

// ─── SEARCH PARSER ───────────────────────────────────────────────────────────
// Syntax:
//   bare words          → AND logic, whole-word match
//   a, b, c             → OR group (commas at top level = OR), whole-word each
//   (a, b, c)           → OR group (explicit parens), whole-word each
//   "quoted phrase"     → exact substring match (no word boundary)
//   *word               → suffix wildcard — matches anything ending in "word"
//   word*               → prefix wildcard — matches anything starting with "word"
//   *word*              → full wildcard — substring match (same as old default)
//   -word / -"phrase"   → exclusion
//   r:subreddit         → subreddit field (partial)
//   u:username          → author field (partial)
//   type:post/comment   → type filter
//   [#tag name]         → tag token — resolves to the named tag's smart list query at match time

// ─── TAG TOKEN HELPERS ───────────────────────────────────────────────────────

// Validate a tag name — only alphanum, spaces, &, / allowed
export let _searchLookup = [];
export function _sl(s) {
  const i = _searchLookup.length;
  _searchLookup.push(s);
  return i;
}
export let _searchDebounceTimer = null;
export let _filterSubredditTimer = null;
export let _filterAuthorTimer = null;

export function handleSearchInput(value) {
  state.search = value;
  // Do NOT call render() here — that destroys the input and dismisses the keyboard.
  // Manually update the inline ✕ inside the search wrap
  const inlineClear = document.getElementById('search-clear-x');
  if (inlineClear) inlineClear.style.display = value ? 'block' : 'none';
  // Update the persistent clear button visibility
  const clearBtn = document.getElementById('clear-search-btn');
  if (clearBtn) {
    const hasState = value || state.activeTagIds.length > 0 || hasActiveFilters() ||
      state.sortBy !== 'postCreatedAt' || state.sortDir !== 'desc';
    clearBtn.style.visibility = hasState ? 'visible' : 'hidden';
  }

  // Count and save button are updated by renderBrowseList() when debounce fires.
  // Don't call filteredItems() here — it causes stale/misleading counts mid-typing.

  if (!value.trim()) {
    renderBrowseList();
    return;
  }

  const lastChar = value[value.length - 1];
  const words = value.trim().split(/\s+/);
  const currentWord = words[words.length - 1];
  const bareWord = currentWord.replace(/^[-"r\/u\:\/]*/,'').replace(/"/g,'');

  // Trigger if: space typed, bare word ≥4 chars, or current word is a complete field token (r/x or u/x with ≥1 char after slash)
  const isCompleteFieldToken = /^[rRuU][:/]\S+$/.test(currentWord);
  const shouldTrigger = lastChar === ' ' || bareWord.length >= 3 || isCompleteFieldToken;

  clearTimeout(_searchDebounceTimer);
  if (shouldTrigger) {
    _searchDebounceTimer = setTimeout(() => renderBrowseList(), 120);
  }
}

export function handleFilterSubreddit(value) {
  state.filterSubreddit = value;
  _showFilterSuggestions('subreddit-suggestions', value, state.subredditList);
  clearTimeout(_filterSubredditTimer);
  _filterSubredditTimer = setTimeout(() => renderBrowseList(), 200);
}

export function handleFilterAuthor(value) {
  state.filterAuthor = value;
  _showFilterSuggestions('author-suggestions', value, state.authorList);
  clearTimeout(_filterAuthorTimer);
  _filterAuthorTimer = setTimeout(() => renderBrowseList(), 200);
}

export function _showFilterSuggestions(elId, value, list) {
  const el = document.getElementById(elId);
  if (!el) return;
  const q = value.trim().toLowerCase();
  if (!q) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const matches = list.filter(s => s.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q)) {
    el.innerHTML = ''; el.style.display = 'none'; return;
  }
  const field = elId === 'subreddit-suggestions' ? 'filterSubreddit' : 'filterAuthor';
  const inputId = elId === 'subreddit-suggestions' ? 'filter-subreddit-input' : 'filter-author-input';
  el.style.display = 'block';
  el.innerHTML = matches.map(m => `
    <div class="filter-suggestion-item" onmousedown="
      state.${field}='${m.replace(/'/g,"\\'")}';
      document.getElementById('${inputId}').value='${m.replace(/'/g,"\\'")}';
      document.getElementById('${elId}').style.display='none';
      renderBrowseList()">
      ${escHtml(m)}
    </div>`).join('');
}

export function _hideFilterSuggestions() {
  ['subreddit-suggestions','author-suggestions'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  });
}

export function renderRecentSearches() {
  const el = document.getElementById('recent-searches-row');
  if (!el) return;
  const recents = state.recentSearches;
  const show = state.searchFocused && !state.search.trim() && recents.length > 0;
  if (!show) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:6px">RECENT</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${recents.map(s => { const i = _sl(s); return `
        <div style="display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:12px;cursor:pointer;max-width:200px"
          onmousedown="event.preventDefault();runSavedSearch(${i})">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escHtml(s)}</span>
          <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0;line-height:1;flex-shrink:0"
            title="Remove"
            onmousedown="event.preventDefault();event.stopPropagation();removeSavedSearchByIndex(${i})">✕</button>
        </div>`; }).join('')}
    </div>`;
}

// Precomputed item→list-count map, rebuilt before each browse render
export let _listCountMap = new Map();
export function _rebuildListCountMap() {
  _listCountMap = new Map();
  for (const il of state.itemLists) {
    _listCountMap.set(il.itemId, (_listCountMap.get(il.itemId) || 0) + 1);
  }
}

export function renderBrowseItems(items) {
  if (items.length === 0) {
    return `<div class="empty"><div class="empty-icon">🔍</div><h3>No results</h3><p>Try adjusting your search or filters.</p></div>`;
  }
  _rebuildListCountMap();
  return items.map(item => renderItemCard(item, true)).join('');
}

export function renderBrowseList() {
  const el = document.getElementById('browse-list');
  if (!el) { render(); return; }
  const items = filteredItems();
  el.innerHTML = renderBrowseItems(items);
  // Update result count + save button in-place
  const countEl = document.getElementById('search-result-info');
  if (countEl) {
    const q = state.search.trim();
    const hasActivity = q || state.activeTagIds.length > 0;
    countEl.innerHTML = `
      <span style="font-size:12px;color:var(--text-muted);flex-shrink:0">
        ${items.length.toLocaleString()} ${q ? 'result' : 'item'}${items.length!==1?'s':''}
      </span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
      ${(q || state.activeTagIds.length > 0) && !state.editingListId ? `<button class="save-as-list-btn" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent2);padding:2px 4px;white-space:nowrap"
          onclick="saveCurrentSearchAsList()">
          + Save as list
        </button>` : ''}
        ${renderSortControl()}
      </div>`;
  }
}

export function renderItemCard(item, showActions, removeFromListId = null) {
  const badgeClass = item.type === 'comment' ? 'badge-comment' : 'badge-post';
  const badgeLabel = item.type === 'comment' ? '💬 Comment' : '📝 Post';
  const needsEnrich = !item.enriched;
  const inListCount = _listCountMap.get(item.id) || 0;

  // Date display: show post created date if available, otherwise saved date
  const postDate = item.postCreatedAt
    ? `<span class="date-item" title="Date posted to Reddit">📅 ${fmtDate(item.postCreatedAt)}</span>`
    : '';
  const savedDate = item.savedAt
    ? `<span class="date-item" title="Date synced/imported">💾 ${fmtDate(item.savedAt)}</span>`
    : '';

  // Show subreddit prominently, or a warning if missing
  const subredditDisplay = item.subreddit
    ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>`
    : `<span style="font-size:12px;color:var(--warning)">⚠ unknown subreddit</span>`;

  const titleDisplay = item.title
    ? escHtml(item.title)
    : `<span style="color:var(--text-muted);font-style:italic">No title — needs enrichment</span>`;

  // Open link: prefer permalink for comments (goes to comment context),
  // use url for link posts (goes to external destination)
  const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
  const permalinkUrl = fullUrl(item.permalink || item.url || '');

  // Star rating display (1-5)
  const ratingHtml = showActions ? `
    <div style="display:flex;align-items:center;gap:2px">
      ${[1,2,3,4,5].map(n => `
        <button style="background:none;border:none;cursor:pointer;font-size:14px;padding:1px;line-height:1;color:${(item.rating||0)>=n?'#f59e0b':'var(--border)'}"
          onclick="setRating(${item.id},${n})" title="${n} star${n!==1?'s':''}">★</button>
      `).join('')}
    </div>` : (item.rating ? `<span style="font-size:12px;color:#f59e0b">${'★'.repeat(item.rating)}${'☆'.repeat(5-item.rating)}</span>` : '');

  return `
    <div class="card ${needsEnrich ? 'needs-enrichment' : ''}" style="${item.isFavourite?'border-color:rgba(245,158,11,0.35)':''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span class="badge ${badgeClass}">${badgeLabel}</span>
        ${subredditDisplay}
        ${needsEnrich ? `<span class="badge badge-enriching">⚡ needs enrichment</span>` : ''}
        ${item.author ? (() => {
          const freq = state.authorFreq[item.author] || 0;
          const badge = freq >= 3
            ? `<span style="background:rgba(168,85,247,0.2);color:var(--accent2);border-radius:10px;padding:1px 6px;font-size:10px;margin-left:2px">${freq}×</span>`
            : '';
          return `<span style="font-size:11px;color:var(--text-muted);cursor:pointer"
            onclick="applySearch('u/${escHtml(item.author)}')"
            title="Search posts by this author">u/${escHtml(item.author)}${badge}</span>`;
        })() : ''}
      </div>

      <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px;color:var(--text);line-height:1.3;margin-bottom:6px;cursor:pointer"
        onclick="showPreview(${item.id})" title="Preview">
        ${titleDisplay}
      </div>

      ${item.body ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escHtml(item.body)}</div>` : ''}

      <div class="date-row">
        ${postDate}
        ${savedDate}
        ${item.score != null ? `<span class="date-item">⬆ ${item.score.toLocaleString()}</span>` : ''}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${showActions ? `
          <!-- Left group: non-destructive curation actions -->
          <div style="display:flex;align-items:center;gap:4px">
            ${ratingHtml}
            <button style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px;line-height:1;color:${item.isFavourite?'#f59e0b':'var(--text-muted)'}"
              onclick="toggleFavourite(${item.id})" title="${item.isFavourite?'Remove from favourites':'Add to favourites'}">
              ${item.isFavourite ? '⭐' : '☆'}
            </button>
            <button class="btn btn-ghost btn-sm" onclick="showListMenu(${item.id})" title="Add to list"
              style="${inListCount>0?'color:var(--accent2)':''}">
              ${inListCount > 0 ? `📋 ${inListCount}` : '📋'}
            </button>
          </div>
          <!-- Right group: open links -->
          <div style="margin-left:auto;display:flex;gap:4px;align-items:center">
            ${(() => {
              const links = [];
              if (item.url && !item.url.includes('reddit.com')) links.push(fullUrl(item.url));
              if (item.body) {
                const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
                for (const m of mdLinks) { const u = fullUrl(m[2]); if (!links.includes(u)) links.push(u); }
                const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
                for (const m of bareLinks) { const u = fullUrl(m[1]); if (!links.includes(u)) links.push(u); }
              }
              if (links.length === 0) return '';
              if (links.length === 1) return `<a class="btn btn-ghost btn-sm" href="${escHtml(links[0])}" target="_blank" rel="noopener" title="Open link" onclick="trackRecentlyViewed(${item.id})">🔗</a>`;
              return `<button class="btn btn-ghost btn-sm" onclick="showLinkPicker(${item.id})" title="Open link (${links.length})">🔗${links.length}</button>`;
            })()}
            <a class="btn btn-ghost btn-sm" href="${escHtml(permalinkUrl)}" target="_blank" rel="noopener" title="Open on Reddit" onclick="trackRecentlyViewed(${item.id})">↗</a>
          </div>
          <!-- Danger group: destructive actions, separated by gap -->
          <div style="display:flex;gap:4px;align-items:center;padding-left:4px;border-left:1px solid var(--border)">
            ${removeFromListId !== null ? `
              <button class="btn btn-ghost btn-sm" title="Remove from list"
                style="color:var(--warning)"
                onclick="(state.confirmDestructive ? confirm('Remove from list?') : true) && toggleItemList(${item.id},${removeFromListId})">✂️</button>
            ` : ''}
            <button class="btn btn-ghost btn-sm" title="Move to trash"
              style="color:var(--danger)"
              onclick="(state.confirmDestructive ? confirm('Move to trash?') : true) && dislikeItem(${item.id})">🗑️</button>
          </div>
        ` : `
          ${ratingHtml}
          <div style="margin-left:auto">
            <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener" onclick="trackRecentlyViewed(${item.id})">Open →</a>
          </div>
        `}
      </div>
    </div>
  `;
}

export function renderLists() {
  const allLists = state.lists;
  const separated = state.listSeparate;

  const renderListCard = (list) => {
    const isSmart = list.type === 'smart';
    const count = isSmart
      ? (state.tagCache.get(list.id)?.count ?? 0)
      : state.itemLists.filter(il => il.listId === list.id).length;
    return `
      <div class="card" style="cursor:pointer" onclick="state.listView=${list.id};render()">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px">${escHtml(list.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
              ${isSmart ? `<span style="color:var(--accent2)">✦ Smart</span> · ` : ''}${count} item${count!==1?'s':''}
              ${list.isTag ? `<span style="margin-left:6px;background:var(--accent2);color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;white-space:nowrap;display:inline-block">#${escHtml(list.tagName || list.name)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editList(${list.id})" title="Edit">✏️</button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();if(confirm('Delete list?'))deleteList(${list.id})" title="Delete" style="color:var(--danger)">🗑️</button>
          </div>
        </div>
        ${isSmart && list.query ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;font-style:italic">${escHtml(list.query)}</div>` : ''}
        ${isSmart && list.optionsJson ? (() => {
          const parts = optionsSummaryParts(list.optionsJson);
          if (!parts.length) return '';
          return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${parts.map(p => `<span style="font-size:10px;background:rgba(124,58,237,0.12);color:var(--accent2);border-radius:6px;padding:2px 6px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div>`;
        })() : ''}
      </div>`;
  };

  // List detail view
  if (state.listView !== 'all') {
    const list = state.lists.find(l => l.id === state.listView);
    if (!list) { state.listView = 'all'; return renderLists(); }
    const isSmart = list.type === 'smart';
    const tokens = isSmart ? parseSearchQuery(list.query || '') : [];

    const pinnedIds = new Set(state.itemLists.filter(il => il.listId === list.id).map(il => il.itemId));

    let smartItems = [];
    let extraPinnedItems = [];

    if (isSmart) {
      const cached = state.tagCache.get(list.id);
      const allMatching = cached
        ? state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead' && cached.itemIds.has(i.id))
        : state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead' && (tokens.length === 0 || itemMatchesTokens(i, tokens)));
      const matchingIds = new Set(allMatching.map(i => i.id));
      extraPinnedItems = sortItems(state.items.filter(i => pinnedIds.has(i.id) && !matchingIds.has(i.id) && !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead'));
      smartItems = sortItems(allMatching);
    }

    const staticItems = isSmart ? [] : sortItems(state.items.filter(i => pinnedIds.has(i.id) && !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead'));

    _rebuildListCountMap();
    const renderListCard = (i) => renderItemCard(i, true, list.id);
    const itemCount = (isSmart ? smartItems : staticItems).length + extraPinnedItems.length;

    return `
      <div class="section-header">
        <button class="btn btn-ghost btn-sm" onclick="state.listView='all';render()">← Lists</button>
        <div class="section-title" style="flex:1;text-align:center">${escHtml(list.name)}</div>
        <button class="btn btn-ghost btn-sm" onclick="editList(${list.id})">✏️</button>
      </div>
      ${isSmart ? (() => {
        const parts = list.optionsJson ? optionsSummaryParts(list.optionsJson) : [];
        const queryLine = list.query ? `<div>✦ Smart: <em>${escHtml(list.query)}</em></div>` : '';
        const optsLine = parts.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${parts.map(p => `<span style="font-size:10px;background:rgba(124,58,237,0.2);color:var(--accent2);border-radius:6px;padding:2px 6px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div><div style="font-size:10px;color:var(--text-muted);margin-top:5px">Filters &amp; sort apply here only — not when used as a #tag.</div>` : '';
        if (!queryLine && !optsLine) return '';
        return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;padding:8px 12px;background:rgba(168,85,247,0.08);border-radius:8px">${queryLine}${optsLine}</div>`;
      })() : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;min-height:24px">
        <span style="font-size:12px;color:var(--text-muted)">${itemCount.toLocaleString()} item${itemCount!==1?'s':''}</span>
        ${renderSortControl('setSortList')}
      </div>

      ${extraPinnedItems.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">📌 PINNED</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
          ${extraPinnedItems.map(renderListCard).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">✦ MATCHING</div>
      ` : ''}

      <div style="display:flex;flex-direction:column;gap:8px">
        ${(isSmart ? smartItems : staticItems).length === 0
          ? `<div class="empty"><div class="empty-icon">📋</div><h3>No items</h3><p>${isSmart ? 'No items match this search.' : 'Add items from the Browse tab using the 📋 button.'}</p></div>`
          : (isSmart ? smartItems : staticItems).map(renderListCard).join('')}
      </div>
    `;
  }

  // Sort and optionally separate
  const sorted = [...allLists].sort((a,b) => a.name.replace(/^[^a-zA-Z0-9]+/,'').localeCompare(b.name.replace(/^[^a-zA-Z0-9]+/,'')));
  const smarts = sorted.filter(l => l.type === 'smart');
  const statics = sorted.filter(l => l.type === 'static');
  const tagLists = smarts.filter(l => l.isTag).slice().sort((a,b) => (a.tagName||a.name).localeCompare(b.tagName||b.name));
  const nonTagSmarts = smarts.filter(l => !l.isTag);
  const firstGroup  = state.listSmartFirst ? smarts  : statics;
  const secondGroup = state.listSmartFirst ? statics : smarts;
  const firstLabel  = state.listSmartFirst ? '✦ SMART LISTS'  : '📋 STATIC LISTS';
  const secondLabel = state.listSmartFirst ? '📋 STATIC LISTS' : '✦ SMART LISTS';

  const renderSmartGroup = () => {
    if (smarts.length === 0) return '';
    const hasTagSub = tagLists.length > 0 && nonTagSmarts.length > 0;
    const allAreTags = tagLists.length > 0 && nonTagSmarts.length === 0;
    if (!hasTagSub) {
      // all smart lists are tags, or none are — flat list, no subsection
      return `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${smarts.map(renderListCard).join('')}</div>`;
    }
    return `
      <div style="margin-bottom:8px;padding:10px 12px;background:rgba(244,114,182,0.04);border:1px solid rgba(244,114,182,0.18);border-radius:10px;">
        <div onclick="state.tagsCollapsed=!state.tagsCollapsed;render()"
          style="font-size:11px;color:var(--accent3);font-weight:600;letter-spacing:0.05em;display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:2px 0;margin-bottom:${state.tagsCollapsed?'0':'8px'}">
          <span>🏷 TAGS</span>
          <span style="font-size:10px;transition:transform 0.2s;display:inline-block;transform:rotate(${state.tagsCollapsed?'-90deg':'0deg'})">▼</span>
        </div>
        ${state.tagsCollapsed ? '' : `<div style="display:flex;flex-direction:column;gap:8px">${tagLists.map(renderListCard).join('')}</div>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${nonTagSmarts.map(renderListCard).join('')}</div>
    `;
  };

  const renderSeparated = () => {
    const firstIsSmarts = state.listSmartFirst;
    const firstContent  = firstIsSmarts ? renderSmartGroup() : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${statics.map(renderListCard).join('')}</div>`;
    const secondContent = firstIsSmarts ? `<div style="display:flex;flex-direction:column;gap:8px">${statics.map(renderListCard).join('')}</div>` : renderSmartGroup();
    return `
      ${firstGroup.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${firstLabel}</div>
        ${firstContent}
      ` : ''}
      ${secondGroup.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${secondLabel}</div>
        ${secondContent}
      ` : ''}
    `;
  };

  return `
    <div class="section-header">
      <div class="section-title">Lists</div>
      <div style="display:flex;align-items:center;gap:6px;flex:1;margin-left:8px">
        ${allLists.length > 1 ? `
          <button class="btn btn-ghost btn-sm" onclick="state.listSeparate=!state.listSeparate;render()"
            style="${state.listSeparate?'color:var(--accent2)':''}">
            ${state.listSeparate ? '⊟ Separated' : '⊞ Merged'}
          </button>` : ''}
        ${state.listSeparate ? `
          <button class="btn btn-ghost btn-sm" onclick="state.listSmartFirst=!state.listSmartFirst;render()"
            title="Toggle which list type appears first">
            ${state.listSmartFirst ? '✦ Smart ↑' : '📋 Static ↑'}
          </button>` : ''}
      </div>
      <button class="btn btn-primary btn-sm" onclick="showNewListMenu(this)">+ New</button>
    </div>

    ${allLists.length === 0 ? `
      <div class="empty">
        <div class="empty-icon">📋</div>
        <h3>No lists yet</h3>
        <p>Create a <strong>Static list</strong> to manually collect posts, or a <strong>Smart list</strong> that auto-populates from a saved search. Smart lists can also be pinned as <strong>tag chips</strong> in the search bar for quick filtering.</p>
      </div>
    ` : separated ? renderSeparated() : `
      <div style="display:flex;flex-direction:column;gap:8px">${sorted.map(renderListCard).join('')}</div>
    `}
  `;
}

export function renderSettings() {
  const lastSyncStr = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never';
  const unenriched  = state.items.filter(i => i.enrichStatus === 'pending').length;
  const deadCount   = state.items.filter(i => i.enrichStatus === 'dead').length;
  const isNewUser   = state.items.length === 0;

  return `
    <div class="section-title" style="margin-bottom:16px">Settings</div>

    ${isNewUser ? `
    <!-- ── GETTING STARTED ──────────────────────────────────────────────── -->
    <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.8">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:6px;color:var(--accent2)">👋 Getting started</div>
      <div style="color:var(--text-muted)">
        <strong style="color:var(--text)">Already hit Reddit's 1000-save limit?</strong><br>
        Request a data export at <strong style="color:var(--text)">reddit.com/settings</strong> → Data Request, then use <strong style="color:var(--text)">Import & Enrich</strong> below.<br><br>
        <strong style="color:var(--text)">Starting fresh or under the limit?</strong><br>
        Add your Private Feed URL in <strong style="color:var(--text)">Sync New Saves</strong> → Feed connection settings, then tap Sync Now.
      </div>
    </div>
    ` : ''}

    <!-- ── 1. SYNC NEW SAVES ──────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">🔄 Sync New Saves</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Pulls your most recent Reddit saves directly into RedditVault. Run this whenever you've saved new items on Reddit.
      </p>
      <button class="btn btn-primary" onclick="syncFromFeed()" style="width:100%;justify-content:center"
        ${state.feedSyncing ? 'disabled' : ''}>
        ${state.feedSyncing ? '⏳ Syncing…' : '🔄 Sync Now'}
      </button>
      ${state.feedSyncing && state.feedSyncProgress ? (() => {
        const p = state.feedSyncProgress;
        const pct = Math.min(100, Math.round((p.page / 40) * 100)); // 40 = MAX_PAGES
        return `
          <div style="margin-top:10px">
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:6px">
              Page ${p.page} of up to 40 &nbsp;·&nbsp;
              <strong style="color:var(--text)">${p.added}</strong> new &nbsp;·&nbsp;
              <strong style="color:var(--text)">${p.skipped}</strong> already saved
            </div>
          </div>`;
      })() : ''}
      ${state.feedSyncResult ? `
        <div style="margin-top:10px;font-size:12px;color:var(--text-muted);background:var(--bg);border-radius:8px;padding:10px;line-height:2">
          ${state.feedSyncResult.error
            ? `<span style="color:var(--danger)">❌ ${escHtml(state.feedSyncResult.error)}</span>`
            : `✅ <strong style="color:var(--text)">${state.feedSyncResult.added}</strong> new &nbsp;·&nbsp;
               <strong style="color:var(--text)">${state.feedSyncResult.skipped}</strong> already saved &nbsp;·&nbsp;
               <strong style="color:var(--text)">${state.feedSyncResult.pages}</strong> page${state.feedSyncResult.pages !== 1 ? 's' : ''} fetched
               ${state.feedSyncResult.added > 0 && state.feedSyncResult.skipped === 0 && state.feedSyncResult.pages >= 40
                 ? `<br><span style="color:var(--warning)">⚠️ No overlap found — you may have saves beyond Reddit's 1000-item limit. Consider a fresh CSV export.</span>`
                 : ''}`
          }
        </div>
      ` : ''}
      ${!state.redditFeedUrl ? `
        <p style="font-size:12px;color:var(--warning);margin-top:8px">⚠️ No feed URL configured — expand settings below to set up.</p>
      ` : ''}
      ${state.lastFeedSync ? `
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Last synced: ${new Date(state.lastFeedSync).toLocaleString()}</p>
      ` : ''}
      <div style="margin-top:12px;display:grid;gap:10px">
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
          <span>
            Auto-sync on open
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Check for new saves automatically when the app opens or returns to foreground</div>
          </span>
          <input type="checkbox" ${state.autoFeedSync ? 'checked' : ''}
            onchange="state.autoFeedSync=this.checked;db.config.put({key:'autoFeedSync',value:this.checked});render()"
            style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
        </label>
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:13px">
          <span style="color:var(--text-muted);font-size:12px">Minimum interval between checks (minutes)</span>
          <input class="input" type="number" min="5" max="1440" value="${state.autoFeedSyncInterval}"
            style="width:70px;text-align:center"
            onchange="state.autoFeedSyncInterval=Math.max(5,+this.value);db.config.put({key:'autoFeedSyncInterval',value:state.autoFeedSyncInterval})">
        </div>
      </div>
      <details style="margin-top:12px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">⚙️ Feed connection settings</summary>
        <div style="margin-top:12px;display:grid;gap:10px">
          <div class="form-group">
            <label>Private Feed URL</label>
            <input class="input" id="feed-url" placeholder="https://old.reddit.com/user/USERNAME/saved.rss?feed=YOUR_FEED_TOKEN&amp;user=USERNAME"
              value="${escHtml(state.redditFeedUrl)}" style="font-size:16px">
            <span style="font-size:11px;color:var(--text-muted)">Get from old.reddit.com/prefs/feeds/ → under Private Listings, right-click the RSS (or JSON) button next to 'your saved links' → Copy Link. Either form works — it's converted to the Feed format selected below.</span>
            <button class="btn btn-secondary btn-sm" onclick="window.location.href='https://old.reddit.com/prefs/feeds/'"
              style="margin-top:8px;width:100%;justify-content:center">
              🔗 Open Reddit Feeds page
            </button>
          </div>
          <div class="form-group">
            <label>Feed format</label>
            <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">Reddit currently blocks the JSON feed endpoint, so RSS is recommended. Switch to JSON only if Reddit changes which endpoint it blocks (JSON also includes post scores).</p>
            <div style="display:flex;gap:8px">
              <label id="fmt-label-rss" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedFormat!=='json'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                <input type="radio" name="feed-format" value="rss" ${state.feedFormat!=='json'?'checked':''}
                  onchange="
                    state.feedFormat='rss';
                    db.config.put({key:'feedFormat',value:'rss'});
                    document.getElementById('fmt-label-rss').style.borderColor='var(--accent2)';
                    document.getElementById('fmt-label-rss').style.background='rgba(99,102,241,0.08)';
                    document.getElementById('fmt-label-json').style.borderColor='var(--border)';
                    document.getElementById('fmt-label-json').style.background='';">
                <span>RSS <span style="color:var(--text-muted);font-size:11px">(recommended)</span></span>
              </label>
              <label id="fmt-label-json" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedFormat==='json'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                <input type="radio" name="feed-format" value="json" ${state.feedFormat==='json'?'checked':''}
                  onchange="
                    state.feedFormat='json';
                    db.config.put({key:'feedFormat',value:'json'});
                    document.getElementById('fmt-label-json').style.borderColor='var(--accent2)';
                    document.getElementById('fmt-label-json').style.background='rgba(99,102,241,0.08)';
                    document.getElementById('fmt-label-rss').style.borderColor='var(--border)';
                    document.getElementById('fmt-label-rss').style.background='';">
                <span>JSON</span>
              </label>
            </div>
          </div>
          <div class="form-group">
            <label>CORS Proxy</label>
            <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">Reddit blocks direct requests from browser-based apps, so feed sync must route through a proxy server. Your feed URL (which contains your private token) passes through whichever proxy you choose.</p>
            <div style="display:flex;gap:8px;margin-bottom:8px">
              <label id="proxy-label-cloudflare" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedProxyType==='cloudflare'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                <input type="radio" name="proxy-type" value="cloudflare" ${state.feedProxyType==='cloudflare'?'checked':''}
                  onchange="
                    state.feedProxyType='cloudflare';
                    db.config.put({key:'feedProxyType',value:'cloudflare'});
                    document.getElementById('proxy-worker-row').style.display='';
                    document.getElementById('proxy-corsfix-note').style.display='none';
                    document.getElementById('proxy-label-cloudflare').style.borderColor='var(--accent2)';
                    document.getElementById('proxy-label-cloudflare').style.background='rgba(99,102,241,0.08)';
                    document.getElementById('proxy-label-corsfix').style.borderColor='var(--border)';
                    document.getElementById('proxy-label-corsfix').style.background='';
                  ">
                ☁️ Cloudflare Worker
              </label>
              <label id="proxy-label-corsfix" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedProxyType==='corsfix'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                <input type="radio" name="proxy-type" value="corsfix" ${state.feedProxyType==='corsfix'?'checked':''}
                  onchange="
                    state.feedProxyType='corsfix';
                    db.config.put({key:'feedProxyType',value:'corsfix'});
                    document.getElementById('proxy-worker-row').style.display='none';
                    document.getElementById('proxy-corsfix-note').style.display='';
                    document.getElementById('proxy-label-corsfix').style.borderColor='var(--accent2)';
                    document.getElementById('proxy-label-corsfix').style.background='rgba(99,102,241,0.08)';
                    document.getElementById('proxy-label-cloudflare').style.borderColor='var(--border)';
                    document.getElementById('proxy-label-cloudflare').style.background='';
                  ">
                🔀 CORSfix
              </label>
            </div>
            <div id="proxy-worker-row" ${state.feedProxyType==='corsfix'?'style="display:none"':''}>
              <input class="input" id="feed-proxy-url" placeholder="https://your-worker.workers.dev"
                value="${escHtml(state.feedProxyUrl)}" style="font-size:16px">
              <span style="font-size:11px;color:var(--text-muted)">Your deployed Cloudflare Worker URL. Your feed URL stays within your own Cloudflare account. Requires a one-time deploy of the included Worker script.</span>
            </div>
            <div id="proxy-corsfix-note" ${state.feedProxyType!=='corsfix'?'style="display:none"':''}>
              <input id="feed-proxy-url" type="hidden" value="">
              <span style="font-size:11px;color:var(--text-muted)">Third-party proxy — no setup required, but your feed URL (including its private token) passes through proxy.corsfix.com's servers. May be capacity limited. Suitable for testing or if you prefer not to manage your own Worker.<br>CORS proxy service graciously provided by <a href="https://corsfix.com" target="_blank" rel="noopener" style="color:var(--accent2)">CORSfix</a> — thank you for supporting independent developers.</span>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="saveFeedUrl()" style="width:100%;justify-content:center">Save Feed Settings</button>
        </div>
      </details>
    </div>

    <!-- ── 1b. BOOKMARKLET SYNC ────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">🔖 Bookmarklet Sync</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Reddit is locking down the unauthenticated feed this app relies on. This bookmarklet runs <em>as</em> reddit.com using your existing login, so it keeps working where the feed can't — especially on mobile, where there's no extension. It captures your saves into a temporary inbox; RedditVault imports them on its next open (or tap <em>Import from inbox</em> below).
      </p>
      ${state.supabaseUrl && state.supabaseKey ? (() => {
        const bm = buildInboxBookmarklet(state.supabaseUrl, state.supabaseKey, state.redditUsername);
        const res = state.bookmarkletResult;
        return `
        <div style="background:var(--bg);border-radius:8px;padding:12px;line-height:1.6">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔖 RedditVault bookmarklet (menu)</div>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;line-height:1.6">Tapping it opens a menu: <strong style="color:var(--text)">① Capture new saves</strong> or <strong style="color:var(--text)">② Refresh scores</strong> (re-checks the up/down vote counts across your <em>entire</em> active library; large libraries take longer and stage progress as they go).</p>
          <ol style="font-size:12px;color:var(--text-muted);margin:0 0 12px 18px;padding:0;line-height:1.7">
            <li><strong style="color:var(--text)">Desktop:</strong> drag the button below to your bookmarks bar. On <strong style="color:var(--text)">old.reddit.com</strong> (logged in), click it.</li>
            <li><strong style="color:var(--text)">iOS/Safari:</strong> tap <em>Copy</em>. Bookmark any page (Share → Add Bookmark), then open the Bookmarks list (📖 icon) → Edit → tap that bookmark, clear its URL and paste this in. On <strong style="color:var(--text)">old.reddit.com</strong>, launch it from the <strong style="color:var(--text)">Bookmarks list</strong> (📖 icon) — <em>not</em> by typing its name in the address bar, which iOS blocks.</li>
          </ol>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <a href="${escHtml(bm)}" onclick="event.preventDefault();alert('Don\\'t click here — drag this to your bookmarks bar (desktop) or use Copy (mobile), then run it on old.reddit.com.')"
              style="display:inline-block;padding:8px 14px;background:var(--accent);color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;cursor:grab">
              📥 Save to RedditVault
            </a>
            <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(buildInboxBookmarklet(state.supabaseUrl,state.supabaseKey,state.redditUsername)).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
            <button class="btn btn-secondary btn-sm" onclick="window.location.href='https://old.reddit.com/saved'">Open old.reddit.com/saved</button>
          </div>

          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Your Reddit username <span style="opacity:.7">(optional — guards against capturing from the wrong account)</span></label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:14px;color:var(--text-muted)">u/</span>
              <input id="bm-username" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="username" value="${escHtml(state.redditUsername || '')}" style="flex:1;min-width:140px;font-size:16px">
              <button class="btn btn-secondary btn-sm" onclick="saveRedditUsername()">Save</button>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">If set, the bookmarklet checks the logged-in Reddit account against this name and warns before running on a different account. Leave blank to skip the check.</p>
          </div>

          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Refresh scores: how many recent saves to check</label>
            <select id="bm-score-limit" onchange="saveScoreRefreshLimit(this.value)" style="font-size:16px;padding:4px 8px">
              ${[['100','100'],['250','250'],['500','500'],['1000','1000'],['2500','2500'],['0','All']].map(([v,l]) => `<option value="${v}" ${String(state.scoreRefreshLimit) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">Reddit scores settle after a while, so checking only your most recent saves avoids hammering Reddit. Pick <strong>All</strong> for an occasional full refresh. Takes effect immediately — no need to re-copy the bookmarklet.</p>
          </div>

          <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" onclick="drainInbox({manual:true})" ${state.inboxDraining ? 'disabled' : ''}>
              ${state.inboxDraining ? '⏳ Importing…' : '📨 Import from inbox now'}
            </button>
            ${state.lastBookmarkletSync ? `<span style="font-size:11px;color:var(--text-muted)">Last import: ${new Date(state.lastBookmarkletSync).toLocaleString()}</span>` : ''}
          </div>
          ${res ? `
            <div style="margin-top:8px;font-size:12px;background:var(--surface);border-radius:8px;padding:8px 10px">
              ${res.error
                ? `<span style="color:var(--danger)">❌ ${escHtml(res.error)}</span>`
                : `✅ <strong style="color:var(--text)">${res.added}</strong> new &nbsp;·&nbsp; <strong style="color:var(--text)">${res.skipped}</strong> already saved &nbsp;·&nbsp; <strong style="color:var(--text)">${res.scoresUpdated || 0}</strong> scores updated &nbsp;·&nbsp; <strong style="color:var(--text)">${res.drained}</strong> processed`}
            </div>` : ''}

          <details style="margin-top:12px">
            <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📋 Paste captured items (fallback)</summary>
            <div style="margin-top:10px">
              <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Only needed if the bookmarklet couldn't reach your inbox and offered a <em>Copy</em> button instead. Paste that text here.</p>
              <textarea id="bm-paste" placeholder="Paste copied RedditVault data…" style="width:100%;height:70px;font-size:16px;font-family:monospace"></textarea>
              <button class="btn btn-secondary btn-sm" onclick="importPastedBookmarklet()" style="margin-top:6px">Import pasted items</button>
            </div>
          </details>

          <details style="margin-top:8px">
            <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">🔬 Compatibility probe (diagnostics)</summary>
            <div style="margin-top:10px">
              <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Runs two test fetches on reddit.com and alerts their HTTP status — handy if capture isn't working. Install/run it the same way as the bookmarklet above.</p>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <a href="${escHtml(cspProbeBookmarklet(state.supabaseUrl, state.supabaseKey))}" onclick="event.preventDefault();alert('Drag to bookmarks (desktop) or Copy (mobile), then run on old.reddit.com.')"
                  style="display:inline-block;padding:6px 12px;background:var(--accent2);color:#fff;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;cursor:grab">🔬 RV CSP Probe</a>
                <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(cspProbeBookmarklet(state.supabaseUrl,state.supabaseKey)).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
              </div>
            </div>
          </details>
        </div>`;
      })() : `
        <p style="font-size:12px;color:var(--warning);background:rgba(245,158,11,0.08);border-radius:8px;padding:10px">
          ⚠️ Set up your Supabase connection in <strong>Cloud Database</strong> below first — the bookmarklet needs it, and remember to add the <code>reddit_inbox</code> table from <code>supabase-schema.sql</code>.
        </p>
      `}
    </div>

    <!-- ── 2. CLOUD DATABASE ──────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">☁️ Cloud Database</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
        Sync is automatic — changes are pushed to the cloud as you make them and pulled on startup. Manual push and pull should not be necessary under normal circumstances.
      </p>
      <div class="sync-status" style="margin-bottom:10px">
        <div class="status-dot ${state.syncStatus}"></div>
        <span>${state.syncStatus === 'connected' ? 'Connected' : state.syncStatus === 'syncing' ? 'Syncing...' : 'Not connected'}</span>
        ${state.lastSyncedAt ? `<span style="margin-left:auto;color:var(--text-muted);font-size:11px">Last synced: ${lastSyncStr}</span>` : ''}
      </div>
      ${state.supabaseUrl ? `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-secondary" onclick="syncFromSupabase()" style="flex:1;justify-content:center">⬇️ Pull from Cloud</button>
          <button class="btn btn-secondary" onclick="pushAllToSupabase()" style="flex:1;justify-content:center">⬆️ Push to Cloud</button>
        </div>
      ` : ''}
      <details>
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">⚙️ Supabase connection settings</summary>
        <div style="margin-top:12px;display:grid;gap:10px">
          <div style="font-size:12px;color:var(--text-muted);padding:8px 10px;background:rgba(245,158,11,0.08);border-radius:8px;border:1px solid rgba(245,158,11,0.2)">
            ⚠️ Designed for single-user use. Using the same database from two devices simultaneously may cause list sync conflicts.
          </div>
          <div class="form-group">
            <label>Project URL</label>
            <input class="input" id="sb-url" placeholder="https://xxxx.supabase.co" value="${escHtml(state.supabaseUrl)}">
          </div>
          <div class="form-group">
            <label>Anon Key</label>
            <input class="input" id="sb-key" type="password" placeholder="eyJhbGc..." value="${escHtml(state.supabaseKey)}">
          </div>
          <button class="btn btn-secondary" onclick="saveSupabaseConfig()" style="width:100%;justify-content:center">Save & Test Connection</button>
        </div>
      </details>
    </div>

    <!-- ── 3. LIBRARY ─────────────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px">📊 Library</div>
      ${(() => {
        const active = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted);
        const trashCount = state.items.filter(i => i.isDisliked && !i.isPermanentlyDeleted).length;
        const deletedCount = state.items.filter(i => i.isPermanentlyDeleted).length;
        return `
        <div style="font-size:13px;line-height:2.2">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Total items</span><span>${active.length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Posts</span><span style="font-size:12px">${active.filter(i=>i.type==='post').length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Comments</span><span style="font-size:12px">${active.filter(i=>i.type==='comment').length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Lists</span><span>${state.lists.length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Smart</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='smart').length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:28px;font-size:12px">↳ Tags</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='smart'&&l.isTag).length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Static</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='static').length}</span></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Need enrichment</span>
            <span style="${unenriched>0?'color:var(--warning)':''}">${unenriched}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text-muted)">Unavailable</span>
            <span style="display:flex;align-items:center;gap:8px">
              <span style="color:var(--text-muted)">${deadCount.toLocaleString()}</span>
              ${deadCount > 0 ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="resetDeadToPending()">↩ Retry all</button>` : ''}
            </span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Trash</span>
            <span style="color:var(--text-muted)">${trashCount.toLocaleString()}</span>
          </div>
          ${deletedCount > 0 ? `
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="color:var(--text-muted)">Deleted (hidden)</span>
            <span style="color:var(--text-muted);font-size:12px">${deletedCount.toLocaleString()}</span>
          </div>` : ''}
        </div>`;
      })()}
      <!-- Backup & Restore -->
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.05em;margin-bottom:10px">BACKUP & RESTORE</div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
          Backup exports all items, lists and list memberships to a JSON file. Restore replaces all local data from a previous backup.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" onclick="exportJSON()" style="flex:1;justify-content:center">⬇️ Backup</button>
          <button class="btn btn-secondary" onclick="document.getElementById('restore-file').click()" style="flex:1;justify-content:center">⬆️ Restore</button>
        </div>
        <input type="file" id="restore-file" accept=".json" style="display:none">
      </div>
    </div>

    <!-- ── 4. IMPORT & ENRICH ─────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">📥 Import & Enrich</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.6">
        To get your CSV: go to <strong style="color:var(--text)">reddit.com/settings</strong> → Data Request → download and find <strong style="color:var(--text)">saved_posts.csv</strong>.
      </p>
      <details style="margin-bottom:12px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">ℹ️ About importing and enrichment</summary>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:8px;display:grid;gap:8px">
          <p><strong style="color:var(--text)">Before importing your CSV</strong>, it's worth setting up feed sync first if you haven't already. The feed pulls your most recent saves (up to ~1000) with full metadata already attached — no enrichment needed for those. If you have fewer than 1000 saved items in total, the feed alone may be sufficient and you won't need the CSV at all. The CSV is mainly useful for recovering older saves that fall outside the feed's range.</p>
          <p>Items that arrive solely from the CSV will need enrichment to retrieve their titles, subreddits, authors and content. <strong style="color:var(--text)">Start with Arctic Shift</strong> — it's a Reddit archive that can resolve thousands of items in seconds. Because it's an archive it may not have the very latest posts, or posts that were deleted before being archived.</p>
          <p>Once Arctic Shift finishes, check how many items are still unresolved. The <strong style="color:var(--text)">Reddit</strong> pass can recover more but is significantly slower due to rate limiting — whether it's worth running depends on how complete you want your library to be and how many items are still missing.</p>
          <p>The <strong style="color:var(--text)">Retry</strong> button re-queues items that failed due to rate limit hits or temporary errors. Some items need 2–3 passes before they either resolve or are confirmed permanently unavailable as deleted or private posts.</p>
        </div>
      </details>
      <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file').click()" style="margin-bottom:12px">
        <input type="file" id="csv-file" accept=".csv,.json" style="display:none" onchange="(async e => { const f=e.target.files[0]; if(f) await handleFileImport(f); e.target.value=''; })(event)">
        <div class="drop-zone-icon">📥</div>
        <h3>Import Reddit CSV</h3>
        <p>Tap to select your saved_posts.csv file<br>or drag and drop here</p>
      </div>
      ${(() => {
        const pendingCount   = state.items.filter(i => i.enrichStatus === 'pending').length;
        const attemptedCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) > 0).length;
        const thresholdCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) >= state.enrichMaxAttempts).length;
        const lastRunClean   = state.lastRunRateLimitHits === 0;
        const hasRunBefore   = state.lastRunRateLimitHits !== null;
        const normalDelaySecs = Math.round(60 / state.enrichReqPerMin);
        const retryDelaySecs  = Math.round(60 / state.enrichRetryReqPerMin);

        if (pendingCount === 0 && !state.enriching) return `
          <div style="font-size:13px;color:var(--success);padding:8px 0">✓ All items enriched</div>`;

        return `
          ${pendingCount > 0 || state.enriching ? `
            <!-- Arctic Shift block -->
            <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--accent2);margin-bottom:4px;font-size:13px">⚡ Arctic Shift</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                Bulk lookup — enriches thousands in seconds. Try this first.
              </div>
              ${state.enriching && state.enrichProgress.phase === 'arctic' ? `
                <div id="enrich-progress-details">
                  <div class="progress-bar"><div class="progress-fill" style="width:${state.enrichProgress.total > 0 ? Math.round((state.enrichProgress.done / state.enrichProgress.total) * 100) : 0}%"></div></div>
                  <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
                    ${state.enrichProgress.done.toLocaleString()} / ${state.enrichProgress.total.toLocaleString()} checked &nbsp;·&nbsp; ${(state.enrichProgress.enriched||0).toLocaleString()} enriched
                  </div>
                </div>
                <button class="btn btn-danger" style="width:100%;justify-content:center;margin-top:10px" onclick="stopEnrichment()">⏹ Pause</button>
              ` : state.enriching ? `` : `
                <button class="btn btn-secondary" style="width:100%;justify-content:center" onclick="enrichViaArcticShiftOnly()">⚡ Enrich via Arctic Shift</button>
              `}
            </div>

            <!-- Reddit block -->
            <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--warning);margin-bottom:4px;font-size:13px">🐢 Reddit</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                ${pendingCount.toLocaleString()} item${pendingCount !== 1 ? 's' : ''} · ${state.enrichReqPerMin} req/min · ~${enrichTimeEstimate(pendingCount || 1000, state.enrichReqPerMin)}
                &nbsp;— may pick up items Arctic Shift missed, but can take hours.
              </div>
              ${state.enriching && state.enrichProgress.phase === 'reddit' ? `
                <div id="enrich-progress-details">
                  <div class="progress-bar"><div class="progress-fill" style="width:${state.enrichProgress.total > 0 ? Math.round((state.enrichProgress.done / state.enrichProgress.total) * 100) : 0}%"></div></div>
                  <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
                    ${state.enrichProgress.done} / ${state.enrichProgress.total} &nbsp;·&nbsp; ${(state.enrichProgress.enriched||0).toLocaleString()} enriched &nbsp;·&nbsp; ${state.enrichProgress.failed||0} unavailable
                    ${state.enrichProgress.rateLimitHits > 0 ? ` &nbsp;·&nbsp; <span style="color:var(--warning)">⚠ ${state.enrichProgress.rateLimitHits} rate limit${state.enrichProgress.rateLimitHits > 1 ? 's' : ''}</span>` : ''}
                    ${(state.enrichProgress.minsLeft||0) > 1 ? ` &nbsp;·&nbsp; ~${state.enrichProgress.minsLeft} min left` : ''}
                  </div>
                </div>
                <button class="btn btn-danger" style="width:100%;justify-content:center;margin-top:10px" onclick="stopEnrichment()">⏹ Pause</button>
              ` : state.enriching ? `` : `
                <button class="btn btn-warning" style="width:100%;justify-content:center" onclick="enrichViaRedditOnly(false)">🐢 Enrich via Reddit</button>
              `}
            </div>
          ` : ''}
          ${attemptedCount > 0 && !state.enriching ? `
            <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--accent2,#818cf8);margin-bottom:6px;font-size:13px">🔄 ${attemptedCount} item${attemptedCount !== 1 ? 's' : ''} to retry</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                ${state.enrichRetryReqPerMin} req/min · 1 every ${retryDelaySecs}s · ~${enrichTimeEstimate(attemptedCount, state.enrichRetryReqPerMin)}
                ${hasRunBefore ? (lastRunClean
                  ? ' · <span style="color:var(--success)">Last run clean</span>'
                  : ` · <span style="color:var(--warning)">Last run: ${state.lastRunRateLimitHits} rate limit${state.lastRunRateLimitHits !== 1 ? 's' : ''}</span>`) : ''}
              </div>
              <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="enrichViaRedditOnly(true)">🔄 Retry via Reddit</button>
              ${thresholdCount > 0 ? `
                <button class="btn ${lastRunClean ? 'btn-danger' : 'btn-ghost'} btn-sm" style="width:100%;justify-content:center;margin-top:8px" onclick="markAttemptedAsDead()">
                  ⚰️ Mark ${thresholdCount} as dead ${!lastRunClean ? '(last run had rate limits)' : ''}
                </button>` : ''}
            </div>
          ` : ''}`;
      })()}
      <details style="margin-top:4px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:4px 0">⚙️ Enrichment speed settings</summary>
        <div style="margin-top:10px;display:grid;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Initial run (req/min, 1–10)</label>
            <div style="display:flex;align-items:center;gap:10px">
              <input class="input" id="enrich-rpm" type="number" min="1" max="10" value="${state.enrichReqPerMin}" style="width:70px" oninput="updateSpeedHints()">
              <span id="hint-normal" style="font-size:12px;color:var(--text-muted)">every ${Math.round(60/state.enrichReqPerMin)}s</span>
            </div>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Retry run (req/min, 1–10)</label>
            <div style="display:flex;align-items:center;gap:10px">
              <input class="input" id="enrich-retry-rpm" type="number" min="1" max="10" value="${state.enrichRetryReqPerMin}" style="width:70px" oninput="updateSpeedHints()">
              <span id="hint-retry" style="font-size:12px;color:var(--text-muted)">every ${Math.round(60/state.enrichRetryReqPerMin)}s</span>
            </div>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Rate limit pause (minutes)</label>
            <input class="input" id="enrich-rl-pause" type="number" min="1" max="30" value="${state.enrichRateLimitPause}" style="width:70px">
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Attempts before bulk-dead</label>
            <input class="input" id="enrich-max-attempts" type="number" min="1" max="20" value="${state.enrichMaxAttempts}" style="width:70px">
          </div>
          <button class="btn btn-secondary btn-sm" onclick="saveEnrichSettings()" style="width:100%;justify-content:center">Save Speed Settings</button>
        </div>
      </details>
      <div id="import-progress" style="display:none;margin-top:10px">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
        <div style="font-size:13px;color:var(--text-muted);text-align:center" id="progress-label">Processing...</div>
      </div>
    </div>

    <!-- ── 5. BEHAVIOUR ───────────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px">🎛️ Behaviour</div>
      <div style="display:grid;gap:14px">
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
          <span>
            Confirm before trashing or removing from list
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Shows a confirmation prompt on destructive card actions</div>
          </span>
          <input type="checkbox" ${state.confirmDestructive ? 'checked' : ''}
            onchange="state.confirmDestructive=this.checked;db.config.put({key:'confirmDestructive',value:this.checked});pushImportantPreferences()"
            style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
          <span>
            Disable pinch-to-zoom
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Prevents iOS from zooming into text fields and on pinch gesture</div>
          </span>
          <input type="checkbox" ${state.disableZoom ? 'checked' : ''}
            onchange="state.disableZoom=this.checked;db.config.put({key:'disableZoom',value:this.checked});applyZoomSetting()"
            style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
        </label>
      </div>
    </div>

    <!-- ── 6. DIAGNOSTICS ─────────────────────────────────────────────────── -->
    <div class="config-section" style="opacity:0.85">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px;color:var(--text-muted)">🔬 Diagnostics</div>

      <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center;margin-bottom:10px"
        onclick="caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>window.location.reload())">
        ↺ Force reload &amp; clear cache
      </button>

      <details>
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">🔧 Troubleshooting tools</summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:11px;color:var(--text-muted)">These tools were used during initial setup and should rarely be needed.</div>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairItemTypes()">🔧 Repair Post/Comment Types</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairCommentTitles()">💬 Fix Placeholder Comment Titles</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairSavedAtDates()">📅 Patch Import Date Clumps</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="if(confirm('Normalise CSV item IDs, merge duplicates and re-queue for enrichment. Continue?'))repairCSVDuplicates()">
            🔧 Repair CSV Duplicates & Re-enrich</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="if(confirm('Reset ALL items to pending — re-fetches everything from Reddit. Continue?'))resetAllEnrichment()">
            🔄 Re-enrich Entire Library</button>
          <button class="btn btn-danger btn-sm" style="width:100%;justify-content:center;margin-top:4px"
            onclick="if(confirm('Delete ALL local data? Make sure you have a backup first!'))clearAllData()">⚠️ Clear All Local Data</button>
        </div>
      </details>

      <details style="margin-top:10px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📋 Sync log</summary>
        <div style="margin-top:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11px;color:var(--text-muted)">Session log · 🟢 ok &nbsp;🟡 warn &nbsp;🔴 error · newest first</div>
            <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(state.syncLog.map(e=>'+'+e.t+'s '+e.wall+' '+e.msg).join('\\n')).then(()=>showToast('Log copied','success'))">
              Copy
            </button>
          </div>
          <div id="sync-log-entries" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px"></div>
        </div>
      </details>
    </div>

    <div style="text-align:center;padding:16px 0 4px;font-size:12px;color:var(--border)">
      RedditVault v${APP_VERSION} &nbsp;·&nbsp; DB schema v${db.verno}
    </div>
  `;
}

// ─── MODALS ──────────────────────────────────────────────────────────────────
export function showModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><div class="modal-handle"></div>${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);

}

export function closeModal() {
  document.getElementById('modal-overlay')?.remove();
}

// ─── LIST MANAGEMENT ─────────────────────────────────────────────────────────

export function showNewListMenu(btn) {
  document.getElementById('new-list-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'new-list-menu';
  menu.style.cssText = 'position:fixed;z-index:300;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.25);min-width:140px;overflow:hidden;';
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.innerHTML = `
    <button onclick="document.getElementById('new-list-menu')?.remove();showCreateList('static')"
      style="display:block;width:100%;padding:12px 16px;background:none;border:none;text-align:left;color:var(--text);font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">
      📋 Static list
    </button>
    <div style="height:1px;background:var(--border)"></div>
    <button onclick="document.getElementById('new-list-menu')?.remove();showCreateList('smart')"
      style="display:block;width:100%;padding:12px 16px;background:none;border:none;text-align:left;color:var(--text);font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">
      ✦ Smart list
    </button>
  `;
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', handler); }
    });
  }, 0);
}
export function showCreateList(type) {
  const isSmart = type === 'smart';
  showModal(`
    <div class="modal-title">${isSmart ? '✦ New Smart List' : '📋 New Static List'}</div>
    <div class="form-group">
      <label>Name</label>
      <input class="input" id="list-name" placeholder="e.g. Must Reads, AI Papers..." autofocus>
    </div>
    ${isSmart ? `
      <div class="form-group">
        <label>Search query</label>
        <input class="input" id="list-query" placeholder='e.g. r:MachineLearning (pytorch, tensorflow)'>
        <span style="font-size:11px;color:var(--text-muted)">Uses the same syntax as the search bar</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="list-is-tag" ${existingListId && state.lists.find(l=>l.id===existingListId)?.isTag ? 'checked' : ''} style="width:16px;height:16px">
          <span style="font-size:13px;font-weight:600">Show as tag chip</span>
        </label>
        <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:8px">Pins this smart list to the tag tray above search results for one-tap filtering. Also groups it under 🏷 Tags in the Lists tab.</span>
        <div class="form-group" style="margin:0">
          <label style="font-size:11px">Short tag name (optional)</label>
          <input class="input" id="list-tag-name" value="${escHtml(existingListId && state.lists.find(l=>l.id===existingListId)?.tagName || '')}" placeholder="e.g. js, audio, fav" style="font-size:13px">
          <span style="font-size:11px;color:var(--text-muted)">Shown as #name in the tag tray. Uses list name if blank.</span>
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
      <button class="btn btn-primary" onclick="doCreateList('${type}')" style="flex:1;justify-content:center">Create</button>
    </div>
  `);
}

export function editList(id) {
  const list = state.lists.find(l => l.id === id);
  if (!list) return;
  showModal(`
    <div class="modal-title">Edit List</div>
    <div class="form-group">
      <label>Name</label>
      <input class="input" id="edit-list-name" value="${escHtml(list.name)}">
    </div>
    ${list.type === 'smart' ? `
      <div class="form-group">
        <label>Search query</label>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;color:var(--text);font-style:${list.query?'normal':'italic'};min-height:36px;word-break:break-word">
          ${list.query ? escHtml(list.query) : '<span style="color:var(--text-muted)">No query set</span>'}
        </div>
        ${(() => {
          const { tags } = extractTagTokens(list.query || '');
          const missing = tags.filter(n => !state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === n));
          return missing.length ? `<span style="font-size:11px;color:var(--warning)">⚠ Tag${missing.length>1?'s':''} not found: ${missing.map(n=>`#${escHtml(n)}`).join(', ')} — being ignored</span>` : '';
        })()}
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%;justify-content:center"
          onclick="closeModal();runListSearch(${id})">✏️ Edit in search</button>
      </div>
      ${(() => {
        const parts = optionsSummaryParts(list.optionsJson);
        if (!parts.length) return '';
        return `<div style="background:var(--surface);border:1px solid rgba(124,58,237,0.25);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:4px">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${parts.map(p => `<span style="font-size:11px;background:rgba(124,58,237,0.12);color:var(--accent2);border-radius:6px;padding:2px 7px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div>
          <strong style="color:var(--text)">📌 Saved filters &amp; sort</strong> — applied when opening this list directly.<br>
          When used as a <strong>#tag</strong> in another search, only the query above is matched — filters and sort are ignored so compound searches stay predictable.
        </div>`;
      })()}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="edit-list-is-tag" ${list.isTag ? 'checked' : ''} style="width:16px;height:16px">
          <span style="font-size:13px;font-weight:600">Show as tag chip</span>
        </label>
        <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:8px">Pins this smart list to the tag tray above search results for one-tap filtering. Also groups it under 🏷 Tags in the Lists tab.</span>
        <div class="form-group" style="margin:0">
          <label style="font-size:11px">Short tag name (optional)</label>
          <input class="input" id="edit-list-tag-name" value="${escHtml(list.tagName || '')}" placeholder="e.g. js, audio, fav" style="font-size:13px">
          <span style="font-size:11px;color:var(--text-muted)">Shown as #name in the tag tray. Uses list name if blank.</span>
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
      <button class="btn btn-primary" onclick="doEditList(${id})" style="flex:1;justify-content:center">Save</button>
    </div>
  `);
}

export function showListMenu(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  if (state.lists.length === 0) {
    showModal(`
      <div class="modal-title">Add to List</div>
      <p style="color:var(--text-muted);font-size:13px">No static lists yet. Create one in the Lists tab first.</p>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
        <button class="btn btn-primary" onclick="closeModal();showPage('lists')" style="flex:1;justify-content:center">Go to Lists</button>
      </div>
    `);
    return;
  }

  const inListIds = new Set(state.itemLists.filter(il => il.itemId === itemId).map(il => il.listId));
  const sorted = [...state.lists].filter(l => l.type === 'static').sort((a,b) => a.name.replace(/^[^a-zA-Z0-9]+/,'').localeCompare(b.name.replace(/^[^a-zA-Z0-9]+/,'')));

  showModal(`
    <div class="modal-title">Add to List</div>
    <input class="input" id="list-search" placeholder="Search lists…" oninput="filterListMenu(this.value)"
      style="margin-bottom:10px;font-size:13px">
    <div id="list-menu-items" style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto">
      ${sorted.map(l => `
        <button id="lmbtn-${l.id}" class="btn ${inListIds.has(l.id)?'btn-primary':'btn-secondary'}"
          onclick="toggleItemList(${itemId},${l.id})"
          style="justify-content:space-between;text-align:left">
          <span>
            ${l.type==='smart'?'<span style="color:var(--accent2);font-size:10px">✦</span> ':''}${escHtml(l.name)}
          </span>
          <span>${inListIds.has(l.id) ? '✓' : '+'}</span>
        </button>
      `).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-ghost" onclick="closeModal()" style="flex:1;justify-content:center">Done</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal();showPage('lists')" style="flex:1;justify-content:center">Manage Lists →</button>
    </div>
  `);
}

export function filterListMenu(q) {
  const term = q.toLowerCase();
  document.querySelectorAll('#list-menu-items button').forEach(btn => {
    btn.style.display = btn.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
}

export function attachEventListeners() {
  // Populate sync log if visible
  const logEl = document.getElementById('sync-log-entries');
  if (logEl) renderSyncLogEntries(logEl);

  // Swipe right from left edge to go back when viewing a list detail
  if (state.page === 'lists' && state.listView !== 'all') {
    const content = document.getElementById('main-content');
    if (content && !content._swipeBackAttached) {
      content._swipeBackAttached = true;
      let startX = 0, startY = 0, mode = null, tracking = false;

      content.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        mode = null;
        tracking = startX < 40; // only arm from left edge
      }, { passive: true });

      content.addEventListener('touchmove', e => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (mode === null) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          mode = (dx > 0 && Math.abs(dx) > Math.abs(dy)) ? 'right' : 'none';
        }
        if (mode === 'right') {
          if (state.listView === 'all') { mode = 'none'; return; } // not in detail view
          e.preventDefault();
          content.style.transform = `translateX(${Math.max(0, dx)}px)`;
          content.style.transition = 'none';
        }
      }, { passive: false });

      content.addEventListener('touchend', e => {
        if (!tracking || mode !== 'right') { content.style.transform = ''; return; }
        // Guard — listener persists on the element across renders, only act in detail view
        if (state.listView === 'all') {
          content.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = '';
          tracking = false; mode = null;
          return;
        }
        const dx = e.changedTouches[0].clientX - startX;
        if (dx > 80) {
          content.style.transition = 'transform 0.25s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = `translateX(${window.innerWidth}px)`;
          setTimeout(() => {
            content.style.transform = '';
            content.style.transition = '';
            state.listView = 'all';
            render();
          }, 220);
        } else {
          content.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = '';
        }
        tracking = false; mode = null;
      }, { passive: true });
    }
  }

  const restoreInput = document.getElementById('restore-file');
  if (restoreInput) {
    restoreInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleFileImport(file);
      restoreInput.value = ''; // reset so same file can be picked again
    };
  }

  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = async e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) await handleFileImport(file);
    };
  }
}

