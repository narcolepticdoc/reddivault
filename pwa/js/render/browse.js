// render/browse.js — view rendering (split out of the former render.js).
import { applySearch, checkSavedAtClumps, clearFilters, commitSearch, hasActiveFilters, newSearch, removeSavedSearchByIndex, runSavedSearch, saveCurrentSearchAsList, setFilter, showPage, toggleTagChip, trashAllDead } from '../items.js';
import { buildTagDepGraph, filteredItems, getTagsContaining } from '../search.js';
import { state } from '../state.js';
import { escHtml, showToast } from '../util.js';
import { renderItemCard } from './card.js';
import { render, renderSortControl } from './shell.js';
import { renderTrashView } from './trash.js';

export function renderAuthorList() {
  // Build sorted author list — min 2 saves, sorted by count desc
  const authors = Object.entries(state.authorFreq)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (authors.length === 0) {
    return `<div class="empty"><div class="empty-icon">👤</div><h3>No repeat authors yet</h3>
      <p>Authors you've saved 2 or more times will appear here.</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="state.showAuthorList=false;render()">← Back</button>
    </div>`;
  }

  // Group into tiers
  const tiers = [
    { label: '🏆 10+ saves', min: 10, items: authors.filter(([_,c]) => c >= 10) },
    { label: '⭐ 5–9 saves',  min: 5,  items: authors.filter(([_,c]) => c >= 5 && c < 10) },
    { label: '👤 2–4 saves',  min: 2,  items: authors.filter(([_,c]) => c >= 2 && c < 5) },
  ].filter(t => t.items.length > 0);

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:18px">Frequent Authors</div>
      <button class="btn btn-ghost btn-sm" onclick="state.showAuthorList=false;render()">← Back</button>
    </div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
      ${authors.length} author${authors.length!==1?'s':''} saved multiple times. Tap any to search their posts.
    </p>
    ${tiers.map(tier => `
      <div style="margin-bottom:20px">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${tier.label}</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${tier.items.map(([author, count]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;cursor:pointer"
              onclick="state.showAuthorList=false;applySearch('u/${escHtml(author)}')">
              <span style="font-size:14px;color:var(--text)">u/${escHtml(author)}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:12px;color:var(--text-muted)">${count} save${count!==1?'s':''}</span>
                <span style="font-size:12px;color:var(--accent2)">→</span>
              </div>
            </div>`).join('')}
        </div>
      </div>
    `).join('')}`;
}

