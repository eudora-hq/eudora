import { readFileSync, readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { transformSqliteDdl } from './queryRewriter.js'

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations')

async function columnExists(db, table, column) {
  if (db.dialect === 'postgres') {
    const row = await db.get(
      `SELECT 1 AS present
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
      [table, column]
    )
    return Boolean(row)
  }

  const columns = await db.all(`PRAGMA table_info("${table}")`)
  return columns.some(entry => entry.name === column)
}

async function skipExistingColumns(db, sql) {
  const matches = [...sql.matchAll(
    /ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^;]+);/gi
  )]
  let result = sql

  for (const match of matches) {
    if (await columnExists(db, match[1], match[2])) {
      result = result.replace(match[0], '')
    }
  }
  return result
}

export async function runMigrations(db) {
  const table = db.dialect === 'postgres' ? 'schema_migrations' : '_migrations'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id ${db.dialect === 'postgres' ? 'SERIAL PRIMARY KEY,' : 'INTEGER PRIMARY KEY AUTOINCREMENT,'}
      filename TEXT NOT NULL UNIQUE,
      applied_at ${db.dialect === 'postgres' ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' : 'INTEGER NOT NULL'}
    )
  `)

  const applied = new Set((await db.all(`SELECT filename FROM ${table}`)).map(row => row.filename))
  const files = readdirSync(migrationsDirectory).filter(file => file.endsWith('.sql')).sort()

  for (const file of files) {
    if (applied.has(file)) continue

    let sql = readFileSync(resolve(migrationsDirectory, file), 'utf8')
    sql = await skipExistingColumns(db, sql)
    if (db.dialect === 'postgres') sql = transformSqliteDdl(sql)

    await db.transaction(async transactionDb => {
      if (sql.trim()) await transactionDb.exec(sql)
      if (db.dialect === 'postgres') {
        await transactionDb.query(`INSERT INTO ${table} (filename) VALUES (?)`, [file])
      } else {
        await transactionDb.query(
          `INSERT INTO ${table} (filename, applied_at) VALUES (?, ?)`,
          [file, Date.now()]
        )
      }
    })
    console.log(`Applied: ${file}`)
  }
}
