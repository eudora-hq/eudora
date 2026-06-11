import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { log, AUDIT_ACTIONS } from '../auditLogger.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)

// Wait long enough for setImmediate + synchronous DB write to complete
const tick = () => new Promise(r => setTimeout(r, 50))

let db
let tenantId
let userId

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)
  db.exec(migration002Sql)

  tenantId = nanoid()
  userId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, created_at) VALUES (?, ?, ?, ?)'
  ).run(tenantId, 'Test Tenant', 'trial', Date.now())

  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'test@example.com', 'hash', 'owner', 0)
})

afterAll(() => {
  db.close()
})

describe('auditLogger', () => {
  it('inserts a row after a short delay (fire-and-forget)', async () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count
    log({ tenantId, userId, action: AUDIT_ACTIONS.CHAT_MESSAGE, prompt: 'hello', riskScore: 0 }, db)
    await tick()
    const after = db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count
    expect(after).toBe(before + 1)
  })

  it('stores prompt_hash as 64-char hex string, not the raw prompt', async () => {
    log({ tenantId, userId, action: AUDIT_ACTIONS.CHAT_MESSAGE, prompt: 'hello world' }, db)
    await tick()
    const row = db.prepare(
      'SELECT prompt_hash FROM audit_log WHERE prompt_hash IS NOT NULL ORDER BY ts DESC LIMIT 1'
    ).get()
    expect(row.prompt_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.prompt_hash).not.toBe('hello world')
  })

  it('stores null context_hash when context is not provided', async () => {
    log({ tenantId, userId, action: AUDIT_ACTIONS.CHAT_MESSAGE }, db)
    await tick()
    const row = db.prepare('SELECT context_hash FROM audit_log ORDER BY ts DESC LIMIT 1').get()
    expect(row.context_hash).toBeNull()
  })

  it('UPDATE on audit_log row throws a DB constraint error', async () => {
    log({ tenantId, userId, action: AUDIT_ACTIONS.LOGIN }, db)
    await tick()
    const row = db.prepare('SELECT id FROM audit_log ORDER BY ts DESC LIMIT 1').get()
    expect(() => {
      db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('hacked', row.id)
    }).toThrow()
  })

  it('DELETE on audit_log row throws a DB constraint error', async () => {
    log({ tenantId, userId, action: AUDIT_ACTIONS.LOGOUT }, db)
    await tick()
    const row = db.prepare('SELECT id FROM audit_log ORDER BY ts DESC LIMIT 1').get()
    expect(() => {
      db.prepare('DELETE FROM audit_log WHERE id = ?').run(row.id)
    }).toThrow()
  })

  it('does not throw when tenantId is invalid/missing (fire-and-forget)', () => {
    expect(() => {
      log({ tenantId: 'nonexistent', userId: 'nonexistent', action: AUDIT_ACTIONS.CHAT_MESSAGE }, db)
    }).not.toThrow()
  })

  it('does not throw when DB has no audit_log table', () => {
    const emptyDb = new Database(':memory:')
    expect(() => {
      log({ tenantId, userId, action: AUDIT_ACTIONS.CHAT_MESSAGE }, emptyDb)
    }).not.toThrow()
    emptyDb.close()
  })
})
