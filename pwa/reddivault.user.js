// ==UserScript==
// @name         RedditVault Capture
// @namespace    https://reddivault.vercel.app
// @version      1.0.0
// @description  Captures your Reddit saves into your RedditVault inbox while you browse Reddit, using your existing login. Only syncs the Reddit account your vault belongs to.
// @author       RedditVault
// @homepageURL  https://reddivault.vercel.app
// @match        https://*.reddit.com/*
// @match        https://reddit.com/*
// @run-at       document-idle
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM_setValue
// @grant        GM.registerMenuCommand
// @grant        GM_registerMenuCommand
// @connect      supabase.co
// @connect      reddit.com
// @connect      *
// @downloadURL  https://reddivault.vercel.app/reddivault.user.js
// @updateURL    https://reddivault.vercel.app/reddivault.user.js
// ==/UserScript==

// RedditVault capture userscript.
//
// Same protocol as the RedditVault bookmarklet: it reads your saved listing with
// your logged-in Reddit session and writes the raw items ONLY to the
// reddit_inbox staging table. RedditVault drains the inbox through its normal
// dedup-aware ingest — this script never touches reddit_saves.
//
// Why a userscript: its Supabase writes go through GM.xmlHttpRequest, which runs
// outside the page's Content-Security-Policy, so it works on new Reddit
// (www/sh) as well as old.reddit.com — and it runs by itself while you browse.
//
// Account binding: the script is paired to ONE Reddit username (your vault's).
// Every run checks the logged-in account first and does nothing on a mismatch;
// reads use /user/<vault user>/saved.json; the account is re-checked before
// every upload; and every inbox row carries `by` so RedditVault can reject rows
// from any other account.
//
// IMPORTANT for maintainers: bump @version (above) and VERSION (below) on every
// change, or userscript managers won't pick up the update.

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const CAPTURE_EVERY_MS = 30 * 60 * 1000;         // automatic capture: at most every 30 min per device
  const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;    // automatic refresh: once a day...
  const REFRESH_GLOBAL_MIN_MS = 20 * 60 * 60 * 1000; // ...across ALL devices (skip if another device ran it within 20h)
  const TIMER_MS = 5 * 60 * 1000;                  // re-check cadence for long single-page sessions
  const LOCK_MS = 3 * 60 * 1000;                   // cross-tab run lock lifetime
  const SEEN_MAX = 2000;                           // local "already sent" memory
  const KNOWN_LIMIT = 1000;                        // vault ids read when something looks new
  const PENDING_PER_RUN = 1000;                    // unenriched items refreshed per run
  const BATCH_ROWS = 100;                          // inbox upload batch: max rows...
  const BATCH_BYTES = 500 * 1024;                  // ...and max bytes
  const MAX_PAGES = 40;                            // 40 pages ≈ Reddit's ~1000-item listing cap
  const PAIR_PREFIX = 'RV1:';

  if (window.top !== window.self) return;
  if (document.contentType && document.contentType !== 'text/html') return; // skip raw JSON/media views

  // ─── GM API shim (GM4 promise API, falling back to legacy GM_*) ────────────
  const GMx = (typeof GM !== 'undefined' && GM) ? GM : null;

  async function gmGet(key, def) {
    try {
      if (GMx && GMx.getValue) return await GMx.getValue(key, def);
      if (typeof GM_getValue === 'function') return GM_getValue(key, def);
    } catch (e) { /* fall through */ }
    return def;
  }
  async function gmSet(key, value) {
    try {
      if (GMx && GMx.setValue) return await GMx.setValue(key, value);
      if (typeof GM_setValue === 'function') return GM_setValue(key, value);
    } catch (e) { /* ignore */ }
  }
  // Objects are stored as JSON strings — the most portable form across managers.
  async function gmGetJSON(key, def) {
    const raw = await gmGet(key, null);
    if (raw == null || raw === '') return def;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return def; }
  }
  function gmSetJSON(key, value) { return gmSet(key, JSON.stringify(value)); }

  function gmRequest({ method = 'GET', url, headers = {}, body = null, cookies = false }) {
    return new Promise((resolve, reject) => {
      const fn = (GMx && GMx.xmlHttpRequest) || (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
      if (!fn) { reject(new Error('GM.xmlHttpRequest is not available in this userscript manager')); return; }
      try {
        const r = fn({
          method, url, headers, data: body,
          anonymous: !cookies,
          timeout: 30000,
          onload: res => resolve({ status: res.status, text: res.responseText || '', headers: res.responseHeaders || '' }),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timed out')),
          onabort: () => reject(new Error('aborted')),
        });
        if (r && typeof r.catch === 'function') r.catch(reject); // some managers also return a promise
      } catch (e) { reject(e); }
    });
  }

  function registerMenu(name, fn) {
    try {
      if (GMx && GMx.registerMenuCommand) GMx.registerMenuCommand(name, fn);
      else if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(name, fn);
    } catch (e) { /* menu commands are optional — the badge covers everything */ }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lc = s => String(s || '').toLowerCase();

  class RvError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  // ─── Pairing / config ──────────────────────────────────────────────────────
  // Config {u: Supabase URL, k: anon key, x: vault's Reddit username} lives only
  // in userscript storage — never in this public file.
  function decodePairing(code) {
    const raw = String(code || '').trim();
    if (!raw.startsWith(PAIR_PREFIX)) throw new Error('That is not a RedditVault pairing code (it should start with RV1:)');
    let obj;
    try {
      const bin = atob(raw.slice(PAIR_PREFIX.length));
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
      obj = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { throw new Error('The pairing code is damaged — copy it again from RedditVault'); }
    const u = String(obj.u || '').replace(/\/+$/, '');
    const k = String(obj.k || '');
    const x = String(obj.x || '').trim().replace(/^\/?u\//i, '');
    let url;
    try { url = new URL(u); } catch (e) { throw new Error('The pairing code has an invalid database URL'); }
    if (url.protocol !== 'https:') throw new Error('The pairing code database URL must use https');
    if (!k) throw new Error('The pairing code has no database key');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(x)) throw new Error('The pairing code has no valid Reddit username — set it in RedditVault first');
    return { u, k, x };
  }

  async function loadConfig() {
    const cfg = await gmGetJSON('config', null);
    return cfg && cfg.u && cfg.k && cfg.x ? cfg : null;
  }

  async function applyPairing(code, { confirmFirst }) {
    let cfg;
    try { cfg = decodePairing(code); } catch (e) { toast(e.message, 'error', 8000); return false; }
    const host = new URL(cfg.u).host;
    if (confirmFirst && !window.confirm(`Pair the RedditVault userscript in this browser with the vault at ${host} for u/${cfg.x}?\n\nOnly continue if you started this from your own RedditVault.`)) {
      toast('Pairing cancelled', 'info');
      return false;
    }
    try {
      await sbGet(cfg, 'reddit_inbox?select=id&limit=1');
    } catch (e) {
      toast(`Paired, but the vault could not be reached yet: ${e.message}`, 'error', 9000);
    }
    const prev = await loadConfig();
    await gmSetJSON('config', cfg);
    if (!prev || prev.u !== cfg.u || lc(prev.x) !== lc(cfg.x)) {
      // A different vault or account: forget per-vault memory.
      await gmSetJSON('seen', []);
      await gmSet('lastCaptureAt', 0);
      await gmSet('lastRefreshAt', 0);
      await gmSetJSON('lastCapture', null);
      await gmSetJSON('lastRefresh', null);
    }
    const acct = await activeAccount().catch(() => ({}));
    if (acct.name && lc(acct.name) !== lc(cfg.x)) {
      toast(`Paired with u/${cfg.x}. You're logged in as u/${acct.name}, so syncing stays paused until you switch to u/${cfg.x}.`, 'warn', 10000);
      await setStatus({ kind: 'wrong', active: acct.name });
    } else {
      toast(`Paired with your vault for u/${cfg.x} ✓`, 'ok', 6000);
      await setStatus({ kind: 'ok' });
    }
    renderPanel();
    return true;
  }

  async function promptPairing() {
    const code = window.prompt('Paste your RedditVault pairing code\n(RedditVault → Settings → Capture New Saves → Copy pairing code)');
    if (code) await applyPairing(code, { confirmFirst: false });
  }

  // ─── Supabase (always via GM.xmlHttpRequest — immune to the page's CSP) ─────
  function vaultError(status, text) {
    if (status === 401 || status === 403) return new RvError('vault-auth', `Your vault rejected this device's key (HTTP ${status}) — pair this device again from RedditVault`);
    if (status === 404) return new RvError('vault-schema', 'Your vault is missing the reddit_inbox table (HTTP 404) — add it from supabase-schema.sql');
    return new RvError('vault', `Your vault database is unreachable (HTTP ${status || 'no response'}). If your Supabase project is paused, restore it in the Supabase dashboard — nothing is lost, it retries automatically`);
  }

  async function sbRaw(cfg, method, path, { body = null, headers = {} } = {}) {
    try {
      return await gmRequest({
        method,
        url: `${cfg.u}/rest/v1/${path}`,
        headers: { apikey: cfg.k, Authorization: `Bearer ${cfg.k}`, 'Content-Type': 'application/json', ...headers },
        body: body == null ? null : JSON.stringify(body),
      });
    } catch (e) {
      throw vaultError(0, e.message);
    }
  }
  async function sbGet(cfg, path, headers = {}) {
    const res = await sbRaw(cfg, 'GET', path, { headers });
    if (res.status !== 200 && res.status !== 206) throw vaultError(res.status, res.text);
    try { return JSON.parse(res.text || '[]'); } catch (e) { throw vaultError(res.status, 'invalid JSON'); }
  }
  async function sbInsertInbox(cfg, rows) {
    const res = await sbRaw(cfg, 'POST', 'reddit_inbox?on_conflict=reddit_id', {
      body: rows,
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    });
    if (res.status < 200 || res.status >= 300) throw vaultError(res.status, res.text);
  }
  async function sbSetPreference(cfg, key, value) {
    const now = new Date().toISOString();
    const res = await sbRaw(cfg, 'POST', 'user_preferences?on_conflict=key', {
      body: [{ key, value, updated_at: now }],
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    if (res.status < 200 || res.status >= 300) throw vaultError(res.status, res.text);
  }
  async function sbGetPreference(cfg, key) {
    const rows = await sbGet(cfg, `user_preferences?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows.length ? rows[0].value : null;
  }
  async function inboxCount(cfg) {
    const res = await sbRaw(cfg, 'GET', 'reddit_inbox?select=id', { headers: { Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' } });
    const m = /content-range:\s*[^\r\n/]*\/(\d+)/i.exec(res.headers || '');
    if (m) return parseInt(m[1], 10);
    if (res.status === 200 || res.status === 206) {
      try { return JSON.parse(res.text || '[]').length; } catch (e) { /* fall through */ }
    }
    return null;
  }

  // ─── Reddit (your logged-in session) ───────────────────────────────────────
  // Same-origin fetch first (behaves exactly like the page); if the manager's
  // sandbox makes that fail, fall back to GM.xmlHttpRequest with cookies.
  async function redditGet(path) {
    const url = location.origin + path;
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (res.status === 429 || res.status === 401 || res.status === 403 || res.status === 404) return { status: res.status };
      if (res.ok) {
        const text = await res.text();
        try { return { status: res.status, json: JSON.parse(text) }; } catch (e) { /* not JSON — try the fallback */ }
      }
    } catch (e) { /* sandboxed fetch failed — try the fallback */ }
    const r = await gmRequest({ url, headers: { Accept: 'application/json' }, cookies: true });
    if (r.status === 200) {
      try { return { status: 200, json: JSON.parse(r.text) }; } catch (e) { return { status: 0 }; }
    }
    return { status: r.status };
  }

  async function activeAccount() {
    const r = await redditGet('/api/me.json');
    if (r.status === 401 || r.status === 403) return { loggedOut: true };
    if (!r.json) return { error: `Reddit /api/me.json returned HTTP ${r.status}` };
    const name = (r.json.data && r.json.data.name) || r.json.name || null;
    return name ? { name } : { loggedOut: true };
  }

  async function redditInfo(ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await redditGet(`/api/info.json?id=${ids.join(',')}&raw_json=1`);
      if (r.status === 429) { await sleep(5000); continue; }
      if (r.status === 401 || r.status === 403) throw new RvError('loggedout', 'Reddit logged you out during the refresh');
      if (!r.json) throw new RvError('reddit', `Reddit error ${r.status}`);
      return (r.json.data && r.json.data.children) || [];
    }
    throw new RvError('reddit', 'Reddit kept rate limiting — will try again later');
  }

  // Same slim shape as the bookmarklet, plus `by` (the capturing account).
  function slim(c, by) {
    const d = c.data;
    return {
      kind: c.kind,
      data: {
        name: d.name, id: d.id, title: d.title, link_title: d.link_title, author: d.author,
        subreddit: d.subreddit, url: d.url, permalink: d.permalink, body: d.body,
        selftext: d.selftext, score: d.score, created_utc: d.created_utc,
      },
      by,
    };
  }

  // Split rows into upload batches capped by count AND size.
  function makeBatches(rows) {
    const out = [];
    let cur = [], bytes = 0;
    for (const row of rows) {
      const size = JSON.stringify(row).length;
      if (cur.length && (cur.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
      cur.push(row); bytes += size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // ─── Account gate (runs before EVERY capture/refresh, manual or automatic) ──
  async function gate(cfg) {
    const acct = await activeAccount();
    if (acct.error) return { ok: false, kind: 'error', msg: acct.error };
    if (acct.loggedOut) return { ok: false, kind: 'loggedout' };
    if (lc(acct.name) !== lc(cfg.x)) {
      // The vault's username may have been changed in RedditVault since pairing.
      try {
        const live = String((await sbGetPreference(cfg, 'redditUsername')) || '').trim().replace(/^\/?u\//i, '');
        if (live && lc(live) !== lc(cfg.x)) { cfg.x = live; await gmSetJSON('config', cfg); }
      } catch (e) { /* vault unreachable — keep the paired name */ }
    }
    if (lc(acct.name) !== lc(cfg.x)) return { ok: false, kind: 'wrong', active: acct.name };
    return { ok: true, active: acct.name };
  }

  async function onGateFail(g, cfg, manual) {
    await setStatus({ kind: g.kind, active: g.active || null, msg: g.msg || null });
    if (g.kind === 'wrong') {
      const warned = await gmGet('lastWarnedAccount', '');
      if (manual || lc(warned) !== lc(g.active)) {
        toast(`RedditVault: you're logged in as u/${g.active}, but this vault belongs to u/${cfg.x}. Syncing is paused until you switch accounts.`, 'warn', 9000);
        await gmSet('lastWarnedAccount', g.active);
      }
    } else if (g.kind === 'loggedout') {
      if (manual) toast('RedditVault: log in to Reddit as u/' + cfg.x + ' to sync', 'warn', 7000);
    } else if (manual) {
      toast('RedditVault: ' + (g.msg || 'could not check your Reddit account'), 'error', 7000);
    }
  }

  // ─── Seen set (ids already sent or already in the vault) ───────────────────
  async function loadSeen() { return new Set(await gmGetJSON('seen', [])); }
  async function addSeen(ids) {
    if (!ids.length) return;
    const arr = await gmGetJSON('seen', []);
    const set = new Set(arr);
    const fresh = ids.filter(id => !set.has(id));
    await gmSetJSON('seen', fresh.concat(arr).slice(0, SEEN_MAX));
  }

  // ─── Capture ───────────────────────────────────────────────────────────────
  // A quiet run (nothing new) costs one small Reddit request and zero Supabase
  // calls. Only when something looks new does it read the vault's recent ids to
  // filter, then it uploads the genuinely new saves. Ids are marked seen only
  // after their batch was accepted, so a failed upload is retried next run.
  async function capture(cfg, by, progress) {
    const seen = await loadSeen();
    let known = null;
    const fresh = [], freshIds = new Set(), alreadyInVault = [];
    let after = null, page = 0, scanned = 0, rateLimited = 0;
    while (page < MAX_PAGES) {
      const limit = page === 0 ? 25 : 100;
      const r = await redditGet(`/user/${encodeURIComponent(cfg.x)}/saved.json?limit=${limit}&raw_json=1${after ? '&after=' + encodeURIComponent(after) : ''}`);
      if (r.status === 429) {
        if (++rateLimited > 2) throw new RvError('reddit', 'Reddit is rate limiting — will try again later');
        progress('Reddit is rate limiting, waiting…');
        await sleep(5000);
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new RvError('reddit-denied', `Reddit refused access to the saves of u/${cfg.x} (HTTP ${r.status}) — are you logged in as u/${cfg.x}?`);
      if (!r.json) throw new RvError('reddit', `Reddit error ${r.status} while reading your saves`);
      const children = (r.json.data && r.json.data.children) || [];
      if (!children.length) break;
      scanned += children.length;
      const unseen = children.filter(c => c.data && c.data.name && !seen.has(c.data.name) && !freshIds.has(c.data.name));
      if (unseen.length && known === null) {
        progress('Checking your vault…');
        known = new Set((await sbGet(cfg, `reddit_saves?select=reddit_id&order=saved_at.desc&limit=${KNOWN_LIMIT}`)).map(row => row.reddit_id));
      }
      let pageFresh = 0;
      for (const c of unseen) {
        const id = c.data.name;
        if (known && known.has(id)) { alreadyInVault.push(id); continue; }
        fresh.push(slim(c, by)); freshIds.add(id); pageFresh++;
      }
      progress(`Scanned ${scanned} saves — ${fresh.length} new…`);
      page++;
      after = r.json.data && r.json.data.after;
      if (!after || pageFresh === 0) break; // reached saves we already have
      await sleep(1000);
    }
    await addSeen(alreadyInVault);
    if (!fresh.length) return { sent: 0 };

    let sent = 0;
    for (const batch of makeBatches(fresh.map(s => ({ reddit_id: s.data.name, payload: s })))) {
      // Re-check right before data leaves the page: closes the account-switch race.
      const acct = await activeAccount();
      if (!acct.name || lc(acct.name) !== lc(cfg.x)) {
        throw new RvError('switched', `Your Reddit account changed during the sync, so it stopped${sent ? ` after sending ${sent}` : ' before sending anything'}. Switch back to u/${cfg.x} to continue.`);
      }
      await sbInsertInbox(cfg, batch);
      await addSeen(batch.map(row => row.reddit_id));
      sent += batch.length;
      progress(`Sent ${sent}/${fresh.length} new saves…`);
    }
    return { sent };
  }

  // ─── Refresh scores & details ──────────────────────────────────────────────
  // Unenriched (pending) vault items get their full details (op meta, or a
  // missing marker); the most recent N items (RedditVault's "Refresh scores"
  // setting) get a score row only when the score changed. /api/info returns
  // public data, so this never reads anything account-private.
  async function refresh(cfg, by, progress) {
    let lim = 500;
    try {
      const v = await sbGetPreference(cfg, 'scoreRefreshLimit');
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      if (!isNaN(n) && n >= 0) lim = n;
    } catch (e) { /* default */ }

    progress('Loading your vault…');
    const have = new Map(), order = [];
    for (let from = 0; ;) {
      const want = lim > 0 ? Math.min(1000, lim - order.length) : 1000;
      if (want <= 0) break;
      const rows = await sbGet(cfg, 'reddit_saves?select=reddit_id,score&deleted_at=is.null&order=saved_at.desc',
        { Range: `${from}-${from + want - 1}`, 'Range-Unit': 'items' });
      for (const row of rows) { have.set(row.reddit_id, row.score); order.push(row.reddit_id); }
      if (rows.length < want) break;
      from += want;
    }
    const pending = (await sbGet(cfg, `reddit_saves?select=reddit_id&enrich_status=eq.pending&deleted_at=is.null&order=saved_at.desc&limit=${PENDING_PER_RUN}`))
      .map(row => row.reddit_id);
    const isPending = new Set(pending);
    const ids = pending.concat(order.filter(id => !isPending.has(id)));

    let scores = 0, details = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const children = await redditInfo(batch);
      const got = new Map(), needTitle = new Set();
      for (const c of children) {
        const d = c.data;
        if (!d || !d.name) continue;
        got.set(d.name, c);
        if (isPending.has(d.name) && c.kind === 't1' && !d.link_title && d.link_id) needTitle.add(d.link_id);
      }
      // Comments from /api/info may lack the parent-post title: one extra call per batch.
      if (needTitle.size) {
        const parents = await redditInfo([...needTitle]);
        const titles = new Map(parents.filter(p => p.data).map(p => [p.data.name, p.data.title]));
        for (const c of got.values()) {
          const d = c.data;
          if (!d.link_title && d.link_id && titles.has(d.link_id)) d.link_title = titles.get(d.link_id);
        }
      }
      const rows = [];
      for (const id of batch) {
        const c = got.get(id);
        if (isPending.has(id)) {
          rows.push({ reddit_id: 'meta:' + id, payload: c ? { op: 'meta', reddit_id: id, child: slim(c, by), by } : { op: 'meta', reddit_id: id, missing: true, by } });
          details++;
        } else if (c && typeof c.data.score === 'number' && c.data.score !== have.get(id)) {
          rows.push({ reddit_id: 'score:' + id, payload: { op: 'score', reddit_id: id, score: c.data.score, by } });
          scores++;
        }
      }
      for (const b of makeBatches(rows)) await sbInsertInbox(cfg, b);
      progress(`Checked ${Math.min(i + 100, ids.length)}/${ids.length} — ${scores} score changes, ${details} details…`);
      if (i + 100 < ids.length) await sleep(1000);
    }
    return { scores, details };
  }

  // ─── Cross-tab run lock ────────────────────────────────────────────────────
  const TAB_ID = Math.random().toString(36).slice(2);
  async function acquireLock() {
    const now = Date.now();
    const lock = await gmGetJSON('lock', null);
    if (lock && lock.until > now && lock.owner !== TAB_ID) return false;
    await gmSetJSON('lock', { owner: TAB_ID, until: now + LOCK_MS });
    await sleep(60);
    const check = await gmGetJSON('lock', null);
    return !!check && check.owner === TAB_ID;
  }
  async function releaseLock() {
    const lock = await gmGetJSON('lock', null);
    if (lock && lock.owner === TAB_ID) await gmSetJSON('lock', { owner: '', until: 0 });
  }

  // ─── Runners ───────────────────────────────────────────────────────────────
  let busy = false;

  async function handleRunError(e, manual) {
    const msg = e && e.message ? e.message : String(e);
    const kind = e && e.kind === 'switched' ? 'wrong' : 'error';
    await setStatus({ kind, msg });
    toast('RedditVault: ' + msg, kind === 'wrong' ? 'warn' : 'error', manual ? 9000 : 7000);
  }

  async function runCapture({ manual = false, banner = false } = {}) {
    const cfg = await loadConfig();
    if (!cfg) { await setStatus({ kind: 'unpaired' }); if (manual) { toast('RedditVault: pair this browser first', 'warn'); openPanel(); } return; }
    if (busy || !(await acquireLock())) { if (manual) toast('RedditVault: a sync is already running', 'info'); return; }
    busy = true; setBusyUi('Checking your Reddit account…');
    try {
      await gmSet('lastCaptureAt', Date.now()); // throttles automatic runs, including paused/failed ones
      const g = await gate(cfg);
      if (!g.ok) { await onGateFail(g, cfg, manual); return; }
      await gmSet('lastWarnedAccount', '');
      const res = await capture(cfg, g.active, setBusyUi);
      await gmSetJSON('lastCapture', { at: Date.now(), sent: res.sent });
      await setStatus({ kind: 'ok' });
      if (res.sent) {
        toast(`RedditVault: captured ${res.sent} new save${res.sent !== 1 ? 's' : ''}${banner ? ' — switch back to RedditVault to import them' : ' — RedditVault imports them when you open it'}`, 'ok', banner ? 12000 : 5000);
      } else if (manual) {
        toast(`RedditVault: already up to date — no new saves${banner ? '. You can switch back to RedditVault.' : ''}`, 'ok', banner ? 9000 : 4500);
      }
    } catch (e) {
      await gmSetJSON('lastCapture', { at: Date.now(), sent: 0, error: e.message });
      await handleRunError(e, manual);
    } finally {
      busy = false; setBusyUi(null); await releaseLock(); renderPanel();
    }
  }

  async function runRefresh({ manual = false } = {}) {
    const cfg = await loadConfig();
    if (!cfg) { await setStatus({ kind: 'unpaired' }); if (manual) { toast('RedditVault: pair this browser first', 'warn'); openPanel(); } return; }
    if (busy || !(await acquireLock())) { if (manual) toast('RedditVault: a sync is already running', 'info'); return; }
    busy = true; setBusyUi('Checking your Reddit account…');
    try {
      await gmSet('lastRefreshAt', Date.now());
      const g = await gate(cfg);
      if (!g.ok) { await onGateFail(g, cfg, manual); return; }
      if (!manual) {
        // Coordinate across devices: only one paired device refreshes per day.
        const last = Date.parse((await sbGetPreference(cfg, 'userscriptLastRefreshAt')) || '');
        if (!isNaN(last) && Date.now() - last < REFRESH_GLOBAL_MIN_MS) return;
      }
      await sbSetPreference(cfg, 'userscriptLastRefreshAt', new Date().toISOString());
      const res = await refresh(cfg, g.active, setBusyUi);
      await gmSetJSON('lastRefresh', { at: Date.now(), scores: res.scores, details: res.details });
      await setStatus({ kind: 'ok' });
      if (res.scores || res.details) {
        toast(`RedditVault: queued ${res.scores} score change${res.scores !== 1 ? 's' : ''} and ${res.details} detail refresh${res.details !== 1 ? 'es' : ''}`, 'ok', 5000);
      } else if (manual) {
        toast('RedditVault: scores and details are already current', 'ok');
      }
    } catch (e) {
      await gmSetJSON('lastRefresh', { at: Date.now(), scores: 0, details: 0, error: e.message });
      await handleRunError(e, manual);
    } finally {
      busy = false; setBusyUi(null); await releaseLock(); renderPanel();
    }
  }

  // Automatic schedule: only in a visible tab, throttled per device.
  async function maybeRun() {
    if (document.visibilityState !== 'visible' || busy) return;
    ensureMounted();
    if (!(await loadConfig())) { await setStatus({ kind: 'unpaired' }); return; }
    if (Date.now() - (await gmGet('lastCaptureAt', 0)) >= CAPTURE_EVERY_MS) await runCapture();
    if (Date.now() - (await gmGet('lastRefreshAt', 0)) >= REFRESH_EVERY_MS) await runRefresh();
  }

  // ─── Hash triggers (deep links from RedditVault) ───────────────────────────
  function clearHash() {
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  async function handleHash() {
    const h = location.hash || '';
    if (h.startsWith('#rv-pair=')) {
      let code = h.slice('#rv-pair='.length);
      try { code = decodeURIComponent(code); } catch (e) { /* use as-is */ }
      clearHash(); // never leave the key sitting in the address bar
      if (await applyPairing(code, { confirmFirst: true })) await runCapture({ manual: true });
      return true;
    }
    if (h === '#rv-capture') { clearHash(); await runCapture({ manual: true, banner: true }); return true; }
    if (h === '#rv-refresh') { clearHash(); await runRefresh({ manual: true }); return true; }
    if (h === '#rv-show') {
      clearHash();
      await gmSet('hidden', false);
      ensureMounted(); renderBadge();
      toast('RedditVault button restored', 'ok');
      return true;
    }
    return false;
  }

  // ─── Status ────────────────────────────────────────────────────────────────
  async function setStatus(s) {
    await gmSetJSON('status', { ...s, at: Date.now() });
    renderBadge(); renderPanel();
  }

  // ─── UI: badge + panel + toast (shadow DOM, CSSOM styles only) ─────────────
  // Styles are applied through element.style (CSSOM), which page CSPs don't
  // block, inside a closed shadow root so Reddit's CSS can't interfere.
  let host = null, root = null, badge = null, badgeDot = null, panel = null, toastBox = null;
  let busyText = null, spinTimer = null, panelOpen = false, liveInfo = null;
  const SPIN = ['◐', '◓', '◑', '◒'];
  const C = { bg: '#1a1a1b', fg: '#f5f5f5', muted: '#a8a8ad', border: '#3a3a3c', accent: '#ff4500', btn: '#4f46e5', ok: '#22c55e', warn: '#f59e0b', err: '#ef4444', idle: '#6b7280' };

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(label, onClick, { bg = C.btn, disabled = false } = {}) {
    const b = el('button', `all:initial;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff;background:${bg};border-radius:7px;padding:8px 11px;margin:6px 6px 0 0;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? '0.45' : '1'};display:inline-block`, label);
    b.type = 'button';
    if (disabled) b.disabled = true;
    else b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  function ensureMounted() {
    if (host && host.isConnected) return;
    host = el('div', 'all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0');
    host.setAttribute('data-reddivault', 'userscript');
    root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    badge = null; panel = null; toastBox = null;
    renderBadge();
  }

  function cornerCss(corner, offset) {
    const narrow = window.innerWidth < 700;
    const v = corner[0] === 't'
      ? `top:calc(${narrow ? 64 : 72}px + ${offset}px)`
      : `bottom:calc(${narrow ? 84 : 20}px + ${offset}px + env(safe-area-inset-bottom, 0px))`;
    const h = corner[1] === 'l' ? 'left:16px' : 'right:16px';
    return `${v};${h}`;
  }

  // All storage reads happen before the DOM swap, and the swap itself is
  // synchronous, so overlapping renders can never leave two badges behind.
  async function renderBadge() {
    if (!root) return;
    const hidden = await gmGet('hidden', false);
    const corner = await gmGet('corner', 'br');
    const status = (await gmGetJSON('status', null)) || { kind: (await loadConfig()) ? 'ok' : 'unpaired' };
    if (badge) { badge.remove(); badge = null; }
    if (hidden) return;
    const color = busyText ? C.btn : ({ ok: C.ok, wrong: C.warn, loggedout: C.warn, error: C.err, unpaired: C.idle }[status.kind] || C.idle);
    badge = el('button', `all:initial;position:fixed;${cornerCss(corner, 0)};width:42px;height:42px;border-radius:50%;background:${C.bg};color:${C.fg};border:2px solid ${color};box-shadow:0 2px 10px rgba(0,0,0,.45);font:800 13px/42px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;text-align:center;cursor:pointer;opacity:.92`);
    badge.type = 'button';
    badge.setAttribute('aria-label', 'RedditVault sync');
    badge.title = 'RedditVault — tap for sync controls';
    badge.textContent = 'RV';
    badgeDot = el('span', `all:initial;position:absolute;right:-3px;top:-3px;min-width:16px;height:16px;border-radius:8px;background:${color};color:#fff;font:700 11px/16px -apple-system,sans-serif;text-align:center;padding:0 2px`,
      busyText ? SPIN[0] : ({ ok: '✓', wrong: '!', loggedout: '!', error: '✗', unpaired: '?' }[status.kind] || '?'));
    badge.appendChild(badgeDot);
    badge.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); panelOpen ? closePanel() : openPanel(); });
    root.appendChild(badge);
  }

  function setBusyUi(text) {
    busyText = text;
    if (text && !spinTimer) {
      let i = 0;
      spinTimer = setInterval(() => { if (badgeDot) badgeDot.textContent = SPIN[++i % SPIN.length]; }, 180);
      renderBadge();
    } else if (!text && spinTimer) {
      clearInterval(spinTimer); spinTimer = null;
      renderBadge();
    }
    if (panelOpen && panel) {
      const line = panel.querySelector('[data-rv="progress"]');
      if (line) line.textContent = text || '';
      else renderPanel();
    }
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  async function openPanel() {
    ensureMounted();
    panelOpen = true;
    liveInfo = { checking: true };
    await renderPanel();
    // Fresh look at the account and inbox every time the panel opens.
    const cfg = await loadConfig();
    if (!cfg) { liveInfo = null; await renderPanel(); return; }
    const [acct, count] = await Promise.all([
      activeAccount().catch(e => ({ error: e.message })),
      inboxCount(cfg).catch(() => null),
    ]);
    liveInfo = { acct, count };
    await renderPanel();
  }
  function closePanel() {
    panelOpen = false; liveInfo = null;
    if (panel) { panel.remove(); panel = null; }
  }

  async function renderPanel() {
    if (!root) return;
    if (!panelOpen) { if (panel) { panel.remove(); panel = null; } return; }
    const cfg = await loadConfig();
    const corner = await gmGet('corner', 'br');
    const status = (await gmGetJSON('status', null)) || {};
    const lastCap = await gmGetJSON('lastCapture', null);
    const lastRef = await gmGetJSON('lastRefresh', null);
    // Synchronous from here on (see renderBadge).
    if (panel) { panel.remove(); panel = null; }
    if (!panelOpen) return; // closed while loading

    panel = el('div', `all:initial;position:fixed;${cornerCss(corner, 52)};width:min(330px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:${C.bg};color:${C.fg};border:1px solid ${C.border};border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.55);padding:12px 14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-sizing:border-box`);
    const head = el('div', 'all:initial;display:flex;align-items:center;justify-content:space-between;font:700 14px/1.4 -apple-system,sans-serif;color:inherit');
    head.appendChild(el('span', 'all:initial;font:inherit;color:inherit', 'RedditVault'));
    head.appendChild(el('span', `all:initial;font:400 11px/1.4 -apple-system,sans-serif;color:${C.muted}`, 'userscript v' + VERSION));
    panel.appendChild(head);
    const line = (text, color) => panel.appendChild(el('div', `all:initial;display:block;font:13px/1.55 -apple-system,sans-serif;color:${color || C.fg};margin-top:4px`, text));

    if (!cfg) {
      line('Not paired with a vault yet.');
      line('In RedditVault: Settings → Capture New Saves → "Pair this device", or copy the pairing code and paste it here.', C.muted);
      panel.appendChild(button('Paste pairing code', promptPairing));
      panel.appendChild(button('Close', closePanel, { bg: '#555' }));
      root.appendChild(panel);
      return;
    }

    line('Vault account: u/' + cfg.x);
    let canRun = true;
    if (liveInfo && liveInfo.checking) {
      line('Checking your Reddit account…', C.muted);
    } else if (liveInfo && liveInfo.acct) {
      const a = liveInfo.acct;
      if (a.name && lc(a.name) === lc(cfg.x)) line('Reddit account: u/' + a.name + ' ✓', C.ok);
      else if (a.name) { line(`⚠ Logged in as u/${a.name} — syncing is paused until you switch to u/${cfg.x}.`, C.warn); canRun = false; }
      else if (a.loggedOut) { line('⚠ Logged out of Reddit — log in as u/' + cfg.x + ' to sync.', C.warn); canRun = false; }
      else line('Could not check your Reddit account: ' + (a.error || 'unknown error'), C.err);
    } else if (status.kind === 'wrong') {
      line(`⚠ Last check: logged in as u/${status.active || 'another account'} — paused.`, C.warn);
    }
    if (status.kind === 'error' && status.msg) line('Last problem: ' + status.msg, C.err);

    line(`Last capture: ${lastCap ? ago(lastCap.at) + (lastCap.error ? ' — failed' : ` — ${lastCap.sent} new`) : 'never'}`, C.muted);
    line(`Last refresh: ${lastRef ? ago(lastRef.at) + (lastRef.error ? ' — failed' : ` — ${lastRef.scores} scores, ${lastRef.details} details`) : 'never'}`, C.muted);
    if (liveInfo && liveInfo.count != null) {
      line(liveInfo.count
        ? `Inbox: ${liveInfo.count} item${liveInfo.count !== 1 ? 's' : ''} waiting — open RedditVault to import`
        : 'Inbox: empty (everything has been imported)', C.muted);
    }
    const prog = el('div', `all:initial;display:block;font:12px/1.5 -apple-system,sans-serif;color:${C.btn};margin-top:4px;min-height:0`, busyText || '');
    prog.setAttribute('data-rv', 'progress');
    panel.appendChild(prog);

    const runDisabled = busy || !canRun;
    panel.appendChild(button('Sync now', () => runCapture({ manual: true }), { disabled: runDisabled }));
    panel.appendChild(button('Refresh scores & details', () => runRefresh({ manual: true }), { disabled: runDisabled }));
    const row2 = el('div', 'all:initial;display:block;margin-top:2px');
    row2.appendChild(button('Re-pair', promptPairing, { bg: '#374151' }));
    row2.appendChild(button('Move', cycleCorner, { bg: '#374151' }));
    row2.appendChild(button('Hide button', hideBadge, { bg: '#374151' }));
    row2.appendChild(button('Close', closePanel, { bg: '#555' }));
    panel.appendChild(row2);
    root.appendChild(panel);
  }

  async function cycleCorner() {
    const order = ['br', 'bl', 'tl', 'tr'];
    const cur = await gmGet('corner', 'br');
    await gmSet('corner', order[(order.indexOf(cur) + 1) % order.length]);
    await renderBadge(); await renderPanel();
  }
  async function hideBadge() {
    await gmSet('hidden', true);
    closePanel(); await renderBadge();
    toast('RedditVault button hidden — it still syncs automatically. Bring it back from RedditVault → Settings → "Show userscript button".', 'info', 9000);
  }

  let toastTimer = null;
  async function toast(msg, kind = 'info', ms = 4500) {
    ensureMounted();
    const corner = await gmGet('corner', 'br');
    if (toastBox) toastBox.remove();
    const color = { ok: C.ok, warn: C.warn, error: C.err, info: C.btn }[kind] || C.btn;
    toastBox = el('div', `all:initial;position:fixed;${cornerCss(corner[0] === 't' ? 'tr' : 'br', 52)};max-width:min(360px,calc(100vw - 32px));background:${C.bg};color:${C.fg};border-left:4px solid ${color};border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.5);padding:10px 12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-sizing:border-box;cursor:pointer`, msg);
    toastBox.addEventListener('click', () => { if (toastBox) { toastBox.remove(); toastBox = null; } });
    root.appendChild(toastBox);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastBox) { toastBox.remove(); toastBox = null; } }, ms);
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  registerMenu('RedditVault: Sync now', () => runCapture({ manual: true }));
  registerMenu('RedditVault: Refresh scores & details now', () => runRefresh({ manual: true }));
  registerMenu('RedditVault: Show sync controls', async () => { await gmSet('hidden', false); ensureMounted(); await renderBadge(); openPanel(); });
  registerMenu('RedditVault: Pair / re-pair', promptPairing);

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeRun(); });
  window.addEventListener('hashchange', () => { handleHash(); });
  setInterval(maybeRun, TIMER_MS);

  (async () => {
    ensureMounted();
    await handleHash();
    await maybeRun();
  })();
})();
