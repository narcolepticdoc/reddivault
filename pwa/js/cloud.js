// cloud.js — part of RedditVault (auto-split from the original single-file PWA).
import { loadData, markDirty } from './core.js';
import { render, renderHeaderActions } from './render.js';
import { db, state, syncLog } from './state.js';
import { showToast } from './util.js';

export async function supabaseFetch(path, method='GET', body=null) {
  if (!state.supabaseUrl || !state.supabaseKey) throw new Error('Supabase not configured');
  const res = await fetch(`${state.supabaseUrl}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': state.supabaseKey,
      'Authorization': `Bearer ${state.supabaseKey}`,
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : ''
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return method === 'GET' ? res.json() : res;
}

// Fetches a specific row range using HTTP Range headers — the correct way to
// paginate Supabase which otherwise hard-caps at 1000 rows per request
export async function supabaseFetchRange(path, from, to) {
  if (!state.supabaseUrl || !state.supabaseKey) throw new Error('Supabase not configured');
  const res = await fetch(`${state.supabaseUrl}/rest/v1${path}`, {
    headers: {
      'apikey': state.supabaseKey,
      'Authorization': `Bearer ${state.supabaseKey}`,
      'Range': `${from}-${to}`,
      'Range-Unit': 'items',
      'Prefer': 'count=none'
    }
  });
  // 206 Partial Content = more pages exist, 200 = last page
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`Supabase range fetch error: ${res.status}`);
  }
  return res.json();
}

export let _retryTimer = null;
export let _retryCount = 0;
export const RETRY_DELAYS = [30000, 60000, 120000]; // 30s, 1min, 2min

export function scheduleRetry() {
  if (_retryTimer) return;
  if (_retryCount >= RETRY_DELAYS.length) {
    syncLog('Retry: max attempts reached — giving up', 'error');
    return;
  }
  const delay = RETRY_DELAYS[_retryCount];
  syncLog(`Retry: scheduled in ${delay/1000}s (attempt ${_retryCount + 1})`);
  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    if (!state.localDirty) { _retryCount = 0; return; }
    _retryCount++;
    syncLog(`Retry: attempt ${_retryCount} starting`);
    try {
      await pushAllDirty();
    } catch(e) {
      syncLog(`Retry: attempt ${_retryCount} failed — ${e.message}`, 'error');
      if (state.localDirty) scheduleRetry();
    }
  }, delay);
}

export async function pushAllDirty() {
  if (!state.supabaseUrl || !state.supabaseKey || !state.localDirty) return;
  syncLog('pushAllDirty: pushing lists');
  await pushListsToSupabase();
}

export async function markClean(pushedAt) {
  const ts = pushedAt || new Date().toISOString();
  const wasDirty = state.localDirty;
  state.localDirty = false;
  state.cloudAhead = false;
  state.lastPushedAt = ts;
  state.lastSyncedAt = ts;
  _retryCount = 0;
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  await db.config.put({ key: 'localDirty', value: false });
  await db.config.put({ key: 'lastPushedAt', value: ts });
  await db.config.put({ key: 'lastSyncedAt', value: ts });
  if (wasDirty) syncLog('Clean: dirty flag cleared', 'ok');
  try {
    await supabaseFetch('/user_preferences?on_conflict=key', 'POST',
      [{ key: 'last_modified', value: ts, updated_at: ts }]);
  } catch(e) {
    syncLog(`Clean: failed to write cloud timestamp — ${e.message}`, 'warn');
  }
  renderHeaderActions();
}

export async function checkCloudAhead() {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  try {
    const rows = await supabaseFetch('/user_preferences?key=eq.last_modified&select=value,updated_at');
    if (!rows || !rows.length) {
      syncLog('checkCloudAhead: no last_modified record found');
      return;
    }
    const cloudTs = rows[0].value || rows[0].updated_at;
    if (!cloudTs) return;
    const cloudTime = new Date(cloudTs).getTime();
    const localTime = state.lastPushedAt ? new Date(state.lastPushedAt).getTime() : 0;
    const diff = ((cloudTime - localTime) / 1000).toFixed(0);
    if (cloudTime > localTime + 5000) {
      syncLog(`checkCloudAhead: cloud ahead by ${diff}s — pulling`, 'warn');
      state.cloudAhead = true;
      renderHeaderActions();
      showToast('Cloud has newer data — syncing…', 'info');
      await syncFromSupabase();
    } else {
      syncLog(`checkCloudAhead: in sync (diff=${diff}s)`);
      state.syncStatus = 'connected';
      state.lastSyncedAt = new Date().toISOString();
      await db.config.put({ key: 'lastSyncedAt', value: state.lastSyncedAt });
      renderHeaderActions();
    }
  } catch(e) {
    syncLog(`checkCloudAhead failed — ${e.message}`, 'error');
    console.warn('Cloud check failed:', e);
  }
}

export async function pushPreference(key, value) {
  if (!state.supabaseUrl) return;
  try {
    await supabaseFetch(
      '/user_preferences?on_conflict=key',
      'POST',
      [{ key, value, updated_at: new Date().toISOString() }]
    );
  } catch(e) {
    console.warn('Preference push failed:', e);
  }
}

// Pushes the small set of important config preferences with dirty/clean tracking.
// These are rarely changed but critical for the app to work correctly on a new device.
export async function pushImportantPreferences() {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  try {
    await supabaseFetch('/user_preferences?on_conflict=key', 'POST', [
      { key: 'redditFeedUrl',      value: state.redditFeedUrl,      updated_at: new Date().toISOString() },
      { key: 'feedProxyUrl',       value: state.feedProxyUrl,       updated_at: new Date().toISOString() },
      { key: 'feedProxyType',      value: state.feedProxyType,      updated_at: new Date().toISOString() },
      { key: 'feedFormat',         value: state.feedFormat,         updated_at: new Date().toISOString() },
      { key: 'confirmDestructive', value: state.confirmDestructive, updated_at: new Date().toISOString() },
    ]);
    syncLog('pushImportantPreferences: ok', 'ok');
  } catch(e) {
    syncLog(`pushImportantPreferences failed — ${e.message}`, 'error');
    await markDirty('important preferences push failed');
  }
}

export async function pullPreferences() {
  if (!state.supabaseUrl) return;
  try {
    const rows = await supabaseFetch('/user_preferences?select=*');
    for (const row of rows) {
      if (row.key === 'recentSearches' && Array.isArray(row.value)) {
        const merged = [...new Set([...row.value, ...state.recentSearches])].slice(0, 20);
        state.recentSearches = merged;
        await db.config.put({ key: 'recentSearches', value: merged });
      }
      if (row.key === 'redditFeedUrl' && row.value) {
        state.redditFeedUrl = row.value;
        await db.config.put({ key: 'redditFeedUrl', value: row.value });
      }
      if (row.key === 'feedProxyUrl' && row.value) {
        state.feedProxyUrl = row.value;
        await db.config.put({ key: 'feedProxyUrl', value: row.value });
      }
      if (row.key === 'feedProxyType' && row.value) {
        state.feedProxyType = row.value;
        await db.config.put({ key: 'feedProxyType', value: row.value });
      }
      if (row.key === 'feedFormat' && row.value) {
        state.feedFormat = row.value;
        await db.config.put({ key: 'feedFormat', value: row.value });
      }
      if (row.key === 'confirmDestructive' && row.value !== undefined) {
        state.confirmDestructive = row.value;
        await db.config.put({ key: 'confirmDestructive', value: row.value });
      }
    }
    syncLog(`pullPreferences: ok — ${rows.length} preference${rows.length !== 1 ? 's' : ''} loaded`);
  } catch(e) {
    syncLog(`pullPreferences: failed — ${e.message}`, 'error');
    console.warn('Preference pull failed:', e);
  }
}

export async function syncFromSupabase() {
  // Record pull start time BEFORE fetching — any row modified during a slow pull
  // will have updated_at >= pullStartedAt, so it won't be missed next time.
  const pullStartedAt = new Date().toISOString();

  // Delta sync: only fetch rows modified since our last successful push.
  // This is the correct cursor — we want everything that changed on the cloud
  // after we last wrote to it. Falls back to full scan on first-time setup.
  const cursor = state.lastPushedAt || null;
  const isDelta = !!cursor;
  const deltaFilter = isDelta ? `&updated_at=gt.${encodeURIComponent(cursor)}` : '';

  syncLog(`syncFromSupabase: starting ${isDelta ? 'delta' : 'full'} pull${isDelta ? ` (since ${cursor})` : ''}`);
  state.syncStatus = 'syncing';
  renderHeaderActions();
  try {
    const PAGE_SIZE = 1000;
    let allRemoteItems = [];
    let offset = 0;
    while (true) {
      const page = await supabaseFetchRange(
        `/reddit_saves?select=*&order=updated_at.desc${deltaFilter}`,
        offset, offset + PAGE_SIZE - 1
      );
      allRemoteItems = allRemoteItems.concat(page);
      if (isDelta) {
        showToast(`Fetching changes... ${allRemoteItems.length} items`, 'success');
      } else {
        showToast(`Fetching from cloud... ${allRemoteItems.length} items`, 'success');
      }
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    syncLog(`syncFromSupabase: fetched ${allRemoteItems.length} ${isDelta ? 'changed' : 'total'} items`);

    let added = 0, updated = 0;
    for (const item of allRemoteItems) {
      const exists = await db.items.where('redditId').equals(item.reddit_id).first();
      // If cloud row has deleted_at, honour it; never overwrite a local permanent deletion
      const isPermanentlyDeleted = !!(item.deleted_at || (exists && exists.isPermanentlyDeleted));
      const deletedAt = item.deleted_at || (exists && exists.deletedAt) || null;
      if (!exists) {
        // Don't re-add items the cloud knows are permanently deleted
        if (isPermanentlyDeleted) { updated++; continue; }
        await db.items.add({
          redditId: item.reddit_id,
          type: item.type,
          subreddit: item.subreddit || '',
          title: item.title || '',
          url: item.url || '',
          permalink: item.permalink || item.url || '',
          body: item.body || '',
          author: item.author || '',
          score: item.score ?? null,
          savedAt: item.saved_at,
          postCreatedAt: item.post_created_at || null,
          enriched: !!(item.title && item.subreddit),
          enrichStatus: item.enrich_status || ((item.title && item.subreddit) ? 'enriched' : 'pending'),
          isFavourite:  item.is_favourite || false,
          rating:       item.rating || null,
          isDisliked:   item.is_disliked || false,
          isPermanentlyDeleted: false,
          deletedAt: null,
          enrichAttempts: 0,
          syncedAt: new Date().toISOString()
        });
        added++;
      } else {
        await db.items.update(exists.id, {
          type:                 item.type,
          subreddit:            item.subreddit || '',
          title:                item.title || '',
          url:                  item.url || '',
          permalink:            item.permalink || item.url || '',
          body:                 item.body || '',
          author:               item.author || '',
          score:                item.score ?? null,
          savedAt:              item.saved_at,
          postCreatedAt:        item.post_created_at || null,
          enriched:             !!(item.title && item.subreddit),
          enrichStatus:         item.enrich_status || ((item.title && item.subreddit) ? 'enriched' : 'pending'),
          isFavourite:          item.is_favourite || false,
          rating:               item.rating || null,
          isDisliked:           item.is_disliked || false,
          isPermanentlyDeleted,
          deletedAt,
          syncedAt:             new Date().toISOString(),
        });
        updated++;
      }
    }
    syncLog(`syncFromSupabase: upserted items — added=${added} updated=${updated}`);

    // Lists sync: delta on list records, full rebuild of memberships only when lists changed.
    let changedLists = [];
    try {
      const listsDeltaFilter = isDelta ? `&updated_at=gt.${encodeURIComponent(cursor)}` : '';
      changedLists = await supabaseFetch(`/reddit_lists?select=*${listsDeltaFilter}`);
      const listsChanged = !isDelta || changedLists.length > 0;

      if (!isDelta) {
        // Full sync: reconcile all lists against remote
        const allRemoteLists = changedLists;
        for (const l of allRemoteLists) {
          const exists = await db.lists.where('name').equals(l.name).first();
          if (!exists) {
            await db.lists.add({ name: l.name, type: l.type, query: l.query || '', isTag: l.is_tag || false, tagName: l.tag_name || '', optionsJson: l.options_json || null, createdAt: l.created_at });
          } else {
            await db.lists.update(exists.id, { type: l.type, query: l.query || '', isTag: l.is_tag || false, tagName: l.tag_name || '', optionsJson: l.options_json || null });
          }
        }
        const remoteNames = new Set(allRemoteLists.map(l => l.name));
        const localLists = await db.lists.toArray();
        for (const l of localLists) {
          if (!remoteNames.has(l.name)) {
            await db.lists.delete(l.id);
            await db.item_lists.where('listId').equals(l.id).delete();
          }
        }
      } else if (changedLists.length > 0) {
        // Delta: only upsert the lists that changed; deletions detected by checking all remote names
        const allRemoteLists = await supabaseFetch('/reddit_lists?select=name');
        const remoteNames = new Set(allRemoteLists.map(l => l.name));
        for (const l of changedLists) {
          const exists = await db.lists.where('name').equals(l.name).first();
          if (!exists) {
            await db.lists.add({ name: l.name, type: l.type, query: l.query || '', isTag: l.is_tag || false, tagName: l.tag_name || '', optionsJson: l.options_json || null, createdAt: l.created_at });
          } else {
            await db.lists.update(exists.id, { type: l.type, query: l.query || '', isTag: l.is_tag || false, tagName: l.tag_name || '', optionsJson: l.options_json || null });
          }
        }
        const localLists = await db.lists.toArray();
        for (const l of localLists) {
          if (!remoteNames.has(l.name)) {
            await db.lists.delete(l.id);
            await db.item_lists.where('listId').equals(l.id).delete();
          }
        }
      }

      // Reconcile memberships only for lists that changed.
      // reddit_item_lists has no updated_at, but we now touch the parent list's
      // updated_at whenever memberships change, so changedLists tells us exactly
      // which lists need their memberships refreshed.
      if (listsChanged) {
        const freshLists = await db.lists.toArray();
        const allLocalItems = await db.items.toArray();

        // Determine which static lists need membership reconciliation
        const listsToReconcile = !isDelta
          ? freshLists.filter(l => l.type === 'static')
          : changedLists
              .filter(l => l.type === 'static')
              .map(l => freshLists.find(fl => fl.name === l.name))
              .filter(Boolean);

        for (const list of listsToReconcile) {
          const remoteMembers = await supabaseFetch(
            `/reddit_item_lists?list_name=eq.${encodeURIComponent(list.name)}&select=reddit_id`
          );
          const remoteMemberIds = new Set(remoteMembers.map(r => r.reddit_id));

          // Get current local memberships for this list
          const localMemberships = await db.item_lists.where('listId').equals(list.id).toArray();
          const localMemberRedditIds = new Set(
            localMemberships.map(il => allLocalItems.find(i => i.id === il.itemId)?.redditId).filter(Boolean)
          );

          // Add missing
          for (const redditId of remoteMemberIds) {
            if (!localMemberRedditIds.has(redditId)) {
              const item = allLocalItems.find(i => i.redditId === redditId);
              if (item) await db.item_lists.add({ itemId: item.id, listId: list.id });
            }
          }
          // Remove stale
          for (const il of localMemberships) {
            const redditId = allLocalItems.find(i => i.id === il.itemId)?.redditId;
            if (redditId && !remoteMemberIds.has(redditId)) {
              await db.item_lists.delete(il.id);
            }
          }
        }
        syncLog(`syncFromSupabase: memberships reconciled — ${listsToReconcile.length} lists`);
      } else {
        syncLog('syncFromSupabase: lists unchanged, skipping membership reconciliation');
      }

      syncLog(`syncFromSupabase: lists synced — ${changedLists.length} changed`);
    } catch(e) {
      syncLog(`syncFromSupabase: lists sync skipped — ${e.message}`, 'warn');
    }

    // Pull complete — lastPushedAt (delta cursor) does not advance on pull.
    // lastSyncedAt (display label) does — we are now confirmed in sync.
    // markClean is NOT called here — it would advance lastPushedAt incorrectly.
    state.lastSyncedAt = pullStartedAt;
    await db.config.put({ key: 'lastSyncedAt', value: pullStartedAt });
    state.syncStatus = 'connected';
    state.cloudAhead = false;
    state.localDirty = false;
    _retryCount = 0;
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    await db.config.put({ key: 'localDirty', value: false });
    await loadData();
    await pullPreferences();
    renderHeaderActions();
    syncLog(`syncFromSupabase: complete`, 'ok');
    if (isDelta && allRemoteItems.length === 0 && !changedLists?.length) {
      showToast('Already up to date ✓', 'success');
    } else {
      const label = isDelta ? 'changes' : 'items';
      showToast(`Synced ${added + updated} ${label} from cloud ✓`, 'success');
    }
    render();
  } catch(e) {
    state.syncStatus = 'disconnected';
    syncLog(`syncFromSupabase: failed — ${e.message}`, 'error');
    showToast('Sync failed: ' + e.message, 'error');
    renderHeaderActions();
  }
}

// Lightweight delta pull run before every push.
// Fetches anything on the cloud newer than our last push, merges it in locally,
// so we never blindly overwrite changes from another device.
// If no lastPushedAt exists (first push ever) this is a no-op — the full startup
// pull will have already fetched everything. lastPushedAt is the correct cursor
// here (not lastSyncedAt) because we want items changed since we last *wrote*.
export async function deltaPullBeforePush() {
  if (!state.supabaseUrl || !state.supabaseKey || !state.lastPushedAt) return;
  syncLog('deltaPullBeforePush: checking for remote changes since last push');
  try {
    const cursor = state.lastPushedAt;
    const deltaFilter = `&updated_at=gt.${encodeURIComponent(cursor)}`;

    // Items
    const remoteItems = await supabaseFetch(`/reddit_saves?select=*&order=updated_at.desc${deltaFilter}`);
    if (remoteItems && remoteItems.length > 0) {
      syncLog(`deltaPullBeforePush: merging ${remoteItems.length} remote item(s)`);
      for (const r of remoteItems) {
        const existing = await db.items.where('redditId').equals(r.reddit_id).first();
        if (!existing) {
          await db.items.add({
            redditId: r.reddit_id, type: r.type, subreddit: r.subreddit,
            title: r.title, url: r.url, permalink: r.permalink,
            body: r.body, author: r.author, score: r.score,
            savedAt: r.saved_at, postCreatedAt: r.post_created_at,
            enrichStatus: r.enrich_status || 'pending',
            isFavourite: r.is_favourite || false, rating: r.rating || null,
            isDisliked: r.is_disliked || false,
            syncedAt: new Date().toISOString(),
          });
        } else {
          // Only overwrite if remote is genuinely newer than our local copy
          const remoteTs = new Date(r.updated_at || 0).getTime();
          const localTs  = new Date(existing.syncedAt || 0).getTime();
          if (remoteTs > localTs) {
            await db.items.update(existing.id, {
              isFavourite: r.is_favourite || false,
              rating: r.rating || null,
              isDisliked: r.is_disliked || false,
              enrichStatus: r.enrich_status || existing.enrichStatus,
              syncedAt: new Date().toISOString(),
            });
          }
        }
      }
      await loadData();
    }

    // Lists — upsert changed, reconcile deletions, refresh memberships for changed lists
    const remoteLists = await supabaseFetch(`/reddit_lists?select=*${deltaFilter}`);
    if (remoteLists && remoteLists.length > 0) {
      syncLog(`deltaPullBeforePush: merging ${remoteLists.length} remote list(s)`);
      for (const l of remoteLists) {
        const existing = state.lists.find(loc => loc.name === l.name);
        if (!existing) {
          await db.lists.add({
            name: l.name, type: l.type, query: l.query || '',
            isTag: l.is_tag || false, tagName: l.tag_name || '',
            optionsJson: l.options_json || null,
            createdAt: l.created_at,
          });
        } else {
          await db.lists.update(existing.id, {
            type: l.type, query: l.query || '',
            isTag: l.is_tag || false, tagName: l.tag_name || '',
            optionsJson: l.options_json || null,
          });
        }
      }
      // Check for deletions — any local list not on the remote should be removed
      const allRemoteNames = await supabaseFetch('/reddit_lists?select=name');
      const remoteNameSet = new Set(allRemoteNames.map(l => l.name));
      const localLists = await db.lists.toArray();
      for (const l of localLists) {
        if (!remoteNameSet.has(l.name)) {
          await db.lists.delete(l.id);
          await db.item_lists.where('listId').equals(l.id).delete();
        }
      }
      // Reconcile memberships for changed static lists
      await loadData();
      const freshLists = await db.lists.toArray();
      const allLocalItems = await db.items.toArray();
      for (const rl of remoteLists.filter(l => l.type === 'static')) {
        const local = freshLists.find(fl => fl.name === rl.name);
        if (!local) continue;
        const remoteMembers = await supabaseFetch(
          `/reddit_item_lists?list_name=eq.${encodeURIComponent(rl.name)}&select=reddit_id`
        );
        const remoteMemberIds = new Set(remoteMembers.map(r => r.reddit_id));
        const localMemberships = await db.item_lists.where('listId').equals(local.id).toArray();
        const localMemberRedditIds = new Set(
          localMemberships.map(il => allLocalItems.find(i => i.id === il.itemId)?.redditId).filter(Boolean)
        );
        for (const redditId of remoteMemberIds) {
          if (!localMemberRedditIds.has(redditId)) {
            const item = allLocalItems.find(i => i.redditId === redditId);
            if (item) await db.item_lists.add({ itemId: item.id, listId: local.id });
          }
        }
        for (const il of localMemberships) {
          const redditId = allLocalItems.find(i => i.id === il.itemId)?.redditId;
          if (redditId && !remoteMemberIds.has(redditId)) {
            await db.item_lists.delete(il.id);
          }
        }
      }
      await loadData();
    }

    syncLog('deltaPullBeforePush: done', 'ok');
  } catch(e) {
    syncLog(`deltaPullBeforePush: failed — ${e.message}`, 'warn');
    // Non-fatal — proceed with push rather than blocking it
  }
}

export async function pushToSupabase(items, skipClean = false) {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  const payload = items.map(i => ({
    reddit_id: i.redditId,
    type: i.type,
    subreddit: i.subreddit || '',
    title: i.title || '',
    url: i.url || '',
    permalink: i.permalink || i.url || '',
    body: i.body || '',
    author: i.author || '',
    score: i.score ?? null,
    saved_at: i.savedAt,
    post_created_at: i.postCreatedAt || null,
    enrich_status: i.enrichStatus || 'pending',
    is_favourite: i.isFavourite || false,
    rating: i.rating || null,
    is_disliked: i.isDisliked || false,
  }));
  try {
    await supabaseFetch('/reddit_saves?on_conflict=reddit_id', 'POST', payload);
    syncLog(`push: ${items.length} item${items.length !== 1 ? 's' : ''} pushed to cloud`, 'ok');
    if (!skipClean) await markClean();
  } catch(e) {
    syncLog(`push: failed — ${e.message}`, 'error');
    console.warn('Push failed:', e);
  }
}

export async function pushListsToSupabase(skipPull = false) {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  if (!skipPull) await deltaPullBeforePush();
  syncLog('pushListsToSupabase: starting');
  try {
    const lists = await db.lists.toArray();
    const itemLists = await db.item_lists.toArray();
    const allItems = await db.items.toArray();

    if (lists.length) {
      const fullPayload = lists.map(l => ({
        name: l.name, type: l.type, query: l.query || '',
        is_tag: l.isTag || false, tag_name: l.tagName || '',
        options_json: l.optionsJson || null,
        created_at: l.createdAt
      }));
      await supabaseFetch('/reddit_lists?on_conflict=name', 'POST', fullPayload);
      syncLog(`pushListsToSupabase: ${lists.length} list${lists.length !== 1 ? 's' : ''} upserted`);
    }

    const idToRedditId = new Map(allItems.map(i => [i.id, i.redditId]));
    for (const list of lists) {
      const memberRedditIds = itemLists
        .filter(il => il.listId === list.id)
        .map(il => idToRedditId.get(il.itemId))
        .filter(Boolean);
      await supabaseFetch(`/reddit_item_lists?list_name=eq.${encodeURIComponent(list.name)}`, 'DELETE', null);
      if (memberRedditIds.length) {
        const payload = memberRedditIds.map(reddit_id => ({ reddit_id, list_name: list.name }));
        await supabaseFetch('/reddit_item_lists?on_conflict=reddit_id,list_name', 'POST', payload);
      }
      // Touch the list's updated_at so the moddatetime trigger fires — this is what
      // lets the delta pull detect that memberships changed for this list.
      await supabaseFetch(
        `/reddit_lists?name=eq.${encodeURIComponent(list.name)}`,
        'PATCH',
        { updated_at: new Date().toISOString() }
      );
      syncLog(`pushListsToSupabase: memberships pushed for "${list.name}" (${memberRedditIds.length} members)`);
    }
    syncLog(`pushListsToSupabase: ok — ${lists.length} lists`, 'ok');
    state.syncStatus = 'connected';
    await markClean();
  } catch(e) {
    syncLog(`pushListsToSupabase: failed — ${e.message}`, 'error');
    throw e;
  }
}

export async function deleteListFromSupabase(listName) {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  try {
    await deltaPullBeforePush();
    await supabaseFetch(`/reddit_item_lists?list_name=eq.${encodeURIComponent(listName)}`, 'DELETE', null);
    await supabaseFetch(`/reddit_lists?name=eq.${encodeURIComponent(listName)}`, 'DELETE', null);
    await markClean();
  } catch(e) { console.warn('List delete from cloud failed:', e.message); }
}

// ─── IMPORT ──────────────────────────────────────────────────────────────────
export async function pushAllToSupabase() {
  if (!state.supabaseUrl || !state.supabaseKey) {
    showToast('Supabase not configured', 'error');
    return;
  }
  showToast('Pushing all local data to cloud…', 'info');
  try {
    await deltaPullBeforePush(); // pull once before the entire operation
    const allItems = await db.items.toArray();
    const BATCH = 200;
    for (let i = 0; i < allItems.length; i += BATCH) {
      await pushToSupabase(allItems.slice(i, i + BATCH), true); // skipClean — markClean called once at end
      showToast(`Pushing… ${Math.min(i + BATCH, allItems.length)} / ${allItems.length}`, 'info');
    }
    await pushListsToSupabase(true); // pull already done above, skipPull=true
    // markClean already called by pushListsToSupabase
    showToast(`✓ Pushed ${allItems.length.toLocaleString()} items + lists to cloud`, 'success');
  } catch(e) {
    showToast('Push failed: ' + e.message, 'error');
  }
}
export async function pushItemUpdate(id, fields) {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  const item = await db.items.get(id);
  if (!item) return;
  try {
    await supabaseFetch(`/reddit_saves?reddit_id=eq.${item.redditId}`, 'PATCH', fields);
    state.syncStatus = 'connected';
    await markClean();
  } catch(e) {
    syncLog(`pushItemUpdate failed for ${item.redditId} — ${e.message}`, 'error');
    await markDirty('item update push failed');
  }
}

export async function pushItemDelete(redditId) {
  if (!state.supabaseUrl || !state.supabaseKey) return;
  _setSyncing(true);
  try {
    await supabaseFetch(`/reddit_saves?reddit_id=eq.${redditId}`, 'DELETE', null);
    state.syncStatus = 'connected';
    syncLog(`pushItemDelete: ok — ${redditId}`, 'ok');
    _setSyncing(false);
    await markClean();
  } catch(e) {
    syncLog(`pushItemDelete failed for ${redditId} — ${e.message}`, 'error');
    _setSyncing(false);
    await markDirty('item delete push failed');
  }
}

export let _syncingTimer = null;
export function _setSyncing(on) {
  if (on) {
    state.syncStatus = 'syncing';
    renderHeaderActions();
    if (_syncingTimer) clearTimeout(_syncingTimer);
  } else {
    if (_syncingTimer) clearTimeout(_syncingTimer);
    _syncingTimer = setTimeout(() => {
      _syncingTimer = null;
      if (state.syncStatus === 'syncing') state.syncStatus = 'connected';
      renderHeaderActions();
    }, 600);
  }
}

