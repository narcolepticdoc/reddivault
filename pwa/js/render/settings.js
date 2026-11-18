// render/settings.js — view rendering (split out of the former render.js).
import { USERSCRIPT_PATH, buildInboxBookmarklet, copyPairingCode, cspProbeBookmarklet, drainInbox, importPastedBookmarklet, openRedditCapture, openRedditRefresh, pairUserscript, saveRedditUsername, saveScoreRefreshLimit, showUserscriptButton } from '../bookmarklet.js';
import { pushAllToSupabase, pushImportantPreferences, syncFromSupabase } from '../cloud.js';
import { clearAllData } from '../core.js';
import { exportJSON, handleFileImports, repairCSVDuplicates, repairCommentTitles, repairItemTypes, repairSavedAtDates } from '../dataio.js';
import { enrichViaArcticShiftOnly, markAttemptedAsDead, resetAllEnrichment, resetDeadToPending, saveEnrichMaxAttempts, stopEnrichment } from '../enrich.js';
import { RSS_SUNSET, rssRetired, saveFeedUrl, saveSupabaseConfig, syncFromFeed } from '../feed.js';
import { APP_VERSION, db, state } from '../state.js';
import { applyZoomSetting, escHtml, showToast } from '../util.js';
import { render } from './shell.js';

