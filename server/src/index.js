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
import reportsRoutes from './routes/reports.js'
import { loadAllJobs } from './scheduler/cronRunner.js'

const PORT = process.env.PORT || 3001

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
  runMigrations(db)
  loadAllJobs()
  console.log('[startup] Cron scheduler loaded')
  fastify.decorate('db', db)

  // Public routes: no token required
  const PUBLIC_ROUTES = new Set([
    'GET /health',
    'GET /health/ollama',
    'POST /auth/register',
    'POST /auth/login',
    'POST /auth/refresh',
    'POST /billing/webhook',
    'GET /auth/oauth/callback/openai',
  ])

  fastify.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    const key = `${request.method} ${path}`
    if (PUBLIC_ROUTES.has(key)) return
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

  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }))
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
