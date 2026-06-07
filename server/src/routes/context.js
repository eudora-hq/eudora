import { nanoid } from 'nanoid'
import { encrypt, decrypt } from '../utils/encryption.js'
import { isUnderLimit } from '../billing/canAccess.js'
import { generateEmbeddingWithMetadata } from '../utils/embeddings.js'

async function embedContextFile(db, fileId, tenantId, content) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(context_files)').all().map(column => column.name)
  )
  if (!columns.has('embedding')) return

  const openAIKey = db.prepare(`
    SELECT key_encrypted, key_iv
    FROM api_keys
    WHERE tenant_id = ? AND provider = 'openai' AND key_encrypted IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1
  `).get(tenantId)
  const ollamaKey = db.prepare(`
    SELECT base_url
    FROM api_keys
    WHERE tenant_id = ? AND provider = 'ollama' AND base_url IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1
  `).get(tenantId)

  let provider = 'ollama'
  let apiKey = null
  let baseUrl = null
  if (openAIKey) {
    provider = 'openai'
    apiKey = decrypt(openAIKey.key_encrypted, openAIKey.key_iv)
  } else if (ollamaKey) {
    baseUrl = ollamaKey.base_url
  }

  const result = await generateEmbeddingWithMetadata(content, {
    apiKey,
    provider,
    baseUrl,
  })
  db.prepare(`
    UPDATE context_files
    SET embedding = ?, embedding_model = ?, embedded_at = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    JSON.stringify(result.embedding),
    result.model,
    Date.now(),
    fileId,
    tenantId
  )
}

export default async function contextRoutes(fastify) {
  const db = fastify.db

  // POST /context
  fastify.post('/', async (request, reply) => {
    const { agentId, filename, content, tags = [] } = request.body || {}

    if (!agentId) return reply.code(400).send({ error: 'agentId is required' })
    if (!filename) return reply.code(400).send({ error: 'filename is required' })
    if (!content) return reply.code(400).send({ error: 'content is required' })

    const agent = db.prepare('SELECT id, tenant_id FROM agents WHERE id = ?').get(agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (agent.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    if (!isUnderLimit(db, request.tenantId, request.tenant.plan, 'context_files')) {
      return reply.code(403).send({ error: 'limit_reached', upgradeUrl: '/billing' })
    }

    const { ciphertext, iv } = encrypt(content)

    const id = nanoid()
    const now = Date.now()
    db.prepare(`
      INSERT INTO context_files
        (id, tenant_id, agent_id, filename, tags, content_encrypted, content_iv, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.tenantId, agentId, filename, JSON.stringify(tags), ciphertext, iv, now, now)

    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), request.tenantId, 'context_files', 1, now)

    embedContextFile(db, id, request.tenantId, content).catch(err => {
      console.error('[embed] Failed to embed file:', err.message)
    })

    return reply.code(201).send({ id, agent_id: agentId, filename, tags, created_at: now, updated_at: now })
  })

  // GET /context?agentId=
  fastify.get('/', async (request, reply) => {
    const { agentId } = request.query || {}
    if (!agentId) return reply.code(400).send({ error: 'agentId is required' })

    const agent = db.prepare('SELECT id, tenant_id FROM agents WHERE id = ?').get(agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (agent.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    const rows = db
      .prepare(
        'SELECT id, agent_id, filename, tags, created_at, updated_at FROM context_files WHERE agent_id = ? AND tenant_id = ?'
      )
      .all(agentId, request.tenantId)

    return reply.send(rows.map((row) => ({ ...row, tags: JSON.parse(row.tags) })))
  })

  // GET /context/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params
    const row = db.prepare('SELECT * FROM context_files WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    const content = decrypt(row.content_encrypted, row.content_iv)
    return reply.send({
      id: row.id,
      agent_id: row.agent_id,
      filename: row.filename,
      tags: JSON.parse(row.tags),
      content,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })
  })

  // PATCH /context/:id/tags
  fastify.patch('/:id/tags', async (request, reply) => {
    const { id } = request.params
    const { tags } = request.body || {}

    const row = db.prepare('SELECT id, tenant_id, filename FROM context_files WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    const updated_at = Date.now()
    db.prepare('UPDATE context_files SET tags = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(tags),
      updated_at,
      id
    )

    return reply.send({ id, filename: row.filename, tags, updated_at })
  })

  // DELETE /context/:id
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params
    const row = db.prepare('SELECT id, tenant_id FROM context_files WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    db.prepare('DELETE FROM context_files WHERE id = ?').run(id)
    return reply.send({ success: true })
  })
}
