import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import { decrypt } from '../utils/encryption.js'
import { getHumanRoot } from '../utils/ownershipChain.js'
import { rateLimiter } from '../middleware/rateLimiter.js'
import { sanitise } from '../security/sanitiser.js'

const ALLOWED_SOURCES = new Set(['langchain', 'crewai'])

function sha256(value) {
  if (value == null) return null
  return createHash('sha256').update(String(value)).digest('hex')
}

function findProxyAgent(db, proxyKey) {
  if (typeof proxyKey !== 'string' || !proxyKey.startsWith('eudora-proxy-')) {
    return null
  }

  const agent = db.prepare(`
    SELECT *
    FROM agents
    WHERE ? LIKE proxy_key_prefix || '%'
      AND agent_type = 'external'
    LIMIT 1
  `).get(proxyKey)
  if (!agent) return null

  try {
    return decrypt(agent.proxy_key_encrypted, agent.proxy_key_iv) === proxyKey
      ? agent
      : null
  } catch {
    return null
  }
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return 'invalid_payload'
  if (!body.agent_id || !body.proxy_key || !body.source) return 'missing_fields'
  if (!Object.prototype.hasOwnProperty.call(body, 'prompt')) return 'missing_fields'
  if (!Object.prototype.hasOwnProperty.call(body, 'response')) return 'missing_fields'
  if (!ALLOWED_SOURCES.has(body.source)) return 'invalid_source'
  if (typeof body.prompt !== 'string' || typeof body.response !== 'string') {
    return 'invalid_fields'
  }
  return null
}

export default async function ingestRoutes(fastify) {
  const db = fastify.db

  async function authenticateIngest(request, reply) {
    const validationError = validatePayload(request.body)
    if (validationError) {
      reply.code(400).send({ error: validationError })
      return
    }

    const agent = findProxyAgent(db, request.body.proxy_key)
    if (!agent || agent.id !== request.body.agent_id) {
      reply.code(401).send({ error: 'unauthorized' })
      return
    }

    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?')
      .get(agent.tenant_id)
    if (!tenant) {
      reply.code(401).send({ error: 'unauthorized' })
      return
    }

    request.proxyAgent = agent
    request.tenantId = agent.tenant_id
    request.tenant = tenant
    await new Promise(resolve => rateLimiter(request, reply, resolve))
  }

  fastify.post('/ingest', {
    preHandler: authenticateIngest,
  }, async (request, reply) => {
    if (reply.sent) return

    const {
      source,
      prompt,
      response,
      model = null,
      latency_ms = null,
      token_usage = {},
      metadata = {},
    } = request.body
    const agent = request.proxyAgent
    const promptScan = sanitise(prompt)
    const responseScan = sanitise(response)
    const patterns = [...new Set([
      ...promptScan.patterns,
      ...responseScan.patterns,
    ])]
    const dlpDetected = promptScan.dlpDetected || responseScan.dlpDetected
    const riskScore = dlpDetected ? 90 : patterns.length > 0 ? 40 : 0
    const humanRoot = agent.owner_type === 'human'
      ? agent.owner_id
      : getHumanRoot(db, agent.id, agent.tenant_id)
    const auditUser = humanRoot || agent.owner_id || db.prepare(`
      SELECT id
      FROM users
      WHERE tenant_id = ?
      ORDER BY role = 'owner' DESC
      LIMIT 1
    `).get(agent.tenant_id)?.id

    if (!auditUser) {
      return reply.code(400).send({ error: 'agent_has_no_accountable_user' })
    }

    let ownerChain = []
    try {
      ownerChain = JSON.parse(agent.owner_chain || '[]')
    } catch {
      ownerChain = []
    }

    const runId = nanoid()
    db.prepare(`
      INSERT INTO audit_log (
        id, tenant_id, user_id, action, prompt_hash, response_hash,
        risk_score, metadata, initiated_by_user_id, agent_chain, ts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      agent.tenant_id,
      auditUser,
      `${source}_ingest`,
      sha256(prompt),
      sha256(response),
      riskScore,
      JSON.stringify({
        source,
        agentId: agent.id,
        model,
        latencyMs: latency_ms,
        tokenUsage: token_usage,
        frameworkMetadata: metadata,
        sanitiserFlagged: patterns.length > 0,
        dlpDetected,
        patterns,
        promptSanitised: promptScan.sanitisedText,
        responseSanitised: responseScan.sanitisedText,
      }),
      auditUser,
      JSON.stringify([agent.id, ...ownerChain]),
      Date.now()
    )

    return reply.send({ status: 'ok', run_id: runId })
  })
}
