const DAY_MS = 24 * 60 * 60 * 1000

function agentIdExpression(alias = 'audit_log') {
  return `CASE
    WHEN json_valid(${alias}.metadata) THEN COALESCE(
      json_extract(${alias}.metadata, '$.agentId'),
      json_extract(${alias}.metadata, '$.agent_id')
    )
    ELSE NULL
  END`
}

function fillDailySeries(rows, days = 30) {
  const byDay = new Map(rows.map(row => [row.day, row]))
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (days - index - 1) * DAY_MS)
    const day = date.toISOString().slice(0, 10)
    const row = byDay.get(day)
    return {
      day,
      interactions: Number(row?.interactions || 0),
      risk_events: Number(row?.risk_events || 0),
    }
  })
}

export default async function analyticsRoutes(fastify) {
  const db = fastify.db
  const auditAgentId = agentIdExpression('al')

  fastify.get('/overview', async (request) => {
    const tenantId = request.tenantId
    const now = Date.now()
    const last30d = now - 30 * DAY_MS
    const prev30d = last30d - 30 * DAY_MS

    const total30d = await db.get(`
      SELECT COUNT(*) AS count
      FROM audit_log
      WHERE tenant_id = ? AND ts > ?
    `, [tenantId, last30d]).count

    const prevTotal30d = await db.get(`
      SELECT COUNT(*) AS count
      FROM audit_log
      WHERE tenant_id = ? AND ts BETWEEN ? AND ?
    `, [tenantId, prev30d, last30d]).count

    const eventSummary = await db.get(`
      SELECT
        SUM(CASE WHEN risk_score > 20 THEN 1 ELSE 0 END) AS risk_events,
        SUM(CASE WHEN action IN ('guard_block', 'proxy_blocked') THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN action = 'dlp_detected' THEN 1 ELSE 0 END) AS dlp
      FROM audit_log
      WHERE tenant_id = ? AND ts > ?
    `, [tenantId, last30d])

    const topAgents = await db.all(`
      SELECT
        a.id,
        a.name,
        COUNT(al.id) AS interactions,
        ROUND(AVG(al.risk_score), 1) AS avg_risk
      FROM audit_log al
      JOIN agents a
        ON a.id = ${auditAgentId}
       AND a.tenant_id = al.tenant_id
      WHERE al.tenant_id = ? AND al.ts > ?
      GROUP BY a.id, a.name
      ORDER BY interactions DESC, a.name ASC
      LIMIT 5
    `, [tenantId, last30d])

    const dailyRows = await db.all(`
      SELECT
        date(ts / 1000, 'unixepoch') AS day,
        COUNT(*) AS interactions,
        SUM(CASE WHEN risk_score > 20 THEN 1 ELSE 0 END) AS risk_events
      FROM audit_log
      WHERE tenant_id = ? AND ts > ?
      GROUP BY day
      ORDER BY day ASC
    `, [tenantId, last30d])

    const riskDistribution = await db.get(`
      SELECT
        SUM(CASE WHEN risk_score <= 20 THEN 1 ELSE 0 END) AS nominal,
        SUM(CASE WHEN risk_score BETWEEN 21 AND 50 THEN 1 ELSE 0 END) AS elevated,
        SUM(CASE WHEN risk_score > 50 THEN 1 ELSE 0 END) AS critical
      FROM audit_log
      WHERE tenant_id = ? AND ts > ?
    `, [tenantId, last30d])

    const trend = prevTotal30d > 0
      ? Math.round(((total30d - prevTotal30d) / prevTotal30d) * 100)
      : 0

    return {
      period: '30d',
      summary: {
        totalInteractions: total30d,
        trend,
        riskEvents: Number(eventSummary.risk_events || 0),
        blockedRequests: Number(eventSummary.blocked || 0),
        dlpEvents: Number(eventSummary.dlp || 0),
      },
      topAgents: topAgents.map(agent => ({
        ...agent,
        interactions: Number(agent.interactions),
        avg_risk: Number(agent.avg_risk || 0),
      })),
      dailyActivity: fillDailySeries(dailyRows),
      riskDistribution: {
        nominal: Number(riskDistribution.nominal || 0),
        elevated: Number(riskDistribution.elevated || 0),
        critical: Number(riskDistribution.critical || 0),
      },
    }
  })

  fastify.get('/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params
    const tenantId = request.tenantId
    const last30d = Date.now() - 30 * DAY_MS

    const agent = await db.get(`
      SELECT id, name
      FROM agents
      WHERE id = ? AND tenant_id = ?
    `, [agentId, tenantId])
    if (!agent) return reply.code(404).send({ error: 'not_found' })

    const stats = await db.get(`
      SELECT
        COUNT(*) AS total,
        ROUND(AVG(risk_score), 1) AS avg_risk,
        MAX(risk_score) AS max_risk,
        SUM(CASE WHEN action IN ('guard_block', 'proxy_blocked') THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN action = 'dlp_detected' THEN 1 ELSE 0 END) AS dlp
      FROM audit_log
      WHERE tenant_id = ?
        AND ${agentIdExpression('audit_log')} = ?
        AND ts > ?
    `, [tenantId, agentId, last30d])

    const dailyRows = await db.all(`
      SELECT
        date(ts / 1000, 'unixepoch') AS day,
        COUNT(*) AS interactions,
        SUM(CASE WHEN risk_score > 20 THEN 1 ELSE 0 END) AS risk_events
      FROM audit_log
      WHERE tenant_id = ?
        AND ${agentIdExpression('audit_log')} = ?
        AND ts > ?
      GROUP BY day
      ORDER BY day ASC
    `, [tenantId, agentId, last30d])

    return {
      agentId,
      agentName: agent.name,
      period: '30d',
      stats: {
        total: Number(stats.total || 0),
        avgRisk: Number(stats.avg_risk || 0),
        maxRisk: Number(stats.max_risk || 0),
        blocked: Number(stats.blocked || 0),
        dlp: Number(stats.dlp || 0),
      },
      daily: fillDailySeries(dailyRows),
    }
  })
}
