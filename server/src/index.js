import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import dotenv from 'dotenv'

dotenv.config()

import getDb from './db/client.js'
import { runMigrations } from './db/migrations/runner.js'
import { authenticate } from './middleware/auth.js'
import { scopeToTenant } from './middleware/tenantScope.js'
import { checkTrialExpiry } from './middleware/trialExpiry.js'
import { rateLimiter } from './middleware/rateLimiter.js'
import authRoutes from './routes/auth.js'
import agentsRoutes from './routes/agents.js'
import apiKeysRoutes from './routes/apiKeys.js'
import chatRoutes from './routes/chat.js'
import contextRoutes from './routes/context.js'
import auditRoutes from './routes/audit.js'
import billingRoutes from './routes/billing.js'
import cronRoutes from './routes/cron.js'
import workflowsRoutes from './routes/workflows.js'
import onboardingRoutes from './routes/onboarding.js'
import accountRoutes from './routes/account.js'
import proxyRoutes from './routes/proxy.js'
import reportsRoutes, {
  registerArticle50Routes,
  registerReportVerificationRoute,
} from './routes/reports.js'
import teamRoutes from './routes/team.js'
import notificationsRoutes from './routes/notifications.js'
import integrationsRoutes from './routes/integrations.js'
import analyticsRoutes from './routes/analytics.js'
import ingestRoutes from './routes/ingest.js'
import approvalsRoutes from './routes/approvals.js'
import { loadAllJobs } from './scheduler/cronRunner.js'
import { startApprovalMonitor } from './services/approvalGates.js'

const PORT = process.env.PORT || 3001
const tunnelTokens = new Map()

