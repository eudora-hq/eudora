import getDb from '../db/client.js'
import { decrypt } from '../utils/encryption.js'
import { generateEmbeddingWithMetadata, cosineSimilarity } from '../utils/embeddings.js'
import { INTENT_TAG_MAP } from '../../../shared/constants/intentTypes.js'

const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '8000')

function parseEmbedding(row) {
  try {
    const embedding = JSON.parse(row.embedding)
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  }
}

async function getQueryEmbeddings(db, tenantId, query, models) {
  const embeddings = new Map()
  const openAIKey = models.some(model => model.startsWith('openai:'))
    ? db.prepare(`
        SELECT key_encrypted, key_iv
        FROM api_keys
        WHERE tenant_id = ? AND provider = 'openai' AND key_encrypted IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1
      `).get(tenantId)
    : null
  const ollamaKey = models.some(model => model.startsWith('ollama:'))
    ? db.prepare(`
        SELECT base_url
        FROM api_keys
        WHERE tenant_id = ? AND provider = 'ollama' AND base_url IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1
      `).get(tenantId)
    : null

  for (const model of models) {
    let result
    if (model.startsWith('openai:') && openAIKey) {
      result = await generateEmbeddingWithMetadata(query, {
        provider: 'openai',
        apiKey: decrypt(openAIKey.key_encrypted, openAIKey.key_iv),
      })
    } else if (model.startsWith('ollama:') && ollamaKey) {
      result = await generateEmbeddingWithMetadata(query, {
        provider: 'ollama',
        baseUrl: ollamaKey.base_url,
      })
    } else if (model === 'fallback:tfidf-768') {
      result = await generateEmbeddingWithMetadata(query, { provider: 'fallback' })
    }

    if (result?.model === model) embeddings.set(model, result.embedding)
  }
  return embeddings
}

export async function retrieve(agentId, intent, tenantId, query = '') {
  const db = getDb()

  const rows = db
    .prepare('SELECT * FROM context_files WHERE agent_id = ? AND tenant_id = ?')
    .all(agentId, tenantId)

  if (rows.length === 0) {
    return { files: [], tokensEstimate: 0, excluded: [] }
  }

  const relevantTags = INTENT_TAG_MAP[intent] ?? ['general']
  let matched = []
  const excluded = []

  const embeddedRows = query
    ? rows
        .map(row => ({ row, embedding: row.embedding ? parseEmbedding(row) : null }))
        .filter(item => item.embedding && item.row.embedding_model)
    : []

  if (embeddedRows.length > 0) {
    const models = [...new Set(embeddedRows.map(item => item.row.embedding_model))]
    const queryEmbeddings = await getQueryEmbeddings(db, tenantId, query, models)
    const semanticRows = embeddedRows
      .filter(item => queryEmbeddings.has(item.row.embedding_model))
      .map(item => ({
        ...item.row,
        similarity: cosineSimilarity(
          queryEmbeddings.get(item.row.embedding_model),
          item.embedding
        ),
      }))
      .sort((left, right) => right.similarity - left.similarity)
    const semanticIds = new Set(semanticRows.map(row => row.id))
    matched = semanticRows

    for (const row of rows) {
      if (semanticIds.has(row.id)) continue
      const fileTags = JSON.parse(row.tags)
      if (fileTags.some(tag => relevantTags.includes(tag))) {
        matched.push(row)
      } else {
        excluded.push({ id: row.id, filename: row.filename, reason: 'tag_mismatch' })
      }
    }
  } else {
    for (const row of rows) {
      const fileTags = JSON.parse(row.tags)
      const hasMatch = fileTags.some(tag => relevantTags.includes(tag))
      if (hasMatch) {
        matched.push(row)
      } else {
        excluded.push({ id: row.id, filename: row.filename, reason: 'tag_mismatch' })
      }
    }
  }

  const files = []
  let tokensEstimate = 0
  let budgetExceeded = false

  for (const row of matched) {
    if (budgetExceeded) {
      excluded.push({ id: row.id, filename: row.filename, reason: 'token_budget' })
      continue
    }

    const content = decrypt(row.content_encrypted, row.content_iv)
    const tokens = Math.ceil(content.length / 4)

    if (tokensEstimate + tokens > MAX_CONTEXT_TOKENS) {
      budgetExceeded = true
      excluded.push({ id: row.id, filename: row.filename, reason: 'token_budget' })
    } else {
      tokensEstimate += tokens
      files.push({ id: row.id, filename: row.filename, content })
    }
  }

  return { files, tokensEstimate, excluded }
}
