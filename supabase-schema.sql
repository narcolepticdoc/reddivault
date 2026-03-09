-- RedditVault — Supabase Schema
-- Run this entire block in Supabase SQL Editor → New Query → Run
-- This is the current schema for a fresh install.
-- If you are migrating an existing database, see the MIGRATION section at the bottom.

-- ─── FRESH INSTALL ────────────────────────────────────────────────────────────

-- Enable the moddatetime extension (auto-updates updated_at on row changes)
CREATE EXTENSION IF NOT EXISTS moddatetime;

-- Your saved Reddit posts and comments
CREATE TABLE IF NOT EXISTS reddit_saves (
  id                   bigserial PRIMARY KEY,
  reddit_id            text UNIQUE NOT NULL,      -- Reddit's internal ID (e.g. "t3_abc123")
  type                 text DEFAULT 'post',        -- "post" or "comment"
  subreddit            text,
  title                text,
  url                  text,
  permalink            text,                       -- always the reddit.com/r/.../comments/... URL
  body                 text,                       -- post selftext or comment body
  author               text,
  score                integer,
  saved_at             timestamptz,               -- when you saved/imported the item
  post_created_at      timestamptz,               -- when the Reddit post/comment was originally made
  enrich_status        text DEFAULT 'pending',     -- "pending" | "enriched" | "dead"
  is_favourite         boolean DEFAULT false,
  rating               integer,                   -- 1-5 stars, null = unrated
  is_disliked          boolean DEFAULT false,      -- trashed items
  deleted_at           timestamptz,               -- set when permanently deleted; null = active
  created_at           timestamptz DEFAULT now(), -- when this row was first inserted
  updated_at           timestamptz DEFAULT now()  -- auto-updated by trigger below
);

-- Your lists (static lists and smart lists / tags)
CREATE TABLE IF NOT EXISTS reddit_lists (
  id          bigserial PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  type        text DEFAULT 'static',              -- "static" | "smart"
  query       text DEFAULT '',                    -- search query for smart lists
  is_tag      boolean DEFAULT false,              -- true if this list is also a tag chip
  tag_name    text DEFAULT '',                    -- display name for the tag chip
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Many-to-many: which items belong to which lists
CREATE TABLE IF NOT EXISTS reddit_item_lists (
  id          bigserial PRIMARY KEY,
  reddit_id   text NOT NULL REFERENCES reddit_saves(reddit_id) ON DELETE CASCADE,
  list_name   text NOT NULL REFERENCES reddit_lists(name)      ON DELETE CASCADE,
  UNIQUE(reddit_id, list_name)
);

-- Key-value store for syncing settings across devices
CREATE TABLE IF NOT EXISTS user_preferences (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz DEFAULT now()
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- Allows the app to read/write using the anon key without complex auth.
-- Your data is still private -- only someone with your Supabase URL + anon key can access it.

ALTER TABLE reddit_saves      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reddit_lists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reddit_item_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON reddit_saves      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON reddit_lists      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON reddit_item_lists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON user_preferences  FOR ALL USING (true) WITH CHECK (true);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reddit_saves_saved_at      ON reddit_saves(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_post_created  ON reddit_saves(post_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_type          ON reddit_saves(type);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_subreddit     ON reddit_saves(subreddit);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_deleted       ON reddit_saves(deleted_at);
CREATE INDEX IF NOT EXISTS idx_reddit_saves_enrich        ON reddit_saves(enrich_status);

-- ─── AUTO-UPDATE TRIGGERS ─────────────────────────────────────────────────────
-- These keep updated_at current automatically whenever a row is modified.

CREATE OR REPLACE TRIGGER set_updated_at_saves
  BEFORE UPDATE ON reddit_saves
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

CREATE OR REPLACE TRIGGER set_updated_at_lists
  BEFORE UPDATE ON reddit_lists
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);


-- ─── MIGRATION (existing installs only) ───────────────────────────────────────
-- Only run this section if you already have a database from an earlier version.
-- Skip entirely for fresh installs.

-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS enrich_status   text DEFAULT 'pending';
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS is_favourite     boolean DEFAULT false;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS rating           integer;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS is_disliked      boolean DEFAULT false;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS post_created_at  timestamptz;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS permalink        text;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS author           text;
-- ALTER TABLE reddit_saves ADD COLUMN IF NOT EXISTS score            integer;
--
-- ALTER TABLE reddit_lists ADD COLUMN IF NOT EXISTS is_tag           boolean DEFAULT false;
-- ALTER TABLE reddit_lists ADD COLUMN IF NOT EXISTS tag_name         text DEFAULT '';
-- ALTER TABLE reddit_lists ADD COLUMN IF NOT EXISTS updated_at       timestamptz DEFAULT now();
--
-- CREATE EXTENSION IF NOT EXISTS moddatetime;
--
-- CREATE OR REPLACE TRIGGER set_updated_at_saves
--   BEFORE UPDATE ON reddit_saves
--   FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);
--
-- CREATE OR REPLACE TRIGGER set_updated_at_lists
--   BEFORE UPDATE ON reddit_lists
--   FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);
--
-- CREATE TABLE IF NOT EXISTS reddit_item_lists (
--   id        bigserial PRIMARY KEY,
--   reddit_id text NOT NULL REFERENCES reddit_saves(reddit_id) ON DELETE CASCADE,
--   list_name text NOT NULL REFERENCES reddit_lists(name)      ON DELETE CASCADE,
--   UNIQUE(reddit_id, list_name)
-- );
--
-- CREATE TABLE IF NOT EXISTS user_preferences (
--   key        text PRIMARY KEY,
--   value      text,
--   updated_at timestamptz DEFAULT now()
-- );
--
-- ALTER TABLE reddit_item_lists ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE user_preferences  ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all" ON reddit_item_lists FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "Allow all" ON user_preferences  FOR ALL USING (true) WITH CHECK (true);
--
-- -- If you had an old "folder" column instead of deleted_at, rename it:
-- -- ALTER TABLE reddit_saves RENAME COLUMN folder TO deleted_at;
-- -- ALTER TABLE reddit_saves ALTER COLUMN deleted_at TYPE timestamptz USING NULL;
