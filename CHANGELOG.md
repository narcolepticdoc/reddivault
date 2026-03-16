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

## [0.9.9.34] - 2026-03-16
### Fixed
- **Search box ✕ appears immediately while typing** -- the clear button inside
  the search wrap is now always present in the DOM (hidden via `display:none`)
  and toggled directly from `handleSearchInput` via its id, so it appears as
  soon as you start typing without requiring a tab switch or full re-render.
- **"Clear search & filters" right-aligned** -- the persistent clear button
  below the search bar is now right-aligned to sit under the Filters button,
  not the left edge.

---

## [0.9.9.33] - 2026-03-15
### Fixed
- **Stale result count while typing** -- `handleSearchInput` was calling
  `filteredItems()` eagerly on every keystroke before the debounce fired,
  showing misleading counts at 1-2 chars. Count now only updates when
  `renderBrowseList()` fires after the debounce threshold is met.
- **Clear search button always visible** -- "Clear search & filters" now
  renders as a persistent element below the search bar (hidden via
  `visibility:hidden` rather than removed from DOM) and updates live as
  you type without requiring a full re-render.
- **Add to List only shows static lists** -- smart lists are saved searches
  and cannot have items manually pinned; they are now excluded from the
  Add to List modal.
### Changed
- **Search debounce threshold lowered to 3 characters** -- live search now
  fires after 3 chars instead of 4, covering more short but meaningful words.

---

## [0.9.9.32] - 2026-03-15
### Fixed
- **CORSfix proxy restored to original working state** -- the `&limit=25`
  workaround and URL encoding change introduced during troubleshooting were
  reverted. CORSfix works correctly with the raw unencoded URL appended
  directly. Earlier failures were caused by a subscription lapse, not a
  code problem.
### Added
- **Detailed feed sync diagnostics** -- the sync log now shows the full proxy
  URL being constructed and the response body on failure, making proxy
  issues much easier to diagnose.

---

## [0.9.9.31] - 2026-03-15
### Changed
- Reverted corsfix URL encoding introduced in 0.9.9.29.
- Added `isCorsfix` guard to skip `&limit=25` for corsfix (later reverted
  in 0.9.9.32 -- was unnecessary, root cause was subscription lapse).

---

## [0.9.9.30] - 2026-03-15
### Added
- Feed sync now logs the constructed proxy URL and full response body on
  HTTP errors to the sync log for easier troubleshooting.

---

## [0.9.9.29] - 2026-03-15
### Fixed (later reverted)
- Attempted fix for corsfix invalid URL error by encoding the target URL.
  Reverted in 0.9.9.31 -- root cause was a subscription lapse, not a URL
  construction problem.
### Infrastructure
- **Cloudflare Worker updated** -- `ALLOWED_ORIGIN` replaced with dynamic
  origin checking. The worker now accepts requests from the production URL,
  all Vercel preview deployments from the narcolepticdocs account
  (`*-narcolepticdocs-projects.vercel.app`), and localhost. Old builds can
  be tested via the Vercel deploy dashboard -- each deployment retains its
  own preview URL and passes through the Cloudflare proxy correctly.

---

## [0.9.9.28] - 2026-03-12
### Added
- **Wildcard support for `r/` and `u/` tokens** -- trailing `*` does a
  prefix match on the field value. `r/python*` matches `python`,
  `pythonlanguage`, `pythoncode` etc. but not `learnpython`. Works in
  comma lists too: `r/python*, r/rust`. `u/ali*` matches `alice` etc.

---

## [0.9.9.27] - 2026-03-12
### Fixed
- **`r/sub` and `u/user` now exact-match** -- field tokens were using
  `.includes()` (substring match) so `r/py` would match `python`, `pytorch`,
  `learnpython` etc. Changed to strict equality.

---

## [0.9.9.26] - 2026-03-12
### Fixed
- **Multiple `r/` and `u/` debounce trigger** -- search now fires as soon as
  a field token like `r/sub` looks complete, instead of waiting for a space
  or a 4-char bare word.

---

