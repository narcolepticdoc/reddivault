// enrich.js — part of RedditVault (auto-split from the original single-file PWA).
import { pushToSupabase } from './cloud.js';
import { loadData } from './core.js';
import { render } from './render.js';
import { db, state, syncLog } from './state.js';
import { showToast, sleep, sleepWithCountdown } from './util.js';

export async function enrichItemFromReddit(item) {
  const redditUrl = item.permalink || item.url || '';
  if (!redditUrl.includes('reddit.com')) return null;

  const clean = redditUrl.split('?')[0].replace(/\/$/, '');
  const jsonUrl = clean + '.json?raw_json=1&limit=1';

  try {
    const res = await fetch(jsonUrl, {
      headers: { 'Accept': 'application/json' }
    });

    // 429 = rate limited — caller should back off
    if (res.status === 429) return 'rate_limited';
    // 403/404 = deleted or private — mark as done so we don't retry forever
    if (res.status === 403 || res.status === 404) return 'unavailable';
    if (!res.ok) return null;

    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) return null;

    const postChildren = data[0]?.data?.children;
    if (!postChildren?.length) return null;
    const postData = postChildren[0].data;
    if (!postData) return null;

    // Re-derive type from permalink — don't trust stored type which may be wrong
    // from old CSV import bugs. A comment permalink has 6+ path segments;
    // a post permalink has exactly 5.
    const permalinkPath = (item.permalink || item.url || '').replace(/^https?:\/\/[^/]+/, '');
    const derivedType = permalinkPath.split('/').filter(Boolean).length > 5 ? 'comment' : 'post';

    let commentData = null;
    if (derivedType === 'comment' && data.length > 1) {
      // We need to find the SPECIFIC saved comment, not just the first in the thread.
      // The comment's bare ID is the last non-empty path segment of the permalink,
      // or we can strip the t1_ prefix from redditId.
      const bareId = (item.redditId || '').replace(/^t1_/, '');
      // Reddit returns a nested comment tree — walk it to find our comment
      function findComment(children) {
        for (const child of (children || [])) {
          if (!child.data) continue;
          if (child.data.id === bareId) return child.data;
          // Comments can be nested — recurse into replies
          const nested = child.data.replies?.data?.children;
          if (nested) {
            const found = findComment(nested);
            if (found) return found;
          }
        }
        return null;
      }
      const cc = data[1]?.data?.children;
      commentData = bareId ? findComment(cc) : (cc?.[0]?.data || null);
    }

    const enriched = {
      type: derivedType,   // store corrected type in case it was wrong
      subreddit: postData.subreddit || item.subreddit || '',
      postCreatedAt: postData.created_utc
        ? new Date(postData.created_utc * 1000).toISOString()
        : item.postCreatedAt || null,
      enriched: true,
      enrichAttempts: (item.enrichAttempts || 0) + 1,
    };

    if (derivedType === 'comment') {
      enriched.title = postData.title || item.title || 'Saved Comment';
      enriched.author = commentData?.author || item.author || '';
      enriched.body = commentData?.body || item.body || '';
      enriched.score = commentData?.score ?? item.score ?? null;
      if (commentData?.created_utc) {
        enriched.postCreatedAt = new Date(commentData.created_utc * 1000).toISOString();
      }
    } else {
      enriched.title = postData.title || item.title || 'Untitled Post';
      enriched.author = postData.author || item.author || '';
      enriched.body = postData.selftext || item.body || '';
      enriched.score = postData.score ?? item.score ?? null;
      if (postData.url && !postData.url.includes('reddit.com/r/')) {
        enriched.url = postData.url;
      }
    }

    return enriched;
  } catch(e) {
    return null;
  }
}

// ── Proactive rate-limit avoidance ───────────────────────────────────────────
// Without OAuth, Reddit allows 10 requests per minute on a rolling 10-minute
// window. We target 8 req/min by default — 80% of the limit — which keeps
// us safely clear. A steady drip is better than bursts followed by long waits.
//
// Retry runs default to 4 req/min since the pool is mostly dead/private posts
// and there is no urgency — slower = fewer false rate limit signals.
//
// All settings are user-adjustable within sane bounds and persisted to config.

