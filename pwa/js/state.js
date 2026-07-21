// state.js — part of RedditVault (auto-split from the original single-file PWA).
import { autoFeedSyncIfDue } from './feed.js';
import { escHtml } from './util.js';

// ─── VERSION ─────────────────────────────────────────────────────────────────
export const APP_VERSION = '0.9.19.2';

// ─── DATABASE ────────────────────────────────────────────────────────────────
export const db = new Dexie('RedditVault');
db.version(3).stores({
  items: '++id, redditId, type, subreddit, title, url, folder, savedAt, postCreatedAt, enriched, syncedAt',
  folders: '++id, name, icon, createdAt',
  config: 'key'
});
db.version(4).stores({
  items: '++id, redditId, type, subreddit, title, url, folder, savedAt, postCreatedAt, enriched, enrichAttempts, syncedAt',
  folders: '++id, name, icon, createdAt',
  config: 'key'
});
db.version(5).stores({
  items: '++id, redditId, type, subreddit, title, url, folder, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt',
  folders: '++id, name, icon, createdAt',
  config: 'key'
}).upgrade(tx => {
  return tx.table('items').toCollection().modify(item => {
    const definitelyEnriched = !!(item.title && item.title.trim() && item.subreddit && item.subreddit.trim());
    item.enrichStatus   = definitelyEnriched ? 'enriched' : 'pending';
    item.enriched       = definitelyEnriched;
    item.enrichAttempts = 0;
  });
});
// Version 6: adds lists (static + smart) and item_lists junction table. Folders deprecated.
db.version(6).stores({
  items: '++id, redditId, type, subreddit, title, url, folder, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt',
  folders: '++id, name, icon, createdAt',
  lists: '++id, name, type, createdAt',
  item_lists: '++id, itemId, listId',
  config: 'key'
});
// Version 7: adds tagName and isTag to lists; migrates favoriteSearches to smart lists.
db.version(7).stores({
  items: '++id, redditId, type, subreddit, title, url, folder, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt',
  folders: '++id, name, icon, createdAt',
  lists: '++id, name, type, createdAt, isTag',
  item_lists: '++id, itemId, listId',
  config: 'key'
}).upgrade(async tx => {
  // Migrate existing favoriteSearches → smart lists
  const favConfig = await tx.table('config').get('favoriteSearches');
  const favs = favConfig?.value || [];
  for (const query of favs) {
    const name = query.length > 30 ? query.slice(0, 30) + '…' : query;
    const exists = await tx.table('lists').where('name').equals(name).first();
    if (!exists) {
      await tx.table('lists').add({ name, type: 'smart', query, createdAt: new Date().toISOString(), isTag: false, tagName: '' });
    }
  }
});

db.version(8).stores({
  items: '++id, redditId, type, subreddit, title, url, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt, isPermanentlyDeleted',
  folders: '++id, name, icon, createdAt',
  lists: '++id, name, type, createdAt, isTag',
  item_lists: '++id, itemId, listId',
  config: 'key'
});
// Version 9: adds optionsJson to lists for persisting filters/sort per list.
db.version(9).stores({
  items: '++id, redditId, type, subreddit, title, url, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt, isPermanentlyDeleted',
  folders: '++id, name, icon, createdAt',
  lists: '++id, name, type, createdAt, isTag',
  item_lists: '++id, itemId, listId',
  config: 'key'
});