## [0.9.9.25] - 2026-03-12
### Added
- **Multiple `r/` and `u/` tokens now OR within their field** -- `r/python
  r/rust` and `r/python, r/rust` both return posts from either subreddit.
  `u/alice, u/bob` returns posts by either author. Multiple field tokens of
  the same type collapse into a `fieldOrGroup` after parsing.
- **`r/this, r/that, u/user` AND logic** -- subreddit OR group is ANDed with
  the user filter, returning posts by that user in any listed subreddit.
- **Case-insensitive field prefixes** -- `R/`, `U/`, `R:`, `U:` all work the
  same as lowercase equivalents.
### Fixed
- Trailing commas on field tokens stripped so `r/sub,` from mixed
  space+comma queries matches correctly.
### Changed
- Search input now has `autocapitalize="none"` and `autocorrect="off"` to
  suppress iOS sentence-capitalisation and autocorrect.

---

## [0.9.9.24] - 2026-03-12
### Fixed
- **Swipe-back gesture on list overview** -- the swipe-right listener
  persisted on the `main-content` element after navigating back to the list
  overview, causing the screen to slide around on a ghost gesture. The
  `touchmove` and `touchend` handlers now check `state.listView` at gesture
  time and bail out if not in a detail view.

---

## [0.9.9.23] – 2026-03-12
### Added
- **Swipe back from list detail** — swiping right from the left edge of the
  screen while viewing a list returns to the Lists overview, matching the
  same gesture used to dismiss the preview sheet in Browse. The content
  slides out to the right with a spring-back if the threshold isn't met.

---

## [0.9.9.22] – 2026-03-12
### Fixed
- **Comma OR with quoted phrases** — `A, B, "C D", E` now correctly produces
  an OR group. Previously the presence of quotes caused the comma path to bail
  out entirely, falling through to AND parsing which matched nothing.
- **Quoted phrases inside paren OR groups** — `("A B")` and `(A, "B C", D)`
  now work correctly. The paren parser was passing quoted terms straight to
  `_parseWildcard` which has no concept of quotes, producing a token with
  literal quote characters that never matched.
- Verified by a 61-case test suite covering: word boundaries, AND, quoted
  phrases, negation, wildcards, bare comma OR, paren OR, field tokens
  (`r/`, `u/`, `type:`), body search toggle, smart quote normalisation,
  and negated comma fall-through to AND mode.

---

## [0.9.9.21] – 2026-03-11
### Changed
- **Clump detection now lazy** — no longer runs on every `loadData`. Instead
  runs once the first time the user selects "Date Saved" sort, then caches
  the result for the session. Reset only when the patch tool runs.
- **Flat 100-item threshold** — replaced the `max(50, 5%)` heuristic with a
  flat threshold of 100 items per hour. Any hour bucket with ≥100 items is
  unambiguously an import event; organic save activity never reaches that.

---

## [0.9.9.20] – 2026-03-11
### Fixed
- **Patch Import Date Clumps now syncs to cloud** — after patching `savedAt`
  values, the tool pushes all affected items to Supabase so the fix isn't
  overwritten by the next cloud pull.
### Added
- **Date saved sort warning** — when sorting by Date Saved, a yellow notice
  appears if import date clumps are detected, explaining that sort order may
  not reflect actual save order and linking to the patch tool in Settings.
  The clump check runs once after `loadData` and is cached; invalidated
  automatically after the patch tool runs.

---

## [0.9.9.19] – 2026-03-11
### Added
- **Tag count in Library settings** — Smart list breakdown now shows a
  `↳ Tags` sub-row so you can see at a glance how many smart lists are
  pinned as tag chips.
### Changed
- **Tag drawer sorted alphabetically** — tag chips in the Browse search tray
  now sort A→Z by tag name instead of creation order.
- **Tags section in Lists tab sorted alphabetically** — same ordering applied
  to the 🏷 Tags group in the Lists tab.

---

