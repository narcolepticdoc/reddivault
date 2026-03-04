# RedditVault — Complete Setup Guide

Welcome! This guide will walk you through everything step by step.
**No programming experience required.** If you get stuck anywhere, each step includes
troubleshooting tips.

---

## What You're Setting Up

RedditVault has three parts:

```
[Chrome Extension on your Mac]  →  [Supabase Cloud Database]  →  [PWA on your iPhone]
       Pulls from Reddit              Stores everything              Browse & organize
```

- **Chrome Extension** (Mac): Logs into Reddit with your existing browser session and
  uploads your saved posts to a cloud database.
- **Supabase**: A free cloud database that sits in the middle. Think of it as the
  bridge between your Mac and iPhone.
- **PWA** (iPhone): A web app that reads your saved items and lets you organize them
  into folders. Works like a native app when added to your home screen.

**Time to complete: About 20-30 minutes (mostly waiting for things to load)**

---

## PART 1: Set Up Supabase (Free Cloud Database)

Supabase is completely free for personal use. You don't need a credit card.

### Step 1.1 — Create a Supabase Account

1. Open your browser and go to: **https://supabase.com**
2. Click the green **"Start your project"** button
3. Click **"Sign up"** and create an account (you can sign up with GitHub or Google
   if you prefer, or use an email address)
4. Check your email for a confirmation link and click it
5. You'll be taken to your Supabase dashboard

### Step 1.2 — Create a New Project

