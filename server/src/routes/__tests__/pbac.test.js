import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = '0'.repeat(64)
process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import agentsRoutes from '../agents.js'
import chatRoutes from '../chat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(resolve(__dirname, '../../db/migrations/001_initial_schema.sql'), 'utf8')
const migration002 = readFileSync(resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'), 'utf8')
const migration003 = readFileSync(resolve(__dirname, '../../db/migrations/003_external_agents.sql'), 'utf8')
const migration004 = readFileSync(resolve(__dirname, '../../db/migrations/004_pbac.sql'), 'utf8')

let app, db, tenantId, userId, agentId, token

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migration001)
  db.exec(migration002)
  db.exec(migration003)
  db.exec(migration004)

  tenantId = nanoid()
  userId = nanoid()
  agentId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'PBAC Co', 'enterprise', null, Date.now())

  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'pbac@test.com', 'hash', 'owner')

  db.prepare(`
    INSERT INTO agents (
      id, tenant_id, name, purpose, model_provider, owner_type, owner_id,
      owner_chain, status, created_at
    )
    VALUES (?, ?, 'Draft Agent', 'testing PBAC', 'anthropic', 'human', ?, '[]', 'draft', ?)
  `).run(agentId, tenantId, userId, Date.now())

  token = generateAccessToken({ userId, tenantId, role: 'owner' })

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((resolveHook) => scopeToTenant(request, reply, resolveHook))
    if (reply.sent) return
    await new Promise((resolveHook) => checkTrialExpiry(request, reply, resolveHook))
  })

  await app.register(agentsRoutes, { prefix: '/agents' })
  await app.register(chatRoutes, { prefix: '/chat' })
  await app.ready()
})

afterEach(async () => {
  await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  if (app) await app.close()
  if (db) db.close()
})

function request(method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

async function waitForAuditAction(action) {
  for (let i = 0; i < 10; i++) {
    const row = db.prepare('SELECT * FROM audit_log WHERE action = ?').get(action)
    if (row) return row
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  return null
}

describe('PBAC agent approval', () => {
  it("agent with status 'draft' cannot be used in chat", async () => {
    const res = await request('POST', '/chat', {
      agentId,
      message: 'Hello',
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('agent_not_live')
  })

  it('POST /agents/:id/submit-for-approval changes status and creates audit entry', async () => {
    const res = await request('POST', `/agents/${agentId}/submit-for-approval`)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('pending_approval')
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId).status).toBe('pending_approval')

    const audit = await waitForAuditAction('agent_submitted_for_approval')
    expect(audit).toBeTruthy()
    expect(audit.initiated_by_user_id).toBe(userId)
  })

  it('POST /agents/:id/approve changes status to live and logs approver', async () => {
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('pending_approval', agentId)

    const res = await request('POST', `/agents/${agentId}/approve`)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('live')
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId).status).toBe('live')

    const audit = await waitForAuditAction('agent_approved')
    expect(audit).toBeTruthy()
    const metadata = JSON.parse(audit.metadata)
    expect(metadata.approvedBy).toBe(userId)
  })

  it('POST /agents/:id/approve when not pending returns 400', async () => {
    const res = await request('POST', `/agents/${agentId}/approve`)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('not_pending')
  })

  it('PATCH /agents/:id/scope-policy stores policy and GET /agents/:id returns it', async () => {
    const scopePolicy = {
      allowed: ['compliance', 'document_qa', 'code_review'],
      blocked: ['financial_advice', 'medical_advice', 'legal_advice'],
    }

    const patchRes = await request('PATCH', `/agents/${agentId}/scope-policy`, { scopePolicy })
    expect(patchRes.statusCode).toBe(200)
    expect(JSON.parse(patchRes.body).scopePolicy).toEqual(scopePolicy)

    const getRes = await request('GET', `/agents/${agentId}`)
    expect(getRes.statusCode).toBe(200)
    expect(JSON.parse(JSON.parse(getRes.body).scope_policy)).toEqual(scopePolicy)
  })
})
