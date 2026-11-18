# RedditVault — Complete Setup Guide

Welcome! This guide walks you through everything step by step.
**No programming experience required.**

---

## What You're Setting Up

RedditVault has three main parts, plus a capture tool that runs in your browser:

```
[Userscript / Bookmarklet]  →  [Supabase Cloud DB]  →  [PWA on iPhone / any browser]
  Captures from Reddit           Stores everything        Browse & organise
  using your own login
```

- **Supabase**: Free cloud database that syncs between your devices.
- **PWA** (iPhone/any browser): The main app. Add it to your home screen and it works like a native app — search, filter, lists, tags, ratings, and more.
- **Userscript** (recommended): Runs inside your browser whenever Reddit is open and captures new saves automatically, using your existing Reddit login. No API keys or Reddit developer account needed.
- **Bookmarklet** (no install): A bookmark you tap on Reddit to capture saves manually — works in any browser.
- **Chrome Extension** (optional, desktop): The original desktop sync tool.

> **Why not RSS any more?** Reddit ends RSS feeds on **Nov 13, 2026** and has refused anonymous `.json` requests since May 2026. Reddit said logged-in access is not affected, so RedditVault now reads your saves only through your own logged-in browser session.

**Time to complete: about 20–30 minutes**

---

## PART 1: Set Up Supabase (Free Cloud Database)

### Step 1.1 — Create a Supabase Account

1. Go to **https://supabase.com** and click **"Start your project"**
2. Sign up with GitHub, Google, or email — no credit card needed
3. Confirm your email if prompted

### Step 1.2 — Create a New Project

1. Click **"New project"**
2. Fill in:
   - **Name**: `reddivault` (or anything you like)
   - **Database Password**: make a strong one and save it somewhere
   - **Region**: closest to you
3. Click **"Create new project"** and wait ~2 minutes for it to provision

### Step 1.3 — Create the Database Tables

1. In the left sidebar click **"SQL Editor"** (the `< >` icon)
2. Click **"New query"**
3. Open the file **`supabase-schema.sql`** from this repo and paste the entire contents into the editor
4. Click **"Run"** (or Cmd+Enter)
5. You should see "Success. No rows returned"

> If you see an error about the `moddatetime` extension not being available, your Supabase plan may not support it. In that case, delete just the `CREATE EXTENSION` line and the two `CREATE OR REPLACE TRIGGER` blocks at the bottom, then run again. The app will still work — you just won't get automatic `updated_at` tracking (delta sync will fall back to full sync).

### Step 1.4 — Get Your Connection Keys

1. In the left sidebar click **"Project Settings"** (⚙️ gear icon, near the bottom)
2. Click **"API"**
3. Copy and save two things:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon / public key** — a long string starting with `eyJ...`

> Keep this tab open — you'll paste these values into the app in later steps.

---

## PART 2: Deploy the PWA to Vercel

The PWA is hosted on Vercel and auto-deploys from GitHub whenever you push changes.

### Step 2.1 — Fork or clone the repo

If you haven't already, fork this repo on GitHub or push it to your own GitHub account.

### Step 2.2 — Connect to Vercel

1. Go to **https://vercel.com** and sign up (free, sign in with GitHub)
2. Click **"Add New Project"**
3. Import your GitHub repo
4. Vercel will detect the `vercel.json` file automatically — no build configuration needed
5. Click **"Deploy"**

Vercel will give you a URL like `https://reddivault.vercel.app`. Every push to your main branch auto-deploys.

### Step 2.3 — Add to iPhone Home Screen

1. Open **Safari** on your iPhone (must be Safari, not Chrome)
2. Go to your Vercel URL
3. Tap the **Share button** (box with arrow ↑)
4. Tap **"Add to Home Screen"** → name it **RedditVault** → tap **Add**

The icon will appear on your home screen and launch as a full-screen app.

### Step 2.4 — Connect the PWA to Supabase

1. Open RedditVault from your home screen (or any browser)
2. Tap **Settings** (⚙️ in the bottom nav)
3. Scroll to **☁️ Cloud Database** and tap the ⚙️ settings toggle
4. Enter your **Supabase Project URL** and **Supabase Anon Key** from Step 1.4
5. Tap **"Save & Test Connection"** — you should see "Connected"

---

## PART 3 (Optional): Set Up the Chrome Extension (Desktop Sync)

