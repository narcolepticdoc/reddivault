// items.js — part of RedditVault (auto-split from the original single-file PWA).
import { _setSyncing, deleteListFromSupabase, markClean, pushItemUpdate, pushListsToSupabase, pushPreference, supabaseFetch } from './cloud.js';
import { loadData, markDirty, rebuildTagCache } from './core.js';
import { _searchLookup, closeModal, render, renderBrowseList, renderSortControl, showModal } from './render.js';
import { applyListOptions, extractTagTokens, hasNonDefaultOptions, serialiseListOptions, serialiseQueryWithTags, validateTagName } from './search.js';
import { db, state, syncLog } from './state.js';
import { escHtml, showToast } from './util.js';

export function showPage(page) {
  if (page !== 'browse' && state.editingListId) state.editingListId = null;
  state.page = page;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`nav-${page}`)?.classList.add('active');
  render();
  const content = document.getElementById('main-content');
  if (content) content.scrollTop = 0;
  window.scrollTo(0, 0);
}

export async function trackRecentlyViewed(itemId) {
  const id = Number(itemId);
  if (!Number.isFinite(id)) return;
  // Don't record trashed/deleted items — they'd consume a slot but never render.
  const item = state.items.find(i => i.id === id);
  if (item && (item.isDisliked || item.isPermanentlyDeleted)) return;
  const ts = new Date().toISOString();
  const list = (state.recentlyViewed || []).filter(r => r.id !== id);
  list.unshift({ id, ts });
  state.recentlyViewed = list.slice(0, 100);
  try { await db.config.put({ key: 'recentlyViewed', value: state.recentlyViewed }); } catch(e) {}
  if (state.page === 'recent') render();
}

export async function clearRecentlyViewed() {
  state.recentlyViewed = [];
  try { await db.config.put({ key: 'recentlyViewed', value: [] }); } catch(e) {}
  if (state.page === 'recent') render();
}

export async function toggleFavourite(id) {
  const item = await db.items.get(id);
  if (!item) return;
  const val = !item.isFavourite;
  await db.items.update(id, { isFavourite: val });
  syncLog(`toggleFavourite: ${item.redditId} → ${val}`);
  await loadData();
  renderBrowseList();
  _setSyncing(true);
  pushItemUpdate(id, { is_favourite: val }).then(() => _setSyncing(false));
}

export async function setRating(id, rating) {
  const item = await db.items.get(id);
  if (!item) return;
  const val = item.rating === rating ? null : rating;
  await db.items.update(id, { rating: val });
  syncLog(`setRating: ${item.redditId} → ${val}`);
  await loadData();
  renderBrowseList();
  _setSyncing(true);
  pushItemUpdate(id, { rating: val }).then(() => _setSyncing(false));
}

export async function dislikeItem(id) {
  const item = await db.items.get(id);
  if (!item) return;
  await db.items.update(id, { isDisliked: true, isFavourite: false, rating: null });
  syncLog(`dislikeItem (trash): ${item.redditId}`);
  await loadData();
  renderBrowseList();
  _setSyncing(true);
  pushItemUpdate(id, { is_disliked: true, is_favourite: false, rating: null }).then(() => _setSyncing(false));
}

export async function restoreItem(id) {
  const item = await db.items.get(id);
  if (!item) return;
  await db.items.update(id, { isDisliked: false });
  syncLog(`restoreItem: ${item.redditId}`);
  await loadData();
  renderBrowseList();
  _setSyncing(true);
  pushItemUpdate(id, { is_disliked: false }).then(() => _setSyncing(false));
}

export async function deleteItemPermanently(id) {
  const item = await db.items.get(id);
  if (!item) return;
  const deletedAt = new Date().toISOString();
  await db.items.update(id, { isPermanentlyDeleted: true, deletedAt });
  syncLog(`deleteItemPermanently: ${item.redditId}`);
  await loadData();
  renderBrowseList();
  _setSyncing(true);
  pushItemUpdate(id, { deleted_at: deletedAt, is_disliked: true }).then(() => _setSyncing(false));
}

