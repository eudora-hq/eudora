import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { record } from '../traceRecorder.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

const tick = () => new Promise(r => setTimeout(r, 50))

let db
let tenantId
let conversationId

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  tenantId = nanoid()
  const userId = nanoid()
  const agentId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, created_at) VALUES (?, ?, ?, ?)'
  ).run(tenantId, 'Trace Tenant', 'trial', Date.now())

  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'trace@example.com', 'hash', 'owner', 0)

  db.prepare(
    'INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, tenantId, 'Test Agent', 'testing', 'anthropic', Date.now())

  conversationId = nanoid()
  db.prepare(
    'INSERT INTO conversations (id, tenant_id, agent_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(conversationId, tenantId, agentId, userId, Date.now())
})

afterAll(() => {
  db.close()
})

describe('traceRecorder', () => {
  it('inserts a row after a short delay (fire-and-forget)', async () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM traces').get().count
    record(
      {
        tenantId,
        conversationId,
        intent: 'coding',
        contextInjected: ['file1', 'file2'],
        tokensUsed: 150,
        durationMs: 342,
        riskScore: 0,
      },
      db
    )
    await tick()
    const after = db.prepare('SELECT COUNT(*) as count FROM traces').get().count
    expect(after).toBe(before + 1)
  })

  it('stores context_injected as JSON string that parses back to the original array', async () => {
    record(
      {
        tenantId,
        conversationId,
        intent: 'coding',
        contextInjected: ['file1', 'file2'],
        tokensUsed: 150,
        durationMs: 342,
        riskScore: 0,
      },
      db
    )
    await tick()
    const row = db.prepare('SELECT context_injected FROM traces ORDER BY ts DESC LIMIT 1').get()
    expect(typeof row.context_injected).toBe('string')
    expect(JSON.parse(row.context_injected)).toEqual(['file1', 'file2'])
  })

  it('does not throw when optional fields are missing', () => {
    expect(() => {
      record({ tenantId, intent: 'general', contextInjected: [], tokensUsed: 0, durationMs: 0, riskScore: 0 }, db)
    }).not.toThrow()
  })

  it('does not throw when data is invalid (fire-and-forget)', () => {
    expect(() => {
      record({ tenantId: 'nonexistent', intent: null, contextInjected: null, tokensUsed: null, durationMs: null, riskScore: null }, db)
    }).not.toThrow()
  })
})
