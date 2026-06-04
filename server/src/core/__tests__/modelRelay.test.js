import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = 'a1'.repeat(32) // 64 hex chars

// ── vi.mock hoisted above all static imports ──────────────────────────────────
const mocks = vi.hoisted(() => ({ db: null }))
vi.mock('../../db/client.js', () => ({
  getDb: () => mocks.db,
  default: () => mocks.db,
}))
// ─────────────────────────────────────────────────────────────────────────────

import { encrypt } from '../../utils/encryption.js'
import {
  relay,
  InvalidApiKeyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../modelRelay.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let tenantId, userId
let anthropicKeyId, openaiKeyId
let ollamaNoKeyId, ollamaWithKeyId, customKeyId

const composedPrompt = {
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Help me write a function.' },
  ],
  estimatedTokens: 50,
  contextFilesUsed: [],
}

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.pragma('foreign_keys = ON')
  mocks.db.exec(migrationSql)

  tenantId = nanoid()
  mocks.db
    .prepare('INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, 'Test Co', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())

  userId = nanoid()
  mocks.db
    .prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, tenantId, 'relay@test.com', 'hash', 'owner')

  const ins = mocks.db.prepare(
    `INSERT INTO api_keys
       (id, tenant_id, user_id, provider, auth_type, label, key_encrypted, key_iv, base_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  // Anthropic key
  const ant = encrypt('sk-ant-secret')
  anthropicKeyId = nanoid()
  ins.run(anthropicKeyId, tenantId, userId, 'anthropic', 'key', 'Ant', ant.ciphertext, ant.iv, null, Date.now())

  // OpenAI key
  const oai = encrypt('sk-openai-secret')
  openaiKeyId = nanoid()
  ins.run(openaiKeyId, tenantId, userId, 'openai', 'key', 'OAI', oai.ciphertext, oai.iv, null, Date.now())

  // Ollama — no key
  ollamaNoKeyId = nanoid()
  ins.run(ollamaNoKeyId, tenantId, userId, 'ollama', 'key', 'Oll-nokey', null, null, 'http://localhost:11434', Date.now())

  // Ollama — with key
  const olk = encrypt('ollama-token')
  ollamaWithKeyId = nanoid()
  ins.run(ollamaWithKeyId, tenantId, userId, 'ollama', 'key', 'Oll-key', olk.ciphertext, olk.iv, 'http://localhost:11434', Date.now())

  // Custom — with key
  const cust = encrypt('custom-token')
  customKeyId = nanoid()
  ins.run(customKeyId, tenantId, userId, 'custom', 'key', 'Custom', cust.ciphertext, cust.iv, 'https://api.custom.example', Date.now())
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (mocks.db) mocks.db.close()
  mocks.db = null
})

function stubFetch(body, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })
  )
}

// ── Provider routing ──────────────────────────────────────────────────────────

describe('Anthropic provider', () => {
  it('calls correct endpoint with correct headers and returns { content, tokensUsed }', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: 'Here is your function.' }],
        usage: { input_tokens: 120, output_tokens: 80 },
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await relay(composedPrompt, anthropicKeyId, tenantId)

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(opts.headers['anthropic-version']).toBe('2023-06-01')
    expect(typeof opts.headers['x-api-key']).toBe('string')
    expect(opts.headers['x-api-key'].length).toBeGreaterThan(0)

    expect(result.content).toBe('Here is your function.')
    expect(result.tokensUsed).toEqual({ input: 120, output: 80, total: 200 })
  })
})

describe('OpenAI provider', () => {
  it('calls correct endpoint with Bearer token header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'OpenAI says hi.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await relay(composedPrompt, openaiKeyId, tenantId)

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(opts.headers.Authorization).toMatch(/^Bearer .+/)

    expect(result.content).toBe('OpenAI says hi.')
    expect(result.tokensUsed).toEqual({ input: 50, output: 30, total: 80 })
  })
})

describe('Ollama provider', () => {
  const ollamaBody = {
    message: { content: 'Llama response' },
    prompt_eval_count: 40,
    eval_count: 20,
  }

  it('sends NO Authorization header when key is null', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ollamaBody })
    vi.stubGlobal('fetch', mockFetch)

    await relay(composedPrompt, ollamaNoKeyId, tenantId)

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers).not.toHaveProperty('Authorization')
  })

  it('sends Authorization header when key is present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ollamaBody })
    vi.stubGlobal('fetch', mockFetch)

    await relay(composedPrompt, ollamaWithKeyId, tenantId)

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers).toHaveProperty('Authorization')
    expect(opts.headers.Authorization).toMatch(/^Bearer .+/)
  })
})

describe('Custom provider', () => {
  it('sends Authorization header when key is present', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Custom says hi.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await relay(composedPrompt, customKeyId, tenantId)

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers.Authorization).toMatch(/^Bearer .+/)
    expect(result.content).toBe('Custom says hi.')
  })
})

// ── HTTP error handling ───────────────────────────────────────────────────────

describe('HTTP error handling', () => {
  it('401 → throws InvalidApiKeyError', async () => {
    stubFetch({}, 401)
    await expect(relay(composedPrompt, anthropicKeyId, tenantId)).rejects.toThrow(InvalidApiKeyError)
  })

  it('429 → throws ProviderRateLimitError', async () => {
    stubFetch({}, 429)
    await expect(relay(composedPrompt, anthropicKeyId, tenantId)).rejects.toThrow(ProviderRateLimitError)
  })

  it('500 → throws ProviderUnavailableError', async () => {
    stubFetch({}, 500)
    await expect(relay(composedPrompt, anthropicKeyId, tenantId)).rejects.toThrow(ProviderUnavailableError)
  })

  it('decrypted key does NOT appear in any thrown error message', async () => {
    stubFetch({}, 401)
    try {
      await relay(composedPrompt, anthropicKeyId, tenantId)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).not.toContain('sk-ant-secret')
    }
  })
})
