import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { normalizePlan } from '../billing/canAccess.js'
import { generateComplianceReport } from '../reports/complianceReport.js'
import {
  TSA_URL,
  extractTimestampedContent,
  verifyTimestamp,
} from '../services/rfc3161.js'

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

async function verifyStoredReport(report, pdfBuffer) {
  const content = extractTimestampedContent(pdfBuffer)
  const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
  const timestamp = {
    status: report.timestamp_status || 'pending',
    time: report.timestamp_time || null,
    tsa: report.tsa_url || TSA_URL,
    valid: false,
  }
  let verificationSummary

  if (timestamp.status === 'ok' && report.timestamp_token) {
    const verified = await verifyTimestamp(
      content,
      Buffer.from(report.timestamp_token, 'base64')
    )
    timestamp.valid = verified.valid
    timestamp.time = verified.timestamp || timestamp.time
    timestamp.tsa = verified.tsa || timestamp.tsa
    verificationSummary = verified.valid
      ? `Report content verified. Timestamp issued by Freetsa.org at ${timestamp.time}.`
      : 'Report content hash does not match the stored RFC 3161 timestamp.'
  } else if (timestamp.status === 'unavailable') {
    verificationSummary = 'Report signature is available, but the Timestamp Authority was unavailable when this report was generated.'
  } else if (timestamp.status === 'failed') {
    verificationSummary = 'A timestamp response was stored, but its message imprint could not be verified.'
  } else {
    verificationSummary = 'Trusted timestamp verification is pending.'
  }

  return {
    report_id: report.id,
    content_hash: contentHash,
    timestamp,
    eudora_signature: report.report_hash,
    verification_summary: verificationSummary,
  }
}

export async function registerReportVerificationRoute(fastify) {
  const db = fastify.db

  fastify.get('/:id/verify', async (request, reply) => {
    const report = db.prepare(
      'SELECT * FROM compliance_reports WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!report) return reply.code(404).send({ error: 'report_not_found' })

    const path = reportPath(report.id)
    if (!existsSync(path)) {
      return reply.code(404).send({ error: 'report_file_not_found' })
    }
    return verifyStoredReport(report, readFileSync(path))
  })
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

    const {
      dateFrom,
      dateTo,
      agentId = null,
      format = 'pdf',
      traceMode,
    } = request.body || {}
    const resolvedTraceMode = ['flagged', 'full', 'summary'].includes(traceMode)
      ? traceMode
      : 'flagged'
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
    const {
      reportHash,
      pdfBuffer,
      timestampToken,
      timestampStatus,
      timestampTime,
      tsaUrl,
    } = await generateComplianceReport(db, {
      tenantId: request.tenantId,
      dateFrom: Number(dateFrom),
      dateTo: Number(dateTo),
      agentId,
      reportId,
      generatedAt,
      traceMode: resolvedTraceMode,
    })

    db.prepare(`
      INSERT INTO compliance_reports
        (
          id, tenant_id, date_from, date_to, report_hash, generated_at, agent_id,
          timestamp_token, timestamp_status, timestamp_time, tsa_url
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      request.tenantId,
      Number(dateFrom),
      Number(dateTo),
      reportHash,
      generatedAt,
      agentId,
      timestampToken,
      timestampStatus,
      timestampTime,
      tsaUrl
    )

    writeFileSync(reportPath(reportId), pdfBuffer)
    reply.header('X-Report-Id', reportId)
    reply.header('X-Report-Hash', reportHash)
    return sendPdf(reply, pdfBuffer)
  })

  fastify.get('/', async (request) => {
    return db.prepare(`
      SELECT
        id, date_from, date_to, report_hash, generated_at, agent_id,
        timestamp_status, timestamp_time, tsa_url
      FROM compliance_reports
      WHERE tenant_id = ?
      ORDER BY generated_at DESC
    `).all(request.tenantId)
  })

  await registerReportVerificationRoute(fastify)

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
