// dataio.js — part of RedditVault (auto-split from the original single-file PWA).
import { markClean, pushToSupabase, supabaseFetch } from './cloud.js';
import { loadConfig, loadData, markDirty } from './core.js';
import { render } from './render.js';
import { db, state } from './state.js';
import { fmtDate, showToast } from './util.js';

export async function repairSavedAtDates() {
  // Detect "import clumps" — groups of items where many share the same savedAt
  // hour, which indicates a bulk CSV import where we used new Date() as a
  // synthetic timestamp.  For those items, replace savedAt with postCreatedAt
  // as a better (if imperfect) approximation of when they were actually saved.

  const allItems = await db.items.toArray();
  const total = allItems.length;
  if (!total) { showToast('No items found', 'warning'); return; }

  // Group by truncated-to-hour savedAt
  const hourBuckets = {};
  for (const item of allItems) {
    if (!item.savedAt) continue;
    const hour = item.savedAt.slice(0, 13); // "2024-03-15T14"
    hourBuckets[hour] = (hourBuckets[hour] || 0) + 1;
  }

  // A clump is any hour bucket that contains ≥5% of the library OR ≥50 items
  const clumpThreshold = Math.max(50, Math.floor(total * 0.05));
  const clumpHours = new Set(
    Object.entries(hourBuckets)
      .filter(([, count]) => count >= clumpThreshold)
      .map(([hour]) => hour)
  );

  if (clumpHours.size === 0) {
    showToast('No import clumps detected — savedAt looks healthy', 'success');
    return;
  }

  // Count affected items (only patch if postCreatedAt is available)
  const affected = allItems.filter(i =>
    i.savedAt && clumpHours.has(i.savedAt.slice(0, 13)) && i.postCreatedAt
  );
  const noPostDate = allItems.filter(i =>
    i.savedAt && clumpHours.has(i.savedAt.slice(0, 13)) && !i.postCreatedAt
  );

  const clumpSummary = [...clumpHours]
    .sort()
    .map(h => `${h}:xx (${hourBuckets[h]} items)`)
    .join(', ');

  const confirmed = confirm(
    `Found ${clumpHours.size} import clump${clumpHours.size > 1 ? 's' : ''}:\n${clumpSummary}\n\n` +
    `${affected.length} items will have savedAt replaced with their post creation date.\n` +
    (noPostDate.length ? `${noPostDate.length} items have no post date and will be skipped.\n\n` : '\n') +
    `This is irreversible. Continue?`
  );
  if (!confirmed) return;

  showToast('Patching savedAt…', 'info');
  let patched = 0;
  for (const item of affected) {
    await db.items.update(item.id, { savedAt: item.postCreatedAt });
    patched++;
  }

  await markDirty(`repairSavedAtDates: patched ${patched} items`);

  // Push patched items to Supabase so cloud stays in sync
  if (state.supabaseUrl && state.supabaseKey) {
    showToast('Syncing patched dates to cloud…', 'info');
    const patched_items = await db.items.toArray();
    const toSync = patched_items.filter(i =>
      i.savedAt && affected.some(a => a.id === i.id)
    );
    for (let i = 0; i < toSync.length; i += 200) {
      await pushToSupabase(toSync.slice(i, i + 200));
    }
  }

  state.savedAtClumpy = null; // force re-check on next loadData
  await loadData();
  render();
  showToast(`Patched ${patched} item${patched !== 1 ? 's' : ''} — savedAt now reflects post creation date`, 'success');
}

