# Changelog

All notable changes to RedditVault are documented here.
Newest releases at the top.

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
- Wrangler `wrangler.toml` for Cloudflare Worker CI/CD deployment.
### Fixed
- Removed unnecessary URL manipulation in feed sync.

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
- Feed sync (`syncFeed()`): fetches Reddit private RSS via proxy, parses JSON, upserts
  new items. Auto-sync on configurable interval.
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
- Rate limiting for enrichment: configurable RPM with 7.5 s default delay.
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
