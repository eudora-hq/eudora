import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

const stripeMocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  constructEvent: vi.fn(),
}))

vi.mock('stripe', () => {
  function MockStripe() {
    this.checkout = { sessions: { create: stripeMocks.checkoutCreate } }
    this.billingPortal = { sessions: { create: stripeMocks.portalCreate } }
    this.webhooks = { constructEvent: stripeMocks.constructEvent }
  }
  return { default: MockStripe }
})

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import { seedFeatureFlags } from '../../billing/canAccess.js'
import billingRoutes from '../billing.js'

process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock'
process.env.STRIPE_PRICE_SOLO = 'price_solo'
process.env.STRIPE_PRICE_TEAM = 'price_team'
process.env.STRIPE_PRICE_PRO = 'price_pro'
process.env.CLIENT_URL = 'http://localhost:5173'

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
      // Ignore duplicate migration statements in tests.
    }
  })
}

async function createApp(db) {
  const app = Fastify({ logger: false })
  app.decorate('db', db)
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.url.split('?')[0] === '/billing/webhook') {
        done(null, body)
        return
      }
      try {
        done(null, JSON.parse(body.toString()))
      } catch (err) {
        done(err)
      }
    }
  )
  app.addHook('preHandler', async (request, reply) => {
    const key = `${request.method} ${request.url.split('?')[0]}`
    if (key === 'POST /billing/webhook') return

    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((res) => scopeToTenant(request, reply, res))
    if (reply.sent) return
    await new Promise((res) => checkTrialExpiry(request, reply, res))
  })
  await app.register(billingRoutes, { prefix: '/billing' })
  await app.ready()
  return app
}

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runSql(db, migration001)
  runSql(db, migration002)
  return db
}

function seedTenant(db, { plan = 'trial', stripeCustomerId = null } = {}) {
  const tenantId = nanoid()
  const userId = nanoid()
  const now = Date.now()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at, stripe_customer_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    tenantId,
    `${plan} Tenant`,
    plan,
    plan === 'trial' ? now + 14 * 24 * 60 * 60 * 1000 : null,
    now,
    stripeCustomerId
  )
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, `${userId}@test.com`, 'hash', 'owner')
  seedFeatureFlags(db, tenantId, plan)
  return {
    tenantId,
    userId,
    token: generateAccessToken({ userId, tenantId, role: 'owner' }),
  }
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

describe('billing routes', () => {
  let app
  let db
  let tenant
  let subscribedTenant

  beforeEach(async () => {
    process.env.SELF_HOSTED = 'false'
    vi.clearAllMocks()
    stripeMocks.checkoutCreate.mockResolvedValue({
      url: 'https://checkout.stripe.com/test-session-url',
      id: 'cs_test_123',
    })
    stripeMocks.portalCreate.mockResolvedValue({
      url: 'https://billing.stripe.com/test-portal-url',
    })

    db = createDb()
    tenant = seedTenant(db, { plan: 'trial' })
    subscribedTenant = seedTenant(db, { plan: 'solo', stripeCustomerId: 'cus_test_123' })
    app = await createApp(db)
  })

  afterEach(async () => {
    process.env.SELF_HOSTED = 'false'
    await app.close()
    db.close()
  })

  it("POST /billing/checkout with valid plan 'solo' → 200, returns checkoutUrl", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: auth(tenant.token),
      payload: { plan: 'solo' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      checkoutUrl: 'https://checkout.stripe.com/test-session-url',
    })
    expect(stripeMocks.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: 'price_solo', quantity: 1 }],
      metadata: { tenantId: tenant.tenantId, plan: 'solo' },
    }))
  })

  it("POST /billing/checkout with invalid plan 'enterprise' → 400", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: auth(tenant.token),
      payload: { plan: 'enterprise' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /billing/checkout without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      payload: { plan: 'solo' },
    })

    expect(res.statusCode).toBe(401)
  })

  it('POST /billing/portal with tenant that has stripe_customer_id → 200, returns portalUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: auth(subscribedTenant.token),
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      portalUrl: 'https://billing.stripe.com/test-portal-url',
    })
    expect(stripeMocks.portalCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      return_url: 'http://localhost:5173/settings',
    })
  })

  it('POST /billing/portal with tenant that has no stripe_customer_id → 400 no_subscription', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: auth(tenant.token),
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('no_subscription')
  })

  it('webhook checkout.session.completed updates tenant plan, clears trial, stores customer ID', async () => {
    stripeMocks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenantId: tenant.tenantId, plan: 'solo' },
          customer: 'cus_checkout_123',
        },
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid',
      },
      payload: JSON.stringify({ type: 'checkout.session.completed' }),
    })

    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT plan, trial_ends_at, stripe_customer_id FROM tenants WHERE id = ?')
      .get(tenant.tenantId)
    expect(row.plan).toBe('solo')
    expect(row.trial_ends_at).toBeNull()
    expect(row.stripe_customer_id).toBe('cus_checkout_123')
  })

  it("webhook customer.subscription.deleted sets tenant to expired trial", async () => {
    stripeMocks.constructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_test_123' } },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid',
      },
      payload: JSON.stringify({ type: 'customer.subscription.deleted' }),
    })

    expect(res.statusCode).toBe(200)
    const row = db.prepare('SELECT plan, trial_ends_at FROM tenants WHERE id = ?')
      .get(subscribedTenant.tenantId)
    expect(row.plan).toBe('trial')
    expect(row.trial_ends_at).toBeLessThan(Date.now())
  })

  it('webhook with invalid signature → 400', async () => {
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature')
    })

    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid',
      },
      payload: JSON.stringify({ type: 'checkout.session.completed' }),
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Webhook signature verification failed')
  })
})
