# RedditVault — Claude Code Context

This file is the persistent memory for Claude Code sessions on this project.
Read it at the start of every session. Update it when significant decisions are made or features added.

---

## Project Overview

RedditVault is a personal Reddit saved items manager built to work around Reddit's ~1,000 item API limit. It consists of:

- **`pwa/index.html`** — single-file PWA (the entire app: ~4,500 lines of vanilla JS + HTML + CSS)
- **`pwa/sw.js`** — service worker for offline caching
- **`pwa/manifest.json`** — PWA manifest
- **`extension/`** — Chrome extension for desktop sync via Reddit session cookies
- **`cloudflare-worker/reddit-feed-proxy.js`** — CORS proxy for RSS feed auto-sync
- **`supabase-schema.sql`** — current DB schema (fresh install + migration sections)
- **`SETUP.md`** — end-user setup guide
- **`vercel.json`** — Vercel deployment config (auto-deploys from GitHub)

**Live URL:** https://reddivault.vercel.app
**Current version:** v0.9.7.4

---

## Architecture

### Data flow
```
Reddit (session cookies) → Chrome Extension → Supabase → PWA (IndexedDB cache)
Reddit (RSS feed)        → Cloudflare Worker → PWA feed sync
Reddit public JSON API   → PWA enrichment (no auth needed)
```

### Key design decisions

**Single-file PWA** — everything in `index.html`. No build step, no bundler. Deployed directly via Vercel. Simplicity is a hard constraint.

**Session-based sync, not OAuth** — the Chrome extension uses `fetch()` against Reddit's internal API endpoints with the user's existing browser cookies. Avoids Reddit's developer application approval process entirely. Personal use only.

**IndexedDB as primary store** — Supabase is the cloud sync layer, not the source of truth. The PWA reads from local IndexedDB on every load. `supabasePull()` merges remote into local; `supabasePush()` pushes local dirty items to remote.

**Soft delete** — "permanently deleted" items are never removed from the DB. They get `isPermanentlyDeleted: true` + `deletedAt` timestamp locally, and `deleted_at` set in Supabase. This prevents them from resurfacing via feed sync. Actual DB purge is a separate explicit action.

**URL enrichment** — Reddit CSV exports are sparse (IDs and URLs only). The app fetches `https://old.reddit.com{permalink}.json` for each item to get title, body, author, score, subreddit. No auth needed. Rate limiting: configurable delay (default 7.5s between requests).

**No folder column** — early versions had a `folder` text column. This was renamed to `deleted_at timestamptz` in a Supabase migration. There are no folders in the current schema — organisation is via Lists.

---

## Supabase Schema (current)

Four tables:

```sql
reddit_saves       -- items (posts + comments)
reddit_lists       -- user lists (static and smart)
reddit_item_lists  -- many-to-many: item ↔ list membership
user_preferences   -- key-value settings sync across devices
```

### `reddit_saves` columns
`id, reddit_id, type, subreddit, title, url, permalink, body, author, score, saved_at, post_created_at, enrich_status, is_favourite, rating, is_disliked, deleted_at, created_at, updated_at`

- `enrich_status`: `'pending'` | `'enriched'` | `'dead'`
- `deleted_at`: null = active, timestamptz = permanently deleted
- `is_disliked`: trashed (soft trash, recoverable)
- `updated_at`: auto-maintained by moddatetime trigger

### `reddit_lists` columns
`id, name, type, query, is_tag, tag_name, created_at, updated_at`

- `type`: `'static'` | `'smart'`
- `is_tag`: if true, this list also renders as a tag chip on matching items in browse view
- `query`: search query string for smart lists (uses same parser as main search)

### `reddit_item_lists` columns
`id, reddit_id, list_name` — unique constraint on `(reddit_id, list_name)`

### `user_preferences` columns
`key, value, updated_at` — stores: `redditFeedUrl`, `feedProxyUrl`, `confirmDestructive`, `last_modified`

---

## IndexedDB Schema (Dexie, version 8)

```javascript
db.version(8).stores({
  items:      '++id, redditId, type, subreddit, title, url, savedAt, postCreatedAt, enriched, enrichStatus, enrichAttempts, syncedAt, isPermanentlyDeleted',
  lists:      '++id, name, type',
  item_lists: '++id, itemId, listId',
});
```

Field name mapping (IndexedDB camelCase → Supabase snake_case):
- `redditId` → `reddit_id`
- `savedAt` → `saved_at`
- `postCreatedAt` → `post_created_at`
- `enrichStatus` → `enrich_status`
- `isFavourite` → `is_favourite`
- `isDisliked` → `is_disliked`
- `isPermanentlyDeleted` → (`deleted_at` being non-null in Supabase)
- `deletedAt` → `deleted_at`
- `isTag` → `is_tag`
- `tagName` → `tag_name`

