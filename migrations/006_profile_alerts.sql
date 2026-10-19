-- Results for other people (EXTRA_PROFILES). New setups get this from schema.sql.
CREATE TABLE IF NOT EXISTS profile_alerts (
  profile     TEXT NOT NULL,
  id          TEXT NOT NULL,
  fingerprint TEXT,
  score       INTEGER,
  scored_at   INTEGER NOT NULL,
  message     TEXT,
  url         TEXT,
  notified_at INTEGER,
  PRIMARY KEY (profile, id)
);
CREATE INDEX IF NOT EXISTS idx_profile_alerts_fingerprint ON profile_alerts (profile, fingerprint);
