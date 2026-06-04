import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import cronParser from 'cron-parser'
import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import cronRoutes from '../cron.js'

process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

const schedulerMocks = vi.hoisted(() => ({
  registerJob: vi.fn(),
  deregisterJob: vi.fn(),
}))

vi.mock('../scheduler/cronRunner.js', () => schedulerMocks, { virtual: true })
vi.mock('../../scheduler/cronRunner.js', () => schedulerMocks, { virtual: true })

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
  await app.register(cronRoutes, { prefix: '/cron' })
  await app.ready()
  return app
}

function insertTenant(db, plan = 'solo') {
  const tenantId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'Tenant', plan, Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  return tenantId
}

function insertUser(db, tenantId) {
  const userId = nanoid()
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, `${userId}@test.com`, 'hash', 'owner')
  return userId
}

function insertAgent(db, tenantId, userId) {
  const agentId = nanoid()
  db.prepare(
    `INSERT INTO agents
      (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, tenantId, 'Test Agent', 'Does scheduled work', 'anthropic', 'human', userId, '[]', Date.now())
  return agentId
}

function insertJob(db, tenantId, agentId, overrides = {}) {
  const job = {
    id: nanoid(),
    name: 'History job',
    prompt: 'Run',
    schedule: '0 9 * * *',
    enabled: 1,
    created_at: Date.now(),
    next_run_at: Date.now(),
    ...overrides,
  }
  db.prepare(
    `INSERT INTO cron_jobs
      (id, tenant_id, agent_id, name, prompt, schedule, enabled, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    tenantId,
    agentId,
    job.name,
    job.prompt,
    job.schedule,
    job.enabled,
    job.created_at,
    job.next_run_at
  )
  return job.id
}

function insertRun(db, tenantId, jobId, overrides = {}) {
  const run = {
    id: nanoid(),
    status: 'success',
    output: 'Run output',
    tokens_used: 12,
    duration_ms: 34,
    risk_score: 5,
    started_at: Date.now(),
    completed_at: Date.now(),
    ...overrides,
  }
  db.prepare(
    `INSERT INTO cron_runs
      (id, tenant_id, cron_job_id, status, output, tokens_used, duration_ms, risk_score, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id,
    tenantId,
    jobId,
    run.status,
    run.output,
    run.tokens_used,
    run.duration_ms,
    run.risk_score,
    run.started_at,
    run.completed_at
  )
  return run.id
}

function authToken(userId, tenantId) {
  return generateAccessToken({ userId, tenantId, role: 'owner' })
}

function req(app, method, url, token, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

describe('cron routes', () => {
  let app
  let db
  let tenantId
  let userId
  let agentId
  let token

  beforeEach(async () => {
    vi.clearAllMocks()
    db = createDb()
    tenantId = insertTenant(db, 'solo')
    userId = insertUser(db, tenantId)
    agentId = insertAgent(db, tenantId, userId)
    token = authToken(userId, tenantId)
    app = await createApp(db)
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  it('POST /cron with valid data → 201, job in DB with correct next_run_at', async () => {
    const schedule = '0 9 * * *'
    const res = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Morning run',
      prompt: 'Summarise updates',
      schedule,
      preset: 'daily_9am',
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(body.id)
    expect(row).toBeTruthy()
    expect(row.next_run_at).toBe(body.next_run_at)
    expect(row.next_run_at).toBeGreaterThan(Date.now())
    expect(row.next_run_at).toBe(cronParser.parseExpression(schedule).next().getTime())
    expect(schedulerMocks.registerJob).toHaveBeenCalledWith(expect.objectContaining({ id: body.id }))
  })

  it('POST /cron with invalid cron expression "99 * * * *" → 400', async () => {
    const res = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Bad schedule',
      prompt: 'Run',
      schedule: '99 * * * *',
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('invalid_cron_expression')
    expect(body.message).toContain('Invalid schedule: "99 * * * *"')
  })

  it('POST /cron when at cron_jobs limit for solo plan → 403', async () => {
    const insertUsage = db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < 5; i++) {
      insertUsage.run(nanoid(), tenantId, 'cron_jobs', 1, Date.now())
    }

    const res = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Limit hit',
      prompt: 'Run',
      schedule: '0 * * * *',
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('limit_reached')
  })

  it('GET /cron → returns jobs with agent_name and last_run_status fields', async () => {
    const jobId = nanoid()
    db.prepare(
      `INSERT INTO cron_jobs
        (id, tenant_id, agent_id, name, prompt, schedule, enabled, created_at, last_run_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, tenantId, agentId, 'Daily', 'Run', '0 9 * * *', 1, Date.now(), Date.now(), Date.now())
    db.prepare(
      'INSERT INTO cron_runs (id, tenant_id, cron_job_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), tenantId, jobId, 'success', Date.now())

    const res = await req(app, 'GET', '/cron', token)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body[0]).toEqual(expect.objectContaining({
      id: jobId,
      agent_name: 'Test Agent',
      last_run_status: 'success',
    }))
  })

  it('PATCH /cron/:id with new schedule → updates next_run_at, calls deregisterJob + registerJob', async () => {
    const createRes = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Patch me',
      prompt: 'Run',
      schedule: '0 9 * * *',
    })
    const { id } = JSON.parse(createRes.body)
    vi.clearAllMocks()

    const res = await req(app, 'PATCH', `/cron/${id}`, token, {
      schedule: '0 10 * * *',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.schedule).toBe('0 10 * * *')
    expect(body.next_run_at).toBe(cronParser.parseExpression('0 10 * * *').next().getTime())
    expect(schedulerMocks.deregisterJob).toHaveBeenCalledWith(id)
    expect(schedulerMocks.registerJob).toHaveBeenCalledWith(expect.objectContaining({ id, schedule: '0 10 * * *' }))
  })

  it('PATCH /cron/:id with enabled: 0 → job disabled, deregisterJob called', async () => {
    const createRes = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Disable me',
      prompt: 'Run',
      schedule: '0 9 * * *',
    })
    const { id } = JSON.parse(createRes.body)
    vi.clearAllMocks()

    const res = await req(app, 'PATCH', `/cron/${id}`, token, { enabled: 0 })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).enabled).toBe(0)
    expect(schedulerMocks.deregisterJob).toHaveBeenCalledWith(id)
  })

  it('DELETE /cron/:id → 200, row deleted, deregisterJob called', async () => {
    const createRes = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Delete me',
      prompt: 'Run',
      schedule: '0 9 * * *',
    })
    const { id } = JSON.parse(createRes.body)
    vi.clearAllMocks()

    const res = await req(app, 'DELETE', `/cron/${id}`, token)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).success).toBe(true)
    expect(db.prepare('SELECT id FROM cron_jobs WHERE id = ?').get(id)).toBeUndefined()
    expect(schedulerMocks.deregisterJob).toHaveBeenCalledWith(id)
  })

  it('DELETE /cron/:id from wrong tenant → 403', async () => {
    const createRes = await req(app, 'POST', '/cron', token, {
      agentId,
      name: 'Wrong tenant',
      prompt: 'Run',
      schedule: '0 9 * * *',
    })
    const { id } = JSON.parse(createRes.body)
    const otherTenantId = insertTenant(db, 'solo')
    const otherUserId = insertUser(db, otherTenantId)
    const otherToken = authToken(otherUserId, otherTenantId)

    const res = await req(app, 'DELETE', `/cron/${id}`, otherToken)

    expect(res.statusCode).toBe(403)
  })

  it('GET /cron/:id/runs → returns paginated runs, output truncated to 200 chars', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    const longOutput = 'x'.repeat(250)
    insertRun(db, tenantId, jobId, { output: longOutput, started_at: 1000 })
    insertRun(db, tenantId, jobId, { output: 'second', started_at: 2000 })

    const res = await req(app, 'GET', `/cron/${jobId}/runs?page=1&limit=1`, token)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.total).toBe(2)
    expect(body.page).toBe(1)
    expect(body.pages).toBe(2)
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].truncatedOutput).toBe('second')

    const secondPage = await req(app, 'GET', `/cron/${jobId}/runs?page=2&limit=1`, token)
    const secondBody = JSON.parse(secondPage.body)
    expect(secondBody.runs[0].truncatedOutput).toBe(`${'x'.repeat(200)}...`)
  })

  it('GET /cron/:id/runs → output shorter than 200 chars returned as-is', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    insertRun(db, tenantId, jobId, { output: 'short output' })

    const res = await req(app, 'GET', `/cron/${jobId}/runs`, token)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).runs[0].truncatedOutput).toBe('short output')
  })

  it('GET /cron/:id/runs from wrong tenant → 403', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    const otherTenantId = insertTenant(db, 'solo')
    const otherUserId = insertUser(db, otherTenantId)
    const otherToken = authToken(otherUserId, otherTenantId)

    const res = await req(app, 'GET', `/cron/${jobId}/runs`, otherToken)

    expect(res.statusCode).toBe(403)
  })

  it('GET /cron/:id/runs/:runId → returns full untruncated output', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    const output = 'y'.repeat(260)
    const runId = insertRun(db, tenantId, jobId, { output })

    const res = await req(app, 'GET', `/cron/${jobId}/runs/${runId}`, token)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.run.output).toBe(output)
    expect(body.trace).toBeNull()
  })

  it('GET /cron/:id/runs/:runId with linked trace → trace data included in response', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    const runId = insertRun(db, tenantId, jobId)
    const traceId = nanoid()
    db.prepare(
      `INSERT INTO traces
        (id, tenant_id, cron_run_id, intent, context_injected, tokens_used, duration_ms, risk_score, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(traceId, tenantId, runId, 'coding', JSON.stringify(['file1', 'file2']), 33, 44, 12, 123456)

    const res = await req(app, 'GET', `/cron/${jobId}/runs/${runId}`, token)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.trace).toEqual({
      id: traceId,
      intent: 'coding',
      context_injected: ['file1', 'file2'],
      tokens_used: 33,
      duration_ms: 44,
      risk_score: 12,
      ts: 123456,
    })
  })
})
