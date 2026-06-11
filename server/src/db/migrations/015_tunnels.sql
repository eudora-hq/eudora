CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tunnel_key TEXT NOT NULL UNIQUE,
  local_port INTEGER NOT NULL DEFAULT 11434,
  local_host TEXT NOT NULL DEFAULT '127.0.0.1',
  status TEXT NOT NULL DEFAULT 'inactive',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_tunnels_tenant ON tunnels(tenant_id);

ALTER TABLE api_keys ADD COLUMN tunnel_id TEXT REFERENCES tunnels(id) ON DELETE SET NULL;
