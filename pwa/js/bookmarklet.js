// bookmarklet.js — part of RedditVault (auto-split from the original single-file PWA).
import { markClean, pushPreference, pushToSupabase, supabaseFetch, supabaseFetchRange } from './cloud.js';
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

// Shared app-side ingest for raw Reddit children (used by the bookmarklet inbox
// drain and the manual paste fallback). Dedups against ALL known ids including
// permanently-deleted ones, so a bookmarklet capture can never resurrect
// something you deleted. New items go to IndexedDB and are pushed to the cloud
// via the app's own normal pushToSupabase — the bookmarklet never writes to
// reddit_saves itself.
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
    if (state.supabaseUrl && state.supabaseKey) await pushToSupabase(newItems);
  }
  return { added: newItems.length, skipped };
}

// Apply score-only updates from the bookmarklet's "Refresh scores" op.
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
  for (const item of state.items) {
    if (!byId.has(item.redditId)) continue;
    const newScore = byId.get(item.redditId);
    if (item.score === newScore) continue;      // no-op if unchanged
    await db.items.update(item.id, { score: newScore });
    item.score = newScore;                        // keep in-memory state coherent
    changed.push(item);
  }
  if (changed.length && state.supabaseUrl && state.supabaseKey) {
    for (let i = 0; i < changed.length; i += 200) {
      await pushToSupabase(changed.slice(i, i + 200), true);
    }
    await markClean();
  }
  return changed.length;
}

