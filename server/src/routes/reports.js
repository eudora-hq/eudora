import { adaptDatabase } from '../db/index.js'
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
import {
  ARTICLE50_TEMPLATES,
  getArticle50Template,
} from '../services/article50Templates.js'

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
  const db = adaptDatabase(fastify.db)

  fastify.get('/:id/verify', async (request, reply) => {
    const report = await db.get(
      'SELECT * FROM compliance_reports WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])
    if (!report) return reply.code(404).send({ error: 'report_not_found' })

    const path = reportPath(report.id)
    if (!existsSync(path)) {
      return reply.code(404).send({ error: 'report_file_not_found' })
    }
    return verifyStoredReport(report, readFileSync(path))
  })
}

function parseRegulationRefs(value, fallback) {
  if (value == null) return fallback
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
  return value
}

export async function registerArticle50Routes(fastify) {
  const db = adaptDatabase(fastify.db)

  fastify.get('/records', async (request, reply) => {
    const {
      agent_id: agentId,
      dateFrom,
      dateTo,
      sector_template: sectorTemplate,
    } = request.query || {}
    const clauses = ['tenant_id = ?']
    const params = [request.tenantId]

    if (sectorTemplate && !ARTICLE50_TEMPLATES[sectorTemplate]) {
      return reply.code(400).send({ error: 'invalid_sector_template' })
    }
    if (agentId) {
      clauses.push('agent_id = ?')
      params.push(agentId)
    }
    if (dateFrom) {
      const parsedDateFrom = new Date(Number(dateFrom) || dateFrom)
      if (Number.isNaN(parsedDateFrom.getTime())) {
        return reply.code(400).send({ error: 'invalid_date_range' })
      }
      clauses.push('interaction_timestamp >= ?')
      params.push(parsedDateFrom.toISOString())
    }
    if (dateTo) {
      const parsedDateTo = new Date(Number(dateTo) || dateTo)
      if (Number.isNaN(parsedDateTo.getTime())) {
        return reply.code(400).send({ error: 'invalid_date_range' })
      }
      clauses.push('interaction_timestamp <= ?')
      params.push(parsedDateTo.toISOString())
    }
    if (sectorTemplate) {
      clauses.push('sector_template = ?')
      params.push(sectorTemplate)
    }

    const records = await db.all(`
      SELECT * FROM article50_records
      WHERE ${clauses.join(' AND ')}
      ORDER BY interaction_timestamp DESC
    `, params)

    return await Promise.all(records.map(async record => {
      const auditEvent = await db.get(
        `SELECT risk_score FROM audit_log
         WHERE tenant_id = ? AND (id = ? OR metadata LIKE ?)
         ORDER BY ts DESC
         LIMIT 1`,
        [request.tenantId, record.run_id, `%"runId":"${record.run_id}"%`]
      )
      return {
        ...record,
        disclosure_made: Boolean(record.disclosure_made),
        regulation_refs: JSON.parse(record.regulation_refs || '[]'),
        risk_score: auditEvent?.risk_score ?? null,
      }
    }))
  })

  fastify.post('/records', async (request, reply) => {
    const {
      agent_id: agentId,
      run_id: runId,
      interaction_timestamp: interactionTimestamp,
      disclosure_made: disclosureMade = true,
      disclosure_method: disclosureMethod = 'logged_only',
      output_summary: outputSummary,
      sector_template: sectorTemplate = 'general',
      regulation_refs: requestedRegulations,
    } = request.body || {}

    if (!agentId || !runId || !interactionTimestamp || !outputSummary) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    const template = getArticle50Template(sectorTemplate)
    if (!template) return reply.code(400).send({ error: 'invalid_sector_template' })
    if (!['system_prompt', 'prepended_message', 'logged_only'].includes(disclosureMethod)) {
      return reply.code(400).send({ error: 'invalid_disclosure_method' })
    }
    const timestamp = new Date(interactionTimestamp)
    if (Number.isNaN(timestamp.getTime())) {
      return reply.code(400).send({ error: 'invalid_interaction_timestamp' })
    }
    const agent = await db.get('SELECT id FROM agents WHERE id = ? AND tenant_id = ?', [agentId, request.tenantId])
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })

    const regulationRefs = parseRegulationRefs(requestedRegulations, template.regulations)
    if (!regulationRefs) return reply.code(400).send({ error: 'invalid_regulation_refs' })

    const id = nanoid()
    await db.query(`
      INSERT INTO article50_records (
        id, tenant_id, agent_id, run_id, interaction_timestamp,
        disclosure_made, disclosure_method, output_summary,
        sector_template, regulation_refs
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id,
      request.tenantId,
      agentId,
      runId,
      timestamp.toISOString(),
      disclosureMade ? 1 : 0,
      disclosureMethod,
      String(outputSummary).substring(0, 200),
      sectorTemplate,
      JSON.stringify(regulationRefs)])

    return reply.code(201).send({
      id,
      tenant_id: request.tenantId,
      agent_id: agentId,
      run_id: runId,
      interaction_timestamp: timestamp.toISOString(),
      disclosure_made: Boolean(disclosureMade),
      disclosure_method: disclosureMethod,
      output_summary: String(outputSummary).substring(0, 200),
      sector_template: sectorTemplate,
      regulation_refs: regulationRefs,
    })
  })
}

export default async function reportsRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

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
      mode,
      sectorTemplate = 'general',
    } = request.body || {}
    const requestedMode = mode || traceMode || 'flagged'
    if (!['flagged', 'full', 'summary', 'article50'].includes(requestedMode)) {
      return reply.code(400).send({ error: 'invalid_report_mode' })
    }
    if (requestedMode === 'article50' && !ARTICLE50_TEMPLATES[sectorTemplate]) {
      return reply.code(400).send({ error: 'invalid_sector_template' })
    }
    const resolvedTraceMode = ['flagged', 'full', 'summary'].includes(requestedMode)
      ? requestedMode
      : 'flagged'
    const resolvedReportMode = requestedMode
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
      const agent = await db.get('SELECT id FROM agents WHERE id = ? AND tenant_id = ?', [agentId, request.tenantId])
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
      data,
    } = await generateComplianceReport(db, {
      tenantId: request.tenantId,
      dateFrom: Number(dateFrom),
      dateTo: Number(dateTo),
      agentId,
      reportId,
      generatedAt,
      traceMode: resolvedTraceMode,
      reportMode: resolvedReportMode,
      sectorTemplate,
    })

    await db.transaction(async tx => {
      await tx.query(`
        INSERT INTO compliance_reports
          (
            id, tenant_id, date_from, date_to, report_hash, generated_at, agent_id,
            timestamp_token, timestamp_status, timestamp_time, tsa_url, report_mode
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [reportId,
        request.tenantId,
        Number(dateFrom),
        Number(dateTo),
        reportHash,
        generatedAt,
        agentId,
        timestampToken,
        timestampStatus,
        timestampTime,
        tsaUrl,
        resolvedReportMode])

      if (resolvedReportMode === 'article50') {
        for (const record of data.article50Records) {
          await tx.query(
            `INSERT INTO article50_records (
              id, tenant_id, agent_id, run_id, interaction_timestamp,
              disclosure_made, disclosure_method, output_summary,
              sector_template, regulation_refs
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              nanoid(),
              request.tenantId,
              record.agentId,
              record.runId,
              record.interactionTimestamp,
              record.disclosureMade,
              record.disclosureMethod,
              record.outputSummary,
              record.sectorTemplate,
              JSON.stringify(record.regulationRefs),
            ]
          )
        }
      }
    })

    writeFileSync(reportPath(reportId), pdfBuffer)
    reply.header('X-Report-Id', reportId)
    reply.header('X-Report-Hash', reportHash)
    return sendPdf(reply, pdfBuffer)
  })

  fastify.get('/', async (request) => {
    return await db.all(`
      SELECT
        id, date_from, date_to, report_hash, generated_at, agent_id,
        timestamp_status, timestamp_time, tsa_url, report_mode
      FROM compliance_reports
      WHERE tenant_id = ?
      ORDER BY generated_at DESC
    `, [request.tenantId])
  })

  await registerReportVerificationRoute(fastify)

  fastify.get('/:id', async (request, reply) => {
    const report = await db.get(
      'SELECT * FROM compliance_reports WHERE id = ? AND tenant_id = ?'
    , [request.params.id, request.tenantId])

    if (!report) return reply.code(404).send({ error: 'report_not_found' })

    const path = reportPath(report.id)
    if (!existsSync(path)) {
      return reply.code(404).send({ error: 'report_file_not_found' })
    }

    reply.header('X-Report-Hash', report.report_hash)
    return sendPdf(reply, readFileSync(path), `eudora-compliance-report-${report.id}.pdf`)
  })
}
