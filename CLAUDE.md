# RedditVault — Claude Code Context

Persistent project memory for Claude Code sessions. Read at session start; update when
significant decisions are made or features added. Keep it **current-state** — decision
history lives in `docs/transcripts/` (see `journal.txt` for the index), not here.

RedditVault is a personal Reddit saved-items manager built to work around Reddit's
~1,000-item API limit. A static PWA (IndexedDB-first) syncs with Supabase; saves are
captured with the user's own logged-in Reddit session via a userscript (automatic), a
bookmarklet (manual), or the Chrome extension. RSS feed sync is legacy — Reddit ends RSS
on Nov 13, 2026 and has refused unauthenticated `.json` since May 28, 2026 ("logged-in
and authenticated access won't be impacted").

**Live URL:** https://reddivault.vercel.app · **Current version:** v0.10.0.0

---

## Hard Rules — every change must respect these

1. **Zero-build, static deploy.** Native ES modules loaded directly by the browser —
   no bundler, no package.json, no transpiler, no build step. Third-party libs (Dexie,
   PapaParse) come from CDN `<script>` tags in `pwa/index.html`. Vercel serves the files
   as-is.
2. **Version bumps on every deployed change.** Bump `APP_VERSION` in `pwa/js/state.js`
   AND `VERSION` in `pwa/sw.js` (format `major.minor.patch.hotfix`). The SW precaches a
   hand-maintained `ASSETS` array keyed off `VERSION` — **a new `js/*.js` file must be
   added to `ASSETS`** or it won't work offline. The userscript (`pwa/reddivault.user.js`)
   has its **own** version: bump its `@version` header AND `VERSION` constant on every
   change to it, or userscript managers won't update. It is not part of the app shell —
   never add it to `ASSETS` (the SW deliberately bypasses `*.user.js`).
3. **The `window` bridge.** Rendered HTML uses ~140 inline `onclick="fn(…)"` handlers
   that resolve against global scope. `app.js` does `Object.assign(window, ...modules)`,
   so any function referenced by an inline handler must be **`export`ed from its module**
   — the bridge picks it up automatically, zero template changes.
4. **Rating three-state.** `rating` is `null` (unrated) | `0` (thumbs-down) | `1`–`5`
   (stars). Always propagate with `?? null`, **never `|| null`** (which coerces a real
   `0` to unrated).
5. **Soft delete only.** "Permanently deleted" items stay in the DB with
   `isPermanentlyDeleted: true` + `deletedAt` (Supabase `deleted_at`) so feed sync can't
   resurrect them. Actual removal is only the explicit Purge action.
6. **Single ingestion path.** `mapRedditChild(child, source)` is the only mapper from a
   raw Reddit listing child to an item — feed sync, the inbox drain and
   `applyMetaUpdates` all use it. The bookmarklet and the userscript write **only** to
   the `reddit_inbox` staging table, never to `reddit_saves`; all real writes go through
   the app's dedup-aware drain.
7. **`localEditAt` pull guard.** Every per-item local mutation stamps
   `item.localEditAt` with an ISO timestamp (client clock). `syncFromSupabase` and
   `deltaPullBeforePush` must skip overwriting any item whose `localEditAt` is newer
   than the pull's start time (both on the client clock), so an in-flight pull can't
   clobber a fresh edit.
8. **iOS quirks.** `font-size: 16px` on all inputs (prevents zoom-on-focus); viewport
   pinch-zoom lock is user-controllable (`state.disableZoom`). The bookmarklet string
   must stay quote-free (no double quotes, no backticks, no inline `onclick`, and no
   apostrophes inside its single-quoted literals) — banners use the `done()` helper with
   `textContent`.
9. **Account binding (several Reddit accounts).** Only the vault's account
   (`state.redditUsername`, required for both capture tools) may ever be captured:
   the bookmarklet and userscript check `/api/me.json` before every run with **no
   override**, read `/user/<vault user>/saved.json` (never `/user/me/`), the userscript
   re-checks right before every upload, and every inbox row carries `by` (capturing
   account) — `drainInbox`/`importPastedBookmarklet` reject rows whose `by` doesn't match
   (`_inboxRowFromOtherAccount`; rows without `by` from old bookmarklets are accepted).
10. **No anonymous Reddit requests from the app.** Reddit refuses unauthenticated `.json`
    (403 since May 28, 2026). Every Reddit read happens inside reddit.com with the user's
    session (bookmarklet/userscript/extension); the PWA itself only talks to Supabase and
    Arctic Shift.

---

## File Structure

```
/
├── CLAUDE.md                          ← this file
├── SETUP.md                           ← end-user setup guide
├── supabase-schema.sql                ← DB schema (fresh install + migration sections)
├── vercel.json                        ← Vercel config (auto-deploys from GitHub)
├── pwa/
│   ├── index.html                     ← shell: markup + CDN libs + module entry
│   ├── styles.css                     ← all app CSS
│   ├── sw.js                          ← service worker (VERSION + ASSETS list)
│   ├── reddivault.user.js             ← capture userscript (own @version; served static,
│   │                                    auto-updates; NOT in ASSETS)
│   ├── manifest.json, icon-*.png
│   └── js/                            ← the app, native ES modules
│       ├── app.js                     ← entry: imports all, window bridge, bootstrap
│       ├── state.js                   ← APP_VERSION, Dexie db + version chain, state, syncLog
│       ├── util.js                    ← escHtml, fmtDate, showToast, renderMarkdown,
│       │                                openLink, fullUrl, ratingDisplay, applyZoomSetting
│       ├── core.js                    ← init, loadConfig/loadData, rebuildTagCache,
│       │                                rebuildFilterLists, reconcileDirtyState, markDirty
│       ├── enrich.js                  ← Arctic Shift bulk enrichment, mark-dead/retry
│       ├── cloud.js                   ← Supabase REST (supabaseFetch), push/pull/delta sync,
│       │                                pushInBatches, preferences push/pull, retry/dirty
│       ├── feed.js                    ← LEGACY RSS feed sync (RSS_SUNSET/rssRetired),
│       │                                _buildProxyUrl, Supabase/feed config save
│       ├── bookmarklet.js             ← capture + inbox: buildInboxBookmarklet, drainInbox,
│       │                                ingestChildren, mapRedditChild, applyScoreUpdates,
│       │                                applyMetaUpdates, importPastedBookmarklet,
│       │                                cspProbeBookmarklet, userscript pairing helpers
│       ├── dataio.js                  ← CSV import, JSON backup/restore, repairs, delete
│       ├── search.js                  ← parseSearchQuery, itemMatchesTokens, _parseWildcard,
│       │                                affinityScore, sortItems, filteredItems,
│       │                                list-options helpers (serialise/applyListOptions)
│       ├── items.js                   ← item/list mutations (favourite, rate, trash, delete,
│       │                                list CRUD), showPage, search/filter actions
│       ├── render.js                  ← barrel: `export *` over render/ submodules
│       └── render/
│           ├── shell.js               ← render dispatcher, header, error fallback,
│           │                            showModal/closeModal, showRatingMenu, sort control
│           ├── home.js                ← renderHome, renderRecent
│           ├── browse.js              ← renderBrowse, item list, search/filter handlers
│           ├── card.js                ← renderItemCard
│           ├── preview.js             ← showPreview, closePreview, showLinkPicker,
│           │                            refreshOpenPreviewMeta
│           ├── trash.js               ← renderTrashView
│           ├── lists.js               ← renderLists + list menus
│           └── settings.js            ← the whole settings page
├── extension/                         ← Chrome extension (manifest, popup, background)
├── cloudflare-worker/                 ← LEGACY (RSS feed proxy; obsolete after Nov 13, 2026)
│   ├── reddit-feed-proxy.js           ← CORS proxy worker
│   └── wrangler.toml                  ← wrangler deploy config
└── docs/transcripts/                  ← full session transcripts + journal.txt index
```

Other modules and the window bridge import rendering from `./render.js` (the barrel),
never from `render/` submodules directly.

---

## Data Flow

```
Reddit (session cookies) → Userscript  → Supabase reddit_inbox → PWA drains into library
Reddit (session cookies) → Bookmarklet → Supabase reddit_inbox → PWA drains into library
Reddit (session cookies) → Chrome Extension → Supabase → PWA (IndexedDB cache)
Arctic Shift archive     → PWA enrichment (bulk, no auth)
Reddit (RSS feed)        → Cloudflare Worker / corsfix → PWA feed sync   [LEGACY, ends Nov 13, 2026]
```

- **IndexedDB is the source of truth**; Supabase is the sync layer. The PWA reads local
  on every load; `syncFromSupabase` merges remote into local, `pushToSupabase` /
  `pushAllDirty` push local items up.
- **Session-based sync, not OAuth** — the userscript, bookmarklet and extension ride the
  user's existing reddit.com login cookies. Reddit closed self-service API keys in Nov
  2025, so there is no OAuth path (and borrowing another app's client ID — e.g.
  RedReader's — was ruled out: its `redreader://` redirect can't reach a web app, and it
  would misuse that app's accessibility grant). Personal use only; the Supabase anon key
  in the bookmarklet / userscript pairing is RLS-protected and acceptable for this
  threat model.
- There are **no folders** — organisation is via Lists. (The old `folder` column became
  `deleted_at` in a Supabase migration; a legacy `folders` Dexie store lingers unused.)

---

## Supabase Schema

Five tables (see `supabase-schema.sql`):

| Table | Purpose |
|-------|---------|
| `reddit_saves` | items (posts + comments) |
| `reddit_inbox` | bookmarklet staging — drained into `reddit_saves`, then cleared |
| `reddit_lists` | user lists (static and smart) |
| `reddit_item_lists` | many-to-many item ↔ list, unique on `(reddit_id, list_name)` |
| `user_preferences` | key-value settings sync (`key, value, updated_at`) |

**`reddit_saves`:** `id, reddit_id, type, subreddit, title, url, permalink, body, author,
score, saved_at, post_created_at, enrich_status, is_favourite, rating, is_disliked,
deleted_at, created_at, updated_at`
- `enrich_status`: `'pending' | 'enriched' | 'dead'`
- `deleted_at`: null = active, timestamptz = permanently deleted
- `is_disliked`: soft trash (recoverable) · `rating`: nullable int (see Hard Rule 4)
- `updated_at`: maintained by moddatetime trigger — delta pulls key off it

**`reddit_lists`:** `id, name, type ('static'|'smart'), query, is_tag, tag_name,
options_json, created_at, updated_at`
- `options_json` is `text`, **not jsonb** — the app stores a JSON *string*
  (`serialiseListOptions`) and `JSON.parse`s it on read (`applyListOptions`); jsonb would
  round-trip as an object and the options would be silently dropped.

**`reddit_inbox`:** `id, reddit_id, payload jsonb, created_at` — transient staging.
- `reddit_id` is the `UNIQUE` upsert key (`on_conflict=reddit_id`,
  `resolution=ignore-duplicates`, so bookmarklet re-runs don't pile up).
- Rows are typed by `payload.op`: **no `op`** = capture (`{kind, data, by}` Reddit child,
  keyed by fullname `t3_…`/`t1_…`, fed to `mapRedditChild`); **`op:'score'`** =
  `{op:'score', reddit_id, score, by}`, keyed `'score:'+fullname`; **`op:'meta'`** =
  `{op:'meta', reddit_id, child, by}` (full details for a pending item) or
  `{op:'meta', reddit_id, missing:true, by}`, keyed `'meta:'+fullname`. Distinct key
  prefixes mean op types never collide under ignore-duplicates, and the inbox is
  bounded at ~3 rows per item no matter how often capture runs.
- `by` = the Reddit account that captured the row (Hard Rule 9).

**`user_preferences` keys:** `redditFeedUrl`, `redditUsername`, `scoreRefreshLimit`,
`feedProxyUrl`, `feedProxyType`, `feedFormat`, `confirmDestructive`, `recentSearches`,
`last_modified`, `userscriptLastRefreshAt` (written by the userscript to coordinate its
daily refresh across devices; `pullPreferences` ignores it). The bookmarklet and
userscript read `scoreRefreshLimit` and `redditUsername` live.

---

## IndexedDB Schema (Dexie, version 9)

```javascript
db.version(9).stores({
  items:      '++id, redditId, type, subreddit, title, url, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt, isPermanentlyDeleted',
  folders:    '++id, name, icon, createdAt',   // legacy, unused
  lists:      '++id, name, type, createdAt, isTag',
  item_lists: '++id, itemId, listId',
  config:     'key',                            // local key-value config
});
```

Unindexed fields ride along on objects (e.g. `items.localEditAt`, `lists.optionsJson`).
The version chain in `state.js` carries upgrade migrations — never edit old versions,
add a new `db.version(n)`.

Field mapping (IndexedDB camelCase → Supabase snake_case): `redditId → reddit_id`,
`savedAt → saved_at`, `postCreatedAt → post_created_at`, `enrichStatus → enrich_status`,
`isFavourite → is_favourite`, `isDisliked → is_disliked`, `deletedAt → deleted_at`
(`isPermanentlyDeleted` ⇔ `deleted_at` non-null), `isTag → is_tag`,
`tagName → tag_name`, `optionsJson → options_json`.

---

## App State (`state` in state.js)

Key fields (see `state.js` for the full annotated object):

```javascript
state.page            // 'home' | 'browse' | 'recent' | 'lists' | 'settings'
state.items / lists / itemLists   // loaded from IndexedDB
state.search          // current search string
state.showFilters, filterType, filterRating, filterHasLinks,
state.filterSubreddit, filterAuthor, filterDateFrom/To,
state.filterDateField // 'postCreatedAt' | 'savedAt'
state.filterFavourite, searchBody
state.activeTagIds    // list ids active as tag filters
state.tagMode         // 'AND' | 'OR'
state.tagCache        // Map<listId, { count, itemIds: Set }> — see Lists
state.sortBy          // 'affinity' | 'savedAt' | 'postCreatedAt' | 'score' | 'rating' | 'subreddit' | 'title'
state.sortDir         // 'asc' | 'desc'
state.showTrash / showDeleted     // trash + deleted-items views (flags, not pages)
state.localDirty / cloudAhead     // sync dirty tracking
state.lastPushedAt    // delta cursor for push
state.supabaseUrl / supabaseKey
state.redditFeedUrl, feedProxyUrl, feedProxyType ('cloudflare'|'corsfix'),  // legacy RSS
state.feedFormat      // 'rss' | 'json' — legacy RSS
state.redditUsername  // the vault's Reddit account — REQUIRED for capture (Hard Rule 9)
state.scoreRefreshLimit  // saves checked by "Refresh scores" (0 = all, default 500)
state.enrichMaxAttempts  // refresh misses before "Mark as dead" is offered
state.listView / listSeparate / listSmartFirst
state.confirmDestructive, disableZoom
state.autoFeedSync, autoFeedSyncInterval   // legacy RSS; no-op after rssRetired()
```

---

## Render Pattern

Manual render cycle, everything writes `innerHTML`:

- `render()` — full shell (nav + current page). Call on page/state changes.
- `renderBrowseList()` — just the item list. Call on search/filter/sort changes.
- `filteredItems()` (search.js) — the central filter: applies `isPermanentlyDeleted`,
  `isDisliked`, `enrichStatus !== 'dead'`, view context, active tags,
  subreddit/author/date filters, and search tokens.
- Error boundary: `window.onerror` + `unhandledrejection` show a recovery UI with version.

---

## Search Engine

`parseSearchQuery(raw)` → token objects; `itemMatchesTokens(item, tokens)` matches;
`_parseWildcard(raw)` → `{ value, exact, suffixWild, prefixWild }`.

| Input | Behaviour |
|-------|-----------|
| `python tutorial` | AND — whole-word matches |
| `react, vue` / `(react, vue)` | OR group |
| `"machine learning"` | exact substring |
| `witch*` / `*witch` / `*witch*` | prefix / suffix / contains |
| `-javascript` | exclude |
| `r:programming` / `u:name` | subreddit / author (partial match) |
| `type:post` | type filter |

- Bare words are **whole-word** matches (`app` ≠ `apple`); use `app*` for prefix.
- Wildcards work inside OR groups: `(run*, walk*)`.
- Field prefixes stay partial: `r:prog` matches r/programming.
- A negated term in a bare comma list (`-python, javascript`) falls through to AND parsing.
- Search input normalises smart quotes `' ' " "` (iOS autocorrect).

---

## Sync System

### Cloud push / pull (cloud.js)
- **Delta cursor:** `state.lastPushedAt` (historical name) means "everything on the
  cloud up to T has been merged locally". It advances **only when a pull completes**
  (`syncFromSupabase`, `deltaPullBeforePush`), never on push — advancing it on push
  would skip rows another device wrote between our last pull and the push. Pushes
  write `last_modified` (via `markClean`) so other devices know to pull; the cost is
  at most one redundant delta pull after a push-only session.
- `pushToSupabase(items)` — upsert to `reddit_saves` with `on_conflict=reddit_id`;
  stamps `syncedAt` on the pushed items on success, calls `markDirty` on failure.
  Items with no `syncedAt` are the retry queue: `pushAllDirty` re-pushes them (batched,
  skipping locally-deleted ones), and a completed pull keeps `localDirty` set while any
  remain.
- `pushListsToSupabase()` — upserts lists, rebuilds `reddit_item_lists` per list, and
  always touches the parent list's `updated_at` when memberships change (so delta sees it).
- `syncFromSupabase()` — delta pull via `updated_at=gt.{lastSync}`; full scan on first
  run. `lastSync` is recorded at pull-*start* so rows modified during a slow pull aren't
  missed. Static-list memberships reconcile per-list only for lists whose `updated_at`
  changed. Respects the `localEditAt` guard (Hard Rule 7).

### Capture: userscript (pwa/reddivault.user.js) — automatic
Plain script for Tampermonkey / Violentmonkey / iOS "Userscripts". `@match
https://*.reddit.com/*`. Same inbox protocol as the bookmarklet; writes go through
`GM.xmlHttpRequest`, which is outside page CSP, so it works on new Reddit as well as old.
- **Config** `{u, k, x}` lives only in GM storage, set by **pairing**: the PWA's
  `buildPairingCode()` makes `RV1:<base64 JSON>`; `pairUserscript()` opens
  `old.reddit.com/#rv-pair=…` (fragment never reaches Reddit; the script confirms, stores
  and strips it), or the user pastes the code via the RV panel.
- **Schedule:** capture at most every 30 min per device (visible tab only; checked on
  load, focus and a 5-min timer); refresh once per 24 h across devices
  (`userscriptLastRefreshAt`). A GM-storage lock stops tabs running concurrently.
- **Capture:** page 1 of `/user/<x>/saved.json?limit=25`; a local "seen" set (last 2000
  ids) means a quiet run costs one Reddit request and **zero** Supabase calls. Only when
  something unseen appears does it read 1000 recent vault ids to filter. Uploads in
  batches of ≤100 rows / ≤500 KB; ids are marked seen **only after** Supabase accepts
  the batch, so failures retry next run.
- **Refresh:** same logic as bookmarklet op ② (changed scores only + meta for pending).
- **Manual controls:** floating **RV** badge (shadow DOM, CSSOM styles) → panel with
  Sync now / Refresh / status / inbox count / Re-pair / Move / Hide; menu commands;
  hash triggers `#rv-capture`, `#rv-refresh`, `#rv-pair=…`, `#rv-show`.
- **Account binding:** Hard Rule 9 (gate every run, live re-read of `redditUsername` on
  mismatch, re-check before each upload, `by` on rows).

### Capture: bookmarklet (bookmarklet.js) — manual, no install
`buildInboxBookmarklet(url, key, expectUser)` generates a menu-driven `javascript:`
bookmarklet; `expectUser` (`state.redditUsername`) is required.
- **Host modes:** on `old.reddit.com` it reads recent vault ids, captures incrementally
  and POSTs directly. On new Reddit (www/sh) CSP `connect-src` blocks every Supabase
  call, so it scans the newest 3 pages and offers the clipboard envelope
  (`{type:'rv-bookmarklet', v:2, by, children}` → "Paste captured items" /
  `importPastedBookmarklet`). The same envelope is the fallback if an old.reddit POST fails.
- **Account check:** `/api/me.json` must equal `expectUser` — hard block, no "use
  anyway"; reads `/user/<expectUser>/saved.json`; re-checks before sending.
- **① Capture** / **② Refresh scores & details** (old.reddit only): reads
  `scoreRefreshLimit` live, pages that many active ids (+ stored scores) and up to 1000
  pending ids, batches `/api/info.json` (100/call, 1s pacing, 429 retry; parent titles
  for comments fetched when missing), sends `score` rows only for changed scores and
  `meta` rows for pending items, flushing per batch.

**Drain:** `drainInbox({manual})` runs on startup, on `visibilitychange` foreground, and
from the Settings button. Pages the inbox, rejects rows from another account (`by`),
dispatches by `payload.op`: capture rows → `ingestChildren(children,'bookmarklet')`;
score rows → `applyScoreUpdates`; meta rows → `applyMetaUpdates` (existing items only,
skips permanently-deleted, keeps `savedAt`, stamps `localEditAt`; `missing` bumps
`enrichAttempts`). Then DELETEs drained ids (chunked). Result `{added, skipped,
scoresUpdated, detailsUpdated, rejected, drained}`; quiet runs toast only when something
changed or was rejected. All cloud pushes use `pushInBatches` (200/request; `markClean`
only if every batch succeeded). Anti-resurrection: `ingestChildren` dedups against all
known ids **including permanently-deleted**.

### Legacy: RSS feed sync (feed.js)
- `syncFromFeed()` — fetch Reddit RSS via CORS proxy, parse, upsert new items. Reddit
  ends RSS on **Nov 13, 2026** (`RSS_SUNSET`); after `rssRetired()` auto-sync no-ops and a
  manual sync explains the failure. UI lives in a collapsed "Legacy" block. Removal of
  the feed code, its prefs and `cloudflare-worker/` is a planned follow-up.
- Proxy via `_buildProxyUrl(feedUrl)` — never build URLs by hand.

---

## Lists, Tags, Ratings

- **Static lists** — manual membership, stored in the `item_lists` junction.
- **Smart lists** — a search query; membership computed at render time via
  `parseSearchQuery(list.query)`, never stored. `optionsJson` persists the list's
  filters/sort (`serialiseListOptions`/`applyListOptions`).
- **Tags** — smart lists with `isTag: true`; render as chip pills on matching cards and
  as filter buttons in browse. `rebuildTagCache()` precomputes
  `state.tagCache: Map<listId, { count, itemIds: Set }>` after `loadData()` and any list
  mutation, making per-item chip rendering O(1).
- **Affinity sort** — rating (0–50), favourite (+30 flat), author frequency (0–15
  log-scaled via `rebuildAuthorFreq()`), tag membership (0–20). Unrated (`null`) gets a
  neutral 10-pt baseline; thumbs-down (`0`) scores 0, below unrated.
- **Rating UI** — each card shows a compact rating chip (muted "☆ Rate" / 👎 / ★n) that
  opens `showRatingMenu(itemId)` (shell.js modal picker: 👎, ★1–5, Clear). Also reachable
  from the preview sheet, which refreshes its meta in place
  (`refreshOpenPreviewMeta()`). Read-only display always goes through
  `ratingDisplay(item)` in util.js.
- **Favourite ≠ rating** — `isFavourite` is a separate field, rendered as a **pink heart**
  (`#ec4899`, filled ♥ / hollow ♡) to stay distinct from amber rating stars and the red
  trash button. Card border tint pink when favourited; home stat reads "Favourited".

---

## Item Lifecycle

```
CSV import / inbox drain (userscript, bookmarklet) / extension / legacy feed sync
  → upsert IndexedDB (enrichStatus 'pending'|'enriched') → push to Supabase

Enrichment: Arctic Shift bulk pass (manual), then the session refresh (userscript daily /
bookmarklet ②) → op 'meta' → applyMetaUpdates → enrichStatus 'enriched';
misses bump enrichAttempts → "Mark as dead" → 'dead' → push

Trash (isDisliked)      → hidden from browse, visible in Trash, recoverable
Permanent delete        → isPermanentlyDeleted + deletedAt / deleted_at; hidden everywhere
                          except Deleted Items; never resurfaces; restorable
Purge                   → actually removed from IndexedDB + Supabase; gone
```

**Deletion/restore sync rule** (both pull paths): a remote `deleted_at` always wins;
a remote row that is *active* while we hold a local permanent deletion un-deletes it
only if the remote row's `updated_at` is newer than our local `deletedAt` — so restores
propagate across devices, but a stale remote row can't resurrect a deletion.

**Enrichment detail:** phase 1 `enrichViaArcticShift` hits
`arctic-shift.photon-reddit.com` (`/api/posts/ids`, `/api/comments/ids`; up to 500
ids/request, 500ms between batches, no auth; archive lags Reddit by weeks, no SLA).
Phase 2 is the session refresh (≤1000 pending items per run). The old anonymous
per-item `permalink.json` enricher was removed (Reddit returns 403). PullPush was
considered and rejected (ingestion stopped May 2025).

---

## Settings Page — six sections in order

1. **📥 Capture New Saves** — vault Reddit username (required), userscript (install /
   pair / capture now / show button), bookmarklet (+ paste fallback, CSP probe),
   refresh-scores limit, import-from-inbox, collapsed **Legacy: RSS feed sync**
2. **☁️ Cloud Database** — status, manual push/pull, Supabase connection (collapsible)
3. **📊 Library** — stats (active items; deleted count if any), Backup & Restore
4. **📥 Import & Enrich** — data-export request link, multi-file CSV import, Arctic
   Shift, session refresh, not-found/mark-dead
5. **🎛️ Behaviour** — confirm-destructive, disable pinch-to-zoom
6. **🔬 Diagnostics** (muted) — force reload, troubleshooting tools, sync log

---

## Conventions

- **CSS variables:** `--bg, --surface, --border, --text, --text-muted, --accent`
  (orange), `--accent2` (blue), `--danger` (red). Dark mode via
  `@media (prefers-color-scheme: dark)`.
- **Sync log:** `syncLog(msg, level)` — in-memory (session-only, cap 200), shown in
  Diagnostics. Levels: `'info' | 'ok' | 'warn' | 'error'`.
- **Markdown:** `renderMarkdown(text)` — bold, italic, inline code, links,
  strikethrough; extracts links before escaping. Used for comment bodies.
- **Toasts:** `showToast(msg)`; quiet background syncs only toast on change.

---

## Known Issues / Pending Work

1. **Legacy RSS cleanup** — after Nov 13, 2026 confirms RSS is gone, delete the feed sync
   code, feed prefs/config keys, corsfix bits and `cloudflare-worker/` (whose
   `ALLOWED_ORIGIN` is hardcoded to `https://reddivault.vercel.app`).
2. **Reddit CSV `saved_posts.csv`** — the saved-date field is usually empty, so `savedAt`
   is typically the import timestamp, not the real save date.
3. **Window-bridge migration** — a future pass can replace inline `onclick` handlers with
   a `data-action` delegated dispatcher and drop the bridge.
4. **Logged-in `.json` contingency** — if Reddit ever blocks `.json` for logged-in
   sessions too, the userscript/bookmarklet can fall back to parsing the saved page's
   HTML (old.reddit `.thing[data-fullname]`). Not built.
5. **Userscript on iOS** — Safari extensions may not run in the in-app view a home-screen
   PWA opens links in; users open Reddit in Safari directly.