// Drain the reddit_inbox staging table into the library, then clear it. Called
// on startup (quiet) and from the Settings "Import from inbox" button (manual).
export async function drainInbox({ manual = false } = {}) {
  if (!state.supabaseUrl || !state.supabaseKey) {
    if (manual) showToast('Connect Supabase first', 'error');
    return { added: 0, skipped: 0, scoresUpdated: 0, drained: 0 };
  }
  if (state.inboxDraining) return { added: 0, skipped: 0, scoresUpdated: 0, drained: 0 };
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
      if (manual) { state.bookmarkletResult = { added: 0, skipped: 0, scoresUpdated: 0, drained: 0 }; render(); showToast('Inbox empty — nothing to import', 'info'); }
      return { added: 0, skipped: 0, scoresUpdated: 0, drained: 0 };
    }
    syncLog(`drainInbox: ${rows.length} item(s) in inbox`);
    // Typed staging: rows are dispatched by payload.op. Legacy rows have no `op`
    // (bare {kind,data}) and are treated as captures, so they still drain.
    const captureChildren = [], scoreUpdates = [];
    for (const r of rows) {
      const p = r.payload; if (!p) continue;
      if (p.op === 'score') { if (p.reddit_id) scoreUpdates.push({ redditId: p.reddit_id, score: p.score }); }
      else captureChildren.push(p);
    }
    const { added, skipped } = captureChildren.length
      ? await ingestChildren(captureChildren, 'bookmarklet')
      : { added: 0, skipped: 0 };
    const scoresUpdated = scoreUpdates.length ? await applyScoreUpdates(scoreUpdates) : 0;

    // Clear everything we pulled (new + already-known) so the inbox stays empty.
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await supabaseFetch(`/reddit_inbox?id=in.(${chunk.join(',')})`, 'DELETE');
    }

    const ts = new Date().toISOString();
    await db.config.put({ key: 'lastBookmarkletSync', value: ts });
    state.lastBookmarkletSync = ts;
    state.bookmarkletResult = { added, skipped, scoresUpdated, drained: rows.length };
    syncLog(`drainInbox: imported ${added} new, ${skipped} already saved, ${scoresUpdated} score(s) updated, cleared ${rows.length}`, 'ok');

    if (added > 0 || scoresUpdated > 0) await loadData();
    render();
    // Toast on manual runs always, and on quiet (startup/foreground) runs only
    // when something actually changed — so silent drains stay silent.
    if (manual || added > 0 || scoresUpdated > 0) {
      const parts = [];
      if (added) parts.push(`${added} new item${added !== 1 ? 's' : ''}`);
      if (scoresUpdated) parts.push(`${scoresUpdated} score${scoresUpdated !== 1 ? 's' : ''} updated`);
      showToast(parts.length ? `Imported ${parts.join(' · ')} from bookmarklet` : 'Nothing new from bookmarklet', 'success');
    }
    return { added, skipped, scoresUpdated, drained: rows.length };
  } catch (e) {
    syncLog(`drainInbox: failed — ${e.message}`, 'error');
    if (manual) { state.bookmarkletResult = { error: e.message }; render(); showToast('Inbox import failed', 'error'); }
    return { added: 0, skipped: 0, scoresUpdated: 0, drained: 0, error: e.message };
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
  const { added, skipped } = await ingestChildren(children, 'bookmarklet');
  const ts = new Date().toISOString();
  await db.config.put({ key: 'lastBookmarkletSync', value: ts });
  state.lastBookmarkletSync = ts;
  state.bookmarkletResult = { added, skipped, scoresUpdated: 0, drained: children.length };
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

// Capture bookmarklet. Runs same-origin on reddit.com using the user's session
// cookie, fetches their saved listing, and POSTs the raw items to the
// reddit_inbox staging table — never to reddit_saves directly. The app drains
// the inbox through its normal ingest. On any POST failure it falls back to
// copying the items to the clipboard for manual "Paste captured items" import,
// so a network/RLS hiccup never loses the fetched data.
export function buildInboxBookmarklet(supabaseUrl, supabaseKey, expectUser) {
  const u = String(supabaseUrl || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const k = String(supabaseKey || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const x = String(expectUser || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Built as a string; uses only single quotes (no double quotes, no backticks),
  // so nothing needs escaping when the href is escHtml-escaped at render time.
  // Banners use the done() helper (textContent + a real Close button) instead of
  // innerHTML with inline onclick — keeps the bookmarklet quote-free and robust.
  // Tapping it shows a menu: ① Capture new saves, ② Refresh scores. Each op
  // starts on a fresh button gesture (so window.open for login isn't blocked).
  // EX = expected Reddit username (optional); the bookmarklet checks the logged-in
  // account against it via /api/me.json before showing the menu.
  return "javascript:(async()=>{" +
    "var U='" + u + "',K='" + k + "',EX='" + x + "';" +
    "var o=document.createElement('div');o.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a1b;color:#fff;font:14px/1.6 -apple-system,sans-serif;padding:12px 16px;box-shadow:0 2px 10px rgba(0,0,0,.5)';document.body.appendChild(o);" +
    "var say=function(m){o.textContent=m};" +
    "var clo=function(){o.remove()};" +
    "var btn=function(label,bg){var b=document.createElement('button');b.textContent=label;b.style.cssText='margin:8px 8px 0 0;padding:8px 14px;border:0;border-radius:6px;background:'+(bg||'#4f46e5')+';color:#fff;cursor:pointer;font:inherit';o.appendChild(b);return b};" +
    "var done=function(msg){o.textContent=msg;btn('Close','#555').onclick=clo};" +
    // Wrong-context guards (bookmarklets can't survive a navigation, so we tell
    // the user to tap the bookmark again once the right page has loaded).
    "if(!/(^|\\.)reddit\\.com$/.test(location.hostname)){say('RedditVault: open Reddit first, then tap the bookmark again.');btn('Go to old.reddit.com').onclick=function(){location.href='https://old.reddit.com/'};return;}" +
    "if(location.hostname!=='old.reddit.com'){say('RedditVault needs old.reddit.com (new Reddit blocks the save). Tap below, then tap the bookmark again.');btn('Switch to old.reddit.com').onclick=function(){location.href='https://old.reddit.com'+location.pathname};btn('Close','#555').onclick=clo;return;}" +
    "var needLogin=function(){say('RedditVault: you are logged out of Reddit.');btn('Log in to Reddit').onclick=function(){window.open('https://old.reddit.com/login','_blank')};btn('Close','#555').onclick=clo};" +
    // ── Op 1: capture new saves (incremental, same as before) ──
    "async function capture(){" +
      "say('RedditVault: checking what is new…');" +
      "var known=new Set();" +
      "try{var kr=await fetch(U+'/rest/v1/reddit_saves?select=reddit_id&order=saved_at.desc&limit=500',{headers:{apikey:K,Authorization:'Bearer '+K}});if(kr.ok){var ka=await kr.json();for(var n=0;n<ka.length;n++)known.add(ka[n].reddit_id);}}catch(e){}" +
      "var rows=[],kids=[],after=null,page=0,seen=0;" +
      "try{while(page<40){" +
        "var res=await fetch('/user/me/saved.json?limit=100&raw_json=1'+(after?'&after='+after:''),{credentials:'include',headers:{'Accept':'application/json'}});" +
        "if(res.status===401||res.status===403){needLogin();return;}" +
        "if(res.status===429){say('Rate limited — waiting 5s…');await new Promise(function(r){setTimeout(r,5000)});continue;}" +
        "if(!res.ok){say('⚠️ Reddit error '+res.status+'. Try again shortly.');return;}" +
        "var data=await res.json(),ch=(data&&data.data&&data.data.children)||[];if(!ch.length)break;" +
        "var fresh=0;" +
        "for(var i=0;i<ch.length;i++){var d=ch[i].data,rid=d.name||d.id;seen++;if(known.has(rid))continue;fresh++;var slim={kind:ch[i].kind,data:{name:d.name,id:d.id,title:d.title,link_title:d.link_title,author:d.author,subreddit:d.subreddit,url:d.url,permalink:d.permalink,body:d.body,selftext:d.selftext,score:d.score,created_utc:d.created_utc}};kids.push(slim);rows.push({reddit_id:rid,payload:slim});}" +
        "page++;say('Scanned '+seen+' saves — '+rows.length+' new…');" +
        "after=data.data.after;if(!after)break;" +
        "if(fresh===0)break;" +
        "await new Promise(function(r){setTimeout(r,1000)});" +
      "}}catch(e){say('⚠️ Could not read saves: '+e.message);return;}" +
      "if(!rows.length){done('✅ Already up to date — no new saves.');return;}" +
      "say('Sending '+rows.length+' new saves to your vault inbox…');" +
      "try{for(var j=0;j<rows.length;j+=100){var b=rows.slice(j,j+100);" +
        "var pr=await fetch(U+'/rest/v1/reddit_inbox?on_conflict=reddit_id',{method:'POST',headers:{'Content-Type':'application/json',apikey:K,Authorization:'Bearer '+K,Prefer:'resolution=ignore-duplicates'},body:JSON.stringify(b)});" +
        "if(!pr.ok){throw new Error(pr.status+' '+(await pr.text()).slice(0,140));}say('Sent '+Math.min(j+100,rows.length)+'/'+rows.length+'…');}" +
        "done('✅ Captured '+rows.length+' new saves. Open RedditVault — it imports them automatically.');" +
      "}catch(e){" +
        "var env=JSON.stringify({type:'rv-bookmarklet',v:1,children:kids});" +
        "o.textContent='⚠️ Could not reach your vault inbox ('+e.message+'). Copy your saves and paste them into RedditVault instead:';" +
        "var cb=document.createElement('button');cb.textContent='Copy '+rows.length+' items';cb.style.cssText='margin-left:8px;padding:6px 12px;border:0;border-radius:6px;background:#4f46e5;color:#fff;cursor:pointer';" +
        "cb.onclick=function(){navigator.clipboard.writeText(env).then(function(){cb.textContent='✓ Copied — paste in RedditVault'}).catch(function(){var t=document.createElement('textarea');t.value=env;t.style.cssText='display:block;width:100%;height:80px;margin-top:8px';o.appendChild(t);t.focus();t.select()})};" +
        "o.appendChild(cb);" +
      "}" +
    "}" +
    // ── Op 2: refresh scores for EVERY active item in the vault ──
    // Pages the whole active list via Supabase Range headers (1000/page), then
    // batches through Reddit /api/info (100 ids/call) and flushes score rows to
    // the inbox per batch — so an interrupted run still stages its progress.
    "async function refresh(){" +
      // How many recent saves to check is an app setting, read live from
      // user_preferences (0 = all). Defaults to 500 if unset/unreadable.
      "var LIM=500;" +
      "try{var lr=await fetch(U+'/rest/v1/user_preferences?key=eq.scoreRefreshLimit&select=value',{headers:{apikey:K,Authorization:'Bearer '+K}});if(lr.ok){var la=await lr.json();if(la.length){var lv=la[0].value;var pv=(typeof lv==='number')?lv:parseInt(lv,10);if(!isNaN(pv)&&pv>=0)LIM=pv;}}}catch(e){}" +
      "var scope=LIM>0?('most recent '+LIM):'entire';" +
      "say('RedditVault: loading your '+scope+' saved items…');" +
      "var ids=[],from=0,PG=1000;" +
      "try{while(true){" +
        "var want=(LIM>0)?Math.min(PG,LIM-ids.length):PG;if(want<=0)break;" +
        "var rr=await fetch(U+'/rest/v1/reddit_saves?select=reddit_id&deleted_at=is.null&order=saved_at.desc',{headers:{apikey:K,Authorization:'Bearer '+K,Range:from+'-'+(from+want-1),'Range-Unit':'items'}});" +
        "if(rr.status!==200&&rr.status!==206){done('⚠️ Could not read your vault list ('+rr.status+').');return;}" +
        "var ja=await rr.json();for(var i=0;i<ja.length;i++)ids.push(ja[i].reddit_id);" +
        "say('Loading your item list… '+ids.length);" +
        "if(ja.length<want)break;from+=want;if(LIM>0&&ids.length>=LIM)break;" +
      "}}catch(e){done('⚠️ Could not reach your vault ('+e.message+').');return;}" +
      "if(!ids.length){done('Nothing to refresh.');return;}" +
      "var sent=0,checked=0;" +
      "try{for(var j=0;j<ids.length;j+=100){" +
        "var batch=ids.slice(j,j+100);" +
        "var res=await fetch('/api/info.json?id='+batch.join(',')+'&raw_json=1',{credentials:'include',headers:{'Accept':'application/json'}});" +
        "if(res.status===401||res.status===403){needLogin();return;}" +
        "if(res.status===429){say('Rate limited — waiting 5s…');await new Promise(function(r){setTimeout(r,5000)});j-=100;continue;}" +
        "if(!res.ok){say('⚠️ Reddit error '+res.status+'. '+sent+' sent so far. Try again shortly.');return;}" +
        "var data=await res.json(),ch=(data&&data.data&&data.data.children)||[],rows=[];" +
        "for(var m=0;m<ch.length;m++){var d=ch[m].data;if(d&&d.name&&typeof d.score==='number'){rows.push({reddit_id:'score:'+d.name,payload:{op:'score',reddit_id:d.name,score:d.score}});}}" +
        "if(rows.length){var pr=await fetch(U+'/rest/v1/reddit_inbox?on_conflict=reddit_id',{method:'POST',headers:{'Content-Type':'application/json',apikey:K,Authorization:'Bearer '+K,Prefer:'resolution=ignore-duplicates'},body:JSON.stringify(rows)});if(!pr.ok){done('⚠️ Could not reach your vault inbox ('+pr.status+'). '+sent+' sent so far; re-run on old.reddit.com to finish.');return;}sent+=rows.length;}" +
        "checked=Math.min(j+100,ids.length);say('Checked '+checked+'/'+ids.length+' items — '+sent+' scores sent…');" +
        "if(j+100<ids.length)await new Promise(function(r){setTimeout(r,1000)});" +
      "}}catch(e){done('⚠️ Could not refresh scores: '+e.message+' ('+sent+' sent so far).');return;}" +
      "if(!sent){done('No score changes to send.');return;}" +
      "done('✅ Queued '+sent+' score updates. Open RedditVault — it applies them automatically.');" +
    "}" +
    // ── Account check (verify the right Reddit user is logged in) ──
    "var me=null;" +
    "try{var mr=await fetch('/api/me.json',{credentials:'include',headers:{'Accept':'application/json'}});if(mr.status===401||mr.status===403){needLogin();return;}if(mr.ok){var mj=await mr.json();me=(mj&&mj.data&&mj.data.name)||(mj&&mj.name)||null;}}catch(e){}" +
    "if(!me){needLogin();return;}" +
    "var who='Logged in as u/'+me;" +
    // ── Menu ──
    "var menu=function(){say('RedditVault — '+who+'. Choose an action:');btn('① Capture new saves').onclick=function(){capture()};btn('② Refresh scores').onclick=function(){refresh()};btn('Close','#555').onclick=clo};" +
    "if(EX&&me.toLowerCase()!==EX.toLowerCase()){say('⚠️ '+who+', but this vault belongs to u/'+EX+'. Switch Reddit accounts and tap the bookmark again, or continue anyway.');btn('Use anyway','#b45309').onclick=function(){menu()};btn('Close','#555').onclick=clo;}else{menu();}" +
  "})()";
}

