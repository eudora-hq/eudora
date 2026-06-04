import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { validateOwnership, getHumanRoot } from '../ownershipChain.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schemaSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

function createTestDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Run initial schema
  schemaSql.split(';').map(s => s.trim()).filter(Boolean).forEach(sql => {
    try {
      db.prepare(sql).run()
    } catch {
      // Some migration statements are intentionally idempotent in this fixture.
    }
  })
  // Add ownership columns (migration 002)
  const ownership002 = [
    `ALTER TABLE agents ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'human'`,
    `ALTER TABLE agents ADD COLUMN owner_id TEXT`,
    `ALTER TABLE agents ADD COLUMN owner_chain TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE audit_log ADD COLUMN initiated_by_user_id TEXT`,
    `ALTER TABLE audit_log ADD COLUMN agent_chain TEXT DEFAULT '[]'`,
  ]
  ownership002.forEach(sql => {
    try {
      db.prepare(sql).run()
    } catch {
      // Columns may already exist if the schema fixture changes.
    }
  })
  return db
}

function insertTenant(db, id = 'tenant1') {
  db.prepare(`INSERT INTO tenants (id, name, plan, created_at) VALUES (?, 'Test', 'trial', ?)`)
    .run(id, Date.now())
  return id
}

function insertUser(db, tenantId, userId = 'user1', role = 'owner') {
  db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, 'hash', ?)`)
    .run(userId, tenantId, `${userId}@test.com`, role)
  return userId
}

function insertAgent(db, tenantId, agentId, ownerType = 'human', ownerId = 'user1', ownerChain = []) {
  db.prepare(`INSERT INTO agents
    (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
    VALUES (?, ?, 'Agent', 'Test', 'anthropic', ?, ?, ?, ?)`)
    .run(agentId, tenantId, ownerType, ownerId, JSON.stringify(ownerChain), Date.now())
  return agentId
}

describe('validateOwnership', () => {
  let db, tenantId, userId

  beforeEach(() => {
    db = createTestDb()
    tenantId = insertTenant(db)
    userId = insertUser(db, tenantId)
  })

  it('human owner with valid userId → valid, empty chain', () => {
    const result = validateOwnership(db, userId, 'human', tenantId, null)
    expect(result.valid).toBe(true)
    expect(result.chain).toEqual([])
  })

  it('human owner with non-existent userId → invalid', () => {
    const result = validateOwnership(db, 'nonexistent', 'human', tenantId, null)
    expect(result.valid).toBe(false)
    expect(result.code).toBe('invalid_ownership')
  })

  it('agent owned by another agent whose chain reaches a human → valid', () => {
    // agentA is owned by human
    insertAgent(db, tenantId, 'agentA', 'human', userId, [])
    // agentB is owned by agentA
    const result = validateOwnership(db, 'agentA', 'agent', tenantId, 'agentB')
    expect(result.valid).toBe(true)
    expect(result.chain).toEqual(['agentA'])
  })

  it('agent owned by another agent with no human at root → invalid', () => {
    // agentOrphan has no valid human owner
    db.prepare(`INSERT INTO agents
      (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
      VALUES ('agentOrphan', ?, 'Orphan', 'Test', 'anthropic', 'human', 'nonexistent_user', '[]', ?)`)
      .run(tenantId, Date.now())

    const result = validateOwnership(db, 'agentOrphan', 'agent', tenantId, 'agentB')
    expect(result.valid).toBe(false)
    expect(result.code).toBe('invalid_ownership')
  })

  it('agent cannot own itself → invalid', () => {
    insertAgent(db, tenantId, 'agentA', 'human', userId, [])
    const result = validateOwnership(db, 'agentA', 'agent', tenantId, 'agentA')
    expect(result.valid).toBe(false)
    expect(result.code).toBe('ownership_cycle')
  })

  it('cycle detection: agent A → agent B → agent A → invalid', () => {
    // agentA owned by human
    insertAgent(db, tenantId, 'agentA', 'human', userId, [])
    // agentB owned by agentA — chain is ['agentA']
    insertAgent(db, tenantId, 'agentB', 'agent', 'agentA', ['agentA'])
    // Now try to make agentA owned by agentB — this would create a cycle
    const result = validateOwnership(db, 'agentB', 'agent', tenantId, 'agentA')
    expect(result.valid).toBe(false)
    expect(result.code).toBe('ownership_cycle')
  })

  it('chain depth > 10 levels → invalid', () => {
    // Create a chain of 10 agents, each owned by the previous
    let prevId = 'agentRoot'
    insertAgent(db, tenantId, prevId, 'human', userId, [])
    const chain = []
    for (let i = 1; i <= 9; i++) {
      const agentId = `agent${i}`
      chain.unshift(prevId)
      insertAgent(db, tenantId, agentId, 'agent', prevId, [...chain])
      prevId = agentId
    }
    // Now try to add an 11th level
    const result = validateOwnership(db, prevId, 'agent', tenantId, 'agentNew')
    expect(result.valid).toBe(false)
    expect(result.code).toBe('ownership_depth_exceeded')
  })

  it('cross-tenant ownership → invalid', () => {
    const otherTenantId = insertTenant(db, 'othertenant')
    const otherUserId = insertUser(db, otherTenantId, 'otheruser')
    const result = validateOwnership(db, otherUserId, 'human', tenantId, null)
    expect(result.valid).toBe(false)
  })
})

describe('getHumanRoot', () => {
  let db, tenantId, userId

  beforeEach(() => {
    db = createTestDb()
    tenantId = insertTenant(db)
    userId = insertUser(db, tenantId)
  })

  it('agent directly owned by human → returns user_id', () => {
    insertAgent(db, tenantId, 'agentA', 'human', userId, [])
    const root = getHumanRoot(db, 'agentA', tenantId)
    expect(root).toBe(userId)
  })

  it('3-level chain → returns human user_id at root', () => {
    insertAgent(db, tenantId, 'agentA', 'human', userId, [])
    insertAgent(db, tenantId, 'agentB', 'agent', 'agentA', ['agentA'])
    insertAgent(db, tenantId, 'agentC', 'agent', 'agentB', ['agentB', 'agentA'])
    const root = getHumanRoot(db, 'agentC', tenantId)
    expect(root).toBe(userId)
  })

  it('orphaned agent with invalid human owner → returns null', () => {
    db.prepare(`INSERT INTO agents
      (id, tenant_id, name, purpose, model_provider, owner_type, owner_id, owner_chain, created_at)
      VALUES ('agentOrphan', ?, 'Orphan', 'Test', 'anthropic', 'human', 'invalid_user', '[]', ?)`)
      .run(tenantId, Date.now())
    const root = getHumanRoot(db, 'agentOrphan', tenantId)
    expect(root).toBeNull()
  })
})
