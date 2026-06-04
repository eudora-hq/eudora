-- Add ownership chain columns to agents table
ALTER TABLE agents ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'human';
ALTER TABLE agents ADD COLUMN owner_id TEXT;
ALTER TABLE agents ADD COLUMN owner_chain TEXT NOT NULL DEFAULT '[]';

-- Add human accountability columns to audit_log
-- Note: audit_log is append-only (no UPDATE/DELETE) but ALTER TABLE ADD COLUMN is fine
ALTER TABLE audit_log ADD COLUMN initiated_by_user_id TEXT;
ALTER TABLE audit_log ADD COLUMN agent_chain TEXT DEFAULT '[]';

-- Backfill existing agents: assign the tenant's owner user as the human owner
-- Each existing agent becomes owned directly by the tenant owner (human)
UPDATE agents SET
  owner_type = 'human',
  owner_id = (
    SELECT id FROM users
    WHERE tenant_id = agents.tenant_id
    AND role = 'owner'
    LIMIT 1
  ),
  owner_chain = '[]'
WHERE owner_type = 'human' AND owner_id IS NULL;

-- Add model_name to api_keys for Ollama and Custom providers
ALTER TABLE api_keys ADD COLUMN model_name TEXT;
