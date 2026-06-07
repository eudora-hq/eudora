CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  invited_by TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_tenant ON invites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

ALTER TABLE users ADD COLUMN name TEXT;