export async function restoreDeletedItem(id) {
  const item = await db.items.get(id);
  if (!item) return;
  await db.items.update(id, { isPermanentlyDeleted: false, deletedAt: null, isDisliked: false });
  syncLog(`restoreDeletedItem: ${item.redditId}`);
  await loadData();
  render();
  _setSyncing(true);
  pushItemUpdate(id, { deleted_at: null, is_disliked: false }).then(() => _setSyncing(false));
}

export async function purgeDeletedItems() {
  const deleted = state.items.filter(i => i.isPermanentlyDeleted);
  if (!deleted.length) return;
  syncLog(`purgeDeletedItems: removing ${deleted.length} items from DB`);
  _setSyncing(true);
  for (const item of deleted) {
    await db.items.delete(item.id);
    if (state.supabaseUrl && item.redditId) {
      try {
        await supabaseFetch(`/reddit_saves?reddit_id=eq.${item.redditId}`, 'DELETE', null);
      } catch(e) {
        syncLog(`purgeDeletedItems: failed for ${item.redditId} — ${e.message}`, 'error');
        await markDirty('purge push failed');
      }
    }
  }
  _setSyncing(false);
  syncLog(`purgeDeletedItems: complete`, 'ok');
  if (state.supabaseUrl) await markClean();
  await loadData();
  render();
}

export async function purgeSingleItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  syncLog(`purgeSingleItem: removing ${item.redditId} from DB`);
  await db.items.delete(id);
  if (state.supabaseUrl && item.redditId) {
    try {
      await supabaseFetch(`/reddit_saves?reddit_id=eq.${item.redditId}`, 'DELETE', null);
    } catch(e) {
      syncLog(`purgeSingleItem: failed for ${item.redditId} — ${e.message}`, 'error');
      await markDirty('purgeSingleItem push failed');
    }
  }
  syncLog(`purgeSingleItem: complete`, 'ok');
  await loadData();
  render();
}

export async function deleteAllTrashed() {
  const trashed = state.items.filter(i => i.isDisliked && !i.isPermanentlyDeleted);
  if (!trashed.length) return;
  if (!confirm(`Permanently delete ${trashed.length} item${trashed.length!==1?'s':''}? They'll be hidden from your library but recoverable from Deleted Items.`)) return;
  syncLog(`deleteAllTrashed: marking ${trashed.length} items as permanently deleted`);
  _setSyncing(true);
  const deletedAt = new Date().toISOString();
  for (const item of trashed) {
    await db.items.update(item.id, { isPermanentlyDeleted: true, deletedAt });
    if (state.supabaseUrl && item.redditId) {
      try {
        await supabaseFetch(`/reddit_saves?reddit_id=eq.${item.redditId}`, 'PATCH', { deleted_at: deletedAt, is_disliked: true });
        state.syncStatus = 'connected';
      } catch(e) {
        syncLog(`deleteAllTrashed: failed for ${item.redditId} — ${e.message}`, 'error');
        await markDirty('deleteAllTrashed push failed');
      }
    }
  }
  _setSyncing(false);
  syncLog(`deleteAllTrashed: complete`, 'ok');
  if (state.supabaseUrl) await markClean();
  await loadData();
  render();
}

export async function trashAllDead() {
  const dead = state.items.filter(i => i.enrichStatus === 'dead' && !i.isDisliked);
  if (!dead.length) return;
  if (!confirm(`Move ${dead.length} unavailable item${dead.length!==1?'s':''} to trash?`)) return;
  syncLog(`trashAllDead: moving ${dead.length} items to trash`);
  _setSyncing(true);
  for (const item of dead) {
    await db.items.update(item.id, { isDisliked: true });
    if (state.supabaseUrl && item.redditId) {
      try {
        await supabaseFetch(`/reddit_saves?reddit_id=eq.${item.redditId}`, 'PATCH', { is_disliked: true });
        state.syncStatus = 'connected';
      } catch(e) {
        syncLog(`trashAllDead: push failed for ${item.redditId} — ${e.message}`, 'error');
        await markDirty('trashAllDead push failed');
      }
    }
  }
  _setSyncing(false);
  state.showDead = false;
  syncLog(`trashAllDead: complete`, 'ok');
  if (state.supabaseUrl) await markClean();
  await loadData();
  render();
}

