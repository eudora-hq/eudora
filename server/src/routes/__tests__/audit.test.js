import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { generateAccessToken } from '../../utils/auth.js'
import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { seedFeatureFlags } from '../../billing/canAccess.js'
import auditRoutes from '../audit.js'
import { log } from '../../audit/auditLogger.ts'

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.SELF_HOSTED = 'false'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)
const migration013Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/013_model_selection.sql'),
  'utf8'
)
const migration016Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/016_audit_hmac.sql'),
  'utf8'
)
const migration017Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/017_audit_explanation.sql'),
  'utf8'
)

let app, db
let tenantId, userId, tokenA
let tenantBId, userBId, tokenB
let starterTenantId, starterUserId, starterToken
let professionalTenantId, professionalUserId, professionalToken
let professionalOldTs, professionalNewTs

beforeAll(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)
  db.exec(migration002Sql)
  db.exec(migration013Sql)
  db.exec(migration016Sql)
  db.exec(migration017Sql)

  const now = Date.now()

  // ── Tenant A ────────────────────────────────────────────────────────────────
  tenantId = nanoid()
  userId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'Audit Corp', 'trial', now + 14 * 24 * 60 * 60 * 1000, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'audit@test.com', 'hash', 'owner')
  tokenA = generateAccessToken({ userId, tenantId, role: 'owner' })
  seedFeatureFlags(db, tenantId, 'trial')

  // ── Tenant B (isolation test) ────────────────────────────────────────────────
  tenantBId = nanoid()
  userBId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantBId, 'Other Corp', 'trial', now + 14 * 24 * 60 * 60 * 1000, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userBId, tenantBId, 'other@test.com', 'hash', 'owner')
  tokenB = generateAccessToken({ userId: userBId, tenantId: tenantBId, role: 'owner' })
  seedFeatureFlags(db, tenantBId, 'trial')

  // ── Starter tenant (export forbidden) ──────────────────────────────────────────
  starterTenantId = nanoid()
  starterUserId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(starterTenantId, 'Starter Corp', 'starter', null, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(starterUserId, starterTenantId, 'starter@test.com', 'hash', 'owner')
  starterToken = generateAccessToken({ userId: starterUserId, tenantId: starterTenantId, role: 'owner' })
  seedFeatureFlags(db, starterTenantId, 'starter')

  // ── Professional tenant (export allowed) ─────────────────────────────────────────────
  professionalTenantId = nanoid()
  professionalUserId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(professionalTenantId, 'Professional Corp', 'professional', null, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(professionalUserId, professionalTenantId, 'professional@test.com', 'hash', 'owner')
  professionalToken = generateAccessToken({ userId: professionalUserId, tenantId: professionalTenantId, role: 'owner' })
  seedFeatureFlags(db, professionalTenantId, 'professional')

  // ── Insert 5 audit_log rows for Tenant A ────────────────────────────────────
  const insert = db.prepare(
    'INSERT INTO audit_log (id, tenant_id, user_id, action, risk_score, metadata, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  // 3 chat_message rows, risk_score 0
  for (let i = 0; i < 3; i++) {
    insert.run(nanoid(), tenantId, userId, 'chat_message', 0, '{}', now - i * 1000)
  }
  // 1 guard_block, risk_score 75
  insert.run(nanoid(), tenantId, userId, 'guard_block', 75, '{}', now - 4000)
  // 1 injection_detected, risk_score 40
  insert.run(nanoid(), tenantId, userId, 'injection_detected', 40, '{}', now - 5000)

  professionalOldTs = now - 10000
  professionalNewTs = now - 1000
  insert.run(nanoid(), professionalTenantId, professionalUserId, 'chat_message', 0, JSON.stringify({ marker: 'old' }), professionalOldTs)
  insert.run(nanoid(), professionalTenantId, professionalUserId, 'guard_block', 80, JSON.stringify({ marker: 'new' }), professionalNewTs)

  // ── App ─────────────────────────────────────────────────────────────────────
  app = Fastify({ logger: false })
  app.decorate('db', db)

  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise(res => scopeToTenant(request, reply, res))
    if (reply.sent) return
    await new Promise(res => checkTrialExpiry(request, reply, res))
  })

  await app.register(auditRoutes, { prefix: '/audit' })
  await app.ready()
}, 30000)

afterAll(async () => {
  process.env.SELF_HOSTED = 'false'
  delete process.env.AUDIT_HMAC_KEY
  await app.close()
  db.close()
})