export function renderSettings() {
  // "Nov 13, 2026" for the RSS shutdown notices. Computed here, not at module
  // load: the app's imports are circular (state → feed → render → settings), so
  // feed.js constants aren't initialised yet when this module first evaluates.
  const RSS_SUNSET_LABEL = new Date(`${RSS_SUNSET}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const lastSyncStr = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never';
  const unenriched  = state.items.filter(i => i.enrichStatus === 'pending').length;
  const deadCount   = state.items.filter(i => i.enrichStatus === 'dead').length;
  const isNewUser   = state.items.length === 0;
  const hasDb       = !!(state.supabaseUrl && state.supabaseKey);
  const hasUser     = !!state.redditUsername;
  const retired     = rssRetired();

  return `
    <div class="section-title" style="margin-bottom:16px">Settings</div>

    ${isNewUser ? `
    <!-- ── GETTING STARTED ──────────────────────────────────────────────── -->
    <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.8">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:6px;color:var(--accent2)">👋 Getting started</div>
      <div style="color:var(--text-muted)">
        <strong style="color:var(--text)">1.</strong> Connect your Supabase database in <strong style="color:var(--text)">Cloud Database</strong> below.<br>
        <strong style="color:var(--text)">2.</strong> In <strong style="color:var(--text)">Capture New Saves</strong>, set your Reddit username, then install the <strong style="color:var(--text)">userscript</strong> (automatic) or the <strong style="color:var(--text)">bookmarklet</strong> (no install).<br>
        <strong style="color:var(--text)">3.</strong> More than 1,000 saves? Reddit only lists your newest ~1,000 — request your data export at <strong style="color:var(--text)">reddit.com/settings/data-request</strong> and import it in <strong style="color:var(--text)">Import & Enrich</strong> to recover the rest.
      </div>
    </div>
    ` : ''}

    <!-- ── 1. CAPTURE NEW SAVES ───────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">📥 Capture New Saves</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        RedditVault captures your saves using your own Reddit login — no API keys, and unaffected by Reddit's RSS and public-API shutdowns. Captured saves wait in a temporary inbox and import automatically whenever you open or return to RedditVault.
      </p>

      ${state.redditFeedUrl ? `
        <div style="font-size:12px;line-height:1.6;color:var(--text-muted);background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;padding:10px;margin-bottom:12px">
          ${retired
            ? `📡 <strong style="color:var(--text)">Reddit ended RSS feeds on ${RSS_SUNSET_LABEL}</strong>, so your feed sync no longer works and automatic feed sync is off. Use the userscript or bookmarklet below.`
            : `⚠️ <strong style="color:var(--text)">Reddit is ending RSS feeds on ${RSS_SUNSET_LABEL}.</strong> Your feed sync will stop working then — set up the userscript or bookmarklet below now.`}
        </div>
      ` : ''}

      ${!hasDb ? `
        <p style="font-size:12px;color:var(--warning);background:rgba(245,158,11,0.08);border-radius:8px;padding:10px">
          ⚠️ Set up your Supabase connection in <strong>Cloud Database</strong> below first — capture needs it, and remember to add the <code>reddit_inbox</code> table from <code>supabase-schema.sql</code>.
        </p>
      ` : `
      <!-- Vault account (required) -->
      <div style="margin-bottom:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Your vault's Reddit username <span style="color:var(--warning)">(required)</span></label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="font-size:14px;color:var(--text-muted)">u/</span>
          <input class="input" id="bm-username" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="username" value="${escHtml(state.redditUsername || '')}" style="flex:1;min-width:140px;font-size:16px">
          <button class="btn btn-secondary btn-sm" onclick="saveRedditUsername()">Save</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0;line-height:1.5">Only this Reddit account is ever synced. If you're logged into a different account, the userscript and bookmarklet pause instead of capturing, and RedditVault rejects anything captured from another account. After changing it, copy the bookmarklet again (the userscript picks the change up by itself).</p>
      </div>

      ${!hasUser ? `
        <p style="font-size:12px;color:var(--warning);background:rgba(245,158,11,0.08);border-radius:8px;padding:10px">
          ⚠️ Set your vault's Reddit username above to set up the userscript and bookmarklet.
        </p>
      ` : `
      <!-- A. Userscript -->
      <div style="background:var(--bg);border-radius:8px;padding:12px;line-height:1.6;margin-bottom:10px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">🐒 Userscript — automatic <span style="font-weight:400;color:var(--text-muted)">(recommended)</span></div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0">Runs by itself whenever Reddit is open in your browser — captures new saves at most every 30 minutes and refreshes scores &amp; details once a day. Works on old and new Reddit. One paired browser captures saves you make anywhere, including in the Reddit app.</p>
        <ol style="font-size:12px;color:var(--text-muted);margin:0 0 10px 18px;padding:0;line-height:1.7">
          <li><strong style="color:var(--text)">Install a userscript manager.</strong> Desktop: Tampermonkey or Violentmonkey. Android: Firefox or Edge with Violentmonkey/Tampermonkey (Chrome for Android has no extensions). iPhone/iPad: the free <strong style="color:var(--text)">Userscripts</strong> app for Safari — enable it in Settings → Apps → Safari → Extensions and allow it on reddit.com.</li>
          <li><strong style="color:var(--text)">Install the RedditVault userscript</strong> — your manager offers to install it, and updates arrive automatically.</li>
          <li><strong style="color:var(--text)">Pair this browser</strong> — opens Reddit and links the script to this vault (one time per browser). Or copy the pairing code and paste it from the RV button on Reddit.</li>
        </ol>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <a class="btn btn-primary btn-sm" href="${USERSCRIPT_PATH}" target="_blank" rel="noopener" style="text-decoration:none">⬇️ Install userscript</a>
          <button class="btn btn-secondary btn-sm" onclick="pairUserscript()">🔗 Pair this browser</button>
          <button class="btn btn-secondary btn-sm" onclick="copyPairingCode(this)">Copy pairing code</button>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:10px 0 6px 0">On Reddit, tap the <strong style="color:var(--text)">RV</strong> button for <em>Sync now</em>, status and more.</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" onclick="openRedditCapture()">Open Reddit &amp; capture now</button>
          <button class="btn btn-ghost btn-sm" onclick="showUserscriptButton()">Show userscript button</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin:8px 0 0 0">iPhone: if the RV button doesn't appear, open Reddit in Safari itself — links opened from a home-screen app can land in a view where Safari extensions don't run.</p>
      </div>

      <!-- B. Bookmarklet -->
      ${(() => {
        const bm = buildInboxBookmarklet(state.supabaseUrl, state.supabaseKey, state.redditUsername);
        return `
      <div style="background:var(--bg);border-radius:8px;padding:12px;line-height:1.6">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔖 Bookmarklet — no install</div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;line-height:1.6">Tap it on Reddit to open a menu: <strong style="color:var(--text)">① Capture new saves</strong> or <strong style="color:var(--text)">② Refresh scores &amp; details</strong> (re-checks scores of your recent saves and fills in items that still need enrichment). On <strong style="color:var(--text)">old.reddit.com</strong> it sends straight to your vault; on new Reddit it copies your newest saves for you to paste below.</p>
        <ol style="font-size:12px;color:var(--text-muted);margin:0 0 12px 18px;padding:0;line-height:1.7">
          <li><strong style="color:var(--text)">Desktop:</strong> drag the button below to your bookmarks bar. On <strong style="color:var(--text)">old.reddit.com</strong> (logged in as u/${escHtml(state.redditUsername)}), click it.</li>
          <li><strong style="color:var(--text)">iOS/Safari:</strong> tap <em>Copy</em>. Bookmark any page (Share → Add Bookmark), then open the Bookmarks list (📖 icon) → Edit → tap that bookmark, clear its URL and paste this in. On <strong style="color:var(--text)">old.reddit.com</strong>, launch it from the <strong style="color:var(--text)">Bookmarks list</strong> (📖 icon) — <em>not</em> by typing its name in the address bar, which iOS blocks.</li>
        </ol>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <a href="${escHtml(bm)}" onclick="event.preventDefault();alert('Don\\'t click here — drag this to your bookmarks bar (desktop) or use Copy (mobile), then run it on old.reddit.com.')"
            style="display:inline-block;padding:8px 14px;background:var(--accent);color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;cursor:grab">
            📥 Save to RedditVault
          </a>
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(buildInboxBookmarklet(state.supabaseUrl,state.supabaseKey,state.redditUsername)).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
          <button class="btn btn-secondary btn-sm" onclick="window.location.href='https://old.reddit.com/saved'">Open old.reddit.com/saved</button>
        </div>
        <details style="margin-top:12px">
          <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📋 Paste captured items</summary>
          <div style="margin-top:10px">
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">For when the bookmarklet offered a <em>Copy</em> button instead of sending (new Reddit, or your vault was unreachable). Paste that text here.</p>
            <textarea id="bm-paste" placeholder="Paste copied RedditVault data…" style="width:100%;height:70px;font-size:16px;font-family:monospace"></textarea>
            <button class="btn btn-secondary btn-sm" onclick="importPastedBookmarklet()" style="margin-top:6px">Import pasted items</button>
          </div>
        </details>
        <details style="margin-top:8px">
          <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">🔬 Compatibility probe (diagnostics)</summary>
          <div style="margin-top:10px">
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Runs two test fetches on reddit.com and alerts their HTTP status — handy if capture isn't working. Install/run it the same way as the bookmarklet above.</p>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <a href="${escHtml(cspProbeBookmarklet(state.supabaseUrl, state.supabaseKey))}" onclick="event.preventDefault();alert('Drag to bookmarks (desktop) or Copy (mobile), then run on old.reddit.com.')"
                style="display:inline-block;padding:6px 12px;background:var(--accent2);color:#fff;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;cursor:grab">🔬 RV CSP Probe</a>
              <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(cspProbeBookmarklet(state.supabaseUrl,state.supabaseKey)).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
            </div>
          </div>
        </details>
      </div>`;
      })()}
      `}

      <!-- Shared: refresh scope + inbox import -->
      <div style="margin-top:12px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Refresh scores: how many recent saves to check</label>
        <select id="bm-score-limit" onchange="saveScoreRefreshLimit(this.value)" style="font-size:16px;padding:4px 8px">
          ${[['100','100'],['250','250'],['500','500'],['1000','1000'],['2500','2500'],['0','All']].map(([v,l]) => `<option value="${v}" ${String(state.scoreRefreshLimit) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">Reddit scores settle after a while, so checking only your most recent saves avoids hammering Reddit; only changed scores are sent. Pick <strong>All</strong> for an occasional full refresh. Used by both the userscript and the bookmarklet, read live — no need to re-copy or re-pair.</p>
      </div>

      <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="drainInbox({manual:true})" ${state.inboxDraining ? 'disabled' : ''}>
          ${state.inboxDraining ? '⏳ Importing…' : '📨 Import from inbox now'}
        </button>
        ${state.lastBookmarkletSync ? `<span style="font-size:11px;color:var(--text-muted)">Last import: ${new Date(state.lastBookmarkletSync).toLocaleString()}</span>` : ''}
      </div>
      ${(() => {
        const res = state.bookmarkletResult;
        if (!res) return '';
        return `
        <div style="margin-top:8px;font-size:12px;background:var(--surface);border-radius:8px;padding:8px 10px">
          ${res.error
            ? `<span style="color:var(--danger)">❌ ${escHtml(res.error)}</span>`
            : `✅ <strong style="color:var(--text)">${res.added}</strong> new &nbsp;·&nbsp; <strong style="color:var(--text)">${res.skipped}</strong> already saved &nbsp;·&nbsp; <strong style="color:var(--text)">${res.scoresUpdated || 0}</strong> scores updated &nbsp;·&nbsp; <strong style="color:var(--text)">${res.detailsUpdated || 0}</strong> refreshed &nbsp;·&nbsp; <strong style="color:var(--text)">${res.drained}</strong> processed
               ${res.rejected ? `<br><span style="color:var(--warning)">⚠️ ${res.rejected} skipped — captured from a different Reddit account than u/${escHtml(state.redditUsername)}</span>` : ''}`}
        </div>`;
      })()}
      `}

      <!-- Legacy: RSS feed sync -->
      <details style="margin-top:14px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📡 Legacy: RSS feed sync ${retired ? `(ended ${RSS_SUNSET_LABEL})` : `(ends ${RSS_SUNSET_LABEL})`}</summary>
        <div style="margin-top:12px">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
            ${retired
              ? `Reddit stopped serving RSS feeds on ${RSS_SUNSET_LABEL}, so this no longer works and automatic feed sync is off. It's kept only until it's removed in a later release.`
              : `Reddit is shutting RSS feeds down on ${RSS_SUNSET_LABEL}. This keeps working until then, but use the userscript or bookmarklet above going forward.`}
          </p>
          <button class="btn btn-primary" onclick="syncFromFeed()" style="width:100%;justify-content:center"
            ${state.feedSyncing ? 'disabled' : ''}>
            ${state.feedSyncing ? '⏳ Syncing…' : '🔄 Sync Now'}
          </button>
          ${state.feedSyncing && state.feedSyncProgress ? (() => {
            const p = state.feedSyncProgress;
            const pct = Math.min(100, Math.round((p.page / 40) * 100)); // 40 = MAX_PAGES
            return `
              <div style="margin-top:10px">
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
                <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:6px">
                  Page ${p.page} of up to 40 &nbsp;·&nbsp;
                  <strong style="color:var(--text)">${p.added}</strong> new &nbsp;·&nbsp;
                  <strong style="color:var(--text)">${p.skipped}</strong> already saved
                </div>
              </div>`;
          })() : ''}
          ${state.feedSyncResult ? `
            <div style="margin-top:10px;font-size:12px;color:var(--text-muted);background:var(--bg);border-radius:8px;padding:10px;line-height:2">
              ${state.feedSyncResult.error
                ? `<span style="color:var(--danger)">❌ ${escHtml(state.feedSyncResult.error)}</span>`
                : `✅ <strong style="color:var(--text)">${state.feedSyncResult.added}</strong> new &nbsp;·&nbsp;
                   <strong style="color:var(--text)">${state.feedSyncResult.skipped}</strong> already saved &nbsp;·&nbsp;
                   <strong style="color:var(--text)">${state.feedSyncResult.pages}</strong> page${state.feedSyncResult.pages !== 1 ? 's' : ''} fetched
                   ${state.feedSyncResult.added > 0 && state.feedSyncResult.skipped === 0 && state.feedSyncResult.pages >= 40
                     ? `<br><span style="color:var(--warning)">⚠️ No overlap found — you may have saves beyond Reddit's 1000-item limit. Consider a fresh CSV export.</span>`
                     : ''}`
              }
            </div>
          ` : ''}
          ${!state.redditFeedUrl ? `
            <p style="font-size:12px;color:var(--warning);margin-top:8px">⚠️ No feed URL configured — expand settings below to set up.</p>
          ` : ''}
          ${state.lastFeedSync ? `
            <p style="font-size:11px;color:var(--text-muted);margin-top:8px">Last synced: ${new Date(state.lastFeedSync).toLocaleString()}</p>
          ` : ''}
          <div style="margin-top:12px;display:grid;gap:10px">
            <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
              <span>
                Auto-sync on open
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Check for new saves automatically when the app opens or returns to foreground</div>
              </span>
              <input type="checkbox" ${state.autoFeedSync ? 'checked' : ''}
                onchange="state.autoFeedSync=this.checked;db.config.put({key:'autoFeedSync',value:this.checked});render()"
                style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
            </label>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:13px">
              <span style="color:var(--text-muted);font-size:12px">Minimum interval between checks (minutes)</span>
              <input class="input" type="number" min="5" max="1440" value="${state.autoFeedSyncInterval}"
                style="width:70px;text-align:center"
                onchange="state.autoFeedSyncInterval=Math.max(5,+this.value);db.config.put({key:'autoFeedSyncInterval',value:state.autoFeedSyncInterval})">
            </div>
          </div>
          <details style="margin-top:12px">
            <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">⚙️ Feed connection settings</summary>
            <div style="margin-top:12px;display:grid;gap:10px">
              <div class="form-group">
                <label>Private Feed URL</label>
                <input class="input" id="feed-url" placeholder="https://old.reddit.com/user/USERNAME/saved.rss?feed=YOUR_FEED_TOKEN&amp;user=USERNAME"
                  value="${escHtml(state.redditFeedUrl)}" style="font-size:16px">
                <span style="font-size:11px;color:var(--text-muted)">Get from old.reddit.com/prefs/feeds/ → under Private Listings, right-click the RSS (or JSON) button next to 'your saved links' → Copy Link. Either form works — it's converted to the Feed format selected below.</span>
                <button class="btn btn-secondary btn-sm" onclick="window.location.href='https://old.reddit.com/prefs/feeds/'"
                  style="margin-top:8px;width:100%;justify-content:center">
                  🔗 Open Reddit Feeds page
                </button>
              </div>
              <div class="form-group">
                <label>Feed format</label>
                <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">Reddit currently blocks the JSON feed endpoint, so RSS is recommended. Switch to JSON only if Reddit changes which endpoint it blocks (JSON also includes post scores).</p>
                <div style="display:flex;gap:8px">
                  <label id="fmt-label-rss" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedFormat!=='json'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                    <input type="radio" name="feed-format" value="rss" ${state.feedFormat!=='json'?'checked':''}
                      onchange="
                        state.feedFormat='rss';
                        db.config.put({key:'feedFormat',value:'rss'});
                        document.getElementById('fmt-label-rss').style.borderColor='var(--accent2)';
                        document.getElementById('fmt-label-rss').style.background='rgba(99,102,241,0.08)';
                        document.getElementById('fmt-label-json').style.borderColor='var(--border)';
                        document.getElementById('fmt-label-json').style.background='';">
                    <span>RSS <span style="color:var(--text-muted);font-size:11px">(recommended)</span></span>
                  </label>
                  <label id="fmt-label-json" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedFormat==='json'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                    <input type="radio" name="feed-format" value="json" ${state.feedFormat==='json'?'checked':''}
                      onchange="
                        state.feedFormat='json';
                        db.config.put({key:'feedFormat',value:'json'});
                        document.getElementById('fmt-label-json').style.borderColor='var(--accent2)';
                        document.getElementById('fmt-label-json').style.background='rgba(99,102,241,0.08)';
                        document.getElementById('fmt-label-rss').style.borderColor='var(--border)';
                        document.getElementById('fmt-label-rss').style.background='';">
                    <span>JSON</span>
                  </label>
                </div>
              </div>
              <div class="form-group">
                <label>CORS Proxy</label>
                <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">Reddit blocks direct requests from browser-based apps, so feed sync must route through a proxy server. Your feed URL (which contains your private token) passes through whichever proxy you choose.</p>
                <div style="display:flex;gap:8px;margin-bottom:8px">
                  <label id="proxy-label-cloudflare" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedProxyType==='cloudflare'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                    <input type="radio" name="proxy-type" value="cloudflare" ${state.feedProxyType==='cloudflare'?'checked':''}
                      onchange="
                        state.feedProxyType='cloudflare';
                        db.config.put({key:'feedProxyType',value:'cloudflare'});
                        document.getElementById('proxy-worker-row').style.display='';
                        document.getElementById('proxy-corsfix-note').style.display='none';
                        document.getElementById('proxy-label-cloudflare').style.borderColor='var(--accent2)';
                        document.getElementById('proxy-label-cloudflare').style.background='rgba(99,102,241,0.08)';
                        document.getElementById('proxy-label-corsfix').style.borderColor='var(--border)';
                        document.getElementById('proxy-label-corsfix').style.background='';
                      ">
                    ☁️ Cloudflare Worker
                  </label>
                  <label id="proxy-label-corsfix" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;${state.feedProxyType==='corsfix'?'border-color:var(--accent2);background:rgba(99,102,241,0.08)':''}">
                    <input type="radio" name="proxy-type" value="corsfix" ${state.feedProxyType==='corsfix'?'checked':''}
                      onchange="
                        state.feedProxyType='corsfix';
                        db.config.put({key:'feedProxyType',value:'corsfix'});
                        document.getElementById('proxy-worker-row').style.display='none';
                        document.getElementById('proxy-corsfix-note').style.display='';
                        document.getElementById('proxy-label-corsfix').style.borderColor='var(--accent2)';
                        document.getElementById('proxy-label-corsfix').style.background='rgba(99,102,241,0.08)';
                        document.getElementById('proxy-label-cloudflare').style.borderColor='var(--border)';
                        document.getElementById('proxy-label-cloudflare').style.background='';
                      ">
                    🔀 CORSfix
                  </label>
                </div>
                <div id="proxy-worker-row" ${state.feedProxyType==='corsfix'?'style="display:none"':''}>
                  <input class="input" id="feed-proxy-url" placeholder="https://your-worker.workers.dev"
                    value="${escHtml(state.feedProxyUrl)}" style="font-size:16px">
                  <span style="font-size:11px;color:var(--text-muted)">Your deployed Cloudflare Worker URL. Your feed URL stays within your own Cloudflare account. Requires a one-time deploy of the included Worker script.</span>
                </div>
                <div id="proxy-corsfix-note" ${state.feedProxyType!=='corsfix'?'style="display:none"':''}>
                  <input id="feed-proxy-url" type="hidden" value="">
                  <span style="font-size:11px;color:var(--text-muted)">Third-party proxy — no Worker to deploy. RedditVault automatically sends the request headers Reddit's firewall needs (Origin/Referer/User-Agent via CORSfix's header override), so feed sync works through <code>www.reddit.com</code>. Requires a CORSfix account with this site's origin registered. Note your feed URL (including its private token) passes through proxy.corsfix.com's servers; the Cloudflare Worker keeps it within your own account.<br>CORS proxy service graciously provided by <a href="https://corsfix.com" target="_blank" rel="noopener" style="color:var(--accent2)">CORSfix</a> — thank you for supporting independent developers.</span>
                </div>
              </div>
              <button class="btn btn-secondary" onclick="saveFeedUrl()" style="width:100%;justify-content:center">Save Feed Settings</button>
            </div>
          </details>
        </div>
      </details>
    </div>

    <!-- ── 2. CLOUD DATABASE ──────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">☁️ Cloud Database</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
        Sync is automatic — changes are pushed to the cloud as you make them and pulled on startup. Manual push and pull should not be necessary under normal circumstances.
      </p>
      <div class="sync-status" style="margin-bottom:10px">
        <div class="status-dot ${state.syncStatus}"></div>
        <span>${state.syncStatus === 'connected' ? 'Connected' : state.syncStatus === 'syncing' ? 'Syncing...' : 'Not connected'}</span>
        ${state.lastSyncedAt ? `<span style="margin-left:auto;color:var(--text-muted);font-size:11px">Last synced: ${lastSyncStr}</span>` : ''}
      </div>
      ${state.supabaseUrl ? `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-secondary" onclick="syncFromSupabase()" style="flex:1;justify-content:center">⬇️ Pull from Cloud</button>
          <button class="btn btn-secondary" onclick="pushAllToSupabase()" style="flex:1;justify-content:center">⬆️ Push to Cloud</button>
        </div>
      ` : ''}
      <details>
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">⚙️ Supabase connection settings</summary>
        <div style="margin-top:12px;display:grid;gap:10px">
          <div style="font-size:12px;color:var(--text-muted);padding:8px 10px;background:rgba(245,158,11,0.08);border-radius:8px;border:1px solid rgba(245,158,11,0.2)">
            ⚠️ Designed for single-user use. Using the same database from two devices simultaneously may cause list sync conflicts.
          </div>
          <div class="form-group">
            <label>Project URL</label>
            <input class="input" id="sb-url" placeholder="https://xxxx.supabase.co" value="${escHtml(state.supabaseUrl)}">
          </div>
          <div class="form-group">
            <label>Anon Key</label>
            <input class="input" id="sb-key" type="password" placeholder="eyJhbGc..." value="${escHtml(state.supabaseKey)}">
          </div>
          <button class="btn btn-secondary" onclick="saveSupabaseConfig()" style="width:100%;justify-content:center">Save & Test Connection</button>
        </div>
      </details>
    </div>

    <!-- ── 3. LIBRARY ─────────────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px">📊 Library</div>
      ${(() => {
        const active = state.items.filter(i => !i.isDisliked && !i.isPermanentlyDeleted);
        const trashCount = state.items.filter(i => i.isDisliked && !i.isPermanentlyDeleted).length;
        const deletedCount = state.items.filter(i => i.isPermanentlyDeleted).length;
        return `
        <div style="font-size:13px;line-height:2.2">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Total items</span><span>${active.length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Posts</span><span style="font-size:12px">${active.filter(i=>i.type==='post').length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Comments</span><span style="font-size:12px">${active.filter(i=>i.type==='comment').length.toLocaleString()}</span></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Lists</span><span>${state.lists.length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Smart</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='smart').length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:28px;font-size:12px">↳ Tags</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='smart'&&l.isTag).length}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted);padding-left:14px;font-size:12px">↳ Static</span><span style="font-size:12px">${state.lists.filter(l=>l.type==='static').length}</span></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Need enrichment</span>
            <span style="${unenriched>0?'color:var(--warning)':''}">${unenriched}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--text-muted)">Unavailable</span>
            <span style="display:flex;align-items:center;gap:8px">
              <span style="color:var(--text-muted)">${deadCount.toLocaleString()}</span>
              ${deadCount > 0 ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="resetDeadToPending()">↩ Retry all</button>` : ''}
            </span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span style="color:var(--text-muted)">Trash</span>
            <span style="color:var(--text-muted)">${trashCount.toLocaleString()}</span>
          </div>
          ${deletedCount > 0 ? `
          <div style="display:flex;justify-content:space-between;margin-top:4px">
            <span style="color:var(--text-muted)">Deleted (hidden)</span>
            <span style="color:var(--text-muted);font-size:12px">${deletedCount.toLocaleString()}</span>
          </div>` : ''}
        </div>`;
      })()}
      <!-- Backup & Restore -->
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.05em;margin-bottom:10px">BACKUP & RESTORE</div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
          Backup exports all items, lists and list memberships to a JSON file. Restore replaces all local data from a previous backup.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" onclick="exportJSON()" style="flex:1;justify-content:center">⬇️ Backup</button>
          <button class="btn btn-secondary" onclick="document.getElementById('restore-file').click()" style="flex:1;justify-content:center">⬆️ Restore</button>
        </div>
        <input type="file" id="restore-file" accept=".json" style="display:none">
      </div>
    </div>

    <!-- ── 4. IMPORT & ENRICH ─────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">📥 Import & Enrich</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.6">
        Reddit only lists your newest ~1,000 saves. Your <strong style="color:var(--text)">official data export</strong> has all of them: request it, and Reddit emails a ZIP — import both <strong style="color:var(--text)">saved_posts.csv</strong> and <strong style="color:var(--text)">saved_comments.csv</strong> (you can select both at once). Worth repeating every few months as a backup that doesn't depend on Reddit's APIs.
      </p>
      <button class="btn btn-secondary btn-sm" onclick="window.open('https://www.reddit.com/settings/data-request','_blank')" style="margin-bottom:10px">📦 Request your data from Reddit</button>
      <details style="margin-bottom:12px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">ℹ️ About importing and enrichment</summary>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:8px;display:grid;gap:8px">
          <p><strong style="color:var(--text)">Before importing your CSVs</strong>, it's worth setting up capture first (userscript or bookmarklet). Capture pulls your most recent saves (up to ~1,000) with full details attached — no enrichment needed for those. If you have fewer than 1,000 saves in total, capture alone may be enough. The export is mainly for recovering older saves beyond that window.</p>
          <p>The export only contains ids and links, so imported items need enrichment to get their titles, subreddits, authors and content. <strong style="color:var(--text)">Start with Arctic Shift</strong> — a public Reddit archive that resolves thousands of items in seconds. It lags Reddit by a few weeks and may lack posts deleted before they were archived.</p>
          <p>Whatever Arctic Shift misses is filled in <strong style="color:var(--text)">through your own Reddit login</strong>: the userscript does it daily, or run the bookmarklet's <em>Refresh scores &amp; details</em> on old.reddit.com. Each run covers up to 1,000 pending items. Items Reddit no longer has (deleted, removed or private) are retried a few times, after which you can mark them dead.</p>
        </div>
      </details>
      <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file').click()" style="margin-bottom:12px">
        <input type="file" id="csv-file" accept=".csv,.json" multiple style="display:none" onchange="(async e => { await handleFileImports(e.target.files); e.target.value=''; })(event)">
        <div class="drop-zone-icon">📥</div>
        <h3>Import Reddit CSVs</h3>
        <p>Tap to select saved_posts.csv and saved_comments.csv<br>or drag and drop them here</p>
      </div>
      ${(() => {
        const pendingCount   = state.items.filter(i => i.enrichStatus === 'pending').length;
        const attemptedCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) > 0).length;
        const thresholdCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) >= state.enrichMaxAttempts).length;

        if (pendingCount === 0 && !state.enriching) return `
          <div style="font-size:13px;color:var(--success);padding:8px 0">✓ All items enriched</div>`;

        return `
          <!-- Arctic Shift block -->
          <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
            <div style="font-weight:600;color:var(--accent2);margin-bottom:4px;font-size:13px">⚡ 1. Arctic Shift</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
              Bulk archive lookup — enriches thousands in seconds. Try this first.
            </div>
            ${state.enriching && state.enrichProgress.phase === 'arctic' ? `
              <div id="enrich-progress-details">
                <div class="progress-bar"><div class="progress-fill" style="width:${state.enrichProgress.total > 0 ? Math.round((state.enrichProgress.done / state.enrichProgress.total) * 100) : 0}%"></div></div>
                <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
                  ${state.enrichProgress.done.toLocaleString()} / ${state.enrichProgress.total.toLocaleString()} checked &nbsp;·&nbsp; ${(state.enrichProgress.enriched||0).toLocaleString()} enriched
                </div>
              </div>
              <button class="btn btn-danger" style="width:100%;justify-content:center;margin-top:10px" onclick="stopEnrichment()">⏹ Pause</button>
            ` : state.enriching ? `` : `
              <button class="btn btn-secondary" style="width:100%;justify-content:center" onclick="enrichViaArcticShiftOnly()">⚡ Enrich via Arctic Shift</button>
            `}
          </div>

          <!-- Session-based refresh block -->
          <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
            <div style="font-weight:600;color:var(--warning);margin-bottom:4px;font-size:13px">🔖 2. Your Reddit login</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
              ${pendingCount.toLocaleString()} item${pendingCount !== 1 ? 's' : ''} still need${pendingCount === 1 ? 's' : ''} details. The <strong style="color:var(--text)">userscript</strong> fills these in automatically once a day, or run <strong style="color:var(--text)">② Refresh scores &amp; details</strong> from the bookmarklet on old.reddit.com. Up to 1,000 per run; results import when you return here.
            </div>
            <button class="btn btn-secondary" style="width:100%;justify-content:center" onclick="openRedditRefresh()">🔖 Open Reddit &amp; refresh now (userscript)</button>
          </div>

          ${attemptedCount > 0 ? `
            <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--accent2,#818cf8);margin-bottom:6px;font-size:13px">🔁 ${attemptedCount} item${attemptedCount !== 1 ? 's' : ''} not found yet</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
                Reddit didn't return these when asked — usually deleted, removed or private posts. They're retried on every refresh; after ${state.enrichMaxAttempts} misses you can mark them dead (hides them from your library; "Retry all" under Library brings them back).
              </div>
              ${thresholdCount > 0 ? `
                <button class="btn btn-danger btn-sm" style="width:100%;justify-content:center" onclick="markAttemptedAsDead()">
                  ⚰️ Mark ${thresholdCount} as dead
                </button>` : ''}
            </div>
          ` : ''}`;
      })()}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-muted);margin-top:4px">
        <span>Misses before offering "Mark as dead"</span>
        <input class="input" type="number" min="1" max="20" value="${state.enrichMaxAttempts}" style="width:70px;text-align:center" onchange="saveEnrichMaxAttempts(this.value)">
      </div>
      <div id="import-progress" style="display:none;margin-top:10px">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
        <div style="font-size:13px;color:var(--text-muted);text-align:center" id="progress-label">Processing...</div>
      </div>
    </div>

    <!-- ── 5. BEHAVIOUR ───────────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px">🎛️ Behaviour</div>
      <div style="display:grid;gap:14px">
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
          <span>
            Confirm before trashing or removing from list
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Shows a confirmation prompt on destructive card actions</div>
          </span>
          <input type="checkbox" ${state.confirmDestructive ? 'checked' : ''}
            onchange="state.confirmDestructive=this.checked;db.config.put({key:'confirmDestructive',value:this.checked});pushImportantPreferences()"
            style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px">
          <span>
            Disable pinch-to-zoom
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Prevents iOS from zooming into text fields and on pinch gesture</div>
          </span>
          <input type="checkbox" ${state.disableZoom ? 'checked' : ''}
            onchange="state.disableZoom=this.checked;db.config.put({key:'disableZoom',value:this.checked});applyZoomSetting()"
            style="width:18px;height:18px;margin-left:16px;flex-shrink:0">
        </label>
      </div>
    </div>

    <!-- ── 6. DIAGNOSTICS ─────────────────────────────────────────────────── -->
    <div class="config-section" style="opacity:0.85">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:12px;color:var(--text-muted)">🔬 Diagnostics</div>

      <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center;margin-bottom:10px"
        onclick="caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>window.location.reload())">
        ↺ Force reload &amp; clear cache
      </button>

      <details>
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">🔧 Troubleshooting tools</summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:11px;color:var(--text-muted)">These tools were used during initial setup and should rarely be needed.</div>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairItemTypes()">🔧 Repair Post/Comment Types</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairCommentTitles()">💬 Fix Placeholder Comment Titles</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="repairSavedAtDates()">📅 Patch Import Date Clumps</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="if(confirm('Normalise CSV item IDs, merge duplicates and re-queue for enrichment. Continue?'))repairCSVDuplicates()">
            🔧 Repair CSV Duplicates & Re-enrich</button>
          <button class="btn btn-secondary btn-sm" style="width:100%;justify-content:center"
            onclick="if(confirm('Reset ALL items to pending? They are re-enriched via Arctic Shift and your Reddit login (up to 1,000 per refresh). Continue?'))resetAllEnrichment()">
            🔄 Re-enrich Entire Library</button>
          <button class="btn btn-danger btn-sm" style="width:100%;justify-content:center;margin-top:4px"
            onclick="if(confirm('Delete ALL local data? Make sure you have a backup first!'))clearAllData()">⚠️ Clear All Local Data</button>
        </div>
      </details>

      <details style="margin-top:10px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📋 Sync log</summary>
        <div style="margin-top:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11px;color:var(--text-muted)">Session log · 🟢 ok &nbsp;🟡 warn &nbsp;🔴 error · newest first</div>
            <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(state.syncLog.map(e=>'+'+e.t+'s '+e.wall+' '+e.msg).join('\\n')).then(()=>showToast('Log copied','success'))">
              Copy
            </button>
          </div>
          <div id="sync-log-entries" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px"></div>
        </div>
      </details>
    </div>

    <div style="text-align:center;padding:16px 0 4px;font-size:12px;color:var(--border)">
      RedditVault v${APP_VERSION} &nbsp;·&nbsp; DB schema v${db.verno}
    </div>
  `;
}

// ─── MODALS ──────────────────────────────────────────────────────────────────
