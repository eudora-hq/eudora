-- Add external agent support to agents table
ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE agents ADD COLUMN proxy_key_encrypted TEXT;
ALTER TABLE agents ADD COLUMN proxy_key_iv TEXT;
ALTER TABLE agents ADD COLUMN proxy_key_prefix TEXT;
ALTER TABLE agents ADD COLUMN provider_hint TEXT;
ALTER TABLE agents ADD COLUMN interception_mode TEXT NOT NULL DEFAULT 'observe';
ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
