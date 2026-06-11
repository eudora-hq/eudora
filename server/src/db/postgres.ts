import pg from 'pg'
import { rewritePlaceholders } from './queryRewriter.ts'

const { Pool, types } = pg
types.setTypeParser(20, value => Number(value))

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
    async columns(table) {
      const result = await client.query(
        `SELECT column_name AS name, data_type AS type
         FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      )
      return result.rows
    },
    async exec(sql) {
      return client.query(sql)
    },
  }
}

export function createPostgresAdapter(options: { pool?: any; connectionString?: string } = {}) {
  const pool = options.pool || new Pool({
    connectionString: options.connectionString || process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  })

  const adapter = {
    ...createClientAdapter(pool),
    pool,
    async sizeBytes() {
      const result = await pool.query('SELECT pg_database_size(current_database()) AS size')
      return Number(result.rows[0]?.size || 0)
    },
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
