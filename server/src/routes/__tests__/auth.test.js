import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import jwt from 'jsonwebtoken'
import authRoutes from '../auth.js'
import agentsRoutes from '../agents.js'
import { hashRefreshToken, generateAccessToken } from '../../utils/auth.js'
import { authenticate } from '../../middleware/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

let app
let db

beforeAll(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  await app.register(authRoutes)
  await app.ready()
}, 30000)

afterAll(async () => {
  if (app) await app.close()
  if (db) db.close()
})

async function register(overrides = {}) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
      ...overrides,
    },
  })
}

async function login(email = 'test@example.com', password = 'password123') {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })
}

describe('POST /auth/register', () => {
  it('returns 201 with tenantId, userId, email for valid data', async () => {
    const res = await register({ email: 'new1@example.com' })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('tenantId')
    expect(body).toHaveProperty('userId')
    expect(body.email).toBe('new1@example.com')
  })

  it('returns 409 for duplicate email', async () => {
    await register({ email: 'dup@example.com' })
    const res = await register({ email: 'dup@example.com' })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('email_already_registered')
  })

  it('returns 400 when name is missing', async () => {
    const res = await register({ name: '' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('validation_error')
  })

  it('returns 400 when password is shorter than 8 characters', async () => {
    const res = await register({ email: 'short@example.com', password: 'abc123' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('validation_error')
  })
})

describe('POST /auth/login', () => {
  beforeAll(async () => {
    await register({ email: 'login@example.com' })
  }, 30000)

  it('returns 200 with accessToken and refreshToken for correct credentials', async () => {
    const res = await login('login@example.com')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('accessToken')
    expect(body).toHaveProperty('refreshToken')
    expect(body.user.email).toBe('login@example.com')
  })

  it('returns 401 invalid_credentials for wrong password', async () => {
    const res = await login('login@example.com', 'wrongpassword')
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('invalid_credentials')
  })

  it('returns 401 invalid_credentials for unknown email (same message)', async () => {
    const res = await login('nobody@example.com', 'password123')
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('invalid_credentials')
  })
})

describe('POST /auth/refresh', () => {
  let refreshToken

  beforeAll(async () => {
    await register({ email: 'refresh@example.com' })
    const res = await login('refresh@example.com')
    refreshToken = JSON.parse(res.body).refreshToken
  }, 30000)

  it('returns 200 with new token pair for valid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('accessToken')
    expect(body).toHaveProperty('refreshToken')
    refreshToken = body.refreshToken
  })

  it('returns 401 when the same token is used a second time (rotation)', async () => {
    const firstRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    })
    expect(firstRes.statusCode).toBe(200)
    const staleToken = refreshToken

    const secondRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: staleToken },
    })
    expect(secondRes.statusCode).toBe(401)
  })

  it('returns 401 for expired token', async () => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('refresh@example.com')
    const expiredTokenId = nanoid()
    const rawToken = 'expiredtoken'
    db.prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(expiredTokenId, user.id, hashRefreshToken(rawToken), Date.now() - 1000, Date.now())

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rawToken },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('refresh_token_expired')
  })
})

describe('POST /auth/logout', () => {
  it('returns 200 and the token no longer works for refresh', async () => {
    await register({ email: 'logout@example.com' })
    const loginRes = await login('logout@example.com')
    const { refreshToken } = JSON.parse(loginRes.body)

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    })
    expect(logoutRes.statusCode).toBe(200)
    expect(JSON.parse(logoutRes.body).success).toBe(true)

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    })
    expect(refreshRes.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// JWT middleware tests – uses a separate app with global auth hook + agents
// ---------------------------------------------------------------------------

const PUBLIC_ROUTES = new Set([
  'GET /health',
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/refresh',
])

describe('JWT middleware', () => {
  let mApp
  let mDb

  beforeAll(async () => {
    mDb = new Database(':memory:')
    mDb.pragma('foreign_keys = ON')
    mDb.exec(migrationSql)

    mApp = Fastify({ logger: false })
    mApp.decorate('db', mDb)

    mApp.addHook('preHandler', async (request, reply) => {
      const key = `${request.method} ${request.url.split('?')[0]}`
      if (PUBLIC_ROUTES.has(key)) return
      return authenticate(request, reply)
    })

    mApp.get('/health', async () => ({ status: 'ok' }))
    await mApp.register(authRoutes)
    await mApp.register(agentsRoutes, { prefix: '/agents' })
    await mApp.ready()
  }, 30000)

  afterAll(async () => {
    if (mApp) await mApp.close()
    if (mDb) mDb.close()
  })

  it('GET /agents with no token → 401', async () => {
    const res = await mApp.inject({ method: 'GET', url: '/agents' })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('unauthorized')
  })

  it('GET /agents with expired JWT → 401', async () => {
    const expired = jwt.sign(
      { userId: 'u1', tenantId: 't1', role: 'member', exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    )
    const res = await mApp.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization: `Bearer ${expired}` },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('unauthorized')
  })

  it('GET /agents with tampered JWT → 401', async () => {
    const valid = generateAccessToken({ userId: 'u1', tenantId: 't1', role: 'member' })
    const parts = valid.split('.')
    parts[2] = parts[2].slice(0, -5) + 'XXXXX'
    const tampered = parts.join('.')
    const res = await mApp.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization: `Bearer ${tampered}` },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('unauthorized')
  })

  it('GET /agents with valid JWT → 200 (stub returns [])', async () => {
    const token = generateAccessToken({ userId: 'u1', tenantId: 't1', role: 'member' })
    const res = await mApp.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('GET /health without token → 200 (public route)', async () => {
    const res = await mApp.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('POST /auth/login without token → accessible (public route, not 401 unauthorized)', async () => {
    // Register first so login can succeed
    await mApp.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: 'Mid Test', email: 'midtest@example.com', password: 'password123' },
    })
    const res = await mApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'midtest@example.com', password: 'password123' },
    })
    expect(res.statusCode).toBe(200)
  })
})