The extension runs on your Mac and pushes your Reddit saved items to Supabase using your existing Reddit login session — no Reddit API access needed. **Optional:** the userscript (Part 4) captures on desktop too, automatically — skip to Part 4 if you prefer it.

### Step 3.1 — Load the Extension in Chrome

1. Open **Google Chrome** on your Mac
2. Go to `chrome://extensions` in the address bar
3. Enable **"Developer mode"** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the **`extension`** folder from this repo
6. The **RedditVault Sync** extension will appear — pin it to your toolbar via the 🧩 puzzle icon

### Step 3.2 — Configure the Extension

1. Make sure you're **logged into Reddit** in Chrome
2. Click the RedditVault Sync icon in the toolbar
3. Paste your **Supabase Project URL** and **Supabase Anon Key** from Step 1.4
4. Click **"Save Configuration"**

### Step 3.3 — Run Your First Sync

1. Click **"🔄 Sync Saved Items Now"**
2. The extension walks through your Reddit saved pages and uploads everything to Supabase
3. For 500+ items expect 3–10 minutes — Reddit rate-limits requests so the sync deliberately paces itself
4. When done you'll see "✓ Done! X new items added to cloud"
5. Open the PWA and tap **"Pull from cloud"** in Settings to load them onto your device

---

## PART 4: Capture New Saves with the Userscript (Recommended)

The userscript runs inside your browser whenever you have Reddit open. Every 30 minutes at most it checks your saved items and drops any new ones into a temporary **inbox** in your database. Once a day it also refreshes scores and fills in details for imported items. RedditVault imports from the inbox automatically whenever you open *or return to* the app. The userscript never writes to your main table — only the app does that.

It only runs while Reddit is open in that browser. Your saves belong to your Reddit **account**, though, not your device, so one paired browser captures saves you make anywhere — including in the official Reddit app.

### Step 4.1 — Set your Reddit username

Open RedditVault → Settings → **📥 Capture New Saves**, enter **your vault's Reddit username** and tap **Save**. This is required. Only this account is ever synced (see *More than one Reddit account?* below).

### Step 4.2 — Install a userscript manager

| Device | What to install |
|---|---|
| Desktop (Chrome, Edge, Firefox, Safari) | **Tampermonkey** or **Violentmonkey** |
| Android | **Firefox** or **Microsoft Edge**, then the Violentmonkey or Tampermonkey add-on. *(Chrome for Android has no extensions.)* |
| iPhone / iPad | The free **Userscripts** app (App Store). Then go to Settings → Apps → Safari → Extensions → **Userscripts** → turn it on and allow it on **reddit.com**. |

### Step 4.3 — Install the RedditVault userscript

In **📥 Capture New Saves**, tap **⬇️ Install userscript**. Your manager shows an install screen — confirm it. Updates arrive automatically when RedditVault is updated.

### Step 4.4 — Pair this browser

Tap **🔗 Pair this browser**. Reddit opens, and the userscript asks you to confirm linking to your vault. You do this once per browser.
- If the link opens the Reddit *app* instead, tap **Copy pairing code**. Then open reddit.com in your browser, tap the **RV** button → **Paste pairing code**.

### Using it

- Just browse Reddit. A small **RV** button sits in the corner: ✓ means all good, ! means paused (wrong account or logged out), ✗ means a problem.
- Tap **RV** for **Sync now**, **Refresh scores & details**, the last results, and how many items are waiting in the inbox. You can also move or hide the button. Hidden buttons come back via Settings → **Show userscript button**.
- **Open Reddit & capture now** in Settings opens your saved page and syncs immediately.

> **iPhone tip:** if the RV button doesn't appear, open Reddit in **Safari itself** (e.g. from a Safari bookmark). Links opened from a home-screen app can land in a view where Safari extensions don't run.

### More than one Reddit account?

RedditVault only ever syncs the account you set in Step 4.1:
- Before every run, the userscript and the bookmarklet check which account is logged in. If it's a different account they pause, and there is no override.
- They read only that account's saved list.
- The userscript re-checks right before every upload, in case you switch accounts mid-sync.
- Every captured item is tagged with the account that captured it, and RedditVault rejects anything from another account.

---

## PART 4b: Bookmarklet (No Install, Any Browser)

The **bookmarklet** does the same capture as the userscript, but runs only when you tap it. It runs *as* reddit.com using your existing login, grabs your saved items, and drops them into the same **inbox**.

