export async function tenantQuery(db: any, sql: any, params: any[] = []) {
  return await db.all(sql, params)
}

export async function tenantGet(db: any, sql: any, params: any[] = []) {
  return await db.get(sql, params)
}

export async function tenantRun(db: any, sql: any, params: any[] = []) {
  return await db.query(sql, params)
}