## [0.9.9.18] – 2026-03-11
### Added
- **📅 Patch Import Date Clumps** troubleshooting tool in Settings. Scans
  `savedAt` values for "clumps" — any hour bucket containing ≥5% of the
  library or ≥50 items, which indicates a bulk CSV import where all items
  received a synthetic timestamp. Replaces `savedAt` with `postCreatedAt` for
  affected items as a more time-consistent approximation. Items with no post
  date are skipped. Shows a confirmation dialog with a full clump summary
  before making any changes.

---

## [0.9.9.17] – 2026-03-11
### Fixed
- **Banner cancel resets search** — dismissing the editing banner (✕) now calls
  `newSearch()`, clearing search text, tags, filters and sort instead of just
  hiding the banner.
- **Save over / Save as new resets search** — after saving a list from the
  Save modal, search state is cleared and the app navigates directly to the
  saved list in the Lists tab. Cancelling the modal leaves search untouched.
- **isTag pre-checked in Save modal** — when editing an existing list that is
  already a tag chip, the "Show as tag chip" checkbox is pre-checked and the
  tag name field is pre-filled.

---

## [0.9.9.16] – 2026-03-11
### Fixed
- **Recent searches clickable** — items now use `_sl()` index lookup instead of
  `JSON.stringify()` inline in HTML, which broke with spaces/special characters.
- **Keyboard no longer dismissed on every keystroke** — `handleSearchInput` no
  longer calls `render()` on each character; debounce path unchanged.
- **Tab switches scroll to top** — `showPage()` now resets both `main-content`
  scrollTop and `window.scrollY` after render.
### Changed
- **New Search / Clear** moved directly below the search bar as a small text
  link, away from the Save and Sort controls to prevent mis-taps.

---

## [0.9.9.15] – 2026-03-11
### Changed
- **Recent searches** are now always visible in the Browse tab as a collapsible
  section (▶ Recent), collapsed by default. Previously only appeared when the
  search bar was focused and empty.
- **`r/subreddit` and `u/username`** are now the canonical search syntax,
  matching Reddit's own URL convention. The old `r:` and `u:` colon form still
  works — both delimiters are accepted.
- Search placeholder and tips updated to reflect `r/sub` / `u/name` syntax.
- **New Search button** (✕ New search) appears in the result count row whenever
  there is any active search, filter, or non-default sort. Clears everything
  and returns to a clean Browse state.
- **"See all →"** on the home screen now performs a full new search (clears
  filters, tags, and text) with sort set to Date Saved descending.
- **Options summary** (saved filters & sort) now shown on list cards, the list
  detail view header, and the edit modal, using a shared helper. Edit modal
  includes the tag-matching behaviour note.

---

## [0.9.9.14] – 2026-03-11
### Changed
- **Quick Access** (home screen): renamed from "Your Tags", now shows all lists
  (static and smart) sorted by recency, not just tags. Tapping a tile opens the
  list in the Lists tab directly instead of launching a search.
- **Saved this week**: removed the 5-item cap, now shows the full 7-day window
  grouped into day buckets (Today, Yesterday, 2 days ago…). "See all →" now
  switches to Browse with sort order set to Date Saved descending.
- **Search now searches title only by default.** Subreddit and author are
  excluded from plain-text search — use `r:` and `u:` syntax for those. A new
  **Search body text** checkbox in the Filters panel opts in to searching post
  and comment body text.
- **Saved list options (DB schema v9).** Filters and sort order are now saved
  alongside a smart list (`optionsJson` / `options_json` column). They are
  restored when the list is opened directly but are never consulted during tag
  chip matching, so compound searches remain predictable. The save and edit
  modals show a note explaining this distinction. A summary of active saved
  options is shown in the edit modal.
### Migration
- Existing Supabase installs: run the new migration line in `supabase-schema.sql`
  (`ALTER TABLE reddit_lists ADD COLUMN IF NOT EXISTS options_json text DEFAULT null`).
- IndexedDB upgrades automatically to version 9 on first load.

---

## [0.9.9.13] – 2026-03-11
### Added
- **Swipe right from the left edge to dismiss the item view.** Starting a swipe
  within 40px of the left edge drags the sheet out to the right, mirroring the
  browser back gesture. The sheet follows your finger with the backdrop fading;
  releasing past 80px dismisses, releasing earlier snaps back.
