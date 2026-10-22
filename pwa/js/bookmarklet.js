// bookmarklet.js — part of RedditVault (auto-split from the original single-file PWA).
import { pushInBatches, pushPreference, supabaseFetch, supabaseFetchRange } from './cloud.js';
import { loadData } from './core.js';
import { render } from './render.js';
import { db, state, syncLog } from './state.js';
import { escHtml, showToast } from './util.js';

export async function saveRedditUsername() {
  const raw = (document.getElementById('bm-username')?.value || '').trim().replace(/^\/?u\//i, '');
  await db.config.put({ key: 'redditUsername', value: raw });
  state.redditUsername = raw;
  if (state.supabaseUrl && state.supabaseKey) pushPreference('redditUsername', raw);
  render();
  showToast(raw ? `Reddit username set to u/${raw}` : 'Reddit username cleared', 'success');
}

// How many most-recent active saves "Refresh scores" checks (0 = all). Stored in
// user_preferences so the bookmarklet reads it at runtime — no re-copy needed.
export async function saveScoreRefreshLimit(val) {
  const n = parseInt(val, 10) || 0;
  await db.config.put({ key: 'scoreRefreshLimit', value: n });
  state.scoreRefreshLimit = n;
  if (state.supabaseUrl && state.supabaseKey) pushPreference('scoreRefreshLimit', n);
  showToast(n > 0 ? `Refresh scores will check your latest ${n} saves` : 'Refresh scores will check all saves', 'success');
}

export function mapRedditChild(child, source) {
  const d = child.data;
  const kind = child.kind; // t3 = post, t1 = comment
  const type = kind === 't1' ? 'comment' : 'post';
  // For comments, prefer link_title (parent post title). If absent, store a
  // placeholder and mark for enrichment so the Reddit .json enricher can fetch
  // the real parent post title.
  const commentTitle = type === 'comment' ? (d.link_title || null) : null;
  const needsEnrich = type === 'comment' && !commentTitle;
  return {
    redditId: d.name,
    type,
    title: d.title || commentTitle || (type === 'comment' ? `Comment in r/${d.subreddit}` : ''),
    body: type === 'comment' ? (d.body || '') : (d.selftext || ''),
    author: d.author || '',
    subreddit: d.subreddit || '',
    url: d.url || `https://reddit.com${d.permalink}`,
    permalink: d.permalink ? `https://reddit.com${d.permalink}` : '',
    score: d.score || 0,
    savedAt: new Date().toISOString(),
    postCreatedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    enriched: !needsEnrich,
    enrichStatus: needsEnrich ? 'pending' : 'enriched',
    source,
  };
}

// Shared app-side ingest for raw Reddit children (used by the inbox drain — fed
// by the bookmarklet and the userscript — and the manual paste fallback). Dedups
// against ALL known ids including permanently-deleted ones, so a capture can
// never resurrect something you deleted. New items go to IndexedDB and are
// pushed to the cloud via the app's own pushToSupabase (batched) — the capture
// tools never write to reddit_saves themselves.
export async function ingestChildren(children, source) {
  const existing = new Set(state.items.map(i => i.redditId));
  const newItems = [];
  let skipped = 0;
  for (const child of children) {
    const rid = child && child.data && child.data.name;
    if (!rid) continue;
    if (existing.has(rid)) { skipped++; continue; }
    newItems.push(mapRedditChild(child, source));
    existing.add(rid);
  }
  if (newItems.length) {
    await db.items.bulkAdd(newItems);
    await pushInBatches(newItems);
  }
  return { added: newItems.length, skipped };
}

// Apply score-only updates from the "Refresh scores" op.
// updates: [{redditId, score}]. Only touches items that ALREADY exist locally —
// it never creates rows, so it can't resurrect permanently-deleted/purged items
// (same dedup philosophy as ingestChildren). Updates IndexedDB only when the
// score actually changed, then pushes changed items via the app's own
// pushToSupabase (the trusted write path). Returns the count changed.
export async function applyScoreUpdates(updates) {
  const byId = new Map();
  for (const u of updates) {
    if (!u || !u.redditId || u.score == null) continue;
    byId.set(u.redditId, u.score); // last wins within a batch
  }
  const changed = [];
  const now = new Date().toISOString();
  for (const item of state.items) {
    if (!byId.has(item.redditId)) continue;
    const newScore = byId.get(item.redditId);
    if (item.score === newScore) continue;      // no-op if unchanged
    // localEditAt: Hard Rule 7 — an in-flight pull must not clobber this edit.
    await db.items.update(item.id, { score: newScore, localEditAt: now });
    item.score = newScore;                        // keep in-memory state coherent
    item.localEditAt = now;
    changed.push(item);
  }
  await pushInBatches(changed);
  return changed.length;
}

// Apply full-metadata refreshes from the "Refresh scores & details" op.
// updates: [{redditId, child}] for items Reddit's /api/info returned, or
// [{redditId, missing: true}] for ids it didn't return (deleted/unavailable).
// Like applyScoreUpdates it only touches items ALREADY in the library — never
// creates rows — and skips permanently-deleted ones. Fields come from
// mapRedditChild (the single ingestion mapper) but savedAt/source are kept. A
// miss bumps enrichAttempts on a still-pending item, which feeds the existing
// "Mark N as dead" threshold. Returns { updated, missed }.
export async function applyMetaUpdates(updates) {
  const byId = new Map();
  for (const u of updates) { if (u && u.redditId) byId.set(u.redditId, u); }
  const updated = [];
  let missed = 0;
  const now = new Date().toISOString();
  for (const item of state.items) {
    const u = byId.get(item.redditId);
    if (!u || item.isPermanentlyDeleted) continue;
    let patch;
    if (u.missing || !u.child || !u.child.data) {
      if (item.enrichStatus !== 'pending') continue;
      patch = { enrichAttempts: (item.enrichAttempts || 0) + 1, localEditAt: now };
      missed++;
    } else {
      const m = mapRedditChild(u.child, item.source);
      patch = {
        type: m.type,
        title: m.title,
        body: m.body,
        author: m.author,
        subreddit: m.subreddit,
        url: m.url,
        permalink: m.permalink,
        score: m.score,
        postCreatedAt: m.postCreatedAt || item.postCreatedAt || null,
        enriched: m.enriched,
        enrichStatus: m.enrichStatus,
        enrichAttempts: (item.enrichAttempts || 0) + 1,
        localEditAt: now,
      };
      // A comment returned without its parent-post title keeps a real title we
      // already had rather than dropping back to the "Comment in r/…" placeholder.
      if (m.enrichStatus === 'pending' && item.title && !/^Comment in r\//.test(item.title)) {
        patch.title = item.title;
      }
      updated.push(item);
    }
    await db.items.update(item.id, patch);
    Object.assign(item, patch);
  }
  // Misses only touch local-only fields (enrichAttempts), so only real
  // metadata changes need to reach the cloud.
  await pushInBatches(updated);
  return { updated: updated.length, missed };
}

// True when an inbox row was captured from a Reddit account other than the
// vault's. Every row the bookmarklet/userscript writes carries `by` (the
// logged-in Reddit username); rows without it (old installed bookmarklets) are
// accepted. Last line of defence for users with several Reddit accounts.
export function _inboxRowFromOtherAccount(payload) {
  const expect = (state.redditUsername || '').toLowerCase();
  return !!(payload && payload.by && expect && String(payload.by).toLowerCase() !== expect);
}

const EMPTY_DRAIN = { added: 0, skipped: 0, scoresUpdated: 0, detailsUpdated: 0, rejected: 0, drained: 0 };

// Drain the reddit_inbox staging table into the library, then clear it. Called
// on startup (quiet) and from the Settings "Import from inbox" button (manual).
export async function drainInbox({ manual = false } = {}) {
  if (!state.supabaseUrl || !state.supabaseKey) {
    if (manual) showToast('Connect Supabase first', 'error');
    return { ...EMPTY_DRAIN };
  }
  if (state.inboxDraining) return { ...EMPTY_DRAIN };
  state.inboxDraining = true;
  if (manual) { state.bookmarkletResult = null; render(); }
  try {
    // Page through the inbox — Supabase hard-caps at 1000 rows per request.
    const rows = [];
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const page = await supabaseFetchRange('/reddit_inbox?select=id,payload&order=id.asc', from, from + PAGE - 1);
      rows.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    if (rows.length === 0) {
      syncLog('drainInbox: inbox empty');
      if (manual) { state.bookmarkletResult = { ...EMPTY_DRAIN }; render(); showToast('Inbox empty — nothing to import', 'info'); }
      return { ...EMPTY_DRAIN };
    }
    syncLog(`drainInbox: ${rows.length} item(s) in inbox`);
    // Typed staging: rows are dispatched by payload.op. Legacy rows have no `op`
    // (bare {kind,data}) and are treated as captures, so they still drain.
    // Rows captured from a different Reddit account are cleared but never applied.
    const captureChildren = [], scoreUpdates = [], metaUpdates = [];
    let rejected = 0;
    const rejectedFrom = new Set();
    for (const r of rows) {
      const p = r.payload; if (!p) continue;
      if (_inboxRowFromOtherAccount(p)) { rejected++; rejectedFrom.add(String(p.by)); continue; }
      if (p.op === 'score') { if (p.reddit_id) scoreUpdates.push({ redditId: p.reddit_id, score: p.score }); }
      else if (p.op === 'meta') { if (p.reddit_id) metaUpdates.push({ redditId: p.reddit_id, child: p.child, missing: !!p.missing }); }
      else captureChildren.push(p);
    }
    if (rejected) {
      syncLog(`drainInbox: skipped ${rejected} row(s) captured from u/${[...rejectedFrom].join(', u/')} — vault belongs to u/${state.redditUsername}`, 'warn');
    }
    const { added, skipped } = captureChildren.length
      ? await ingestChildren(captureChildren, 'bookmarklet')
      : { added: 0, skipped: 0 };
    const scoresUpdated = scoreUpdates.length ? await applyScoreUpdates(scoreUpdates) : 0;
    const { updated: detailsUpdated } = metaUpdates.length
      ? await applyMetaUpdates(metaUpdates)
      : { updated: 0 };

    // Clear everything we pulled (new, already-known and rejected) so the inbox stays empty.
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await supabaseFetch(`/reddit_inbox?id=in.(${chunk.join(',')})`, 'DELETE');
    }

    const ts = new Date().toISOString();
    await db.config.put({ key: 'lastBookmarkletSync', value: ts });
    state.lastBookmarkletSync = ts;
    const result = { added, skipped, scoresUpdated, detailsUpdated, rejected, drained: rows.length };
    state.bookmarkletResult = result;
    syncLog(`drainInbox: imported ${added} new, ${skipped} already saved, ${scoresUpdated} score(s) updated, ${detailsUpdated} detail refresh(es), ${rejected} rejected, cleared ${rows.length}`, 'ok');

    const changed = added > 0 || scoresUpdated > 0 || detailsUpdated > 0;
    if (changed) await loadData();
    render();
    // Toast on manual runs always, and on quiet (startup/foreground) runs only
    // when something actually changed — so silent drains stay silent. A rejection
    // always toasts: the user should know the wrong account was captured.
    if (manual || changed || rejected) {
      const parts = [];
      if (added) parts.push(`${added} new item${added !== 1 ? 's' : ''}`);
      if (scoresUpdated) parts.push(`${scoresUpdated} score${scoresUpdated !== 1 ? 's' : ''} updated`);
      if (detailsUpdated) parts.push(`${detailsUpdated} item${detailsUpdated !== 1 ? 's' : ''} refreshed`);
      let msg = parts.length ? `Imported ${parts.join(' · ')}` : 'Nothing new in the inbox';
      if (rejected) msg += ` — skipped ${rejected} captured from u/${[...rejectedFrom].join(', u/')} (not this vault's account)`;
      showToast(msg, rejected ? 'warning' : 'success');
    }
    return result;
  } catch (e) {
    syncLog(`drainInbox: failed — ${e.message}`, 'error');
    if (manual) { state.bookmarkletResult = { error: e.message }; render(); showToast('Inbox import failed', 'error'); }
    return { ...EMPTY_DRAIN, error: e.message };
  } finally {
    // Reset the guard and re-render LAST so the button leaves its "Importing…"
    // state — the branch renders above all run while inboxDraining is still true.
    state.inboxDraining = false;
    render();
  }
}