export function setSort(by) {
  if (state.sortBy === by) {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sortBy = by;
    state.sortDir = (by === 'title' || by === 'subreddit') ? 'asc' : 'desc';
  }
  renderBrowseList();
  const sc = document.getElementById('sort-control');
  if (sc) sc.outerHTML = renderSortControl();
}

export function checkSavedAtClumps() {
  // Flat threshold — 100 items in one hour is never organic, always an import event.
  // Only runs once per session; result cached in state.savedAtClumpy.
  if (state.savedAtClumpy !== null) return;
  const hourBuckets = {};
  for (const item of state.items) {
    if (!item.savedAt) continue;
    const hour = item.savedAt.slice(0, 13);
    hourBuckets[hour] = (hourBuckets[hour] || 0) + 1;
  }
  state.savedAtClumpy = Object.values(hourBuckets).some(c => c >= 100);
}

export function setSortList(by) {
  if (state.sortBy === by) {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sortBy = by;
    state.sortDir = (by === 'title' || by === 'subreddit') ? 'asc' : 'desc';
  }
  render();
}

export async function commitSearch(query) {
  const q = query.trim();
  if (!q) return;
  state.recentSearches = [q, ...state.recentSearches.filter(s => s !== q)].slice(0, 20);
  await db.config.put({ key: 'recentSearches', value: state.recentSearches });
  await pushPreference('recentSearches', state.recentSearches);
}

export function toggleTagChip(listId) {
  listId = +listId;
  if (state.activeTagIds.includes(listId)) {
    state.activeTagIds = state.activeTagIds.filter(id => id !== listId);
  } else {
    state.activeTagIds = [...state.activeTagIds, listId];
    // Track last access for home screen recency sorting
    db.lists.update(listId, { lastAccessedAt: new Date().toISOString() });
    const list = state.lists.find(l => l.id === listId);
    if (list) list.lastAccessedAt = new Date().toISOString();
  }
  render();
}

export async function saveCurrentSearchAsList(existingListId) {
  const q = serialiseQueryWithTags(state.search.trim(), state.activeTagIds, state.tagMode);
  const hasActivity = q || state.activeTagIds.length > 0;
  if (!q && !hasActivity) return;
  const defaultName = existingListId
    ? (state.lists.find(l => l.id === existingListId)?.name || '')
    : (state.search.trim().length > 40 ? state.search.trim().slice(0, 40) + '…' : state.search.trim());
  const hasOpts = hasNonDefaultOptions();
  showModal(`
    <div class="modal-title">✦ Save as Smart List</div>
    <div class="form-group">
      <label>List name</label>
      <input class="input" id="list-name" value="${escHtml(defaultName)}" placeholder="My saved search" autofocus>
    </div>
    <div class="form-group">
      <label>Query</label>
      <input class="input" id="list-query" value="${escHtml(q)}" placeholder="search terms" style="font-size:13px">
      <span style="font-size:11px;color:var(--text-muted)">[#tag name] tokens represent active tag chips</span>
    </div>
    ${hasOpts ? `
    <div style="background:var(--surface);border:1px solid rgba(124,58,237,0.25);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--text-muted);line-height:1.5">
      <strong style="color:var(--text)">📌 Filters & sort will be saved with this list.</strong><br>
      They apply when you open the list directly. When this list is used as a <strong>#tag</strong> in another search, only the query above is used — filters and sort are ignored so compound searches stay predictable.
    </div>` : ''}
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
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
      ${existingListId ? `
        <button class="btn btn-secondary" onclick="doCreateList('smart')" style="flex:1;justify-content:center">Save as new</button>
        <button class="btn btn-primary" onclick="doSaveOverList(${existingListId})" style="flex:1;justify-content:center">Save over</button>
      ` : `
        <button class="btn btn-primary" onclick="doCreateList('smart')" style="flex:1;justify-content:center">Save</button>
      `}
    </div>
  `);
}

export async function removeRecentSearch(query) {
  state.recentSearches = state.recentSearches.filter(s => s !== query);
  await db.config.put({ key: 'recentSearches', value: state.recentSearches });
  await pushPreference('recentSearches', state.recentSearches);
  render();
}

export function applySearch(query) {
  state.search = query;
  state.searchFocused = false;
  if (query.trim()) commitSearch(query);
  render();
}

