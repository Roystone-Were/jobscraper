-- Telegram buttons & commands. New setups get this from schema.sql.
ALTER TABLE seen_jobs ADD COLUMN short_key TEXT;     -- compact id for button callback data
ALTER TABLE seen_jobs ADD COLUMN status TEXT;        -- NULL | 'saved' | 'hidden'
ALTER TABLE seen_jobs ADD COLUMN notified_at INTEGER; -- unix ms when sent to Telegram
CREATE INDEX IF NOT EXISTS idx_seen_jobs_short_key ON seen_jobs (short_key);
CREATE INDEX IF NOT EXISTS idx_seen_jobs_status ON seen_jobs (status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
