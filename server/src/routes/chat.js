import { nanoid } from 'nanoid'
import { classify } from '../core/classifier.js'
import { retrieve } from '../core/contextRetriever.js'
import { compose } from '../core/promptComposer.js'
import {
  relay,
  InvalidApiKeyError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../core/modelRelay.js'
import { isUnderLimit } from '../billing/canAccess.js'
import { sanitise } from '../security/sanitiser.js'
import { guard } from '../security/guardLayer.js'
import { enforceScope } from '../security/scopeEnforcer.js'
import { score } from '../security/riskScorer.js'
import { log, AUDIT_ACTIONS } from '../audit/auditLogger.js'
import { record } from '../audit/traceRecorder.js'
import { createNotification } from '../utils/notify.js'

export default async function chatRoutes(fastify) {
  const db = fastify.db

  // POST /chat
  fastify.post('/', async (request, reply) => {
    const startTime = Date.now()
    const { agentId, conversationId: incomingConvId, message } = request.body || {}

    if (!agentId) return reply.code(400).send({ error: 'agentId is required' })
    if (!message) return reply.code(400).send({ error: 'message is required' })

    const agent = db
      .prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?')
      .get(agentId, request.tenantId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (agent.status && agent.status !== 'live') {
      return reply.code(403).send({
        error: 'agent_not_live',
        message: `Agent status is '${agent.status}'. Agent must be approved before use.`,
      })
    }

    if (!isUnderLimit(db, request.tenantId, request.tenant.plan, 'messages_per_day')) {
      return reply.code(429).send({ error: 'daily_limit_reached', upgradeUrl: '/billing' })
    }

    let conversationId = incomingConvId
    if (!conversationId) {
      conversationId = nanoid()
      db.prepare(
        'INSERT INTO conversations (id, tenant_id, agent_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(conversationId, request.tenantId, agentId, request.user.userId, Date.now())
    } else {
      const conv = db
        .prepare('SELECT id, tenant_id FROM conversations WHERE id = ?')
        .get(conversationId)
      if (!conv) return reply.code(404).send({ error: 'conversation_not_found' })
      if (conv.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })
    }

    db.prepare(
      'INSERT INTO messages (id, conversation_id, tenant_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(nanoid(), conversationId, request.tenantId, 'user', message, Date.now())

    try {
      // Step 1 — Sanitise
      const sanitiserResult = sanitise(message)

      // Step 2 — Classify (using sanitised input)
      const { intent } = await classify(sanitiserResult.sanitised, agent.api_key_id, request.tenantId)

      // Step 3 — Retrieve
      const { files, excluded } = await retrieve(
        agentId,
        intent,
        request.tenantId,
        sanitiserResult.sanitised
      )

      // Step 4 — Compose
      const composed = compose(agent.system_prompt || '', files, sanitiserResult.sanitised)

      // Step 5 — Guard check (before relay)
      const guardResult = guard(sanitiserResult, agent.purpose)
      if (!guardResult.allowed) {
        const riskScore = score(sanitiserResult, guardResult, { compliant: true, violation: null })
        const durationMs = Date.now() - startTime
        log({
          tenantId: request.tenantId,
          userId: request.user.userId,
          initiatedByUserId: request.user.userId,
          agentChain: [],
          action: AUDIT_ACTIONS.GUARD_BLOCK,
          prompt: message,
          riskScore,
          metadata: { violation: guardResult.violation, agentId },
        })
        record({
          tenantId: request.tenantId,
          conversationId,
          intent,
          contextInjected: composed.contextFilesUsed,
          tokensUsed: 0,
          durationMs,
          riskScore,
        })
        if (sanitiserResult.dlpDetected) {
          createNotification(db, {
            tenantId: request.tenantId,
            type: 'dlp_detected',
            title: 'Credential detected and blocked',
            message: `A credential or secret was detected in a message to agent "${agent.name}" and was redacted.`,
            actionUrl: '/audit',
          })
        }
        createNotification(db, {
          tenantId: request.tenantId,
          type: 'agent_blocked',
          title: 'Agent request blocked',
          message: `A request to agent "${agent.name}" was blocked by the security layer.`,
          actionUrl: '/audit',
        })
        createHighRiskNotification(db, request.tenantId, agent.name, riskScore)
        return reply.code(400).send({
          error: 'request_blocked',
          message: 'Your message was blocked by the security layer.',
          violation: guardResult.violation,
        })
      }

      // Step 6 — Relay
      const { content, tokensUsed } = await relay(composed, agent.api_key_id, request.tenantId)

      // Step 7 — Scope check
      const scopeResult = enforceScope(content, agent.purpose)

      // Step 8 — Risk score
      const riskScore = score(sanitiserResult, guardResult, scopeResult)
      createHighRiskNotification(db, request.tenantId, agent.name, riskScore)

      // Step 9 — Store assistant message
      db.prepare(
        'INSERT INTO messages (id, conversation_id, tenant_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(nanoid(), conversationId, request.tenantId, 'assistant', content, Date.now())

      // Step 10 — Usage event
      db.prepare(
        'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
      ).run(nanoid(), request.tenantId, 'message', tokensUsed.total, Date.now())

      // Step 11 — Audit log (fire-and-forget)
      log({
        tenantId: request.tenantId,
        userId: request.user.userId,
        initiatedByUserId: request.user.userId,
        agentChain: [],
        action: AUDIT_ACTIONS.CHAT_MESSAGE,
        prompt: message,
        response: content,
        context: composed.messages[0].content,
        riskScore,
        metadata: {
          agentId,
          conversationId,
          intent,
          contextFilesUsed: composed.contextFilesUsed,
          scopeViolation: scopeResult.violation,
          injectionPatterns: sanitiserResult.patterns,
        },
      })

      if (sanitiserResult.flagged) {
        log({
          tenantId: request.tenantId,
          userId: request.user.userId,
          initiatedByUserId: request.user.userId,
          agentChain: [],
          action: AUDIT_ACTIONS.INJECTION_DETECTED,
          prompt: message,
          riskScore,
          metadata: { patterns: sanitiserResult.patterns, agentId },
        })
      }

      if (!scopeResult.compliant) {
        log({
          tenantId: request.tenantId,
          userId: request.user.userId,
          initiatedByUserId: request.user.userId,
          agentChain: [],
          action: AUDIT_ACTIONS.SCOPE_VIOLATION,
          response: content,
          riskScore,
          metadata: { violation: scopeResult.violation, agentId },
        })
      }

      // Step 12 — Trace record (fire-and-forget)
      const durationMs = Date.now() - startTime
      record({
        tenantId: request.tenantId,
        conversationId,
        intent,
        contextInjected: composed.contextFilesUsed,
        tokensUsed: tokensUsed.total,
        durationMs,
        riskScore,
      })

      // Step 13 — Response
      return reply.send({
        conversationId,
        content,
        tokensUsed,
        intent,
        contextFilesUsed: composed.contextFilesUsed,
        excluded: excluded.map((e) => ({ id: e.id, filename: e.filename, reason: e.reason })),
        riskScore,
        durationMs,
      })
    } catch (err) {
      if (err instanceof InvalidApiKeyError) {
        return reply.code(400).send({
          error: 'invalid_api_key',
          message: 'The API key for this agent is invalid. Please update it in Settings.',
        })
      }
      if (err instanceof ProviderRateLimitError) {
        return reply.code(429).send({
          error: 'provider_rate_limit',
          message: 'The AI provider is rate limiting requests. Please try again in a moment.',
        })
      }
      if (err instanceof ProviderUnavailableError) {
        return reply.code(503).send({
          error: 'provider_unavailable',
          message: 'The AI provider is currently unavailable. Please try again later.',
        })
      }
      return reply.code(500).send({ error: 'internal_error' })
    }
  })

  // GET /chat/conversations
  fastify.get('/conversations', async (request, reply) => {
    const rows = db
      .prepare(
        'SELECT id, agent_id, created_at FROM conversations WHERE tenant_id = ? ORDER BY created_at DESC'
      )
      .all(request.tenantId)
    return reply.send(rows)
  })

  // GET /chat/conversations/:id/messages
  fastify.get('/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params
    const conv = db.prepare('SELECT id, tenant_id FROM conversations WHERE id = ?').get(id)
    if (!conv) return reply.code(404).send({ error: 'not_found' })
    if (conv.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    const messages = db
      .prepare(
        'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(id)
    return reply.send(messages)
  })

  // GET /chat/conversations/:id/trace
  fastify.get('/conversations/:id/trace', async (request, reply) => {
    const { id } = request.params
    const conv = db.prepare('SELECT id, tenant_id FROM conversations WHERE id = ?').get(id)
    if (!conv) return reply.code(404).send({ error: 'not_found' })
    if (conv.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    const traces = db
      .prepare('SELECT * FROM traces WHERE conversation_id = ? AND tenant_id = ? ORDER BY ts ASC')
      .all(id, request.tenantId)

    return reply.send(
      traces.map(t => ({ ...t, context_injected: JSON.parse(t.context_injected) }))
    )
  })
}

function createHighRiskNotification(db, tenantId, agentName, riskScore) {
  if (riskScore <= 70) return

  createNotification(db, {
    tenantId,
    type: 'high_risk',
    title: 'High-risk interaction detected',
    message: `Risk score ${riskScore}/100 on agent "${agentName}". Review in audit log.`,
    actionUrl: '/audit',
  })
}
