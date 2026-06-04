import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = 'f'.repeat(64)

vi.mock('../../security/sanitiser.js', () => ({
  sanitise: vi.fn((input) => ({ sanitised: input, flagged: false, patterns: [] })),
}))
vi.mock('../../security/guardLayer.js', () => ({
  guard: vi.fn(() => ({ allowed: true, violation: null })),
}))
vi.mock('../../security/scopeEnforcer.js', () => ({
  enforceScope: vi.fn(() => ({ compliant: true, violation: null })),
}))
vi.mock('../../core/contextRetriever.js', () => ({
  retrieve: vi.fn().mockResolvedValue({ files: [], tokensEstimate: 0, excluded: [] }),
}))
vi.mock('../../audit/auditLogger.js', () => ({
  log: vi.fn(),
  AUDIT_ACTIONS: { WORKFLOW_RUN: 'workflow_run', CHAT_MESSAGE: 'chat_message' },
}))
vi.mock('../../core/modelRelay.js', () => ({
  relay: vi.fn(async (composed) => {
    const input = composed.messages[1].content
    return {
      content: `output for ${input}`,
      tokensUsed: { input: 10, output: 5, total: 15 },
    }
  }),
}))

import { relay } from '../../core/modelRelay.js'
import { executeWorkflow } from '../executionEngine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)

let db
let tenantId
let workflowId
let runId
let agentIds

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)
  db.exec(migration002Sql)

  tenantId = nanoid()
  const userId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'Workflow Tenant', 'team', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'workflow@test.com', 'hash', 'owner')

  agentIds = [nanoid(), nanoid(), nanoid()]
  const insertAgent = db.prepare(
    'INSERT INTO agents (id, tenant_id, name, purpose, model_provider, system_prompt, owner_type, owner_id, owner_chain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  agentIds.forEach((id, index) => {
    insertAgent.run(id, tenantId, `Agent ${index + 1}`, 'Execute workflow task', 'openai', `System ${index + 1}`, 'human', userId, '[]', Date.now())
  })

  workflowId = nanoid()
  runId = nanoid()
})

afterEach(() => {
  vi.clearAllMocks()
  if (db) db.close()
})

function createWorkflow({ edges }) {
  const nodes = agentIds.map((agentId, index) => ({
    id: `n${index + 1}`,
    agentId,
    label: `Node ${index + 1}`,
    position: { x: index * 100, y: 0 },
  }))

  db.prepare(
    `INSERT INTO workflows (id, tenant_id, name, description, nodes, edges, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workflowId,
    tenantId,
    'Workflow',
    'Start prompt',
    JSON.stringify(nodes),
    JSON.stringify(edges),
    Date.now(),
    Date.now()
  )

  db.prepare(
    `INSERT INTO workflow_runs (id, tenant_id, workflow_id, status, trigger, node_results, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, tenantId, workflowId, 'running', 'manual', '[]', Date.now())
}

function latestResults() {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId)
  return JSON.parse(row.node_results)
}

describe('executeWorkflow', () => {
  it('executes a 3-node linear workflow in topological order', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults().map(result => result.nodeId)).toEqual(['n1', 'n2', 'n3'])
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status).toBe('success')
  })

  it('uses Node 1 output as input to Node 2', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(relay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'output for Start prompt' }),
        ]),
      }),
      null,
      tenantId
    )
  })

  it('skips Node 3 when Node 2 output does not contain the condition string', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', condition: 'APPROVED' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const results = latestResults()
    expect(results.find(result => result.nodeId === 'n3').status).toBe('skipped')
    expect(relay).toHaveBeenCalledTimes(2)
  })

  it('executes Node 3 when Node 2 output contains the condition string', async () => {
    relay.mockImplementation(async (composed) => {
      const input = composed.messages[1].content
      return {
        content: input.includes('output for Start prompt') ? 'APPROVED next step' : `output for ${input}`,
        tokensUsed: { input: 10, output: 5, total: 15 },
      }
    })

    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', condition: 'APPROVED' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const results = latestResults()
    expect(results.find(result => result.nodeId === 'n3').status).toBe('success')
    expect(relay).toHaveBeenCalledTimes(3)
  })
})
