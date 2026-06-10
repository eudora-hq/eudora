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

vi.mock('../../services/rfc3161.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    requestTimestamp: vi.fn(),
    verifyTimestamp: vi.fn(),
  }
})

import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { checkTrialExpiry } from '../../middleware/trialExpiry.js'
import { generateAccessToken } from '../../utils/auth.js'
import {
  extractTimestampedContent,
  requestTimestamp,
  verifyTimestamp,
} from '../../services/rfc3161.js'
import reportsRoutes, { registerReportVerificationRoute } from '../reports.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrations = [
  '001_initial_schema.sql',
  '002_agent_ownership.sql',
  '003_external_agents.sql',
  '004_pbac.sql',
  '005_reports.sql',
  '010_rfc3161_timestamps.sql',
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
  `).run(nanoid(), tenantId, userId, 'chat_message', 10, JSON.stringify({ agentId }), userId, JSON.stringify([agentId]), now - 1000)
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
    expect(result.timestamp).toMatchObject({
      status: 'ok',
      valid: true,
      time: '2026-06-10T14:23:01.000Z',
    })
    expect(result.verification_summary).toContain('Report content verified')
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
    expect(response.json().timestamp.valid).toBe(true)
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
