// core.js — part of RedditVault (auto-split from the original single-file PWA).
import { checkCloudAhead, markClean, pullPreferences, pushListsToSupabase, scheduleRetry, supabaseFetch, syncFromSupabase } from './cloud.js';
import { autoFeedSyncIfDue } from './feed.js';
import { render, renderHeaderActions } from './render.js';
import { filteredItems, itemMatchesTokens, parseSearchQuery } from './search.js';
import { db, state, syncLog } from './state.js';
import { applyZoomSetting, showToast } from './util.js';

export let _startupSyncPromise = null;

// ─── INIT ────────────────────────────────────────────────────────────────────
export async function init() {
  await loadConfig();
  await loadData();
  syncLog(`App init — localDirty=${state.localDirty} lastPushedAt=${state.lastPushedAt || 'none'}`);
  render();
  if (state.supabaseUrl) {
    pullPreferences().then(() => render());
    if (state.localDirty) {
      syncLog('Startup: dirty flag set — scheduling retry and reconciling', 'warn');
      scheduleRetry();
      _startupSyncPromise = reconcileDirtyState();
    } else {
      syncLog('Startup: clean — checking if cloud is ahead');
      _startupSyncPromise = checkCloudAhead();
    }
  } else {
    syncLog('Startup: no Supabase configured — sync disabled');
    _startupSyncPromise = Promise.resolve();
  }
  // Auto feed sync on startup — waits for cloud sync to fully complete first
  _startupSyncPromise.catch(() => {}).then(() => autoFeedSyncIfDue());
}

export async function reconcileDirtyState() {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  syncLog('Reconcile: starting — checking cloud timestamp');
  try {
    const rows = await supabaseFetch('/user_preferences?key=eq.last_modified&select=value,updated_at');
    const cloudTs = rows?.[0]?.value || rows?.[0]?.updated_at;
    const cloudTime = cloudTs ? new Date(cloudTs).getTime() : 0;
    const localTime = state.lastPushedAt ? new Date(state.lastPushedAt).getTime() : 0;
    syncLog(`Reconcile: cloudTime=${cloudTs||'none'} localTime=${state.lastPushedAt||'none'} diff=${((cloudTime-localTime)/1000).toFixed(0)}s`);

    if (cloudTime > localTime + 5000) {
      syncLog('Reconcile: cloud is ahead — pulling', 'warn');
      state.cloudAhead = true;
      renderHeaderActions();
      await syncFromSupabase();
      if (state.localDirty) {
        syncLog('Reconcile: still dirty after pull — force clearing', 'warn');
        await markClean();
      }
    } else {
      syncLog('Reconcile: local may be ahead — attempting push');
      try {
        await pushListsToSupabase();
        syncLog('Reconcile: push succeeded', 'ok');
      } catch(e) {
        syncLog(`Reconcile: push failed (${e.message}) — clearing dirty anyway`, 'warn');
        await markClean();
      }
      if (state.localDirty) {
        syncLog('Reconcile: still dirty after push — force clearing', 'warn');
        await markClean();
      }
    }
  } catch(e) {
    syncLog(`Reconcile: failed — network unavailable? (${e.message})`, 'error');
    console.warn('reconcileDirtyState failed:', e.message);
  }
}

export async function loadConfig() {
  try {
    const url = await db.config.get('supabaseUrl');
    const key = await db.config.get('supabaseKey');
    const enrichRpm = await db.config.get('enrichReqPerMin');
    const retryRpm = await db.config.get('enrichRetryReqPerMin');
    const rlPause = await db.config.get('enrichRateLimitPause');
    if (url) state.supabaseUrl = url.value;
    if (key) state.supabaseKey = key.value;
    const maxAttempts = await db.config.get('enrichMaxAttempts');
    const lastRunRL = await db.config.get('lastRunRateLimitHits');
    if (enrichRpm) state.enrichReqPerMin = enrichRpm.value;
    if (retryRpm) state.enrichRetryReqPerMin = retryRpm.value;
    if (rlPause) state.enrichRateLimitPause = rlPause.value;
    if (maxAttempts) state.enrichMaxAttempts = maxAttempts.value;
    if (lastRunRL) state.lastRunRateLimitHits = lastRunRL.value;
    const recents = await db.config.get('recentSearches');
    if (recents) state.recentSearches = recents.value || [];
    const recentlyViewed = await db.config.get('recentlyViewed');
    if (recentlyViewed && Array.isArray(recentlyViewed.value)) state.recentlyViewed = recentlyViewed.value;
    const feedUrl = await db.config.get('redditFeedUrl');
    if (feedUrl) state.redditFeedUrl = feedUrl.value;
    const proxyUrl = await db.config.get('feedProxyUrl');
    if (proxyUrl) state.feedProxyUrl = proxyUrl.value;
    const proxyType = await db.config.get('feedProxyType');
    if (proxyType) state.feedProxyType = proxyType.value;
    const feedFormat = await db.config.get('feedFormat');
    if (feedFormat) state.feedFormat = feedFormat.value;
    const confirmDestructive = await db.config.get('confirmDestructive');
    if (confirmDestructive) state.confirmDestructive = confirmDestructive.value;
    const disableZoom = await db.config.get('disableZoom');
    if (disableZoom) state.disableZoom = disableZoom.value;
    applyZoomSetting();
    const autoFeedSync = await db.config.get('autoFeedSync');
    if (autoFeedSync) state.autoFeedSync = autoFeedSync.value;
    const autoFeedSyncInterval = await db.config.get('autoFeedSyncInterval');
    if (autoFeedSyncInterval) state.autoFeedSyncInterval = autoFeedSyncInterval.value;
    const localDirty = await db.config.get('localDirty');
    if (localDirty) state.localDirty = localDirty.value;
    const lastPushedAt = await db.config.get('lastPushedAt');
    const lastSyncedAt = await db.config.get('lastSyncedAt');
    if (lastPushedAt) state.lastPushedAt = lastPushedAt.value;
    if (lastSyncedAt) state.lastSyncedAt = lastSyncedAt.value;
    const lastFeedSync = await db.config.get('lastFeedSync');
    if (lastFeedSync) state.lastFeedSync = lastFeedSync.value;
  } catch(e) {}
}

