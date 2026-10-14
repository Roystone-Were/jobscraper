-- Pay shown in alerts (see src/salary.ts). New setups get this from schema.sql.
ALTER TABLE seen_jobs ADD COLUMN salary TEXT;