// ─── STATE ──────────────────────────────────────────────────────────────────
export let state = {
  page: 'home',
  items: [],
  lists: [],     // { id, name, type, query } 
  itemLists: [], // { id, itemId, listId }
  search: '',
  showDead: false,
  supabaseUrl: '',
  supabaseKey: '',
  lastSync: null,
  syncStatus: 'unknown',
  enriching: false,
  enrichProgress: { done: 0, total: 0 },
  enrichReqPerMin: 8,
  enrichRetryReqPerMin: 4,
  enrichRateLimitPause: 5,
  enrichMaxAttempts: 3,
  lastRunRateLimitHits: null,
  authorFreq: {},
  recentSearches: [],
  recentlyViewed: [],   // [{ id, ts }] newest-first, local-only, cap 100
  searchFocused: false,
  recentSearchesOpen: false, // collapsed by default
  // Tag chips — active smart list tags applied to search
  activeTagIds: [],     // list ids of active tag chips
  tagTrayCollapsed: false, // tag tray collapsed (shows only active tags when collapsed)
  editingListId: null,     // list id being edited via Run search, shown as banner in browse
  tagMode: 'AND',       // 'AND' | 'OR'
  tagCache: new Map(),  // Map<listId, { count, itemIds: Set }>
  showTrash: false,
  showDeleted: false,   // deleted items view within trash
  showAuthorList: false,
  filterFavourite: false,
  sortBy: 'postCreatedAt',
  sortDir: 'desc',
  redditFeedUrl: '',
  redditUsername: '',  // expected Reddit username — bookmarklet checks the logged-in account against it
  scoreRefreshLimit: 500,  // how many most-recent active saves the bookmarklet's "Refresh scores" checks (0 = all)
  feedProxyUrl: '',
  feedProxyType: 'cloudflare', // 'cloudflare' | 'corsfix'
  feedFormat: 'rss', // 'rss' | 'json' — Reddit currently WAF-blocks .json
  feedSyncing: false,
  feedSyncProgress: null,   // { page, added, skipped } while syncing
  feedSyncResult: null,
  // Filter panel
  showFilters: false,
  filterType: 'all',       // all | post | comment
  filterRating: 0,         // 0=any, 1-5=min rating
  filterHasLinks: false,
  filterDateField: 'postCreatedAt', // postCreatedAt | savedAt
  filterDateFrom: '',
  filterDateTo: '',
  filterSubreddit: '',
  filterAuthor: '',
  searchBody: false,     // include body text in plain-text search
  subredditList: [],    // precomputed sorted unique subreddits
  authorList: [],       // precomputed sorted unique authors
  // Lists tab
  listView: 'all',         // 'all' | list id
  listSeparate: false,     // separate smart vs static
  listSmartFirst: true,    // smart lists above static when separated
  tagsCollapsed: false,    // tags subsection collapsed in separate mode
  confirmDestructive: true, // confirm before trash/remove actions
  disableZoom: true,        // prevent iOS pinch-to-zoom
  autoFeedSync: false,        // auto-sync feed on open/foreground
  autoFeedSyncInterval: 60,   // minimum minutes between auto syncs
  localDirty: false,        // true if local has changes not yet pushed
  cloudAhead: false,        // true if cloud has data not yet pulled
  lastPushedAt: null,       // ISO timestamp of last successful push to cloud (delta cursor)
  lastSyncedAt: null,       // ISO timestamp of last confirmed in-sync (push or pull) — display only
  lastFeedSync: null,       // ISO timestamp of last successful feed sync
  lastBookmarkletSync: null,// ISO timestamp of last bookmarklet inbox import
  inboxDraining: false,     // guard against concurrent inbox drains
  bookmarkletResult: null,  // last inbox import result {added,skipped,scoresUpdated,drained} | {error}
  savedAtClumpy: null,      // null=unchecked, true=clumps found, false=clean
  syncLog: [],              // in-memory diagnostic log, session only
  _lastIndicatorLabel: null,// tracks last rendered indicator to avoid duplicate log entries
};

// ─── SYNC LOG ────────────────────────────────────────────────────────────────
// In-memory diagnostic log. Written each session, never persisted.
// Captures sync lifecycle events with timestamps relative to session start.

export const _sessionStart = Date.now();
export const SYNC_LOG_MAX = 200;

export function syncLog(msg, level = 'info') {
  const elapsed = ((Date.now() - _sessionStart) / 1000).toFixed(1);
  const entry = { t: elapsed, msg, level, wall: new Date().toLocaleTimeString() };
  state.syncLog.unshift(entry); // newest first
  if (state.syncLog.length > SYNC_LOG_MAX) state.syncLog.length = SYNC_LOG_MAX;
  // Refresh log panel if it's currently visible
  const logEl = document.getElementById('sync-log-entries');
  if (logEl) renderSyncLogEntries(logEl);
}

export function renderSyncLogEntries(el) {
  if (!el) return;
  const colors = { info: 'var(--text-muted)', warn: '#f59e0b', error: '#ef4444', ok: '#22c55e' };
  el.innerHTML = state.syncLog.map(e => `
    <div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:11px;font-family:monospace">
      <span style="color:var(--text-muted);flex-shrink:0;width:48px">+${e.t}s</span>
      <span style="color:var(--text-muted);flex-shrink:0;width:52px">${e.wall}</span>
      <span style="color:${colors[e.level]||'var(--text)'}">${escHtml(e.msg)}</span>
    </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No events yet this session</div>';
}

// Tracks the in-flight startup cloud sync so autoFeedSyncIfDue can wait for it
