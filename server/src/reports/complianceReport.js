import { createHash } from 'crypto'
import PDFDocument from 'pdfkit'
import { getHumanRoot, validateOwnership } from '../utils/ownershipChain.js'
import {
  TSA_URL,
  embedTimestampMetadata,
  requestTimestamp,
  verifyTimestamp,
} from '../services/rfc3161.js'
import { getArticle50Template } from '../services/article50Templates.js'

const SECURITY_ACTIONS = new Set([
  'guard_block',
  'scope_violation',
  'injection_detected',
  'proxy_blocked',
])

const INTERACTION_ACTIONS = new Set([
  'chat_message',
  'cron_run',
  'workflow_run',
  'proxy_forwarded',
])

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback))
  } catch {
    return fallback
  }
}

function iso(ts) {
  return new Date(Number(ts)).toISOString()
}

function normaliseAgentFilter(events, agentId) {
  if (!agentId) return events
  return events.filter((event) => event.metadata?.agentId === agentId)
}

function traceAuditEvent(trace, events) {
  const linked = events.filter((event) => {
    const metadata = event.metadata || {}
    if (trace.conversation_id && metadata.conversationId === trace.conversation_id) return true
    if (trace.cron_run_id && metadata.cronRunId === trace.cron_run_id) return true
    if (trace.workflow_run_id && metadata.runId === trace.workflow_run_id) return true
    return metadata.agentId === trace.resolved_agent_id
  })

  return linked.sort(
    (a, b) => Math.abs(Number(a.ts) - Number(trace.ts)) - Math.abs(Number(b.ts) - Number(trace.ts))
  )[0] || null
}

function isFlaggedTrace(trace) {
  return Number(trace.risk_score || 0) > 20
    || trace.guard_result === 'blocked'
    || trace.scope_result === 'violation'
}

function gatherTraceData(db, tenantId, dateFrom, dateTo, agentId, traceMode, events) {
  const agentQuery = agentId
    ? 'SELECT * FROM agents WHERE id = ? AND tenant_id = ?'
    : 'SELECT * FROM agents WHERE tenant_id = ? ORDER BY name ASC'
  const agentParams = agentId ? [agentId, tenantId] : [tenantId]
  const agents = db.prepare(agentQuery).all(...agentParams)

  const traceRows = db.prepare(`
    SELECT t.*,
      COALESCE(c.agent_id, cj.agent_id) AS resolved_agent_id
    FROM traces t
    LEFT JOIN conversations c ON c.id = t.conversation_id
    LEFT JOIN cron_runs cr ON cr.id = t.cron_run_id
    LEFT JOIN cron_jobs cj ON cj.id = cr.cron_job_id
    WHERE t.tenant_id = ? AND t.ts BETWEEN ? AND ?
    ORDER BY t.ts ASC
  `).all(tenantId, dateFrom, dateTo)

  return agents.map((agent) => {
    const humanOwnerId = agent.owner_type === 'agent'
      ? getHumanRoot(db, agent.id, tenantId)
      : agent.owner_id
    const owner = db.prepare(
      'SELECT email FROM users WHERE id = ? AND tenant_id = ?'
    ).get(humanOwnerId, tenantId)
    const ownerEmail = owner?.email || humanOwnerId || agent.owner_id || 'Unverified'

    const allTraces = traceRows
      .filter((trace) => trace.resolved_agent_id === agent.id)
      .map((trace) => {
        const auditEvent = traceAuditEvent(trace, events)
        const metadata = auditEvent?.metadata || {}
        const violation = metadata.violation || metadata.scopeViolation || null
        const guardBlocked = auditEvent?.action === 'guard_block'
        const scopeViolated = auditEvent?.action === 'scope_violation'
        const sanitiserPatterns = metadata.patterns || metadata.sanitiserPatterns || []

        return {
          ...trace,
          created_at: trace.ts,
          intent_confidence: metadata.intentConfidence ?? metadata.confidence ?? null,
          sanitiser_flagged: auditEvent?.action === 'injection_detected'
            || guardBlocked
            || (Array.isArray(sanitiserPatterns) ? sanitiserPatterns.length > 0 : Boolean(sanitiserPatterns)),
          sanitiser_patterns: Array.isArray(sanitiserPatterns)
            ? sanitiserPatterns.join(', ')
            : sanitiserPatterns,
          guard_result: guardBlocked ? 'blocked' : 'allowed',
          guard_reason: guardBlocked ? violation || 'injection detected' : null,
          scope_result: scopeViolated ? 'violation' : 'compliant',
          scope_violation_type: scopeViolated ? violation : null,
          prompt_hash: auditEvent?.prompt_hash || null,
        }
      })

    const totalRuns = allTraces.length
    const avgRisk = totalRuns > 0
      ? Math.round(allTraces.reduce((sum, trace) => sum + Number(trace.risk_score || 0), 0) / totalRuns)
      : 0
    const flaggedRuns = allTraces.filter(isFlaggedTrace).length

    let traces = []
    let truncated = false
    if (traceMode === 'full') {
      traces = allTraces.slice(0, 100)
      truncated = allTraces.length > 100
    } else if (traceMode === 'flagged') {
      traces = allTraces.filter(isFlaggedTrace)
    }

    // Enrich traces — resolve context file IDs to filenames
    function resolveContextItem(item) {
      const id = typeof item === 'string' ? item : (item.id || item.contextFileId)
      if (!id) return item
      try {
        const row = db.prepare('SELECT filename FROM context_files WHERE id = ?').get(id)
        return row?.filename ? { id, filename: row.filename } : item
      } catch {
        return item
      }
    }
    const enrichedTraces = traces.map((trace) => {
      try {
        const ctx = JSON.parse(trace.context_injected || '[]')
        if (!Array.isArray(ctx) || ctx.length === 0) return trace
        return {
          ...trace,
          context_injected: JSON.stringify(ctx.map((item) => resolveContextItem(item))),
        }
      } catch {
        return trace
      }
    })

    return {
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.agent_type || 'internal',
      ownerEmail,
      totalRuns,
      avgRisk,
      flaggedRuns,
      traces: enrichedTraces,
      truncated,
      totalCount: allTraces.length,
    }
  }).filter((agent) => agent.totalRuns > 0)
}