// Renders the recents row in-place (no full re-render needed)
// Search string lookup — avoids embedding quoted strings in HTML attributes
// Populated before each render, referenced by index from onclick handlers
export function runSavedSearch(i) {
  applySearch(_searchLookup[i] || '');
}
export function removeSavedSearchByIndex(i) {
  removeRecentSearch(_searchLookup[i] || '');
}

// ─── SEARCH DEBOUNCE ─────────────────────────────────────────────────────────
export function hasActiveFilters() {
  return state.filterType !== 'all' || state.filterRating > 0 || state.filterHasLinks ||
    state.filterFavourite || state.filterDateFrom || state.filterDateTo ||
    state.filterSubreddit.trim() || state.filterAuthor.trim() || state.searchBody;
}

export function clearFilters() {
  state.filterType = 'all';
  state.filterRating = 0;
  state.filterHasLinks = false;
  state.filterFavourite = false;
  state.filterDateFrom = '';
  state.filterDateTo = '';
  state.filterSubreddit = '';
  state.filterAuthor = '';
  state.searchBody = false;
  render();
}

// Resets all search state to a clean slate, then navigates to Browse.
// Used by "See all" on the home screen and the "New Search" button in Browse.
export function newSearch(opts = {}) {
  state.search = '';
  state.activeTagIds = [];
  state.tagMode = 'AND';
  state.editingListId = null;
  state.showFilters = false;
  state.filterType = 'all';
  state.filterRating = 0;
  state.filterHasLinks = false;
  state.filterFavourite = false;
  state.filterDateFrom = '';
  state.filterDateTo = '';
  state.filterSubreddit = '';
  state.filterAuthor = '';
  state.searchBody = false;
  state.sortBy = opts.sortBy || 'postCreatedAt';
  state.sortDir = opts.sortDir || 'desc';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  showPage('browse');
}

export function setFilter(type, value) {
  if (type === 'dead') state.showDead = !state.showDead;
  if (type === 'favourite') state.filterFavourite = !state.filterFavourite;
  render();
}

export async function doCreateList(type) {
  const name = document.getElementById('list-name')?.value?.trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }
  const query = type === 'smart' ? (document.getElementById('list-query')?.value?.trim() || '') : '';
  const isTag = document.getElementById('list-is-tag')?.checked || false;
  const tagName = document.getElementById('list-tag-name')?.value?.trim() || '';
  if (isTag && tagName && !validateTagName(tagName)) {
    showToast('Tag name can only contain letters, numbers, spaces, & and /  — no special characters', 'error');
    return;
  }
  // Deduplication
  const nameLower = name.toLowerCase();
  const tagNameLower = tagName.toLowerCase();
  const conflict = state.lists.find(l =>
    l.name.toLowerCase() === nameLower ||
    (tagName && (l.tagName || '').toLowerCase() === tagNameLower) ||
    (tagName && l.name.toLowerCase() === tagNameLower)
  );
  if (conflict) {
    showToast(`A list or tag named "${conflict.name}" already exists`, 'error');
    return;
  }
  closeModal();
  const optionsJson = type === 'smart' ? serialiseListOptions() : null;
  const id = await db.lists.add({ name, type, query, isTag, tagName, optionsJson, createdAt: new Date().toISOString() });
  await loadData();
  if (type === 'smart') rebuildTagCache(id);
  await markDirty(`list created: "${name}"`);
  await pushListsToSupabase();
  state.editingListId = null;
  state.search = '';
  state.activeTagIds = [];
  state.sortBy = 'postCreatedAt';
  state.sortDir = 'desc';
  state.listView = id;
  showPage('lists');
  showToast(`List "${name}" created`, 'success');
}

export function runListSearch(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  // Decode [#name] tokens back to active tag chips where possible
  const { tags, remainder } = extractTagTokens(list.query || '');
  const resolvedTagIds = [];
  for (const name of tags) {
    const tag = state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === name);
    if (tag) resolvedTagIds.push(tag.id);
  }
  state.search = remainder;
  state.activeTagIds = resolvedTagIds;
  state.editingListId = listId;
  // Restore saved filters/sort — only applies when opening directly, not during tag matching
  applyListOptions(list.optionsJson || null);
  showPage('browse');
  document.getElementById('search-input') && (document.getElementById('search-input').value = remainder);
  renderBrowseList();
}