export async function repairCommentTitles() {
  // Find all comments whose title is the feed fallback placeholder
  // "Comment in r/subreddit" — reset them to pending so the Reddit
  // enricher fetches the real parent post title on next enrichment run.
  const allItems = await db.items.toArray();
  const affected = allItems.filter(i =>
    i.type === 'comment' &&
    (i.title || '').match(/^Comment in r\//)
  );

  if (!affected.length) {
    showToast('No placeholder comment titles found', 'success');
    return;
  }

  const confirmed = confirm(
    `Found ${affected.length} comment${affected.length !== 1 ? 's' : ''} with placeholder titles (e.g. "Comment in r/...").\n\n` +
    `These will be reset to pending so the next enrichment run fetches their real parent post titles.\n\nContinue?`
  );
  if (!confirmed) return;

  for (const item of affected) {
    await db.items.update(item.id, {
      enriched: false,
      enrichStatus: 'pending',
      enrichAttempts: 0,
    });
  }

  await markDirty(`repairCommentTitles: reset ${affected.length} items`);
  await loadData();
  render();
  showToast(`${affected.length} comment${affected.length !== 1 ? 's' : ''} queued for re-enrichment`, 'success');
}

export async function repairCSVDuplicates() {
  const allItems = await db.items.toArray();

  // Diagnostic — show what ID formats we actually have
  const prefixed = allItems.filter(i => /^t[13]_/.test(i.redditId || ''));
  const bare     = allItems.filter(i => !/^t[13]_/.test(i.redditId || '') && i.redditId);
  const enrichedAsComment = allItems.filter(i =>
    i.type === 'comment' &&
    (i.permalink || i.url || '').replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean).length <= 5
  );

  console.log(`Total: ${allItems.length} | Prefixed IDs: ${prefixed.length} | Bare IDs: ${bare.length} | Posts stored as comments: ${enrichedAsComment.length}`);
  if (bare.length > 0) console.log('Sample bare IDs:', bare.slice(0,3).map(i => i.redditId));
  if (enrichedAsComment.length > 0) console.log('Sample mistyped:', enrichedAsComment.slice(0,3).map(i => ({id: i.redditId, permalink: i.permalink})));

  showToast(
    `Found: ${prefixed.length} prefixed IDs, ${bare.length} bare IDs, ${enrichedAsComment.length} posts stored as comments — check console for details`,
    bare.length > 0 || enrichedAsComment.length > 0 ? 'warning' : 'success'
  );

  if (bare.length === 0 && enrichedAsComment.length === 0) return;

  // CSV items have bare IDs (abc123); extension items have prefixed IDs (t3_abc123).
  let merged = 0, renumbered = 0, markedForReenrich = 0;

  // Build a map of bare-id -> prefixed item (extension version)
  const prefixedById = {};
  for (const item of allItems) {
    const id = item.redditId || '';
    if (id.startsWith('t3_') || id.startsWith('t1_')) {
      prefixedById[id.replace(/^t[13]_/, '')] = item;
    }
  }

  for (const item of allItems) {
    const id = item.redditId || '';
    if (id.startsWith('t3_') || id.startsWith('t1_')) continue; // already prefixed

    const bareId = id;
    const prefixedItem = prefixedById[bareId];

    if (prefixedItem) {
      // Duplicate — a prefixed version exists from the extension.
      // Preserve favourite/rating from CSV item if the prefixed one lacks them,
      // then delete the bare-ID duplicate.
      const updates = {};
      if (!prefixedItem.isFavourite && item.isFavourite) updates.isFavourite = item.isFavourite;
      // rating 0 (thumbs-down) is a real value — only fill a genuinely unrated slot
      if (prefixedItem.rating == null && item.rating != null) updates.rating = item.rating;
      if (Object.keys(updates).length) await db.items.update(prefixedItem.id, updates);
      await db.items.delete(item.id);
      // Also delete from Supabase
      if (state.supabaseUrl) {
        try { await supabaseFetch('/reddit_saves?reddit_id=eq.' + bareId, 'DELETE', null); } catch(e) {}
      }
      merged++;
    } else {
      // No duplicate — just needs its ID normalised and re-enrichment triggered
      const permalink = item.permalink || item.url || '';
      const permalinkPath = permalink.replace(/^https?:\/\/[^\/]+/, '');
      const isComment = permalinkPath.split('/').filter(Boolean).length > 5;
      const newId = (isComment ? 't1_' : 't3_') + bareId;

      await db.items.update(item.id, {
        redditId: newId,
        enriched: false,
        enrichStatus: 'pending',
        enrichAttempts: 0,
      });
      // Update Supabase — delete old bare-id row, the next push will create the correct one
      if (state.supabaseUrl) {
        try { await supabaseFetch('/reddit_saves?reddit_id=eq.' + bareId, 'DELETE', null); } catch(e) {}
      }
      renumbered++;
      markedForReenrich++;
    }
  }

  await loadData();
  const msg = [
    merged > 0 ? `${merged} duplicate${merged!==1?'s':''} merged` : '',
    renumbered > 0 ? `${renumbered} ID${renumbered!==1?'s':''} normalised` : '',
    markedForReenrich > 0 ? `${markedForReenrich} queued for re-enrichment` : '',
  ].filter(Boolean).join(', ');

  showToast(msg || 'Nothing to repair', merged + renumbered > 0 ? 'success' : 'warning');
  render();

  // Push corrected items to Supabase
  if ((merged + renumbered) > 0 && state.supabaseUrl) {
    showToast('Syncing repairs to cloud…', 'info');
    const fixed = await db.items.toArray();
    for (let i = 0; i < fixed.length; i += 200) await pushToSupabase(fixed.slice(i, i + 200));
    showToast('✓ Repairs synced to cloud', 'success');
  }
}

