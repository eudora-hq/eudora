import { TIER_LIMITS } from '../../../shared/constants/tierLimits.js'

const windows = new Map() // tenantId -> [timestamp, ...]
const WINDOW_MS = 60 * 1000

export function rateLimiter(request, reply, done) {
  if (process.env.SELF_HOSTED === 'true') return done()

  const tenantId = request.tenantId
  const plan = request.tenant?.plan
  const limit = TIER_LIMITS[plan]?.requests_per_minute ?? 60

  if (limit === Infinity) return done()

  const now = Date.now()
  const windowStart = now - WINDOW_MS

  const timestamps = (windows.get(tenantId) || []).filter((t) => t > windowStart)
  timestamps.push(now)
  windows.set(tenantId, timestamps)

  if (timestamps.length > limit) {
    const retryAfter = Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000)
    reply.code(429).send({ error: 'rate_limit_exceeded', retryAfter })
    return done()
  }

  done()
}
