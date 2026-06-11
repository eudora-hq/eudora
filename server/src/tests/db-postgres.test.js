import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { nanoid } from 'nanoid'
import { createPostgresAdapter } from '../db/postgres.js'
import { runMigrations } from '../db/migrations.js'
import { rewritePlaceholders } from '../db/queryRewriter.js'
import { generateComplianceReport } from '../reports/complianceReport.ts'

const connectionString = process.env.TEST_DATABASE_URL
const describePostgres = connectionString ? describe : describe.skip
const { Pool } = pg

describePostgres('Postgres database adapter', () => {
  let adminPool
  let pool
  let db
  let schema

  beforeAll(async () => {
    schema = `eudora_test_${Date.now()}_${Math.random().toString(16).slice(2)}`
    adminPool = new Pool({ connectionString })
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
    db = createPostgresAdapter({ pool })
  })

  afterAll(async () => {
    await db?.close()
    if (adminPool && schema) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await adminPool.end()
    }
  })

  it('connects and rewrites parameterized queries', async () => {
    expect(rewritePlaceholders("SELECT '?' AS literal, ? AS value")).toBe(
      "SELECT '?' AS literal, $1 AS value"
    )
    const row = await db.get('SELECT ?::text AS value', ['connected'])
    expect(row.value).toBe('connected')
  })

  it('applies all migrations and supports basic CRUD', async () => {
    await runMigrations(db)
    const migrations = await db.all('SELECT filename FROM schema_migrations ORDER BY filename')
    expect(migrations.length).toBeGreaterThanOrEqual(14)

    const tenantId = nanoid()
    await db.query(
      `INSERT INTO tenants (id, name, plan, created_at)
       VALUES (?, ?, ?, ?)`,
      [tenantId, 'Postgres Test', 'enterprise', Date.now()]
    )
    expect((await db.get('SELECT name FROM tenants WHERE id = ?', [tenantId])).name)
      .toBe('Postgres Test')
    await db.query('UPDATE tenants SET name = ? WHERE id = ?', ['Updated', tenantId])
    expect((await db.get('SELECT name FROM tenants WHERE id = ?', [tenantId])).name)
      .toBe('Updated')
    await db.query('DELETE FROM tenants WHERE id = ?', [tenantId])
    expect(await db.get('SELECT id FROM tenants WHERE id = ?', [tenantId])).toBeUndefined()
  })

  it('generates a compliance report end to end', async () => {
    await runMigrations(db)
    const tenantId = nanoid()
    const userId = nanoid()
    const agentId = nanoid()
    const now = Date.now()

    await db.query(
      `INSERT INTO tenants (id, name, plan, created_at)
       VALUES (?, ?, 'enterprise', ?)`,
      [tenantId, 'Compliance Tenant', now]
    )
    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role)
       VALUES (?, ?, ?, 'hash', 'owner')`,
      [userId, tenantId, 'owner@example.com']
    )
    await db.query(
      `INSERT INTO agents (
        id, tenant_id, name, purpose, model_provider, owner_type,
        owner_id, owner_chain, created_at
      ) VALUES (?, ?, ?, ?, ?, 'human', ?, '[]', ?)`,
      [agentId, tenantId, 'Postgres Agent', 'Compliance testing', 'openai', userId, now]
    )

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const report = await generateComplianceReport(db, {
      tenantId,
      dateFrom: now - 1000,
      dateTo: now + 1000,
      agentId,
      reportId: nanoid(),
      generatedAt: now,
      reportMode: 'summary',
    })
    vi.unstubAllGlobals()

    expect(report.pdfBuffer.length).toBeGreaterThan(100)
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.timestampStatus).toBe('unavailable')
  })
})