// Manual fallback: import items the bookmarklet copied to the clipboard (used
// only when the direct inbox POST failed). Goes through the same ingestChildren
// path, so the main table is still only written by the app.
export async function importPastedBookmarklet() {
  const ta = document.getElementById('bm-paste');
  let raw = ta && ta.value ? ta.value.trim() : '';
  if (!raw) {
    try { raw = (await navigator.clipboard.readText()).trim(); } catch (e) {}
  }
  if (!raw) { showToast('Paste the copied data into the box first', 'error'); return; }
  let env;
  try { env = JSON.parse(raw); } catch (e) { showToast('Could not read pasted data — is it the copied text?', 'error'); return; }
  const children = (env && Array.isArray(env.children)) ? env.children : (Array.isArray(env) ? env : null);
  if (!children || !children.length) { showToast('No items found in pasted data', 'error'); return; }
  // Same account guard as the inbox drain: the envelope records which Reddit
  // account captured it.
  if (env && _inboxRowFromOtherAccount(env)) {
    showToast(`These items were captured from u/${env.by}, but this vault belongs to u/${state.redditUsername} — not imported`, 'error');
    return;
  }
  const { added, skipped } = await ingestChildren(children, 'bookmarklet');
  const ts = new Date().toISOString();
  await db.config.put({ key: 'lastBookmarkletSync', value: ts });
  state.lastBookmarkletSync = ts;
  state.bookmarkletResult = { ...EMPTY_DRAIN, added, skipped, drained: children.length };
  if (added > 0) await loadData();
  render();
  showToast(`Imported ${added} new item${added !== 1 ? 's' : ''}`, 'success');
}

