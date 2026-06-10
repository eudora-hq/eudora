import { TIER_LIMITS, FEATURES, FEATURES_BY_PLAN } from '../../../shared/constants/tierLimits.js'
import { adaptDatabase } from '../db/index.js'

export function normalizePlan(plan) {
  return plan || 'trial'
}

export function canAccess(db, tenantId, feature) {
  db = adaptDatabase(db)
  if (process.env.SELF_HOSTED === 'true') return true
  if (db.dialect === 'sqlite') {
    const row = db.get(
      'SELECT enabled FROM feature_flags WHERE tenant_id = ? AND feature = ?',
      [tenantId, feature]
    )
    if (row) return row.enabled === 1

    const tenant = db.get('SELECT plan FROM tenants WHERE id = ?', [tenantId])
    const featuresForPlan = FEATURES_BY_PLAN[normalizePlan(tenant?.plan)] || {}
    return featuresForPlan[feature] === true
  }

  return canAccessPostgres(db, tenantId, feature)
}

async function canAccessPostgres(db, tenantId, feature) {
  const row = await db.get(
    'SELECT enabled FROM feature_flags WHERE tenant_id = ? AND feature = ?',
    [tenantId, feature]
  )
  if (row) return row.enabled === 1

  const tenant = await db.get('SELECT plan FROM tenants WHERE id = ?', [tenantId])
  const featuresForPlan = FEATURES_BY_PLAN[normalizePlan(tenant?.plan)] || {}
  return featuresForPlan[feature] === true
}

export function getUsage(db, tenantId, eventType, windowMs = null) {
  db = adaptDatabase(db)
  let sql =
    'SELECT COALESCE(SUM(value), 0) AS total FROM usage_events WHERE tenant_id = ? AND event_type = ?'
  const params = [tenantId, eventType]
  if (windowMs !== null) {
    sql += ' AND ts > ?'
    params.push(Date.now() - windowMs)
  }
  if (db.dialect === 'sqlite') {
    const row = db.get(sql, params)
    return row?.total ?? 0
  }
  return getUsagePostgres(db, sql, params)
}

async function getUsagePostgres(db, sql, params) {
  const row = await db.get(sql, params)
  return row?.total ?? 0
}

export function isUnderLimit(db, tenantId, plan, metric) {
  if (process.env.SELF_HOSTED === 'true') return true

  if (metric === 'agents') return isUnderAgentLimit(db, tenantId, plan)

  const limit = TIER_LIMITS[normalizePlan(plan)]?.[metric]
  if (limit === undefined || limit === Infinity) return true
  const windowMs = metric === 'messages_per_day' ? 24 * 60 * 60 * 1000 : null
  const usage = getUsage(db, tenantId, metric, windowMs)
  if (usage && typeof usage.then === 'function') {
    return usage.then((value) => value < limit)
  }
  return usage < limit
}

export function isUnderAgentLimit(db, tenantId, plan) {
  db = adaptDatabase(db)
  if (process.env.SELF_HOSTED === 'true') return true

  const limit = TIER_LIMITS[normalizePlan(plan)]?.agents
  if (limit === undefined || limit === Infinity) return true
  if (db.dialect === 'sqlite') {
    const row = db.get('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ?', [tenantId])
    return row.count < limit
  }
  return isUnderAgentLimitPostgres(db, tenantId, limit)
}

async function isUnderAgentLimitPostgres(db, tenantId, limit) {
  const row = await db.get('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ?', [tenantId])
  return row.count < limit
}

export function seedFeatureFlags(db, tenantId, plan) {
  db = adaptDatabase(db)
  const featuresForPlan = FEATURES_BY_PLAN[normalizePlan(plan)] ?? {}
  const allFeatures = Object.values(FEATURES)
  if (db.dialect === 'sqlite') {
    for (const feature of allFeatures) {
      db.query(
        `INSERT INTO feature_flags (tenant_id, feature, enabled)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, feature) DO UPDATE SET enabled = excluded.enabled`,
        [tenantId, feature, featuresForPlan[feature] === true ? 1 : 0]
      )
    }
    return
  }
  return seedFeatureFlagsPostgres(db, tenantId, featuresForPlan, allFeatures)
}

async function seedFeatureFlagsPostgres(db, tenantId, featuresForPlan, allFeatures) {
  for (const feature of allFeatures) {
    await db.query(
      `INSERT INTO feature_flags (tenant_id, feature, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, feature) DO UPDATE SET enabled = excluded.enabled`,
      [tenantId, feature, featuresForPlan[feature] === true ? 1 : 0]
    )
  }
}
