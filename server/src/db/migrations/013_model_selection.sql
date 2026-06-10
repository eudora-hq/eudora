-- This repository's migration ledger applies each file exactly once. These
-- columns do not exist in migrations 001-012.
ALTER TABLE api_keys ADD COLUMN default_model TEXT;
ALTER TABLE agents ADD COLUMN model_override TEXT;
ALTER TABLE agents ADD COLUMN endpoint_url TEXT;
ALTER TABLE audit_log ADD COLUMN resolved_model TEXT;
