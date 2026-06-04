import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { authenticate } from '../auth.js'
import { scopeToTenant } from '../tenantScope.js'
import { checkTrialExpiry } from '../trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

let app
let db
let tenantAId, tenantBId, expiredTenantId, paidTenantId
let tokenA, expiredToken, paidToken

beforeAll(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  const insertTenant = db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const insertUser = db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  )

  // Tenant A — active trial
  tenantAId = nanoid()
  insertTenant.run(tenantAId, 'Tenant A', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  const userAId = nanoid()
  insertUser.run(userAId, tenantAId, 'a@test.com', 'hash', 'owner')
  tokenA = generateAccessToken({ userId: userAId, tenantId: tenantAId, role: 'owner' })

  // Tenant B — active trial (used only to verify isolation)
  tenantBId = nanoid()
  insertTenant.run(tenantBId, 'Tenant B', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  const userBId = nanoid()
  insertUser.run(userBId, tenantBId, 'b@test.com', 'hash', 'owner')

  // Expired trial tenant
  expiredTenantId = nanoid()
  insertTenant.run(expiredTenantId, 'Expired Tenant', 'trial', Date.now() - 60_000, Date.now())
  const expiredUserId = nanoid()
  insertUser.run(expiredUserId, expiredTenantId, 'expired@test.com', 'hash', 'owner')
  expiredToken = generateAccessToken({ userId: expiredUserId, tenantId: expiredTenantId, role: 'owner' })

  // Paid plan tenant (trial_ends_at = null)
  paidTenantId = nanoid()
  insertTenant.run(paidTenantId, 'Paid Tenant', 'pro', null, Date.now())
  const paidUserId = nanoid()
  insertUser.run(paidUserId, paidTenantId, 'paid@test.com', 'hash', 'owner')
  paidToken = generateAccessToken({ userId: paidUserId, tenantId: paidTenantId, role: 'owner' })

  app = Fastify({ logger: false })
  app.decorate('db', db)

  // Replicate the same middleware chain used in index.js
  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((res) => scopeToTenant(request, reply, res))
    if (reply.sent) return
    await new Promise((res) => checkTrialExpiry(request, reply, res))
  })

  // Echo route: exposes request.tenantId set by middleware (never request body/query)
  app.get('/echo', async (request) => ({
    tenantId: request.tenantId,
    plan: request.tenant?.plan,
  }))

  // POST echo: body may contain an arbitrary tenantId — middleware must ignore it
  app.post('/echo', async (request) => ({
    tenantId: request.tenantId,
    bodyTenantId: request.body?.tenantId ?? null,
  }))

  await app.ready()
}, 30000)

afterAll(async () => {
  await app.close()
  db.close()
})

describe('scopeToTenant — tenant isolation', () => {
  it("Tenant A's JWT always sets request.tenantId to Tenant A's ID", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tenantId).toBe(tenantAId)
  })

  it('request.tenantId is not overridable via query params', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/echo?tenantId=${tenantBId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.tenantId).toBe(tenantAId)
    expect(body.tenantId).not.toBe(tenantBId)
  })

  it('request.tenantId is not overridable via request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { tenantId: tenantBId },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    // body.tenantId (from middleware) must be Tenant A, not Tenant B
    expect(body.tenantId).toBe(tenantAId)
    expect(body.bodyTenantId).toBe(tenantBId) // body value unaffected
    expect(body.tenantId).not.toBe(body.bodyTenantId)
  })
})

describe('checkTrialExpiry', () => {
  it('expired trial tenant gets 402 on a protected route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { authorization: `Bearer ${expiredToken}` },
    })
    expect(res.statusCode).toBe(402)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('trial_expired')
    expect(body.upgradeUrl).toBe('/billing')
  })

  it('active trial tenant with trial_ends_at in the future passes through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).plan).toBe('trial')
  })

  it('paid plan tenant with null trial_ends_at passes through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { authorization: `Bearer ${paidToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).plan).toBe('pro')
  })
})