1. On your dashboard, click the **"New project"** button
2. Fill in the details:
   - **Name**: Type `reddivault` (or anything you like)
   - **Database Password**: Create a strong password and **save it somewhere** —
     you might need it later
   - **Region**: Pick the one closest to you (e.g., "US East" if you're in the US)
3. Click **"Create new project"**
4. Wait about 2 minutes while Supabase sets up your database
   *(The progress bar will spin — this is normal)*

### Step 1.3 — Create the Database Tables

This is where you tell Supabase what kind of data you want to store.
We'll use Supabase's built-in SQL editor — don't worry, you just need to
copy and paste.

1. In your Supabase project, look at the left sidebar and click **"SQL Editor"**
   *(It looks like a code icon `< >`)*
2. Click **"New query"**
3. Copy and paste this entire block into the editor:

```sql
-- Table to store all your Reddit saved items
CREATE TABLE reddit_saves (
  id               bigserial PRIMARY KEY,
  reddit_id        text UNIQUE NOT NULL,
  type             text DEFAULT 'post',
  subreddit        text,
  title            text,
  url              text,
  permalink        text,
  body             text,
  author           text,
  score            integer,
  folder           text,
  saved_at         timestamptz,
  post_created_at  timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Table to store your folders
CREATE TABLE reddit_folders (
  id          bigserial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  icon        text DEFAULT '📁',
  created_at  timestamptz DEFAULT now()
);

-- Allow the app to read and write without complex login
ALTER TABLE reddit_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE reddit_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON reddit_saves FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON reddit_folders FOR ALL USING (true) WITH CHECK (true);

-- Speed up searches
CREATE INDEX idx_reddit_saves_folder       ON reddit_saves(folder);
CREATE INDEX idx_reddit_saves_saved_at     ON reddit_saves(saved_at DESC);
CREATE INDEX idx_reddit_saves_post_created ON reddit_saves(post_created_at DESC);
CREATE INDEX idx_reddit_saves_type         ON reddit_saves(type);
CREATE INDEX idx_reddit_saves_subreddit    ON reddit_saves(subreddit);
```

4. Click the **"Run"** button (or press Ctrl+Enter / Cmd+Enter)
5. You should see a green message saying "Success. No rows returned"
   *(If you see an error, try running it again — sometimes it times out)*

### Step 1.4 — Get Your Connection Keys

Now you need two pieces of information to connect the app to your database.

1. In the left sidebar, click **"Project Settings"** (gear icon ⚙️ at the bottom)
2. Click **"API"** in the settings menu
3. You'll see two things you need:

   **Your Project URL** — looks like:
   ```
   https://abcdefghijklmn.supabase.co
   ```

   **Your anon/public key** — a very long string starting with `eyJ...`

4. **Keep this browser tab open** — you'll need to copy these values in the next steps

---

## PART 2: Set Up the Chrome Extension (Mac)

The Chrome extension runs on your Mac and pulls your saved posts from Reddit
using your existing logged-in browser session — no API keys needed.

### Step 2.1 — Download the Extension Files

The `extension` folder contains these files:
```
extension/
├── manifest.json
├── popup.html
├── popup.js
└── background.js
```

Save this entire `extension` folder to somewhere easy to find on your Mac,
like your Desktop or Documents folder.

> **Note:** You'll also need icon image files. Since we can't auto-generate images,
> you can use any small PNG image as a placeholder icon, or skip the icons —
> the extension will work without them (Chrome will just show a default puzzle icon).
> Name them `icon16.png`, `icon48.png`, and `icon128.png` if you want custom icons.

### Step 2.2 — Load the Extension in Chrome

1. Open **Google Chrome** on your Mac
2. In the address bar, type: `chrome://extensions` and press Enter
3. In the top-right corner of that page, turn on **"Developer mode"**
   *(There's a toggle switch — flip it to the right)*
4. Click the **"Load unpacked"** button that appears
5. A file picker will open — navigate to and select your `extension` folder
6. The **RedditVault Sync** extension should now appear in your list!
7. Click the puzzle piece 🧩 icon in Chrome's toolbar (top right)
8. Find "RedditVault Sync" and click the pin 📌 icon to keep it visible

### Step 2.3 — Configure the Extension

1. Make sure you're **logged into Reddit** in Chrome at reddit.com
   *(This is essential — the extension uses your login session)*
2. Click the **RedditVault Sync** icon in Chrome's toolbar
3. A small popup will appear asking for your Supabase details
4. Go back to your Supabase browser tab from Step 1.4 and copy:
   - **Project URL** → paste into "Supabase Project URL"
   - **anon/public key** → paste into "Supabase Anon Key"
5. Click **"Save Configuration"**

### Step 2.4 — Run Your First Sync

1. Click the RedditVault Sync icon in Chrome's toolbar
2. Click **"🔄 Sync Saved Items Now"**
3. The extension will start fetching your saved posts from Reddit
4. Watch the progress in the Activity Log — it shows each page being fetched
5. **Important:** Reddit limits how quickly you can request pages, so the sync
   deliberately goes slowly. For 500+ saved items, expect 3-5 minutes.
6. When done, you'll see "✓ Done! X new items added to cloud"

> **If you get a "Not logged in" error:** Go to reddit.com in Chrome, log in,
> then try syncing again.

> **If you get a "Supabase error 400 / PGRST204 / column not found" error:**
> Supabase's schema cache sometimes takes a moment to register new columns.
> Go to your Supabase project → **Project Settings → API** → scroll down and
> click **"Reload schema cache"**. Wait about 30 seconds, then click Sync again.
> If you still get the error, go to the SQL Editor and run this to make sure all
> columns exist:
> ```sql
> ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS post_created_at timestamptz;
> ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS permalink text;
> ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS author text;
> ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS score integer;
> ```
> Then reload the schema cache again and retry the sync.

> **If you get any other "Supabase error":** Double-check that you copied the URL
> and key correctly, with no extra spaces.

---

## PART 3: Set Up the PWA on iPhone

The PWA (Progressive Web App) is a website that behaves like a native app.
You'll host it on Vercel (free) and then add it to your iPhone home screen.

### Step 3.1 — Create a Free Vercel Account

1. Go to **https://vercel.com** and click "Sign Up"
2. Sign up with GitHub, GitLab, or an email address
3. Follow the prompts to set up your account

### Step 3.2 — Prepare the PWA Files

The `pwa` folder contains:
```
pwa/
├── index.html
├── manifest.json
└── sw.js
```

You also need icon images. Create two simple PNG files:
- `icon-192.png` (192×192 pixels)
- `icon-512.png` (512×512 pixels)

You can use any image editor, or download a simple Reddit/bookmark icon online
and resize it. Place them in the `pwa` folder.

### Step 3.3 — Deploy to Vercel

**Option A: Using Vercel's web interface (easiest — no command line)**

1. Go to **https://vercel.com/new**
2. Look for the option to **"Deploy from template"** or **"Import from Git"**
3. Alternatively, install the **Vercel CLI**:
   - Open **Terminal** on your Mac (search "Terminal" in Spotlight with Cmd+Space)
   - Type this and press Enter:
     ```
     npm install -g vercel
     ```
   - If you get an error about npm not being found, you need to install Node.js first:
     go to **https://nodejs.org** and download the "LTS" version, install it, then try again

4. In Terminal, navigate to your pwa folder:
   ```
   cd ~/Desktop/pwa
   ```
   *(Change `Desktop` to wherever you saved the folder)*

5. Type and run:
   ```
   vercel
   ```

6. Follow the prompts:
   - "Set up and deploy?" → **Y**
   - "Which scope?" → Select your account
   - "Link to existing project?" → **N**
   - "Project name?" → Type `reddivault` and press Enter
   - "Directory?" → Press Enter (it'll use current directory)

7. Vercel will deploy and give you a URL like:
   ```
   https://reddivault-abc123.vercel.app
   ```
   **Copy this URL — you'll use it in the next step!**

**Option B: Drag and drop (even easier)**

1. Go to **https://vercel.com/new**
2. Look for "Deploy" or "Drag and drop" option
3. Drag your entire `pwa` folder into the browser window
4. Vercel will deploy it automatically

### Step 3.4 — Add to iPhone Home Screen

1. Open **Safari** on your iPhone (must be Safari, not Chrome)
2. Go to your Vercel URL (e.g., `https://reddivault-abc123.vercel.app`)
3. Tap the **Share button** (the box with an arrow pointing up ↑)
4. Scroll down and tap **"Add to Home Screen"**
5. Name it **"RedditVault"** and tap **"Add"**

The app icon will appear on your home screen just like a native app!

### Step 3.5 — Connect the PWA to Supabase

1. Open **RedditVault** from your iPhone home screen
2. Tap **"Settings"** (⚙️) in the bottom navigation
3. Enter your Supabase details:
   - **Supabase Project URL**: Same URL from Step 1.4
   - **Supabase Anon Key**: Same key from Step 1.4
4. Tap **"Save & Test Connection"**
5. It will sync your items from the cloud — you should see all the posts the
   Chrome extension uploaded!

---

## PART 4: Importing Your Full History (CSV)

Reddit only lets you access your most recent ~1,000 saved items via its API.
To get your complete history, you need to request your data file from Reddit.

### Step 4.1 — Request Your Reddit Data

1. On your computer, go to **https://www.reddit.com/settings/data-request**
2. You may need to go to **Settings → Privacy & Security → Request data**
3. Click **"Request data"** or **"Request archive"**
4. Reddit will email you when it's ready (usually a few hours, sometimes up to 24h)

### Step 4.2 — Import the CSV

1. When you get the email, download the zip file
2. Unzip it (double-click on Mac)
3. Look for a file called **`saved_posts.csv`** (it may be in a subfolder)
4. Open the **RedditVault** web app on your Mac at your Vercel URL
   *(Use any browser on desktop for the import)*
5. Tap **"Import"** in the bottom navigation
6. Tap the import zone and select your `saved_posts.csv` file
7. The app will process it and add everything to your local database
8. It will also push new items to Supabase automatically if you're configured

---

## PART 5: Ongoing Use

### Daily Workflow

- **When you want to sync recent Reddit saves:** Open Chrome on your Mac,
  click the RedditVault Sync extension icon, click "Sync Saved Items Now"
- **When you want to browse on your iPhone:** Open RedditVault from your home screen.
  Tap the "Sync" button (top right) to pull latest changes from the cloud.

### Organizing into Folders

1. Go to **"Folders"** tab in the app
2. Tap **"+ New"** to create a folder (pick a name and icon)
3. Go to **"All Saves"** and tap the 📁 icon on any item to assign it to a folder
4. Filter by folder using the pills at the top of "All Saves"

### Backing Up Your Data

- Go to **Settings** → **"⬇️ Export Backup JSON"**
- This downloads a complete backup of all your items and folders
- Keep this file somewhere safe (iCloud Drive, Google Drive, etc.)
- You can re-import it anytime using the Import screen

---

## Troubleshooting

### Extension says "Not logged in to Reddit"
→ Open a new Chrome tab, go to reddit.com, make sure you're logged in, try syncing again.

### Extension shows "Supabase error 401" or "403"
→ Your Supabase key may be wrong. Go to Supabase → Project Settings → API and
   re-copy the **anon/public** key (not the service_role key).

### Extension shows "Supabase error 400" or "column not found" (PGRST204)
→ Supabase's schema cache didn't pick up all the columns. Fix it in two steps:
1. Go to Supabase → **Project Settings → API** → scroll down → click **"Reload schema cache"**
2. If that doesn't work, go to **SQL Editor** and run:
   ```sql
   ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS post_created_at timestamptz;
   ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS permalink text;
   ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS author text;
   ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS score integer;
   ```
   Then reload the schema cache again, wait 30 seconds, and retry the sync.

### Extension fetches 0 items
→ Make sure you actually have saved items on Reddit. Go to
   reddit.com/user/me/saved to check.

### PWA says "Sync failed"
→ Check that you entered the Supabase URL and key correctly in Settings.
   The URL should end in `.supabase.co` with no trailing slash.

### iPhone app doesn't look like an app (shows browser UI)
→ You must open it in **Safari** specifically (not Chrome for iOS) and use
   "Add to Home Screen". Then always open it from the home screen icon,
   not from Safari's address bar.

### Items imported from CSV are missing titles
→ Reddit's CSV export sometimes has minimal data. The app will show the URL
   if the title is missing. You can still organize these items into folders.

### Sync is very slow
→ This is intentional. The extension waits 1 second between pages to avoid
   getting temporarily blocked by Reddit. For 1,000 items it takes about
   10-15 minutes total. You can leave the popup open and let it run.

---

## Privacy Notes

- Your Reddit credentials are **never stored or transmitted** by this app.
  The extension uses your browser's existing Reddit session (cookies), the same
  way you'd browse Reddit normally.
- Your Supabase database is private to you. The only people who can access it
  are those who have your Supabase URL and key.
- Keep your Supabase anon key private — treat it like a password.
- All data processing happens locally on your device or in your personal
  Supabase project. No data is sent to any third party.

---

*RedditVault is a personal tool, not affiliated with Reddit or Supabase.*
