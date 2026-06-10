import pg from 'pg'
import { rewritePlaceholders } from './queryRewriter.js'

const { Pool } = pg

function createClientAdapter(client) {
  return {
    dialect: 'postgres',
    raw: client,
    async query(sql, params = []) {
      const result = await client.query(rewritePlaceholders(sql), params)
      return {
        changes: result.rowCount,
        rowCount: result.rowCount,
        rows: result.rows,
      }
    },
    async get(sql, params = []) {
      const result = await client.query(rewritePlaceholders(sql), params)
      return result.rows[0]
    },
    async all(sql, params = []) {
      const result = await client.query(rewritePlaceholders(sql), params)
      return result.rows
    },
    async exec(sql) {
      return client.query(sql)
    },
  }
}

export function createPostgresAdapter(options = {}) {
  const pool = options.pool || new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  })

  const adapter = {
    ...createClientAdapter(pool),
    pool,
    async transaction(callback) {
      const client = await pool.connect()
      const transactionDb = createClientAdapter(client)
      try {
        await client.query('BEGIN')
        const result = await callback(transactionDb)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }

  return adapter
}
