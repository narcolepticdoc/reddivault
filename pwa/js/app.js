// app.js — entry point. Imports every module, re-exposes their exports on
// window so the inline on* handlers in rendered HTML keep resolving (bridge;
// can move to event delegation later), then runs the bootstrap.
import * as Mstate from './state.js';
import * as Mutil from './util.js';
import * as Mcore from './core.js';
import * as Menrich from './enrich.js';
import * as Mcloud from './cloud.js';
import * as Mfeed from './feed.js';
import * as Mbookmarklet from './bookmarklet.js';
import * as Mdataio from './dataio.js';
import * as Msearch from './search.js';
import * as Mitems from './items.js';
import * as Mrender from './render.js';

Object.assign(window, Mstate, Mutil, Mcore, Menrich, Mcloud, Mfeed, Mbookmarklet, Mdataio, Msearch, Mitems, Mrender);

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'SW_UPDATED') {
      // New service worker has activated — reload to get fresh assets
      window.location.reload();
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Mstate.state.supabaseUrl) {
    Mstate.syncLog(`Foregrounded — localDirty=${Mstate.state.localDirty}`);
    if (Mstate.state.localDirty) {
      Mstate.syncLog('Foregrounded: dirty — scheduling retry and reconciling', 'warn');
      Mcloud.scheduleRetry();
      Mcore.reconcileDirtyState();
    } else {
      Mstate.syncLog('Foregrounded: clean — checking if cloud is ahead');
      Mcloud.checkCloudAhead();
    }
  }
  if (document.visibilityState === 'visible') {
    // Wait for any in-flight cloud sync before touching the feed, then drain the
    // bookmarklet inbox — so items captured while the app was backgrounded (e.g.
    // ran the bookmarklet in Safari, switched back) get imported on return, not
    // only on a fresh launch.
    const waitFor = Mcore._startupSyncPromise || Promise.resolve();
    waitFor.catch(() => {})
      .then(() => Mfeed.autoFeedSyncIfDue())
      .then(() => { if (Mstate.state.supabaseUrl && Mstate.state.supabaseKey) return Mbookmarklet.drainInbox(); })
      .catch(() => {});
  }
});

Mcore.init();
