// render/settings.js — view rendering (split out of the former render.js).
import { buildInboxBookmarklet, cspProbeBookmarklet, drainInbox, importPastedBookmarklet, saveRedditUsername, saveScoreRefreshLimit } from '../bookmarklet.js';
import { pushAllToSupabase, pushImportantPreferences, syncFromSupabase } from '../cloud.js';
import { clearAllData } from '../core.js';
import { exportJSON, handleFileImport, repairCSVDuplicates, repairCommentTitles, repairItemTypes, repairSavedAtDates } from '../dataio.js';
import { enrichTimeEstimate, enrichViaArcticShiftOnly, enrichViaRedditOnly, markAttemptedAsDead, resetAllEnrichment, resetDeadToPending, saveEnrichSettings, stopEnrichment, updateSpeedHints } from '../enrich.js';
import { saveFeedUrl, saveSupabaseConfig, syncFromFeed } from '../feed.js';
import { APP_VERSION, db, state } from '../state.js';
import { applyZoomSetting, escHtml, showToast } from '../util.js';
import { render } from './shell.js';

export function renderSettings() {
  const lastSyncStr = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never';
  const unenriched  = state.items.filter(i => i.enrichStatus === 'pending').length;
  const deadCount   = state.items.filter(i => i.enrichStatus === 'dead').length;
  const isNewUser   = state.items.length === 0;

  return `
    <div class="section-title" style="margin-bottom:16px">Settings</div>

    ${isNewUser ? `
    <!-- ── GETTING STARTED ──────────────────────────────────────────────── -->
    <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.8">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:6px;color:var(--accent2)">👋 Getting started</div>
      <div style="color:var(--text-muted)">
        <strong style="color:var(--text)">Already hit Reddit's 1000-save limit?</strong><br>
        Request a data export at <strong style="color:var(--text)">reddit.com/settings</strong> → Data Request, then use <strong style="color:var(--text)">Import & Enrich</strong> below.<br><br>
        <strong style="color:var(--text)">Starting fresh or under the limit?</strong><br>
        Add your Private Feed URL in <strong style="color:var(--text)">Sync New Saves</strong> → Feed connection settings, then tap Sync Now.
      </div>
    </div>
    ` : ''}

    <!-- ── 1. SYNC NEW SAVES ──────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">🔄 Sync New Saves</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Pulls your most recent Reddit saves directly into RedditVault. Run this whenever you've saved new items on Reddit.
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
                ☁️ Cloudflare Worker (recommended)
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
              <span style="font-size:11px;color:var(--text-muted)"><strong>⚠️ Usually won't work for Reddit feeds.</strong> Reddit's firewall blocks CORSfix's shared proxy IPs (independent of User-Agent), so feed sync typically fails with a block/challenge page. The <strong>Cloudflare Worker</strong> option is the reliable choice — Reddit doesn't block its IPs. Note your feed URL (including its private token) would pass through proxy.corsfix.com's servers.<br>CORS proxy service graciously provided by <a href="https://corsfix.com" target="_blank" rel="noopener" style="color:var(--accent2)">CORSfix</a> — thank you for supporting independent developers.</span>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="saveFeedUrl()" style="width:100%;justify-content:center">Save Feed Settings</button>
        </div>
      </details>
    </div>

    <!-- ── 1b. BOOKMARKLET SYNC ────────────────────────────────────────────── -->
    <div class="config-section">
      <div style="font-family:'Syne',sans-serif;font-weight:600;margin-bottom:8px">🔖 Bookmarklet Sync</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Reddit is locking down the unauthenticated feed this app relies on. This bookmarklet runs <em>as</em> reddit.com using your existing login, so it keeps working where the feed can't — especially on mobile, where there's no extension. It captures your saves into a temporary inbox; RedditVault imports them on its next open (or tap <em>Import from inbox</em> below).
      </p>
      ${state.supabaseUrl && state.supabaseKey ? (() => {
        const bm = buildInboxBookmarklet(state.supabaseUrl, state.supabaseKey, state.redditUsername);
        const res = state.bookmarkletResult;
        return `
        <div style="background:var(--bg);border-radius:8px;padding:12px;line-height:1.6">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔖 RedditVault bookmarklet (menu)</div>
          <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px 0;line-height:1.6">Tapping it opens a menu: <strong style="color:var(--text)">① Capture new saves</strong> or <strong style="color:var(--text)">② Refresh scores</strong> (re-checks the up/down vote counts across your <em>entire</em> active library; large libraries take longer and stage progress as they go).</p>
          <ol style="font-size:12px;color:var(--text-muted);margin:0 0 12px 18px;padding:0;line-height:1.7">
            <li><strong style="color:var(--text)">Desktop:</strong> drag the button below to your bookmarks bar. On <strong style="color:var(--text)">old.reddit.com</strong> (logged in), click it.</li>
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

          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Your Reddit username <span style="opacity:.7">(optional — guards against capturing from the wrong account)</span></label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:14px;color:var(--text-muted)">u/</span>
              <input id="bm-username" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="username" value="${escHtml(state.redditUsername || '')}" style="flex:1;min-width:140px;font-size:16px">
              <button class="btn btn-secondary btn-sm" onclick="saveRedditUsername()">Save</button>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">If set, the bookmarklet checks the logged-in Reddit account against this name and warns before running on a different account. Leave blank to skip the check.</p>
          </div>

          <div style="margin-top:12px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Refresh scores: how many recent saves to check</label>
            <select id="bm-score-limit" onchange="saveScoreRefreshLimit(this.value)" style="font-size:16px;padding:4px 8px">
              ${[['100','100'],['250','250'],['500','500'],['1000','1000'],['2500','2500'],['0','All']].map(([v,l]) => `<option value="${v}" ${String(state.scoreRefreshLimit) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0 0">Reddit scores settle after a while, so checking only your most recent saves avoids hammering Reddit. Pick <strong>All</strong> for an occasional full refresh. Takes effect immediately — no need to re-copy the bookmarklet.</p>
          </div>

          <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" onclick="drainInbox({manual:true})" ${state.inboxDraining ? 'disabled' : ''}>
              ${state.inboxDraining ? '⏳ Importing…' : '📨 Import from inbox now'}
            </button>
            ${state.lastBookmarkletSync ? `<span style="font-size:11px;color:var(--text-muted)">Last import: ${new Date(state.lastBookmarkletSync).toLocaleString()}</span>` : ''}
          </div>
          ${res ? `
            <div style="margin-top:8px;font-size:12px;background:var(--surface);border-radius:8px;padding:8px 10px">
              ${res.error
                ? `<span style="color:var(--danger)">❌ ${escHtml(res.error)}</span>`
                : `✅ <strong style="color:var(--text)">${res.added}</strong> new &nbsp;·&nbsp; <strong style="color:var(--text)">${res.skipped}</strong> already saved &nbsp;·&nbsp; <strong style="color:var(--text)">${res.scoresUpdated || 0}</strong> scores updated &nbsp;·&nbsp; <strong style="color:var(--text)">${res.drained}</strong> processed`}
            </div>` : ''}

          <details style="margin-top:12px">
            <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">📋 Paste captured items (fallback)</summary>
            <div style="margin-top:10px">
              <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Only needed if the bookmarklet couldn't reach your inbox and offered a <em>Copy</em> button instead. Paste that text here.</p>
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
      })() : `
        <p style="font-size:12px;color:var(--warning);background:rgba(245,158,11,0.08);border-radius:8px;padding:10px">
          ⚠️ Set up your Supabase connection in <strong>Cloud Database</strong> below first — the bookmarklet needs it, and remember to add the <code>reddit_inbox</code> table from <code>supabase-schema.sql</code>.
        </p>
      `}
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
        To get your CSV: go to <strong style="color:var(--text)">reddit.com/settings</strong> → Data Request → download and find <strong style="color:var(--text)">saved_posts.csv</strong>.
      </p>
      <details style="margin-bottom:12px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:2px 0">ℹ️ About importing and enrichment</summary>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:8px;display:grid;gap:8px">
          <p><strong style="color:var(--text)">Before importing your CSV</strong>, it's worth setting up feed sync first if you haven't already. The feed pulls your most recent saves (up to ~1000) with full metadata already attached — no enrichment needed for those. If you have fewer than 1000 saved items in total, the feed alone may be sufficient and you won't need the CSV at all. The CSV is mainly useful for recovering older saves that fall outside the feed's range.</p>
          <p>Items that arrive solely from the CSV will need enrichment to retrieve their titles, subreddits, authors and content. <strong style="color:var(--text)">Start with Arctic Shift</strong> — it's a Reddit archive that can resolve thousands of items in seconds. Because it's an archive it may not have the very latest posts, or posts that were deleted before being archived.</p>
          <p>Once Arctic Shift finishes, check how many items are still unresolved. The <strong style="color:var(--text)">Reddit</strong> pass can recover more but is significantly slower due to rate limiting — whether it's worth running depends on how complete you want your library to be and how many items are still missing.</p>
          <p>The <strong style="color:var(--text)">Retry</strong> button re-queues items that failed due to rate limit hits or temporary errors. Some items need 2–3 passes before they either resolve or are confirmed permanently unavailable as deleted or private posts.</p>
        </div>
      </details>
      <div class="drop-zone" id="drop-zone" onclick="document.getElementById('csv-file').click()" style="margin-bottom:12px">
        <input type="file" id="csv-file" accept=".csv,.json" style="display:none" onchange="(async e => { const f=e.target.files[0]; if(f) await handleFileImport(f); e.target.value=''; })(event)">
        <div class="drop-zone-icon">📥</div>
        <h3>Import Reddit CSV</h3>
        <p>Tap to select your saved_posts.csv file<br>or drag and drop here</p>
      </div>
      ${(() => {
        const pendingCount   = state.items.filter(i => i.enrichStatus === 'pending').length;
        const attemptedCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) > 0).length;
        const thresholdCount = state.items.filter(i => i.enrichStatus === 'pending' && (i.enrichAttempts || 0) >= state.enrichMaxAttempts).length;
        const lastRunClean   = state.lastRunRateLimitHits === 0;
        const hasRunBefore   = state.lastRunRateLimitHits !== null;
        const normalDelaySecs = Math.round(60 / state.enrichReqPerMin);
        const retryDelaySecs  = Math.round(60 / state.enrichRetryReqPerMin);

        if (pendingCount === 0 && !state.enriching) return `
          <div style="font-size:13px;color:var(--success);padding:8px 0">✓ All items enriched</div>`;

        return `
          ${pendingCount > 0 || state.enriching ? `
            <!-- Arctic Shift block -->
            <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--accent2);margin-bottom:4px;font-size:13px">⚡ Arctic Shift</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                Bulk lookup — enriches thousands in seconds. Try this first.
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

            <!-- Reddit block -->
            <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--warning);margin-bottom:4px;font-size:13px">🐢 Reddit</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                ${pendingCount.toLocaleString()} item${pendingCount !== 1 ? 's' : ''} · ${state.enrichReqPerMin} req/min · ~${enrichTimeEstimate(pendingCount || 1000, state.enrichReqPerMin)}
                &nbsp;— may pick up items Arctic Shift missed, but can take hours.
              </div>
              ${state.enriching && state.enrichProgress.phase === 'reddit' ? `
                <div id="enrich-progress-details">
                  <div class="progress-bar"><div class="progress-fill" style="width:${state.enrichProgress.total > 0 ? Math.round((state.enrichProgress.done / state.enrichProgress.total) * 100) : 0}%"></div></div>
                  <div style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:4px">
                    ${state.enrichProgress.done} / ${state.enrichProgress.total} &nbsp;·&nbsp; ${(state.enrichProgress.enriched||0).toLocaleString()} enriched &nbsp;·&nbsp; ${state.enrichProgress.failed||0} unavailable
                    ${state.enrichProgress.rateLimitHits > 0 ? ` &nbsp;·&nbsp; <span style="color:var(--warning)">⚠ ${state.enrichProgress.rateLimitHits} rate limit${state.enrichProgress.rateLimitHits > 1 ? 's' : ''}</span>` : ''}
                    ${(state.enrichProgress.minsLeft||0) > 1 ? ` &nbsp;·&nbsp; ~${state.enrichProgress.minsLeft} min left` : ''}
                  </div>
                </div>
                <button class="btn btn-danger" style="width:100%;justify-content:center;margin-top:10px" onclick="stopEnrichment()">⏹ Pause</button>
              ` : state.enriching ? `` : `
                <button class="btn btn-warning" style="width:100%;justify-content:center" onclick="enrichViaRedditOnly(false)">🐢 Enrich via Reddit</button>
              `}
            </div>
          ` : ''}
          ${attemptedCount > 0 && !state.enriching ? `
            <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:12px;margin-bottom:10px">
              <div style="font-weight:600;color:var(--accent2,#818cf8);margin-bottom:6px;font-size:13px">🔄 ${attemptedCount} item${attemptedCount !== 1 ? 's' : ''} to retry</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
                ${state.enrichRetryReqPerMin} req/min · 1 every ${retryDelaySecs}s · ~${enrichTimeEstimate(attemptedCount, state.enrichRetryReqPerMin)}
                ${hasRunBefore ? (lastRunClean
                  ? ' · <span style="color:var(--success)">Last run clean</span>'
                  : ` · <span style="color:var(--warning)">Last run: ${state.lastRunRateLimitHits} rate limit${state.lastRunRateLimitHits !== 1 ? 's' : ''}</span>`) : ''}
              </div>
              <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="enrichViaRedditOnly(true)">🔄 Retry via Reddit</button>
              ${thresholdCount > 0 ? `
                <button class="btn ${lastRunClean ? 'btn-danger' : 'btn-ghost'} btn-sm" style="width:100%;justify-content:center;margin-top:8px" onclick="markAttemptedAsDead()">
                  ⚰️ Mark ${thresholdCount} as dead ${!lastRunClean ? '(last run had rate limits)' : ''}
                </button>` : ''}
            </div>
          ` : ''}`;
      })()}
      <details style="margin-top:4px">
        <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;padding:4px 0">⚙️ Enrichment speed settings</summary>
        <div style="margin-top:10px;display:grid;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Initial run (req/min, 1–10)</label>
            <div style="display:flex;align-items:center;gap:10px">
              <input class="input" id="enrich-rpm" type="number" min="1" max="10" value="${state.enrichReqPerMin}" style="width:70px" oninput="updateSpeedHints()">
              <span id="hint-normal" style="font-size:12px;color:var(--text-muted)">every ${Math.round(60/state.enrichReqPerMin)}s</span>
            </div>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Retry run (req/min, 1–10)</label>
            <div style="display:flex;align-items:center;gap:10px">
              <input class="input" id="enrich-retry-rpm" type="number" min="1" max="10" value="${state.enrichRetryReqPerMin}" style="width:70px" oninput="updateSpeedHints()">
              <span id="hint-retry" style="font-size:12px;color:var(--text-muted)">every ${Math.round(60/state.enrichRetryReqPerMin)}s</span>
            </div>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Rate limit pause (minutes)</label>
            <input class="input" id="enrich-rl-pause" type="number" min="1" max="30" value="${state.enrichRateLimitPause}" style="width:70px">
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Attempts before bulk-dead</label>
            <input class="input" id="enrich-max-attempts" type="number" min="1" max="20" value="${state.enrichMaxAttempts}" style="width:70px">
          </div>
          <button class="btn btn-secondary btn-sm" onclick="saveEnrichSettings()" style="width:100%;justify-content:center">Save Speed Settings</button>
        </div>
      </details>
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
            onclick="if(confirm('Reset ALL items to pending — re-fetches everything from Reddit. Continue?'))resetAllEnrichment()">
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
