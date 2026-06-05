ALTER TABLE agents ADD COLUMN scope_policy TEXT DEFAULT '{}';
-- status column already added in 003 but ensure it exists:
-- ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
