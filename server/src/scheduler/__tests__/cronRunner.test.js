import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

const mocks = vi.hoisted(() => ({
  db: null,
  taskA: { destroy: vi.fn() },
  taskB: { destroy: vi.fn() },
  schedule: vi.fn(),
  validate: vi.fn(() => true),
  classify: vi.fn(),
  retrieve: vi.fn(),
  compose: vi.fn(),
  relay: vi.fn(),
  sanitise: vi.fn(),
  guard: vi.fn(),
  enforceScope: vi.fn(),
  score: vi.fn(),
  log: vi.fn(),
  record: vi.fn(),
}))

vi.mock('node-cron', () => ({
  default: {
    schedule: mocks.schedule,
    validate: mocks.validate,
  },
  schedule: mocks.schedule,
  validate: mocks.validate,
}))
vi.mock('../../db/client.js', () => ({
  getDb: () => mocks.db,
  default: () => mocks.db,
}))
vi.mock('../../core/classifier.js', () => ({ classify: mocks.classify }))
vi.mock('../../core/contextRetriever.js', () => ({ retrieve: mocks.retrieve }))
vi.mock('../../core/promptComposer.js', () => ({ compose: mocks.compose }))
vi.mock('../../core/modelRelay.js', () => ({ relay: mocks.relay }))
vi.mock('../../security/sanitiser.js', () => ({ sanitise: mocks.sanitise }))
vi.mock('../../security/guardLayer.js', () => ({ guard: mocks.guard }))
vi.mock('../../security/scopeEnforcer.js', () => ({ enforceScope: mocks.enforceScope }))
vi.mock('../../security/riskScorer.js', () => ({ score: mocks.score }))
vi.mock('../../audit/auditLogger.js', () => ({
  AUDIT_ACTIONS: { CRON_RUN: 'cron_run' },
  log: mocks.log,
}))
vi.mock('../../audit/traceRecorder.js', () => ({ record: mocks.record }))

const { registerJob, deregisterJob, loadAllJobs, __test } = await import('../cronRunner.js')

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
      // Migration fragments may be idempotent in tests.
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

function insertTenant(db) {
  const tenantId = nanoid()
  db.prepare('INSERT INTO tenants (id, name, plan, created_at) VALUES (?, ?, ?, ?)')
    .run(tenantId, 'Tenant', 'enterprise', Date.now())
  return tenantId
}

function insertUser(db, tenantId) {
  const userId = nanoid()
  db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, tenantId, `${userId}@test.com`, 'hash', 'owner')
  return userId
}

