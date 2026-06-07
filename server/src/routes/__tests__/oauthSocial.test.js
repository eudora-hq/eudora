import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import authRoutes from '../auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.CLIENT_URL = 'http://localhost:5173'
process.env.API_URL = 'http://localhost:3001'
process.env.GOOGLE_CLIENT_ID = 'google-client'
process.env.GOOGLE_CLIENT_SECRET = 'google-secret'
process.env.GITHUB_CLIENT_ID = 'github-client'
process.env.GITHUB_CLIENT_SECRET = 'github-secret'

let app
let db

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  await app.register(authRoutes)
  await app.ready()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (app) await app.close()
  if (db) db.close()
})

async function oauthState(provider) {
  const response = await app.inject({
    method: 'GET',
    url: `/auth/oauth/${provider}`,
  })
  const location = response.headers.location
  return {
    response,
    location,
    state: new URL(location).searchParams.get('state'),
  }
}

describe('Google OAuth', () => {
  it('redirects to Google with the backend callback and state', async () => {
    const { response, location, state } = await oauthState('google')

    expect(response.statusCode).toBe(302)
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth?')
    expect(state).toBeTruthy()
    expect(new URL(location).searchParams.get('redirect_uri'))
      .toBe('http://localhost:3001/auth/callback/google')
  })

  it('creates a trial user and redirects to the frontend with tokens', async () => {
    const { state } = await oauthState('google')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'google-access-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'google-user-id',
          email: 'new-google@example.com',
          name: 'Google User',
          verified_email: true,
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=google-code&state=${state}`,
    })

    expect(response.statusCode).toBe(302)
    const redirect = new URL(response.headers.location)
    expect(`${redirect.origin}${redirect.pathname}`).toBe('http://localhost:5173/auth/callback')
    expect(redirect.searchParams.get('accessToken')).toBeTruthy()
    expect(redirect.searchParams.get('refreshToken')).toBeTruthy()
    expect(redirect.searchParams.get('onboardingCompleted')).toBe('false')

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('new-google@example.com')
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(user.tenant_id)
    expect(user).toMatchObject({ role: 'owner', onboarding_completed: 0 })
    expect(tenant.plan).toBe('trial')
    expect(tenant.trial_ends_at).toBeGreaterThan(Date.now())
  })

  it('logs in an existing user without creating another tenant', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Existing User',
        email: 'existing@example.com',
        password: 'password123',
      },
    })
    const tenantCount = db.prepare('SELECT COUNT(*) AS count FROM tenants').get().count
    const { state } = await oauthState('google')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'google-access-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'existing-google-id',
          email: 'existing@example.com',
          name: 'Existing User',
          verified_email: true,
        }),
      }))

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback/google?code=google-code&state=${state}`,
    })

    expect(response.statusCode).toBe(302)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tenants').get().count).toBe(tenantCount)
    expect(db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?')
      .get('existing@example.com').count).toBe(1)
  })
})

describe('GitHub OAuth', () => {
  it('redirects to GitHub with user:email scope', async () => {
    const { response, location, state } = await oauthState('github')

    expect(response.statusCode).toBe(302)
    expect(location).toContain('https://github.com/login/oauth/authorize?')
    expect(state).toBeTruthy()
    expect(new URL(location).searchParams.get('scope')).toBe('user:email')
  })

  it('uses a verified private email and creates the user', async () => {
    const { state } = await oauthState('github')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'github-access-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          login: 'octocat',
          name: 'Octo Cat',
          email: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: 'octocat@example.com', primary: false, verified: true },
        ],
      })
    vi.stubGlobal('fetch', fetchMock)

    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback/github?code=github-code&state=${state}`,
    })

    expect(response.statusCode).toBe(302)
    expect(db.prepare('SELECT email FROM users').get().email).toBe('octocat@example.com')
    expect(new URL(response.headers.location).pathname).toBe('/auth/callback')
  })

  it('rejects an invalid state before exchanging a code', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await app.inject({
      method: 'GET',
      url: '/auth/callback/github?code=github-code&state=invalid',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(
      'http://localhost:5173/login?error=oauth_invalid_state'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
