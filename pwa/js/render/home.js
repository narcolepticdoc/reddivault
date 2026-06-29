// render/home.js — view rendering (split out of the former render.js).
import { clearRecentlyViewed, newSearch, showPage } from '../items.js';
import { db, state } from '../state.js';
import { escHtml, ratingDisplay } from '../util.js';
import { showPreview } from './preview.js';

export function renderHome() {
  const active = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted);
  const total = active.length;
  const favourited = active.filter(i => i.isFavourite).length;
  const rated = active.filter(i => i.rating != null).length;
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
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;line-height:1;color:var(--accent2)">${favourited.toLocaleString()}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;line-height:1.2">Favourited</div>
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
                      ${item.isFavourite ? '<span style="color:#ec4899">♥</span>' : ''}
                      ${ratingDisplay(item)}
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

