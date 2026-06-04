import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../migrations/001_initial_schema.sql'),
  'utf8'
)

const TABLES = [
  'tenants',
  'users',
  'refresh_tokens',
  'api_keys',
  'agents',
  'context_files',
  'conversations',
  'messages',
  'cron_jobs',
  'cron_runs',
  'workflows',
  'workflow_runs',
  'audit_log',
  'traces',
  'usage_events',
  'feature_flags',
]

let db

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)
})

describe('schema migration', () => {
  it('creates all 16 tables', () => {
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(r => r.name)

    for (const table of TABLES) {
      expect(existing, `missing table: ${table}`).toContain(table)
    }
    expect(existing.filter(t => TABLES.includes(t))).toHaveLength(16)
  })

  it('agents table has owner_type, owner_id, owner_chain columns after migration 002', () => {
    // Run migration 002 SQL directly on the in-memory DB
    const migration002 = `
      ALTER TABLE agents ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'human';
      ALTER TABLE agents ADD COLUMN owner_id TEXT;
      ALTER TABLE agents ADD COLUMN owner_chain TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE audit_log ADD COLUMN initiated_by_user_id TEXT;
      ALTER TABLE audit_log ADD COLUMN agent_chain TEXT DEFAULT '[]';
    `
    // Run each statement separately (SQLite doesn't support multiple statements in one call)
    migration002.split(';').map(s => s.trim()).filter(Boolean).forEach(sql => {
      db.prepare(sql).run()
    })

    db.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('tenant1', 'Acme', 0)`)
    db.exec(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ('user1', 'tenant1', 'owner@acme.test', 'x')`)

    // Verify columns exist by doing a test insert
    expect(() => {
      db.prepare(`INSERT INTO agents
        (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
        VALUES ('test', 'tenant1', 'Test', 'Test purpose', 'anthropic', 'human', 'user1', '[]', 1234567890)
      `).run()
    }).not.toThrow()
  })

  it('allows INSERT into audit_log', () => {
    db.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)`)
    db.exec(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ('u1', 't1', 'a@b.com', 'x')`)

    expect(() => {
      db.prepare(`
        INSERT INTO audit_log (id, tenant_id, user_id, action, risk_score, ts)
        VALUES ('a1', 't1', 'u1', 'test', 0, 0)
      `).run()
    }).not.toThrow()
  })

  it('throws on UPDATE to audit_log with "append-only" in the message', () => {
    db.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)`)
    db.exec(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ('u1', 't1', 'a@b.com', 'x')`)
    db.prepare(`
      INSERT INTO audit_log (id, tenant_id, user_id, action, risk_score, ts)
      VALUES ('a1', 't1', 'u1', 'test', 0, 0)
    `).run()

    expect(() => {
      db.prepare(`UPDATE audit_log SET action = 'modified' WHERE id = 'a1'`).run()
    }).toThrowError(/append-only/)
  })

  it('throws on DELETE from audit_log with "append-only" in the message', () => {
    db.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)`)
    db.exec(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ('u1', 't1', 'a@b.com', 'x')`)
    db.prepare(`
      INSERT INTO audit_log (id, tenant_id, user_id, action, risk_score, ts)
      VALUES ('a1', 't1', 'u1', 'test', 0, 0)
    `).run()

    expect(() => {
      db.prepare(`DELETE FROM audit_log WHERE id = 'a1'`).run()
    }).toThrowError(/append-only/)
  })

  it('running the migration SQL twice does not throw (IF NOT EXISTS)', () => {
    expect(() => {
      db.exec(migrationSql)
    }).not.toThrow()
  })
})
