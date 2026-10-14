-- For databases created before cross-board dedupe. New setups get this from schema.sql.
ALTER TABLE seen_jobs ADD COLUMN fingerprint TEXT;
CREATE INDEX IF NOT EXISTS idx_seen_jobs_fingerprint ON seen_jobs (fingerprint);
