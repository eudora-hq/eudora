import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { normalizePlan } from '../billing/canAccess.js'
import { generateComplianceReport } from '../reports/complianceReport.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = resolve(__dirname, '../../.compliance-reports')

function canGenerateReports(request) {
  return process.env.SELF_HOSTED === 'true' || normalizePlan(request.tenant?.plan) === 'enterprise'
}

function ensureReportDir() {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true })
}

function reportPath(reportId) {
  ensureReportDir()
  return resolve(REPORT_DIR, `${reportId}.pdf`)
}

function sendPdf(reply, buffer, filename = 'eudora-compliance-report.pdf') {
  reply.header('Content-Type', 'application/pdf')
  reply.header('Content-Disposition', `attachment; filename="${filename}"`)
  return reply.send(buffer)
}

export default async function reportsRoutes(fastify) {
  const db = fastify.db

  fastify.post('/generate', async (request, reply) => {
    if (!canGenerateReports(request)) {
      return reply.code(403).send({
        error: 'upgrade_required',
        message: 'Compliance reports are available on the Enterprise plan',
        upgradeUrl: '/billing',
      })
    }

    const { dateFrom, dateTo, agentId = null, format = 'pdf' } = request.body || {}
    if (format !== 'pdf') {
      return reply.code(400).send({ error: 'unsupported_format' })
    }
    if (!dateFrom || !dateTo || Number(dateFrom) > Number(dateTo)) {
      return reply.code(400).send({
        error: 'invalid_date_range',
        message: 'dateFrom and dateTo are required timestamps',
      })
    }

    if (agentId) {
      const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND tenant_id = ?')
        .get(agentId, request.tenantId)
      if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    }

    const reportId = nanoid()
    const generatedAt = Date.now()
    const { reportHash, pdfBuffer } = await generateComplianceReport(db, {
      tenantId: request.tenantId,
      dateFrom: Number(dateFrom),
      dateTo: Number(dateTo),
      agentId,
      reportId,
      generatedAt,
    })

    db.prepare(`
      INSERT INTO compliance_reports
        (id, tenant_id, date_from, date_to, report_hash, generated_at, agent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      request.tenantId,
      Number(dateFrom),
      Number(dateTo),
      reportHash,
      generatedAt,
      agentId
    )

    writeFileSync(reportPath(reportId), pdfBuffer)
    reply.header('X-Report-Id', reportId)
    reply.header('X-Report-Hash', reportHash)
    return sendPdf(reply, pdfBuffer)
  })

  fastify.get('/', async (request) => {
    return db.prepare(`
      SELECT id, date_from, date_to, report_hash, generated_at, agent_id
      FROM compliance_reports
      WHERE tenant_id = ?
      ORDER BY generated_at DESC
    `).all(request.tenantId)
  })

  fastify.get('/:id', async (request, reply) => {
    const report = db.prepare(
      'SELECT * FROM compliance_reports WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)

    if (!report) return reply.code(404).send({ error: 'report_not_found' })

    const path = reportPath(report.id)
    if (!existsSync(path)) {
      return reply.code(404).send({ error: 'report_file_not_found' })
    }

    reply.header('X-Report-Hash', report.report_hash)
    return sendPdf(reply, readFileSync(path), `eudora-compliance-report-${report.id}.pdf`)
  })
}
