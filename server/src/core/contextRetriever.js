import getDb from '../db/client.js'
import { decrypt } from '../utils/encryption.js'
import { INTENT_TAG_MAP } from '../../../shared/constants/intentTypes.js'

const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '8000')

export async function retrieve(agentId, intent, tenantId) {
  const db = getDb()

  const rows = db
    .prepare('SELECT * FROM context_files WHERE agent_id = ? AND tenant_id = ?')
    .all(agentId, tenantId)

  if (rows.length === 0) {
    return { files: [], tokensEstimate: 0, excluded: [] }
  }

  const relevantTags = INTENT_TAG_MAP[intent] ?? ['general']

  const matched = []
  const excluded = []

  for (const row of rows) {
    const fileTags = JSON.parse(row.tags)
    const hasMatch = fileTags.some((t) => relevantTags.includes(t))
    if (hasMatch) {
      matched.push(row)
    } else {
      excluded.push({ id: row.id, filename: row.filename, reason: 'tag_mismatch' })
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