export async function repairItemTypes() {
  // Items imported from CSV before the fix have wrong types because the detection
  // logic didn't strip the domain from full URLs before counting path segments.
  // Re-evaluate every item's type from its stored permalink.
  const allItems = await db.items.toArray();
  let fixed = 0;

  for (const item of allItems) {
    const permalink = item.permalink || item.url || '';
    if (!permalink) continue;

    const path = permalink.replace(/^https?:\/\/[^\/]+/, '');
    const parts = path.split('/').filter(Boolean);
    const correctType = parts.length > 5 ? 'comment' : 'post';

    if (item.type !== correctType) {
      await db.items.update(item.id, { type: correctType });
      fixed++;
    }
  }

  await loadData();
  showToast(`Repaired ${fixed} item type${fixed !== 1 ? 's' : ''} ✓`, fixed > 0 ? 'success' : 'warning');
  render();
  // Push repaired types to Supabase so other devices get the fix
  if (fixed > 0 && state.supabaseUrl) {
    showToast('Syncing repairs to cloud…', 'info');
    const allItems = await db.items.toArray();
    for (let i = 0; i < allItems.length; i += 200) {
      await pushToSupabase(allItems.slice(i, i + 200));
    }
    showToast('✓ Repairs synced to cloud', 'success');
  }
}
export async function handleCSVImport(file) {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const rows = results.data;
        let added = 0, dupes = 0;

        for (const row of rows) {
          // Reddit's data export CSV has these columns:
          // id, permalink, url, title, body, created_utc, subreddit, type
          // However the "saved items" export often only has: id, permalink, url
          const rawId = (row.id || '').trim();
          if (!rawId) continue;

          // Detect type first so we can normalise the ID with the correct prefix
          const permalink = row.permalink || '';
          const permalinkPath = permalink.replace(/^https?:\/\/[^\/]+/, '');
          const isComment = permalinkPath.split('/').filter(Boolean).length > 5;

          // Normalise to Reddit fullname format (t1_ = comment, t3_ = post).
          // CSV exports give bare IDs; the extension gives prefixed ones.
          // Consistent storage prevents duplicates when both sources have same item.
          const prefix = isComment ? 't1_' : 't3_';
          const redditId = (rawId.startsWith('t1_') || rawId.startsWith('t3_'))
            ? rawId
            : prefix + rawId;

          // Check for existing item under either the normalised OR bare ID
          const exists = await db.items.where('redditId').equals(redditId).first()
            || await db.items.where('redditId').equals(rawId).first();
          if (exists) { dupes++; continue; }

          // Determine if we have enough data already or need enrichment
          const hasTitle = !!(row.title && row.title.trim());
          const hasSubreddit = !!(row.subreddit && row.subreddit.trim());
          const hasEnoughData = hasTitle && hasSubreddit;

          // Extract subreddit from permalink if not in CSV: /r/SUBREDDIT/...
          let subreddit = row.subreddit || '';
          if (!subreddit && permalink) {
            const parts = permalink.split('/').filter(Boolean);
            if (parts[0] === 'r' && parts[1]) subreddit = parts[1];
          }

          // Build permalink as full URL
          const fullPermalink = permalink.startsWith('http')
            ? permalink
            : `https://www.reddit.com${permalink}`;

          // For the display URL: use provided url, or fall back to permalink
          const url = row.url || fullPermalink;

          // Parse created_utc if available (it's a Unix timestamp)
          const postCreatedAt = row.created_utc && !isNaN(parseInt(row.created_utc))
            ? new Date(parseInt(row.created_utc) * 1000).toISOString()
            : null;

          await db.items.add({
            redditId,
            type: isComment ? 'comment' : 'post',
            subreddit,
            title: row.title || '',
            url,
            permalink: fullPermalink,
            body: row.body || '',
            author: row.author || '',
            score: null,
            savedAt: new Date().toISOString(), // CSV doesn't include save time
            postCreatedAt,
            enriched: hasEnoughData,
            enrichStatus: hasEnoughData ? 'enriched' : 'pending',
            syncedAt: null
          });
          added++;
        }

        await loadData();

        // Push new items to Supabase if configured. pushToSupabase stamps
        // syncedAt on success (a where('syncedAt').equals(null) pass would
        // throw — IndexedDB can't index null keys). Batched: CSV imports can
        // be thousands of rows.
        if (state.supabaseUrl) {
          const newItems = state.items.filter(i => !i.syncedAt);
          for (let i = 0; i < newItems.length; i += 200) {
            await pushToSupabase(newItems.slice(i, i + 200), true);
          }
          if (newItems.length > 0) await markClean();
        }

        resolve({ added, dupes, total: rows.length });
      }
    });
  });
}