- Swipe down from the header/handle (added in 0.9.9.12) still works alongside
  this — both gestures coexist, direction is decided on first movement.

---

## [0.9.9.12] – 2026-03-11
### Added
- **Swipe down to dismiss the item view.** Drag down on the header or drag
  handle of the preview sheet to dismiss it. The sheet follows your finger
  in real time with the backdrop fading as you pull; releasing past 120px
  animates it away, releasing earlier snaps it back. A drag handle pill at
  the top of the sheet provides the standard visual affordance.

---

## [0.9.9.11] – 2026-03-11
### Changed
- **Item card link buttons now match the full item view.** The right-side button
  group on each card is now two consistent buttons:
  - **🔗** — opens the link(s) inside the item (external URL for link posts,
    links extracted from body text). Shows a count badge and opens the picker
    when multiple links are present. Hidden for Reddit-only posts with no
    external links.
  - **↗** — always opens the Reddit permalink.
  Previously the card had a mixed "open URL or permalink" button plus a
  conditional 💬 thread button, which was inconsistent with the full item view.

---

## [0.9.9.10] – 2026-03-10
### Fixed
- **"Last synced" now updates when startup check confirms we are already in
  sync.** `checkCloudAhead` previously set `syncStatus = 'connected'` without
  advancing `lastSyncedAt`, so the timestamp stayed stale on a clean startup
  with no data to pull. It now writes the current time to `lastSyncedAt`
  whenever it confirms parity with the cloud.

---

## [0.9.9.9] – 2026-03-10
### Fixed
- **`pushItemUpdate` and `pushItemDelete` now call `markClean`** on success,
  advancing `lastPushedAt`. Previously, rating, favouriting, trashing, or
  deleting an item wrote to Supabase without moving the delta cursor, meaning
  the next pre-push pull would re-fetch those rows unnecessarily, and in a
  two-device scenario could allow a stale remote version to overwrite a recent
  local write.
- **`purgeDeletedItems`, `deleteAllTrashed`, and `trashAllDead`** all call
  `markClean` after their write loops complete, for the same reason.

---

## [0.9.9.8] – 2026-03-10
### Fixed
- **Retry timer not cancelled after pull.** `syncFromSupabase` now resets
  `_retryCount` and clears `_retryTimer` when it clears `localDirty`, matching
  what `markClean` does. Previously the retry scheduler could fire needlessly
  after a successful pull.
- **`markClean` called once per batch in `pushAllToSupabase`.** Each 200-item
  batch was calling `markClean` (and writing `last_modified` to Supabase).
  `pushToSupabase` now accepts `skipClean=true`; the batch loop passes it and
  lets `pushListsToSupabase` call `markClean` once at the end of the full
  operation.

---

## [0.9.9.7] – 2026-03-10
### Fixed
- **`markClean` no longer called after a pull.** Calling it there incorrectly
  advanced `lastPushedAt` (the delta cursor), which would cause a Device A pull
  to move the cursor past Device B's writes, permanently hiding them from future
  delta pulls. Pull completion now directly clears `localDirty` and advances
  `lastSyncedAt` only.
- **`deltaPullBeforePush` no longer fires once per batch.** It was wired into
  `pushToSupabase`, which is called in a loop by `pushAllToSupabase`. It now
  fires exactly once at the top of each push operation — once in
  `pushAllToSupabase` (passing `skipPull=true` to the subsequent
  `pushListsToSupabase`), and once at the top of standalone
  `pushListsToSupabase` calls.
- **`deltaPullBeforePush` now handles list deletions and membership changes**
  from a remote device — it reconciles local lists against the full remote name
  set and rebuilds static list memberships for any changed lists.
- **`deleteListFromSupabase` now pulls before deleting**, consistent with all
  other write operations.
- **Dead `lastSync` config key removed** from `loadConfig` — this was a leftover
  from before the cursor was renamed to `lastPushedAt`.