export function cspProbeBookmarklet(supabaseUrl, supabaseKey) {
  // Bake creds into single-quoted JS string literals — escape backslash/quote.
  const u = String(supabaseUrl || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const k = String(supabaseKey || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const src =
    "javascript:(async()=>{" +
      "if(!/(^|\\.)reddit\\.com$/.test(location.hostname)){alert('Run this on old.reddit.com while logged in.');return;}" +
      "try{var r=await fetch('/user/me/saved.json?limit=1&raw_json=1',{credentials:'include',headers:{'Accept':'application/json'}});" +
        "alert('1/2 Reddit saved.json: HTTP '+r.status+(r.ok?' OK (same-origin fetch works)':' — not OK; are you logged in?'));}" +
      "catch(e){alert('1/2 Reddit saved.json FAILED: '+e.message+' (blocked before the Supabase test could run).');return;}" +
      "try{var s=await fetch('" + u + "/rest/v1/reddit_saves?limit=1&select=reddit_id',{headers:{apikey:'" + k + "',Authorization:'Bearer " + k + "'}});" +
        "alert('2/2 Supabase reachable: HTTP '+s.status+' — CSP ALLOWS the direct POST path. Reply with both numbers.');}" +
      "catch(e){alert('2/2 Supabase BLOCKED by CSP: '+e.message+' — iOS will need the clipboard fallback. Reply with both numbers.');}" +
    "})()";
  return src;
}

// Escape a value for baking into a single-quoted JS string literal.
function _bmLiteral(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Capture bookmarklet. Runs same-origin on reddit.com using the user's session
// cookie, fetches their saved listing, and POSTs the raw items to the
// reddit_inbox staging table — never to reddit_saves directly. The app drains
// the inbox through its normal ingest.
//
// Account binding: EX (the vault's Reddit username) is required. The logged-in
// account (/api/me.json) must match it exactly — there is no "use anyway" — and
// reads go to /user/EX/saved.json (Reddit only serves a saved listing to its
// owner). Every inbox row carries `by` so the drain can reject anything from
// another account.
//
// Host modes: old.reddit.com can reach Supabase, so it captures incrementally
// and POSTs directly. New Reddit (www/sh) has a CSP whose connect-src blocks
// every Supabase call, so there it scans the newest 3 pages and offers the
// clipboard envelope for "Paste captured items". Refresh needs Supabase, so it
// is offered on old.reddit.com only (the userscript does it anywhere).
//
// Built as a string using only single quotes (no double quotes, no backticks,
// no apostrophes inside literals), so nothing needs escaping when the href is
// escHtml-escaped at render time. Banners use textContent and real buttons.
export function buildInboxBookmarklet(supabaseUrl, supabaseKey, expectUser) {
  const u = _bmLiteral(supabaseUrl);
  const k = _bmLiteral(supabaseKey);
  const x = _bmLiteral(expectUser);
  return "javascript:(async()=>{" +
    "var U='" + u + "',K='" + k + "',EX='" + x + "',ME=null;" +
    "var o=document.createElement('div');o.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a1b;color:#fff;font:14px/1.6 -apple-system,sans-serif;padding:12px 16px;box-shadow:0 2px 10px rgba(0,0,0,.5)';document.body.appendChild(o);" +
    "var say=function(m){o.textContent=m};" +
    "var clo=function(){o.remove()};" +
    "var btn=function(label,bg){var b=document.createElement('button');b.textContent=label;b.style.cssText='margin:8px 8px 0 0;padding:8px 14px;border:0;border-radius:6px;background:'+(bg||'#4f46e5')+';color:#fff;cursor:pointer;font:inherit';o.appendChild(b);return b};" +
    "var done=function(msg){o.textContent=msg;btn('Close','#555').onclick=clo};" +
    "var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};" +
    // Wrong-context guards (a bookmarklet can't survive a navigation, so the
    // user taps the bookmark again once the right page has loaded).
    "if(!/(^|\\.)reddit\\.com$/.test(location.hostname)){say('RedditVault: open Reddit first, then tap the bookmark again.');btn('Go to old.reddit.com').onclick=function(){location.href='https://old.reddit.com/'};return;}" +
    "if(!EX){done('RedditVault: set your Reddit username in RedditVault (Settings, Capture New Saves), then copy the bookmarklet again.');return;}" +
    "var OLD=location.hostname==='old.reddit.com';" +
    "var needLogin=function(){say('RedditVault: you are logged out of Reddit.');btn('Log in to Reddit').onclick=function(){window.open('https://old.reddit.com/login','_blank')};btn('Close','#555').onclick=clo};" +
    // ── Helpers ──
    "var sb=function(path,extra){var h={apikey:K,Authorization:'Bearer '+K};if(extra){for(var x in extra)h[x]=extra[x];}return fetch(U+'/rest/v1/'+path,{headers:h})};" +
    "var post=async function(rows){var pr=await fetch(U+'/rest/v1/reddit_inbox?on_conflict=reddit_id',{method:'POST',headers:{'Content-Type':'application/json',apikey:K,Authorization:'Bearer '+K,Prefer:'resolution=ignore-duplicates'},body:JSON.stringify(rows)});if(!pr.ok){throw new Error(pr.status+' '+(await pr.text()).slice(0,140));}};" +
    "var slim=function(c){var d=c.data;return {kind:c.kind,data:{name:d.name,id:d.id,title:d.title,link_title:d.link_title,author:d.author,subreddit:d.subreddit,url:d.url,permalink:d.permalink,body:d.body,selftext:d.selftext,score:d.score,created_utc:d.created_utc},by:ME}};" +
    "var who=async function(){try{var r=await fetch('/api/me.json',{credentials:'include',headers:{'Accept':'application/json'}});if(!r.ok)return null;var j=await r.json();return (j&&j.data&&j.data.name)||(j&&j.name)||null;}catch(e){return null}};" +
    "var info=async function(ids){for(var t=0;t<3;t++){var r=await fetch('/api/info.json?id='+ids.join(',')+'&raw_json=1',{credentials:'include',headers:{'Accept':'application/json'}});" +
      "if(r.status===401||r.status===403){needLogin();return null;}" +
      "if(r.status===429){say('Rate limited, waiting 5s…');await wait(5000);continue;}" +
      "if(!r.ok){throw new Error('Reddit error '+r.status);}" +
      "var j=await r.json();return (j&&j.data&&j.data.children)||[];}throw new Error('Reddit kept rate limiting');};" +
    "var offerCopy=function(kids,msg){var env=JSON.stringify({type:'rv-bookmarklet',v:2,by:ME,children:kids});o.textContent=msg;var cb=btn('Copy '+kids.length+' items');" +
      "cb.onclick=function(){navigator.clipboard.writeText(env).then(function(){cb.textContent='✓ Copied, paste it in RedditVault'}).catch(function(){var t=document.createElement('textarea');t.value=env;t.style.cssText='display:block;width:100%;height:80px;margin-top:8px';o.appendChild(t);t.focus();t.select()})};" +
      "btn('Close','#555').onclick=clo};" +
    // ── Op 1: capture new saves ──
    "async function capture(){" +
      "say('RedditVault: checking what is new…');" +
      "var known=new Set();" +
      "if(OLD){try{var kr=await sb('reddit_saves?select=reddit_id&order=saved_at.desc&limit=500');if(kr.ok){var ka=await kr.json();for(var n=0;n<ka.length;n++)known.add(ka[n].reddit_id);}}catch(e){}}" +
      "var rows=[],kids=[],after=null,page=0,seen=0,MAXP=OLD?40:3;" +
      "try{while(page<MAXP){" +
        "var res=await fetch('/user/'+encodeURIComponent(EX)+'/saved.json?limit=100&raw_json=1'+(after?'&after='+after:''),{credentials:'include',headers:{'Accept':'application/json'}});" +
        "if(res.status===401||res.status===403){done('⚠️ Reddit refused access to the saves of u/'+EX+' (HTTP '+res.status+'). Make sure you are logged in as u/'+EX+'.');return;}" +
        "if(res.status===429){say('Rate limited, waiting 5s…');await wait(5000);continue;}" +
        "if(!res.ok){done('⚠️ Reddit error '+res.status+'. Try again shortly.');return;}" +
        "var data=await res.json(),ch=(data&&data.data&&data.data.children)||[];if(!ch.length)break;" +
        "var fresh=0;" +
        "for(var i=0;i<ch.length;i++){var c=ch[i],rid=c.data.name;seen++;if(known.has(rid))continue;fresh++;var s=slim(c);kids.push(s);rows.push({reddit_id:rid,payload:s});}" +
        "page++;say('Scanned '+seen+' saves, '+rows.length+' new…');" +
        "after=data.data.after;if(!after)break;" +
        "if(OLD&&fresh===0)break;" +
        "await wait(1000);" +
      "}}catch(e){done('⚠️ Could not read saves: '+e.message);return;}" +
      "if(!rows.length){done('✅ Already up to date, no new saves.');return;}" +
      // Close the account-switch race: confirm the same account before anything leaves the page.
      "var now=await who();if(!now||now.toLowerCase()!==EX.toLowerCase()){done('⚠️ Your Reddit account changed while capturing, so nothing was sent. Switch back to u/'+EX+' and tap the bookmark again.');return;}" +
      "if(!OLD){offerCopy(kids,'New Reddit blocks sending straight to your vault. Copy your '+kids.length+' most recent saves and paste them into RedditVault (Capture New Saves, Paste captured items). On old.reddit.com, or with the RedditVault userscript, saves are sent automatically.');return;}" +
      "say('Sending '+rows.length+' new saves to your vault inbox…');" +
      "try{for(var j=0;j<rows.length;j+=100){await post(rows.slice(j,j+100));say('Sent '+Math.min(j+100,rows.length)+'/'+rows.length+'…');}" +
        "done('✅ Captured '+rows.length+' new saves. Open RedditVault and it imports them automatically.');" +
      "}catch(e){offerCopy(kids,'⚠️ Could not reach your vault inbox ('+e.message+'). Copy your saves and paste them into RedditVault instead:');}" +
    "}" +
    // ── Op 2: refresh scores & details ──
    // Pending (unenriched) items get their full details from Reddit (op meta,
    // or a missing marker if Reddit no longer has them); the most recent LIM
    // items get a score row only when the score actually changed. Batches of
    // 100 via /api/info, flushed per batch so an interrupted run keeps progress.
    "async function refresh(){" +
      "var LIM=500;" +
      "try{var lr=await sb('user_preferences?key=eq.scoreRefreshLimit&select=value');if(lr.ok){var la=await lr.json();if(la.length){var lv=la[0].value;var pv=(typeof lv==='number')?lv:parseInt(lv,10);if(!isNaN(pv)&&pv>=0)LIM=pv;}}}catch(e){}" +
      "say('RedditVault: loading your saved items…');" +
      "var have={},order=[],pend=[],from=0,PG=1000;" +
      "try{while(true){" +
        "var want=(LIM>0)?Math.min(PG,LIM-order.length):PG;if(want<=0)break;" +
        "var rr=await sb('reddit_saves?select=reddit_id,score&deleted_at=is.null&order=saved_at.desc',{Range:from+'-'+(from+want-1),'Range-Unit':'items'});" +
        "if(rr.status!==200&&rr.status!==206){done('⚠️ Could not read your vault list ('+rr.status+').');return;}" +
        "var ja=await rr.json();for(var i=0;i<ja.length;i++){have[ja[i].reddit_id]=ja[i].score;order.push(ja[i].reddit_id);}" +
        "say('Loading your item list… '+order.length);" +
        "if(ja.length<want)break;from+=want;" +
      "}" +
      "var pq=await sb('reddit_saves?select=reddit_id&enrich_status=eq.pending&deleted_at=is.null&order=saved_at.desc&limit=1000');" +
      "if(pq.ok){var pa=await pq.json();for(var q=0;q<pa.length;q++)pend.push(pa[q].reddit_id);}" +
      "}catch(e){done('⚠️ Could not reach your vault ('+e.message+').');return;}" +
      "var isP={};for(var a=0;a<pend.length;a++)isP[pend[a]]=1;" +
      "var ids=pend.slice();for(var b=0;b<order.length;b++){if(!isP[order[b]])ids.push(order[b]);}" +
      "if(!ids.length){done('Nothing to refresh.');return;}" +
      "var sent=0,sc=0,dt=0;" +
      "try{for(var j=0;j<ids.length;j+=100){" +
        "var batch=ids.slice(j,j+100);" +
        "var data=await info(batch);if(data===null)return;" +
        "var got={},rows=[],needT={};" +
        "for(var m=0;m<data.length;m++){var c=data[m],d=c.data;if(!d||!d.name)continue;got[d.name]=c;if(isP[d.name]&&c.kind==='t1'&&!d.link_title&&d.link_id)needT[d.link_id]=1;}" +
        // Comments from /api/info may lack the parent-post title: fetch the parents once per batch.
        "var lids=Object.keys(needT);if(lids.length){var td=await info(lids);if(td===null)return;var tt={};for(var n=0;n<td.length;n++){if(td[n].data)tt[td[n].data.name]=td[n].data.title;}for(var g in got){var gd=got[g].data;if(gd.link_id&&tt[gd.link_id]&&!gd.link_title)gd.link_title=tt[gd.link_id];}}" +
        "for(var p=0;p<batch.length;p++){var id=batch[p],c2=got[id];" +
          "if(isP[id]){rows.push({reddit_id:'meta:'+id,payload:c2?{op:'meta',reddit_id:id,child:slim(c2),by:ME}:{op:'meta',reddit_id:id,missing:true,by:ME}});dt++;}" +
          "else if(c2&&typeof c2.data.score==='number'&&c2.data.score!==have[id]){rows.push({reddit_id:'score:'+id,payload:{op:'score',reddit_id:id,score:c2.data.score,by:ME}});sc++;}" +
        "}" +
        "if(rows.length){try{await post(rows);}catch(e){done('⚠️ Could not reach your vault inbox ('+e.message+'). '+sent+' sent so far; tap the bookmark again on old.reddit.com to finish.');return;}sent+=rows.length;}" +
        "say('Checked '+Math.min(j+100,ids.length)+'/'+ids.length+' items: '+sc+' score changes, '+dt+' details sent…');" +
        "if(j+100<ids.length)await wait(1000);" +
      "}}catch(e){done('⚠️ Could not refresh: '+e.message+' ('+sent+' sent so far).');return;}" +
      "if(!sent){done('✅ Everything is current, nothing to send.');return;}" +
      "done('✅ Queued '+sc+' score changes and '+dt+' detail refreshes. Open RedditVault and it applies them automatically.');" +
    "}" +
    // ── Account check: the logged-in account must be the vault's ──
    "try{var mr=await fetch('/api/me.json',{credentials:'include',headers:{'Accept':'application/json'}});if(mr.status===401||mr.status===403){needLogin();return;}if(mr.ok){var mj=await mr.json();ME=(mj&&mj.data&&mj.data.name)||(mj&&mj.name)||null;}}catch(e){}" +
    "if(!ME){needLogin();return;}" +
    "if(ME.toLowerCase()!==EX.toLowerCase()){done('⚠️ You are logged in as u/'+ME+', but this vault belongs to u/'+EX+'. Nothing was captured. Switch to u/'+EX+' in Reddit, then tap the bookmark again.');return;}" +
    // ── Menu ──
    "say('RedditVault, logged in as u/'+ME+'. Choose an action:');" +
    "btn('① Capture new saves').onclick=function(){capture()};" +
    "if(OLD){btn('② Refresh scores & details').onclick=function(){refresh()};}" +
    "btn('Close','#555').onclick=clo;" +
    "if(!OLD){var nt=document.createElement('div');nt.style.cssText='font-size:12px;opacity:.75;margin-top:6px';nt.textContent='New Reddit: captured saves are copied for pasting into RedditVault. On old.reddit.com (or with the userscript) they are sent directly, and scores and details can be refreshed.';o.appendChild(nt);}" +
  "})()";
}

// ─── USERSCRIPT PAIRING ──────────────────────────────────────────────────────
// The userscript (pwa/reddivault.user.js) is a public static file, so it never
// contains credentials. Each device is paired once with a code carrying the
// Supabase URL, anon key and the vault's Reddit username (same exposure as the
// bookmarklet, which bakes in the same values).
export const USERSCRIPT_PATH = '/reddivault.user.js';

export function buildPairingCode() {
  const json = JSON.stringify({ u: state.supabaseUrl, k: state.supabaseKey, x: state.redditUsername });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'RV1:' + btoa(bin);
}

function _pairingReady() {
  if (!state.supabaseUrl || !state.supabaseKey) { showToast('Connect Supabase first', 'error'); return false; }
  if (!state.redditUsername) { showToast('Set your vault\'s Reddit username first', 'error'); return false; }
  return true;
}

export async function copyPairingCode(btn) {
  if (!_pairingReady()) return;
  try {
    await navigator.clipboard.writeText(buildPairingCode());
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy pairing code'; }, 1500); }
    showToast('Pairing code copied — on Reddit, tap the RV button → Pair and paste it', 'success');
  } catch (e) {
    showToast('Could not copy — your browser blocked clipboard access', 'error');
  }
}

// Open Reddit with the pairing code in the URL fragment (never sent to Reddit's
// servers). The userscript asks for confirmation, stores it, and strips the hash.
export function pairUserscript() {
  if (!_pairingReady()) return;
  window.open('https://old.reddit.com/#rv-pair=' + encodeURIComponent(buildPairingCode()), '_blank');
}

// Open the vault account's saved page with #rv-capture so the userscript runs
// a capture immediately (skipping its 30-minute throttle).
export function openRedditCapture() {
  if (!state.redditUsername) { showToast('Set your vault\'s Reddit username first', 'error'); return; }
  window.open('https://old.reddit.com/user/' + encodeURIComponent(state.redditUsername) + '/saved#rv-capture', '_blank');
}

// Open Reddit with #rv-refresh so the userscript runs "Refresh scores &
// details" right away (fills in pending items using your own login).
export function openRedditRefresh() {
  window.open('https://old.reddit.com/#rv-refresh', '_blank');
}

// Bring back a userscript badge the user hid.
export function showUserscriptButton() {
  window.open('https://old.reddit.com/#rv-show', '_blank');
}

