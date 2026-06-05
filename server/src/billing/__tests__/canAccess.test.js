import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { canAccess, isUnderLimit, seedFeatureFlags } from '../canAccess.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

let db
let trialTenantId, enterpriseTenantId, usageTenantId

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  const insertTenant = db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  )

  trialTenantId = nanoid()
  insertTenant.run(trialTenantId, 'Trial Co', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  seedFeatureFlags(db, trialTenantId, 'trial')

  enterpriseTenantId = nanoid()
  insertTenant.run(enterpriseTenantId, 'Enterprise Co', 'enterprise', null, Date.now())
  seedFeatureFlags(db, enterpriseTenantId, 'enterprise')

  usageTenantId = nanoid()
  insertTenant.run(usageTenantId, 'Usage Co', 'starter', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
})

afterAll(() => {
  db.close()
})

describe('canAccess', () => {
  it('trial tenant cannot access workflow_builder', () => {
    expect(canAccess(db, trialTenantId, 'workflow_builder')).toBe(false)
  })

  it('trial tenant can access audit_view', () => {
    expect(canAccess(db, trialTenantId, 'audit_view')).toBe(true)
  })

  it('enterprise tenant can access workflow_builder', () => {
    expect(canAccess(db, enterpriseTenantId, 'workflow_builder')).toBe(true)
  })

  it('enterprise tenant can access audit_export', () => {
    expect(canAccess(db, enterpriseTenantId, 'audit_export')).toBe(true)
  })
})

describe('isUnderLimit', () => {
  it('returns true when 9 cron_jobs events exist (starter limit is 10)', () => {
    const insertUsage = db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < 9; i++) {
      insertUsage.run(nanoid(), usageTenantId, 'cron_jobs', 1, Date.now())
    }
    expect(isUnderLimit(db, usageTenantId, 'starter', 'cron_jobs')).toBe(true)
  })

  it('returns false when 10 cron_jobs events exist (starter limit is 10, at limit)', () => {
    // Insert 1 more to reach 10 total
    db.prepare(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), usageTenantId, 'cron_jobs', 1, Date.now())
    expect(isUnderLimit(db, usageTenantId, 'starter', 'cron_jobs')).toBe(false)
  })

  it('always returns true for enterprise plan cron_jobs (Infinity limit)', () => {
    expect(isUnderLimit(db, enterpriseTenantId, 'enterprise', 'cron_jobs')).toBe(true)
  })
})

describe('seedFeatureFlags — plan upgrade', () => {
  it('re-seeding with enterprise plan updates all flags correctly', () => {
    const tenantId = nanoid()
    db.prepare(
      'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(tenantId, 'Upgrade Co', 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())

    // Seed as trial
    seedFeatureFlags(db, tenantId, 'trial')
    expect(canAccess(db, tenantId, 'workflow_builder')).toBe(false)
    expect(canAccess(db, tenantId, 'audit_view')).toBe(true)

    // Upgrade to enterprise
    seedFeatureFlags(db, tenantId, 'enterprise')
    expect(canAccess(db, tenantId, 'workflow_builder')).toBe(true)
    expect(canAccess(db, tenantId, 'audit_export')).toBe(true)
    expect(canAccess(db, tenantId, 'audit_view')).toBe(true)
  })
})