// Max attempts before bulk-dead action is enabled — controlled via state.enrichMaxAttempts

// Derive timing from state settings at runtime (not hardcoded constants)
export function getEnrichDelay(isRetry) {
  const rpm = isRetry ? state.enrichRetryReqPerMin : state.enrichReqPerMin;
  return Math.round(60000 / rpm); // ms per request
}
export function getRateLimitPause() {
  return state.enrichRateLimitPause * 60000; // convert minutes to ms
}

export let enrichStopped = false;

// ─── ARCTIC SHIFT BULK ENRICHMENT ────────────────────────────────────────────
// Arctic Shift is a public Reddit archive with an ID-lookup API that accepts
// up to 500 IDs per request — no auth, no rate-limiting for normal usage.
// We use this as a fast first pass before falling back to the slow Reddit
// public .json endpoint for anything Arctic Shift doesn't have.
//
// API: https://arctic-shift.photon-reddit.com
//   GET /api/posts/ids?ids=t3_abc,t3_def&fields=...
//   GET /api/comments/ids?ids=t1_abc,t1_def&fields=...
//
// Coverage: all public Reddit data up to ~36h ago. New/very-obscure posts
// may be missing — those fall back to the Reddit enricher automatically.

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

  syncLog(`arctic: complete — ${arcticEnriched} enriched, ${failed.length} going to Reddit fallback`, arcticEnriched > 0 ? 'ok' : 'warn');
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
  if (arcticEnriched === 0 && missedCount > 0) {
    showToast(`Arctic Shift returned nothing — try Reddit enrichment for ${missedCount} items`, 'warning');
  } else if (missedCount > 0) {
    showToast(`⚡ ${arcticEnriched.toLocaleString()} enriched via Arctic Shift · ${missedCount} not found — use Reddit enrichment for the rest`, 'success');
  } else {
    showToast(`⚡ All ${arcticEnriched.toLocaleString()} items enriched via Arctic Shift ✓`, 'success');
  }
  render();
}

