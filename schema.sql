CREATE TABLE IF NOT EXISTS seen_jobs (
  id          TEXT PRIMARY KEY,   -- "<source>:<site job id>"
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  company     TEXT,
  url         TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,   -- unix ms
  fingerprint TEXT,               -- normalised title+company (src/dedupe.ts)
  short_key   TEXT,               -- compact id for Telegram button callback data
  status      TEXT,               -- NULL | 'saved' | 'hidden'
  notified_at INTEGER,            -- unix ms when sent to Telegram
  score       INTEGER,            -- AI fit 1-10 against the CV (src/ai.ts)
  score_reason TEXT,
  salary      TEXT                -- pay with its basis, e.g. "... (advertised)" (src/salary.ts)
);

CREATE INDEX IF NOT EXISTS idx_seen_jobs_source ON seen_jobs (source);
CREATE INDEX IF NOT EXISTS idx_seen_jobs_fingerprint ON seen_jobs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_seen_jobs_short_key ON seen_jobs (short_key);
CREATE INDEX IF NOT EXISTS idx_seen_jobs_status ON seen_jobs (status);

-- Overrides set from Telegram (/add, /exclude, /pause ...). Missing keys fall
-- back to the vars in wrangler.jsonc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- LinkedIn jobs pushed from a PC (POST /linkedin, see pc/README.md). LinkedIn
-- blocks Cloudflare's IPs, so a PC fetches the search pages and the Worker
-- parses them here. Each run reads this like a feed; rows go once seen.
CREATE TABLE IF NOT EXISTS linkedin_inbox (
  id    TEXT PRIMARY KEY,   -- same as seen_jobs.id
  job   TEXT NOT NULL,      -- Job as JSON
  added INTEGER NOT NULL    -- unix ms
);

-- Results for other people (EXTRA_PROFILES in src/profile.ts, see src/extra.ts).
-- One row per job scored for them, so nothing is scored or sent twice. Matches
-- keep their Telegram message until it is sent.
CREATE TABLE IF NOT EXISTS profile_alerts (
  profile     TEXT NOT NULL,      -- ExtraProfile.key
  id          TEXT NOT NULL,      -- same as seen_jobs.id
  fingerprint TEXT,               -- src/dedupe.ts, to skip copies on other boards
  score       INTEGER,            -- AI fit 1-10 against their profile
  scored_at   INTEGER NOT NULL,   -- unix ms
  message     TEXT,               -- Telegram HTML for a match; NULL if below their threshold
  url         TEXT,
  notified_at INTEGER,            -- unix ms when sent
  PRIMARY KEY (profile, id)
);

CREATE INDEX IF NOT EXISTS idx_profile_alerts_fingerprint ON profile_alerts (profile, fingerprint);
