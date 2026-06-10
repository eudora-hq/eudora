import { createPostgresAdapter } from './postgres.js'
import { createSQLiteAdapter } from './sqlite.js'

let db

export function adaptDatabase(candidate) {
  if (!candidate) return getDb()
  if (candidate.dialect && candidate.query && candidate.get && candidate.all) return candidate
  if (typeof candidate.prepare === 'function') return createSQLiteAdapter({ raw: candidate, path: ':memory:' })
  return candidate
}

export function getDb() {
  if (!db) {
    if (process.env.DATABASE_URL) {
      db = createPostgresAdapter()
      console.log('[db] Using Postgres (DATABASE_URL)')
    } else {
      db = createSQLiteAdapter()
      console.log(`[db] Using SQLite (${db.path})`)
    }
  }
  return db
}

export function setDbForTests(nextDb) {
  db = nextDb ? adaptDatabase(nextDb) : undefined
}

export default getDb
