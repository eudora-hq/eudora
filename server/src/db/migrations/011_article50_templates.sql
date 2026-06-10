ALTER TABLE compliance_reports ADD COLUMN report_mode TEXT DEFAULT 'flagged';
UPDATE compliance_reports SET report_mode = 'flagged' WHERE report_mode IS NULL;

CREATE TABLE article50_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  interaction_timestamp TEXT NOT NULL,
  disclosure_made INTEGER NOT NULL DEFAULT 1,
  disclosure_method TEXT,
  output_summary TEXT,
  sector_template TEXT,
  regulation_refs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_article50_records_tenant
  ON article50_records(tenant_id, interaction_timestamp);
CREATE INDEX idx_article50_records_agent
  ON article50_records(tenant_id, agent_id);
