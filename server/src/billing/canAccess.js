import { TIER_LIMITS, FEATURES, FEATURES_BY_PLAN } from '../../../shared/constants/tierLimits.js'

export function normalizePlan(plan) {
  return plan || 'trial'
}

export function canAccess(db, tenantId, feature) {
  if (process.env.SELF_HOSTED === 'true') return true

  const row = db
    .prepare('SELECT enabled FROM feature_flags WHERE tenant_id = ? AND feature = ?')
    .get(tenantId, feature)
  if (row) return row.enabled === 1

  const tenant = db.prepare('SELECT plan FROM tenants WHERE id = ?').get(tenantId)
  const featuresForPlan = FEATURES_BY_PLAN[normalizePlan(tenant?.plan)] || {}
  return featuresForPlan[feature] === true
}

export function getUsage(db, tenantId, eventType, windowMs = null) {
  let sql =
    'SELECT COALESCE(SUM(value), 0) AS total FROM usage_events WHERE tenant_id = ? AND event_type = ?'
  const params = [tenantId, eventType]
  if (windowMs !== null) {
    sql += ' AND ts > ?'
    params.push(Date.now() - windowMs)
  }
  const row = db.prepare(sql).get(...params)
  return row?.total ?? 0
}

export function isUnderLimit(db, tenantId, plan, metric) {
  if (process.env.SELF_HOSTED === 'true') return true

  if (metric === 'agents') return isUnderAgentLimit(db, tenantId, plan)

  const limit = TIER_LIMITS[normalizePlan(plan)]?.[metric]
  if (limit === undefined || limit === Infinity) return true
  const windowMs = metric === 'messages_per_day' ? 24 * 60 * 60 * 1000 : null
  return getUsage(db, tenantId, metric, windowMs) < limit
}

export function isUnderAgentLimit(db, tenantId, plan) {
  if (process.env.SELF_HOSTED === 'true') return true

  const limit = TIER_LIMITS[normalizePlan(plan)]?.agents
  if (limit === undefined || limit === Infinity) return true
  const used = db.prepare('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ?')
    .get(tenantId).count
  return used < limit
}

export function seedFeatureFlags(db, tenantId, plan) {
  const featuresForPlan = FEATURES_BY_PLAN[normalizePlan(plan)] ?? {}
  const allFeatures = Object.values(FEATURES)
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO feature_flags (tenant_id, feature, enabled) VALUES (?, ?, ?)'
  )
  for (const feature of allFeatures) {
    upsert.run(tenantId, feature, featuresForPlan[feature] === true ? 1 : 0)
  }
}
