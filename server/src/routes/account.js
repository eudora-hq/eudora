import { ZipArchive } from 'archiver'
import { decrypt } from '../utils/encryption.js'

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '')
  } catch {
    return fallback
  }
}

function safeFilename(filename, fallback) {
  const cleaned = String(filename || fallback)
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || fallback
}

function appendJson(archive, name, data) {
  archive.append(`${JSON.stringify(data, null, 2)}\n`, { name })
}

export default async function accountRoutes(fastify) {
  const db = fastify.db

  fastify.get('/export', async (request, reply) => {
    const tenantId = request.tenantId
    const user = await db.get(
      'SELECT email FROM users WHERE id = ? AND tenant_id = ?'
    , [request.user.userId, tenantId])
    const tenantEmail = user?.email || 'unknown'

    const agents = await db.all(
      `SELECT id, name, purpose, model_provider, system_prompt, owner_type,
              owner_id, owner_chain, created_at
       FROM agents
       WHERE tenant_id = ?
       ORDER BY created_at DESC`
    , [tenantId])

    const contextFiles = await db.all(
      `SELECT id, agent_id, filename, tags, content_encrypted, content_iv, created_at, updated_at
       FROM context_files
       WHERE tenant_id = ?
       ORDER BY created_at DESC`
    , [tenantId])

    const auditLog = await db.all(
      `SELECT id, user_id, action, context_hash, prompt_hash, response_hash,
              risk_score, metadata, ts, initiated_by_user_id, agent_chain
       FROM audit_log
       WHERE tenant_id = ?
       ORDER BY ts DESC`
    , [tenantId]).map((row) => ({
      ...row,
      metadata: parseJson(row.metadata, {}),
      agent_chain: parseJson(row.agent_chain, []),
    }))

    const cronJobs = await db.all(
      `SELECT id, agent_id, name, prompt, schedule, preset, enabled,
              created_at, last_run_at, next_run_at
       FROM cron_jobs
       WHERE tenant_id = ?
       ORDER BY created_at DESC`
    , [tenantId])

    const conversations = await db.all(
      `SELECT id, agent_id, user_id, created_at
       FROM conversations
       WHERE tenant_id = ?
       ORDER BY created_at DESC`
    , [tenantId])
    const messagesByConversation = db.prepare(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE tenant_id = ? AND conversation_id = ?
       ORDER BY created_at ASC`
    )
    const conversationsWithMessages = conversations.map((conversation) => ({
      ...conversation,
      messages: messagesByConversation.all(tenantId, conversation.id),
    }))

    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', 'attachment; filename="eudora-export.zip"')
    reply.raw.setHeader('Content-Type', 'application/zip')
    reply.raw.setHeader('Content-Disposition', 'attachment; filename="eudora-export.zip"')

    const archive = new ZipArchive({ zlib: { level: 0 } })
    archive.on('error', (error) => {
      request.log.error(error)
      if (!reply.raw.destroyed) reply.raw.destroy(error)
    })

    archive.pipe(reply.raw)
    archive.append(
      `Eudora data export for ${tenantEmail} — exported ${new Date().toISOString()}\n`,
      { name: 'README.txt' }
    )
    appendJson(archive, 'agents.json', agents)
    appendJson(archive, 'audit_log.json', auditLog)
    appendJson(archive, 'cron_jobs.json', cronJobs)
    appendJson(archive, 'conversations.json', conversationsWithMessages)

    contextFiles.forEach((file, index) => {
      const name = safeFilename(file.filename, `${file.id || index}.md`)
      const content = decrypt(file.content_encrypted, file.content_iv)
      archive.append(content, { name: `context_files/${name}` })
    })

    await archive.finalize()
    return reply
  })
}
