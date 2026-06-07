import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import adminRoutes from '../admin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrations = [
  '001_initial_schema.sql',
  '002_agent_ownership.sql',
  '003_external_agents.sql',
  '006_invites.sql',
].map(file => readFileSync(
  resolve(__dirname, `../../db/migrations/${file}`),
  'utf8'
))

let app
let db
let trialTenantId
let paidTenantId
let trialUserId
let paidUserId

beforeEach(async () => {
  process.env.ADMIN_SECRET = 'test-admin-secret'
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrations.forEach(sql => db.exec(sql))

  const now = Date.now()
  trialTenantId = nanoid()
  paidTenantId = nanoid()
  trialUserId = nanoid()
  paidUserId = nanoid()

  db.prepare(`
    INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
    VALUES (?, 'Trial Bank', 'trial', ?, ?)
  `).run(
    trialTenantId,
    now + 3 * 24 * 60 * 60 * 1000,
    now - 2 * 24 * 60 * 60 * 1000
  )
  db.prepare(`
    INSERT INTO tenants (id, name, plan, created_at, stripe_customer_id)
    VALUES (?, 'Paid Bank', 'professional', ?, 'cus_test')
  `).run(paidTenantId, now - 10 * 24 * 60 * 60 * 1000)
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, name, password_hash, role)
    VALUES (?, ?, 'trial@example.com', 'Trial Owner', 'hash', 'owner')
  `).run(trialUserId, trialTenantId)
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, name, password_hash, role)
    VALUES (?, ?, 'paid@example.com', 'Paid Owner', 'hash', 'owner')
  `).run(paidUserId, paidTenantId)
  db.prepare(`
    INSERT INTO agents (
      id, tenant_id, name, purpose, model_provider, agent_type, created_at
    )
    VALUES (?, ?, 'Risk Agent', 'Compliance', 'openai', 'internal', ?)
  `).run(nanoid(), paidTenantId, now)

  const insertAudit = db.prepare(`
    INSERT INTO audit_log (
      id, tenant_id, user_id, action, risk_score, metadata, ts
    )
    VALUES (?, ?, ?, ?, ?, '{}', ?)
  `)
  insertAudit.run(nanoid(), paidTenantId, paidUserId, 'chat_message', 10, now)
  insertAudit.run(nanoid(), paidTenantId, paidUserId, 'dlp_detected', 90, now)
  insertAudit.run(nanoid(), paidTenantId, paidUserId, 'guard_block', 80, now)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.ready()
})

afterEach(async () => {
  delete process.env.ADMIN_SECRET
  if (app) await app.close()
  if (db) db.close()
})

function request(method, url, options = {}) {
  return app.inject({
    method,
    url,
    headers: options.authorized === false
      ? {}
      : { 'x-admin-key': 'test-admin-secret' },
    payload: options.payload,
  })
}

describe('admin routes', () => {
  it('rejects every admin endpoint without the admin secret', async () => {
    const endpoints = [
      ['GET', '/admin/overview'],
      ['GET', '/admin/tenants'],
      ['GET', `/admin/tenants/${paidTenantId}`],
      ['PATCH', `/admin/tenants/${paidTenantId}/plan`],
      ['GET', '/admin/revenue'],
      ['GET', '/admin/portal'],
    ]

    for (const [method, url] of endpoints) {
      const response = await request(method, url, {
        authorized: false,
        payload: method === 'PATCH' ? { plan: 'enterprise' } : undefined,
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('returns platform overview metrics', async () => {
    const response = await request('GET', '/admin/overview')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      totalTenants: 2,
      mrr: 399,
      activeLast30d: 1,
      trialExpiringSoon: 1,
      totalAuditEvents: 3,
    })
    expect(response.json().dailySignups.length).toBeGreaterThan(0)
  })

  it('lists tenants with plan filtering and usage details', async () => {
    const response = await request(
      'GET',
      '/admin/tenants?plan=professional&limit=10&offset=0'
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
    })
    expect(response.json().tenants[0]).toMatchObject({
      id: paidTenantId,
      owner_email: 'paid@example.com',
      seat_count: 1,
      agent_count: 1,
      total_events: 3,
      events_30d: 3,
    })
  })

  it('returns a tenant detail with users, agents, and audit statistics', async () => {
    const response = await request('GET', `/admin/tenants/${paidTenantId}`)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tenant: { id: paidTenantId, plan: 'professional' },
      auditStats: {
        total: 3,
        last30d: 3,
        risk_events: 2,
        dlp_events: 1,
        blocked: 1,
      },
    })
    expect(response.json().users).toHaveLength(1)
    expect(response.json().agents).toHaveLength(1)
  })

  it('changes a tenant plan and reseeds feature flags', async () => {
    const response = await request(
      'PATCH',
      `/admin/tenants/${trialTenantId}/plan`,
      { payload: { plan: 'enterprise' } }
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ updated: true, plan: 'enterprise' })
    expect(
      db.prepare('SELECT plan FROM tenants WHERE id = ?').get(trialTenantId).plan
    ).toBe('enterprise')
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM feature_flags WHERE tenant_id = ?')
        .get(trialTenantId).count
    ).toBeGreaterThan(0)
  })

  it('returns revenue metrics', async () => {
    const response = await request('GET', '/admin/revenue')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      mrr: 399,
      arr: 4788,
      byPlan: [{ plan: 'professional', count: 1 }],
    })
  })

  it('serves the standalone portal with a valid query key', async () => {
    const response = await request(
      'GET',
      '/admin/portal?key=test-admin-secret',
      { authorized: false }
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Eudora Admin')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})
