import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

vi.mock('../../scheduler/cronRunner.js', () => ({
  registerJob: vi.fn(),
  deregisterJob: vi.fn(),
}))

vi.mock('../../core/classifier.js', () => ({
  classify: vi.fn().mockResolvedValue({ intent: 'general_chat', confidence: 0.9 }),
}))

vi.mock('../../core/contextRetriever.js', () => ({
  retrieve: vi.fn().mockResolvedValue({ files: [], tokensEstimate: 0, excluded: [] }),
}))

vi.mock('../../core/promptComposer.js', () => ({
  compose: vi.fn().mockReturnValue({
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user message' },
    ],
    estimatedTokens: 20,
    contextFilesUsed: [],
  }),
}))

vi.mock('../../core/modelRelay.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    relay: vi.fn().mockResolvedValue({
      content: 'Tier matrix response',
      tokensUsed: { input: 10, output: 10, total: 20 },
    }),
  }
})

vi.mock('../../audit/auditLogger.ts', () => ({
  log: vi.fn(),
  AUDIT_ACTIONS: {
    CHAT_MESSAGE: 'chat_message',
    GUARD_BLOCK: 'guard_block',
    SCOPE_VIOLATION: 'scope_violation',
    INJECTION_DETECTED: 'injection_detected',
    CRON_RUN: 'cron_run',
  },
}))

vi.mock('../../audit/traceRecorder.js', () => ({
  record: vi.fn(),
}))

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import { seedFeatureFlags } from '../../billing/canAccess.js'
import { TIER_LIMITS } from '../../../../shared/constants/tierLimits.js'
import workflowsRoutes from '../workflows.js'
import cronRoutes from '../cron.js'
import contextRoutes from '../context.js'
import chatRoutes from '../chat.js'
import auditRoutes from '../audit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002 = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)

const PLANS = ['trial', 'starter', 'professional', 'enterprise']

function runSql(db, sql) {
  sql.split(';').map((stmt) => stmt.trim()).filter(Boolean).forEach((stmt) => {
    try {
      db.prepare(stmt).run()
    } catch {
      // Migration 002 may be applied after tests that already include columns.
    }
  })
}

function authHeader(token) {
  return { authorization: `Bearer ${token}` }
}

