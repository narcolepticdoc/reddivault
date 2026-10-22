// enrich.js — part of RedditVault (auto-split from the original single-file PWA).
import { pushToSupabase } from './cloud.js';
import { loadData } from './core.js';
import { render } from './render.js';
import { db, state, syncLog } from './state.js';
import { showToast, sleep } from './util.js';

// Enrichment fills in titles, bodies, authors and scores for items that arrive
// with ids only (mainly Reddit data-export CSV imports). Two sources, neither
// needing an API key:
//   1. Arctic Shift (below) — a public archive, thousands of ids in seconds.
//   2. Your own Reddit login — the bookmarklet's "Refresh scores & details"
//      (on old.reddit.com) or the userscript's daily refresh sends full details
//      for pending items through the inbox (op 'meta', applied by
//      applyMetaUpdates in bookmarklet.js).
// The old per-item fetch of reddit.com/<permalink>.json from the app was
// removed: Reddit has refused unauthenticated .json requests since May 28, 2026.

export let enrichStopped = false;

// ─── ARCTIC SHIFT BULK ENRICHMENT ────────────────────────────────────────────
// Arctic Shift is a public Reddit archive with an ID-lookup API that accepts
// up to 500 IDs per request — no auth, no rate-limiting for normal usage.
// We use this as the fast first pass; whatever it misses is left pending for
// the session-based refresh (bookmarklet/userscript "Refresh scores & details").
//
// API: https://arctic-shift.photon-reddit.com
//   GET /api/posts/ids?ids=t3_abc,t3_def&fields=...
//   GET /api/comments/ids?ids=t1_abc,t1_def&fields=...
//
// Coverage: a community archive with no SLA that lags Reddit by weeks, so very
// recent or obscure items may be missing. Items captured by the bookmarklet or
// userscript arrive with full details already, so this mainly serves CSV imports.

export const ARCTIC_BASE           = 'https://arctic-shift.photon-reddit.com';
export const ARCTIC_BATCH          = 500;
export const ARCTIC_POST_FIELDS    = 'id,title,author,subreddit,selftext,url,score,created_utc';
export const ARCTIC_COMMENT_FIELDS = 'id,body,author,subreddit,score,created_utc,link_id';

export function arcticPostToEnriched(post, item) {
  const enriched = {
    type: 'post',
    title:          post.title || item.title || 'Untitled Post',
    author:         post.author || item.author || '',
    subreddit:      post.subreddit || item.subreddit || '',
    body:           post.selftext || item.body || '',
    score:          post.score ?? item.score ?? null,
    postCreatedAt:  post.created_utc ? new Date(post.created_utc * 1000).toISOString() : item.postCreatedAt || null,
    enriched:       true,
    enrichAttempts: (item.enrichAttempts || 0) + 1,
  };
  // Arctic Shift doesn't return permalink — build it from subreddit + id
  if (post.subreddit && post.id) {
    enriched.permalink = `https://reddit.com/r/${post.subreddit}/comments/${post.id}/`;
  }
  if (post.url && !post.url.includes('reddit.com/r/')) enriched.url = post.url;
  return enriched;
}

export function arcticCommentToEnriched(comment, item) {
  // link_id is t3_postid — strip prefix to get post id for permalink
  const postId = (comment.link_id || '').replace(/^t3_/, '');
  return {
    type:           'comment',
    title:          item.title || 'Saved Comment',
    author:         comment.author || item.author || '',
    subreddit:      comment.subreddit || item.subreddit || '',
    body:           comment.body || item.body || '',
    score:          comment.score ?? item.score ?? null,
    postCreatedAt:  comment.created_utc ? new Date(comment.created_utc * 1000).toISOString() : item.postCreatedAt || null,
    // Build best available permalink: /r/sub/comments/postId/_/commentId
    permalink:      (comment.subreddit && postId && comment.id)
      ? `https://reddit.com/r/${comment.subreddit}/comments/${postId}/_/${comment.id}/`
      : item.permalink || '',
    enriched:       true,
    enrichAttempts: (item.enrichAttempts || 0) + 1,
  };
}

