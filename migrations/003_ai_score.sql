-- AI fit scoring. New setups get this from schema.sql.
ALTER TABLE seen_jobs ADD COLUMN score INTEGER;      -- 1-10 fit against the CV
ALTER TABLE seen_jobs ADD COLUMN score_reason TEXT;
