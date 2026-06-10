import { resolve } from 'path'
import { fileURLToPath } from 'url'
import getDb from '../index.js'
export { runMigrations } from '../migrations.js'
import { runMigrations } from '../migrations.js'

// Run as standalone script
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const db = getDb()
  await runMigrations(db)
  await db.close()
}
