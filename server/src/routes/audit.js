import { adaptDatabase } from '../db/index.js'
import PDFDocument from 'pdfkit'
import { format as stringify } from 'fast-csv'
import { TIER_LIMITS } from '../../../shared/constants/tierLimits.js'
import { canAccess } from '../billing/canAccess.js'
import { verifyAuditRow } from '../audit/verifyAuditRow.ts'

function parseMetadata(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return {}
  }
}

export default async function auditRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

  // GET /audit — paginated audit log with filters
  fastify.get('/', async (request, reply) => {
    const {
      action,
      dateFrom,
      dateTo,
      minRiskScore,
      page = 1,
      limit = 50,
    } = request.query

    const plan = request.tenant?.plan || 'trial'
    const retentionDays = TIER_LIMITS[plan]?.audit_retention_days || 30
    const retentionCutoff = retentionDays === Infinity
      ? 0
      : Date.now() - retentionDays * 24 * 60 * 60 * 1000

    const conditions = ['tenant_id = ?', 'ts >= ?']
    const params = [request.tenantId, retentionCutoff]

    if (action) {
      conditions.push('action = ?')
      params.push(action)
    }
    if (dateFrom) {
      conditions.push('ts >= ?')
      params.push(Number(dateFrom))
    }
    if (dateTo) {
      conditions.push('ts <= ?')
      params.push(Number(dateTo))
    }
    if (minRiskScore !== undefined) {
      conditions.push('risk_score >= ?')
      params.push(Number(minRiskScore))
    }

    const where = conditions.join(' AND ')
    const offset = (Number(page) - 1) * Number(limit)

    const total = await db.get(
      `SELECT COUNT(*) as count FROM audit_log WHERE ${where}`
    , params).count

    const events = await db.all(
      `SELECT id, action, risk_score, metadata, ts FROM audit_log
       WHERE ${where}
       ORDER BY ts DESC
       LIMIT ? OFFSET ?`
    , [...params, Number(limit), offset])
      .map(row => ({
        ...row,
        metadata: parseMetadata(row.metadata),
      }))

    const pages = Math.ceil(total / Number(limit))
    return reply.send({ events, total, page: Number(page), pages })
  })

  fastify.get('/export', async (request, reply) => {
    const { format = 'json', dateFrom, dateTo } = request.query || {}
    const exportFormat = String(format).toLowerCase()

    if (process.env.SELF_HOSTED !== 'true' && !await canAccess(db, request.tenantId, 'audit_export')) {
      return reply.code(403).send({
        error: 'upgrade_required',
        message: 'Audit export is available on Professional and Enterprise plans',
        upgradeUrl: '/billing',
      })
    }

    const conditions = ['tenant_id = ?']
    const params = [request.tenantId]
    if (dateFrom) {
      conditions.push('ts >= ?')
      params.push(Number(dateFrom))
    }
    if (dateTo) {
      conditions.push('ts <= ?')
      params.push(Number(dateTo))
    }

    const events = await db.all(
      `SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY ts ASC`
    , params).map(row => ({
      ...row,
      metadata: parseMetadata(row.metadata),
    }))

    if (exportFormat === 'csv') {
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', 'attachment; filename="eudora-audit.csv"')
      reply.raw.setHeader('Content-Type', 'text/csv')
      reply.raw.setHeader('Content-Disposition', 'attachment; filename="eudora-audit.csv"')

      const csvStream = stringify({ headers: true })
      csvStream.pipe(reply.raw)
      events.forEach(e => csvStream.write({
        id: e.id,
        action: e.action,
        risk_score: e.risk_score,
        timestamp: new Date(e.ts).toISOString(),
        user_id: e.user_id,
        metadata: JSON.stringify(e.metadata),
      }))
      csvStream.end()
      return reply
    }

    if (exportFormat === 'pdf') {
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', 'attachment; filename="eudora-audit.pdf"')
      reply.raw.setHeader('Content-Type', 'application/pdf')
      reply.raw.setHeader('Content-Disposition', 'attachment; filename="eudora-audit.pdf"')

      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' })
      doc.pipe(reply.raw)

      doc.fontSize(20).font('Helvetica-Bold').text('EUDORA — Audit Log Export', { align: 'left' })
      doc.fontSize(10).font('Helvetica').text(`Exported: ${new Date().toISOString()}`, { align: 'left' })
      doc.fontSize(10).text(`Tenant: ${request.tenantId}`, { align: 'left' })
      doc.moveDown()

      const cols = { id: 40, action: 120, risk: 40, ts: 160, user: 120 }
      doc.fontSize(8).font('Helvetica-Bold')
      doc.text('ID', 40, doc.y, { width: cols.id, continued: true })
      doc.text('ACTION', { width: cols.action, continued: true })
      doc.text('RISK', { width: cols.risk, continued: true })
      doc.text('TIMESTAMP', { width: cols.ts, continued: true })
      doc.text('USER_ID', { width: cols.user })
      doc.moveTo(40, doc.y).lineTo(790, doc.y).stroke()

      doc.font('Helvetica').fontSize(7)
      events.forEach(e => {
        if (doc.y > 540) doc.addPage({ layout: 'landscape' })
        const y = doc.y + 2
        doc.text(e.id.slice(0, 8), 40, y, { width: cols.id, continued: true })
        doc.text(e.action, { width: cols.action, continued: true })
        doc.text(String(e.risk_score), { width: cols.risk, continued: true })
        doc.text(new Date(e.ts).toISOString(), { width: cols.ts, continued: true })
        doc.text(e.user_id.slice(0, 16), { width: cols.user })
      })

      doc.end()
      return reply
    }

    reply.header('Content-Type', 'application/json')
    reply.header('Content-Disposition', 'attachment; filename="eudora-audit.json"')
    return reply.send(JSON.stringify(events, null, 2))
  })

  fastify.get('/:id/verify', async (request, reply) => {
    const row = await db.get(
      'SELECT * FROM audit_log WHERE id = ? AND tenant_id = ?',
      [request.params.id, request.tenantId]
    )
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const signingKey = process.env.AUDIT_HMAC_KEY
    if (!signingKey) {
      return reply.send({
        id: row.id,
        verified: null,
        reason: 'hmac_not_configured',
      })
    }

    return reply.send({
      id: row.id,
      verified: verifyAuditRow(row, signingKey),
    })
  })
}
