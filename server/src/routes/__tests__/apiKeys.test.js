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
import apiKeysRoutes from '../apiKeys.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.ENCRYPTION_KEY = 'b'.repeat(64)

let app
let db
let tenantAId, userAId, tokenA
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

  // Tenant A
  tenantAId = nanoid()
  insertTenant.run(tenantAId, 'Tenant A', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  userAId = nanoid()
  insertUser.run(userAId, tenantAId, 'a@test.com', 'hash', 'owner')
  tokenA = generateAccessToken({ userId: userAId, tenantId: tenantAId, role: 'owner' })

  // Tenant B
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

  await app.register(apiKeysRoutes, { prefix: '/api-keys' })
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

describe('POST /api-keys', () => {
  it('creates an Anthropic key, returns 201 without key_encrypted in body', async () => {
    const res = await req('POST', '/api-keys', {
      token: tokenA,
      payload: { provider: 'anthropic', label: 'My Anthropic Key', key: 'sk-ant-test-key' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('id')
    expect(body).toHaveProperty('provider', 'anthropic')
    expect(body).toHaveProperty('label', 'My Anthropic Key')
    expect(body).not.toHaveProperty('key_encrypted')
    expect(body).not.toHaveProperty('key_iv')
  })

  it('creates an Ollama key (base_url, no key) → 201, key_encrypted is null in DB', async () => {
    const res = await req('POST', '/api-keys', {
      token: tokenA,
      payload: { provider: 'ollama', label: 'Local Ollama', base_url: 'http://localhost:11434' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).not.toHaveProperty('key_encrypted')

    // Verify the DB row has key_encrypted = null
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(body.id)
    expect(row.key_encrypted).toBeNull()
    expect(row.key_iv).toBeNull()
  })
})

describe('GET /api-keys', () => {
  it('returns only safe fields — never key_encrypted', async () => {
    const res = await req('GET', '/api-keys', { token: tokenA })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.body)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).not.toHaveProperty('key_encrypted')
      expect(row).not.toHaveProperty('key_iv')
      expect(row).not.toHaveProperty('oauth_access_token_encrypted')
      expect(row).not.toHaveProperty('oauth_refresh_token_encrypted')
    }
  })
})

describe('DELETE /api-keys/:id', () => {
  it('returns 403 when Tenant B tries to delete a key owned by Tenant A', async () => {
    // Create a key for Tenant A
    const createRes = await req('POST', '/api-keys', {
      token: tokenA,
      payload: { provider: 'anthropic', label: 'Delete target', key: 'sk-ant-delete-me' },
    })
    const { id } = JSON.parse(createRes.body)

    // Tenant B tries to delete it
    const delRes = await req('DELETE', `/api-keys/${id}`, { token: tokenB })
    expect(delRes.statusCode).toBe(403)

    // Row still exists
    const row = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)
    expect(row).not.toBeNull()
  })

  it('deletes the row when called by the owning tenant, returns 200', async () => {
    const createRes = await req('POST', '/api-keys', {
      token: tokenA,
      payload: { provider: 'anthropic', label: 'To be deleted', key: 'sk-ant-bye' },
    })
    const { id } = JSON.parse(createRes.body)

    const delRes = await req('DELETE', `/api-keys/${id}`, { token: tokenA })
    expect(delRes.statusCode).toBe(200)
    expect(JSON.parse(delRes.body).success).toBe(true)

    const row = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })
})
