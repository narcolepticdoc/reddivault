// util.js — part of RedditVault (auto-split from the original single-file PWA).
import { showPreview } from './render.js';
import { state } from './state.js';

// Read-only rating display. Three distinct states:
//   null/undefined → unrated (shows nothing)
//   0              → thumbs-down (kept, marked bad)
//   1–5            → filled/empty stars
export function ratingDisplay(item) {
  const r = item.rating;
  if (r == null) return '';
  if (r === 0) return `<span style="font-size:13px;color:var(--text-muted)" title="Thumbs down">👎</span>`;
  return `<span style="font-size:12px;color:#f59e0b">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span>`;
}

export function stripUrlPunct(url) {
  // Remove truncated HTML entities at the end first
  url = url.replace(/&(?:[a-z]+|#\d+)?$/, '');
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (/[.,!?:;\]'"']/.test(last)) {
      url = url.slice(0, -1);
    } else if (last === ')') {
      const opens  = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) url = url.slice(0, -1);
      else break;
    } else break;
  }
  return url;
}

// Renders Reddit's markdown subset to safe HTML.
// Handles: headers, bold, italic, code blocks, inline code, blockquotes,
//          ordered/unordered lists, horizontal rules, links, and paragraphs.

export function renderMarkdown(text) {
  if (!text) return '';

  // All URLs (both markdown links and bare URLs) are extracted into placeholders
  // BEFORE escaping and BEFORE bold/italic processing, so underscores and
  // asterisks inside URLs are never touched by formatting regexes.
  const linkPlaceholders = [];
  const ESC_OPEN = '\x01', ESC_CLOSE = '\x02';

  // Step 1: protect escaped brackets
  text = text.replace(/\\\[/g, ESC_OPEN).replace(/\\\]/g, ESC_CLOSE);

  // Step 2: extract markdown links [text](url)
  text = text.replace(/\[([^\]]{1,300}?)\]\((https?:\/\/(?:[^()]+|\([^()]*\))+)\)/g, (_, linkText, url) => {
    url = stripUrlPunct(url);
    const idx = linkPlaceholders.length;
    const safeUrl = url.replace(/'/g, '%27').replace(/"/g, '%22');
    const displayText = linkText.replace(/\x01/g, '[').replace(/\x02/g, ']');
    const safeText = displayText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    linkPlaceholders.push(`<a href="${safeUrl}" onclick="openLink(event,'${safeUrl}')">${safeText}</a>`);
    return `\x00LINK${idx}\x00`;
  });

  // Step 3: extract bare URLs — must happen before escaping so URL path
  // characters like underscores are never touched by italic regexes.
  text = text.replace(/https?:\/\/[^\s<>"\x00]+/g, (url) => {
    url = stripUrlPunct(url);
    const idx = linkPlaceholders.length;
    const safeUrl = url.replace(/'/g, '%27').replace(/"/g, '%22');
    const display = url.length > 50 ? url.slice(0, 47) + '\u2026' : url;
    linkPlaceholders.push(`<a href="${safeUrl}" onclick="openLink(event,'${safeUrl}')">${display}</a>`);
    return `\x00LINK${idx}\x00`;
  });

  // Restore any escaped brackets that weren't part of a link
  text = text.replace(/\x01/g, '[').replace(/\x02/g, ']');

  let html = escHtml(text);

  // Code blocks (``` ... ```) — must come before inline code
  html = html.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic — safe to run now; all URLs are already placeholdered
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^(-{3,}|\*{3,})$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/(^[*\-] .+$(\n[*\-] .+$)*)/gm, match => {
    const items = match.split('\n').map(l => `<li>${l.replace(/^[*\-] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/(^\d+\. .+$(\n\d+\. .+$)*)/gm, match => {
    const items = match.split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Restore all link placeholders
  html = html.replace(/\x00LINK(\d+)\x00/g, (_, i) => linkPlaceholders[+i]);

  // Paragraphs — wrap double-newline separated blocks
  html = html.split(/\n\n+/).map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-3]|ul|ol|pre|blockquote|hr)/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

// ─── LINK HANDLER ────────────────────────────────────────────────────────────

// Ensure a URL is absolute — reddit permalinks are sometimes stored as relative paths
export function fullUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return 'https://www.reddit.com' + url;
  return url;
}

export function openLink(event, url, forceExternal = false) {
  event.preventDefault();
  event.stopPropagation();
  const resolved = fullUrl(url);
  if (!resolved) return;

  // Check if it's a reddit thread we have locally — open preview instead.
  // But not if forceExternal is set (e.g. called from within the preview itself).
  if (!forceExternal && resolved.includes('reddit.com')) {
    const match = resolved.match(/comments\/([a-z0-9]+)/i);
    if (match) {
      const redditId = match[1];
      const localItem = state.items.find(i =>
        i.redditId === redditId ||
        i.redditId === 't3_' + redditId ||
        i.redditId === 't1_' + redditId ||
        (i.permalink || '').includes('/' + redditId + '/')
      );
      if (localItem) {
        showPreview(localItem.id);
        return;
      }
    }
  }

  window.open(resolved, '_blank', 'noopener');
}

// ─── RECENTLY VIEWED ─────────────────────────────────────────────────────────

export function applyZoomSetting() {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  if (state.disableZoom) {
    viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
  } else {
    viewport.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
  }
}

export function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Step-0 CSP probe bookmarklet (see Bookmarklet Sync plan). Runs same-origin on
// reddit.com: first proves the logged-in saved.json fetch works, then tests
// whether Reddit's CSP connect-src lets us POST straight to Supabase. The result
// decides whether iOS gets the automatic direct-POST path or the clipboard
// fallback. Throwaway diagnostic — generated from the user's own creds so it can
// hit their Supabase project.
export function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch(e) { return ''; }
}

export function showToast(msg, type='success') {
  const container = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Sleep with a live countdown displayed in enrich-progress-details
export async function sleepWithCountdown(ms, labelFn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const secsLeft = Math.ceil((end - Date.now()) / 1000);
    const mins = Math.floor(secsLeft / 60);
    const secs = secsLeft % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs.toString().padStart(2,'0')}s` : `${secs}s`;
    state.enrichProgress = { ...state.enrichProgress, rlCountdown: timeStr };
    const el = document.getElementById('enrich-progress-details');
    if (el) {
      const countdownEl = el.querySelector('#rl-countdown');
      if (countdownEl) countdownEl.textContent = `Resuming in ${timeStr}`;
    }
    await sleep(1000);
  }
  state.enrichProgress = { ...state.enrichProgress, rlCountdown: null };
}

