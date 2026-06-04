import { nanoid } from 'nanoid'
import { canAccess, isUnderLimit } from '../billing/canAccess.js'
import { executeWorkflow } from '../workflow/executionEngine.js'

function parseWorkflow(row) {
  return {
    ...row,
    nodes: JSON.parse(row.nodes || '[]'),
    edges: JSON.parse(row.edges || '[]'),
  }
}

function parseRun(row) {
  return {
    ...row,
    node_results: JSON.parse(row.node_results || '[]'),
  }
}

export default async function workflowsRoutes(fastify) {
  const db = fastify.db

  fastify.post('/', async (request, reply) => {
    if (!canAccess(db, request.tenantId, 'workflow_builder')) {
      return reply.code(403).send({ error: 'upgrade_required' })
    }
    if (!isUnderLimit(db, request.tenantId, request.tenant.plan, 'workflows')) {
      return reply.code(403).send({ error: 'limit_reached' })
    }

    const { name, description = null, nodes = [], edges = [] } = request.body || {}
    if (!name) return reply.code(400).send({ error: 'name is required' })

    const id = nanoid()
    const now = Date.now()
    db.prepare(
      `INSERT INTO workflows (id, tenant_id, name, description, nodes, edges, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, request.tenantId, name, description, JSON.stringify(nodes), JSON.stringify(edges), now, now)

    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), request.tenantId, 'workflows', 1, now)

    return reply.code(201).send(parseWorkflow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)))
  })

  fastify.get('/', async (request) => {
    return db
      .prepare('SELECT * FROM workflows WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(request.tenantId)
      .map(parseWorkflow)
  })

  fastify.get('/:id', async (request, reply) => {
    const workflow = db
      .prepare('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' })
    return parseWorkflow(workflow)
  })

  fastify.patch('/:id', async (request, reply) => {
    const workflow = db
      .prepare('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' })

    const { name, description, nodes, edges } = request.body || {}
    db.prepare(
      `UPDATE workflows SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        nodes = COALESCE(?, nodes),
        edges = COALESCE(?, edges),
        updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(
      name,
      description,
      nodes === undefined ? null : JSON.stringify(nodes),
      edges === undefined ? null : JSON.stringify(edges),
      Date.now(),
      request.params.id,
      request.tenantId
    )

    return parseWorkflow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(request.params.id))
  })

  fastify.delete('/:id', async (request, reply) => {
    const workflow = db
      .prepare('SELECT id FROM workflows WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' })

    db.prepare('DELETE FROM workflow_runs WHERE workflow_id = ? AND tenant_id = ?').run(request.params.id, request.tenantId)
    db.prepare('DELETE FROM workflows WHERE id = ? AND tenant_id = ?').run(request.params.id, request.tenantId)
    return { success: true }
  })

  fastify.post('/:id/run', async (request, reply) => {
    if (!canAccess(db, request.tenantId, 'workflow_builder')) {
      return reply.code(403).send({ error: 'upgrade_required' })
    }

    const workflow = db
      .prepare('SELECT id FROM workflows WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' })

    const { trigger = 'manual' } = request.body || {}
    const runId = nanoid()
    db.prepare(
      `INSERT INTO workflow_runs (id, tenant_id, workflow_id, status, trigger, node_results, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, request.tenantId, request.params.id, 'running', trigger, '[]', Date.now())

    setImmediate(() => {
      executeWorkflow(request.params.id, request.tenantId, db, runId, request.user.userId).catch((err) => {
        fastify.log.error(err)
      })
    })

    return reply.code(202).send({ runId })
  })

  fastify.get('/:id/runs', async (request, reply) => {
    const workflow = db
      .prepare('SELECT id FROM workflows WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!workflow) return reply.code(404).send({ error: 'workflow_not_found' })

    const { page = 1, limit = 20 } = request.query || {}
    const offset = (Number(page) - 1) * Number(limit)
    const total = db
      .prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId).count
    const runs = db
      .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? AND tenant_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(request.params.id, request.tenantId, Number(limit), offset)
      .map(parseRun)

    return {
      runs,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    }
  })
}
