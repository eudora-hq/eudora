import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

vi.mock('../../core/classifier.js', () => ({
  classify: vi.fn().mockResolvedValue({ intent: 'coding', confidence: 0.9 }),
}))

vi.mock('../../core/contextRetriever.js', () => ({
  retrieve: vi.fn().mockResolvedValue({ files: [], excluded: [] }),
}))

vi.mock('../../core/promptComposer.js', () => ({
  compose: vi.fn().mockReturnValue({
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user message' },
    ],
    contextFilesUsed: [],
  }),
}))

vi.mock('../../core/modelRelay.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    relay: vi.fn().mockResolvedValue({
      content: 'External agent response',
      tokensUsed: { input: 10, output: 5, total: 15 },
    }),
  }
})

vi.mock('../../security/sanitiser.js', () => ({
  sanitise: vi.fn((message) => ({ sanitised: message, flagged: false, patterns: [] })),
}))

vi.mock('../../security/guardLayer.js', () => ({
  guard: vi.fn(() => ({ allowed: true, violation: null })),
}))

vi.mock('../../security/scopeEnforcer.js', () => ({
  enforceScope: vi.fn(() => ({ compliant: true, violation: null })),
}))

vi.mock('../../security/riskScorer.js', () => ({
  score: vi.fn(() => 0),
}))

vi.mock('../../audit/auditLogger.ts', () => ({
  log: vi.fn(),
  AUDIT_ACTIONS: {
    CHAT_MESSAGE: 'chat_message',
    GUARD_BLOCK: 'guard_block',
    SCOPE_VIOLATION: 'scope_violation',
    INJECTION_DETECTED: 'injection_detected',
  },
}))

vi.mock('../../audit/traceRecorder.js', () => ({
  record: vi.fn(),
}))

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import { encrypt } from '../../utils/encryption.js'
import agentsRoutes from '../agents.js'
import chatRoutes from '../chat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(resolve(__dirname, '../../db/migrations/001_initial_schema.sql'), 'utf8')
const migration002 = readFileSync(resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'), 'utf8')
const migration003 = readFileSync(resolve(__dirname, '../../db/migrations/003_external_agents.sql'), 'utf8')
const migration013 = readFileSync(resolve(__dirname, '../../db/migrations/013_model_selection.sql'), 'utf8')

let app, db, tenantId, userId, apiKeyId, token

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migration001)
  db.exec(migration002)
  db.exec(migration003)
  db.exec(migration013)

  tenantId = nanoid()
  userId = nanoid()
  apiKeyId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'External Co', 'enterprise', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())

  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'external@test.com', 'hash', 'owner')

  const { ciphertext, iv } = encrypt('sk-ant-fake-key')
  db.prepare(
    `INSERT INTO api_keys
      (id, tenant_id, user_id, provider, auth_type, label, key_encrypted, key_iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(apiKeyId, tenantId, userId, 'anthropic', 'key', 'Test Key', ciphertext, iv, Date.now())

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
  vi.clearAllMocks()
  if (app) await app.close()
  if (db) db.close()
})

function request(method, url, payload, authToken = token) {
  return app.inject({
    method,
    url,
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    payload,
  })
}

async function registerExternalAgent(overrides = {}) {
  const res = await request('POST', '/agents/register', {
    name: 'External Guard',
    purpose: 'Proxy an external assistant through Eudora controls',
    ownerType: 'human',
    ownerId: userId,
    providerHint: 'anthropic',
    interceptionMode: 'observe',
    apiKeyId,
    ...overrides,
  })
  return { res, body: JSON.parse(res.body) }
}

describe('external agent registration', () => {
  it('POST /agents/register with valid data returns proxy key once', async () => {
    const { res, body } = await registerExternalAgent({
      endpoint_url: 'https://api.openai.com',
      default_model: 'gpt-4o-mini',
    })

    expect(res.statusCode).toBe(201)
    expect(body.proxyKey).toMatch(/^eudora-proxy-/)
    expect(body.prefix).toBe(body.proxyKey.substring(0, body.prefix.length))

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(body.agentId)
    expect(row.agent_type).toBe('external')
    expect(row.proxy_key_encrypted).toBeTruthy()
    expect(row.proxy_key_iv).toBeTruthy()
    expect(row.proxy_key_encrypted).not.toBe(body.proxyKey)
    expect(row.endpoint_url).toBe('https://api.openai.com')
    expect(row.model_override).toBe('gpt-4o-mini')

    const getRes = await request('GET', `/agents/${body.agentId}`)
    const agent = JSON.parse(getRes.body)
    expect(agent.agent_type).toBe('external')
    expect(agent.proxy_key_prefix).toBe(body.prefix)
    expect(agent.proxyKey).toBeUndefined()
    expect(agent.proxy_key_encrypted).toBeUndefined()
    expect(agent.proxy_key_iv).toBeUndefined()
    expect(agent.endpoint_url).toBe('https://api.openai.com')
    expect(agent.model_override).toBe('gpt-4o-mini')
  })

  it('POST /agents/register without required fields returns 400', async () => {
    const res = await request('POST', '/agents/register', {
      name: 'External Guard',
      purpose: 'Missing owner fields',
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('missing_fields')
  })

  it('POST /agents/:id/proxy-key/rotate returns a new key and prefix', async () => {
    const { body } = await registerExternalAgent()
    const rotateRes = await request('POST', `/agents/${body.agentId}/proxy-key/rotate`)
    const rotated = JSON.parse(rotateRes.body)

    expect(rotateRes.statusCode).toBe(200)
    expect(rotated.proxyKey).toMatch(/^eudora-proxy-/)
    expect(rotated.proxyKey).not.toBe(body.proxyKey)
    expect(rotated.prefix).not.toBe(body.prefix)

    const row = db.prepare('SELECT proxy_key_prefix FROM agents WHERE id = ?').get(body.agentId)
    expect(row.proxy_key_prefix).toBe(rotated.prefix)
  })

  it('GET /agents includes external agents without proxy secrets', async () => {
    const { body } = await registerExternalAgent({
      endpoint_url: 'http://192.168.178.100:11434',
      default_model: 'qwen2.5:14b',
    })
    const res = await request('GET', '/agents')
    const agents = JSON.parse(res.body)

    expect(res.statusCode).toBe(200)
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: body.agentId, agent_type: 'external' }),
      ])
    )
    const external = agents.find((agent) => agent.id === body.agentId)
    expect(external.proxy_key_encrypted).toBeUndefined()
    expect(external.proxy_key_iv).toBeUndefined()
    expect(external.proxyKey).toBeUndefined()
    expect(external.endpoint_url).toBe('http://192.168.178.100:11434')
    expect(external.model_override).toBe('qwen2.5:14b')
  })

  it('external agent with live status is rejected by Neural Interface chat', async () => {
    const { body } = await registerExternalAgent()
    const res = await request('POST', '/chat', {
      agentId: body.agentId,
      message: 'Hello from outside Eudora',
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'external_agent_not_supported',
      message: 'External agents cannot be used via the Neural Interface. Use the proxy endpoint or SDK instead.',
    })
  })
})