export async function restoreFromBackup(data) {
  // Validate it looks like a real backup
  if (!data.items || !Array.isArray(data.items)) {
    throw new Error('Invalid backup file — no items array found');
  }

  const exportedAt = data.exportedAt ? fmtDate(data.exportedAt) : 'unknown date';
  const itemCount = data.items.length;
  const listCount = (data.lists || []).length;

  if (!confirm(`Restore backup from ${exportedAt}?\n\nThis will replace ALL local data with:\n• ${itemCount.toLocaleString()} items\n• ${listCount} lists\n\nThis cannot be undone.`)) {
    return null; // user cancelled
  }

  // Wipe everything
  await db.items.clear();
  await db.lists.clear();
  await db.item_lists.clear();
  await db.folders.clear();

  // Restore items — strip local auto-increment id so IndexedDB assigns fresh ones
  let itemsAdded = 0;
  const redditIdToLocalId = new Map();
  for (const item of data.items) {
    if (!item.redditId) continue;
    const { id: _id, ...itemWithoutId } = item;
    const newId = await db.items.add({
      ...itemWithoutId,
      postCreatedAt: item.postCreatedAt || null,
      enriched: item.enriched ?? !!(item.title && item.subreddit),
      enrichStatus: item.enrichStatus || (item.title && item.subreddit ? 'enriched' : 'pending'),
      permalink: item.permalink || item.url || '',
      author: item.author || '',
      score: item.score ?? null,
    });
    redditIdToLocalId.set(item.redditId, newId);
    itemsAdded++;
  }

  // Restore lists — strip local id, track old->new id mapping
  const oldToNewListId = new Map();
  for (const list of (data.lists || [])) {
    const { id: oldId, ...listWithoutId } = list;
    const newId = await db.lists.add(listWithoutId);
    if (oldId != null) oldToNewListId.set(oldId, newId);
  }

  // Restore item_lists — remap both listId and itemId to new local IDs
  for (const il of (data.itemLists || [])) {
    const item = data.items.find(i => {
      // item_lists reference by itemId (old local id) — find matching item by old id
      return i.id === il.itemId;
    });
    const newItemId = item ? redditIdToLocalId.get(item.redditId) : null;
    const newListId = oldToNewListId.get(il.listId);
    if (newItemId && newListId) {
      await db.item_lists.add({ itemId: newItemId, listId: newListId });
    }
  }

  await loadData();

  // Restore config if present (newer backups only — old backups won't have this key)
  if (data.config && typeof data.config === 'object') {
    for (const [key, value] of Object.entries(data.config)) {
      await db.config.put({ key, value });
    }
    // Reload state so restored settings take effect immediately
    await loadConfig();
  }

  return { added: itemsAdded, lists: (data.lists || []).length };
}