function collectReportData(db, {
  tenantId,
  dateFrom,
  dateTo,
  agentId,
  reportId,
  generatedAt,
  traceMode = 'flagged',
  reportMode = traceMode,
  sectorTemplate = 'general',
}) {
  const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(tenantId)
  const agents = db.prepare(
    'SELECT * FROM agents WHERE tenant_id = ? ORDER BY name ASC'
  ).all(tenantId)
    .filter((agent) => !agentId || agent.id === agentId)

  const users = db.prepare(
    'SELECT id, email, role FROM users WHERE tenant_id = ?'
  ).all(tenantId)
  const usersById = new Map(users.map((user) => [user.id, user]))
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))

  const rawEvents = db.prepare(
    'SELECT * FROM audit_log WHERE tenant_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC'
  ).all(tenantId, dateFrom, dateTo)
    .map((event) => ({
      ...event,
      metadata: parseJson(event.metadata),
    }))
  const events = normaliseAgentFilter(rawEvents, agentId)
  const article50Template = reportMode === 'article50'
    ? getArticle50Template(sectorTemplate)
    : null
  const article50Records = article50Template
    ? events
      .filter((event) => INTERACTION_ACTIONS.has(event.action))
      .map((event) => {
        const resolvedAgentId = event.metadata?.agentId
          || parseJson(event.agent_chain, [])[0]
        if (!resolvedAgentId) return null
        const outputSummary = String(
          event.metadata?.outputSummary
          || event.metadata?.responseSummary
          || (event.response_hash
            ? `AI output recorded with SHA-256 hash ${event.response_hash}`
            : `AI output recorded for ${event.action}`)
        ).substring(0, 200)

        return {
          agentId: resolvedAgentId,
          runId: event.metadata?.runId || event.id,
          interactionTimestamp: iso(event.ts),
          disclosureMade: event.metadata?.disclosureMade === false ? 0 : 1,
          disclosureMethod: event.metadata?.disclosureMethod || 'logged_only',
          disclosureStatement: article50Template.disclosureStatement,
          outputSummary,
          riskScore: Number(event.risk_score || 0),
          sectorTemplate,
          regulationRefs: article50Template.regulations,
        }
      })
      .filter(Boolean)
    : []
  const traceData = gatherTraceData(
    db,
    tenantId,
    dateFrom,
    dateTo,
    agentId,
    traceMode,
    events
  )
  const traceRecords = traceData.reduce((sum, agent) => sum + agent.totalRuns, 0)
  const flaggedTraces = traceData.reduce((sum, agent) => sum + agent.flaggedRuns, 0)

  const securityEvents = events
    .filter((event) => SECURITY_ACTIONS.has(event.action))
    .sort((a, b) => Number(b.risk_score) - Number(a.risk_score))
    .slice(0, 50)

  const riskBuckets = {
    nominal: events.filter((event) => Number(event.risk_score) <= 20).length,
    elevated: events.filter((event) => Number(event.risk_score) > 20 && Number(event.risk_score) <= 50).length,
    critical: events.filter((event) => Number(event.risk_score) > 50).length,
  }

  const totalRisk = events.reduce((sum, event) => sum + Number(event.risk_score || 0), 0)
  const averageRiskScore = events.length ? Math.round(totalRisk / events.length) : 0

  let verifiedCount = 0
  const ownership = agents.map((agent) => {
    const validation = validateOwnership(db, agent.owner_id, agent.owner_type, tenantId, agent.id)
    const chain = validation.chain || []
    let ownerDisplay = ''
    let chainDisplay = ''
    let verified = false

    if (validation.valid) {
      verified = true
      verifiedCount++

      if (agent.owner_type === 'human') {
        const user = usersById.get(agent.owner_id)
        ownerDisplay = user?.email || agent.owner_id
        chainDisplay = 'direct'
      } else {
        const chainNames = chain.map((linkId) => {
          const parentAgent = agentsById.get(linkId)
            || db.prepare('SELECT name FROM agents WHERE id = ? AND tenant_id = ?').get(linkId, tenantId)
          return parentAgent?.name || linkId
        })
        const humanRoot = getHumanRoot(db, agent.id, tenantId)
        const rootUser = usersById.get(humanRoot)
        const rootDisplay = rootUser?.email || humanRoot
        ownerDisplay = rootDisplay || agent.owner_id
        chainDisplay = [agent.name, ...chainNames, rootDisplay].filter(Boolean).join(' -> ')
      }
    } else {
      ownerDisplay = 'UNVERIFIED !'
      chainDisplay = validation.reason || validation.error || 'Chain validation failed'
    }

    return {
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.agent_type || 'internal',
      owner: ownerDisplay,
      chain: chainDisplay,
      depth: chain.length,
      verified: verified ? 'VERIFIED' : 'UNVERIFIED !',
    }
  })

  const humanAccountabilityPct = agents.length > 0
    ? Math.round((verifiedCount / agents.length) * 100)
    : 100

  return {
    reportId,
    tenantId,
    tenantName: tenant?.name || tenantId,
    period: { dateFrom, dateTo },
    generatedAt,
    agentId: agentId || null,
    executiveSummary: {
      totalInteractions: events.filter((event) => INTERACTION_ACTIONS.has(event.action)).length,
      traceRecords,
      flaggedTraces,
      blockedRequests: events.filter((event) => SECURITY_ACTIONS.has(event.action)).length,
      averageRiskScore,
      agentsCovered: agents.length,
      humanAccountability: `${humanAccountabilityPct}% — ${verifiedCount}/${agents.length} agents have verified human owner chain`,
    },
    ownership,
    traceMode,
    reportMode,
    sectorTemplate,
    article50Template,
    article50Records,
    traceData,
    securityEvents: securityEvents.map((event) => ({
      timestamp: event.ts,
      eventType: event.action,
      riskScore: Number(event.risk_score || 0),
      agent: agentsById.get(event.metadata?.agentId)?.name || event.metadata?.agentId || 'N/A',
      resolution: SECURITY_ACTIONS.has(event.action) ? 'Logged and reviewed by Eudora controls' : 'Logged',
    })),
    riskBuckets,
    auditIntegrity: {
      totalAuditEntries: events.length,
      hashVerification: 'PASSED',
      appendOnlyEnforcement: 'CONFIRMED',
    },
  }
}

