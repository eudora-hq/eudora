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
import { seedFeatureFlags } from '../../billing/canAccess.js'
import workflowsRoutes from '../workflows.js'

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.SELF_HOSTED = 'false'
process.env.JWT_EXPIRES_IN = '15m'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let app
let db
let soloToken
let teamToken

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  soloToken = seedTenant('solo')
  teamToken = seedTenant('team')

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
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  if (db) db.close()
})

function seedTenant(plan) {
  const now = Date.now()
  const tenantId = nanoid()
  const userId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, `${plan} Tenant`, plan, plan === 'trial' ? now + 14 * 24 * 60 * 60 * 1000 : null, now)
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, `${plan}@test.com`, 'hash', 'owner')
  seedFeatureFlags(db, tenantId, plan)

  return generateAccessToken({ userId, tenantId, role: 'owner' })
}

function postWorkflow(token) {
  return app.inject({
    method: 'POST',
    url: '/workflows',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'Review Workflow',
      description: 'Run the review chain',
      nodes: [{ id: 'n1', agentId: 'agent-1', label: 'Review', position: { x: 0, y: 0 } }],
      edges: [],
    },
  })
}

describe('POST /workflows', () => {
  it('returns 403 for a solo tenant', async () => {
    const res = await postWorkflow(soloToken)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('upgrade_required')
  })

  it('returns 201 and the created workflow for a team tenant', async () => {
    const res = await postWorkflow(teamToken)
    expect(res.statusCode).toBe(201)

    const body = JSON.parse(res.body)
    expect(body.name).toBe('Review Workflow')
    expect(body.nodes).toEqual([
      { id: 'n1', agentId: 'agent-1', label: 'Review', position: { x: 0, y: 0 } },
    ])
    expect(body.edges).toEqual([])
  })
})