// ─── ITEMS ───────────────────────────────────────────────────────────────────
export async function deleteItem(itemId) {
  await db.items.delete(itemId);
  await loadData();
  render();
  showToast('Item removed', 'success');
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────
export async function exportJSON() {
  const items = await db.items.toArray();
  const lists = await db.lists.toArray();
  const itemLists = await db.item_lists.toArray();

  // Persist all meaningful config keys — skip transient sync state
  const CONFIG_KEYS = [
    'supabaseUrl', 'supabaseKey',
    'redditFeedUrl', 'redditUsername', 'scoreRefreshLimit', 'feedProxyUrl', 'feedProxyType', 'feedFormat',
    'enrichReqPerMin', 'enrichRetryReqPerMin', 'enrichRateLimitPause', 'enrichMaxAttempts',
    'confirmDestructive', 'disableZoom', 'autoFeedSync', 'autoFeedSyncInterval',
    'recentSearches',
  ];
  const configRows = await db.config.where('key').anyOf(CONFIG_KEYS).toArray();
  const config = Object.fromEntries(configRows.map(r => [r.key, r.value]));

  const data = JSON.stringify({ items, lists, itemLists, config, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reddivault-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded ✓', 'success');
}

// ─── RENDER ──────────────────────────────────────────────────────────────────
export async function handleFileImport(file) {
  // JSON files are always treated as backups to restore — never merge
  if (file.name.endsWith('.json')) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await restoreFromBackup(data);
      if (result === null) return; // user cancelled confirm dialog
      showToast(`✓ Restored ${result.added.toLocaleString()} items and ${result.lists} lists`, 'success');
      setTimeout(() => render(), 500);
    } catch(e) {
      showToast('Restore failed: ' + e.message, 'error');
    }
    return;
  }

  // CSV files — Reddit export import
  const progress = document.getElementById('import-progress');
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  if (progress) progress.style.display = 'block';
  if (fill) fill.style.width = '30%';
  if (label) label.textContent = 'Reading file...';

  try {
    if (fill) fill.style.width = '60%';
    if (label) label.textContent = 'Importing...';
    const result = await handleCSVImport(file);
    if (fill) fill.style.width = '100%';
    const needsEnrich = state.items.filter(i => !i.enriched).length;
    if (label) label.textContent = `Done! Added ${result.added} items (${result.dupes} duplicates skipped)${needsEnrich > 0 ? `. ${needsEnrich} items need enrichment.` : ''}`;
    showToast(`✓ Imported ${result.added} new items`, 'success');
    setTimeout(() => render(), 1000);
  } catch(e) {
    if (label) label.textContent = 'Error: ' + e.message;
    showToast('Import failed: ' + e.message, 'error');
  }
}

