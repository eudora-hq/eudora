import { readFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import getDb from '../client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function skipExistingColumns(db, sql) {
  return sql.replace(
    /ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^;]+);/gi,
    (statement, table, column) => {
      const exists = db.prepare(`PRAGMA table_info("${table}")`).all()
        .some((entry) => entry.name === column)
      return exists ? '' : statement
    }
  )
}

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  )

  const files = readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipped: ${file}`)
      continue
    }

    const sql = skipExistingColumns(db, readFileSync(resolve(__dirname, file), 'utf8'))
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(file, Date.now())
    })()

    console.log(`Applied: ${file}`)
  }
}

// Run as standalone script
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const db = getDb()
  runMigrations(db)
}