> **old.reddit.com vs new Reddit:** on **`old.reddit.com`** the bookmarklet sends straight to your vault. New Reddit (`www.reddit.com` / `sh.reddit.com`) has a strict Content-Security-Policy that blocks the direct send. There, the bookmarklet captures your newest ~300 saves and offers a **Copy** button instead — paste the result into RedditVault. *(The userscript isn't affected by this.)*

### Step 4b.1 — Add the inbox table

If you set up Supabase before v0.9.12.0, add the staging table: open Supabase → SQL Editor → New Query, paste the `reddit_inbox` block from the **MIGRATION** section of `supabase-schema.sql`, and Run. (Fresh installs from the current schema already include it.)

### Step 4b.2 — Install the bookmarklet

1. Open RedditVault → Settings → **📥 Capture New Saves**, and make sure **your vault's Reddit username** is set (required — the bookmarklet is built with it).
2. Optionally set **Refresh scores: how many recent saves to check** (default **500**). This is read live, so changing it needs no re-copy.
3. **Desktop:** drag the **📥 Save to RedditVault** button to your bookmarks bar.
4. **iOS / Safari:** tap **Copy**. Bookmark any page (Share → Add Bookmark), then open the Bookmarks list (📖 icon) → **Edit** → tap that bookmark → clear its URL → **paste** → Done.

> If you change your username later, **re-copy the bookmarklet** so the new value is baked in. (Upgrading from v0.9.x? Re-copy it too — older copies don't have the account protection.)

### Step 4b.3 — Run the bookmarklet (menu)

1. Go to **`old.reddit.com`** and make sure you're logged in as your vault's account.
2. Run the bookmarklet:
   - **Desktop:** click it in the bookmarks bar.
   - **iOS:** open the **Bookmarks list** (📖 icon) and tap it there. *Do not* type its name in the address bar — iOS blocks that ("JavaScript is not allowed to be used this way").
3. A small menu appears at the top of the page, showing **"logged in as u/…"**. If that's not your vault's account, it stops and tells you to switch.
   - **① Capture new saves** — grabs your latest saved items into the inbox. Shows **"Captured N new saves"** or **"Already up to date"**.
   - **② Refresh scores & details** — re-checks scores on your most recent saves (the **Refresh scores** setting) and sends only the ones that changed. It also fills in full details for items that still need enrichment (e.g. from a CSV import). It sends as it goes, so an interrupted run keeps its progress — just run it again. *(old.reddit.com only.)*
4. Switch back to RedditVault — it drains the inbox automatically on launch **and whenever you return to the app**. You can also force it from **Settings → 📥 Capture New Saves → 📨 Import from inbox now**.

**Helpful prompts:** if you run it on the wrong page or while logged out, the menu offers a button to jump to **old.reddit.com** or the **login** page. A bookmarklet can't keep running across a page change, so **tap the bookmark again** on the page it landed you on.

Capture is incremental: it only scans back as far as the newest saves you already have, so routine runs are quick. If the banner offers a **Copy** button (new Reddit, or your vault was unreachable), tap it, then use **📥 Capture New Saves → 📋 Paste captured items** in RedditVault.

---

## PART 5: Import Your Full Reddit History (CSV)

Reddit only lists your most recent ~1,000 saved items, so that's all any capture tool can reach. To import your complete history, request a data export from Reddit. It's an official export that doesn't depend on Reddit's APIs. Worth repeating every few months as a backup.

### Step 5.1 — Request Your Data

1. Go to **https://www.reddit.com/settings/data-request**
   *(or Settings → Privacy & Security → Request data)*
2. Click **"Request data"** or **"Request archive"**
3. Reddit will email you when it's ready — usually a few hours, up to 24h

### Step 5.2 — Import the CSVs

1. Download and unzip the file Reddit emails you
2. Look for **`saved_posts.csv`** and **`saved_comments.csv`** (may be in a subfolder)
3. Open RedditVault (a desktop browser is easiest)
4. Go to **Settings → 📥 Import & Enrich**
5. Tap the import area and select **both files** (or drag them in)
6. The app imports everything, skips anything you already have, and pushes new items to Supabase automatically

> Reddit's export is sparse — just IDs and links. To fill in titles, authors and post bodies, enrich in two steps:
> 1. **⚡ Enrich via Arctic Shift** — a public archive that resolves thousands of items in seconds.
> 2. **Your Reddit login** fills in the rest: the userscript does it automatically once a day, or run the bookmarklet's **② Refresh scores & details** on old.reddit.com. Up to 1,000 items per run.

---

## PART 6: Ongoing Use

### Daily workflow

- **New saves are captured automatically** while you browse Reddit with the userscript (Part 4), or whenever you tap the bookmarklet (Part 4b)
- **RedditVault imports them** the next time you open or return to it
- **On your iPhone** tap the sync button (🔄 top right) to pull the latest from the cloud

### Organising your library

- Go to the **Lists** tab to create lists — either static (you add items manually) or smart (defined by a search query that auto-updates)
- Tap the ⋯ menu on any item to add it to a list, rate it, favourite it, or trash it
- Use **Tags** (smart lists with the tag option enabled) to add coloured chips to items that appear inline in browse view
- Use the search bar with the filter panel for advanced filtering by subreddit, author, date range, type, rating, and more

### Backing up your data

- Settings → **📊 Library** → **Export Backup JSON**
- Save the file to iCloud Drive or similar
- You can restore from this backup at any time via the same Settings panel

---

## Troubleshooting

**Extension says "Not logged in to Reddit"**
→ Open reddit.com in Chrome, make sure you're logged in, then try syncing again.

**Extension shows "Supabase error 401" or "403"**
→ Wrong key. Go to Supabase → Project Settings → API and re-copy the **anon/public** key (not the `service_role` key).

**Extension shows "Supabase error 400" or "column not found" (PGRST204)**
→ Schema cache stale. Go to Supabase → Project Settings → API → scroll down → click **"Reload schema cache"**. Wait 30 seconds and retry.

**PWA says "Sync failed"**
→ Check Supabase URL and key in Settings. The URL should end in `.supabase.co` with no trailing slash.

**Feed sync says "Failed"**
→ Reddit ended RSS feeds on Nov 13, 2026. Switch to the userscript (Part 4) or bookmarklet (Part 4b).

**The userscript's RV button shows "!"**
→ You're logged out, or logged into a different Reddit account than your vault's. Switch to the vault's account — syncing resumes on its own. Tap RV to see which account it sees.

**The userscript's RV button shows "✗" ("vault unreachable")**
→ Free Supabase projects pause after a week with no activity. Open the Supabase dashboard and restore the project. Nothing is lost — the userscript retries automatically and only marks items as sent once Supabase accepts them.

**No RV button on Reddit**
→ Check the userscript is installed and enabled in your manager, and (iPhone) that the Userscripts extension is allowed on reddit.com. Open Reddit in the browser itself, not an in-app view. If you hid the button, use Settings → **Show userscript button**.

**"Skipped N captured from u/…" toast in RedditVault**
→ Something was captured while a different Reddit account was logged in (e.g. an old bookmarklet copy). Those items were not imported. Re-copy the bookmarklet from Settings.

**iPhone app shows browser UI instead of full-screen**
→ Must be opened in **Safari** (not Chrome for iOS) and added to home screen via "Add to Home Screen". Always open from the home screen icon, not from Safari's address bar.

**Imported CSV items are missing titles**
→ Expected — Reddit's CSV only contains IDs and URLs. Run **⚡ Enrich via Arctic Shift** in Settings → Import & Enrich. The userscript's daily refresh (or the bookmarklet's **② Refresh scores & details**) fills in the rest.

**Sync is slow**
→ Intentional. The extension waits between pages to avoid Reddit rate limits. For 1,000 items expect 10–15 minutes. Leave the popup open and let it run.

---

## Privacy

- Your Reddit credentials are **never stored or sent anywhere** by this app. The userscript, bookmarklet and extension use your browser's existing Reddit session (cookies), exactly like normal browsing.
- The userscript stores its pairing (your Supabase URL, anon key and Reddit username) only in your userscript manager's storage. The pairing link carries the code in the URL fragment (`#…`), which browsers never send to Reddit's servers.
- Your Supabase database is private to you. Only someone with your Supabase URL and anon key can access it — keep the anon key private.
- The optional Cloudflare Worker (legacy RSS feed sync, obsolete after Nov 13, 2026) only proxies requests from your configured domain and only to Reddit URLs containing a valid feed token.
- No data is sent to any third party. Everything lives in your own Supabase project.

---

*RedditVault is a personal tool, not affiliated with Reddit, Supabase, Vercel, or Cloudflare.*