export async function loadData() {
  state.items = await db.items.orderBy('savedAt').reverse().toArray();
  state.lists = await db.lists.orderBy('name').toArray();
  state.itemLists = await db.item_lists.toArray();
  // Build author frequency map — only visible items (not disliked, dead, or permanently deleted)
  state.authorFreq = {};
  for (const item of state.items) {
    if (!item.author || item.author === '[deleted]' || item.author === 'AutoModerator') continue;
    if (item.isDisliked || item.enrichStatus === 'dead' || item.isPermanentlyDeleted) continue;
    state.authorFreq[item.author] = (state.authorFreq[item.author] || 0) + 1;
  }
  const freqVals = Object.values(state.authorFreq);
  state.maxAuthorFreq = freqVals.length ? Math.max(...freqVals) : 1;
  rebuildTagCache();
  rebuildFilterLists();
}

export function rebuildFilterLists() {
  const visible = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead');
  state.subredditList = [...new Set(visible.map(i => i.subreddit).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  state.authorList    = [...new Set(visible.map(i => i.author).filter(s => s && s !== '[deleted]' && s !== 'AutoModerator'))].sort((a, b) => a.localeCompare(b));
}

// ─── TAG CACHE ───────────────────────────────────────────────────────────────
// Pre-computes matching item sets for all smart list tags so render and
// filteredItems() can do cheap Set.has() lookups instead of re-running
// token matching on every render.
// Rebuilt after any DB change (loadData), and incrementally for a single
// list when its query is created or edited.

// Map<listId, { count: number, itemIds: Set<number> }> — initialised in the
// `state` object literal; rebuilt here.
export function rebuildTagCache(onlyListId = null) {
  const visibleItems = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead');
  const listsToRebuild = onlyListId
    ? state.lists.filter(l => l.id === onlyListId)
    : state.lists.filter(l => l.type === 'smart');

  for (const list of listsToRebuild) {
    const tokens = parseSearchQuery(list.query || '');
    const matchingIds = new Set(
      visibleItems
        .filter(i => tokens.length === 0 || itemMatchesTokens(i, tokens))
        .map(i => i.id)
    );
    state.tagCache.set(list.id, { count: matchingIds.size, itemIds: matchingIds });
  }

  // Remove cache entries for lists that no longer exist
  if (!onlyListId) {
    const listIds = new Set(state.lists.map(l => l.id));
    for (const id of state.tagCache.keys()) {
      if (!listIds.has(id)) state.tagCache.delete(id);
    }
  }
}

// ─── ENRICHMENT ──────────────────────────────────────────────────────────────
// Fetches title, subreddit, post_created_at, author from Reddit's public .json API.
// Works without authentication. Uses adaptive rate limiting and batch pausing
// to survive enriching thousands of items without getting blocked by Reddit.

// enriched field values:
//   false / 0 / undefined = needs enrichment
//   true / 1              = successfully enriched OR permanently unavailable (deleted/private)
// enrichAttempts field tracks how many times we've tried, so we can skip
// items that have failed many times (truly deleted/private) vs ones that
// just got rate-limited mid-run.

export async function markDirty(reason = 'unspecified') {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  const wasClean = !state.localDirty;
  state.localDirty = true;
  await db.config.put({ key: 'localDirty', value: true });
  if (wasClean) syncLog(`Dirty: ${reason}`, 'warn');
  renderHeaderActions();
  scheduleRetry();
}

export async function clearAllData() {
  await db.items.clear();
  await db.lists.clear();
  await db.item_lists.clear();
  await db.folders.clear();
  await loadData();
  render();
  showToast('All local data cleared', 'success');
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
