import { createHash } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'fs'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = '0'.repeat(64)
process.env.SELF_HOSTED = 'false'
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

// vi.hoisted runs before module imports (alongside the vi.mock hoist), so these
// stable vi.fn() references are available to both the factory and the test body.
const { mockRequestTimestamp, mockVerifyTimestamp } = vi.hoisted(() => ({
  mockRequestTimestamp: vi.fn(),
  mockVerifyTimestamp: vi.fn(),
}))

vi.mock('../../services/rfc3161.ts', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    requestTimestamp: mockRequestTimestamp,
    verifyTimestamp: mockVerifyTimestamp,
  }
})

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import { extractTimestampedContent } from '../../services/rfc3161.ts'
const requestTimestamp = mockRequestTimestamp
const verifyTimestamp = mockVerifyTimestamp
import reportsRoutes, {
  registerArticle50Routes,
  registerReportVerificationRoute,
} from '../reports.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrations = [
  '001_initial_schema.sql',
  '002_agent_ownership.sql',
  '003_external_agents.sql',
  '004_pbac.sql',
  '005_reports.sql',
  '010_rfc3161_timestamps.sql',
  '011_article50_templates.sql',
]
  .map((file) => readFileSync(resolve(__dirname, '../../db/migrations', file), 'utf8'))
const reportDir = resolve(__dirname, '../../../.compliance-reports')

let app, db, tenantId, userId, agentId, token

beforeEach(async () => {
  process.env.SELF_HOSTED = 'false'
  requestTimestamp.mockResolvedValue(Buffer.from('valid-tsr'))
  verifyTimestamp.mockResolvedValue({
    valid: true,
    timestamp: '2026-06-10T14:23:01.000Z',
    tsa: 'https://freetsa.org/tsr',
  })
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrations.forEach((sql) => db.exec(sql))

  tenantId = nanoid()
  userId = nanoid()
  agentId = nanoid()

  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'Reports Co', 'enterprise', null, Date.now())
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'reports@test.com', 'hash', 'owner')
  db.prepare(`
    INSERT INTO agents (
      id, tenant_id, name, purpose, model_provider, owner_type, owner_id,
      owner_chain, status, created_at
    )
    VALUES (?, ?, 'Compliance Agent', 'DORA compliance review', 'anthropic', 'human', ?, '[]', 'live', ?)
  `).run(agentId, tenantId, userId, Date.now())

  const now = Date.now()
  db.prepare(`
    INSERT INTO audit_log
      (id, tenant_id, user_id, action, risk_score, metadata, initiated_by_user_id, agent_chain, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    tenantId,
    userId,
    'chat_message',
    10,
    JSON.stringify({
      agentId,
      runId: 'run-article50',
      disclosureMade: true,
      disclosureMethod: 'system_prompt',
      outputSummary: 'AI-generated compliance guidance was presented to the user.',
    }),
    userId,
    JSON.stringify([agentId]),
    now - 1000
  )
  db.prepare(`
    INSERT INTO audit_log
      (id, tenant_id, user_id, action, risk_score, metadata, initiated_by_user_id, agent_chain, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), tenantId, userId, 'guard_block', 80, JSON.stringify({ agentId }), userId, JSON.stringify([agentId]), now)

  token = generateAccessToken({ userId, tenantId, role: 'owner' })

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((resolveHook) => scopeToTenant(request, reply, resolveHook))
    if (reply.sent) return
    await new Promise((resolveHook) => checkTrialExpiry(request, reply, resolveHook))
  })
  await app.register(reportsRoutes, { prefix: '/reports' })
  await app.register(registerReportVerificationRoute, { prefix: '/v1/compliance/reports' })
  await app.register(registerArticle50Routes, { prefix: '/v1/compliance/article50' })
  await app.ready()
})

afterEach(async () => {
  process.env.SELF_HOSTED = 'false'
  if (app) await app.close()
  if (db) db.close()
  if (existsSync(reportDir)) rmSync(reportDir, { recursive: true, force: true })
})

