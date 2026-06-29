// render/shell.js — view rendering (split out of the former render.js).
import { handleFileImport } from '../dataio.js';
import { setSort, showPage } from '../items.js';
import { APP_VERSION, renderSyncLogEntries, state, syncLog } from '../state.js';
import { escHtml } from '../util.js';
import { renderBrowse, renderBrowseList } from './browse.js';
import { renderHome, renderRecent } from './home.js';
import { renderLists } from './lists.js';
import { renderSettings } from './settings.js';

export function render() {
  try {
    const content = document.getElementById('main-content');
    renderHeaderActions();
    switch(state.page) {
      case 'home':     content.innerHTML = renderHome(); break;
      case 'browse':   content.innerHTML = renderBrowse(); break;
      case 'recent':   content.innerHTML = renderRecent(); break;
      case 'lists':    content.innerHTML = renderLists(); break;
      case 'settings': content.innerHTML = renderSettings(); break;
    }
    attachEventListeners();
  } catch(err) {
    console.error('render() error:', err);
    _renderErrorFallback(err);
  }
}

export function _renderErrorFallback(err) {
  try {
    const content = document.getElementById('main-content');
    if (content) content.innerHTML = `
      <div style="padding:32px 20px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:18px;margin-bottom:8px">Something went wrong</div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Page: <strong>${escHtml(state.page)}</strong></div>
        <div style="font-size:12px;color:var(--danger);background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);
          border-radius:8px;padding:10px 14px;margin:12px 0 20px;text-align:left;font-family:monospace;word-break:break-all">
          ${escHtml(err?.message || String(err))}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:280px;margin:0 auto">
          <button class="btn btn-secondary" onclick="showPage('home')">🏠 Go to Home</button>
          <button class="btn btn-ghost" onclick="window.location.reload()">↺ Reload app</button>
        </div>
      </div>`;
  } catch(e) {
    // If even the fallback fails, reload is the last resort
    console.error('_renderErrorFallback failed:', e);
    window.location.reload();
  }
}

export function renderHeaderActions() {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

  const el = document.getElementById('header-actions');
  if (!state.supabaseUrl || !state.supabaseKey) {
    el.innerHTML = '';
    return;
  }

  if (state.syncStatus === 'syncing') {
    el.innerHTML = `
      <span style="font-size:11px;color:var(--warning);display:flex;align-items:center;gap:5px">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--warning);display:inline-block;animation:pulse 1s infinite"></span>
        Syncing
      </span>`;
    return;
  }

  let dot, label, title, logMsg;
  if (state.localDirty) {
    dot = '#f59e0b';
    label = 'Unsynced';
    title = 'Local changes not yet pushed to cloud';
    logMsg = 'warn:Indicator → Unsynced (localDirty)';
  } else if (state.cloudAhead) {
    dot = '#3b82f6';
    label = 'Pulling…';
    title = 'Cloud has newer data — pulling';
    logMsg = 'warn:Indicator → Pulling (cloudAhead)';
  } else if (state.syncStatus === 'disconnected') {
    dot = '#ef4444';
    label = 'Disconnected';
    title = 'Cloud connection issue — check Settings';
    logMsg = 'error:Indicator → Disconnected';
  } else {
    dot = '#22c55e';
    label = 'In sync';
    title = `Fully synced · last sync ${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : 'unknown'}`;
    logMsg = 'ok:Indicator → In sync';
  }
  // Only log when the indicator label actually changes
  if (logMsg && label !== state._lastIndicatorLabel) {
    state._lastIndicatorLabel = label;
    const [level, msg] = logMsg.split(':');
    syncLog(msg, level);
  }

  el.innerHTML = `
    <span style="font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:5px;cursor:pointer"
      title="${title}" onclick="showPage('settings')">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};display:inline-block"></span>
      ${label}
    </span>`;
}

