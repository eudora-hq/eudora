import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = '0'.repeat(64)
process.env.SELF_HOSTED = 'false'

import { encrypt } from '../../utils/encryption.js'
import ingestRoutes from '../ingest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrations = [
  '001_initial_schema.sql',
  '002_agent_ownership.sql',
  '003_external_agents.sql',
].map(file => readFileSync(resolve(__dirname, `../../db/migrations/${file}`), 'utf8'))

let app
let db
let tenantId
let userId
let agentId
let proxyKey

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrations.forEach(migration => db.exec(migration))

  tenantId = nanoid()
  userId = nanoid()
  agentId = nanoid()
  proxyKey = `eudora-proxy-${nanoid(32)}`
  const encryptedKey = encrypt(proxyKey)

  db.prepare(`
    INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
    VALUES (?, ?, 'enterprise', NULL, ?)
  `).run(tenantId, 'Ingest Test', Date.now())
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, ?, ?, 'owner')
  `).run(userId, tenantId, 'owner@example.com', 'hash')
  db.prepare(`
    INSERT INTO agents (
      id, tenant_id, name, purpose, model_provider, owner_type, owner_id,
      owner_chain, agent_type, proxy_key_encrypted, proxy_key_iv,
      proxy_key_prefix, provider_hint, interception_mode, status, created_at
    )
    VALUES (?, ?, ?, ?, 'openai', 'human', ?, '[]', 'external', ?, ?, ?, 'openai', 'observe', 'live', ?)
  `).run(
    agentId,
    tenantId,
    'LangChain Agent',
    'Framework callback ingestion',
    userId,
    encryptedKey.ciphertext,
    encryptedKey.iv,
    proxyKey.substring(0, 24),
    Date.now()
  )

  app = Fastify({ logger: false })
  app.decorate('db', db)
  await app.register(ingestRoutes, { prefix: '/v1' })
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  if (db) db.close()
})

function payload(overrides = {}) {
  return {
    agent_id: agentId,
    proxy_key: proxyKey,
    source: 'langchain',
    prompt: 'Summarise the control evidence',
    response: 'The control is operating effectively.',
    model: 'gpt-4o',
    latency_ms: 123,
    token_usage: { prompt_tokens: 8, completion_tokens: 6 },
    metadata: { chain_name: 'compliance-review', tools_used: [] },
    ...overrides,
  }
}

describe('POST /v1/ingest', () => {
  it('accepts a valid framework payload and writes an audit record', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: payload(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok' })
    expect(response.json().run_id).toBeTruthy()

    const audit = db.prepare('SELECT * FROM audit_log WHERE id = ?')
      .get(response.json().run_id)
    expect(audit.action).toBe('langchain_ingest')
    expect(audit.user_id).toBe(userId)
    const metadata = JSON.parse(audit.metadata)
    expect(metadata.source).toBe('langchain')
    expect(metadata.agentId).toBe(agentId)
    expect(metadata.tokenUsage.prompt_tokens).toBe(8)
  })

  it('rejects an invalid proxy key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: payload({ proxy_key: 'eudora-proxy-invalid' }),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized' })
  })

  it('rejects payloads with missing required fields', async () => {
    const body = payload()
    delete body.response

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: body,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'missing_fields' })
  })

  it('records DLP detection for credentials in the prompt', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: payload({
        prompt: 'Use AWS key AKIAIOSFODNN7EXAMPLE for this request',
      }),
    })

    expect(response.statusCode).toBe(200)
    const audit = db.prepare('SELECT * FROM audit_log WHERE id = ?')
      .get(response.json().run_id)
    const metadata = JSON.parse(audit.metadata)
    expect(audit.risk_score).toBe(90)
    expect(metadata.dlpDetected).toBe(true)
    expect(metadata.patterns).toContain('credential_exposure')
    expect(metadata.promptSanitised).toContain('[CREDENTIAL REDACTED]')
  })
})
