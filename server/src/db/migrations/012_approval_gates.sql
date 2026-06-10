CREATE TABLE IF NOT EXISTS approval_gates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT NOT NULL,
  workflow_id TEXT REFERENCES workflows(id),
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  risk_score INTEGER,
  risk_reason TEXT,
  agent_prompt TEXT,
  agent_response_draft TEXT,
  required_approvers INTEGER DEFAULT 1,
  current_approvals INTEGER DEFAULT 0,
  timeout_minutes INTEGER DEFAULT 60,
  on_timeout TEXT NOT NULL DEFAULT 'reject',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES approval_gates(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  approver_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS approval_gate_approvers (
  gate_id TEXT NOT NULL REFERENCES approval_gates(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  notified_at TEXT,
  reminded_at TEXT,
  PRIMARY KEY (gate_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_gates_tenant_status
  ON approval_gates(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_approval_gates_expires
  ON approval_gates(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_gate
  ON approval_decisions(gate_id, tenant_id);
