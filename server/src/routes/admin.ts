import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { seedFeatureFlags } from '../billing/canAccess.ts'
import { adaptDatabase } from '../db/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLAN_PRICES = {
  starter: 99,
  professional: 399,
  enterprise: 999,
}
const VALID_PLANS = ['trial', 'starter', 'professional', 'enterprise']
const SORT_COLUMNS = {
  created_at: 't.created_at',
  plan: 't.plan',
  total_events: 'total_events',
  events_30d: 'events_30d',
}

function requireAdmin(request, reply) {
  const key = request.headers['x-admin-key'] || request.query?.key
  if (!process.env.ADMIN_SECRET || !key || key !== process.env.ADMIN_SECRET) {
    reply.code(401).send({ error: 'unauthorized' })
    return false
  }
  return true
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

export default async function adminRoutes(fastify) {
  const db = adaptDatabase(fastify.db)
  const dayExpression = db.dialect === 'postgres'
    ? "to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
    : "date(created_at / 1000, 'unixepoch')"
  const monthExpression = db.dialect === 'postgres'
    ? "to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM')"
    : "strftime('%Y-%m', created_at / 1000, 'unixepoch')"

  fastify.get('/portal', async (request, reply) => {
    // No auth required — the HTML page itself has a login form that sends the key

    const html = readFileSync(
      resolve(__dirname, '../admin/index.html'),
      'utf8'
    )
    return reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
      )
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(html)
  })

  fastify.get('/overview', async (request, reply) => {
    if (!requireAdmin(request, reply)) return

    const now = Date.now()
    const last30d = now - 30 * 24 * 60 * 60 * 1000
    const last7d = now - 7 * 24 * 60 * 60 * 1000
    const planCounts = await db.all(`
      SELECT plan, COUNT(*) AS count
      FROM tenants
      GROUP BY plan
      ORDER BY plan
    `)
    const newLast30d = (await db.get(`
      SELECT COUNT(*) AS count FROM tenants WHERE created_at > ?
    `, [last30d])).count
    const newLast7d = (await db.get(`
      SELECT COUNT(*) AS count FROM tenants WHERE created_at > ?
    `, [last7d])).count
    const activeLast30d = (await db.get(`
      SELECT COUNT(DISTINCT tenant_id) AS count
      FROM audit_log
      WHERE ts > ?
    `, [last30d])).count
    const trialExpiringSoon = (await db.get(`
      SELECT COUNT(*) AS count
      FROM tenants
      WHERE plan = 'trial' AND trial_ends_at BETWEEN ? AND ?
    `, [now, now + 7 * 24 * 60 * 60 * 1000])).count
    const expiredTrials = (await db.get(`
      SELECT COUNT(*) AS count
      FROM tenants
      WHERE plan = 'trial' AND trial_ends_at < ?
    `, [now])).count
    const totalAuditEvents = (await db.get(`
      SELECT COUNT(*) AS count FROM audit_log
    `)).count
    const dailySignups = await db.all(`
      SELECT
        ${dayExpression} AS day,
        COUNT(*) AS count
      FROM tenants
      WHERE created_at > ?
      GROUP BY day
      ORDER BY day ASC
    `, [last30d])

    const mrr = planCounts.reduce(
      (sum, row) => sum + (PLAN_PRICES[row.plan] || 0) * row.count,
      0
    )

    return reply.send({
      plans: planCounts,
      mrr,
      newLast30d,
      newLast7d,
      activeLast30d,
      trialExpiringSoon,
      expiredTrials,
      totalAuditEvents,
      dailySignups,
      totalTenants: planCounts.reduce((sum, row) => sum + row.count, 0),
    })
  })

  fastify.get('/tenants', async (request, reply) => {
    if (!requireAdmin(request, reply)) return

    const {
      plan,
      sort = 'created_at',
      order = 'desc',
    } = request.query || {}
    if (plan && !VALID_PLANS.includes(plan)) {
      return reply.code(400).send({ error: 'invalid_plan' })
    }

    const limit = boundedInteger(request.query?.limit, 50, 1, 100)
    const offset = boundedInteger(request.query?.offset, 0, 0, 1_000_000)
    const safeSort = SORT_COLUMNS[sort] || SORT_COLUMNS.created_at
    const safeOrder = order === 'asc' ? 'ASC' : 'DESC'
    const last30d = Date.now() - 30 * 24 * 60 * 60 * 1000

    let query = `
      SELECT
        t.id,
        t.name,
        t.plan,
        t.trial_ends_at,
        t.stripe_customer_id,
        t.created_at,
        COUNT(DISTINCT u.id) AS seat_count,
        COUNT(DISTINCT a.id) AS agent_count,
        (SELECT COUNT(*) FROM audit_log al WHERE al.tenant_id = t.id) AS total_events,
        (
          SELECT COUNT(*)
          FROM audit_log al
          WHERE al.tenant_id = t.id AND al.ts > ?
        ) AS events_30d,
        (
          SELECT email
          FROM users
          WHERE tenant_id = t.id AND role = 'owner'
          ORDER BY id
          LIMIT 1
        ) AS owner_email
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id
      LEFT JOIN agents a ON a.tenant_id = t.id
    `
    const params = [last30d]

    if (plan) {
      query += ' WHERE t.plan = ?'
      params.push(plan)
    }

    query += `
      GROUP BY t.id
      ORDER BY ${safeSort} ${safeOrder}
      LIMIT ? OFFSET ?
    `
    params.push(limit, offset)

    const tenants = await db.all(query, params)
    const total = plan
      ? (await db.get('SELECT COUNT(*) AS count FROM tenants WHERE plan = ?', [plan])).count
      : (await db.get('SELECT COUNT(*) AS count FROM tenants')).count

    return reply.send({ tenants, total, limit, offset })
  })

  fastify.get('/tenants/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return

    const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [request.params.id])
    if (!tenant) return reply.code(404).send({ error: 'not_found' })

    const users = await db.all(`
      SELECT id, email, name, role, last_login
      FROM users
      WHERE tenant_id = ?
      ORDER BY role = 'owner' DESC, email ASC
    `, [request.params.id])
    const agents = await db.all(`
      SELECT id, name, agent_type, created_at
      FROM agents
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `, [request.params.id])
    const auditStats = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS last30d,
        SUM(CASE WHEN risk_score > 20 THEN 1 ELSE 0 END) AS risk_events,
        SUM(CASE WHEN action = 'dlp_detected' THEN 1 ELSE 0 END) AS dlp_events,
        SUM(CASE WHEN action = 'guard_block' THEN 1 ELSE 0 END) AS blocked
      FROM audit_log
      WHERE tenant_id = ?
    `, [Date.now() - 30 * 24 * 60 * 60 * 1000, request.params.id])

    return reply.send({
      tenant,
      users,
      agents,
      auditStats: {
        total: auditStats.total || 0,
        last30d: auditStats.last30d || 0,
        risk_events: auditStats.risk_events || 0,
        dlp_events: auditStats.dlp_events || 0,
        blocked: auditStats.blocked || 0,
      },
    })
  })

  fastify.patch('/tenants/:id/plan', async (request, reply) => {
    if (!requireAdmin(request, reply)) return

    const { plan } = request.body || {}
    if (!VALID_PLANS.includes(plan)) {
      return reply.code(400).send({ error: 'invalid_plan' })
    }
    const tenant = await db.get('SELECT id FROM tenants WHERE id = ?', [request.params.id])
    if (!tenant) return reply.code(404).send({ error: 'not_found' })

    await db.transaction(async tx => {
      await tx.query('UPDATE tenants SET plan = ? WHERE id = ?', [plan, request.params.id])
      await seedFeatureFlags(tx, request.params.id, plan)
    })

    return reply.send({ updated: true, plan })
  })

  fastify.get('/revenue', async (request, reply) => {
    if (!requireAdmin(request, reply)) return

    const byPlan = await db.all(`
      SELECT plan, COUNT(*) AS count
      FROM tenants
      WHERE plan IN ('starter', 'professional', 'enterprise')
      GROUP BY plan
      ORDER BY plan
    `)
    const mrr = byPlan.reduce(
      (sum, row) => sum + (PLAN_PRICES[row.plan] || 0) * row.count,
      0
    )
    const monthlyPaid = await db.all(`
      SELECT
        ${monthExpression} AS month,
        plan,
        COUNT(*) AS count
      FROM tenants
      WHERE plan IN ('starter', 'professional', 'enterprise')
      GROUP BY month, plan
      ORDER BY month DESC, plan ASC
      LIMIT 24
    `)

    return reply.send({ byPlan, mrr, arr: mrr * 12, monthlyPaid })
  })
}
