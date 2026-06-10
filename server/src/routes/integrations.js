import { nanoid } from 'nanoid'
import { testConnection, pullAuditLogs } from '../integrations/azureOpenAI.js'
import {
  testGithubConnection,
  pullCopilotAuditLogs,
} from '../integrations/githubCopilot.js'
import { encrypt, decrypt } from '../utils/encryption.js'
import { createNotification } from '../utils/notify.js'

const REQUIRED_AZURE_FIELDS = [
  'tenantId',
  'clientId',
  'clientSecret',
  'subscriptionId',
  'resourceGroup',
  'resourceName',
]

function hasRequiredAzureConfig(config) {
  return REQUIRED_AZURE_FIELDS.every(field => (
    typeof config?.[field] === 'string' && config[field].trim()
  ))
}

function hasRequiredGithubConfig(config) {
  return ['org', 'token'].every(field => (
    typeof config?.[field] === 'string' && config[field].trim()
  ))
}

function requireIntegrationAdmin(request, reply) {
  if (!['owner', 'admin'].includes(request.user?.role)) {
    reply.code(403).send({
      error: 'forbidden',
      message: 'Only team owners and admins can manage integrations.',
    })
    return false
  }
  return true
}

function encodeConfig(config) {
  const { ciphertext, iv } = encrypt(JSON.stringify(config))
  return JSON.stringify({ ciphertext, iv })
}

function decodeConfig(storedConfig) {
  const encoded = JSON.parse(storedConfig)
  if (encoded.ciphertext && encoded.iv) {
    return JSON.parse(decrypt(encoded.ciphertext, encoded.iv))
  }
  return encoded
}

function auditAction(source, operation) {
  const normalized = String(operation || 'request')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${source}_${normalized || 'request'}`
}

export default async function integrationsRoutes(fastify) {
  const db = fastify.db

  fastify.get('/', async (request) => {
    return await db.all(`
      SELECT
        id, type, name, status, last_sync_at, last_sync_status,
        last_sync_count, created_at
      FROM integrations
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `, [request.tenantId])
  })

  fastify.post('/azure-openai/test', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    const { config } = request.body || {}
    if (!hasRequiredAzureConfig(config)) {
      return reply.code(400).send({
        error: 'missing_config',
        message: `Required fields: ${REQUIRED_AZURE_FIELDS.join(', ')}`,
      })
    }

    return reply.send(await testConnection(config))
  })

  fastify.post('/azure-openai', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    const { name, config } = request.body || {}
    if (!name?.trim() || !hasRequiredAzureConfig(config)) {
      return reply.code(400).send({ error: 'missing_fields' })
    }

    const connection = await testConnection(config)
    if (!connection.success) {
      return reply.code(400).send({
        error: 'connection_failed',
        message: connection.error,
      })
    }

    const id = nanoid()
    const createdAt = Date.now()
    await db.query(`
      INSERT INTO integrations (
        id, tenant_id, type, name, config, status, created_at
      )
      VALUES (?, ?, 'azure_openai', ?, ?, 'active', ?)
    `, [id,
      request.tenantId,
      name.trim(),
      encodeConfig(config),
      createdAt])

    return reply.code(201).send({
      id,
      name: name.trim(),
      type: 'azure_openai',
      status: 'active',
      created_at: createdAt,
    })
  })

  fastify.post('/github-copilot/test', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    const { config } = request.body || {}
    if (!hasRequiredGithubConfig(config)) {
      return reply.code(400).send({
        error: 'missing_config',
        message: 'Required fields: org, token',
      })
    }

    return reply.send(await testGithubConnection(config))
  })

  fastify.post('/github-copilot', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    const { name, config } = request.body || {}
    if (!name?.trim() || !hasRequiredGithubConfig(config)) {
      return reply.code(400).send({ error: 'missing_fields' })
    }

    const connection = await testGithubConnection(config)
    if (!connection.success) {
      return reply.code(400).send({
        error: 'connection_failed',
        message: connection.error,
      })
    }

    const id = nanoid()
    const createdAt = Date.now()
    await db.query(`
      INSERT INTO integrations (
        id, tenant_id, type, name, config, status, created_at
      )
      VALUES (?, ?, 'github_copilot', ?, ?, 'active', ?)
    `, [id,
      request.tenantId,
      name.trim(),
      encodeConfig(config),
      createdAt])

    return reply.code(201).send({
      id,
      name: name.trim(),
      type: 'github_copilot',
      status: 'active',
      created_at: createdAt,
    })
  })

  fastify.post('/:id/sync', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    const integration = await db.get(`
      SELECT *
      FROM integrations
      WHERE id = ? AND tenant_id = ?
    `, [request.params.id, request.tenantId])
    if (!integration) return reply.code(404).send({ error: 'not_found' })
    if (!['azure_openai', 'github_copilot'].includes(integration.type)) {
      return reply.code(400).send({ error: 'unsupported_integration' })
    }

    let config
    try {
      config = decodeConfig(integration.config)
    } catch {
      return reply.code(500).send({
        error: 'invalid_integration_config',
        message: 'Stored integration credentials could not be decrypted.',
      })
    }

    const since = integration.last_sync_at || Date.now() - 24 * 60 * 60 * 1000

    try {
      const source = integration.type
      const events = source === 'github_copilot'
        ? await pullCopilotAuditLogs(config, since)
        : await pullAuditLogs(config, since)
      const insertAudit = db.prepare(`
        INSERT INTO audit_log (
          id, tenant_id, user_id, action, risk_score, metadata,
          initiated_by_user_id, agent_chain, ts
        )
        VALUES (?, ?, ?, ?, 0, ?, ?, '[]', ?)
      `)
      let imported = 0

      const importEvents = db.transaction(() => {
        for (const event of events) {
          insertAudit.run(
            nanoid(),
            request.tenantId,
            request.user.userId,
            auditAction(source, event.operation || event.action),
            JSON.stringify({
              source,
              integrationId: integration.id,
              integrationName: integration.name,
              ...event,
            }),
            request.user.userId,
            event.timestamp || Date.now()
          )
          imported += 1
        }
      })
      importEvents()

      const syncedAt = Date.now()
      await db.query(`
        UPDATE integrations
        SET last_sync_at = ?, last_sync_status = 'success', last_sync_count = ?
        WHERE id = ? AND tenant_id = ?
      `, [syncedAt, imported, integration.id, request.tenantId])

      if (imported > 0) {
        const providerName = source === 'github_copilot'
          ? 'GitHub Copilot'
          : 'Azure OpenAI'
        createNotification(db, {
          tenantId: request.tenantId,
          type: 'integration_sync',
          title: `${providerName} sync complete`,
          message: `Imported ${imported} events from "${integration.name}"`,
          actionUrl: '/audit',
        })
      }

      return reply.send({ imported, total: events.length, syncedAt })
    } catch (error) {
      const status = `failed: ${error.message.substring(0, 100)}`
      await db.query(`
        UPDATE integrations
        SET last_sync_at = ?, last_sync_status = ?, last_sync_count = 0
        WHERE id = ? AND tenant_id = ?
      `, [Date.now(), status, integration.id, request.tenantId])

      return reply.code(500).send({
        error: 'sync_failed',
        message: error.message,
      })
    }
  })

  fastify.delete('/:id', async (request, reply) => {
    if (!requireIntegrationAdmin(request, reply)) return

    await db.query('DELETE FROM integrations WHERE id = ? AND tenant_id = ?', [request.params.id, request.tenantId])
    return reply.send({ deleted: true })
  })
}
