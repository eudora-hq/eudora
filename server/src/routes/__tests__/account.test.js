import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import { encrypt } from '../../utils/encryption.js'
import accountRoutes from '../account.js'

process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002 = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)

function runSql(db, sql) {
  sql.split(';').map((stmt) => stmt.trim()).filter(Boolean).forEach((stmt) => {
    try {
      db.prepare(stmt).run()
    } catch {
      // Migration 002 can be re-run safely in tests; ignore duplicate-column errors.
    }
  })
}

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runSql(db, migration001)
  runSql(db, migration002)
  return db
}

async function createApp(db) {
  const app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((res) => scopeToTenant(request, reply, res))
    if (reply.sent) return
    await new Promise((res) => checkTrialExpiry(request, reply, res))
  })
  app.get('/protected', async () => ({ ok: true }))
  await app.register(accountRoutes, { prefix: '/account' })
  await app.ready()
  return app
}

function insertTenantBundle(db, { name, email, expired = false }) {
  const tenantId = nanoid()
  const userId = nanoid()
  const agentId = nanoid()
  const conversationId = nanoid()
  const messageId = nanoid()
  const contextId = nanoid()
  const jobId = nanoid()
  const now = Date.now()
  const { ciphertext, iv } = encrypt(`# ${name}\nTenant-owned context.`)

  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, name, 'trial', expired ? now - 1000 : now + 86400000, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, email, 'hash', 'owner')
  db.prepare(
    `INSERT INTO agents
      (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, tenantId, `${name} Agent`, `${name} purpose`, 'anthropic', 'human', userId, '[]', now)
  db.prepare(
    `INSERT INTO context_files
      (id, tenant_id, agent_id, filename, tags, content_encrypted, content_iv, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(contextId, tenantId, agentId, `${name}.md`, '["general"]', ciphertext, iv, now, now)
  db.prepare(
    'INSERT INTO conversations (id, tenant_id, agent_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(conversationId, tenantId, agentId, userId, now)
  db.prepare(
    'INSERT INTO messages (id, conversation_id, tenant_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(messageId, conversationId, tenantId, 'user', `${name} message`, now)
  db.prepare(
    `INSERT INTO cron_jobs
      (id, tenant_id, agent_id, name, prompt, schedule, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, tenantId, agentId, `${name} Job`, `${name} prompt`, '0 9 * * *', 1, now)
  db.prepare(
    `INSERT INTO audit_log
      (id, tenant_id, user_id, action, risk_score, metadata, ts, initiated_by_user_id, agent_chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(nanoid(), tenantId, userId, 'agent_created', 0, JSON.stringify({ marker: name }), now, userId, JSON.stringify([agentId]))

  return {
    tenantId,
    userId,
    token: generateAccessToken({ userId, tenantId, role: 'owner' }),
  }
}

function exportRequest(app, token) {
  return app.inject({
    method: 'GET',
    url: '/account/export',
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('account export route', () => {
  let app
  let db
  let tenantA
  let tenantB

  beforeEach(async () => {
    process.env.SELF_HOSTED = 'false'
    db = createDb()
    tenantA = insertTenantBundle(db, { name: 'TenantAlphaSecret', email: 'alpha@example.com' })
    tenantB = insertTenantBundle(db, { name: 'TenantBetaExport', email: 'beta@example.com' })
    app = await createApp(db)
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('GET /account/export with valid token → 200, Content-Type is application/zip', async () => {
    const res = await exportRequest(app, tenantA.token)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/zip')
    expect(res.headers['content-disposition']).toContain('eudora-export.zip')
  })

  it('GET /account/export — response is a non-empty buffer', async () => {
    const res = await exportRequest(app, tenantA.token)
    const buffer = res.rawPayload

    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('GET /account/export from wrong tenant → cannot access other tenant data', async () => {
    const res = await exportRequest(app, tenantB.token)
    const exported = res.rawPayload.toString('utf8')

    expect(res.statusCode).toBe(200)
    expect(exported).toContain('TenantBetaExport')
    expect(exported).not.toContain('TenantAlphaSecret')
  })

  it('GET /account/export still works for expired trial tenants', async () => {
    const expiredTenant = insertTenantBundle(db, {
      name: 'ExpiredTenantExport',
      email: 'expired@example.com',
      expired: true,
    })

    const res = await exportRequest(app, expiredTenant.token)

    expect(res.statusCode).toBe(200)
  })

  it('expired trial user gets 402 on protected non-export routes', async () => {
    const expiredTenant = insertTenantBundle(db, {
      name: 'ExpiredTenantBlocked',
      email: 'blocked@example.com',
      expired: true,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expiredTenant.token}` },
    })

    expect(res.statusCode).toBe(402)
    expect(JSON.parse(res.body)).toEqual({ error: 'trial_expired', upgradeUrl: '/billing' })
  })
})
