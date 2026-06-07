import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

const mocks = vi.hoisted(() => ({ db: null }))
vi.mock('../../db/client.js', () => ({
  getDb: () => mocks.db,
  default: () => mocks.db,
}))
vi.mock('../../utils/encryption.js', () => ({
  decrypt: vi.fn(ciphertext => ciphertext),
}))

import { generateEmbedding } from '../../utils/embeddings.js'
import { retrieve } from '../contextRetriever.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let tenantId
let agentId

beforeAll(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(readFileSync(
    resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
    'utf8'
  ))
  mocks.db.exec(readFileSync(
    resolve(__dirname, '../../db/migrations/009_embeddings.sql'),
    'utf8'
  ))

  tenantId = nanoid()
  agentId = nanoid()
  mocks.db.prepare(`
    INSERT INTO tenants (id, name, plan, created_at)
    VALUES (?, 'Tenant', 'trial', ?)
  `).run(tenantId, Date.now())
  mocks.db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, 'owner@example.com', 'hash', 'owner')
  `).run(nanoid(), tenantId)
  mocks.db.prepare(`
    INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at)
    VALUES (?, ?, 'Agent', 'Compliance', 'openai', ?)
  `).run(agentId, tenantId, Date.now())
})

afterAll(() => {
  mocks.db.close()
  mocks.db = null
})

async function insertEmbeddedFile(filename, content) {
  const embedding = await generateEmbedding(content, null, 'fallback')
  const now = Date.now()
  mocks.db.prepare(`
    INSERT INTO context_files (
      id, tenant_id, agent_id, filename, tags, content_encrypted, content_iv,
      created_at, updated_at, embedding, embedding_model, embedded_at
    )
    VALUES (?, ?, ?, ?, '["general"]', ?, 'iv', ?, ?, ?, 'fallback:tfidf-768', ?)
  `).run(
    nanoid(),
    tenantId,
    agentId,
    filename,
    content,
    now,
    now,
    JSON.stringify(embedding),
    now
  )
}

describe('semantic context retrieval', () => {
  it('ranks context by similarity to the query', async () => {
    await insertEmbeddedFile('security.md', 'credential security encryption password controls')
    await insertEmbeddedFile('cooking.md', 'pasta tomato sauce recipe kitchen')

    const result = await retrieve(
      agentId,
      'general_chat',
      tenantId,
      'credential security controls'
    )

    expect(result.files.map(file => file.filename)).toEqual([
      'security.md',
      'cooking.md',
    ])
  })
})
