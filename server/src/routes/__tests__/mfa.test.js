import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { generate } from 'otplib'
import authRoutes from '../auth.js'
import { generateAccessToken } from '../../utils/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'

let app
let db
let accessToken
let secret

beforeAll(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  await app.register(authRoutes)
  await app.ready()

  const registration = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'MFA User',
      email: 'mfa@example.com',
      password: 'password123',
    },
  })
  const registered = registration.json()
  accessToken = generateAccessToken({
    userId: registered.userId,
    tenantId: registered.tenantId,
    role: 'owner',
  })
})

afterAll(async () => {
  if (app) await app.close()
  if (db) db.close()
})

function authHeaders() {
  return { authorization: `Bearer ${accessToken}` }
}

describe('TOTP MFA', () => {
  it('requires authentication for setup', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
    })

    expect(response.statusCode).toBe(401)
  })

  it('generates a pending secret and QR code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      secret: expect.any(String),
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      otpauth: expect.stringMatching(/^otpauth:\/\/totp\//),
    })
    secret = response.json().secret
    expect(
      db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get('mfa@example.com').mfa_secret
    ).toBe(`pending:${secret}`)
  })

  it('rejects an invalid setup verification code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: authHeaders(),
      payload: { code: '000000' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_code')
  })

  it('activates MFA with a valid TOTP code', async () => {
    const code = await generate({ secret })
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: authHeaders(),
      payload: { code },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ enabled: true })
    expect(
      db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get('mfa@example.com').mfa_secret
    ).toBe(secret)
  })

  it('requires MFA during login and rejects an invalid code', async () => {
    const firstStep = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'mfa@example.com', password: 'password123' },
    })
    expect(firstStep.statusCode).toBe(200)
    expect(firstStep.json()).toEqual({
      mfaRequired: true,
      email: 'mfa@example.com',
    })
    expect(firstStep.json()).not.toHaveProperty('accessToken')

    const invalid = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'mfa@example.com',
        password: 'password123',
        mfaCode: '000000',
      },
    })
    expect(invalid.statusCode).toBe(401)
    expect(invalid.json().error).toBe('invalid_mfa_code')
  })

  it('issues tokens after password and valid MFA verification', async () => {
    const code = await generate({ secret })
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'mfa@example.com',
        password: 'password123',
        mfaCode: code,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { email: 'mfa@example.com' },
    })
  })

  it('disables MFA only with a valid current code', async () => {
    const code = await generate({ secret })
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: authHeaders(),
      payload: { code },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ disabled: true })
    expect(
      db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get('mfa@example.com').mfa_secret
    ).toBeNull()
  })
})