function insertAgent(db, tenantId, userId) {
  const agentId = nanoid()
  db.prepare(
    `INSERT INTO agents
      (id, tenant_id, name, purpose, model_provider, system_prompt, owner_type, owner_id, owner_chain, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, tenantId, 'Cron Agent', 'Scheduled work', 'anthropic', 'System', 'human', userId, '[]', Date.now())
  return agentId
}

function insertJob(db, tenantId, agentId, enabled = 1) {
  const jobId = nanoid()
  db.prepare(
    `INSERT INTO cron_jobs
      (id, tenant_id, agent_id, name, prompt, schedule, enabled, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, tenantId, agentId, 'Job', 'Run scheduled task', '* * * * *', enabled, Date.now(), Date.now())
  return jobId
}

function setupPipeline() {
  mocks.sanitise.mockReturnValue({ sanitised: 'Run scheduled task', flagged: false, patterns: [] })
  mocks.guard.mockReturnValue({ allowed: true, violation: null })
  mocks.classify.mockResolvedValue({ intent: 'general_chat' })
  mocks.retrieve.mockResolvedValue({ files: [{ id: 'ctx1', filename: 'a.md', content: '# A' }], excluded: [] })
  mocks.compose.mockReturnValue({
    messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Run scheduled task' }],
    estimatedTokens: 12,
    contextFilesUsed: ['ctx1'],
  })
  mocks.relay.mockResolvedValue({ content: 'Relay output', tokensUsed: { input: 10, output: 5, total: 15 } })
  mocks.enforceScope.mockReturnValue({ compliant: true, violation: null })
  mocks.score.mockReturnValue(7)
}

describe('cronRunner', () => {
  let db
  let tenantId
  let userId
  let agentId

  beforeEach(() => {
    db = createDb()
    mocks.db = db
    tenantId = insertTenant(db)
    userId = insertUser(db, tenantId)
    agentId = insertAgent(db, tenantId, userId)
    __test.activeTasks.clear()
    vi.clearAllMocks()
    mocks.schedule
      .mockReturnValueOnce(mocks.taskA)
      .mockReturnValue(mocks.taskB)
    setupPipeline()
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (db) db.close()
    mocks.db = null
    __test.activeTasks.clear()
  })

  it('registerJob with enabled job → cron.schedule called with correct expression', () => {
    registerJob({ id: 'job1', name: 'Job', schedule: '* * * * *', enabled: 1 })

    expect(mocks.schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function))
  })

  it('registerJob with enabled: 0 → cron.schedule NOT called', () => {
    registerJob({ id: 'job1', name: 'Job', schedule: '* * * * *', enabled: 0 })

    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('deregisterJob → task.destroy() called, removed from map', () => {
    registerJob({ id: 'job1', name: 'Job', schedule: '* * * * *', enabled: 1 })

    deregisterJob('job1')

    expect(mocks.taskA.destroy).toHaveBeenCalled()
    expect(__test.activeTasks.has('job1')).toBe(false)
  })

  it('registerJob called twice for same jobId → first task destroyed before second registered', () => {
    registerJob({ id: 'job1', name: 'Job', schedule: '* * * * *', enabled: 1 })
    registerJob({ id: 'job1', name: 'Job', schedule: '*/5 * * * *', enabled: 1 })

    expect(mocks.taskA.destroy).toHaveBeenCalled()
    expect(mocks.schedule).toHaveBeenCalledTimes(2)
    expect(__test.activeTasks.has('job1')).toBe(true)
  })

  it('runJob success → cron_runs row has status success, output matches relay mock', async () => {
    const jobId = insertJob(db, tenantId, agentId)

    await __test.runJob(jobId)

    const run = db.prepare('SELECT * FROM cron_runs WHERE cron_job_id = ?').get(jobId)
    expect(run.status).toBe('success')
    expect(run.output).toBe('Relay output')
    expect(run.tokens_used).toBe(15)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ cronRunId: run.id, riskScore: 7 }))
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'cron_run', userId }))
  })

  it('runJob failure (relay throws) → cron_runs row has status failed, server does not throw', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    mocks.relay.mockRejectedValue(new Error('provider failed'))

    await expect(__test.runJob(jobId)).resolves.toBeUndefined()

    const run = db.prepare('SELECT * FROM cron_runs WHERE cron_job_id = ?').get(jobId)
    expect(run.status).toBe('failed')
    expect(run.output).toBe('provider failed')
  })

  it('runJob when agent not found → run marked failed, no crash', async () => {
    const jobId = insertJob(db, tenantId, agentId)
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId)
    db.pragma('foreign_keys = ON')

    await expect(__test.runJob(jobId)).resolves.toBeUndefined()

    const run = db.prepare('SELECT * FROM cron_runs WHERE cron_job_id = ?').get(jobId)
    expect(run.status).toBe('failed')
    expect(run.output).toBe('Agent not found')
  })

  it('loadAllJobs → registers all enabled jobs, skips disabled ones', () => {
    const enabledA = insertJob(db, tenantId, agentId, 1)
    const enabledB = insertJob(db, tenantId, agentId, 1)
    insertJob(db, tenantId, agentId, 0)

    loadAllJobs()

    expect(mocks.schedule).toHaveBeenCalledTimes(2)
    expect(__test.activeTasks.has(enabledA)).toBe(true)
    expect(__test.activeTasks.has(enabledB)).toBe(true)
  })
})
