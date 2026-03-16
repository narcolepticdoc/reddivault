# Changelog

All notable changes to RedditVault are documented here.
Newest releases at the top.

---

## [0.9.10.0] – 2026-03-16
### Changed
- **Affinity sort**: precompute `maxAuthorFreq` once in `loadData()` instead of
  recomputing `Math.max(...Object.values())` on every sort comparison — eliminates
  ~10,000 redundant object enumerations per affinity sort on a 1,000-item library.
- **Date and affinity sort**: precompute sort keys (timestamps / affinity scores)
  into a Map before sorting, replacing repeated `new Date()` construction and
  `affinityScore()` recalculation inside comparators.
- **`filteredItems()`**: consolidate 5 sequential `.filter()` chains (visibility,
  dead/alive, favourite, plus rating/links/date/subreddit/author panel filters)
  into 2 single-pass filters, reducing intermediate array allocations.
- **Search parsing**: add `cachedParseSearch()` memoisation wrapper so identical
  query strings are not re-parsed by the regex-heavy `parseSearchQuery()` on
  consecutive `filteredItems()` calls.
- **`pushListsToSupabase()`**: build an `itemId→redditId` Map before the list
  loop, replacing O(n) `allItems.find()` per membership entry with O(1) Map
  lookup.
- **Item card rendering**: precompute `itemId→listCount` Map once per render
  pass (`_rebuildListCountMap()`), replacing O(n) `state.itemLists.filter()`
  scan per rendered card.

---

## [0.9.7.6] – 2026-03-09
### Added
- CORS proxy selector in Settings → Sync New Saves → Feed connection settings:
  choose between **Cloudflare Worker** (existing behaviour, requires worker URL) and
  **CORSfix** (no setup required — uses `proxy.corsfix.com`).
- `_buildProxyUrl(feedUrl)` helper centralises proxy URL construction for both modes.
- `feedProxyType` state field (`'cloudflare'` | `'corsfix'`, default `'cloudflare'`),
  persisted to IndexedDB, pushed/pulled via `user_preferences` in Supabase.

---

## [0.9.7.5] – 2026-03-09
### Changed
- Lists tab toolbar: merged separate "+ Static" and "+ Smart" buttons into a single
  "+ New" button with an anchored dropdown menu. Reduces crowding on iOS when the
  Separate toggle and order-toggle button are also visible.

---

## [0.9.7.4] – 2026-03-09
### Added
- Lists tab: order-toggle button ("✦ Smart ↑" / "📋 Static ↑") when Separate mode is
  active — lets the user choose whether Smart or Static lists appear first.
- New `listSmartFirst` state variable (default: `true`).

---

## [0.9.7.3] – 2026-03-08
### Added
- `wrangler.toml` for Cloudflare Worker CI/CD deployment.
### Fixed
- Removed unnecessary URL manipulation in feed sync.

---

## [0.9.7.2] – 2026-03-09
### Added
- Comprehensive sync logging across previously silent code paths:
  - `syncFromFeed`: logs start, per-page item counts, pagination stop reason,
    and a detailed completion line (added / skipped / pages checked). "Up to date"
    result now appears in the sync log.
  - `pushToSupabase`: logs item count on success, error message on failure.
  - `pullPreferences`: logs preference count on success, error on failure.
  - `pushListsToSupabase`: logs upsert count, per-list membership push with member
    count; removed legacy tag-columns fallback (single-user install, no migration needed).

---

## [0.9.7.1] – 2026-03-09
### Fixed
- Static list membership delta sync: push now touches the list row's `updated_at`
  after writing memberships, so the moddatetime trigger fires and the delta pull
  detects the change.
- Pull-side membership reconciliation: changed from full clear+rebuild to per-list
  add/remove diff (only for lists flagged as changed by `updated_at`).

---

## [0.9.7.0] – 2026-03-09
### Added
- Delta sync: items and lists pulls now use `updated_at=gt.{lastSync}` filter,
  fetching only rows modified since the last successful pull.
- `lastSync` timestamp is recorded at pull **start** (not end) to avoid missing
  rows modified during a slow pull.
- "Already up to date" toast when delta returns zero changes.

---

## [0.9.6.4] – 2026-03-09
### Added
- Search: word-boundary matching by default — bare words only match whole words
  (`witch` does not match `switch`).
- Search: wildcard syntax — `word*` (prefix), `*word` (suffix), `*word*` (substring),
  applied per word not per field.
- Search: bare-comma OR groups (`a, b, c` equivalent to `(a, b, c)`); negation in
  bare-comma OR falls through to AND.
