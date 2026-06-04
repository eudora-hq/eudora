import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

// Must be set before any module that calls getMasterKey() is imported
process.env.ENCRYPTION_KEY = 'd'.repeat(64)
process.env.JWT_SECRET = 'test-secret-32-chars-minimum!!!!'

// ── vi.mock is hoisted above all static imports ──────────────────────────────
let testDb
vi.mock('../../db/client.js', () => ({
  default: () => testDb,
}))
// ─────────────────────────────────────────────────────────────────────────────

import { encrypt } from '../../utils/encryption.js'
import { classify } from '../classifier.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let tenantId, userId, anthropicKeyId, openaiKeyId

beforeAll(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(migrationSql)

  tenantId = nanoid()
  testDb
    .prepare('INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, 'Test Co', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())

  userId = nanoid()
  testDb
    .prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, tenantId, 'c@test.com', 'hash', 'owner')

  // Anthropic api key
  const { ciphertext: antCt, iv: antIv } = encrypt('sk-ant-test')
  anthropicKeyId = nanoid()
  testDb
    .prepare(
      'INSERT INTO api_keys (id, tenant_id, user_id, provider, auth_type, label, key_encrypted, key_iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(anthropicKeyId, tenantId, userId, 'anthropic', 'key', 'Ant Key', antCt, antIv, Date.now())

  // OpenAI api key
  const { ciphertext: oaiCt, iv: oaiIv } = encrypt('sk-openai-test')
  openaiKeyId = nanoid()
  testDb
    .prepare(
      'INSERT INTO api_keys (id, tenant_id, user_id, provider, auth_type, label, key_encrypted, key_iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(openaiKeyId, tenantId, userId, 'openai', 'key', 'OAI Key', oaiCt, oaiIv, Date.now())
})

afterAll(() => {
  testDb.close()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(jsonBody, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    })
  )
}

describe('classify', () => {
  it('valid Anthropic response returns { intent, confidence }', async () => {
    stubFetch({ content: [{ text: '{"intent":"coding","confidence":0.95}' }] })
    const result = await classify('Write me a sort function', anthropicKeyId, tenantId)
    expect(result).toEqual({ intent: 'coding', confidence: 0.95 })
  })

  it('valid OpenAI response returns correct intent', async () => {
    stubFetch({
      choices: [{ message: { content: '{"intent":"data_analysis","confidence":0.88}' } }],
    })
    const result = await classify('Analyse this CSV file', openaiKeyId, tenantId)
    expect(result).toEqual({ intent: 'data_analysis', confidence: 0.88 })
  })

  it('malformed JSON from model returns fallback', async () => {
    stubFetch({ content: [{ text: 'I think this is coding' }] })
    const result = await classify('Write some code', anthropicKeyId, tenantId)
    expect(result).toEqual({ intent: 'general_chat', confidence: 0 })
  })

  it('unknown intent in JSON returns fallback', async () => {
    stubFetch({ content: [{ text: '{"intent":"unknown_type","confidence":0.9}' }] })
    const result = await classify('Do something', anthropicKeyId, tenantId)
    expect(result).toEqual({ intent: 'general_chat', confidence: 0 })
  })

  it('fetch network error returns fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))
    const result = await classify('Hello', anthropicKeyId, tenantId)
    expect(result).toEqual({ intent: 'general_chat', confidence: 0 })
  })

  it('HTTP 429 from provider returns fallback without throwing', async () => {
    stubFetch({ error: { message: 'Rate limit exceeded' } }, 429)
    const result = await classify('Hello', anthropicKeyId, tenantId)
    expect(result).toEqual({ intent: 'general_chat', confidence: 0 })
  })
})
