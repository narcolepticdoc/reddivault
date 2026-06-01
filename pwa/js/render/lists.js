// render/lists.js — view rendering (split out of the former render.js).
import { deleteList, doCreateList, doEditList, runListSearch, setSortList, showPage, toggleItemList } from '../items.js';
import { extractTagTokens, itemMatchesTokens, optionsSummaryParts, parseSearchQuery, sortItems } from '../search.js';
import { state } from '../state.js';
import { escHtml } from '../util.js';
import { _rebuildListCountMap } from './browse.js';
import { renderItemCard } from './card.js';
import { closeModal, render, renderSortControl, showModal } from './shell.js';

export function renderLists() {
  const allLists = state.lists;
  const separated = state.listSeparate;

  const renderListCard = (list) => {
    const isSmart = list.type === 'smart';
    const count = isSmart
      ? (state.tagCache.get(list.id)?.count ?? 0)
      : state.itemLists.filter(il => il.listId === list.id).length;
    return `
      <div class="card" style="cursor:pointer" onclick="state.listView=${list.id};render()">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px">${escHtml(list.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
              ${isSmart ? `<span style="color:var(--accent2)">✦ Smart</span> · ` : ''}${count} item${count!==1?'s':''}
              ${list.isTag ? `<span style="margin-left:6px;background:var(--accent2);color:#fff;border-radius:10px;padding:1px 7px;font-size:10px;font-weight:600;white-space:nowrap;display:inline-block">#${escHtml(list.tagName || list.name)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editList(${list.id})" title="Edit">✏️</button>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();if(confirm('Delete list?'))deleteList(${list.id})" title="Delete" style="color:var(--danger)">🗑️</button>
          </div>
        </div>
        ${isSmart && list.query ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;font-style:italic">${escHtml(list.query)}</div>` : ''}
        ${isSmart && list.optionsJson ? (() => {
          const parts = optionsSummaryParts(list.optionsJson);
          if (!parts.length) return '';
          return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${parts.map(p => `<span style="font-size:10px;background:rgba(124,58,237,0.12);color:var(--accent2);border-radius:6px;padding:2px 6px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div>`;
        })() : ''}
      </div>`;
  };

  // List detail view
  if (state.listView !== 'all') {
    const list = state.lists.find(l => l.id === state.listView);
    if (!list) { state.listView = 'all'; return renderLists(); }
    const isSmart = list.type === 'smart';
    const tokens = isSmart ? parseSearchQuery(list.query || '') : [];

    const pinnedIds = new Set(state.itemLists.filter(il => il.listId === list.id).map(il => il.itemId));

    let smartItems = [];
    let extraPinnedItems = [];

    if (isSmart) {
      const cached = state.tagCache.get(list.id);
      const allMatching = cached
        ? state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead' && cached.itemIds.has(i.id))
        : state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead' && (tokens.length === 0 || itemMatchesTokens(i, tokens)));
      const matchingIds = new Set(allMatching.map(i => i.id));
      extraPinnedItems = sortItems(state.items.filter(i => pinnedIds.has(i.id) && !matchingIds.has(i.id) && !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead'));
      smartItems = sortItems(allMatching);
    }

    const staticItems = isSmart ? [] : sortItems(state.items.filter(i => pinnedIds.has(i.id) && !i.isDisliked && !i.isPermanentlyDeleted && i.enrichStatus !== 'dead'));

    _rebuildListCountMap();
    const renderListCard = (i) => renderItemCard(i, true, list.id);
    const itemCount = (isSmart ? smartItems : staticItems).length + extraPinnedItems.length;

    return `
      <div class="section-header">
        <button class="btn btn-ghost btn-sm" onclick="state.listView='all';render()">← Lists</button>
        <div class="section-title" style="flex:1;text-align:center">${escHtml(list.name)}</div>
        <button class="btn btn-ghost btn-sm" onclick="editList(${list.id})">✏️</button>
      </div>
      ${isSmart ? (() => {
        const parts = list.optionsJson ? optionsSummaryParts(list.optionsJson) : [];
        const queryLine = list.query ? `<div>✦ Smart: <em>${escHtml(list.query)}</em></div>` : '';
        const optsLine = parts.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${parts.map(p => `<span style="font-size:10px;background:rgba(124,58,237,0.2);color:var(--accent2);border-radius:6px;padding:2px 6px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div><div style="font-size:10px;color:var(--text-muted);margin-top:5px">Filters &amp; sort apply here only — not when used as a #tag.</div>` : '';
        if (!queryLine && !optsLine) return '';
        return `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;padding:8px 12px;background:rgba(168,85,247,0.08);border-radius:8px">${queryLine}${optsLine}</div>`;
      })() : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;min-height:24px">
        <span style="font-size:12px;color:var(--text-muted)">${itemCount.toLocaleString()} item${itemCount!==1?'s':''}</span>
        ${renderSortControl('setSortList')}
      </div>

      ${extraPinnedItems.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">📌 PINNED</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
          ${extraPinnedItems.map(renderListCard).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">✦ MATCHING</div>
      ` : ''}

      <div style="display:flex;flex-direction:column;gap:8px">
        ${(isSmart ? smartItems : staticItems).length === 0
          ? `<div class="empty"><div class="empty-icon">📋</div><h3>No items</h3><p>${isSmart ? 'No items match this search.' : 'Add items from the Browse tab using the 📋 button.'}</p></div>`
          : (isSmart ? smartItems : staticItems).map(renderListCard).join('')}
      </div>
    `;
  }

  // Sort and optionally separate
  const sorted = [...allLists].sort((a,b) => a.name.replace(/^[^a-zA-Z0-9]+/,'').localeCompare(b.name.replace(/^[^a-zA-Z0-9]+/,'')));
  const smarts = sorted.filter(l => l.type === 'smart');
  const statics = sorted.filter(l => l.type === 'static');
  const tagLists = smarts.filter(l => l.isTag).slice().sort((a,b) => (a.tagName||a.name).localeCompare(b.tagName||b.name));
  const nonTagSmarts = smarts.filter(l => !l.isTag);
  const firstGroup  = state.listSmartFirst ? smarts  : statics;
  const secondGroup = state.listSmartFirst ? statics : smarts;
  const firstLabel  = state.listSmartFirst ? '✦ SMART LISTS'  : '📋 STATIC LISTS';
  const secondLabel = state.listSmartFirst ? '📋 STATIC LISTS' : '✦ SMART LISTS';

  const renderSmartGroup = () => {
    if (smarts.length === 0) return '';
    const hasTagSub = tagLists.length > 0 && nonTagSmarts.length > 0;
    const allAreTags = tagLists.length > 0 && nonTagSmarts.length === 0;
    if (!hasTagSub) {
      // all smart lists are tags, or none are — flat list, no subsection
      return `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${smarts.map(renderListCard).join('')}</div>`;
    }
    return `
      <div style="margin-bottom:8px;padding:10px 12px;background:rgba(244,114,182,0.04);border:1px solid rgba(244,114,182,0.18);border-radius:10px;">
        <div onclick="state.tagsCollapsed=!state.tagsCollapsed;render()"
          style="font-size:11px;color:var(--accent3);font-weight:600;letter-spacing:0.05em;display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:2px 0;margin-bottom:${state.tagsCollapsed?'0':'8px'}">
          <span>🏷 TAGS</span>
          <span style="font-size:10px;transition:transform 0.2s;display:inline-block;transform:rotate(${state.tagsCollapsed?'-90deg':'0deg'})">▼</span>
        </div>
        ${state.tagsCollapsed ? '' : `<div style="display:flex;flex-direction:column;gap:8px">${tagLists.map(renderListCard).join('')}</div>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${nonTagSmarts.map(renderListCard).join('')}</div>
    `;
  };

  const renderSeparated = () => {
    const firstIsSmarts = state.listSmartFirst;
    const firstContent  = firstIsSmarts ? renderSmartGroup() : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${statics.map(renderListCard).join('')}</div>`;
    const secondContent = firstIsSmarts ? `<div style="display:flex;flex-direction:column;gap:8px">${statics.map(renderListCard).join('')}</div>` : renderSmartGroup();
    return `
      ${firstGroup.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${firstLabel}</div>
        ${firstContent}
      ` : ''}
      ${secondGroup.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;margin-bottom:8px">${secondLabel}</div>
        ${secondContent}
      ` : ''}
    `;
  };

  return `
    <div class="section-header">
      <div class="section-title">Lists</div>
      <div style="display:flex;align-items:center;gap:6px;flex:1;margin-left:8px">
        ${allLists.length > 1 ? `
          <button class="btn btn-ghost btn-sm" onclick="state.listSeparate=!state.listSeparate;render()"
            style="${state.listSeparate?'color:var(--accent2)':''}">
            ${state.listSeparate ? '⊟ Separated' : '⊞ Merged'}
          </button>` : ''}
        ${state.listSeparate ? `
          <button class="btn btn-ghost btn-sm" onclick="state.listSmartFirst=!state.listSmartFirst;render()"
            title="Toggle which list type appears first">
            ${state.listSmartFirst ? '✦ Smart ↑' : '📋 Static ↑'}
          </button>` : ''}
      </div>
      <button class="btn btn-primary btn-sm" onclick="showNewListMenu(this)">+ New</button>
    </div>

    ${allLists.length === 0 ? `
      <div class="empty">
        <div class="empty-icon">📋</div>
        <h3>No lists yet</h3>
        <p>Create a <strong>Static list</strong> to manually collect posts, or a <strong>Smart list</strong> that auto-populates from a saved search. Smart lists can also be pinned as <strong>tag chips</strong> in the search bar for quick filtering.</p>
      </div>
    ` : separated ? renderSeparated() : `
      <div style="display:flex;flex-direction:column;gap:8px">${sorted.map(renderListCard).join('')}</div>
    `}
  `;
}

export function showNewListMenu(btn) {
  document.getElementById('new-list-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'new-list-menu';
  menu.style.cssText = 'position:fixed;z-index:300;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.25);min-width:140px;overflow:hidden;';
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.innerHTML = `
    <button onclick="document.getElementById('new-list-menu')?.remove();showCreateList('static')"
      style="display:block;width:100%;padding:12px 16px;background:none;border:none;text-align:left;color:var(--text);font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">
      📋 Static list
    </button>
    <div style="height:1px;background:var(--border)"></div>
    <button onclick="document.getElementById('new-list-menu')?.remove();showCreateList('smart')"
      style="display:block;width:100%;padding:12px 16px;background:none;border:none;text-align:left;color:var(--text);font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;">
      ✦ Smart list
    </button>
  `;
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', handler); }
    });
  }, 0);
}
export function showCreateList(type) {
  const isSmart = type === 'smart';
  showModal(`
    <div class="modal-title">${isSmart ? '✦ New Smart List' : '📋 New Static List'}</div>
    <div class="form-group">
      <label>Name</label>
      <input class="input" id="list-name" placeholder="e.g. Must Reads, AI Papers..." autofocus>
    </div>
    ${isSmart ? `
      <div class="form-group">
        <label>Search query</label>
        <input class="input" id="list-query" placeholder='e.g. r:MachineLearning (pytorch, tensorflow)'>
        <span style="font-size:11px;color:var(--text-muted)">Uses the same syntax as the search bar</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="list-is-tag" ${existingListId && state.lists.find(l=>l.id===existingListId)?.isTag ? 'checked' : ''} style="width:16px;height:16px">
          <span style="font-size:13px;font-weight:600">Show as tag chip</span>
        </label>
        <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:8px">Pins this smart list to the tag tray above search results for one-tap filtering. Also groups it under 🏷 Tags in the Lists tab.</span>
        <div class="form-group" style="margin:0">
          <label style="font-size:11px">Short tag name (optional)</label>
          <input class="input" id="list-tag-name" value="${escHtml(existingListId && state.lists.find(l=>l.id===existingListId)?.tagName || '')}" placeholder="e.g. js, audio, fav" style="font-size:13px">
          <span style="font-size:11px;color:var(--text-muted)">Shown as #name in the tag tray. Uses list name if blank.</span>
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
      <button class="btn btn-primary" onclick="doCreateList('${type}')" style="flex:1;justify-content:center">Create</button>
    </div>
  `);
}

export function editList(id) {
  const list = state.lists.find(l => l.id === id);
  if (!list) return;
  showModal(`
    <div class="modal-title">Edit List</div>
    <div class="form-group">
      <label>Name</label>
      <input class="input" id="edit-list-name" value="${escHtml(list.name)}">
    </div>
    ${list.type === 'smart' ? `
      <div class="form-group">
        <label>Search query</label>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;color:var(--text);font-style:${list.query?'normal':'italic'};min-height:36px;word-break:break-word">
          ${list.query ? escHtml(list.query) : '<span style="color:var(--text-muted)">No query set</span>'}
        </div>
        ${(() => {
          const { tags } = extractTagTokens(list.query || '');
          const missing = tags.filter(n => !state.lists.find(l => l.isTag && l.type === 'smart' && (l.tagName || l.name) === n));
          return missing.length ? `<span style="font-size:11px;color:var(--warning)">⚠ Tag${missing.length>1?'s':''} not found: ${missing.map(n=>`#${escHtml(n)}`).join(', ')} — being ignored</span>` : '';
        })()}
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%;justify-content:center"
          onclick="closeModal();runListSearch(${id})">✏️ Edit in search</button>
      </div>
      ${(() => {
        const parts = optionsSummaryParts(list.optionsJson);
        if (!parts.length) return '';
        return `<div style="background:var(--surface);border:1px solid rgba(124,58,237,0.25);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:4px">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${parts.map(p => `<span style="font-size:11px;background:rgba(124,58,237,0.12);color:var(--accent2);border-radius:6px;padding:2px 7px;white-space:nowrap">${escHtml(p)}</span>`).join('')}</div>
          <strong style="color:var(--text)">📌 Saved filters &amp; sort</strong> — applied when opening this list directly.<br>
          When used as a <strong>#tag</strong> in another search, only the query above is matched — filters and sort are ignored so compound searches stay predictable.
        </div>`;
      })()}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:4px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px">
          <input type="checkbox" id="edit-list-is-tag" ${list.isTag ? 'checked' : ''} style="width:16px;height:16px">
          <span style="font-size:13px;font-weight:600">Show as tag chip</span>
        </label>
        <span style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:8px">Pins this smart list to the tag tray above search results for one-tap filtering. Also groups it under 🏷 Tags in the Lists tab.</span>
        <div class="form-group" style="margin:0">
          <label style="font-size:11px">Short tag name (optional)</label>
          <input class="input" id="edit-list-tag-name" value="${escHtml(list.tagName || '')}" placeholder="e.g. js, audio, fav" style="font-size:13px">
          <span style="font-size:11px;color:var(--text-muted)">Shown as #name in the tag tray. Uses list name if blank.</span>
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
      <button class="btn btn-primary" onclick="doEditList(${id})" style="flex:1;justify-content:center">Save</button>
    </div>
  `);
}

export function showListMenu(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  if (state.lists.length === 0) {
    showModal(`
      <div class="modal-title">Add to List</div>
      <p style="color:var(--text-muted);font-size:13px">No static lists yet. Create one in the Lists tab first.</p>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" onclick="closeModal()" style="flex:1;justify-content:center">Cancel</button>
        <button class="btn btn-primary" onclick="closeModal();showPage('lists')" style="flex:1;justify-content:center">Go to Lists</button>
      </div>
    `);
    return;
  }

  const inListIds = new Set(state.itemLists.filter(il => il.itemId === itemId).map(il => il.listId));
  const sorted = [...state.lists].filter(l => l.type === 'static').sort((a,b) => a.name.replace(/^[^a-zA-Z0-9]+/,'').localeCompare(b.name.replace(/^[^a-zA-Z0-9]+/,'')));

  showModal(`
    <div class="modal-title">Add to List</div>
    <input class="input" id="list-search" placeholder="Search lists…" oninput="filterListMenu(this.value)"
      style="margin-bottom:10px;font-size:13px">
    <div id="list-menu-items" style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto">
      ${sorted.map(l => `
        <button id="lmbtn-${l.id}" class="btn ${inListIds.has(l.id)?'btn-primary':'btn-secondary'}"
          onclick="toggleItemList(${itemId},${l.id})"
          style="justify-content:space-between;text-align:left">
          <span>
            ${l.type==='smart'?'<span style="color:var(--accent2);font-size:10px">✦</span> ':''}${escHtml(l.name)}
          </span>
          <span>${inListIds.has(l.id) ? '✓' : '+'}</span>
        </button>
      `).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-ghost" onclick="closeModal()" style="flex:1;justify-content:center">Done</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal();showPage('lists')" style="flex:1;justify-content:center">Manage Lists →</button>
    </div>
  `);
}

export function filterListMenu(q) {
  const term = q.toLowerCase();
  document.querySelectorAll('#list-menu-items button').forEach(btn => {
    btn.style.display = btn.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
}

