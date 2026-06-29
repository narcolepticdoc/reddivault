// render/card.js — view rendering (split out of the former render.js).
import { applySearch, dislikeItem, toggleFavourite, toggleItemList, trackRecentlyViewed } from '../items.js';
import { state } from '../state.js';
import { escHtml, fmtDate, fullUrl, ratingDisplay } from '../util.js';
import { _listCountMap } from './browse.js';
import { showListMenu } from './lists.js';
import { showLinkPicker, showPreview } from './preview.js';

export function renderItemCard(item, showActions, removeFromListId = null) {
  const badgeClass = item.type === 'comment' ? 'badge-comment' : 'badge-post';
  const badgeLabel = item.type === 'comment' ? '💬 Comment' : '📝 Post';
  const needsEnrich = !item.enriched;
  const inListCount = _listCountMap.get(item.id) || 0;

  // Date display: show post created date if available, otherwise saved date
  const postDate = item.postCreatedAt
    ? `<span class="date-item" title="Date posted to Reddit">📅 ${fmtDate(item.postCreatedAt)}</span>`
    : '';
  const savedDate = item.savedAt
    ? `<span class="date-item" title="Date synced/imported">💾 ${fmtDate(item.savedAt)}</span>`
    : '';

  // Show subreddit prominently, or a warning if missing
  const subredditDisplay = item.subreddit
    ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>`
    : `<span style="font-size:12px;color:var(--warning)">⚠ unknown subreddit</span>`;

  const titleDisplay = item.title
    ? escHtml(item.title)
    : `<span style="color:var(--text-muted);font-style:italic">No title — needs enrichment</span>`;

  // Open link: prefer permalink for comments (goes to comment context),
  // use url for link posts (goes to external destination)
  const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
  const permalinkUrl = fullUrl(item.permalink || item.url || '');

  // Rating: a single compact chip that opens the rating picker (big tap targets).
  // unrated → muted "☆ Rate", 0 → 👎, 1–5 → stars. Read-only contexts just show state.
  const ratingHtml = showActions
    ? `<button class="btn btn-ghost btn-sm" onclick="showRatingMenu(${item.id})" title="Rate"
         style="${item.rating!=null ? '' : 'color:var(--text-muted)'}">${ratingDisplay(item) || '☆ Rate'}</button>`
    : ratingDisplay(item);

  return `
    <div class="card ${needsEnrich ? 'needs-enrichment' : ''}" style="${item.isFavourite?'border-color:rgba(245,158,11,0.35)':''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span class="badge ${badgeClass}">${badgeLabel}</span>
        ${subredditDisplay}
        ${needsEnrich ? `<span class="badge badge-enriching">⚡ needs enrichment</span>` : ''}
        ${item.author ? (() => {
          const freq = state.authorFreq[item.author] || 0;
          const badge = freq >= 3
            ? `<span style="background:rgba(168,85,247,0.2);color:var(--accent2);border-radius:10px;padding:1px 6px;font-size:10px;margin-left:2px">${freq}×</span>`
            : '';
          return `<span style="font-size:11px;color:var(--text-muted);cursor:pointer"
            onclick="applySearch('u/${escHtml(item.author)}')"
            title="Search posts by this author">u/${escHtml(item.author)}${badge}</span>`;
        })() : ''}
      </div>

      <div style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px;color:var(--text);line-height:1.3;margin-bottom:6px;cursor:pointer"
        onclick="showPreview(${item.id})" title="Preview">
        ${titleDisplay}
      </div>

      ${item.body ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escHtml(item.body)}</div>` : ''}

      <div class="date-row">
        ${postDate}
        ${savedDate}
        ${item.score != null ? `<span class="date-item">⬆ ${item.score.toLocaleString()}</span>` : ''}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${showActions ? `
          <!-- Left group: non-destructive curation actions -->
          <div style="display:flex;align-items:center;gap:4px">
            ${ratingHtml}
            <button style="background:none;border:none;cursor:pointer;font-size:16px;padding:2px;line-height:1;color:${item.isFavourite?'#f59e0b':'var(--text-muted)'}"
              onclick="toggleFavourite(${item.id})" title="${item.isFavourite?'Remove from favourites':'Add to favourites'}">
              ${item.isFavourite ? '⭐' : '☆'}
            </button>
            <button class="btn btn-ghost btn-sm" onclick="showListMenu(${item.id})" title="Add to list"
              style="${inListCount>0?'color:var(--accent2)':''}">
              ${inListCount > 0 ? `📋 ${inListCount}` : '📋'}
            </button>
          </div>
          <!-- Right group: open links -->
          <div style="margin-left:auto;display:flex;gap:4px;align-items:center">
            ${(() => {
              const links = [];
              if (item.url && !item.url.includes('reddit.com')) links.push(fullUrl(item.url));
              if (item.body) {
                const mdLinks = [...item.body.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)]+)\)/g)];
                for (const m of mdLinks) { const u = fullUrl(m[2]); if (!links.includes(u)) links.push(u); }
                const bareLinks = [...item.body.matchAll(/(?<!\()(https?:\/\/[^\s)>"\]]+)/g)];
                for (const m of bareLinks) { const u = fullUrl(m[1]); if (!links.includes(u)) links.push(u); }
              }
              if (links.length === 0) return '';
              if (links.length === 1) return `<a class="btn btn-ghost btn-sm" href="${escHtml(links[0])}" target="_blank" rel="noopener" title="Open link" onclick="trackRecentlyViewed(${item.id})">🔗</a>`;
              return `<button class="btn btn-ghost btn-sm" onclick="showLinkPicker(${item.id})" title="Open link (${links.length})">🔗${links.length}</button>`;
            })()}
            <a class="btn btn-ghost btn-sm" href="${escHtml(permalinkUrl)}" target="_blank" rel="noopener" title="Open on Reddit" onclick="trackRecentlyViewed(${item.id})">↗</a>
          </div>
          <!-- Danger group: destructive actions, separated by gap -->
          <div style="display:flex;gap:4px;align-items:center;padding-left:4px;border-left:1px solid var(--border)">
            ${removeFromListId !== null ? `
              <button class="btn btn-ghost btn-sm" title="Remove from list"
                style="color:var(--warning)"
                onclick="(state.confirmDestructive ? confirm('Remove from list?') : true) && toggleItemList(${item.id},${removeFromListId})">✂️</button>
            ` : ''}
            <button class="btn btn-ghost btn-sm" title="Move to trash"
              style="color:var(--danger)"
              onclick="(state.confirmDestructive ? confirm('Move to trash?') : true) && dislikeItem(${item.id})">🗑️</button>
          </div>
        ` : `
          ${ratingHtml}
          <div style="margin-left:auto">
            <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener" onclick="trackRecentlyViewed(${item.id})">Open →</a>
          </div>
        `}
      </div>
    </div>
  `;
}

