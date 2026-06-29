// render/preview.js — view rendering (split out of the former render.js).
import { applySearch, trackRecentlyViewed } from '../items.js';
import { db, state } from '../state.js';
import { escHtml, fmtDate, fullUrl, ratingDisplay, renderMarkdown, stripUrlPunct } from '../util.js';

// Builds the preview header meta (badges, author/date/score, rating). Factored out so
// refreshOpenPreviewMeta() can re-render just this block in place after a rating/favourite
// change without rebuilding (and flickering) the whole sheet.
function buildPreviewMeta(item) {
  const rd = ratingDisplay(item);
  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
      ${item.subreddit ? `<span class="subreddit-tag" style="cursor:pointer" onclick="closePreview();applySearch('r/${escHtml(item.subreddit)}')">r/${escHtml(item.subreddit)}</span>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="showRatingMenu(${item.id})" title="Rate"
        style="${rd ? '' : 'color:var(--text-muted)'}">${rd || '☆ Rate'}</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleFavourite(${item.id})"
        title="${item.isFavourite?'Remove from favourites':'Add to favourites'}"
        style="color:${item.isFavourite?'#ec4899':'var(--text-muted)'}">${item.isFavourite ? '♥' : '♡'}</button>
    </div>
    <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted);flex-wrap:wrap">
      ${item.author ? `<span>u/${escHtml(item.author)}</span>` : ''}
      ${item.postCreatedAt ? `<span>📅 ${fmtDate(item.postCreatedAt)}</span>` : ''}
      ${item.score != null ? `<span>⬆ ${item.score.toLocaleString()}</span>` : ''}
    </div>`;
}

// Re-render the open preview's meta block (if a preview is showing) so rating/favourite
// edits made via the picker reflect immediately. Reads the fresh item from state.items.
export function refreshOpenPreviewMeta() {
  const metaEl = document.getElementById('preview-meta');
  if (!metaEl) return;
  const id = Number(metaEl.dataset.itemId);
  const item = state.items.find(i => i.id === id);
  if (item) metaEl.innerHTML = buildPreviewMeta(item);
}

export async function showPreview(itemId) {
  const item = await db.items.get(itemId);
  if (!item) return;
  trackRecentlyViewed(item.id);

  document.getElementById('preview-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.id = 'preview-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closePreview(); });

  const permalinkUrl = fullUrl(item.permalink || item.url || '');
  const hasBody = !!(item.body && item.body.trim());

  // Collect all external links for the "Open link" button/picker
  const externalLinks = [];
  // 1. Post-level URL (link posts)
  if (item.url && !item.url.includes('reddit.com')) {
    externalLinks.push({ label: item.url.length > 60 ? item.url.slice(0, 57) + '…' : item.url, url: fullUrl(item.url) });
  }
  // 2. Links from body text
  if (item.body) {
    // Named markdown links [text](url)
    const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
    for (const m of mdLinks) {
      const url = fullUrl(m[2]);
      if (!externalLinks.find(l => l.url === url)) {
        externalLinks.push({ label: m[1].slice(0, 60), url });
      }
    }
    // Bare URLs
    const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
    for (const m of bareLinks) {
      const url = fullUrl(stripUrlPunct(m[1]));
      if (!externalLinks.find(l => l.url === url)) {
        externalLinks.push({ label: url.length > 60 ? url.slice(0, 57) + '…' : url, url });
      }
    }
  }

  const bodyHtml = hasBody
    ? renderMarkdown(item.body)
    : externalLinks.length
      ? `<div style="text-align:center;padding:40px 20px">
           <div style="font-size:48px;margin-bottom:16px">🔗</div>
           <div style="font-size:14px;color:var(--text-muted);word-break:break-all">${escHtml(externalLinks[0].url)}</div>
         </div>`
      : `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
           <div style="font-size:48px;margin-bottom:12px">📄</div>
           No local content — open on Reddit to read.
         </div>`;

  // Open link button: single link opens directly, multiple shows picker
  let openLinkBtn = '';
  if (externalLinks.length === 1) {
    openLinkBtn = `<a class="btn btn-primary" style="flex:1;justify-content:center;text-decoration:none"
      href="${escHtml(externalLinks[0].url)}" target="_blank" rel="noopener">🔗 Open link ↗</a>`;
  } else if (externalLinks.length > 1) {
    openLinkBtn = `<button class="btn btn-primary" style="flex:1;justify-content:center"
      onclick="showLinkPicker(${item.id})">🔗 Open link (${externalLinks.length}) ↗</button>`;
  }

  overlay.innerHTML = `
    <div class="preview-sheet" id="preview-sheet">
      <div class="preview-drag-handle"></div>
      <div class="preview-header">
        <div style="flex:1;min-width:0" id="preview-meta" data-item-id="${item.id}">
          ${buildPreviewMeta(item)}
        </div>
        <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:22px;padding:0;line-height:1;flex-shrink:0;align-self:flex-start"
          onclick="closePreview()">✕</button>
      </div>
      <div class="preview-body">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:19px;line-height:1.3;margin-bottom:16px;color:var(--text)">
          ${escHtml(item.title || 'Untitled')}
        </div>
        ${bodyHtml}
      </div>
      <div class="preview-footer">
        ${openLinkBtn}
        <a class="btn ${openLinkBtn ? 'btn-ghost' : 'btn-primary'}" style="flex:1;justify-content:center;text-decoration:none"
          href="${escHtml(permalinkUrl)}" target="_blank" rel="noopener">📖 Open on Reddit ↗</a>
        <button class="btn btn-ghost" onclick="closePreview()">Close</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Swipe-to-dismiss gestures: swipe down from header/handle, or swipe right from left edge
  const sheet = overlay.querySelector('#preview-sheet');
  const header = sheet.querySelector('.preview-header');
  const handle = sheet.querySelector('.preview-drag-handle');
  let touchStartY = 0, touchStartX = 0, gestureMode = null, dismissed = false;
  // gestureMode: null (undecided) | 'down' | 'right' | 'none'

  function dismissSheet(direction) {
    if (dismissed) return;
    dismissed = true;
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    sheet.style.transform = direction === 'right' ? 'translateX(110%)' : 'translateY(110%)';
    overlay.style.transition = 'opacity 0.25s ease';
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 280);
  }

  function snapBack() {
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    sheet.style.transform = '';
    overlay.style.background = '';
  }

  function onTouchStart(e) {
    if (dismissed) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    gestureMode = null;
    sheet.style.transition = 'none';
  }

  function onTouchMove(e) {
    if (dismissed) return;
    const dy = e.touches[0].clientY - touchStartY;
    const dx = e.touches[0].clientX - touchStartX;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    // Decide gesture mode on first meaningful movement
    if (gestureMode === null) {
      if (adx < 6 && ady < 6) return; // not moved enough yet
      const fromLeftEdge = touchStartX < 40;
      const headerBottom = header.getBoundingClientRect().bottom;
      const fromHeaderZone = touchStartY <= headerBottom;
      if (fromLeftEdge && dx > 0 && adx > ady) {
        gestureMode = 'right';
      } else if (fromHeaderZone && ady > adx) {
        gestureMode = 'down';
      } else {
        gestureMode = 'none'; // not a recognised gesture zone — ignore
      }
    }

    if (gestureMode === 'right') {
      if (dx < 0) return; // no leftward drag
      e.preventDefault();
      const progress = Math.min(dx / window.innerWidth, 1);
      sheet.style.transform = `translateX(${dx}px)`;
      overlay.style.background = `rgba(0,0,0,${0.85 * (1 - progress * 0.9)})`;
    } else if (gestureMode === 'down') {
      if (dy < 0) { sheet.style.transform = `translateY(${dy * 0.15}px)`; return; }
      e.preventDefault();
      const progress = Math.min(dy / window.innerHeight, 1);
      sheet.style.transform = `translateY(${dy}px)`;
      overlay.style.background = `rgba(0,0,0,${0.85 * (1 - progress * 0.8)})`;
    }
  }

  function onTouchEnd(e) {
    if (dismissed || gestureMode === null || gestureMode === 'none') return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (gestureMode === 'right' && dx > 80) {
      dismissSheet('right');
    } else if (gestureMode === 'down' && dy > 120) {
      dismissSheet('down');
    } else {
      snapBack();
    }
    gestureMode = null;
  }

  // Register on the whole overlay — gestureMode detection decides what to track.
  // Down swipes only commit when starting from header/handle (checked via touchStartY
  // falling within the header bounds), right-edge swipes work from anywhere.
  overlay.addEventListener('touchstart', onTouchStart, { passive: true });
  overlay.addEventListener('touchmove', onTouchMove, { passive: false });
  overlay.addEventListener('touchend', onTouchEnd, { passive: true });
}

export function closePreview() {
  document.getElementById('preview-overlay')?.remove();
}

export async function showLinkPicker(itemId) {
  const item = await db.items.get(itemId);
  if (!item) return;
  trackRecentlyViewed(item.id);

  // Re-derive links the same way showPreview does
  const links = [];
  if (item.url && !item.url.includes('reddit.com')) {
    links.push({ label: item.url.length > 70 ? item.url.slice(0, 67) + '…' : item.url, url: fullUrl(item.url) });
  }
  if (item.body) {
    const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
    for (const m of mdLinks) {
      const url = fullUrl(m[2]);
      if (!links.find(l => l.url === url)) links.push({ label: m[1].slice(0, 70), url });
    }
    const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
    for (const m of bareLinks) {
      const url = fullUrl(stripUrlPunct(m[1]));
      if (!links.find(l => l.url === url)) {
        links.push({ label: url.length > 70 ? url.slice(0, 67) + '…' : url, url });
      }
    }
  }

  const sheet = document.createElement('div');
  sheet.id = 'link-picker-overlay';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,0.6);display:flex;align-items:flex-end';
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
  sheet.innerHTML = `
    <div style="background:var(--surface);border-radius:20px 20px 0 0;width:100%;padding:20px;max-height:70vh;overflow-y:auto">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:16px;font-size:16px">Choose a link</div>
      ${links.map((l, i) => `
        <a href="${escHtml(l.url)}" target="_blank" rel="noopener"
          style="display:block;padding:12px;border-radius:10px;background:var(--surface2);margin-bottom:8px;text-decoration:none;color:var(--text)"
          onclick="document.getElementById('link-picker-overlay')?.remove()">
          <div style="font-size:13px;color:var(--text);margin-bottom:2px">${escHtml(l.label)}</div>
          <div style="font-size:11px;color:var(--accent2);word-break:break-all">${escHtml(l.url)}</div>
        </a>`).join('')}
      <button class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:4px"
        onclick="document.getElementById('link-picker-overlay')?.remove()">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
}

// ─── ITEM ACTIONS ────────────────────────────────────────────────────────────

