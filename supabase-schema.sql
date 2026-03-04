-- RedditVault — Supabase Schema
-- Run this entire block in Supabase SQL Editor → New Query → Run
-- If you already ran the previous schema, use the MIGRATION section at the bottom instead.

-- ─── FRESH INSTALL ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reddit_saves (
  id               bigserial PRIMARY KEY,
  reddit_id        text UNIQUE NOT NULL,        -- Reddit's internal ID (e.g. "t3_abc123")
  type             text DEFAULT 'post',         -- "post" or "comment"
  subreddit        text,                        -- subreddit name (without r/)
  title            text,                        -- post title (or parent post title for comments)
  url              text,                        -- destination URL (external for link posts, permalink for others)
  permalink        text,                        -- always the reddit.com/r/.../comments/... URL
  body             text,                        -- post selftext or comment body
  author           text,                        -- reddit username of the poster
  score            integer,                     -- upvote score at time of sync
  folder           text,                        -- user-assigned folder name (null = unfiled)
  saved_at         timestamptz,                 -- when you synced/imported (proxy for save time)
  post_created_at  timestamptz,                 -- when the Reddit post/comment was originally made ← NEW
  created_at       timestamptz DEFAULT now(),   -- when this row was inserted into our DB
  updated_at       timestamptz DEFAULT now()    -- when this row was last modified
);

CREATE TABLE IF NOT EXISTS reddit_folders (
  id          bigserial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  icon        text DEFAULT '📁',
  created_at  timestamptz DEFAULT now()
);

-- Row Level Security (lets the app read/write without complex auth)
ALTER TABLE reddit_saves   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reddit_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON reddit_saves   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON reddit_folders FOR ALL USING (true) WITH CHECK (true);

-- Indexes for fast filtering and searching
CREATE INDEX IF NOT EXISTS idx_reddit_saves_folder        ON reddit_saves(folder);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_saved_at      ON reddit_saves(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_post_created  ON reddit_saves(post_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_type          ON reddit_saves(type);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_subreddit     ON reddit_saves(subreddit);


-- ─── MIGRATION (only needed if you already ran the OLD schema) ─────────────────
-- If you set up the database before and are updating to the new version,
-- run ONLY this section (not the CREATE TABLE above):
--
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS post_created_at timestamptz;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS permalink text;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS author text;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS score integer;
-- CREATE INDEX IF NOT EXISTS idx_reddit_saves_post_created ON reddit_saves(post_created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_reddit_saves_subreddit    ON reddit_saves(subreddit);