---

## [0.9.9.6] – 2026-03-10
### Fixed
- **"Last synced" now reflects both push and pull.** Introduced a separate
  `lastSyncedAt` field (display-only) that advances on any successful sync
  event — push or pull. `lastPushedAt` is kept as the delta cursor and only
  advances on push, which remains correct. The two concerns are now cleanly
  separated.

---

## [0.9.9.5] – 2026-03-10
### Fixed
- **Delta sync cursor corrected.** The pull cursor is now `lastPushedAt` (the
  time of the last successful push) rather than the time of the last pull.
  This is semantically correct: the question being asked is "has anything
  changed on the cloud since I last wrote to it?" — not "since I last read
  from it." The old approach would miss writes from a second device in some
  multi-device scenarios.
- **Pull before push.** Every push now performs a lightweight delta pull first,
  merging any remote changes since the last push before writing local changes.
  This makes two-device use (phone + desktop, used at different times) robust
  against silent data loss. Simultaneous editing on two devices remains
  unsupported and is warned against in the UI.
- **"Last synced" reflects last push**, not last startup pull. The timestamp
  in Settings now shows when you last successfully wrote to the cloud, which
  is the meaningful sync event from a data-integrity perspective.

---

## [0.9.9.4] – 2026-03-10
### Fixed
- Removed the ▶ Run search button from list cards — search editing is now
  accessed exclusively via the ✏️ edit modal, keeping the card UI clean.

---

## [0.9.9.3] – 2026-03-10
### Fixed
- **Single save location while editing** — "+ Save as list" is hidden when an
  editing session is active; the banner is the only save point, removing the
  ambiguity of two concurrent save buttons.
- **Tag being edited excluded from tray** — when editing a list/tag via Run
  search, that tag is hidden from the chip tray entirely so it can't be
  self-referenced.
- **Tag badge no longer breaks mid-word** in the Lists tab — added
  `white-space:nowrap` so multi-word tag names always wrap as a whole unit.
- **Query field read-only in edit modal** — the search query is displayed as
  text with an "✏️ Edit in search" button; the only way to change a query is
  via Run search → Save over, keeping the editing flow consistent.
- **List and tag name deduplication** — creating or renaming a list/tag is
  blocked if the name (case-insensitive) matches any existing list name or
  tag name, with a clear error message.

---

## [0.9.9.2] – 2026-03-10
### Added
- **Tag tokens in saved list queries.** Active tag chips are now included when
  saving a search as a smart list. Tags are serialised as `[#name]` tokens in
  the query string (e.g. `[#AI & ML] [#Dev Tools] horses`). When tagMode is OR,
  tags are wrapped in a group: `([#AI & ML], [#Dev Tools]) horses`. Tokens
  resolve to the tag's current query at match time, so if a tag changes the
  list updates automatically.
- **"▶ Run search" button** on smart list cards and in the edit modal. Navigates
  to Browse with the list query decoded — `[#name]` tokens are resolved back to
  active tag chips where possible. A persistent banner shows "Editing: [name]"
  with Save as list / Save over / ✕ controls.
- **"Save as list" visible when tags are active** (previously only shown when
  there was a text search query).
- **Save over existing list** — when launched via Run search, the Save modal
  offers both "Save over" and "Save as new".
- **Tag name validation** — short tag names are restricted to alphanumeric
  characters, spaces, `&`, and `/`. Special characters used by the search
  syntax are disallowed. Enforced with an inline error on create and edit.
- **Missing tag warnings** in the list edit modal — if a `[#name]` token refers
  to a tag that no longer exists, a warning is shown next to the query field.
- **Circular reference prevention (two layers):**
  - UI: when editing a tag, tags that would create a cycle are greyed out in
    the tray. Tapping one shows a toast explaining why it's unavailable.
  - Save: full dependency graph traversal on save blocks any cycle with a
    clear error message showing the full cycle path.

---

## [0.9.9.1] – 2026-03-10
### Changed
- Tag tray collapse button is now a visible labelled button ("▾ Collapse tags" /
  "▸ Show tags") using the standard ghost button style, replacing the nearly
  invisible bare chevron.