export async function doSaveOverList(id) {
  const name = document.getElementById('list-name')?.value?.trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }
  const query = document.getElementById('list-query')?.value?.trim() || '';
  const isTag = document.getElementById('list-is-tag')?.checked || false;
  const tagName = document.getElementById('list-tag-name')?.value?.trim() || '';
  if (isTag && tagName && !validateTagName(tagName)) {
    showToast('Tag name can only contain letters, numbers, spaces, & and /  — no special characters', 'error');
    return;
  }
  // Deduplication — allow same name as self
  const nameLower = name.toLowerCase();
  const conflict = state.lists.find(l => l.id !== id && l.name.toLowerCase() === nameLower);
  if (conflict) {
    showToast(`A list named "${conflict.name}" already exists`, 'error');
    return;
  }
  if (isTag && tagName && !validateTagName(tagName)) {
    showToast('Tag name can only contain letters, numbers, spaces, & and /  — no special characters', 'error');
    return;
  }
  closeModal();
  const optionsJson = serialiseListOptions();
  await db.lists.update(id, { name, query, isTag, tagName, optionsJson });
  await loadData();
  rebuildTagCache(id);
  await markDirty(`list updated: "${name}"`);
  await pushListsToSupabase();
  state.editingListId = null;
  state.search = '';
  state.activeTagIds = [];
  state.sortBy = 'postCreatedAt';
  state.sortDir = 'desc';
  state.listView = id;
  showPage('lists');
  showToast(`List "${name}" updated`, 'success');
}

export async function deleteList(id) {
  const list = state.lists.find(l => l.id === id);
  await db.lists.delete(id);
  await db.item_lists.where('listId').equals(id).delete();
  if (state.listView === id) state.listView = 'all';
  // Remove from active tag chips if it was one
  state.activeTagIds = state.activeTagIds.filter(tid => tid !== id);
  await loadData();
  await markDirty(`list deleted: "${list?.name}"`);
  if (list) await deleteListFromSupabase(list.name);
  render();
}

export async function doEditList(id) {
  const name = document.getElementById('edit-list-name')?.value?.trim();
  if (!name) { showToast('Name required', 'error'); return; }
  const isTagEl = document.getElementById('edit-list-is-tag');
  const tagNameEl = document.getElementById('edit-list-tag-name');
  const updates = { name };
  if (isTagEl) updates.isTag = isTagEl.checked;
  if (tagNameEl) updates.tagName = tagNameEl.value.trim();

  // Tag name validation
  if (updates.isTag && updates.tagName && !validateTagName(updates.tagName)) {
    showToast('Tag name can only contain letters, numbers, spaces, & and /  — no special characters', 'error');
    return;
  }

  // Deduplication — check name not taken by another list
  const nameLower = name.toLowerCase();
  const conflict = state.lists.find(l => l.id !== id && (l.name.toLowerCase() === nameLower || (l.tagName || '').toLowerCase() === nameLower));
  if (conflict) {
    showToast(`A list named "${conflict.name}" already exists`, 'error');
    return;
  }

  await db.lists.update(id, updates);
  closeModal();
  await loadData();
  await markDirty(`list edited: "${name}"`);
  await pushListsToSupabase();
  render();
}

export async function toggleItemList(itemId, listId) {
  const existing = state.itemLists.find(il => il.itemId === itemId && il.listId === listId);
  if (existing) {
    await db.item_lists.delete(existing.id);
  } else {
    await db.item_lists.add({ itemId, listId });
  }
  await loadData();
  await markDirty('item list membership changed');
  // Sync to Supabase
  try { await pushListsToSupabase(); } catch(e) {}
  const inListIds = new Set(state.itemLists.filter(il => il.itemId === itemId).map(il => il.listId));
  const btn = document.getElementById(`lmbtn-${listId}`);
  if (btn) {
    const isNowIn = inListIds.has(listId);
    btn.className = `btn ${isNowIn ? 'btn-primary' : 'btn-secondary'}`;
    btn.querySelector('span:last-child').textContent = isNowIn ? '✓' : '+';
  }
  // Refresh the 📋 button on visible cards without full re-render
  renderBrowseList();
}



// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
