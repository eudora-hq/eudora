import getDb from '../db/client.js'
import { decrypt } from '../utils/encryption.js'
import { sanitise } from '../security/sanitiser.js'
import { guard } from '../security/guardLayer.js'
import { score } from '../security/riskScorer.js'
import { enforceScope } from '../security/scopeEnforcer.js'
import { log } from '../audit/auditLogger.js'
import { record } from '../audit/traceRecorder.js'
import { getHumanRoot } from '../utils/ownershipChain.js'
import { nanoid } from 'nanoid'
import { resolveModel } from '../utils/resolveModel.js'

function extractOpenAIMessage(body) {
  const messages = body.messages || []
  const last = messages[messages.length - 1]
  return last?.content || ''
}

function extractAnthropicMessage(body) {
  const messages = body.messages || []
  const last = messages[messages.length - 1]
  if (typeof last?.content === 'string') return last.content
  if (Array.isArray(last?.content)) {
    return last.content.find((block) => block.type === 'text')?.text || ''
  }
  return ''
}

function extractOpenAIResponseText(data) {
  return data?.choices?.[0]?.message?.content || ''
}

function extractAnthropicResponseText(data) {
  const first = data?.content?.[0]
  return typeof first?.text === 'string' ? first.text : ''
}

function buildRefusal(providerName) {
  if (providerName === 'anthropic') {
    return {
      id: `msg_eudora_${nanoid(8)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'This request was blocked by the Eudora compliance layer.' }],
      model: 'eudora-guard',
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  return {
    id: `chatcmpl-eudora-${nanoid(8)}`,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'This request was blocked by the Eudora compliance layer.' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function getApiCredential(apiKey) {
  if (!apiKey?.key_encrypted) return null
  return decrypt(apiKey.key_encrypted, apiKey.key_iv)
}

export default async function proxyRoutes(fastify) {
  const db = fastify.db ?? getDb()

  async function authenticateProxy(request, reply) {
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith('Bearer eudora-proxy-')) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Invalid proxy key',
      })
    }

    const providedKey = auth.replace('Bearer ', '')
    const agent = db.prepare(`
      SELECT * FROM agents
      WHERE ? LIKE proxy_key_prefix || '%'
        AND agent_type = 'external'
      LIMIT 1
    `).get(providedKey)

    if (!agent) return reply.code(401).send({ error: 'unauthorized' })

    try {
      const storedKey = decrypt(agent.proxy_key_encrypted, agent.proxy_key_iv)
      if (storedKey !== providedKey) return reply.code(401).send({ error: 'unauthorized' })
    } catch {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    request.proxyAgent = agent
    request.tenantId = agent.tenant_id
  }

  function runCompliancePipeline(agent, userMessage, providerName) {
    const startedAt = Date.now()
    const sanitiserResult = sanitise(userMessage)
    const guardResult = guard(sanitiserResult, agent.purpose)
    const riskScore = score(sanitiserResult, guardResult, { compliant: true, violation: null })

    return {
      providerName,
      sanitiserResult,
      guardResult,
      riskScore,
      startedAt,
      runId: nanoid(),
    }
  }

  function auditProxy(
    agent,
    pipeline,
    blocked,
    responseText = '',
    scopeResult = null,
    resolvedModel = null
  ) {
    const ownerChain = JSON.parse(agent.owner_chain || '[]')
    const humanRoot = agent.owner_type === 'human'
      ? agent.owner_id
      : getHumanRoot(db, agent.id, agent.tenant_id)

    const finalRiskScore = scopeResult
      ? score(pipeline.sanitiserResult, pipeline.guardResult, scopeResult)
      : pipeline.riskScore

    log({
      tenantId: agent.tenant_id,
      userId: humanRoot || agent.owner_id,
      initiatedByUserId: humanRoot || agent.owner_id,
      agentChain: [agent.id, ...ownerChain],
      action: blocked ? 'proxy_blocked' : 'proxy_forwarded',
      response: responseText,
      riskScore: finalRiskScore,
      resolvedModel,
      metadata: {
        agentId: agent.id,
        runId: pipeline.runId,
        provider: pipeline.providerName,
        interceptionMode: agent.interception_mode,
        disclosureMade: true,
        disclosureMethod: 'system_prompt',
        outputSummary: responseText.substring(0, 200),
        injectionDetected: pipeline.sanitiserResult.flagged,
        patterns: pipeline.sanitiserResult.patterns,
        guardViolation: pipeline.guardResult.violation,
        scopeViolation: scopeResult?.violation || null,
      },
    }, db)

    record({
      tenantId: agent.tenant_id,
      intent: `proxy_${pipeline.providerName}`,
      contextInjected: [],
      tokensUsed: 0,
      durationMs: Date.now() - pipeline.startedAt,
      riskScore: finalRiskScore,
    }, db)
  }

  async function getAgentApiKey(agent, reply) {
    const apiKey = db.prepare(
      'SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?'
    ).get(agent.api_key_id, agent.tenant_id)

    if (!apiKey && agent.endpoint_url) {
      return {
        tenant_id: agent.tenant_id,
        provider: agent.provider_hint,
        base_url: agent.endpoint_url,
        default_model: null,
        key_encrypted: null,
        key_iv: null,
      }
    }
    if (!apiKey) {
      reply.code(503).send({ error: 'no_api_key' })
      return null
    }

    return apiKey
  }

  function proxyModel(agent, apiKey, requestModel = null) {
    return resolveModel(agent, apiKey) || requestModel || null
  }

  function endpoint(base, path) {
    return `${String(base).replace(/\/+$/, '')}${path}`
  }

  fastify.post('/openai/v1/chat/completions', {
    preHandler: authenticateProxy,
  }, async (request, reply) => {
    const agent = request.proxyAgent
    const pipeline = runCompliancePipeline(agent, extractOpenAIMessage(request.body), 'openai')
    const configuredConnection = agent.api_key_id
      ? db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(agent.api_key_id, agent.tenant_id)
      : null
    const blockedModel = proxyModel(agent, configuredConnection, request.body?.model)
    const shouldBlock = agent.interception_mode === 'block' && pipeline.guardResult.allowed === false

    if (shouldBlock) {
      auditProxy(agent, pipeline, true, '', null, blockedModel)
      return reply.code(400).send(buildRefusal('openai'))
    }

    const apiKey = await getAgentApiKey(agent, reply)
    if (!apiKey) return
    const decryptedKey = getApiCredential(apiKey)
    const resolvedModel = proxyModel(agent, apiKey, request.body?.model)
    const body = resolvedModel ? { ...request.body, model: resolvedModel } : request.body
    const targetUrl = agent.endpoint_url
      ? endpoint(agent.endpoint_url, '/v1/chat/completions')
      : 'https://api.openai.com/v1/chat/completions'

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(decryptedKey ? { Authorization: `Bearer ${decryptedKey}` } : {}),
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    const responseText = extractOpenAIResponseText(data)
    auditProxy(agent, pipeline, false, responseText, enforceScope(responseText, agent.purpose), resolvedModel)
    return reply.code(response.status).send(data)
  })

  fastify.post('/anthropic/v1/messages', {
    preHandler: authenticateProxy,
  }, async (request, reply) => {
    const agent = request.proxyAgent
    const pipeline = runCompliancePipeline(agent, extractAnthropicMessage(request.body), 'anthropic')
    const configuredConnection = agent.api_key_id
      ? db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(agent.api_key_id, agent.tenant_id)
      : null
    const blockedModel = proxyModel(agent, configuredConnection, request.body?.model)
    const shouldBlock = agent.interception_mode === 'block' && pipeline.guardResult.allowed === false

    if (shouldBlock) {
      auditProxy(agent, pipeline, true, '', null, blockedModel)
      return reply.code(400).send(buildRefusal('anthropic'))
    }

    const apiKey = await getAgentApiKey(agent, reply)
    if (!apiKey) return
    const decryptedKey = getApiCredential(apiKey)
    const resolvedModel = proxyModel(agent, apiKey, request.body?.model)
    const body = resolvedModel ? { ...request.body, model: resolvedModel } : request.body
    const targetUrl = agent.endpoint_url
      ? endpoint(agent.endpoint_url, '/v1/messages')
      : 'https://api.anthropic.com/v1/messages'

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(decryptedKey ? { 'x-api-key': decryptedKey } : {}),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    const responseText = extractAnthropicResponseText(data)
    auditProxy(agent, pipeline, false, responseText, enforceScope(responseText, agent.purpose), resolvedModel)
    return reply.code(response.status).send(data)
  })

  fastify.post('/azure/:resource/openai/deployments/:model/chat/completions', {
    preHandler: authenticateProxy,
  }, async (request, reply) => {
    const agent = request.proxyAgent
    const { resource, model } = request.params
    const apiVersion = request.query['api-version'] || '2024-02-01'
    const pipeline = runCompliancePipeline(agent, extractOpenAIMessage(request.body), 'azure')
    const configuredConnection = agent.api_key_id
      ? db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(agent.api_key_id, agent.tenant_id)
      : null
    const blockedModel = proxyModel(agent, configuredConnection, model)
    const shouldBlock = agent.interception_mode === 'block' && pipeline.guardResult.allowed === false

    if (shouldBlock) {
      auditProxy(agent, pipeline, true, '', null, blockedModel)
      return reply.code(400).send(buildRefusal('openai'))
    }

    const apiKey = await getAgentApiKey(agent, reply)
    if (!apiKey) return
    const decryptedKey = getApiCredential(apiKey)
    const resolvedModel = proxyModel(agent, apiKey, model)
    const url = agent.endpoint_url
      ? endpoint(agent.endpoint_url, `/openai/deployments/${resolvedModel}/chat/completions?api-version=${apiVersion}`)
      : `https://${resource}.openai.azure.com/openai/deployments/${resolvedModel}/chat/completions?api-version=${apiVersion}`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': decryptedKey,
      },
      body: JSON.stringify(request.body),
    })

    const data = await response.json()
    const responseText = extractOpenAIResponseText(data)
    auditProxy(agent, pipeline, false, responseText, enforceScope(responseText, agent.purpose), resolvedModel)
    return reply.code(response.status).send(data)
  })

  fastify.post('/custom/:agentId/v1/chat/completions', {
    preHandler: authenticateProxy,
  }, async (request, reply) => {
    const agent = request.proxyAgent
    const pipeline = runCompliancePipeline(agent, extractOpenAIMessage(request.body), 'custom')
    const configuredConnection = agent.api_key_id
      ? db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(agent.api_key_id, agent.tenant_id)
      : null
    const blockedModel = proxyModel(agent, configuredConnection, request.body?.model)
    const shouldBlock = agent.interception_mode === 'block' && pipeline.guardResult.allowed === false

    if (shouldBlock) {
      auditProxy(agent, pipeline, true, '', null, blockedModel)
      return reply.code(400).send(buildRefusal('openai'))
    }

    const apiKey = await getAgentApiKey(agent, reply)
    if (!apiKey) return
    const decryptedKey = getApiCredential(apiKey)
    const resolvedModel = proxyModel(agent, apiKey, request.body?.model)
    const headers = { 'Content-Type': 'application/json' }
    if (decryptedKey) headers.Authorization = `Bearer ${decryptedKey}`

    const response = await fetch(endpoint(agent.endpoint_url || apiKey.base_url, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(resolvedModel ? { ...request.body, model: resolvedModel } : request.body),
    })

    const data = await response.json()
    const responseText = extractOpenAIResponseText(data)
    auditProxy(agent, pipeline, false, responseText, enforceScope(responseText, agent.purpose), resolvedModel)
    return reply.code(response.status).send(data)
  })
}