- Lists tab Separate/Merge toggle now shows the current state ("⊞ Merged" /
  "⊟ Separated") rather than the action verb, so it's clear what mode you're
  in rather than what will happen if you tap.

---

## [0.9.9.0] – 2026-03-10
### Added
- Feed sync section now shows timestamp of last successful sync.
- Tag tray is now collapsible — tap ▾ to collapse, ▸ tags to expand. When
  collapsed, only active tag chips are shown so active filters remain visible.
- Search tips: documented `()` OR groups and mixed AND+OR syntax with examples.

### Fixed
- "Open Reddit Feeds page" button now navigates via `window.location.href`
  instead of `window.open`, correctly opening in the external browser on iOS PWA.
- List sorting now ignores leading punctuation — e.g. `(Milk, cookies)` sorts
  alongside `M` rather than before `A`.

### Changed
- About enrichment: renamed to "About importing and enrichment". Rewrote
  content to cover feed-first advice, the <1000 items shortcut, Arctic Shift
  as first choice with archive caveat, Reddit pass judgement guidance, and
  retry explanation.

---

## [0.9.8.19] – 2026-03-09
### Changed
- Lists empty state: updated description to mention tag chips.
- Create/edit smart list modal: "Show as tag chip in search" renamed to "Show as
  tag chip" with an expanded description explaining the tag tray and Lists tab
  grouping behaviour.
- Settings → About enrichment: replaced inaccurate "8–10 req/min, several hours"
  framing with accurate two-phase description (Arctic Shift bulk pass first, then
  Reddit per-item fallback). Clarified retry purpose.
- Settings → CORS Proxy: added brief explanation of why a proxy is needed and
  what the privacy implications are for each option. Cloudflare Worker note
  clarified to state it requires a one-time deploy. CORSfix note updated to
  note it may be capacity limited and that the feed token passes through a
  third-party server.

---

## [0.9.8.18] – 2026-03-09
### Changed
- Lists tab (Separate mode): Smart Lists group now has a collapsible 🏷 Tags
  subsection at the top, containing only smart lists marked as tags. Non-tag
  smart lists appear below it. Tap the Tags header to collapse/expand.
- Tags subsection only appears when there is a mix of tag and non-tag smart
  lists — if all (or none) are tags the Smart group stays flat.
- Merged mode unchanged — all lists remain in a single flat alphabetical list.
- New `tagsCollapsed` state variable (default: false).

---

## [0.9.8.17] – 2026-03-09
### Fixed
- "🔗 Open Reddit Feeds page" button now forces an external browser via
  `window.open(..., '_system')` instead of `<a target="_blank">`, which was
  opening inside the PWA's in-app browser where the user's Reddit session
  is not available.

---

## [0.9.8.16] – 2026-03-09
### Changed
- Lists toolbar: Separate/Merge and order-toggle buttons moved to the left side of
  the header (between the "Lists" title and "+ New"), pinning "+ New" to the far
  right. Prevents the "+ New" button from shifting position when the toggle buttons
  appear/disappear.

---

## [0.9.8.15] – 2026-03-09
### Fixed
- Back-merged v0.9.7.3–v0.9.7.5 Claude Code changes that were missing from the
  claude.ai build (those versions had been built locally and never reconciled):
  - `wrangler.toml` added to `cloudflare-worker/` for `wrangler deploy` CI/CD
  - Cloudflare Worker: removed hostname normalisation to `old.reddit.com` — trusts
    the URL as configured by the user
  - Feed sync: simplified `&limit=25` append (ternary was dead code; `?` is
    guaranteed by `saveFeedUrl` validation)
  - Lists tab: `listSmartFirst` state + "✦ Smart ↑ / 📋 Static ↑" order-toggle
    button (visible when Separate mode is active)
  - Lists tab: "+ Static" and "+ Smart" buttons merged into a single "+ New"
    dropdown

---

## [0.9.8.14] – 2026-03-09
### Added
- Trash count row in Settings → Library stats panel.