export async function arcticFetchPostBatch(items) {
  // Arctic Shift expects bare base36 IDs (no t3_ prefix)
  const ids = items.map(i => (i.redditId || '').replace(/^t3_/, '')).join(',');
  const url = `${ARCTIC_BASE}/api/posts/ids?ids=${ids}&fields=${ARCTIC_POST_FIELDS}`;
  syncLog(`arctic: POST batch — ${items.length} ids, first: ${items[0]?.redditId}, sample url: ${url.slice(0, 120)}`);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      syncLog(`arctic: POST batch HTTP ${res.status} — ${body.slice(0, 200)}`, 'error');
      return new Map();
    }
    const json = await res.json();
    syncLog(`arctic: POST batch raw response keys: ${Object.keys(json).join(', ')} | data length: ${Array.isArray(json.data) ? json.data.length : Array.isArray(json) ? json.length : 'not array'}`);
    const posts = json.data || json;
    const map = new Map();
    if (!Array.isArray(posts)) {
      syncLog(`arctic: POST batch — response is not an array, got: ${JSON.stringify(json).slice(0, 200)}`, 'warn');
      return map;
    }
    for (const post of posts) {
      const bareId = post.id || (post.name || '').replace(/^t3_/, '');
      if (!bareId) continue;
      const item = items.find(i => (i.redditId || '').replace(/^t3_/, '') === bareId);
      if (item) map.set(item.id, arcticPostToEnriched(post, item));
    }
    syncLog(`arctic: POST batch — ${posts.length} returned, ${map.size} matched`);
    return map;
  } catch (e) {
    syncLog(`arctic: POST batch fetch failed — ${e.message}`, 'error');
    return new Map();
  }
}

export async function arcticFetchCommentBatch(items) {
  // Arctic Shift expects bare base36 IDs (no t1_ prefix)
  const ids = items.map(i => (i.redditId || '').replace(/^t1_/, '')).join(',');
  const url = `${ARCTIC_BASE}/api/comments/ids?ids=${ids}&fields=${ARCTIC_COMMENT_FIELDS}`;
  syncLog(`arctic: COMMENT batch — ${items.length} ids, first: ${items[0]?.redditId}, sample url: ${url.slice(0, 120)}`);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      syncLog(`arctic: COMMENT batch HTTP ${res.status} — ${body.slice(0, 200)}`, 'error');
      return new Map();
    }
    const json = await res.json();
    syncLog(`arctic: COMMENT batch raw response keys: ${Object.keys(json).join(', ')} | data length: ${Array.isArray(json.data) ? json.data.length : Array.isArray(json) ? json.length : 'not array'}`);
    const comments = json.data || json;
    const map = new Map();
    if (!Array.isArray(comments)) {
      syncLog(`arctic: COMMENT batch — response is not an array, got: ${JSON.stringify(json).slice(0, 200)}`, 'warn');
      return map;
    }
    for (const comment of comments) {
      const bareId = comment.id || (comment.name || '').replace(/^t1_/, '');
      if (!bareId) continue;
      const item = items.find(i => (i.redditId || '').replace(/^t1_/, '') === bareId);
      if (item) map.set(item.id, arcticCommentToEnriched(comment, item));
    }
    syncLog(`arctic: COMMENT batch — ${comments.length} returned, ${map.size} matched`);
    return map;
  } catch (e) {
    syncLog(`arctic: COMMENT batch fetch failed — ${e.message}`, 'error');
    return new Map();
  }
}

// Runs the Arctic Shift bulk pass. Returns items it couldn't resolve
// (to be handed to the Reddit per-item fallback enricher).
export async function enrichViaArcticShift(toEnrich, onProgress) {
  const posts    = toEnrich.filter(i => i.type === 'post'    || (i.redditId || '').startsWith('t3_'));
  const comments = toEnrich.filter(i => i.type === 'comment' || (i.redditId || '').startsWith('t1_'));
  const unknown  = toEnrich.filter(i => !posts.includes(i) && !comments.includes(i));

  syncLog(`arctic: starting — ${toEnrich.length} total (${posts.length} posts, ${comments.length} comments, ${unknown.length} unknown)`);

  const allBatches = [];
  for (let i = 0; i < posts.length;    i += ARCTIC_BATCH) allBatches.push({ type: 'post',    items: posts.slice(i, i + ARCTIC_BATCH) });
  for (let i = 0; i < comments.length; i += ARCTIC_BATCH) allBatches.push({ type: 'comment', items: comments.slice(i, i + ARCTIC_BATCH) });

  syncLog(`arctic: ${allBatches.length} batch${allBatches.length !== 1 ? 'es' : ''} to process`);

  let arcticDone = 0, arcticEnriched = 0;
  const failed = [...unknown];

  for (const batch of allBatches) {
    if (enrichStopped) break;
    const resultMap = batch.type === 'post'
      ? await arcticFetchPostBatch(batch.items)
      : await arcticFetchCommentBatch(batch.items);

    for (const item of batch.items) {
      const update = resultMap.get(item.id);
      if (update) {
        await db.items.update(item.id, { ...update, enrichStatus: 'enriched' });
        arcticEnriched++;
      } else {
        failed.push(item);
      }
    }
    arcticDone += batch.items.length;
    onProgress(arcticDone, toEnrich.length, arcticEnriched);
    await sleep(500); // polite delay — Arctic Shift is a community resource
  }

  syncLog(`arctic: complete — ${arcticEnriched} enriched, ${failed.length} not in the archive (left pending for the session refresh)`, arcticEnriched > 0 ? 'ok' : 'warn');
  return failed;
}

