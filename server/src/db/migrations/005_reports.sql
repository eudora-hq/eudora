CREATE TABLE IF NOT EXISTS compliance_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  date_from INTEGER NOT NULL,
  date_to INTEGER NOT NULL,
  report_hash TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  agent_id TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
