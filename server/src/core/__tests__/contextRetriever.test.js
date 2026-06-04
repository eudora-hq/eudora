import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = 'f'.repeat(64)

// ── vi.mock hoisted above all static imports ──────────────────────────────────
const mocks = vi.hoisted(() => ({ db: null }))
vi.mock('../../db/client.js', () => ({
  getDb: () => mocks.db,
  default: () => mocks.db,
}))
vi.mock('../../utils/encryption.js', () => ({
  encrypt: vi.fn((plaintext) => ({ ciphertext: plaintext, iv: 'test-iv' })),
  decrypt: vi.fn((ciphertext) => ciphertext),
}))
// ─────────────────────────────────────────────────────────────────────────────

import { encrypt } from '../../utils/encryption.js'
import { retrieve } from '../contextRetriever.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let tenantId, tenantBId

beforeAll(() => {
  mocks.db = new Database(':memory:')
  mocks.db.pragma('foreign_keys = ON')
  mocks.db.exec(migrationSql)

  // Tenant A
  tenantId = nanoid()
  mocks.db
    .prepare('INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, 'Tenant A', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  const userId = nanoid()
  mocks.db
    .prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, tenantId, 'a@retriever.com', 'hash', 'owner')

  // Tenant B (for isolation test)
  tenantBId = nanoid()
  mocks.db
    .prepare('INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantBId, 'Tenant B', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  const userBId = nanoid()
  mocks.db
    .prepare('INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(userBId, tenantBId, 'b@retriever.com', 'hash', 'owner')
})

afterAll(() => {
  if (mocks.db) mocks.db.close()
  mocks.db = null
})

// Helper: create a fresh agent and insert context files into it
function makeAgent(tid = tenantId) {
  const id = nanoid()
  mocks.db
    .prepare(
      'INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, tid, 'Agent', 'general', 'anthropic', Date.now())
  return id
}

function insertFile(agentId, tid, { filename = 'f.md', tags = [], content = 'hello' } = {}) {
  const { ciphertext, iv } = encrypt(content)
  const id = nanoid()
  const now = Date.now()
  mocks.db
    .prepare(
      `INSERT INTO context_files
         (id, tenant_id, agent_id, filename, tags, content_encrypted, content_iv, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, tid, agentId, filename, JSON.stringify(tags), ciphertext, iv, now, now)
  return id
}

describe('retrieve — tag filtering', () => {
  it('file tagged [coding] is retrieved for coding intent, excluded for general_chat', async () => {
    const agentId = makeAgent()
    insertFile(agentId, tenantId, { filename: 'code.md', tags: ['coding'], content: 'code stuff' })

    const codingResult = await retrieve(agentId, 'coding', tenantId)
    expect(codingResult.files).toHaveLength(1)
    expect(codingResult.files[0].filename).toBe('code.md')
    expect(codingResult.excluded).toHaveLength(0)

    const chatResult = await retrieve(agentId, 'general_chat', tenantId)
    expect(chatResult.files).toHaveLength(0)
    expect(chatResult.excluded).toHaveLength(1)
    expect(chatResult.excluded[0].reason).toBe('tag_mismatch')
  })

  it('file tagged [general] is retrieved for ALL intents', async () => {
    const agentId = makeAgent()
    insertFile(agentId, tenantId, { filename: 'general.md', tags: ['general'], content: 'shared' })

    for (const intent of ['coding', 'general_chat', 'data_analysis', 'document_qa', 'compliance', 'custom']) {
      const result = await retrieve(agentId, intent, tenantId)
      expect(result.files).toHaveLength(1)
      expect(result.excluded).toHaveLength(0)
    }
  })

  it('for compliance intent: [coding] file excluded, [general] file retrieved', async () => {
    const agentId = makeAgent()
    insertFile(agentId, tenantId, { filename: 'code.md', tags: ['coding'], content: 'code' })
    insertFile(agentId, tenantId, { filename: 'gen.md', tags: ['general'], content: 'general' })

    const result = await retrieve(agentId, 'compliance', tenantId)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].filename).toBe('gen.md')
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0].filename).toBe('code.md')
    expect(result.excluded[0].reason).toBe('tag_mismatch')
  })
})

describe('retrieve — token budget', () => {
  it('files beyond MAX_CONTEXT_TOKENS appear in excluded with reason token_budget', async () => {
    const agentId = makeAgent()
    // Default MAX_CONTEXT_TOKENS = 8000 → budget = 8000 * 4 = 32000 chars
    // File 1: 20000 chars → 5000 tokens — fits
    // File 2: 20000 chars → 5000 tokens — total 10000 > 8000 → excluded
    const bigContent1 = 'A'.repeat(20000)
    const bigContent2 = 'B'.repeat(20000)
    insertFile(agentId, tenantId, { filename: 'big1.md', tags: ['general'], content: bigContent1 })
    insertFile(agentId, tenantId, { filename: 'big2.md', tags: ['general'], content: bigContent2 })

    const result = await retrieve(agentId, 'general_chat', tenantId)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].filename).toBe('big1.md')
    expect(result.tokensEstimate).toBe(5000) // Math.ceil(20000 / 4)
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0].filename).toBe('big2.md')
    expect(result.excluded[0].reason).toBe('token_budget')
  })
})

describe('retrieve — agent isolation', () => {
  it('files from a different agent are never returned even with same tenant', async () => {
    const agentX = makeAgent()
    const agentY = makeAgent()
    insertFile(agentX, tenantId, { filename: 'x.md', tags: ['general'], content: 'belongs to X' })

    const result = await retrieve(agentY, 'general_chat', tenantId)
    expect(result.files).toHaveLength(0)
    expect(result.tokensEstimate).toBe(0)
    expect(result.excluded).toHaveLength(0)
  })
})

describe('retrieve — empty result', () => {
  it('returns empty result when agent has no files', async () => {
    const agentId = makeAgent()
    const result = await retrieve(agentId, 'coding', tenantId)
    expect(result).toEqual({ files: [], tokensEstimate: 0, excluded: [] })
  })
})