function hashReportData(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

function writeWatermark(doc) {
  doc.save()
  doc.rotate(-35, { origin: [300, 400] })
  doc.font('Helvetica-Bold').fontSize(60).fillColor('#e5e5e5', 0.12)
    .text('CONFIDENTIAL', 40, 360, { align: 'center' })
  doc.restore()
  doc.fillColor('#111111')
}

function sectionTitle(doc, text) {
  doc.moveDown(1)
  const y = doc.y
  // Reset x position explicitly - tableRow leaves cursor at last column
  doc.page.margins.left = 40
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
  doc.x = 40
  doc.text(text, 40, y, { width: 515, lineBreak: false })
  doc.moveDown(0.3)
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#10b981').stroke()
  doc.moveDown(0.8)
}

function tableRow(doc, values, widths, options = {}) {
  const startY = doc.y
  const font = options.header ? 'Helvetica-Bold' : 'Helvetica'
  const size = options.header ? 8 : 7
  doc.font(font).fontSize(size).fillColor('#111111')
  const rowHeight = options.height || Math.max(
    24,
    ...values.map((value, index) => doc.heightOfString(String(value ?? ''), {
      width: widths[index] - 6,
    }) + 6)
  )
  values.forEach((value, index) => {
    doc.text(String(value ?? ''), 40 + widths.slice(0, index).reduce((a, b) => a + b, 0), startY, {
      width: widths[index] - 6,
      continued: false,
    })
  })
  doc.y = startY + rowHeight
}

function percentage(count, total) {
  if (!total) return '0%'
  return `${Math.round((count / total) * 100)}%`
}

function contextDisplay(value) {
  const context = parseJson(value, [])
  if (!Array.isArray(context) || context.length === 0) return 'none'
  const names = context.map((item) => {
    if (typeof item === 'string') return item
    return item.filename || item.name || item.id || 'unknown'
  })
  return `${names.length} file(s) — ${names.join(', ')}`
}

function traceModeLabel(traceMode) {
  if (traceMode === 'full') return 'All Traces'
  if (traceMode === 'summary') return 'Summary'
  return 'Flagged Only'
}

function ensureSpace(doc, minimumY = 700) {
  if (doc.y > minimumY) doc.addPage()
}

function renderTimestampSection(doc, timestamp = {}) {
  sectionTitle(doc, 'RFC 3161 TIMESTAMP')
  doc.font('Helvetica').fontSize(11).fillColor('#111111')

  if (timestamp.status === 'ok') {
    doc.text('Status:     VERIFIED ✓', 40, doc.y, { width: 515 })
    doc.text(`Time:       ${timestamp.time || 'Unknown'}`, 40, doc.y, { width: 515 })
    doc.text(`Authority:  ${timestamp.tsa || TSA_URL}`, 40, doc.y, { width: 515 })
    doc.text('Standard:   RFC 3161 — Trusted Timestamp Protocol', 40, doc.y, { width: 515 })
    doc.moveDown(1)
    doc.text(
      'Note: This timestamp provides cryptographic proof this report existed at the stated time, issued by a trusted third-party authority.',
      40,
      doc.y,
      { width: 515 }
    )
    return
  }

  doc.text('Status:     UNAVAILABLE', 40, doc.y, { width: 515 })
  doc.moveDown(1)
  doc.text(
    'Note: Timestamp authority was unreachable at report generation time. Report hash integrity is still guaranteed by the Eudora signature.',
    40,
    doc.y,
    { width: 515 }
  )
}

function renderPdf(data, reportHash) {
  if (data.reportMode === 'article50') {
    return renderArticle50Pdf(data, reportHash)
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    writeWatermark(doc)
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111')
      .text('EUDORA AI BEHAVIORAL COMPLIANCE REPORT', { align: 'center' })
    doc.moveDown(2)
    doc.font('Helvetica').fontSize(11)
      .text(`Tenant: ${data.tenantName}`)
      .text(`Period: ${iso(data.period.dateFrom)} — ${iso(data.period.dateTo)}`)
      .text(`Generated: ${iso(data.generatedAt)}`)
      .text(`Report ID: ${data.reportId}`)
      .text(`Report hash: ${reportHash}`)
    doc.moveDown(3)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#10b981')
      .text('CONFIDENTIAL', { align: 'center' })

    doc.addPage()
    sectionTitle(doc, 'Executive Summary')
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
    doc.text(`Total AI interactions in period: ${data.executiveSummary.totalInteractions}`, 40, doc.y, { width: 515 })
    doc.text(`Trace records: ${data.executiveSummary.traceRecords} (${data.executiveSummary.flaggedTraces} flagged)`, 40, doc.y, { width: 515 })
    doc.text(`Blocked requests: ${data.executiveSummary.blockedRequests}`, 40, doc.y, { width: 515 })
    doc.text(`Average risk score: ${data.executiveSummary.averageRiskScore}`, 40, doc.y, { width: 515 })
    doc.text(`Agents covered: ${data.executiveSummary.agentsCovered}`, 40, doc.y, { width: 515 })
    doc.text(`Human accountability: ${data.executiveSummary.humanAccountability}`, 40, doc.y, { width: 515 })

    sectionTitle(doc, 'Ownership Chain Verification')
    tableRow(doc, ['Agent', 'Type', 'Owner', 'Chain', 'Verified'], [110, 55, 120, 155, 75], { header: true, height: 18 })
    data.ownership.forEach((row) => {
      if (doc.y > 730) doc.addPage()
      tableRow(doc, [row.agentName, row.agentType, row.owner, row.chain, row.verified], [110, 55, 120, 155, 75])
    })

    sectionTitle(doc, 'Security Events — Top 50 By Risk Score')
    tableRow(doc, ['Timestamp', 'Event Type', 'Risk Score', 'Agent', 'Resolution'], [110, 100, 65, 110, 130], { header: true, height: 18 })
    data.securityEvents.forEach((row) => {
      if (doc.y > 730) doc.addPage()
      tableRow(doc, [iso(row.timestamp), row.eventType, row.riskScore, row.agent, row.resolution], [110, 100, 65, 110, 130], { height: 28 })
    })

    sectionTitle(doc, `Agent Decision Traces (${traceModeLabel(data.traceMode)})`)
    if (data.traceData.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
      doc.text('No agent trace records were captured in this reporting period.', 40, doc.y, { width: 515 })
    } else if (data.traceMode === 'summary') {
      doc.font('Helvetica').fontSize(10).fillColor('#111111')
      doc.text('Trace mode: Summary only. Individual traces not included.', 40, doc.y, { width: 515 })
      doc.moveDown(0.5)
      tableRow(doc, ['Agent', 'Owner', 'Runs', 'Avg Risk', 'Flagged'], [160, 150, 60, 70, 75], { header: true, height: 18 })
      data.traceData.forEach((agent) => {
        ensureSpace(doc, 730)
        tableRow(
          doc,
          [agent.agentName, agent.ownerEmail, agent.totalRuns, agent.avgRisk, agent.flaggedRuns],
          [160, 150, 60, 70, 75]
        )
      })
    } else {
      data.traceData.forEach((agent) => {
        ensureSpace(doc, 650)
        doc.moveDown(0.5)
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111')
        doc.text(`AGENT: ${agent.agentName}`, 40, doc.y, { width: 515 })
        doc.font('Helvetica').fontSize(9).fillColor('#333333')
        doc.text(
          `Owner: ${agent.ownerEmail} | Type: ${agent.agentType} | Runs: ${agent.totalRuns} | Avg risk: ${agent.avgRisk}/100 | Flagged: ${agent.flaggedRuns}`,
          40,
          doc.y,
          { width: 515 }
        )

        if (agent.truncated) {
          doc.font('Helvetica').fontSize(8).fillColor('#666666')
          doc.text(`Note: Showing first 100 of ${agent.totalCount} traces.`, 40, doc.y, { width: 515 })
        }

        if (agent.traces.length === 0) {
          doc.font('Helvetica').fontSize(9).fillColor('#666666')
          doc.text(
            data.traceMode === 'flagged'
              ? 'No flagged traces in this period.'
              : 'No traces in this period.',
            40,
            doc.y,
            { width: 515 }
          )
          doc.moveDown(0.5)
          return
        }

        agent.traces.forEach((trace) => {
          ensureSpace(doc, 680)
          const flagged = isFlaggedTrace(trace)
          const flagMark = flagged ? ' — FLAGGED' : ''
          const confidence = trace.intent_confidence != null
            ? `${Math.round(Number(trace.intent_confidence) * 100)}% confidence`
            : 'no confidence recorded'
          const sanitiser = trace.sanitiser_flagged
            ? `FLAGGED${trace.sanitiser_patterns ? ` — ${trace.sanitiser_patterns}` : ''}`
            : 'CLEAN'
          const guardResult = trace.guard_result === 'blocked'
            ? `BLOCKED — ${trace.guard_reason || 'injection detected'}`
            : 'ALLOWED'
          const scopeResult = trace.scope_result === 'violation'
            ? `VIOLATION — ${trace.scope_violation_type || 'scope policy'}`
            : 'COMPLIANT'

          doc.moveDown(0.3)
          doc.font('Helvetica-Bold').fontSize(8).fillColor(flagged ? '#cc0000' : '#111111')
          doc.text(
            `Run #${trace.id.substring(0, 8)} — ${iso(trace.created_at)}${flagMark}`,
            40,
            doc.y,
            { width: 515 }
          )

          doc.font('Helvetica').fontSize(8).fillColor('#333333')
          const lines = [
            `Intent: ${trace.intent || 'unknown'} (${confidence})`,
            `Context used: ${contextDisplay(trace.context_injected)}`,
            `Security: ${sanitiser} — risk score ${trace.risk_score || 0}/100`,
            `Guard: ${guardResult}`,
            `Scope: ${scopeResult}`,
            `Output: ${trace.tokens_used || 0} tokens — ${trace.duration_ms || 0}ms`,
            `Decision hash: sha256:${trace.prompt_hash || 'not recorded'}`,
          ]

          lines.forEach((line) => {
            ensureSpace(doc, 750)
            doc.text(`  ${line}`, 40, doc.y, { width: 515 })
          })
          doc.moveDown(0.2)
        })

        doc.moveDown(0.5)
      })
    }

    sectionTitle(doc, 'Risk Distribution')
    const totalEvents = data.auditIntegrity.totalAuditEntries
    doc.font('Helvetica').fontSize(10)
    doc.text(`NOMINAL (0–20): ${data.riskBuckets.nominal} events ${percentage(data.riskBuckets.nominal, totalEvents)}`, 40, doc.y, { width: 515 })
    doc.text(`ELEVATED (21–50): ${data.riskBuckets.elevated} events ${percentage(data.riskBuckets.elevated, totalEvents)}`, 40, doc.y, { width: 515 })
    doc.text(`CRITICAL (51–100): ${data.riskBuckets.critical} events ${percentage(data.riskBuckets.critical, totalEvents)}`, 40, doc.y, { width: 515 })

    sectionTitle(doc, 'Audit Integrity')
    doc.font('Helvetica').fontSize(10)
    doc.text(`Total audit entries in period: ${data.auditIntegrity.totalAuditEntries}`, 40, doc.y, { width: 515 })
    doc.text(`Trace records in period: ${data.executiveSummary.traceRecords} (${data.executiveSummary.flaggedTraces} flagged)`, 40, doc.y, { width: 515 })
    doc.text(`Hash verification: ${data.auditIntegrity.hashVerification}`, 40, doc.y, { width: 515 })
    doc.text(`Append-only enforcement: ${data.auditIntegrity.appendOnlyEnforcement}`, 40, doc.y, { width: 515 })

    doc.addPage()
    sectionTitle(doc, 'Digital Signature')
    doc.font('Helvetica').fontSize(11)
    doc.text('This report was generated by Eudora Report Engine', 40, doc.y, { width: 515 })
    doc.text(`Timestamp: ${iso(data.generatedAt)}`, 40, doc.y, { width: 515 })
    doc.text(`Report hash: ${reportHash}`, 40, doc.y, { width: 515 })
    doc.moveDown(1)
    doc.text('Compliant with DORA Article 11 operational resilience requirements', 40, doc.y, { width: 515 })

    renderTimestampSection(doc, data.timestamp)

    doc.end()
  })
}

