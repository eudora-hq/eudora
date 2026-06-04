import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
import contextRoutes from '../context.js'

process.env.ENCRYPTION_KEY = 'e'.repeat(64)
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let app
let db
let tenantAId, userAId, agentAId, tokenA
let tenantBId, userBId, tokenB

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
  const insertAgent = db.prepare(
    'INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )

  // Tenant A — active trial
  tenantAId = nanoid()
  insertTenant.run(tenantAId, 'Tenant A', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  userAId = nanoid()
  insertUser.run(userAId, tenantAId, 'a@test.com', 'hash', 'owner')
  agentAId = nanoid()
  insertAgent.run(agentAId, tenantAId, 'Agent A', 'general assistant', 'anthropic', Date.now())
  tokenA = generateAccessToken({ userId: userAId, tenantId: tenantAId, role: 'owner' })

  // Tenant B — active trial (for cross-tenant tests)
  tenantBId = nanoid()
  insertTenant.run(tenantBId, 'Tenant B', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  userBId = nanoid()
  insertUser.run(userBId, tenantBId, 'b@test.com', 'hash', 'owner')
  tokenB = generateAccessToken({ userId: userBId, tenantId: tenantBId, role: 'owner' })

  app = Fastify({ logger: false })
  app.decorate('db', db)

  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((res) => scopeToTenant(request, reply, res))
    if (reply.sent) return
    await new Promise((res) => checkTrialExpiry(request, reply, res))
  })

  await app.register(contextRoutes, { prefix: '/context' })
  await app.ready()
}, 30000)

afterAll(async () => {
  await app.close()
  db.close()
})

function req(method, url, { token, payload } = {}) {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  })
}

describe('POST /context', () => {
  it('creates a context file, returns 201 with no content_encrypted field', async () => {
    const res = await req('POST', '/context', {
      token: tokenA,
      payload: {
        agentId: agentAId,
        filename: 'guide.md',
        content: '# Guide\nThis is the content.',
        tags: ['docs', 'guide'],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('filename', 'guide.md')
    expect(body.tags).toEqual(['docs', 'guide'])
    expect(body).not.toHaveProperty('content_encrypted')
    expect(body).not.toHaveProperty('content')
    expect(body).not.toHaveProperty('content_iv')
  })

  it('DB stores encrypted content — not the raw string', async () => {
    const raw = '# Secret content that must be encrypted'
    const res = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'secret.md', content: raw },
    })
    const { id } = JSON.parse(res.body)
    const row = db.prepare('SELECT content_encrypted FROM context_files WHERE id = ?').get(id)
    expect(row.content_encrypted).not.toBe(raw)
    expect(typeof row.content_encrypted).toBe('string')
    expect(row.content_encrypted.length).toBeGreaterThan(0)
  })
})

describe('GET /context', () => {
  it('returns array with no content or content_encrypted fields', async () => {
    const res = await req('GET', `/context?agentId=${agentAId}`, { token: tokenA })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.body)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).not.toHaveProperty('content')
      expect(row).not.toHaveProperty('content_encrypted')
      expect(row).not.toHaveProperty('content_iv')
      expect(Array.isArray(row.tags)).toBe(true)
    }
  })
})

describe('GET /context/:id', () => {
  it('returns decrypted content matching what was uploaded', async () => {
    const originalContent = '# My Doc\nHello world from test'
    const createRes = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'fetch-test.md', content: originalContent },
    })
    const { id } = JSON.parse(createRes.body)

    const getRes = await req('GET', `/context/${id}`, { token: tokenA })
    expect(getRes.statusCode).toBe(200)
    const body = JSON.parse(getRes.body)
    expect(body.content).toBe(originalContent)
    expect(body).not.toHaveProperty('content_encrypted')
  })

  it('returns 403 when Tenant B tries to access Tenant A context file', async () => {
    const createRes = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'private.md', content: 'tenant A only' },
    })
    const { id } = JSON.parse(createRes.body)

    const getRes = await req('GET', `/context/${id}`, { token: tokenB })
    expect(getRes.statusCode).toBe(403)
  })
})

describe('PATCH /context/:id/tags', () => {
  it('updates tags and returns new tags', async () => {
    const createRes = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'taggable.md', content: 'content', tags: ['old'] },
    })
    const { id } = JSON.parse(createRes.body)

    const patchRes = await req('PATCH', `/context/${id}/tags`, {
      token: tokenA,
      payload: { tags: ['new', 'updated'] },
    })
    expect(patchRes.statusCode).toBe(200)
    const body = JSON.parse(patchRes.body)
    expect(body.tags).toEqual(['new', 'updated'])
    expect(body).toHaveProperty('updated_at')
  })
})

describe('DELETE /context/:id', () => {
  it('deletes the row and returns 200', async () => {
    const createRes = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'delete-me.md', content: 'bye' },
    })
    const { id } = JSON.parse(createRes.body)

    const delRes = await req('DELETE', `/context/${id}`, { token: tokenA })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.body).success).toBe(true)

    const row = db.prepare('SELECT id FROM context_files WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })
})

describe('limit enforcement', () => {
  it('returns 403 with limit_reached when at context_files limit', async () => {
    // trial plan limit is 50 — insert a single usage_event with value=50 to simulate being at limit
    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), tenantAId, 'context_files', 50, Date.now())

    const res = await req('POST', '/context', {
      token: tokenA,
      payload: { agentId: agentAId, filename: 'over-limit.md', content: 'blocked' },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('limit_reached')
    expect(body.upgradeUrl).toBe('/billing')

    // Clean up: remove the sentinel usage event so other tests aren't affected
    db.prepare("DELETE FROM usage_events WHERE tenant_id = ? AND value = 50").run(tenantAId)
  })
})