describe('tier enforcement route matrix', () => {
  let app
  let db
  let tenants

  beforeEach(async () => {
    process.env.SELF_HOSTED = 'false'
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runSql(db, migration001)
    runSql(db, migration002)

    tenants = Object.fromEntries(PLANS.map((plan) => [plan, seedTenant(plan)]))

    app = Fastify({ logger: false })
    app.decorate('db', db)
    app.addHook('preHandler', async (request, reply) => {
      await authenticate(request, reply)
      if (reply.sent) return
      await new Promise((res) => scopeToTenant(request, reply, res))
      if (reply.sent) return
      await new Promise((res) => checkTrialExpiry(request, reply, res))
    })

    await app.register(workflowsRoutes, { prefix: '/workflows' })
    await app.register(cronRoutes, { prefix: '/cron' })
    await app.register(contextRoutes, { prefix: '/context' })
    await app.register(chatRoutes, { prefix: '/chat' })
    await app.register(auditRoutes, { prefix: '/audit' })
    await app.ready()
  })

  afterEach(async () => {
    process.env.SELF_HOSTED = 'false'
    await app.close()
    db.close()
  })

  function seedTenant(plan) {
    const now = Date.now()
    const tenantId = nanoid()
    const userId = nanoid()
    const agentId = nanoid()

    db.prepare(
      'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      tenantId,
      `${plan} Tenant`,
      plan,
      plan === 'trial' ? now + 14 * 24 * 60 * 60 * 1000 : null,
      now
    )
    db.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, tenantId, `${plan}@test.com`, 'hash', 'owner')
    db.prepare(
      `INSERT INTO agents
        (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agentId, tenantId, `${plan} Agent`, 'Answer user requests', 'anthropic', 'human', userId, '[]', now)

    seedFeatureFlags(db, tenantId, plan)

    return {
      tenantId,
      userId,
      agentId,
      token: generateAccessToken({ userId, tenantId, role: 'owner' }),
    }
  }

  function seedAtLimit(plan, metric) {
    const limit = TIER_LIMITS[plan][metric]
    if (limit === Infinity) return
    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), tenants[plan].tenantId, metric, limit, Date.now())
  }

  async function postWorkflow(plan) {
    return app.inject({
      method: 'POST',
      url: '/workflows',
      headers: authHeader(tenants[plan].token),
      payload: {
        name: `${plan} workflow`,
        description: 'Tier matrix workflow',
        nodes: [],
        edges: [],
      },
    })
  }

  async function postCron(plan) {
    return app.inject({
      method: 'POST',
      url: '/cron',
      headers: authHeader(tenants[plan].token),
      payload: {
        agentId: tenants[plan].agentId,
        name: `${plan} cron`,
        prompt: 'Run scheduled task',
        schedule: '0 9 * * *',
      },
    })
  }

  async function postContext(plan) {
    return app.inject({
      method: 'POST',
      url: '/context',
      headers: authHeader(tenants[plan].token),
      payload: {
        agentId: tenants[plan].agentId,
        filename: `${plan}.md`,
        content: `Context for ${plan}`,
        tags: ['general'],
      },
    })
  }

  async function postChat(plan) {
    return app.inject({
      method: 'POST',
      url: '/chat',
      headers: authHeader(tenants[plan].token),
      payload: {
        agentId: tenants[plan].agentId,
        message: 'Hello',
      },
    })
  }

  async function getAuditExport(plan) {
    return app.inject({
      method: 'GET',
      url: '/audit/export',
      headers: authHeader(tenants[plan].token),
    })
  }

  it.each([
    ['trial', 403],
    ['starter', 403],
    ['professional', 201],
    ['enterprise', 201],
  ])('POST /workflows for %s → %i', async (plan, expectedStatus) => {
    const res = await postWorkflow(plan)
    expect(res.statusCode).toBe(expectedStatus)
  })

  it.each([
    ['trial', 403],
    ['starter', 403],
    ['professional', 403],
    ['enterprise', 201],
  ])('POST /cron at limit for %s → %i', async (plan, expectedStatus) => {
    seedAtLimit(plan, 'cron_jobs')
    const res = await postCron(plan)
    expect(res.statusCode).toBe(expectedStatus)
  })

  it.each([
    ['trial', 403],
    ['starter', 403],
    ['professional', 403],
    ['enterprise', 201],
  ])('POST /context at limit for %s → %i', async (plan, expectedStatus) => {
    seedAtLimit(plan, 'context_files')
    const res = await postContext(plan)
    expect(res.statusCode).toBe(expectedStatus)
  })

  it.each([
    ['trial', 429],
    ['starter', 429],
    ['professional', 429],
    ['enterprise', 200],
  ])('POST /chat at daily limit for %s → %i', async (plan, expectedStatus) => {
    seedAtLimit(plan, 'messages_per_day')
    const res = await postChat(plan)
    expect(res.statusCode).toBe(expectedStatus)
  })

  it.each([
    ['trial', 403],
    ['starter', 403],
    ['professional', 200],
    ['enterprise', 200],
  ])('GET /audit/export for %s → %i', async (plan, expectedStatus) => {
    const res = await getAuditExport(plan)
    expect(res.statusCode).toBe(expectedStatus)
  })

  it('SELF_HOSTED=true allows starter tenant to POST /workflows', async () => {
    process.env.SELF_HOSTED = 'true'

    const res = await postWorkflow('starter')

    expect(res.statusCode).toBe(201)
    process.env.SELF_HOSTED = 'false'
  })
})