export function renderBrowse() {
  _searchLookup = []; // reset lookup table for this render

  // Trash / deleted views take over the whole browse area
  if (state.showTrash || state.showDeleted) return renderTrashView();

  // Author list view
  if (state.showAuthorList) return renderAuthorList();

  const items = filteredItems();
  const q = state.search.trim();
  const deadCount = state.items.filter(i => i.enrichStatus === 'dead' && !i.isPermanentlyDeleted).length;
  const trashCount = state.items.filter(i => i.isDisliked && !i.isPermanentlyDeleted).length;
  const favCount = state.items.filter(i => i.isFavourite).length;
  const tagLists = state.lists.filter(l => l.isTag && l.type === 'smart').slice().sort((a,b) => (a.tagName||a.name).localeCompare(b.tagName||b.name));

  return `
    <!-- ── Editing list banner ──────────────────────────────────────────── -->
    ${state.editingListId ? (() => {
      const editingList = state.lists.find(l => l.id === state.editingListId);
      return editingList ? `
        <div style="background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.3);border-radius:10px;padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span style="font-size:13px;color:var(--accent2)">✏️ Editing: <strong>${escHtml(editingList.name)}</strong></span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary btn-sm" onclick="saveCurrentSearchAsList(${state.editingListId})">Save as list</button>
            <button class="btn btn-ghost btn-sm" onclick="state.editingListId=null;newSearch()" title="Stop editing">✕</button>
          </div>
        </div>` : '';
    })() : ''}

    <!-- ── Tag chip tray ─────────────────────────────────────────────────── -->
    ${tagLists.length > 0 ? (() => {
      // When editing a tag, compute which tags would cause cycles
      const blockedTagIds = state.editingListId ? (() => {
        const graph = buildTagDepGraph();
        return getTagsContaining(state.editingListId, graph);
      })() : new Set();
      const visibleTags = (state.tagTrayCollapsed ? tagLists.filter(l => state.activeTagIds.includes(+l.id)) : tagLists)
        .filter(l => l.id !== state.editingListId); // hide the tag being edited
      return `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${visibleTags.map(l => {
            const active = state.activeTagIds.includes(+l.id);
            const cached = state.tagCache.get(l.id);
            const count = cached ? cached.count : 0;
            const blocked = blockedTagIds.has(l.id);
            return `<button
              style="display:inline-flex;align-items:center;gap:5px;background:${active?'var(--accent2)':blocked?'var(--surface2)':'var(--surface)'};border:1px solid ${active?'var(--accent2)':blocked?'rgba(255,255,255,0.1)':'var(--border)'};border-radius:20px;padding:4px 12px;font-size:12px;cursor:${blocked?'default':'pointer'};color:${active?'#fff':blocked?'var(--text-muted)':'var(--text)'};font-weight:${active?'600':'400'};opacity:${blocked?'0.5':'1'}"
              onclick="${blocked ? `showToast('Adding this tag would create a circular reference','warning')` : `toggleTagChip(${l.id})`}">
              #${escHtml(l.tagName || l.name)}
              <span style="font-size:10px;opacity:0.75">${count}</span>
            </button>`;
          }).join('')}
          ${state.activeTagIds.length > 0 ? `
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted);margin-left:4px;cursor:pointer;user-select:none">
              <input type="checkbox" ${state.tagMode==='OR'?'checked':''}
                onchange="state.tagMode=this.checked?'OR':'AND';renderBrowseList();render()"
                style="width:14px;height:14px">
              OR
            </label>
            <button style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:2px 6px"
              onclick="state.activeTagIds=[];state.tagMode='AND';renderBrowseList();render()">Clear</button>
          ` : ''}
          <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:12px"
            onclick="state.tagTrayCollapsed=!state.tagTrayCollapsed;render()">
            ${state.tagTrayCollapsed ? '▸ Show tags' : '▾ Collapse tags'}
          </button>
        </div>
      </div>`;
    })() : ''}

    <!-- ── Search input + filter toggle ────────────────────────────────── -->
    <div style="display:flex;gap:8px;align-items:stretch;margin-bottom:8px">
      <div class="search-wrap" style="flex:1;min-width:0">
        <span class="search-icon">🔍</span>
        <input class="input" id="search-input"
          placeholder='Search… "phrase"  a,b,c  *wild*  r/sub  u/name  -exclude'
          value="${escHtml(state.search)}"
          oninput="handleSearchInput(this.value)"
          onfocus="state.searchFocused=true"
          onblur="setTimeout(()=>{state.searchFocused=false},300)"
          onkeydown="if(event.key==='Enter'&&state.search.trim()){commitSearch(state.search);renderBrowseList();}"
          autocapitalize="none" autocorrect="off" spellcheck="false"
          style="width:100%;padding-right:${state.search ? '36px' : '12px'}">
        <button id="search-clear-x"
          style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;line-height:1;padding:0;display:${state.search ? 'block' : 'none'}"
          onclick="applySearch('')">✕</button>
      </div>
      <button onclick="state.showFilters=!state.showFilters;render()"
        style="background:${hasActiveFilters()?'var(--accent2)':'var(--surface)'};border:1px solid ${hasActiveFilters()?'var(--accent2)':'var(--border)'};border-radius:10px;padding:0 14px;height:44px;cursor:pointer;font-size:13px;color:${hasActiveFilters()?'#fff':'var(--text-muted)'};white-space:nowrap;flex-shrink:0;align-self:stretch">
        ${hasActiveFilters() ? '⚙️ Filters ●' : '⚙️ Filters'}
      </button>
    </div>
    <div style="min-height:18px;margin-top:4px;text-align:right">
      <button id="clear-search-btn" onclick="newSearch()"
        style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--text-muted);padding:0;opacity:0.7;visibility:${(state.search || state.activeTagIds.length > 0 || hasActiveFilters() || state.sortBy !== 'postCreatedAt' || state.sortDir !== 'desc') ? 'visible' : 'hidden'}">
        ✕ Clear search &amp; filters
      </button>
    </div>

    <!-- ── Search syntax hint ──────────────────────────────────────────── -->
    <details style="margin:-2px 0 8px;font-size:11px;color:var(--text-muted)">
      <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:4px;width:fit-content">
        <span style="opacity:0.5">ℹ︎ Search tips</span>
      </summary>
      <div style="margin-top:8px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;display:grid;gap:6px;line-height:1.8">
        <div><code style="color:var(--accent2);font-size:11px">python tutorial</code> <span style="color:var(--text-muted)">— both words must appear (AND)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">react, vue, svelte</code> <span style="color:var(--text-muted)">— any of these words (OR)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">(react, vue, svelte)</code> <span style="color:var(--text-muted)">— same as above, parentheses are optional for a pure OR search</span></div>
        <div><code style="color:var(--accent2);font-size:11px">(dogs, cats) horses cows</code> <span style="color:var(--text-muted)">— must contain horses AND cows AND at least one of dogs/cats (mixed AND + OR)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">"machine learning"</code> <span style="color:var(--text-muted)">— match this exact word or phrase anywhere in the text</span></div>
        <div><code style="color:var(--accent2);font-size:11px">-javascript</code> <span style="color:var(--text-muted)">— exclude this word</span></div>
        <div><code style="color:var(--accent2);font-size:11px">run*</code> <span style="color:var(--text-muted)">— words starting with "run" (running, runner…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">*ness</code> <span style="color:var(--text-muted)">— words ending with "ness" (happiness, darkness…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">*witch*</code> <span style="color:var(--text-muted)">— words containing "witch" (switch, bewitched…)</span></div>
        <div><code style="color:var(--accent2);font-size:11px">r/programming</code> <span style="color:var(--text-muted)">— filter by subreddit</span></div>
        <div><code style="color:var(--accent2);font-size:11px">u/username</code> <span style="color:var(--text-muted)">— filter by author</span></div>
        <div style="margin-top:2px;color:var(--text-muted);font-size:11px">Bare words search titles only (enable "Search body text" in Filters to include post/comment text). Use wildcards for partial matching or quotes for exact phrases. Use r: and u: to search by subreddit or author.</div>
      </div>
    </details>

    <!-- ── Recent searches ──────────────────────────────────────────────── -->
    ${state.recentSearches.length > 0 ? `
      <div style="margin:-2px 0 8px">
        <button onclick="state.recentSearchesOpen=!state.recentSearchesOpen;render()"
          style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:5px;padding:2px 0;color:var(--text-muted);font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase">
          <span style="transition:transform 0.15s;display:inline-block;transform:rotate(${state.recentSearchesOpen?'90':'0'}deg)">▶</span>
          Recent (${state.recentSearches.length})
        </button>
        ${state.recentSearchesOpen ? `
          <div id="recent-searches-row" style="margin-top:6px">
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${state.recentSearches.map(s => { const i = _sl(s); return `
                <div style="display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:12px;cursor:pointer;max-width:200px"
                  onclick="runSavedSearch(${i});state.recentSearchesOpen=false">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escHtml(s)}</span>
                  <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0;line-height:1;flex-shrink:0"
                    title="Remove" onclick="event.stopPropagation();removeSavedSearchByIndex(${i})">✕</button>
                </div>`; }).join('')}
            </div>
          </div>` : ''}
      </div>` : ''}

    <!-- ── Filter panel (slide-down) ────────────────────────────────────── -->
    ${state.showFilters ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:4px;display:grid;gap:12px">

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">TYPE</div>
            <div style="display:flex;gap:6px">
              ${['all','post','comment'].map(t => `
                <button class="filter-pill ${state.filterType===t?'active':''}" style="flex:1;justify-content:center"
                  onclick="state.filterType='${t}';render()">${t==='all'?'All':t==='post'?'📝 Posts':'💬 Comments'}</button>
              `).join('')}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:0;width:100%">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600">MIN RATING</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="filter-pill ${state.filterRating===0?'active':''}" onclick="state.filterRating=0;render()" style="flex:1;justify-content:center;min-width:36px">Any</button>
              ${[1,2,3,4,5].map(n => `
                <button class="filter-pill ${state.filterRating===n?'active':''}" onclick="state.filterRating=${n};render()" style="flex:1;justify-content:center;min-width:36px;padding:6px 4px;font-size:11px">
                  ${'★'.repeat(n)}
                </button>`).join('')}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.filterFavourite?'checked':''} onchange="state.filterFavourite=this.checked;render()">
            ⭐ Favourites only
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.filterHasLinks?'checked':''} onchange="state.filterHasLinks=this.checked;render()">
            🔗 Has links
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${state.searchBody?'checked':''} onchange="state.searchBody=this.checked;renderBrowseList()">
            📄 Search body text
          </label>
        </div>

        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="font-size:11px;color:var(--text-muted);font-weight:600">DATE RANGE</div>
            <select class="input" style="width:auto;font-size:13px;padding:4px 8px;height:auto" onchange="state.filterDateField=this.value;render()">
              <option value="postCreatedAt" ${state.filterDateField==='postCreatedAt'?'selected':''}>Post date</option>
              <option value="savedAt" ${state.filterDateField==='savedAt'?'selected':''}>Saved date</option>
            </select>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <div style="flex:1;display:flex;flex-direction:column;gap:2px">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:0.04em">FROM</div>
              <input class="input" type="date" style="width:100%;font-size:16px;padding:8px 10px" value="${state.filterDateFrom}"
                onchange="state.filterDateFrom=this.value;render()">
            </div>
            <div style="color:var(--text-muted);font-size:14px;padding-top:16px">—</div>
            <div style="flex:1;display:flex;flex-direction:column;gap:2px">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:0.04em">TO</div>
              <input class="input" type="date" style="width:100%;font-size:16px;padding:8px 10px" value="${state.filterDateTo}"
                onchange="state.filterDateTo=this.value;render()">
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div style="flex:1;min-width:100px;position:relative">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">SUBREDDIT</div>
            <input class="input" id="filter-subreddit-input" style="font-size:16px;width:100%" placeholder="e.g. programming"
              value="${escHtml(state.filterSubreddit)}"
              oninput="handleFilterSubreddit(this.value)"
              onblur="_hideFilterSuggestions()">
            <div id="subreddit-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:2px;
              box-shadow:0 4px 12px rgba(0,0,0,0.3);overflow:hidden"></div>
          </div>
          <div style="flex:1;min-width:100px;position:relative">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;font-weight:600">AUTHOR</div>
            <input class="input" id="filter-author-input" style="font-size:16px;width:100%" placeholder="e.g. username"
              value="${escHtml(state.filterAuthor)}"
              oninput="handleFilterAuthor(this.value)"
              onblur="_hideFilterSuggestions()">
            <div id="author-suggestions" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:2px;
              box-shadow:0 4px 12px rgba(0,0,0,0.3);overflow:hidden"></div>
          </div>
        </div>

        <button class="btn btn-ghost btn-sm" onclick="clearFilters()" style="width:100%;justify-content:center;color:var(--danger)">
          ✕ Clear all filters
        </button>
      </div>
    ` : ''}

    <!-- ── savedAt clump warning ──────────────────────────────────────── -->
    ${state.sortBy === 'savedAt' && (checkSavedAtClumps(), state.savedAtClumpy) ? `
      <div style="font-size:11px;color:var(--warning);background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:8px;padding:6px 10px;margin-bottom:6px;line-height:1.5">
        ⚠ Most items share a synthetic import date — sort order may not reflect when you actually saved things.
        <button onclick="showPage('settings')" style="background:none;border:none;cursor:pointer;color:var(--accent2);font-size:11px;padding:0;white-space:nowrap">Run the patch tool →</button>
      </div>` : ''}

    <!-- ── Result count + save search + sort ───────────────────────────── -->
    <div id="search-result-info" style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;margin-bottom:4px;min-height:24px;gap:8px">
      <span style="font-size:12px;color:var(--text-muted);flex-shrink:0">
        ${items.length.toLocaleString()} ${q ? 'result' : 'item'}${items.length!==1?'s':''}
      </span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
        ${(q || state.activeTagIds.length > 0) && !state.editingListId ? `
          <button style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent2);padding:2px 4px;white-space:nowrap"
            onclick="saveCurrentSearchAsList()">
            + Save as list</button>` : ''}
        ${renderSortControl()}
      </div>
    </div>

    <!-- ── Quick filter pills ───────────────────────────────────────────── -->
    <div class="filter-row">
      ${deadCount > 0 ? `<button class="filter-pill ${state.showDead?'active':''}" onclick="setFilter('dead')" style="${state.showDead?'':'opacity:0.6'}">⚰️ ${state.showDead ? 'Unavailable ✕' : `Unavailable (${deadCount})`}</button>` : ''}
      ${state.showDead && deadCount > 0 ? `<button class="filter-pill" onclick="trashAllDead()" style="color:var(--danger);border-color:var(--danger);opacity:0.85">🗑️ Trash all (${deadCount})</button>` : ''}
      ${trashCount > 0 ? `<button class="filter-pill" onclick="state.showTrash=true;render()" style="opacity:0.7">🗑️ Trash (${trashCount})</button>` : ''}
      <button class="filter-pill" onclick="state.showAuthorList=true;render()" style="opacity:0.8">👤 Authors</button>
    </div>

    <!-- ── Results ───────────────────────────────────────────────────────── -->
    <div id="browse-list">
      ${renderBrowseItems(items)}
    </div>
  `;
}

// ─── SEARCH PARSER ───────────────────────────────────────────────────────────
// Syntax:
//   bare words          → AND logic, whole-word match
//   a, b, c             → OR group (commas at top level = OR), whole-word each
//   (a, b, c)           → OR group (explicit parens), whole-word each
//   "quoted phrase"     → exact substring match (no word boundary)
//   *word               → suffix wildcard — matches anything ending in "word"
//   word*               → prefix wildcard — matches anything starting with "word"
//   *word*              → full wildcard — substring match (same as old default)
//   -word / -"phrase"   → exclusion
//   r:subreddit         → subreddit field (partial)
//   u:username          → author field (partial)
//   type:post/comment   → type filter
//   [#tag name]         → tag token — resolves to the named tag's smart list query at match time

// ─── TAG TOKEN HELPERS ───────────────────────────────────────────────────────

// Validate a tag name — only alphanum, spaces, &, / allowed
export let _searchLookup = [];
export function _sl(s) {
  const i = _searchLookup.length;
  _searchLookup.push(s);
  return i;
}
export let _searchDebounceTimer = null;
export let _filterSubredditTimer = null;
export let _filterAuthorTimer = null;

export function handleSearchInput(value) {
  state.search = value;
  // Do NOT call render() here — that destroys the input and dismisses the keyboard.
  // Manually update the inline ✕ inside the search wrap
  const inlineClear = document.getElementById('search-clear-x');
  if (inlineClear) inlineClear.style.display = value ? 'block' : 'none';
  // Update the persistent clear button visibility
  const clearBtn = document.getElementById('clear-search-btn');
  if (clearBtn) {
    const hasState = value || state.activeTagIds.length > 0 || hasActiveFilters() ||
      state.sortBy !== 'postCreatedAt' || state.sortDir !== 'desc';
    clearBtn.style.visibility = hasState ? 'visible' : 'hidden';
  }

  // Count and save button are updated by renderBrowseList() when debounce fires.
  // Don't call filteredItems() here — it causes stale/misleading counts mid-typing.

  if (!value.trim()) {
    renderBrowseList();
    return;
  }

  const lastChar = value[value.length - 1];
  const words = value.trim().split(/\s+/);
  const currentWord = words[words.length - 1];
  const bareWord = currentWord.replace(/^[-"r\/u\:\/]*/,'').replace(/"/g,'');

  // Trigger if: space typed, bare word ≥4 chars, or current word is a complete field token (r/x or u/x with ≥1 char after slash)
  const isCompleteFieldToken = /^[rRuU][:/]\S+$/.test(currentWord);
  const shouldTrigger = lastChar === ' ' || bareWord.length >= 3 || isCompleteFieldToken;

  clearTimeout(_searchDebounceTimer);
  if (shouldTrigger) {
    _searchDebounceTimer = setTimeout(() => renderBrowseList(), 120);
  }
}

export function handleFilterSubreddit(value) {
  state.filterSubreddit = value;
  _showFilterSuggestions('subreddit-suggestions', value, state.subredditList);
  clearTimeout(_filterSubredditTimer);
  _filterSubredditTimer = setTimeout(() => renderBrowseList(), 200);
}

export function handleFilterAuthor(value) {
  state.filterAuthor = value;
  _showFilterSuggestions('author-suggestions', value, state.authorList);
  clearTimeout(_filterAuthorTimer);
  _filterAuthorTimer = setTimeout(() => renderBrowseList(), 200);
}

export function _showFilterSuggestions(elId, value, list) {
  const el = document.getElementById(elId);
  if (!el) return;
  const q = value.trim().toLowerCase();
  if (!q) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const matches = list.filter(s => s.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q)) {
    el.innerHTML = ''; el.style.display = 'none'; return;
  }
  const field = elId === 'subreddit-suggestions' ? 'filterSubreddit' : 'filterAuthor';
  const inputId = elId === 'subreddit-suggestions' ? 'filter-subreddit-input' : 'filter-author-input';
  el.style.display = 'block';
  el.innerHTML = matches.map(m => `
    <div class="filter-suggestion-item" onmousedown="
      state.${field}='${m.replace(/'/g,"\\'")}';
      document.getElementById('${inputId}').value='${m.replace(/'/g,"\\'")}';
      document.getElementById('${elId}').style.display='none';
      renderBrowseList()">
      ${escHtml(m)}
    </div>`).join('');
}

export function _hideFilterSuggestions() {
  ['subreddit-suggestions','author-suggestions'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  });
}

export function renderRecentSearches() {
  const el = document.getElementById('recent-searches-row');
  if (!el) return;
  const recents = state.recentSearches;
  const show = state.searchFocused && !state.search.trim() && recents.length > 0;
  if (!show) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:6px">RECENT</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${recents.map(s => { const i = _sl(s); return `
        <div style="display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:12px;cursor:pointer;max-width:200px"
          onmousedown="event.preventDefault();runSavedSearch(${i})">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escHtml(s)}</span>
          <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0;line-height:1;flex-shrink:0"
            title="Remove"
            onmousedown="event.preventDefault();event.stopPropagation();removeSavedSearchByIndex(${i})">✕</button>
        </div>`; }).join('')}
    </div>`;
}