---

## [0.9.8.13] – 2026-03-09
### Added
- "🔗 Open Reddit Feeds page" button in Feed connection settings. Opens
  `old.reddit.com/prefs/feeds/` in an external browser tab so the user's existing
  Reddit session is available to find their private feed URL. Avoids opening it
  in-app where there would be no session.

---

## [0.9.8.12] – 2026-03-09
### Fixed
- Backup/restore was silently discarding all settings. `exportJSON` only saved
  `items`, `lists`, and `itemLists` — the entire `db.config` table was excluded,
  meaning Supabase credentials, feed URL, proxy settings, enrich speed settings,
  and behaviour preferences were all lost on restore.
- `exportJSON` now reads and includes a `config` object containing all meaningful
  config keys: `supabaseUrl`, `supabaseKey`, `redditFeedUrl`, `feedProxyUrl`,
  `feedProxyType`, `enrichReqPerMin`, `enrichRetryReqPerMin`, `enrichRateLimitPause`,
  `enrichMaxAttempts`, `confirmDestructive`, `disableZoom`, `autoFeedSync`,
  `autoFeedSyncInterval`, `recentSearches`. Transient sync state (`localDirty`,
  `lastPushedAt`, `lastSync`, `lastFeedSync`, `lastRunRateLimitHits`) is intentionally
  excluded.
- `restoreFromBackup` now writes config keys back to `db.config` and calls
  `loadConfig()` so restored settings take effect immediately without a reload.
- Backwards compatible — old backups without a `config` key restore items/lists
  as before.

---

## [0.9.8.11] – 2026-03-09
### Added
- Deleted items view now has a `👁 View` button and clickable title (same as the
  trash view) so you can open the in-app preview before deciding whether to restore
  or purge an item.

---

## [0.9.8.10] – 2026-03-09
### Fixed
- Home screen "Saved" count included disliked and permanently deleted items
  (`state.items.length` with no filter), causing it to diverge from the Library
  count in Settings which correctly filters those out. Home screen now derives all
  counts from the same `active` filter (`!isDisliked && !isPermanentlyDeleted`),
  so both views agree after a cloud pull that restores previously-deleted items.

---

## [0.9.8.9] – 2026-03-09
### Removed
- "Remove feed-imported items" button and `removeFeedItems()` function — too
  destructive for a button that lives next to routine actions.

---

## [0.9.8.8] – 2026-03-09
### Added
- "↩ Retry all" button next to the Unavailable count in Settings → Library. Resets
  all dead items to `enrichStatus: 'pending'` with `enrichAttempts: 0` so they
  appear in the next enrichment run. Confirms count before acting.

---

## [0.9.8.7] – 2026-03-09
### Fixed
- Import tap/click non-functional on desktop and mobile. The drop zone `onclick`
  referenced `#csv-file` which was never rendered into the DOM — only drag-and-drop
  worked as a result. Fixed by embedding the hidden `<input type="file">` directly
  inside the drop zone element so it always exists when the click fires. Removed the
  now-redundant `attachEventListeners` wiring for `csv-file`.

---

## [0.9.8.6] – 2026-03-09
### Added
- Feed sync progress bar: shows current page (of up to 40), running new/already-saved
  counts while sync is in progress. State tracked in `state.feedSyncProgress` so the
  bar renders from state on every `render()` call.
- Reddit enrichment rate limit countdown: instead of silently blocking for several
  minutes, the progress area now shows "⏳ Rate limited — Resuming in 4m 23s" with a
  live per-second countdown. A `sleepWithCountdown(ms)` helper drives the ticker by
  updating `#rl-countdown` every second without triggering a full `render()`.

---

## [0.9.8.5] – 2026-03-09
### Changed
- Enrichment split into two separate operations:
  - **⚡ Enrich via Arctic Shift** — bulk lookup, thousands enriched in seconds
  - **🐢 Enrich via Reddit** — per-item fallback, may catch what Arctic Shift missed
    but can take hours; includes retry run option