function req(url, { token } = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

// ── GET /audit ────────────────────────────────────────────────────────────────

describe('GET /audit', () => {
  it('returns all 5 events for tenant, total = 5', async () => {
    const res = await req('/audit', { token: tokenA })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(5)
    expect(body.events).toHaveLength(5)
    expect(body.page).toBe(1)
    expect(body.events.every(event => event.explanation_code === 'allowed')).toBe(true)
  })

  it('filters by action=guard_block → 1 event', async () => {
    const res = await req('/audit?action=guard_block', { token: tokenA })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(1)
    expect(body.events[0].action).toBe('guard_block')
  })

  it('filters by minRiskScore=40 → 2 events (guard_block and injection_detected)', async () => {
    const res = await req('/audit?minRiskScore=40', { token: tokenA })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(2)
    expect(body.events.every(e => e.risk_score >= 40)).toBe(true)
  })

  it('paginates: page=1&limit=2 → 2 events, pages=3', async () => {
    const res = await req('/audit?page=1&limit=2', { token: tokenA })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.events).toHaveLength(2)
    expect(body.pages).toBe(3)
    expect(body.page).toBe(1)
  })

  it('tenant isolation: Tenant B sees 0 events from Tenant A data', async () => {
    const res = await req('/audit', { token: tokenB })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(0)
    expect(body.events).toHaveLength(0)
  })

  it('retention window: event older than 30 days not returned for trial tenant', async () => {
    // Get current visible count
    const beforeRes = await req('/audit', { token: tokenA })
    const visibleBefore = JSON.parse(beforeRes.body).total

    // Insert event 32 days old — outside 30-day trial retention window
    db.prepare(
      'INSERT INTO audit_log (id, tenant_id, user_id, action, risk_score, metadata, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      nanoid(), tenantId, userId, 'chat_message', 0, '{}',
      Date.now() - 32 * 24 * 60 * 60 * 1000
    )

    const afterRes = await req('/audit', { token: tokenA })
    // Visible count must not have increased — old event filtered by retention
    expect(JSON.parse(afterRes.body).total).toBe(visibleBefore)
  })
})

// ── GET /audit/export ─────────────────────────────────────────────────────────

describe('GET /audit/export', () => {
  it('GET /audit/export?format=json with starter tenant → 403 upgrade_required', async () => {
    const res = await req('/audit/export?format=json', { token: starterToken })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('upgrade_required')
  })

  it('GET /audit/export?format=json with professional tenant → 200, Content-Type application/json', async () => {
    const res = await req('/audit/export?format=json', { token: professionalToken })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['content-disposition']).toContain('eudora-audit.json')

    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    expect(body[0].metadata.marker).toBe('old')
  })

  it('GET /audit/export?format=csv with professional tenant → 200, Content-Type text/csv', async () => {
    const res = await req('/audit/export?format=csv', { token: professionalToken })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.body).toContain('id,action,risk_score,timestamp,user_id,metadata')
    expect(res.body).toContain('guard_block')
  })

  it('GET /audit/export?format=pdf with professional tenant → 200, Content-Type application/pdf', async () => {
    const res = await req('/audit/export?format=pdf', { token: professionalToken })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('GET /audit/export?format=json with dateFrom filter → only returns events after that timestamp', async () => {
    const res = await req(`/audit/export?format=json&dateFrom=${professionalOldTs + 1}`, { token: professionalToken })
    expect(res.statusCode).toBe(200)

    const body = JSON.parse(res.body)
    expect(body).toHaveLength(1)
    expect(body[0].ts).toBe(professionalNewTs)
    expect(body[0].metadata.marker).toBe('new')
  })

  it('GET /audit/export with SELF_HOSTED=true and starter tenant → 200', async () => {
    process.env.SELF_HOSTED = 'true'

    const res = await req('/audit/export?format=json', { token: starterToken })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    process.env.SELF_HOSTED = 'false'
  })
})

describe('GET /audit/:id/verify', () => {
  it('verifies a signed row', async () => {
    process.env.AUDIT_HMAC_KEY = 'cd'.repeat(32)
    log({
      tenantId,
      userId,
      action: 'chat_message',
      prompt: 'verify this row',
      metadata: { source: 'route-test' },
    }, db)
    await new Promise(resolve => setTimeout(resolve, 50))

    const row = db.prepare(
      'SELECT id FROM audit_log WHERE row_hmac IS NOT NULL ORDER BY ts DESC LIMIT 1'
    ).get()
    const res = await req(`/audit/${row.id}/verify`, { token: tokenA })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: row.id, verified: true })
    delete process.env.AUDIT_HMAC_KEY
  })

  it('reports when HMAC signing is not configured', async () => {
    delete process.env.AUDIT_HMAC_KEY
    const row = db.prepare(
      'SELECT id FROM audit_log WHERE tenant_id = ? ORDER BY ts DESC LIMIT 1'
    ).get(tenantId)
    const res = await req(`/audit/${row.id}/verify`, { token: tokenA })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      id: row.id,
      verified: null,
      reason: 'hmac_not_configured',
    })
  })

  it('does not expose another tenant audit row', async () => {
    const row = db.prepare(
      'SELECT id FROM audit_log WHERE tenant_id = ? LIMIT 1'
    ).get(tenantId)
    const res = await req(`/audit/${row.id}/verify`, { token: tokenB })

    expect(res.statusCode).toBe(404)
  })
})