async function start() {
  const fastify = Fastify({ logger: true })

  await fastify.register(helmet)
  await fastify.register(cors, {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.url.split('?')[0] === '/billing/webhook') {
        done(null, body)
        return
      }

      try {
        const str = body.toString()
        done(null, str.length ? JSON.parse(str) : {})
      } catch (err) {
        done(err)
      }
    }
  )

  const db = getDb()
  await runMigrations(db)
  await loadAllJobs()
  console.log('[startup] Cron scheduler loaded')
  startApprovalMonitor(db, fastify.log)
  fastify.decorate('db', db)

  // Public routes: no token required
  const PUBLIC_ROUTES = new Set([
    'GET /health',
    'GET /health/ollama',
    'POST /auth/register',
    'POST /auth/login',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/accept-invite',
    'POST /auth/refresh',
    'GET /auth/oauth/google',
    'GET /auth/callback/google',
    'GET /auth/oauth/github',
    'GET /auth/callback/github',
    'POST /billing/webhook',
    'GET /auth/oauth/callback/openai',
  ])

  fastify.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    const key = `${request.method} ${path}`
    if (PUBLIC_ROUTES.has(key)) return
    if (process.env.ENABLE_ADMIN === 'true' && path.startsWith('/admin/')) return
    if (path === '/v1/ingest') return
    if (request.method === 'GET' && path.startsWith('/auth/invite/')) return
    if (path.startsWith('/proxy/')) return

    // Chain: authenticate → scopeToTenant → checkTrialExpiry
    await authenticate(request, reply)
    if (reply.sent) return

    await new Promise((res) => scopeToTenant(request, reply, res))
    if (reply.sent) return

    await new Promise((res) => checkTrialExpiry(request, reply, res))
    if (reply.sent) return

    await new Promise((res) => rateLimiter(request, reply, res))
  })

  // auth routes define their own full paths (/auth/* and /users/me)
  fastify.register(authRoutes)
  fastify.register(agentsRoutes, { prefix: '/agents' })
  fastify.register(apiKeysRoutes, { prefix: '/api-keys' })
  fastify.register(chatRoutes, { prefix: '/chat' })
  fastify.register(contextRoutes, { prefix: '/context' })
  fastify.register(auditRoutes, { prefix: '/audit' })
  fastify.register(billingRoutes, { prefix: '/billing' })
  fastify.register(cronRoutes, { prefix: '/cron' })
  fastify.register(workflowsRoutes, { prefix: '/workflows' })
  fastify.register(onboardingRoutes, { prefix: '/onboarding' })
  fastify.register(accountRoutes, { prefix: '/account' })
  fastify.register(proxyRoutes, { prefix: '/proxy' })
  fastify.register(reportsRoutes, { prefix: '/reports' })
  fastify.register(registerReportVerificationRoute, { prefix: '/v1/compliance/reports' })
  fastify.register(registerArticle50Routes, { prefix: '/v1/compliance/article50' })
  fastify.register(teamRoutes, { prefix: '/team' })
  fastify.register(notificationsRoutes, { prefix: '/notifications' })
  fastify.register(integrationsRoutes, { prefix: '/integrations' })
  fastify.register(analyticsRoutes, { prefix: '/analytics' })
  fastify.register(ingestRoutes, { prefix: '/v1' })
  fastify.register(approvalsRoutes, { prefix: '/v1/approvals' })
  if (process.env.ENABLE_ADMIN === 'true') {
    const { default: adminRoutes } = await import('./routes/admin.js')
    await fastify.register(adminRoutes, { prefix: '/admin' })
    fastify.log.info('Admin routes enabled')
  } else {
    fastify.log.info('Admin routes disabled')
  }

  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }))
  fastify.post('/tunnel/token', async (request, reply) => {
    const { targetUrl = 'http://127.0.0.1:11434' } = request.body || {}

    let target
    try {
      target = new URL(targetUrl)
    } catch {
      return reply.code(400).send({ error: 'invalid_target_url' })
    }
    if (!['http:', 'https:'].includes(target.protocol)) {
      return reply.code(400).send({ error: 'invalid_target_url' })
    }

    const crypto = await import('crypto')
    const tunnelToken = crypto.default.randomBytes(24).toString('hex')
    const tenantPrefix = String(request.tenantId)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .substring(0, 8) || 'eudora'
    const subdomain = `${tenantPrefix}-ollama`
    const tunnelUrl = `https://${subdomain}.tunnel.geteudora.com`
    const localPort = target.port || (target.protocol === 'https:' ? '443' : '80')

    tunnelTokens.set(request.tenantId, {
      token: tunnelToken,
      targetUrl: target.toString().replace(/\/+$/, ''),
      subdomain,
      createdAt: Date.now(),
    })

    return reply.send({
      tunnelToken,
      subdomain,
      tunnelUrl,
      instructions: {
        download: 'https://github.com/fatedier/frp/releases',
        config: `[common]
server_addr = tunnel.geteudora.com
server_port = 7000
token = ${tunnelToken}

[ollama]
type = http
local_ip = ${target.hostname}
local_port = ${localPort}
custom_domains = ${subdomain}.tunnel.geteudora.com`,
        command: './frpc -c frpc.toml',
      },
    })
  })
  fastify.post('/tunnel/test', async (request, reply) => {
    const { tunnelUrl } = request.body || {}

    let parsed
    try {
      parsed = new URL(tunnelUrl)
    } catch {
      return reply.code(400).send({ error: 'invalid_tunnel_url' })
    }
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.tunnel.geteudora.com')
    ) {
      return reply.code(400).send({ error: 'invalid_tunnel_url' })
    }

    let timeout
    const startedAt = Date.now()
    try {
      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(
        `${tunnelUrl.replace(/\/+$/, '')}/api/tags`,
        { signal: controller.signal }
      )

      if (!response.ok) {
        return reply.send({
          success: false,
          status: response.status,
          latencyMs: Date.now() - startedAt,
        })
      }

      const data = await response.json().catch(() => ({}))
      return reply.send({
        success: true,
        latencyMs: Date.now() - startedAt,
        models: data.models || [],
      })
    } catch (err) {
      return reply.send({
        success: false,
        error: err.name === 'AbortError' ? 'timeout' : err.message,
        latencyMs: Date.now() - startedAt,
      })
    } finally {
      clearTimeout(timeout)
    }
  })
  fastify.get('/health/system', async (request, reply) => {
    const tenantId = request.tenantId
    const now = Date.now()
    const last24Hours = now - 24 * 60 * 60 * 1000

    const dbSizeBytes = await db.sizeBytes()

    const auditStats = await db.get(`
      SELECT
        COUNT(*) AS total_entries,
        MAX(ts) AS last_entry,
        MIN(ts) AS first_entry
      FROM audit_log
      WHERE tenant_id = ?
    `, [tenantId])

    const agentStats = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN agent_type = 'external' THEN 1 ELSE 0 END) AS external
      FROM agents
      WHERE tenant_id = ?
    `, [tenantId])

    const cronStats = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active
      FROM cron_jobs
      WHERE tenant_id = ?
    `, [tenantId])

    const recentFailures = await db.get(`
      SELECT COUNT(*) AS count
      FROM cron_runs
      WHERE tenant_id = ? AND status = 'failed' AND started_at > ?
    `, [tenantId, last24Hours])

    const riskEvents = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN risk_score > 70 THEN 1 ELSE 0 END) AS high_risk,
        SUM(CASE WHEN action = 'dlp_detected' THEN 1 ELSE 0 END) AS dlp_events
      FROM audit_log
      WHERE tenant_id = ? AND ts > ?
    `, [tenantId, last24Hours])

    const traceStats = await db.get(`
      SELECT COUNT(*) AS total
      FROM traces
      WHERE tenant_id = ?
    `, [tenantId])

    return reply.send({
      status: 'operational',
      timestamp: now,
      database: {
        sizeBytes: dbSizeBytes,
        sizeMB: Math.round((dbSizeBytes / 1024 / 1024) * 100) / 100,
      },
      audit: {
        totalEntries: auditStats.total_entries,
        lastEntry: auditStats.last_entry,
        firstEntry: auditStats.first_entry,
        traceRecords: traceStats.total,
      },
      agents: {
        total: agentStats.total,
        external: agentStats.external || 0,
      },
      scheduler: {
        totalJobs: cronStats.total,
        activeJobs: cronStats.active || 0,
        failuresLast24h: recentFailures.count,
      },
      security: {
        highRiskLast24h: riskEvents.high_risk || 0,
        dlpEventsLast24h: riskEvents.dlp_events || 0,
        totalEventsLast24h: riskEvents.total,
        encryption: 'AES-256-GCM',
        auditIntegrity: 'SHA-256',
      },
      environment: {
        selfHosted: process.env.SELF_HOSTED === 'true',
        nodeVersion: process.version,
      },
    })
  })
  fastify.get('/health/ollama', async (request, reply) => {
    const requestedUrl = request.query.url || 'http://localhost:11434'
    if (
      typeof requestedUrl !== 'string' ||
      (!requestedUrl.startsWith('http://') && !requestedUrl.startsWith('https://'))
    ) {
      return reply.code(400).send({ error: 'invalid_url' })
    }

    const ollamaUrl = requestedUrl.replace(/\/+$/, '')
    let timeout
    try {
      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: controller.signal,
      })

      if (!response.ok) {
        return { ollamaDetected: false, models: [], url: ollamaUrl }
      }

      const data = await response.json()
      const models = (data.models || []).map((model) => ({
        name: model.name,
        size: model.size,
        modified: model.modified_at,
      }))

      return { ollamaDetected: true, models, url: ollamaUrl }
    } catch {
      return { ollamaDetected: false, models: [], url: ollamaUrl }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })

  process.on('SIGINT', async () => {
    await fastify.close()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await fastify.close()
    process.exit(0)
  })

  try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' })
    console.log(`Eudora server running on port ${PORT}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
