# RedditVault — Complete Setup Guide

Welcome! This guide walks you through everything step by step.
**No programming experience required.**

---

## What You're Setting Up

RedditVault has four parts:

```
[Chrome Extension]  →  [Supabase Cloud DB]  →  [PWA on iPhone]
  Syncs from Reddit     Stores everything       Browse & organise

[Cloudflare Worker]  (optional)
  Proxy for auto-sync via Reddit RSS feed
```

- **Chrome Extension** (Mac/desktop): Uses your existing Reddit browser session to upload saved posts to the cloud database. No API keys or Reddit developer account needed.
- **Supabase**: Free cloud database that syncs between your desktop and phone.
- **PWA** (iPhone/any browser): The main app. Add it to your home screen and it works like a native app — search, filter, lists, tags, ratings, and more.
- **Cloudflare Worker** (optional): A tiny proxy that lets the PWA auto-sync new saves directly from Reddit's RSS feed without needing the Chrome extension.

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

## PART 3: Set Up the Chrome Extension (Desktop Sync)

The extension runs on your Mac and pushes your Reddit saved items to Supabase using your existing Reddit login session — no Reddit API access needed.

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

## PART 4: Set Up Auto-Sync via RSS Feed (Optional)

This lets the PWA automatically check for new Reddit saves on a schedule, without needing the Chrome extension open. It uses Reddit's private RSS feed and a Cloudflare Worker as a CORS proxy.

### Step 4.1 — Get Your Reddit RSS Feed URL

1. Log into Reddit on desktop
2. Go to **https://old.reddit.com/prefs/feeds**
3. Find the **"saved links"** RSS feed and copy the URL — it looks like:
   ```
   https://www.reddit.com/saved.rss?feed=abc123&user=yourusername
   ```
   This URL is private to you — treat it like a password.

### Step 4.2 — Deploy the Cloudflare Worker

The worker lives in **`cloudflare-worker/reddit-feed-proxy.js`** in this repo.

1. Go to **https://workers.cloudflare.com** and sign up for a free account
2. Click **"Create a Worker"**
3. Delete all the default code in the editor
4. Paste the entire contents of `cloudflare-worker/reddit-feed-proxy.js`
5. Find this line near the top and update it to your Vercel URL:
   ```javascript
   const ALLOWED_ORIGIN = 'https://reddivault.vercel.app';
   ```
6. Click **"Save and Deploy"**
7. Copy the worker URL — it looks like `https://reddit-feed-proxy.yourname.workers.dev`

> The free Cloudflare Workers plan allows 100,000 requests/day — far more than this app will ever use.

### Step 4.3 — Configure the PWA

1. Open RedditVault → Settings → **🔄 Sync New Saves** → tap the ⚙️ settings toggle
2. Paste your **Reddit RSS feed URL** into "Feed URL"
3. Paste your **Cloudflare Worker URL** into "Proxy URL"
4. Tap **"Test feed connection"** — you should see a success message
5. Enable **"Auto-sync"** and set your preferred interval (e.g. every 30 minutes)

---

## PART 5: Import Your Full Reddit History (CSV)

Reddit only exposes your most recent ~1,000 saved items via its feed. To import your complete history, request a data export from Reddit.

### Step 5.1 — Request Your Data

1. Go to **https://www.reddit.com/settings/data-request**
   *(or Settings → Privacy & Security → Request data)*
2. Click **"Request data"** or **"Request archive"**
3. Reddit will email you when it's ready — usually a few hours, up to 24h

### Step 5.2 — Import the CSV

1. Download and unzip the file Reddit emails you
2. Look for **`saved_posts.csv`** (may be in a subfolder)
3. Open RedditVault in any desktop browser
4. Go to **Settings → 📥 Import & Enrich**
5. Tap the import area and select your `saved_posts.csv`
6. The app will import everything and push new items to Supabase automatically

> Reddit's CSV export is sparse — just IDs and URLs. After importing, use the **"Enrich"** button in Settings to fetch full titles, authors, and post bodies from Reddit's public JSON endpoints. This fills in the missing metadata automatically.

---

## PART 6: Ongoing Use

### Daily workflow

- **New saves appear automatically** if you set up the RSS feed sync (Part 4)
- **Or sync manually** via the Chrome extension when you want to push a batch
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

**Feed sync says "Failed" or returns no items**
→ Check your Cloudflare Worker is deployed and the `ALLOWED_ORIGIN` matches your exact Vercel URL. Check the RSS feed URL is correct by pasting it into a browser — it should return XML.

**iPhone app shows browser UI instead of full-screen**
→ Must be opened in **Safari** (not Chrome for iOS) and added to home screen via "Add to Home Screen". Always open from the home screen icon, not from Safari's address bar.

**Imported CSV items are missing titles**
→ Expected — Reddit's CSV only contains IDs and URLs. Use the **Enrich** button in Settings → Import & Enrich to fetch the missing metadata.

**Sync is slow**
→ Intentional. The extension waits between pages to avoid Reddit rate limits. For 1,000 items expect 10–15 minutes. Leave the popup open and let it run.

---

## Privacy

- Your Reddit credentials are **never stored or sent anywhere** by this app. The extension uses your browser's existing Reddit session (cookies), exactly like normal browsing.
- Your Supabase database is private to you. Only someone with your Supabase URL and anon key can access it — keep the anon key private.
- The Cloudflare Worker only proxies requests from your configured domain and only to Reddit URLs containing a valid feed token.
- No data is sent to any third party. Everything lives in your own Supabase project.

---

*RedditVault is a personal tool, not affiliated with Reddit, Supabase, Vercel, or Cloudflare.*