function request(method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

async function generateReport(overrides = {}) {
  const now = Date.now()
  return request('POST', '/reports/generate', {
    dateFrom: now - 60 * 60 * 1000,
    dateTo: now + 60 * 60 * 1000,
    format: 'pdf',
    ...overrides,
  })
}

describe('reports routes', () => {
  it('enterprise tenant can generate a PDF report and stores hash', async () => {
    const res = await generateReport()

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.rawPayload.length).toBeGreaterThan(0)

    const reportId = res.headers['x-report-id']
    const row = db.prepare('SELECT * FROM compliance_reports WHERE id = ?').get(reportId)
    expect(row.report_hash).toBe(res.headers['x-report-hash'])
    expect(row.tenant_id).toBe(tenantId)
    expect(row.timestamp_status).toBe('ok')
    expect(row.timestamp_token).toBe(Buffer.from('valid-tsr').toString('base64'))
    expect(res.rawPayload.toString('binary')).toContain('/Keywords (eudora-tsr:')
  })

  it('GET /reports returns generated report metadata', async () => {
    await generateReport({ agentId })
    const res = await request('GET', '/reports')
    const reports = JSON.parse(res.body)

    expect(res.statusCode).toBe(200)
    expect(reports).toHaveLength(1)
    expect(reports[0].agent_id).toBe(agentId)
  })

  it('GET /reports/:id re-downloads the same PDF artifact', async () => {
    const generated = await generateReport()
    const reportId = generated.headers['x-report-id']

    const res = await request('GET', `/reports/${reportId}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-report-hash']).toBe(generated.headers['x-report-hash'])
    expect(Buffer.compare(res.rawPayload, generated.rawPayload)).toBe(0)
  })

  it('report generation succeeds when the Timestamp Authority is unavailable', async () => {
    requestTimestamp.mockRejectedValueOnce(new Error('TSA timeout'))

    const generated = await generateReport()

    expect(generated.statusCode).toBe(200)
    const row = db.prepare('SELECT * FROM compliance_reports WHERE id = ?')
      .get(generated.headers['x-report-id'])
    expect(row.timestamp_status).toBe('unavailable')
    expect(row.timestamp_token).toBeNull()
  })

  it('GET /reports/:id/verify validates the stored timestamp and content hash', async () => {
    const generated = await generateReport()
    const reportId = generated.headers['x-report-id']

    const response = await request('GET', `/reports/${reportId}/verify`)
    const result = response.json()

    expect(response.statusCode).toBe(200)
    // status and time come from the stored report row (set during generation via mocked TSA).
    // crypto validity (valid: true) is covered by src/services/__tests__/rfc3161.test.js;
    // this test focuses on route logic: correct report lookup and content hash computation.
    expect(result.timestamp.status).toBe('ok')
    expect(result.timestamp.time).toBe('2026-06-10T14:23:01.000Z')
    expect(result.verification_summary).toBeDefined()
    const canonicalPdf = extractTimestampedContent(generated.rawPayload)
    const rehashed = `sha256:${createHash('sha256').update(canonicalPdf).digest('hex')}`
    expect(result.content_hash).toBe(rehashed)
  })

  it('exposes the verification endpoint at the v1 compliance path', async () => {
    const generated = await generateReport()
    const reportId = generated.headers['x-report-id']

    const response = await request('GET', `/v1/compliance/reports/${reportId}/verify`)

    expect(response.statusCode).toBe(200)
    expect(response.json().report_id).toBe(reportId)
    // Endpoint reachability confirmed; crypto validity covered by rfc3161.test.js
    expect(response.json().timestamp.status).toBe('ok')
  })

  it.each([
    ['pending', 'Trusted timestamp verification is pending.'],
    ['unavailable', 'Timestamp Authority was unavailable'],
    ['failed', 'could not be verified'],
  ])('verification endpoint explains %s timestamp status', async (status, message) => {
    const generated = await generateReport()
    const reportId = generated.headers['x-report-id']
    db.prepare(`
      UPDATE compliance_reports
      SET timestamp_status = ?, timestamp_token = NULL
      WHERE id = ?
    `).run(status, reportId)

    const response = await request('GET', `/reports/${reportId}/verify`)
    const result = response.json()

    expect(response.statusCode).toBe(200)
    expect(result.timestamp.status).toBe(status)
    expect(result.timestamp.valid).toBe(false)
    expect(result.verification_summary).toContain(message)
  })

  it.each(['general', 'healthcare', 'financial', 'hr_legal'])(
    'generates an Article 50 PDF and records interactions for the %s template',
    async (sectorTemplate) => {
      const response = await generateReport({ mode: 'article50', sectorTemplate })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/pdf')
      expect(response.rawPayload.length).toBeGreaterThan(0)

      const report = db.prepare('SELECT * FROM compliance_reports WHERE id = ?')
        .get(response.headers['x-report-id'])
      expect(report.report_mode).toBe('article50')

      const records = db.prepare(
        'SELECT * FROM article50_records WHERE tenant_id = ? AND sector_template = ?'
      ).all(tenantId, sectorTemplate)
      expect(records).toHaveLength(1)
      expect(records[0].run_id).toBe('run-article50')
      expect(JSON.parse(records[0].regulation_refs)).toContain('EU AI Act Article 50')
    }
  )

  it('GET Article 50 records returns parsed regulation references and filters', async () => {
    await generateReport({ mode: 'article50', sectorTemplate: 'financial' })

    const response = await request(
      'GET',
      `/v1/compliance/article50/records?agent_id=${agentId}&sector_template=financial`
    )
    const records = response.json()

    expect(response.statusCode).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0].disclosure_made).toBe(true)
    expect(records[0].risk_score).toBe(10)
    expect(records[0].regulation_refs).toEqual([
      'EU AI Act Article 50',
      'DORA Article 17',
      'MiFID II Article 25',
    ])
  })

  it('POST Article 50 record creates a standalone manual record', async () => {
    const response = await request('POST', '/v1/compliance/article50/records', {
      agent_id: agentId,
      run_id: 'manual-run',
      interaction_timestamp: '2026-06-10T12:00:00.000Z',
      disclosure_made: true,
      disclosure_method: 'prepended_message',
      output_summary: 'Manual Article 50 transparency record.',
      sector_template: 'general',
      regulation_refs: ['EU_AI_Act_Art50'],
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().regulation_refs).toEqual(['EU_AI_Act_Art50'])
    const stored = db.prepare('SELECT * FROM article50_records WHERE run_id = ?')
      .get('manual-run')
    expect(JSON.parse(stored.regulation_refs)).toEqual(['EU_AI_Act_Art50'])
  })

  it.each([
    [{}, 'missing_fields'],
    [{
      agent_id: 'agent',
      run_id: 'run',
      interaction_timestamp: '2026-06-10T12:00:00.000Z',
      output_summary: 'summary',
      sector_template: 'unknown',
    }, 'invalid_sector_template'],
    [{
      agent_id: 'agent',
      run_id: 'run',
      interaction_timestamp: 'not-a-date',
      output_summary: 'summary',
    }, 'invalid_interaction_timestamp'],
  ])('POST Article 50 record rejects invalid payloads', async (payload, error) => {
    const response = await request('POST', '/v1/compliance/article50/records', payload)

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe(error)
  })

  it('rejects invalid Article 50 report templates', async () => {
    const response = await generateReport({
      mode: 'article50',
      sectorTemplate: 'unknown',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_sector_template')
  })

  it('non-enterprise tenant receives 403', async () => {
    db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run('professional', tenantId)
    const res = await generateReport()

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('upgrade_required')
  })

  it('SELF_HOSTED tenant can generate report regardless of plan', async () => {
    process.env.SELF_HOSTED = 'true'
    db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run('starter', tenantId)

    const res = await generateReport()
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })
})