---

## App State (`state` object)

Key fields:
```javascript
state.items          // all items array (loaded from IndexedDB)
state.lists          // all lists array
state.itemLists      // all item_list junction records
state.search         // current search string
state.showFilters    // filter panel open
state.filterSub      // subreddit filter
state.filterAuthor   // author filter
state.filterDateFrom/To  // date range filters
state.filterDateField    // 'savedAt' | 'postCreatedAt'
state.tagMode        // 'AND' | 'OR' for tag chip filtering
state.activeTagIds   // array of list IDs being used as tag filters
state.sortBy         // 'savedAt' | 'postCreatedAt' | 'affinity' | 'score' | 'random'
state.view           // 'browse' | 'lists' | 'settings' | 'trash' | 'deleted'
state.listSeparate   // bool — split lists view into smart/static sections
state.listSmartFirst // bool — smart section above static when separated (togglable button)
state.isDirty        // local changes not yet pushed to Supabase
state.supabaseUrl    // Supabase project URL
state.supabaseKey    // Supabase anon key
state.redditFeedUrl  // Reddit private RSS feed URL
state.feedProxyUrl   // Cloudflare worker URL
state.disableZoom    // iOS viewport zoom disabled
state.confirmDestructive // confirm before destructive actions
```

---

## Render Pattern

The app uses a simple manual render cycle:

```javascript
render()              // renders the full shell (nav, current view)
renderBrowseList()    // re-renders just the item list (called on search/filter changes)
```

`render()` is called for view/state changes. `renderBrowseList()` is called for search/filter/sort changes to avoid re-rendering the entire shell. Both write to `innerHTML`.

`filteredItems()` — the central filter function. Applies: `isPermanentlyDeleted`, `isDisliked`, `enrichStatus !== 'dead'`, view context, active tag filters, subreddit/author/date filters, and search query tokens.

---

## Search Engine

Parser: `parseSearchQuery(raw)` → array of token objects
Matcher: `itemMatchesTokens(item, tokens)`

### Syntax
| Input | Behaviour |
|-------|-----------|
| `python tutorial` | AND — both words must appear as whole words |
| `react, vue, svelte` | OR — bare comma list = OR group |
| `(react, vue)` | OR group (explicit parens) |
| `"machine learning"` | exact substring anywhere in text |
| `witch*` | words starting with "witch" (witches, witchcraft) |
| `*witch` | words ending with "witch" (switch) |
| `*witch*` | words containing "witch" (switches, bewitched) |
| `-javascript` | exclude this word |
| `r:programming` | subreddit filter (partial match) |
| `u:username` | author filter (partial match) |
| `type:post` | type filter |

**Word boundary matching** is the default for bare words — `app` does NOT match `apple` or `applications`. Use `app*` for prefix matching.

**Wildcards inside OR groups work** — `(run*, walk*)` correctly applies prefix matching to each term.

**Field prefixes stay partial** — `r:prog` matches `r/programming`.

**Negation in bare-comma OR** — if any term in a comma list is negated (`-python, javascript`), the whole thing falls through to AND parsing rather than OR, so `-python, javascript` means NOT python AND javascript.

Helper: `_parseWildcard(raw)` — parses a single term string into `{ value, exact, suffixWild, prefixWild }`.

---

## Sync System

### Feed sync (auto / manual)
`syncFeed()` — fetches Reddit RSS feed via Cloudflare proxy, parses JSON, upserts new items. Skips items already in the DB and items that are `isPermanentlyDeleted`. Runs on interval if `state.autoSync` is enabled.

### Cloud push
`supabasePush(items)` — upserts items to `reddit_saves` using `on_conflict=reddit_id`.
`pushListsToSupabase()` — upserts lists and rebuilds `reddit_item_lists` for each list.

### Cloud pull
`syncFromSupabase()` — delta sync using `updated_at=gt.{lastSync}` filter when `state.lastSync` exists. Falls back to full table scan on first run (no `lastSync`). `lastSync` is recorded at the *start* of the pull (not end) so rows modified during a slow pull aren't missed next time. Lists use the same delta filter. Static list memberships are reconciled per-list (add missing, remove stale) only for lists whose `updated_at` changed — push always touches the parent list's `updated_at` when memberships change so the trigger fires. Smart list membership is never stored — computed at render time. Toast shows "Already up to date" when delta returns zero changes.

---

## Lists System

**Static lists** — manual membership. Items added/removed via UI. Stored in `item_lists` junction table.

**Smart lists** — defined by a search query. Membership computed at runtime by running `parseSearchQuery(list.query)` against all items. Not stored in `item_lists`.

