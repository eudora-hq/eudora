export async function tenantQuery(db, sql, params = []) {
  return await db.all(sql, params)
}

export async function tenantGet(db, sql, params = []) {
  return await db.get(sql, params)
}

export async function tenantRun(db, sql, params = []) {
  return await db.query(sql, params)
}
