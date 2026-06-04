import { TIER_LIMITS, FEATURES, FEATURES_BY_PLAN } from '../../../shared/constants/tierLimits.js'

export function canAccess(db, tenantId, feature) {
  if (process.env.SELF_HOSTED === 'true') return true

  const row = db
    .prepare('SELECT enabled FROM feature_flags WHERE tenant_id = ? AND feature = ?')
    .get(tenantId, feature)
  return row?.enabled === 1
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

  const limit = TIER_LIMITS[plan]?.[metric]
  if (limit === undefined || limit === Infinity) return true
  const windowMs = metric === 'messages_per_day' ? 24 * 60 * 60 * 1000 : null
  return getUsage(db, tenantId, metric, windowMs) < limit
}

export function seedFeatureFlags(db, tenantId, plan) {
  const featuresForPlan = FEATURES_BY_PLAN[plan] ?? []
  const allFeatures = Object.values(FEATURES)
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO feature_flags (tenant_id, feature, enabled) VALUES (?, ?, ?)'
  )
  for (const feature of allFeatures) {
    upsert.run(tenantId, feature, featuresForPlan.includes(feature) ? 1 : 0)
  }
}