export async function enrichViaRedditOnly(retryFailed = false) {
  if (state.enriching) return;
  enrichStopped = false;

  if (retryFailed) {
    await db.items.toCollection().modify(item => {
      if (item.enrichStatus !== 'dead' && !item.title && !item.subreddit) {
        item.enriched = false;
        item.enrichStatus = 'pending';
        item.enrichAttempts = 0;
      }
    });
    await loadData();
  }

  const allItems = await db.items.toArray();
  const toEnrich = allItems.filter(i => i.enrichStatus === 'pending');

  if (toEnrich.length === 0) {
    showToast('Nothing to enrich ✓', 'success');
    return;
  }

  state.enriching = true;
  state.enrichProgress = { phase: 'reddit', done: 0, total: toEnrich.length, enriched: 0, failed: 0, rateLimitHits: 0 };
  render();

  const delay   = getEnrichDelay(retryFailed);
  const rlPause = getRateLimitPause();
  let enrichedCount    = 0;
  let failedCount      = 0;
  let rateLimitHits    = 0;
  let consecutiveNulls = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    if (enrichStopped) {
      showToast('Enrichment paused — click Start to resume', 'warning');
      break;
    }

    const item = toEnrich[i];
    const phaseDone  = i + 1;
    const phaseTotal = toEnrich.length;
    const pct        = Math.round((phaseDone / phaseTotal) * 100);
    const minsLeft   = Math.round(((phaseTotal - phaseDone) * delay) / 60000);

    // Keep state in sync so render() can reconstruct the progress display
    state.enrichProgress = { phase: 'reddit', done: phaseDone, total: phaseTotal, enriched: enrichedCount, failed: failedCount, rateLimitHits, minsLeft };

    const el = document.getElementById('enrich-progress-details');
    if (el) {
      el.innerHTML = `
        <div style="font-size:11px;font-weight:600;color:var(--warning);margin-bottom:6px;letter-spacing:0.03em">
          🐢 Reddit enrichment (${phaseTotal.toLocaleString()} items)
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
          ${phaseDone} / ${phaseTotal} &nbsp;·&nbsp; ${enrichedCount.toLocaleString()} enriched &nbsp;·&nbsp; ${failedCount} unavailable
          ${rateLimitHits > 0 ? ` &nbsp;·&nbsp; <span style="color:var(--warning)">⚠ ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}</span>` : ''}
          ${minsLeft > 1 ? ` &nbsp;·&nbsp; ~${minsLeft} min left` : ''}
        </div>
      `;
    }

    const result = await enrichItemFromReddit(item);

    if (result === 'rate_limited') {
      rateLimitHits++;
      state.enrichProgress.rateLimitHits = rateLimitHits;
      // Show countdown in progress area then sleep
      const el2 = document.getElementById('enrich-progress-details');
      if (el2) {
        const existing = el2.innerHTML;
        el2.innerHTML = existing + `<div style="font-size:12px;color:var(--warning);text-align:center;margin-top:8px;font-weight:500">⏳ Rate limited — <span id="rl-countdown">calculating...</span></div>`;
      }
      await sleepWithCountdown(rlPause);
      consecutiveNulls = 0;
      i--;
      continue;
    } else if (result === 'unavailable') {
      await db.items.update(item.id, { enriched: true, enrichStatus: 'dead', enrichAttempts: (item.enrichAttempts || 0) + 1 });
      failedCount++;
      consecutiveNulls = 0;
    } else if (result && typeof result === 'object') {
      await db.items.update(item.id, { ...result, enrichStatus: 'enriched' });
      enrichedCount++;
      consecutiveNulls = 0;
    } else {
      const attempts = (item.enrichAttempts || 0) + 1;
      await db.items.update(item.id, { enrichAttempts: attempts });
      failedCount++;
      consecutiveNulls++;
      if (consecutiveNulls >= 3) {
        rateLimitHits++;
        state.enrichProgress.rateLimitHits = rateLimitHits;
        const el2 = document.getElementById('enrich-progress-details');
        if (el2) {
          const existing = el2.innerHTML;
          el2.innerHTML = existing + `<div style="font-size:12px;color:var(--warning);text-align:center;margin-top:8px;font-weight:500">⏳ Possible rate limit — <span id="rl-countdown">calculating...</span></div>`;
        }
        await sleepWithCountdown(rlPause);
        consecutiveNulls = 0;
      }
    }

    await sleep(delay);
  }

  state.enriching = false;
  state.enrichProgress = { done: 0, total: 0, enriched: 0, failed: 0, rateLimitHits: 0 };
  state.lastRunRateLimitHits = rateLimitHits;
  await db.config.put({ key: 'lastRunRateLimitHits', value: rateLimitHits });
  await loadData();

  if (state.supabaseUrl && enrichedCount > 0) {
    const enrichedItems = await db.items.filter(i => i.enriched && i.title).toArray();
    for (let i = 0; i < enrichedItems.length; i += 200) {
      await pushToSupabase(enrichedItems.slice(i, i + 200));
    }
  }

  const remaining = await db.items.filter(i => !i.enriched).count();
  const rlMsg = rateLimitHits > 0 ? ` · ⚠ ${rateLimitHits} rate limit${rateLimitHits > 1 ? 's' : ''}` : '';
  showToast(
    `✓ ${enrichedCount} enriched · ${failedCount} unavailable${remaining > 0 ? ` · ${remaining} remaining` : ''}${rlMsg}`,
    rateLimitHits > 0 ? 'warning' : enrichedCount > 0 ? 'success' : 'warning'
  );
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

export function stopEnrichment() {
  enrichStopped = true;
}