export async function enrichViaArcticShiftOnly() {
  if (state.enriching) return;
  enrichStopped = false;

  const allItems = await db.items.toArray();
  const toEnrich = allItems.filter(i => i.enrichStatus === 'pending');

  if (toEnrich.length === 0) {
    showToast('Nothing to enrich ✓', 'success');
    return;
  }

  state.enriching = true;
  state.enrichProgress = { phase: 'arctic', done: 0, total: toEnrich.length, enriched: 0, failed: 0, rateLimitHits: 0 };
  render();

  let arcticEnriched = 0;
  const onProgress = (done, total, enriched) => {
    arcticEnriched = enriched;
    state.enrichProgress = { phase: 'arctic', done, total, enriched, failed: 0, rateLimitHits: 0 };
    const el = document.getElementById('enrich-progress-details');
    if (!el) return;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:var(--accent2);margin-bottom:6px;letter-spacing:0.03em">
        ⚡ Arctic Shift bulk lookup
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
        ${done.toLocaleString()} / ${total.toLocaleString()} checked &nbsp;·&nbsp; ${enriched.toLocaleString()} enriched
      </div>
    `;
  };

  onProgress(0, toEnrich.length, 0);
  const missed = await enrichViaArcticShift(toEnrich, onProgress);

  state.enriching = false;
  state.enrichProgress = { done: 0, total: 0, enriched: 0, failed: 0, rateLimitHits: 0 };
  await loadData();

  if (state.supabaseUrl && arcticEnriched > 0) {
    const enrichedItems = await db.items.filter(i => i.enriched && i.title).toArray();
    for (let i = 0; i < enrichedItems.length; i += 200) {
      await pushToSupabase(enrichedItems.slice(i, i + 200));
    }
  }

  const missedCount = missed.length;
  // Whatever the archive missed stays pending; the bookmarklet's "Refresh scores
  // & details" (old.reddit.com) or the userscript's daily refresh fills it in.
  const refreshHint = 'run Refresh scores & details from the bookmarklet or userscript to fill in the rest';
  if (arcticEnriched === 0 && missedCount > 0) {
    showToast(`Arctic Shift had none of these ${missedCount} items — ${refreshHint}`, 'warning');
  } else if (missedCount > 0) {
    showToast(`⚡ ${arcticEnriched.toLocaleString()} enriched via Arctic Shift · ${missedCount} not found — ${refreshHint}`, 'success');
  } else {
    showToast(`⚡ All ${arcticEnriched.toLocaleString()} items enriched via Arctic Shift ✓`, 'success');
  }
  render();
}

export async function markAttemptedAsDead() {
  const maxAttempts = state.enrichMaxAttempts;
  const candidates = state.items.filter(i =>
    i.enrichStatus === 'pending' && (i.enrichAttempts || 0) >= maxAttempts
  );
  if (candidates.length === 0) {
    showToast('No items meet the threshold', 'warning');
    return;
  }
  if (!confirm(`Mark ${candidates.length} item${candidates.length !== 1 ? 's' : ''} with ${maxAttempts}+ failed attempts as dead? They will be hidden from your library.`)) return;

  for (const item of candidates) {
    await db.items.update(item.id, { enriched: true, enrichStatus: 'dead' });
  }
  await loadData();
  showToast(`Marked ${candidates.length} items as dead`, 'success');
  render();
}

export async function resetDeadToPending() {
  const dead = state.items.filter(i => i.enrichStatus === 'dead');
  if (dead.length === 0) { showToast('No unavailable items', 'warning'); return; }
  if (!confirm(`Reset ${dead.length} unavailable item${dead.length !== 1 ? 's' : ''} to pending so they can be retried?`)) return;
  for (const item of dead) {
    await db.items.update(item.id, { enriched: false, enrichStatus: 'pending', enrichAttempts: 0 });
  }
  await loadData();
  showToast(`↩ ${dead.length} items reset to pending`, 'success');
  render();
}

// "Attempts before bulk-dead": each session refresh that can't find a pending
// item counts one attempt (applyMetaUpdates); past this many, "Mark as dead"
// is offered.
export async function saveEnrichMaxAttempts(val) {
  const n = Math.min(20, Math.max(1, parseInt(val, 10) || 3));
  state.enrichMaxAttempts = n;
  await db.config.put({ key: 'enrichMaxAttempts', value: n });
  showToast(`Items will be offered for "Mark as dead" after ${n} failed lookup${n !== 1 ? 's' : ''}`, 'success');
  render();
}

export function stopEnrichment() {
  enrichStopped = true;
}

export async function resetAllEnrichment() {
  const allItems = await db.items.toArray();
  for (const item of allItems) {
    await db.items.update(item.id, {
      enriched: false,
      enrichStatus: 'pending',
      enrichAttempts: 0,
    });
  }
  await loadData();
  showToast(`${allItems.length.toLocaleString()} items queued for re-enrichment`, 'success');
  render();
}