- `enrichAllItems()` removed and replaced with `enrichViaArcticShiftOnly()` and
  `enrichViaRedditOnly(retryFailed)`.
- Progress is now stored in `state.enrichProgress.phase` ('arctic' | 'reddit') so
  `render()` can reconstruct the correct progress display after a tab switch —
  fixes the progress bar resetting when switching away and back.

---

## [0.9.8.4] – 2026-03-09
### Fixed
- Arctic Shift was receiving `t3_ch63ro` style IDs with prefix, and commas were being
  URL-encoded as `%2C` by `encodeURIComponent` on the whole ids string, which broke
  the comma-separated list parsing on their end.
- IDs are now stripped to bare base36 (`ch63ro`) before sending.
- Commas in the `ids` parameter are now literal (only individual IDs would need
  encoding, and base36 IDs contain no special characters).
- Added `sample url` to batch log entries so the actual URL sent is visible for
  future debugging.

---

## [0.9.8.3] – 2026-03-09
### Fixed
- Arctic Shift API returned HTTP 400 `'permalink' is not a valid field` — `permalink`
  is not in the Arctic Shift schema for posts or comments.
- Removed `permalink` from both field lists. Permalink is now constructed locally:
  - Posts: `https://reddit.com/r/{subreddit}/comments/{id}/`
  - Comments: `https://reddit.com/r/{subreddit}/comments/{postId}/_/{commentId}/`
    (using `link_id` field to get the parent post id)
- Verified valid field lists against the Arctic Shift API README:
  - Posts: `id, title, author, subreddit, selftext, url, score, created_utc`
  - Comments: `id, body, author, subreddit, score, created_utc, link_id`

---

## [0.9.8.2] – 2026-03-09
### Fixed
- Arctic Shift API returned HTTP 400 `'name' is not a valid field` — removed `name`
  from both `ARCTIC_POST_FIELDS` and `ARCTIC_COMMENT_FIELDS`. The `id` field alone
  is sufficient for matching; `name` was redundant.

---

## [0.9.8.1] – 2026-03-09
### Fixed
- Arctic Shift functions were silently swallowing all errors (`catch { return new Map() }`
  with no logging). Now logs at every failure point:
  - HTTP non-OK responses: logs status code + first 200 chars of response body
  - Non-array response shape: logs the raw response so the actual API format is visible
  - Network/fetch exceptions: logs the error message
  - Success path: logs IDs sent, items returned, items matched (for diagnosing zero-match issues)
  - `enrichViaArcticShift`: logs item counts by type at start, batch count, and final
    enriched/fallback split at completion.

---

## [0.9.8.0] – 2026-03-09
### Added
- **Arctic Shift two-phase enrichment**: enrichment now runs a fast bulk pass
  against the Arctic Shift public Reddit archive API before falling back to the
  slow Reddit per-item enricher.
  - Phase 1 (⚡ Arctic Shift): batches up to 500 IDs per request, no auth needed,
    resolves thousands of items in minutes. Posts and comments use separate endpoints.
  - Phase 2 (🐢 Reddit fallback): existing per-item `enrichItemFromReddit()` loop,
    unchanged, handles only items Phase 1 missed (very new posts, archive gaps).
  - Progress UI shows which phase is running with distinct labels and separate counters.
  - Toast at completion reports the Arctic Shift contribution:
    e.g. "✓ Enriched 4,832 (4,651 via Arctic Shift) · 181 unavailable".
- New functions: `arcticPostToEnriched`, `arcticCommentToEnriched`,
  `arcticFetchPostBatch`, `arcticFetchCommentBatch`, `enrichViaArcticShift`.
- 500ms polite delay between Arctic Shift batches (community resource).

---

## [0.9.7.7] – 2026-03-09
### Fixed
- Switching between Cloudflare Worker and CORSfix no longer collapses the
  Feed connection settings panel (removed `render()` call from radio `onchange`).
- Proxy type now saves immediately to state + IndexedDB on selection — no need
  to hit Save just to switch modes. Worker URL field shows/hides in-place via DOM
  toggle rather than full re-render.

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
