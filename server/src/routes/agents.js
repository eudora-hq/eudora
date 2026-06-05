import { nanoid } from 'nanoid'
import { isUnderAgentLimit } from '../billing/canAccess.js'
import { log } from '../audit/auditLogger.js'
import { encrypt } from '../utils/encryption.js'
import { validateOwnership } from '../utils/ownershipChain.js'

const INTERCEPTION_MODES = new Set(['block', 'observe', 'report_only'])
const PROXY_KEY_PREFIX_LENGTH = 24

function redactAgentSecrets(agent) {
  if (!agent) return agent
  const safeAgent = { ...agent }
  delete safeAgent.proxy_key_encrypted
  delete safeAgent.proxy_key_iv
  return safeAgent
}

function generateProxyKey() {
  const rawKey = `eudora-proxy-${nanoid(32)}`
  return {
    rawKey,
    prefix: rawKey.substring(0, PROXY_KEY_PREFIX_LENGTH),
  }
}

export default async function agentsRoutes(fastify) {
  const db = fastify.db

  // List all agents for tenant
  fastify.get('/', async (request) => {
    try {
      return db.prepare(`
        SELECT a.*,
          u.email AS owner_email,
          pa.name AS owner_agent_name
        FROM agents a
        LEFT JOIN users u ON a.owner_type = 'human' AND u.id = a.owner_id AND u.tenant_id = a.tenant_id
        LEFT JOIN agents pa ON a.owner_type = 'agent' AND pa.id = a.owner_id AND pa.tenant_id = a.tenant_id
        WHERE a.tenant_id = ?
        ORDER BY a.created_at DESC
      `).all(request.tenantId).map(redactAgentSecrets)
    } catch (err) {
      if (!String(err.message || '').includes('no such column')) throw err
      return db.prepare(
        'SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at DESC'
      ).all(request.tenantId).map(redactAgentSecrets)
    }
  })

  // POST /agents/register — register an external agent
  fastify.post('/register', async (request, reply) => {
    const {
      name,
      purpose,
      ownerType,
      ownerId,
      providerHint,
      interceptionMode,
      apiKeyId,
    } = request.body

    if (!name || !purpose || !ownerType || !ownerId) {
      return reply.code(400).send({
        error: 'missing_fields',
        message: 'name, purpose, ownerType, ownerId required',
      })
    }

    const mode = interceptionMode || 'observe'
    if (!INTERCEPTION_MODES.has(mode)) {
      return reply.code(400).send({ error: 'invalid_interception_mode' })
    }
    if (!isUnderAgentLimit(db, request.tenantId, request.tenant.plan)) {
      return reply.code(403).send({
        error: 'limit_reached',
        message: 'Upgrade to monitor more agents',
        upgradeUrl: '/billing',
      })
    }

    const ownership = validateOwnership(
      db,
      ownerId,
      ownerType,
      request.tenantId,
      null
    )

    if (!ownership.valid) {
      return reply.code(400).send({
        error: ownership.code || 'invalid_ownership',
        message: ownership.error || 'Invalid ownership assignment',
      })
    }

    const agentId = nanoid()
    const { rawKey, prefix } = generateProxyKey()
    const { ciphertext, iv } = encrypt(rawKey)
    const now = Date.now()
    const resolvedProvider = providerHint || 'openai'

    db.prepare(`
      INSERT INTO agents (
        id, tenant_id, name, purpose, model_provider, api_key_id,
        agent_type, proxy_key_encrypted, proxy_key_iv, proxy_key_prefix,
        provider_hint, interception_mode, status, owner_type, owner_id,
        owner_chain, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'external', ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)
    `).run(
      agentId,
      request.tenantId,
      name,
      purpose,
      resolvedProvider,
      apiKeyId || null,
      ciphertext,
      iv,
      prefix,
      resolvedProvider,
      mode,
      ownerType,
      ownerId,
      JSON.stringify(ownership.chain),
      now
    )

    log({
      tenantId: request.tenantId,
      userId: request.user.userId,
      action: 'agent_registered_external',
      riskScore: 0,
      metadata: { name, providerHint: resolvedProvider, interceptionMode: mode, agentId },
      initiatedByUserId: request.user.userId,
      agentChain: [agentId],
    }, db)

    return reply.code(201).send({
      agentId,
      proxyKey: rawKey,
      prefix,
      message: 'Store this proxy key securely. It will not be shown again.',
    })
  })

  // POST /agents/:id/proxy-key/rotate — rotate proxy key
  fastify.post('/:id/proxy-key/rotate', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)

    if (!agent) return reply.code(404).send({ error: 'not_found' })
    if (agent.agent_type !== 'external') {
      return reply.code(400).send({ error: 'not_external_agent' })
    }

    const { rawKey, prefix } = generateProxyKey()
    const { ciphertext, iv } = encrypt(rawKey)

    db.prepare(`
      UPDATE agents
      SET proxy_key_encrypted = ?, proxy_key_iv = ?, proxy_key_prefix = ?
      WHERE id = ? AND tenant_id = ?
    `).run(ciphertext, iv, prefix, request.params.id, request.tenantId)

    log({
      tenantId: request.tenantId,
      userId: request.user.userId,
      action: 'agent_proxy_key_rotated',
      riskScore: 0,
      metadata: { agentId: request.params.id },
      initiatedByUserId: request.user.userId,
      agentChain: [request.params.id],
    }, db)

    return {
      proxyKey: rawKey,
      prefix,
      message: 'Old key immediately invalid.',
    }
  })

  // POST /agents/:id/submit-for-approval
  fastify.post('/:id/submit-for-approval', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)

    if (!agent) return reply.code(404).send({ error: 'not_found' })

    db.prepare(
      'UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?'
    ).run('pending_approval', request.params.id, request.tenantId)

    log({
      tenantId: request.tenantId,
      userId: request.user.userId,
      action: 'agent_submitted_for_approval',
      riskScore: 0,
      metadata: { agentId: agent.id },
      initiatedByUserId: request.user.userId,
      agentChain: [agent.id],
    }, db)

    return { status: 'pending_approval' }
  })

  // POST /agents/:id/approve
  fastify.post('/:id/approve', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)

    if (!agent) return reply.code(404).send({ error: 'not_found' })
    if (agent.status !== 'pending_approval') {
      return reply.code(400).send({
        error: 'not_pending',
        message: 'Agent must be pending_approval to approve',
      })
    }

    db.prepare(
      'UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?'
    ).run('live', request.params.id, request.tenantId)

    log({
      tenantId: request.tenantId,
      userId: request.user.userId,
      action: 'agent_approved',
      riskScore: 0,
      metadata: {
        agentId: agent.id,
        approvedBy: request.user.userId,
        approvedAt: Date.now(),
      },
      initiatedByUserId: request.user.userId,
      agentChain: [agent.id],
    }, db)

    return { status: 'live' }
  })

  // PATCH /agents/:id/scope-policy
  fastify.patch('/:id/scope-policy', async (request, reply) => {
    const { scopePolicy } = request.body || {}
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)

    if (!agent) return reply.code(404).send({ error: 'not_found' })

    db.prepare(
      'UPDATE agents SET scope_policy = ? WHERE id = ? AND tenant_id = ?'
    ).run(JSON.stringify(scopePolicy || {}), request.params.id, request.tenantId)

    return { scopePolicy: scopePolicy || {} }
  })

  // Get single agent
  fastify.get('/:id', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    return redactAgentSecrets(agent)
  })

  // Create agent
  fastify.post('/', async (request, reply) => {
    const {
      name,
      purpose,
      model_provider,
      api_key_id,
      system_prompt,
      owner_type,
      owner_id,
    } = request.body

    if (!name || !purpose || !model_provider) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'name, purpose and model_provider are required',
      })
    }
    if (!isUnderAgentLimit(db, request.tenantId, request.tenant.plan)) {
      return reply.code(403).send({
        error: 'limit_reached',
        message: 'Upgrade to monitor more agents',
        upgradeUrl: '/billing',
      })
    }

    // Resolve ownership — default to the creating user as human owner
    const resolvedOwnerType = owner_type || 'human'
    const resolvedOwnerId = owner_id || request.user.userId

    const ownership = validateOwnership(
      db,
      resolvedOwnerId,
      resolvedOwnerType,
      request.tenantId,
      null // no selfId yet — this is a new agent
    )

    if (!ownership.valid) {
      return reply.code(400).send({
        error: ownership.code,
        message: ownership.error,
      })
    }

    const id = nanoid()
    db.prepare(
      `INSERT INTO agents
        (id, tenant_id, name, purpose, model_provider, api_key_id, system_prompt,
         owner_type, owner_id, owner_chain, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      request.tenantId,
      name,
      purpose,
      model_provider,
      api_key_id || null,
      system_prompt || null,
      resolvedOwnerType,
      resolvedOwnerId,
      JSON.stringify(ownership.chain),
      Date.now()
    )

    return reply.code(201).send(redactAgentSecrets(
      db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    ))
  })

  // Update agent
  fastify.patch('/:id', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })

    const {
      name,
      purpose,
      model_provider,
      api_key_id,
      system_prompt,
      owner_type,
      owner_id,
    } = request.body

    // If ownership is being changed, validate the new ownership
    if (owner_type || owner_id) {
      const newOwnerType = owner_type || agent.owner_type
      const newOwnerId = owner_id || agent.owner_id

      const ownership = validateOwnership(
        db,
        newOwnerId,
        newOwnerType,
        request.tenantId,
        request.params.id // pass selfId to detect cycles
      )

      if (!ownership.valid) {
        return reply.code(400).send({
          error: ownership.code,
          message: ownership.error,
        })
      }

      db.prepare(
        `UPDATE agents SET
          name = COALESCE(?, name),
          purpose = COALESCE(?, purpose),
          model_provider = COALESCE(?, model_provider),
          api_key_id = COALESCE(?, api_key_id),
          system_prompt = COALESCE(?, system_prompt),
          owner_type = ?,
          owner_id = ?,
          owner_chain = ?
         WHERE id = ? AND tenant_id = ?`
      ).run(
        name, purpose, model_provider, api_key_id, system_prompt,
        newOwnerType,
        newOwnerId,
        JSON.stringify(ownership.chain),
        request.params.id,
        request.tenantId
      )
    } else {
      // No ownership change — just update other fields
      db.prepare(
        `UPDATE agents SET
          name = COALESCE(?, name),
          purpose = COALESCE(?, purpose),
          model_provider = COALESCE(?, model_provider),
          api_key_id = COALESCE(?, api_key_id),
          system_prompt = COALESCE(?, system_prompt)
         WHERE id = ? AND tenant_id = ?`
      ).run(
        name, purpose, model_provider, api_key_id, system_prompt,
        request.params.id,
        request.tenantId
      )
    }

    return redactAgentSecrets(
      db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id)
    )
  })

  // Delete agent
  fastify.delete('/:id', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    db.prepare('DELETE FROM agents WHERE id = ? AND tenant_id = ?')
      .run(request.params.id, request.tenantId)
    return { success: true }
  })
}