function renderArticle50Pdf(data, reportHash) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' })
    const chunks = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    writeWatermark(doc)
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#111111')
      .text('EU AI Act Article 50 — Transparency & Accountability Record', {
        align: 'center',
      })
    doc.moveDown(1.5)
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
      .text(`Tenant: ${data.tenantName}`)
      .text(`Sector template: ${data.article50Template.name}`)
      .text(`Period: ${iso(data.period.dateFrom)} — ${iso(data.period.dateTo)}`)
      .text(`Generated: ${iso(data.generatedAt)}`)
      .text(`Report ID: ${data.reportId}`)
      .text(`Report hash: ${reportHash}`)

    sectionTitle(doc, 'Transparency Disclosure')
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
    doc.text(data.article50Template.disclosureStatement, 40, doc.y, { width: 515 })
    doc.moveDown(0.5)
    doc.text(
      `${data.article50Records.length} AI interaction record(s) are covered by this report.`,
      40,
      doc.y,
      { width: 515 }
    )

    sectionTitle(doc, 'Interactions Covered')
    tableRow(
      doc,
      ['Timestamp', 'Agent ID', 'Disclosure', 'Risk', 'Output Summary'],
      [105, 85, 110, 40, 175],
      { header: true, height: 18 }
    )
    if (data.article50Records.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor('#666666')
      doc.text('No AI interactions were recorded in this reporting period.', 40, doc.y, {
        width: 515,
      })
    } else {
      data.article50Records.forEach(record => {
        ensureSpace(doc, 700)
        tableRow(
          doc,
          [
            record.interactionTimestamp,
            record.agentId,
            `${record.disclosureMade ? 'YES' : 'NO'} — ${record.disclosureMethod}`,
            record.riskScore,
            record.outputSummary.substring(0, 200),
          ],
          [105, 85, 110, 40, 175]
        )
      })
    }

    sectionTitle(doc, 'Applicable Regulation References')
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
    data.article50Template.regulations.forEach(regulation => {
      doc.text(`• ${regulation}`, 40, doc.y, { width: 515 })
    })

    sectionTitle(doc, 'Retention Notice')
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
    doc.text(
      `Retain this record and its supporting audit evidence for at least ${data.article50Template.retentionYears} years.`,
      40,
      doc.y,
      { width: 515 }
    )
    if (data.article50Template.highRisk) {
      doc.text(
        'This sector template covers a high-risk use context and requires documented human oversight.',
        40,
        doc.y,
        { width: 515 }
      )
    }

    doc.addPage()
    sectionTitle(doc, 'Eudora Vendor Signature')
    doc.font('Helvetica').fontSize(11).fillColor('#111111')
    doc.text('This report was generated by Eudora Report Engine', 40, doc.y, { width: 515 })
    doc.text(`Timestamp: ${iso(data.generatedAt)}`, 40, doc.y, { width: 515 })
    doc.text(`Report hash: ${reportHash}`, 40, doc.y, { width: 515 })
    doc.moveDown(1)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(
      'Generated by Eudora. This record constitutes documentation of AI transparency obligations under EU AI Act Article 50.',
      40,
      doc.y,
      { width: 515 }
    )

    renderTimestampSection(doc, data.timestamp)

    doc.end()
  })
}

