import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function createSQLiteAdapter(options = {}) {
  const path = options.path || process.env.DATABASE_PATH || process.env.DB_PATH
    || resolve(__dirname, '../../../data/eudora.db')
  if (!options.raw && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = options.raw || new Database(path)

  if (!options.raw) {
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')
  }

  const adapter = {
    dialect: 'sqlite',
    path,
    raw,
    query(sql, params = []) {
      return raw.prepare(sql).run(...params)
    },
    get(sql, params = []) {
      return raw.prepare(sql).get(...params)
    },
    all(sql, params = []) {
      return raw.prepare(sql).all(...params)
    },
    exec(sql) {
      return raw.exec(sql)
    },
    async transaction(callback) {
      raw.exec('BEGIN')
      try {
        const result = await callback(adapter)
        raw.exec('COMMIT')
        return result
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    async close() {
      raw.close()
    },
  }

  return adapter
}