- Search: wildcards work inside OR groups.
- Search: collapsible syntax tips panel below search bar.

---

## [0.9.6.x] – 2026-03-08
### Added
- Soft-delete with `isPermanentlyDeleted` flag + `deletedAt` timestamp; items hidden
  everywhere except a dedicated Deleted Items view and are never resurfaced by feed sync.
- Restore button in Deleted Items view.
### Fixed
- iOS pinch-to-zoom fixes; viewport `maximum-scale` now controllable via Behaviour setting.

---

## [0.9.4 – 0.9.5] – 2026-03-08
### Changed
- Settings panel fully restructured into six labelled sections (Sync, Cloud DB, Library,
  Import & Enrich, Behaviour, Diagnostics).
### Fixed
- `render()` correctness fixes; improved error boundary with version info in recovery UI.

---

## [0.9.3.x] – 2026-03-08
### Added
- Home screen dashboard (active item counts, quick-action cards).
- Backup & Restore: export/import full IndexedDB snapshot as JSON.

---

## [0.9.2.x] – 2026-03-07
### Added
- Sync indicator overhaul with live progress display.
- Diagnostic sync log panel (in-memory, shown in Diagnostics section).

---

## [0.9.x] – 2026-03-06
### Added
- Smart tag chips: smart lists with `isTag: true` render as coloured pill badges on
  matching items in browse view and as filter buttons above the list.
- Affinity sort: scores items by rating, favourite status, author frequency, and tag
  membership. `rebuildAuthorFreq()` and `rebuildTagCache()` precompute data on load.
- Tag cache (`state.tagCache`) for O(1) tag chip rendering.
- iOS layout fixes for safe-area insets.

---

## [0.8.8.1 – 0.8.9] – 2026-03-06
### Fixed
- Markdown link parsing: extracts links before HTML escaping to avoid mangling brackets.
- Sync indicator edge-case fixes.
- Dirty-tracking reliability improvements.

---

## [0.8.3 – 0.8.8] – 2026-03-06
### Fixed
- Critical DB/schema fixes post-Lists migration.
- List sync repairs (static list membership reconciliation).
- `updated_at` trigger ensures delta sync catches membership changes.

---

## [0.8.0 – 0.8.2] – 2026-03-06
### Added
- **Lists system** replacing Folders: static lists (manual membership) and smart lists
  (search-query-driven, computed at runtime).
- Advanced filter panel: subreddit, author, date range, date field selector.
- `reddit_lists` and `reddit_item_lists` Supabase tables; `reddit_item_lists` junction
  in IndexedDB schema (version 8).

---

## [0.7.13 – 0.7.20] – 2026-03-05
### Added
- Cloudflare Worker CORS proxy for RSS feed sync (replaces Vercel serverless proxy).
### Fixed
- Multiple feed sync reliability fixes.
- UI reorganisation for sync controls.

---

## [0.7.6 – 0.7.12] – 2026-03-05
### Added
- Feed sync (`syncFromFeed()`): fetches Reddit private RSS via proxy, parses JSON,
  upserts new items. Auto-sync on configurable interval.
- Vercel serverless proxy (later replaced by Cloudflare Worker).

---

## [0.5.3 – 0.6.3] – 2026-03-05
### Added
- Bidirectional cloud sync with Supabase (push + pull with delta filter).
- Ratings (0–5 stars) and dislike (soft trash) per item.
- Trash view: recoverable trashed items.

---

## [0.4.2 – 0.5.2] – 2026-03-05
### Added
- Advanced search parser: OR groups `(a, b)`, exact phrases `"..."`, wildcards `*`,
  negation `-word`, field prefixes `r:`, `u:`, `type:`.
- Favourites toggle per item.
- Recent search history.

---

## [0.3.6 – 0.4.1] – 2026-03-04
### Added
- `enrichStatus` field: `pending` / `enriched` / `dead`.
- Rate limiting for enrichment: configurable RPM with 7.5s default delay.
- Exponential backoff on failed enrichment requests.

---

## [0.2.x – 0.3.5] – 2026-03-04
### Added
- Enrichment: fetch `old.reddit.com/{permalink}.json` for title, body, author, score,
  subreddit — no auth required.
- Separate `saved_at` vs `post_created_at` timestamps.
- Pagination fixes for large libraries.

---

## [0.1.0] – 2026-03-04
### Added
- Initial build: Chrome extension (session-cookie sync), Supabase backend, iOS PWA.
- IndexedDB (Dexie) as primary local store.
- CSV import from Reddit saved export.
- Basic browse, search, and Supabase push/pull.