// Precomputed item→list-count map, rebuilt before each browse render
export let _listCountMap = new Map();
export function _rebuildListCountMap() {
  _listCountMap = new Map();
  for (const il of state.itemLists) {
    _listCountMap.set(il.itemId, (_listCountMap.get(il.itemId) || 0) + 1);
  }
}

export function renderBrowseItems(items) {
  if (items.length === 0) {
    return `<div class="empty"><div class="empty-icon">🔍</div><h3>No results</h3><p>Try adjusting your search or filters.</p></div>`;
  }
  _rebuildListCountMap();
  return items.map(item => renderItemCard(item, true)).join('');
}

export function renderBrowseList() {
  const el = document.getElementById('browse-list');
  if (!el) { render(); return; }
  const items = filteredItems();
  el.innerHTML = renderBrowseItems(items);
  // Update result count + save button in-place
  const countEl = document.getElementById('search-result-info');
  if (countEl) {
    const q = state.search.trim();
    const hasActivity = q || state.activeTagIds.length > 0;
    countEl.innerHTML = `
      <span style="font-size:12px;color:var(--text-muted);flex-shrink:0">
        ${items.length.toLocaleString()} ${q ? 'result' : 'item'}${items.length!==1?'s':''}
      </span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
      ${(q || state.activeTagIds.length > 0) && !state.editingListId ? `<button class="save-as-list-btn" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent2);padding:2px 4px;white-space:nowrap"
          onclick="saveCurrentSearchAsList()">
          + Save as list
        </button>` : ''}
        ${renderSortControl()}
      </div>`;
  }
}

