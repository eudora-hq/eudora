import { nanoid } from 'nanoid'
import { createHmac } from 'crypto'
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
  const context = {
    workflow,
    workflowId,
    urlFetchCount: 0,
    maxUrlFetches: 10,
  }

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
        const result = await executeNode(node, input, tenantId, db, context)
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

async function executeNode(node, input, tenantId, db, context = {}) {
  const startedAt = Date.now()

  if (node.type === 'fetch_url') {
    return executeFetchUrlNode(node, input, tenantId, db, context, startedAt)
  }

  if (node.type === 'fetch_api') {
    return executeFetchApiNode(node, input, tenantId, db, context, startedAt)
  }

  if (node.type === 'webhook_out') {
    return executeWebhookOutNode(node, input, tenantId, db, context, startedAt)
  }

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

async function executeFetchUrlNode(node, input, tenantId, db, context, startedAt) {
  if (context.urlFetchCount >= context.maxUrlFetches) {
    return {
      nodeId: node.id,
      agentId: null,
      output: 'URL fetch limit reached (max 10 per run)',
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'skipped',
      error: 'rate_limit',
    }
  }

  context.urlFetchCount += 1
  const url = resolveFetchUrl(node, input)

  if (!url || !String(url).startsWith('http')) {
    return {
      nodeId: node.id,
      agentId: null,
      output: 'Invalid URL',
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: 'invalid_url',
    }
  }

  let timeout
  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Eudora-Research-Agent/1.0' },
    })

    if (!response.ok) {
      return {
        nodeId: node.id,
        agentId: null,
        output: `HTTP ${response.status}`,
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: 'fetch_failed',
      }
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text')) {
      return {
        nodeId: node.id,
        agentId: null,
        output: 'Non-text content',
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: 'non_text_content',
      }
    }

    let text = await response.text()
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const maxChars = 50000
    if (text.length > maxChars) {
      text = `${text.substring(0, maxChars)}\n\n[Content truncated at 50,000 characters]`
    }

    log({
      tenantId,
      userId: null,
      action: 'url_fetched',
      riskScore: 0,
      metadata: {
        url,
        contentLength: text.length,
        workflowId: context.workflowId,
      },
    }, db)

    return {
      nodeId: node.id,
      agentId: null,
      output: text,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'success',
    }
  } catch (err) {
    return {
      nodeId: node.id,
      agentId: null,
      output: err.name === 'AbortError' ? 'Request timed out' : err.message,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err.name === 'AbortError' ? 'timeout' : 'fetch_error',
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function resolveFetchUrl(node, input) {
  if (node.config?.url) return node.config.url

  const raw = String(input || '').trim()
  const labelMatch = String(node.label || '').match(/(\d+)/)
  const preferredIndex = Number.isInteger(node.config?.urlIndex)
    ? node.config.urlIndex
    : Math.max(0, Number(labelMatch?.[1] || 1) - 1)

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const urls = parsed.filter(item => typeof item === 'string' && item.startsWith('http'))
      return urls[preferredIndex] || urls[0] || raw
    }
  } catch {
    // Fall through to text URL extraction.
  }

  const urls = raw.match(/https?:\/\/[^\s"',\]]+/g) || []
  return urls[preferredIndex] || urls[0] || raw
}

async function executeFetchApiNode(node, input, tenantId, db, context, startedAt) {
  const config = node.config || {}
  const url = config.url || input

  if (!url || (!String(url).startsWith('http://') && !String(url).startsWith('https://'))) {
    return {
      nodeId: node.id,
      agentId: null,
      output: 'Invalid URL',
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: 'invalid_url',
    }
  }

  let timeout
  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), 15000)

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Eudora-Workflow/1.0',
      ...parseHeaders(config.headers || ''),
    }

    if (config.authType === 'bearer' && config.authValue) {
      headers.Authorization = `Bearer ${config.authValue}`
    } else if (config.authType === 'basic' && config.authValue) {
      headers.Authorization = `Basic ${Buffer.from(config.authValue).toString('base64')}`
    } else if (config.authType === 'apikey' && config.authValue && config.authHeader) {
      headers[config.authHeader] = config.authValue
    }

    const method = String(config.method || 'GET').toUpperCase()
    const options = {
      method,
      headers,
      signal: controller.signal,
    }

    if (method !== 'GET' && method !== 'HEAD') {
      const configuredBody = config.body
      const body = configuredBody || (method === 'POST' ? input : '')
      if (body) {
        if (typeof body === 'string') {
          try {
            JSON.parse(body)
            options.body = body
          } catch {
            options.body = JSON.stringify({ data: body })
          }
        } else {
          options.body = JSON.stringify(body)
        }
      }
    }

    const response = await fetch(String(url), options)
    const responseText = await response.text()

    let output
    try {
      output = JSON.stringify(JSON.parse(responseText), null, 2)
    } catch {
      output = responseText
    }

    const maxChars = 50000
    if (output.length > maxChars) {
      output = `${output.substring(0, maxChars)}\n\n[Response truncated at 50,000 characters]`
    }

    log({
      tenantId,
      userId: null,
      action: 'api_called',
      riskScore: 0,
      metadata: {
        url: String(url),
        method,
        statusCode: response.status,
        workflowId: context.workflowId,
      },
    }, db)

    if (!response.ok) {
      return {
        nodeId: node.id,
        agentId: null,
        output: `HTTP ${response.status}: ${output}`,
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: 'http_error',
      }
    }

    return {
      nodeId: node.id,
      agentId: null,
      output,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'success',
    }
  } catch (err) {
    return {
      nodeId: node.id,
      agentId: null,
      output: err.name === 'AbortError' ? 'Request timed out' : err.message,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err.name === 'AbortError' ? 'timeout' : 'fetch_error',
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function executeWebhookOutNode(node, input, tenantId, db, context, startedAt) {
  const config = node.config || {}
  const url = config.url

  if (!url || (!String(url).startsWith('http://') && !String(url).startsWith('https://'))) {
    return {
      nodeId: node.id,
      agentId: null,
      output: 'No webhook URL configured',
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: 'missing_url',
    }
  }

  const payloadMode = config.payloadMode || 'auto'
  const payload = buildWebhookPayload(payloadMode, config.customPayload, input, {
    workflowId: context.workflowId,
    nodeId: node.id,
    tenantId,
  })

  let timeout
  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), 10000)

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Eudora-Webhook/1.0',
      'X-Eudora-Workflow': context.workflowId,
      ...parseHeaders(config.headers || ''),
    }

    if (config.secret) {
      const signature = createHmac('sha256', config.secret).update(payload).digest('hex')
      headers['X-Eudora-Signature'] = `sha256=${signature}`
    }

    const response = await fetch(String(url), {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    })
    const responseText = await response.text()

    log({
      tenantId,
      userId: null,
      action: 'webhook_delivered',
      riskScore: 0,
      metadata: {
        url: String(url),
        statusCode: response.status,
        payloadMode,
        workflowId: context.workflowId,
        signed: Boolean(config.secret),
      },
    }, db)

    if (!response.ok) {
      return {
        nodeId: node.id,
        agentId: null,
        output: `Webhook failed - HTTP ${response.status}: ${responseText.substring(0, 200)}`,
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        status: 'failed',
        error: 'http_error',
      }
    }

    const responseSummary = responseText
      ? `: ${responseText.substring(0, 500)}`
      : ''
    return {
      nodeId: node.id,
      agentId: null,
      output: `Webhook delivered - HTTP ${response.status}${responseSummary}`,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'success',
    }
  } catch (err) {
    return {
      nodeId: node.id,
      agentId: null,
      output: err.name === 'AbortError' ? 'Webhook timed out' : err.message,
      tokensUsed: 0,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      error: err.name === 'AbortError' ? 'timeout' : 'delivery_error',
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function buildWebhookPayload(payloadMode, customPayload, input, context) {
  if (payloadMode === 'raw') {
    return typeof input === 'string' ? input : JSON.stringify(input)
  }

  if (payloadMode === 'custom' && customPayload) {
    try {
      const serialisedInput = JSON.stringify(input)
      const template = String(customPayload)
        .replace(/"\{\{input\}\}"/g, serialisedInput)
        .replace(/\{\{input\}\}/g, serialisedInput)
      JSON.parse(template)
      return template
    } catch {
      return JSON.stringify({ data: input })
    }
  }

  return JSON.stringify({
    source: 'eudora',
    workflowId: context.workflowId,
    nodeId: context.nodeId,
    timestamp: new Date().toISOString(),
    data: input,
    tenantId: context.tenantId,
  })
}

function parseHeaders(headersString) {
  if (!headersString) return {}

  const headers = {}
  String(headersString).split('\n').forEach(line => {
    const index = line.indexOf(':')
    if (index <= 0) return

    const key = line.substring(0, index).trim()
    const value = line.substring(index + 1).trim()
    if (key && value) headers[key] = value
  })
  return headers
}
