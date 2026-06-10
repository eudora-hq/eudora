import { tenantGet } from '../db/helpers.js'
import { adaptDatabase } from '../db/index.js'

const MAX_CHAIN_DEPTH = 10

/**
 * Validates an ownership assignment and returns the resolved chain.
 *
 * @param {object} db - SQLite DB instance
 * @param {string} ownerId - user_id if ownerType='human', agent_id if ownerType='agent'
 * @param {string} ownerType - 'human' | 'agent'
 * @param {string} tenantId - the tenant making this request
 * @param {string|null} selfId - the agent being created/updated (null for new agents)
 * @returns {{ valid: true, chain: string[] } | { valid: false, error: string, code: string }}
 */
export function validateOwnership(db, ownerId, ownerType, tenantId, selfId = null) {
  db = adaptDatabase(db)
  if (db.dialect === 'sqlite') {
    return validateOwnershipSync(db, ownerId, ownerType, tenantId, selfId)
  }
  return validateOwnershipAsync(db, ownerId, ownerType, tenantId, selfId)
}

function validateOwnershipSync(db, ownerId, ownerType, tenantId, selfId) {
  try {
    if (ownerType === 'human') {
      const user = db.get('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [
        ownerId,
        tenantId,
      ])
      if (!user) {
        return {
          valid: false,
          error: 'Owner user not found in this tenant',
          code: 'invalid_ownership',
        }
      }
      return { valid: true, chain: [] }
    }

    if (ownerType === 'agent') {
      const ownerAgent = db.get(
        'SELECT id, owner_type, owner_id, owner_chain, tenant_id FROM agents WHERE id = ? AND tenant_id = ?',
        [ownerId, tenantId]
      )
      if (!ownerAgent) {
        return {
          valid: false,
          error: 'Owner agent not found in this tenant',
          code: 'invalid_ownership',
        }
      }
      if (selfId && ownerAgent.id === selfId) {
        return {
          valid: false,
          error: 'An agent cannot own itself',
          code: 'ownership_cycle',
        }
      }

      let ownerChain = []
      try {
        ownerChain = JSON.parse(ownerAgent.owner_chain || '[]')
      } catch {
        ownerChain = []
      }
      if (selfId && ownerChain.includes(selfId)) {
        return {
          valid: false,
          error: 'Circular ownership detected',
          code: 'ownership_cycle',
        }
      }
      if (!getHumanRootSync(db, ownerId, tenantId)) {
        return {
          valid: false,
          error: 'Agent ownership chain must terminate at a human user',
          code: 'invalid_ownership',
        }
      }

      const newChain = [ownerId, ...ownerChain]
      if (newChain.length >= MAX_CHAIN_DEPTH) {
        return {
          valid: false,
          error: `Ownership chain cannot exceed ${MAX_CHAIN_DEPTH} levels`,
          code: 'ownership_depth_exceeded',
        }
      }
      return { valid: true, chain: newChain }
    }

    return {
      valid: false,
      error: 'owner_type must be "human" or "agent"',
      code: 'invalid_ownership',
    }
  } catch {
    return {
      valid: false,
      error: 'Ownership validation failed',
      code: 'invalid_ownership',
    }
  }
}

async function validateOwnershipAsync(db, ownerId, ownerType, tenantId, selfId) {
  try {
    if (ownerType === 'human') {
      // Owner must be a real user in this tenant
      const user = await tenantGet(
        db,
        'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
        [ownerId, tenantId]
      )
      if (!user) {
        return {
          valid: false,
          error: 'Owner user not found in this tenant',
          code: 'invalid_ownership',
        }
      }
      return { valid: true, chain: [] }
    }

    if (ownerType === 'agent') {
      // Owner must be a real agent in this tenant
      const ownerAgent = await tenantGet(
        db,
        'SELECT id, owner_type, owner_id, owner_chain, tenant_id FROM agents WHERE id = ? AND tenant_id = ?',
        [ownerId, tenantId]
      )
      if (!ownerAgent) {
        return {
          valid: false,
          error: 'Owner agent not found in this tenant',
          code: 'invalid_ownership',
        }
      }

      // Cannot own yourself
      if (selfId && ownerAgent.id === selfId) {
        return {
          valid: false,
          error: 'An agent cannot own itself',
          code: 'ownership_cycle',
        }
      }

      // Parse owner agent's existing chain
      let ownerChain = []
      try {
        ownerChain = JSON.parse(ownerAgent.owner_chain || '[]')
      } catch {
        ownerChain = []
      }

      // Cycle detection: selfId cannot appear anywhere in the owner's chain
      if (selfId && ownerChain.includes(selfId)) {
        return {
          valid: false,
          error: 'Circular ownership detected',
          code: 'ownership_cycle',
        }
      }

      // The owner agent must itself ultimately be owned by a human
      // Walk the chain to verify human at root
      const humanRoot = await getHumanRoot(db, ownerId, tenantId)
      if (!humanRoot) {
        return {
          valid: false,
          error: 'Agent ownership chain must terminate at a human user',
          code: 'invalid_ownership',
        }
      }

      // Depth check: new chain = [ownerId, ...ownerChain]
      const newChain = [ownerId, ...ownerChain]
      if (newChain.length >= MAX_CHAIN_DEPTH) {
        return {
          valid: false,
          error: `Ownership chain cannot exceed ${MAX_CHAIN_DEPTH} levels`,
          code: 'ownership_depth_exceeded',
        }
      }

      return { valid: true, chain: newChain }
    }

    return {
      valid: false,
      error: 'owner_type must be "human" or "agent"',
      code: 'invalid_ownership',
    }
  } catch {
    return {
      valid: false,
      error: 'Ownership validation failed',
      code: 'invalid_ownership',
    }
  }
}

/**
 * Returns the user_id of the human at the root of an agent's ownership chain.
 * Returns null if no human root is found.
 *
 * @param {object} db
 * @param {string} agentId
 * @param {string} tenantId
 * @returns {string|null}
 */
export function getHumanRoot(db, agentId, tenantId) {
  db = adaptDatabase(db)
  if (db.dialect === 'sqlite') return getHumanRootSync(db, agentId, tenantId)
  return getHumanRootAsync(db, agentId, tenantId)
}

function getHumanRootSync(db, agentId, tenantId) {
  try {
    let currentId = agentId
    let depth = 0

    while (depth < MAX_CHAIN_DEPTH + 1) {
      const agent = db.get(
        'SELECT owner_type, owner_id FROM agents WHERE id = ? AND tenant_id = ?',
        [currentId, tenantId]
      )
      if (!agent) return null

      if (agent.owner_type === 'human') {
        const user = db.get('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [
          agent.owner_id,
          tenantId,
        ])
        return user ? agent.owner_id : null
      }
      if (agent.owner_type === 'agent') {
        currentId = agent.owner_id
        depth++
        continue
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

async function getHumanRootAsync(db, agentId, tenantId) {
  try {
    let currentId = agentId
    let depth = 0

    while (depth < MAX_CHAIN_DEPTH + 1) {
      const agent = await tenantGet(
        db,
        'SELECT owner_type, owner_id FROM agents WHERE id = ? AND tenant_id = ?',
        [currentId, tenantId]
      )

      if (!agent) return null

      if (agent.owner_type === 'human') {
        // Verify the human user actually exists
        const user = await tenantGet(
          db,
          'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
          [agent.owner_id, tenantId]
        )
        return user ? agent.owner_id : null
      }

      if (agent.owner_type === 'agent') {
        currentId = agent.owner_id
        depth++
        continue
      }

      return null
    }

    return null // Exceeded max depth
  } catch {
    return null
  }
}
