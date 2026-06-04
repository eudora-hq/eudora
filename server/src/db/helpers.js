export function tenantQuery(db, sql, params = []) {
  return db.prepare(sql).all(...params)
}

export function tenantGet(db, sql, params = []) {
  return db.prepare(sql).get(...params)
}

export function tenantRun(db, sql, params = []) {
  return db.prepare(sql).run(...params)
}
