import {
  createTunnel,
  deleteTunnel,
  getTunnelStatus,
  listTunnels,
  recordHeartbeat,
} from '../services/tunnelService.ts'
import { adaptDatabase } from '../db/index.ts'

const heartbeatWindows = new Map()
const HEARTBEAT_LIMIT = 10
const HEARTBEAT_WINDOW_MS = 60_000

function allowHeartbeat(tunnelId, now = Date.now()) {
  const current = heartbeatWindows.get(tunnelId)
  if (!current || current.resetAt <= now) {
    heartbeatWindows.set(tunnelId, { count: 1, resetAt: now + HEARTBEAT_WINDOW_MS })
    return true
  }
  if (current.count >= HEARTBEAT_LIMIT) return false
  current.count += 1
  return true
}

function bearerToken(request) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  return authorization.slice('Bearer '.length).trim()
}

export default async function tunnelsRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

  fastify.post('/', async (request, reply) => {
    try {
      const tunnel = await createTunnel(db, {
        tenantId: request.tenantId,
        name: request.body?.name,
        localPort: request.body?.local_port,
        localHost: request.body?.local_host,
      })
      return reply.code(201).send(tunnel)
    } catch (err) {
      const knownErrors = new Set([
        'name_required',
        'name_too_long',
        'invalid_local_host',
        'invalid_local_port',
      ])
      if (knownErrors.has(err.message)) {
        return reply.code(400).send({ error: err.message })
      }
      throw err
    }
  })

  fastify.get('/', async (request) => {
    const tunnels = await listTunnels(db, request.tenantId)
    return { tunnels }
  })

  fastify.delete('/:id', async (request, reply) => {
    const tunnel = await db.get(
      'SELECT id FROM tunnels WHERE id = ? AND tenant_id = ?',
      [request.params.id, request.tenantId]
    )
    if (!tunnel) return reply.code(404).send({ error: 'not_found' })

    await deleteTunnel(db, request.tenantId, request.params.id)
    return { deleted: true }
  })

  fastify.get('/:id/status', async (request, reply) => {
    const tunnel = await getTunnelStatus(
      db,
      request.tenantId,
      request.params.id
    )
    if (!tunnel) return reply.code(404).send({ error: 'not_found' })
    return {
      status: tunnel.status,
      last_seen_at: tunnel.last_seen_at,
    }
  })

  fastify.post('/:id/heartbeat', async (request, reply) => {
    if (!allowHeartbeat(request.params.id)) {
      return reply.code(429).send({ error: 'rate_limit_exceeded' })
    }

    const authenticated = await recordHeartbeat(
      db,
      request.params.id,
      bearerToken(request)
    )
    if (!authenticated) {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    return { status: 'active', last_seen_at: Date.now() }
  })
}

export function resetHeartbeatRateLimitsForTests() {
  heartbeatWindows.clear()
}
