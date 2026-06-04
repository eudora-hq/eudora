import { nanoid } from 'nanoid'
import { validateOwnership } from '../utils/ownershipChain.js'

export default async function agentsRoutes(fastify) {
  const db = fastify.db

  // List all agents for tenant
  fastify.get('/', async (request) => {
    return db.prepare(
      'SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at DESC'
    ).all(request.tenantId)
  })

  // Get single agent
  fastify.get('/:id', async (request, reply) => {
    const agent = db.prepare(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    return agent
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

    return reply.code(201).send(
      db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
    )
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

    return db.prepare('SELECT * FROM agents WHERE id = ?').get(request.params.id)
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
