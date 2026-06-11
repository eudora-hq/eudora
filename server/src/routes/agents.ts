import { adaptDatabase } from '../db/index.ts'
import { nanoid } from 'nanoid'
import { isUnderAgentLimit } from '../billing/canAccess.ts'
import { log } from '../audit/auditLogger.ts'
import { encrypt } from '../utils/encryption.ts'
import { validateOwnership } from '../utils/ownershipChain.ts'

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
  const db = adaptDatabase(fastify.db)

  // List all agents for tenant
  fastify.get('/', async (request) => {
    try {
      return await db.all(`
        SELECT a.*,
          u.email AS owner_email,
          pa.name AS owner_agent_name
        FROM agents a
        LEFT JOIN users u ON a.owner_type = 'human' AND u.id = a.owner_id AND u.tenant_id = a.tenant_id
        LEFT JOIN agents pa ON a.owner_type = 'agent' AND pa.id = a.owner_id AND pa.tenant_id = a.tenant_id
        WHERE a.tenant_id = ?
        ORDER BY a.created_at DESC
      `, [request.tenantId]).map(redactAgentSecrets)
    } catch (err) {
      if (!String(err.message || '').includes('no such column')) throw err
      return await db.all(
        'SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at DESC'
      , [request.tenantId]).map(redactAgentSecrets)
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
      endpoint_url,
      default_model,
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
    if (!await isUnderAgentLimit(db, request.tenantId, request.tenant.plan)) {
      return reply.code(403).send({
        error: 'limit_reached',
        message: 'Upgrade to monitor more agents',
        upgradeUrl: '/billing',
      })
    }

    const ownership = await validateOwnership(
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

    await db.query(`
      INSERT INTO agents (
        id, tenant_id, name, purpose, model_provider, api_key_id,
        agent_type, proxy_key_encrypted, proxy_key_iv, proxy_key_prefix,
        provider_hint, interception_mode, status, owner_type, owner_id,
        owner_chain, model_override, endpoint_url, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'external', ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)
    `, [agentId,
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
      default_model?.trim() || null,
      endpoint_url?.trim() || null,
      now])

    log({
      tenantId: request.tenantId,
      userId: request.user.userId,
      action: 'agent_registered_external',
      riskScore: 0,
      metadata: {
        name,
        providerHint: resolvedProvider,
        interceptionMode: mode,
        endpointUrl: endpoint_url?.trim() || null,
        modelOverride: default_model?.trim() || null,
        agentId,
      },
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
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])

    if (!agent) return reply.code(404).send({ error: 'not_found' })
    if (agent.agent_type !== 'external') {
      return reply.code(400).send({ error: 'not_external_agent' })
    }

    const { rawKey, prefix } = generateProxyKey()
    const { ciphertext, iv } = encrypt(rawKey)

    await db.query(`
      UPDATE agents
      SET proxy_key_encrypted = ?, proxy_key_iv = ?, proxy_key_prefix = ?
      WHERE id = ? AND tenant_id = ?
    `, [ciphertext, iv, prefix, request.params.id, request.tenantId])

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
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])

    if (!agent) return reply.code(404).send({ error: 'not_found' })

    await db.query(
      'UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?'
    , ['pending_approval', request.params.id, request.tenantId])

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
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])

    if (!agent) return reply.code(404).send({ error: 'not_found' })
    if (agent.status !== 'pending_approval') {
      return reply.code(400).send({
        error: 'not_pending',
        message: 'Agent must be pending_approval to approve',
      })
    }

    await db.query(
      'UPDATE agents SET status = ? WHERE id = ? AND tenant_id = ?'
    , ['live', request.params.id, request.tenantId])

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
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])

    if (!agent) return reply.code(404).send({ error: 'not_found' })

    await db.query(
      'UPDATE agents SET scope_policy = ? WHERE id = ? AND tenant_id = ?'
    , [JSON.stringify(scopePolicy || {}), request.params.id, request.tenantId])

    return { scopePolicy: scopePolicy || {} }
  })

  // Get single agent
  fastify.get('/:id', async (request, reply) => {
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])
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
      model_override,
      endpoint_url,
    } = request.body

    if (!name || !purpose || !model_provider) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'name, purpose and model_provider are required',
      })
    }
    if (!await isUnderAgentLimit(db, request.tenantId, request.tenant.plan)) {
      return reply.code(403).send({
        error: 'limit_reached',
        message: 'Upgrade to monitor more agents',
        upgradeUrl: '/billing',
      })
    }

    // Resolve ownership — default to the creating user as human owner
    const resolvedOwnerType = owner_type || 'human'
    const resolvedOwnerId = owner_id || request.user.userId

    const ownership = await validateOwnership(
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
    await db.query(
      `INSERT INTO agents
        (id, tenant_id, name, purpose, model_provider, api_key_id, system_prompt,
         owner_type, owner_id, owner_chain, model_override, endpoint_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    , [id,
      request.tenantId,
      name,
      purpose,
      model_provider,
      api_key_id || null,
      system_prompt || null,
      resolvedOwnerType,
      resolvedOwnerId,
      JSON.stringify(ownership.chain),
      model_override?.trim() || null,
      endpoint_url?.trim() || null,
      Date.now()])

    return reply.code(201).send(redactAgentSecrets(
      await db.get('SELECT * FROM agents WHERE id = ?', [id])
    ))
  })

  // Update agent
  fastify.patch('/:id', async (request, reply) => {
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })

    const {
      name,
      purpose,
      model_provider,
      api_key_id,
      system_prompt,
      owner_type,
      owner_id,
      model_override,
      endpoint_url,
    } = request.body
    const nextModelOverride = model_override !== undefined
      ? (model_override?.trim() || null)
      : agent.model_override
    const nextEndpointUrl = endpoint_url !== undefined
      ? (endpoint_url?.trim() || null)
      : agent.endpoint_url

    // If ownership is being changed, validate the new ownership
    if (owner_type || owner_id) {
      const newOwnerType = owner_type || agent.owner_type
      const newOwnerId = owner_id || agent.owner_id

      const ownership = await validateOwnership(
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

      await db.query(
        `UPDATE agents SET
          name = COALESCE(?, name),
          purpose = COALESCE(?, purpose),
          model_provider = COALESCE(?, model_provider),
          api_key_id = COALESCE(?, api_key_id),
          system_prompt = COALESCE(?, system_prompt),
          model_override = ?,
          endpoint_url = ?,
          owner_type = ?,
          owner_id = ?,
          owner_chain = ?
         WHERE id = ? AND tenant_id = ?`
      , [name, purpose, model_provider, api_key_id, system_prompt,
        nextModelOverride, nextEndpointUrl,
        newOwnerType,
        newOwnerId,
        JSON.stringify(ownership.chain),
        request.params.id,
        request.tenantId])
    } else {
      // No ownership change — just update other fields
      await db.query(
        `UPDATE agents SET
          name = COALESCE(?, name),
          purpose = COALESCE(?, purpose),
          model_provider = COALESCE(?, model_provider),
          api_key_id = COALESCE(?, api_key_id),
          system_prompt = COALESCE(?, system_prompt),
          model_override = ?,
          endpoint_url = ?
         WHERE id = ? AND tenant_id = ?`
      , [name, purpose, model_provider, api_key_id, system_prompt,
        nextModelOverride, nextEndpointUrl,
        request.params.id,
        request.tenantId])
    }

    return redactAgentSecrets(
      await db.get('SELECT * FROM agents WHERE id = ?', [request.params.id])
    )
  })

  // Delete agent
  fastify.delete('/:id', async (request, reply) => {
    const agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    await db.query('DELETE FROM agents WHERE id = ? AND tenant_id = ?', [request.params.id, request.tenantId])
    return { success: true }
  })
}
