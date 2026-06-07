import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import analyticsRoutes from '../analytics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let app
let db
let tenantId
let userId
let agentAId
let agentBId

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  tenantId = nanoid()
  userId = nanoid()
  agentAId = nanoid()
  agentBId = nanoid()

  db.prepare(`
    INSERT INTO tenants (id, name, plan, created_at)
    VALUES (?, 'Analytics Tenant', 'enterprise', ?)
  `).run(tenantId, Date.now())
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, 'analytics@example.com', 'hash', 'owner')
  `).run(userId, tenantId)
  db.prepare(`
    INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at)
    VALUES (?, ?, ?, 'Analytics', 'openai', ?)
  `).run(agentAId, tenantId, 'Risk Monitor', Date.now())
  db.prepare(`
    INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at)
    VALUES (?, ?, ?, 'Analytics', 'anthropic', ?)
  `).run(agentBId, tenantId, 'Policy Analyst', Date.now())

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request) => {
    request.tenantId = tenantId
    request.user = { userId, tenantId, role: 'owner' }
  })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  if (db) db.close()
})

function insertAudit({
  action = 'chat_message',
  riskScore = 0,
  agentId = agentAId,
  timestamp = Date.now(),
  tenant = tenantId,
  user = userId,
} = {}) {
  db.prepare(`
    INSERT INTO audit_log (
      id, tenant_id, user_id, action, risk_score, metadata, ts
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    tenant,
    user,
    action,
    riskScore,
    JSON.stringify(agentId ? { agentId } : {}),
    timestamp
  )
}

describe('analytics routes', () => {
  it('returns overview metrics, daily activity, top agents, and risk distribution', async () => {
    const now = Date.now()
    insertAudit({ agentId: agentAId, riskScore: 10, timestamp: now - 2 * 24 * 60 * 60 * 1000 })
    insertAudit({ agentId: agentAId, riskScore: 35, timestamp: now - 24 * 60 * 60 * 1000 })
    insertAudit({ agentId: agentAId, action: 'guard_block', riskScore: 80 })
    insertAudit({ agentId: agentBId, action: 'dlp_detected', riskScore: 90 })
    insertAudit({ agentId: null, action: 'login', riskScore: 0 })

    const response = await app.inject({
      method: 'GET',
      url: '/analytics/overview',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      period: '30d',
      summary: {
        totalInteractions: 5,
        trend: 0,
        riskEvents: 3,
        blockedRequests: 1,
        dlpEvents: 1,
      },
      riskDistribution: {
        nominal: 2,
        elevated: 1,
        critical: 2,
      },
    })
    expect(response.json().dailyActivity).toHaveLength(30)
    expect(response.json().topAgents[0]).toMatchObject({
      id: agentAId,
      name: 'Risk Monitor',
      interactions: 3,
    })
    expect(response.json().topAgents[1]).toMatchObject({
      id: agentBId,
      name: 'Policy Analyst',
      interactions: 1,
      avg_risk: 90,
    })
  })

  it('calculates trend against the previous 30-day period', async () => {
    const now = Date.now()
    insertAudit({ timestamp: now - 5 * 24 * 60 * 60 * 1000 })
    insertAudit({ timestamp: now - 10 * 24 * 60 * 60 * 1000 })
    insertAudit({ timestamp: now - 35 * 24 * 60 * 60 * 1000 })

    const response = await app.inject({
      method: 'GET',
      url: '/analytics/overview',
    })

    expect(response.json().summary).toMatchObject({
      totalInteractions: 2,
      trend: 100,
    })
  })

  it('returns tenant-scoped per-agent statistics and daily data', async () => {
    insertAudit({ agentId: agentAId, riskScore: 45 })
    insertAudit({ agentId: agentAId, action: 'guard_block', riskScore: 75 })
    insertAudit({ agentId: agentBId, riskScore: 5 })

    const response = await app.inject({
      method: 'GET',
      url: `/analytics/agents/${agentAId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      agentId: agentAId,
      agentName: 'Risk Monitor',
      period: '30d',
      stats: {
        total: 2,
        avgRisk: 60,
        maxRisk: 75,
        blocked: 1,
        dlp: 0,
      },
    })
    expect(response.json().daily).toHaveLength(30)
  })

  it('does not expose an agent from another tenant', async () => {
    const otherTenantId = nanoid()
    const otherUserId = nanoid()
    const otherAgentId = nanoid()
    db.prepare(`
      INSERT INTO tenants (id, name, plan, created_at)
      VALUES (?, 'Other Tenant', 'enterprise', ?)
    `).run(otherTenantId, Date.now())
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, password_hash, role)
      VALUES (?, ?, 'other@example.com', 'hash', 'owner')
    `).run(otherUserId, otherTenantId)
    db.prepare(`
      INSERT INTO agents (id, tenant_id, name, purpose, model_provider, created_at)
      VALUES (?, ?, 'Other Agent', 'Other', 'openai', ?)
    `).run(otherAgentId, otherTenantId, Date.now())

    const response = await app.inject({
      method: 'GET',
      url: `/analytics/agents/${otherAgentId}`,
    })

    expect(response.statusCode).toBe(404)
  })
})
