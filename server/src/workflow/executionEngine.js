import { nanoid } from 'nanoid'
import { sanitise } from '../security/sanitiser.js'
import { guard } from '../security/guardLayer.js'
import { retrieve } from '../core/contextRetriever.js'
import { compose } from '../core/promptComposer.js'
import { relay } from '../core/modelRelay.js'
import { enforceScope } from '../security/scopeEnforcer.js'
import { score } from '../security/riskScorer.js'
import { log, AUDIT_ACTIONS } from '../audit/auditLogger.js'

export async function executeWorkflow(workflowId, tenantId, db, runId = null, initiatedByUserId = null) {
  const workflow = db
    .prepare('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?')
    .get(workflowId, tenantId)

  if (!workflow) throw new Error('workflow_not_found')

  const activeRunId = runId || getRunningRunId(db, workflowId, tenantId) || nanoid()
  const nodes = JSON.parse(workflow.nodes || '[]')
  const edges = JSON.parse(workflow.edges || '[]')
  const results = []

  try {
    const graph = buildGraph(nodes, edges)
    const completed = new Set()
    const skipped = new Set()
    const outputs = new Map()
    const queue = graph.startNodes.slice()

    while (queue.length > 0) {
      const nodeId = queue.shift()
      if (completed.has(nodeId) || skipped.has(nodeId)) continue

      const node = graph.nodeById.get(nodeId)
      const predecessors = graph.incoming.get(nodeId) || []
      if (!predecessors.every(edge => completed.has(edge.source) || skipped.has(edge.source))) {
        queue.push(nodeId)
        continue
      }

      const blockedByCondition = predecessors.some(edge => {
        if (!edge.condition) return false
        const predecessorOutput = outputs.get(edge.source) || ''
        return !predecessorOutput.toLowerCase().includes(String(edge.condition).toLowerCase())
      })

      if (blockedByCondition || predecessors.some(edge => skipped.has(edge.source))) {
        skipped.add(nodeId)
        results.push({
          nodeId,
          agentId: node.agentId,
          output: '',
          tokensUsed: 0,
          durationMs: 0,
          status: 'skipped',
        })
      } else {
        const input = buildNodeInput(nodeId, workflow.description, predecessors, outputs)
        const result = await executeNode(node, input, tenantId, db)
        results.push(result)
        outputs.set(nodeId, result.output)
        completed.add(nodeId)
      }

      for (const edge of graph.outgoing.get(nodeId) || []) {
        if (!queue.includes(edge.target) && !completed.has(edge.target) && !skipped.has(edge.target)) {
          queue.push(edge.target)
        }
      }
    }

    const totalTokensUsed = results.reduce((sum, result) => sum + (result.tokensUsed || 0), 0)
    db.prepare(
      'UPDATE workflow_runs SET status = ?, node_results = ?, completed_at = ? WHERE id = ? AND tenant_id = ?'
    ).run('success', JSON.stringify(results), Date.now(), activeRunId, tenantId)

    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), tenantId, 'workflow_run', totalTokensUsed, Date.now())

    log({
      tenantId,
      userId: initiatedByUserId,
      initiatedByUserId,
      agentChain: results.map(result => result.agentId).filter(Boolean),
      action: AUDIT_ACTIONS.WORKFLOW_RUN,
      riskScore: results.some(result => result.status === 'failed') ? 50 : 0,
      metadata: {
        workflowId,
        runId: activeRunId,
        status: 'success',
        totalTokensUsed,
      },
    }, db)

    return results
  } catch (err) {
    db.prepare(
      'UPDATE workflow_runs SET status = ?, node_results = ?, completed_at = ? WHERE id = ? AND tenant_id = ?'
    ).run('failed', JSON.stringify(results), Date.now(), activeRunId, tenantId)
    log({
      tenantId,
      userId: initiatedByUserId,
      initiatedByUserId,
      agentChain: results.map(result => result.agentId).filter(Boolean),
      action: AUDIT_ACTIONS.WORKFLOW_RUN,
      riskScore: 75,
      metadata: {
        workflowId,
        runId: activeRunId,
        status: 'failed',
        error: err.message,
      },
    }, db)
    throw err
  }
}

function getRunningRunId(db, workflowId, tenantId) {
  const row = db
    .prepare("SELECT id FROM workflow_runs WHERE workflow_id = ? AND tenant_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(workflowId, tenantId)
  return row?.id || null
}

function buildGraph(nodes, edges) {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const incoming = new Map(nodes.map(node => [node.id, []]))
  const outgoing = new Map(nodes.map(node => [node.id, []]))

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
    outgoing.get(edge.source).push(edge)
    incoming.get(edge.target).push(edge)
  }

  const startNodes = nodes
    .filter(node => incoming.get(node.id).length === 0)
    .map(node => node.id)

  return { nodeById, incoming, outgoing, startNodes }
}

function buildNodeInput(nodeId, description, predecessors, outputs) {
  if (predecessors.length === 0) return description || 'Execute your task'
  return predecessors
    .map(edge => outputs.get(edge.source))
    .filter(Boolean)
    .join('\n\n') || 'Execute your task'
}

async function executeNode(node, input, tenantId, db) {
  const startedAt = Date.now()
  const agent = db
    .prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?')
    .get(node.agentId, tenantId)

  if (!agent) {
    return {
      nodeId: node.id,
      agentId: node.agentId,
      output: '',
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
    }
  }

  try {
    const sanitiserResult = sanitise(input)
    const guardResult = guard(sanitiserResult, agent.purpose)
    if (!guardResult.allowed) {
      return {
        nodeId: node.id,
        agentId: agent.id,
        output: '',
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        status: 'failed',
      }
    }

    const { files } = await retrieve(agent.id, 'custom', tenantId)
    const composed = compose(agent.system_prompt || '', files, sanitiserResult.sanitised)
    const { content, tokensUsed } = await relay(composed, agent.api_key_id, tenantId)
    const scopeResult = enforceScope(content, agent.purpose)
    score(sanitiserResult, guardResult, scopeResult)

    return {
      nodeId: node.id,
      agentId: agent.id,
      output: content,
      tokensUsed: tokensUsed?.total || 0,
      durationMs: Date.now() - startedAt,
      status: 'success',
    }
  } catch (err) {
    return {
      nodeId: node.id,
      agentId: agent.id,
      output: err.message,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
    }
  }
}