export function updateEnrichProgress(done, total, enriched, failed, status = '', rlPauseMs = 300000) {
  const el = document.getElementById('enrich-progress-details');
  if (!el) return;
  const pct = Math.round((done / total) * 100);
  const remaining = total - done;
  const delay = getEnrichDelay(false); // use current run delay for estimate
  const minsLeft = Math.round((remaining * delay) / 60000);
  const rlHits = state.enrichProgress.rateLimitHits || 0;
  const rlPauseMins = Math.round(rlPauseMs / 60000);

  let statusMsg = '';
  if (status === 'ratelimit') {
    statusMsg = `<span style="color:var(--warning)">⏳ Rate limited — pausing ${rlPauseMins} min before continuing...</span>`;
  }

  el.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
      ${done} / ${total} processed &nbsp;·&nbsp; ${enriched} enriched &nbsp;·&nbsp; ${failed} unavailable
      ${rlHits > 0 ? `&nbsp;·&nbsp; <span style="color:var(--warning)">⚠ ${rlHits} rate limit${rlHits > 1 ? 's' : ''}</span>` : ''}
      ${!status && minsLeft > 1 ? `&nbsp;·&nbsp; ~${minsLeft} min left` : ''}
    </div>
    ${statusMsg ? `<div style="font-size:12px;text-align:center;margin-top:6px">${statusMsg}</div>` : ''}
  `;
}

// ─── SUPABASE ────────────────────────────────────────────────────────────────
export async function saveEnrichSettings() {
  const rpm = parseInt(document.getElementById('enrich-rpm')?.value);
  const retryRpm = parseInt(document.getElementById('enrich-retry-rpm')?.value);
  const rlPause = parseInt(document.getElementById('enrich-rl-pause')?.value);

  // Validate within sane bounds
  const validRpm = Math.min(10, Math.max(1, rpm || 8));
  const validRetryRpm = Math.min(10, Math.max(1, retryRpm || 4));
  const validRlPause = Math.min(30, Math.max(1, rlPause || 5));

  const maxAtt = parseInt(document.getElementById('enrich-max-attempts')?.value);
  const validMaxAtt = Math.min(20, Math.max(1, maxAtt || 3));

  state.enrichReqPerMin = validRpm;
  state.enrichRetryReqPerMin = validRetryRpm;
  state.enrichRateLimitPause = validRlPause;
  state.enrichMaxAttempts = validMaxAtt;

  await db.config.put({ key: 'enrichReqPerMin', value: validRpm });
  await db.config.put({ key: 'enrichRetryReqPerMin', value: validRetryRpm });
  await db.config.put({ key: 'enrichRateLimitPause', value: validRlPause });
  await db.config.put({ key: 'enrichMaxAttempts', value: validMaxAtt });

  showToast('Enrichment settings saved ✓', 'success');
  render();
}

// ─── PREFERENCES SYNC ────────────────────────────────────────────────────────

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

export function enrichTimeEstimate(itemCount, rpm) {
  const delaySecs = 60 / rpm;
  const totalMins = Math.ceil(itemCount * delaySecs / 60);
  if (totalMins < 60) return `~${totalMins} min`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `~${hrs}h ${mins}m` : `~${hrs}h`;
}


export function updateSpeedHints() {
  const normalRpm  = Math.min(10, Math.max(1, parseInt(document.getElementById('enrich-rpm')?.value) || 8));
  const retryRpm   = Math.min(10, Math.max(1, parseInt(document.getElementById('enrich-retry-rpm')?.value) || 4));
  const needsEnrich = state.items.filter(i => !i.enriched).length;
  const retryable   = state.items.filter(i => i.enriched && !i.title && !i.subreddit).length +
                      state.items.filter(i => !i.enriched && (i.enrichAttempts || 0) > 0).length;
  const normalQueue = needsEnrich || 1000;
  const retryQueue  = retryable  || 1000;

  const hn = document.getElementById('hint-normal');
  const hr = document.getElementById('hint-retry');
  if (hn) hn.textContent = `every ${Math.round(60/normalRpm)}s · ${enrichTimeEstimate(normalQueue, normalRpm)} for ${normalQueue.toLocaleString()} items`;
  if (hr) hr.textContent = `every ${Math.round(60/retryRpm)}s · ${enrichTimeEstimate(retryQueue, retryRpm)} for ${retryQueue.toLocaleString()} items`;
}

