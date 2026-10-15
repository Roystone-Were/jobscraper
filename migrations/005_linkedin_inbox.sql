-- LinkedIn jobs pushed from a PC (POST /linkedin). New setups get this from schema.sql.
CREATE TABLE IF NOT EXISTS linkedin_inbox (
  id    TEXT PRIMARY KEY,
  job   TEXT NOT NULL,
  added INTEGER NOT NULL
);
