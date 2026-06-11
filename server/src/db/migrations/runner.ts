import { resolve } from 'path'
import { fileURLToPath } from 'url'
import getDb from '../index.ts'
export { runMigrations } from '../migrations.ts'
import { runMigrations } from '../migrations.ts'

// Run as standalone script
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const db = getDb()
  await runMigrations(db)
  await db.close()
}