**Tags** — smart lists with `isTag: true`. These render as coloured chip pills on matching items in the browse view. Tag chips are also shown as filter buttons at the top of browse view. `state.activeTagIds` tracks which tags are active as filters.

**Tag cache** — `state.tagCache` is a `Map<itemId, listId[]>` precomputed by `rebuildTagCache()`. Called after `loadData()` and after any list mutation. Makes tag chip rendering O(1) per item.

**Affinity sort** — scores items on: rating (0–50 pts), favourite (+30 pts flat), author frequency (0–15 pts log-scaled), tag membership (0–20 pts). `rebuildAuthorFreq()` precomputes author counts. Called in `loadData()`.

---

## Item Lifecycle

```
CSV import / feed sync / extension sync
  → upsert into IndexedDB (enrichStatus: 'pending' or 'enriched')
  → push to Supabase

Enrichment (manual trigger)
  → fetch old.reddit.com/{permalink}.json
  → update item fields + enrichStatus: 'enriched' | 'dead'
  → push to Supabase

Trash (isDisliked: true)
  → hidden from browse view
  → visible in Trash view
  → recoverable

Permanent delete (isPermanentlyDeleted: true + deletedAt)
  → hidden everywhere except Deleted Items view
  → deleted_at set in Supabase
  → never resurfaces from feed sync
  → recoverable via Restore button

Purge (actual deletion)
  → removed from IndexedDB
  → DELETE from Supabase reddit_saves
  → gone permanently
```

---

## Settings Panel Structure (v0.9.5+)

Six sections in this order:
1. **🔄 Sync New Saves** — sync button, result, auto-sync toggle, interval, feed connection settings (collapsible)
2. **☁️ Cloud Database** — status, manual push/pull, Supabase connection settings (collapsible)
3. **📊 Library** — stats (active items only; deleted count shown if any), Backup & Restore sub-block
4. **📥 Import & Enrich** — CSV import, enrichment controls, About, speed settings (collapsible)
5. **🎛️ Behaviour** — Confirm destructive actions checkbox, Disable pinch-to-zoom checkbox
6. **🔬 Diagnostics** (muted, opacity 0.85) — Force reload button, Troubleshooting tools (details), Sync log (details)

---

## CSS Variables

```css
--bg         /* page background */
--surface    /* card/panel background */
--border     /* border colour */
--text       /* primary text */
--text-muted /* secondary/hint text */
--accent     /* primary accent (orange-ish) */
--accent2    /* secondary accent (blue-ish) */
--danger     /* red for destructive actions */
```

Dark mode via `@media (prefers-color-scheme: dark)`.

---

## Known Issues / Pending Work

1. **Cloudflare Worker ALLOWED_ORIGIN** — hardcoded to `https://reddivault.vercel.app`. New installs must update this to their own Vercel URL before deploying the worker.

2. **Reddit CSV `saved_posts.csv`** — the CSV field for saved date is often empty; `savedAt` is typically the import timestamp, not the actual Reddit save date.

---

## Conventions

- **Versioning**: `APP_VERSION` const at top of `index.html`. Format: `major.minor.patch.hotfix` (e.g. `0.9.6.4`). Bump for every deployed change.
- **Sync log**: `syncLog(message, level)` — appends to in-memory log shown in Diagnostics. Levels: `'info'` (default), `'ok'`, `'warn'`, `'error'`.
- **Error boundary**: `window.onerror` + `unhandledrejection` catch and display a recovery UI with version info.
- **iOS**: `font-size: 16px` on all inputs (prevents iOS zoom on focus). Viewport has `maximum-scale=1.0, user-scalable=no` (controllable via Behaviour setting).
- **Markdown rendering**: `renderMarkdown(text)` — handles bold, italic, inline code, links, strikethrough. Used for comment body text. Extracts markdown links before escaping to avoid mangling brackets.
- **Smart quote normalisation**: search input normalises `'` `'` `"` `"` to straight quotes (iOS autocorrect artefact).

---

## Session Transcripts

Full conversation history is in `docs/transcripts/`. See `docs/transcripts/journal.txt` for a chronological index.

These can be read with standard file tools if you need to investigate why a specific decision was made.

---

## File Structure

```
/
├── CLAUDE.md                          ← this file
├── SETUP.md                           ← end-user setup guide
├── supabase-schema.sql                ← current DB schema
├── vercel.json                        ← Vercel config
├── pwa/
│   ├── index.html                     ← entire PWA (~4,500 lines)
│   ├── sw.js                          ← service worker
│   ├── manifest.json                  ← PWA manifest
│   ├── icon-192.png
│   └── icon-512.png
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   └── background.js
├── cloudflare-worker/
│   └── reddit-feed-proxy.js           ← CORS proxy worker
└── docs/
    └── transcripts/
        ├── journal.txt
        └── *.txt                      ← full session transcripts
```