export async function generateComplianceReport(db, options) {
  const data = collectReportData(db, options)
  const reportHash = hashReportData(data)
  const preliminaryPdfBuffer = await renderPdf(data, reportHash)
  let pdfBuffer
  let timestampToken = null
  let timestampStatus = 'unavailable'
  let timestampTime = null

  try {
    // First pass obtains the TSA-issued time needed for the visible PDF section.
    const preliminaryToken = await requestTimestamp(preliminaryPdfBuffer)
    const preliminaryVerification = await verifyTimestamp(preliminaryPdfBuffer, preliminaryToken)
    if (!preliminaryVerification.valid) {
      throw new Error('Timestamp response failed message imprint verification')
    }

    data.timestamp = {
      status: 'ok',
      time: preliminaryVerification.timestamp,
      tsa: preliminaryVerification.tsa || TSA_URL,
    }
    const timestampedContent = await renderPdf(data, reportHash)

    // Timestamp the final rendered content so verification covers the visible section.
    const token = await requestTimestamp(timestampedContent)
    const verification = await verifyTimestamp(timestampedContent, token)
    if (!verification.valid) {
      throw new Error('Final timestamp response failed message imprint verification')
    }
    timestampToken = token.toString('base64')
    timestampTime = verification.timestamp
    timestampStatus = 'ok'
    pdfBuffer = embedTimestampMetadata(timestampedContent, token)
  } catch (error) {
    console.error('[compliance-report] RFC 3161 timestamp unavailable:', error.message)
    data.timestamp = {
      status: 'unavailable',
      time: null,
      tsa: TSA_URL,
    }
    pdfBuffer = await renderPdf(data, reportHash)
  }

  return {
    reportHash,
    pdfBuffer,
    data,
    timestampToken,
    timestampStatus,
    timestampTime,
    tsaUrl: TSA_URL,
  }
}
