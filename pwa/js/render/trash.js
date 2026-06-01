// render/trash.js — view rendering (split out of the former render.js).
import { deleteAllTrashed, deleteItemPermanently, purgeDeletedItems, purgeSingleItem, restoreDeletedItem, restoreItem } from '../items.js';
import { filteredItems } from '../search.js';
import { state } from '../state.js';
import { escHtml, fullUrl } from '../util.js';
import { showPreview } from './preview.js';
import { render } from './shell.js';

export function renderTrashView() {
  const items = filteredItems();

  if (state.showDeleted) {
    const deletedItems = state.items.filter(i => i.isPermanentlyDeleted)
      .sort((a, b) => new Date(b.deletedAt||0) - new Date(a.deletedAt||0));
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-family:'Syne',sans-serif;font-weight:600">🗑️ Deleted Items (${deletedItems.length})</div>
        <button class="btn btn-ghost btn-sm" onclick="state.showDeleted=false;render()">← Back</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        These items are hidden from your library. Restore to bring them back, or Purge to remove them from the database entirely.
      </p>
      ${deletedItems.length === 0 ? `
        <div class="empty"><div class="empty-icon">✓</div><h3>No deleted items</h3></div>
      ` : `
        <button class="btn btn-danger btn-sm" style="width:100%;justify-content:center;margin-bottom:12px"
          onclick="if(confirm('Remove ${deletedItems.length} item${deletedItems.length!==1?'s':''} from the database entirely? If they still exist in your Reddit saves they may reappear on next feed sync.'))purgeDeletedItems()">
          ⚠️ Purge all from database
        </button>
        ${deletedItems.map(item => {
          const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
          const deletedStr = item.deletedAt ? new Date(item.deletedAt).toLocaleDateString() : '';
          return `
            <div class="card" style="border-color:rgba(239,68,68,0.15);opacity:0.8">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
                <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
                ${item.subreddit ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>` : ''}
                ${deletedStr ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">Deleted ${deletedStr}</span>` : ''}
              </div>
              <div onclick="showPreview(${item.id})" style="font-family:'Syne',sans-serif;font-weight:600;font-size:14px;color:var(--text);line-height:1.3;margin-bottom:8px;cursor:pointer">
                ${escHtml(item.title || 'Untitled')}
              </div>
              <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-ghost btn-sm" onclick="showPreview(${item.id})">👁 View</button>
                <button class="btn btn-ghost btn-sm" onclick="restoreDeletedItem(${item.id})">↩ Restore</button>
                <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener">↗ Open</a>
                <button class="btn btn-danger btn-sm" onclick="if(confirm('Remove from database entirely? It may reappear on next feed sync.'))purgeSingleItem(${item.id})">⚠ Purge</button>
              </div>
            </div>`;
        }).join('')}
      `}
    `;
  }

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-family:'Syne',sans-serif;font-weight:600">🗑️ Trash (${items.length})</div>
      <div style="display:flex;gap:8px">
        ${items.length > 0 ? `<button class="btn btn-danger btn-sm" onclick="deleteAllTrashed()">Delete all</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="state.showTrash=false;render()">← Back</button>
      </div>
    </div>
    ${items.length === 0 ? `
      <div class="empty"><div class="empty-icon">🗑️</div><h3>Trash is empty</h3><p>Items you dislike will appear here.</p></div>
    ` : items.map(item => {
      const openUrl = fullUrl((item.type === 'comment' ? item.permalink : item.url) || item.permalink || item.url || '');
      return `
        <div class="card" style="border-color:rgba(239,68,68,0.2)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <span class="badge ${item.type==='comment'?'badge-comment':'badge-post'}">${item.type==='comment'?'💬 Comment':'📝 Post'}</span>
            ${item.subreddit ? `<span class="subreddit-tag">r/${escHtml(item.subreddit)}</span>` : ''}
            ${item.author ? `<span style="font-size:11px;color:var(--text-muted)">u/${escHtml(item.author)}</span>` : ''}
          </div>
          <div onclick="showPreview(${item.id})" style="font-family:'Syne',sans-serif;font-weight:600;font-size:15px;color:var(--text);line-height:1.3;margin-bottom:8px;cursor:pointer">
            ${escHtml(item.title || 'Untitled')}
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick="showPreview(${item.id})">👁 View</button>
            <button class="btn btn-ghost btn-sm" onclick="restoreItem(${item.id})">↩ Restore</button>
            <a class="btn btn-ghost btn-sm" href="${escHtml(openUrl)}" target="_blank" rel="noopener">↗ Open</a>
            <button class="btn btn-danger btn-sm" onclick="if(confirm('Permanently delete this item?'))deleteItemPermanently(${item.id})">🗑 Delete</button>
          </div>
        </div>`;
    }).join('')}
    ${(() => {
      const deletedCount = state.items.filter(i => i.isPermanentlyDeleted).length;
      return deletedCount > 0 ? `
        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
          <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;opacity:0.7"
            onclick="state.showDeleted=true;render()">
            View ${deletedCount} deleted item${deletedCount!==1?'s':''}
          </button>
        </div>` : '';
    })()}
  `;
}