export function renderSortControl(onChangeFn = 'setSort') {
  const opts = [
    { key: 'affinity',     label: '✦ Affinity' },
    { key: 'savedAt',      label: 'Date saved' },
    { key: 'postCreatedAt',label: 'Date posted' },
    { key: 'score',        label: 'Score' },
    { key: 'rating',       label: 'Rating' },
    { key: 'subreddit',    label: 'Subreddit' },
    { key: 'title',        label: 'Title' },
  ];
  const arrow = state.sortDir === 'desc' ? '↓' : '↑';
  const optHtml = opts.map(o =>
    `<option value="${o.key}" ${o.key === state.sortBy ? 'selected' : ''}>${o.label}</option>`
  ).join('');
  return `<div id="sort-control" style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
    <span>Sort:</span>
    <select style="background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:2px 6px;cursor:pointer"
      onchange="${onChangeFn}(this.value)">
      ${optHtml}
    </select>
    <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:0 2px"
      onclick="state.sortDir=state.sortDir==='desc'?'asc':'desc';${onChangeFn==='setSort'?'renderBrowseList()':'render()'}"
      title="Toggle direction">${arrow}</button>
  </div>`;
}

export function showModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><div class="modal-handle"></div>${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);

}

export function closeModal() {
  document.getElementById('modal-overlay')?.remove();
}

// Rating picker — big, well-spaced tap targets (replaces the cramped inline 5-star
// row). Three-state model: 👎 = 0 (kept, marked bad), ★1–5 = stars, "No rating" = null.
// Buttons resolve setRating/closeModal via the window bridge (app.js).
export function showRatingMenu(itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  const current = item.rating;
  const starBtn = n => `
    <button class="rating-pick-btn" onclick="setRating(${itemId},${n});closeModal()"
      title="${n} star${n !== 1 ? 's' : ''}"
      style="color:${(current != null && current >= n) ? '#f59e0b' : 'var(--border)'}">★</button>`;
  showModal(`
    <div class="modal-title">Rate</div>
    <div class="rating-pick-row">
      <button class="rating-pick-btn ${current === 0 ? 'rating-pick-active' : ''}"
        onclick="setRating(${itemId},0);closeModal()" title="Thumbs down (kept, marked bad)"
        style="font-size:24px">👎</button>
      <span class="rating-pick-divider"></span>
      ${[1, 2, 3, 4, 5].map(starBtn).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-ghost" onclick="closeModal()" style="flex:1;justify-content:center">Close</button>
      ${current != null ? `<button class="btn btn-ghost" onclick="setRating(${itemId},null);closeModal()"
        style="flex:1;justify-content:center;color:var(--text-muted)">Clear rating</button>` : ''}
    </div>
  `);
}

// ─── LIST MANAGEMENT ─────────────────────────────────────────────────────────

export function attachEventListeners() {
  // Populate sync log if visible
  const logEl = document.getElementById('sync-log-entries');
  if (logEl) renderSyncLogEntries(logEl);

  // Swipe right from left edge to go back when viewing a list detail
  if (state.page === 'lists' && state.listView !== 'all') {
    const content = document.getElementById('main-content');
    if (content && !content._swipeBackAttached) {
      content._swipeBackAttached = true;
      let startX = 0, startY = 0, mode = null, tracking = false;

      content.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        mode = null;
        tracking = startX < 40; // only arm from left edge
      }, { passive: true });

      content.addEventListener('touchmove', e => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (mode === null) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          mode = (dx > 0 && Math.abs(dx) > Math.abs(dy)) ? 'right' : 'none';
        }
        if (mode === 'right') {
          if (state.listView === 'all') { mode = 'none'; return; } // not in detail view
          e.preventDefault();
          content.style.transform = `translateX(${Math.max(0, dx)}px)`;
          content.style.transition = 'none';
        }
      }, { passive: false });

      content.addEventListener('touchend', e => {
        if (!tracking || mode !== 'right') { content.style.transform = ''; return; }
        // Guard — listener persists on the element across renders, only act in detail view
        if (state.listView === 'all') {
          content.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = '';
          tracking = false; mode = null;
          return;
        }
        const dx = e.changedTouches[0].clientX - startX;
        if (dx > 80) {
          content.style.transition = 'transform 0.25s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = `translateX(${window.innerWidth}px)`;
          setTimeout(() => {
            content.style.transform = '';
            content.style.transition = '';
            state.listView = 'all';
            render();
          }, 220);
        } else {
          content.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
          content.style.transform = '';
        }
        tracking = false; mode = null;
      }, { passive: true });
    }
  }

  const restoreInput = document.getElementById('restore-file');
  if (restoreInput) {
    restoreInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleFileImport(file);
      restoreInput.value = ''; // reset so same file can be picked again
    };
  }

  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = async e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) await handleFileImport(file);
    };
  }
}


