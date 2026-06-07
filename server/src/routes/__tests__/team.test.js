import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import authRoutes from '../auth.js'
import teamRoutes from '../team.js'
import { authenticate } from '../../middleware/auth.js'
import { scopeToTenant } from '../../middleware/tenantScope.js'
import { generateAccessToken } from '../../utils/auth.js'

process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum!!'
process.env.JWT_EXPIRES_IN = '15m'
process.env.SELF_HOSTED = 'false'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration006 = readFileSync(
  resolve(__dirname, '../../db/migrations/006_invites.sql'),
  'utf8'
)

let app
let db
let tenantId
let ownerId
let token

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migration001)
  db.exec(migration006)

  tenantId = nanoid()
  ownerId = nanoid()
  db.prepare(`
    INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
    VALUES (?, ?, 'professional', NULL, ?)
  `).run(tenantId, 'Eudora Test Team', Date.now())
  db.prepare(`
    INSERT INTO users (
      id, tenant_id, email, name, password_hash, role, onboarding_completed
    )
    VALUES (?, ?, ?, ?, 'hash', 'owner', 1)
  `).run(ownerId, tenantId, 'owner@example.com', 'Owner User')

  token = generateAccessToken({ userId: ownerId, tenantId, role: 'owner' })

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (
      (request.method === 'GET' && path.startsWith('/auth/invite/')) ||
      (request.method === 'POST' && path === '/auth/accept-invite')
    ) {
      return
    }

    await authenticate(request, reply)
    if (reply.sent) return
    await new Promise((done) => scopeToTenant(request, reply, done))
  })

  await app.register(authRoutes)
  await app.register(teamRoutes, { prefix: '/team' })
  await app.ready()
})

afterEach(async () => {
  process.env.SELF_HOSTED = 'false'
  if (app) await app.close()
  if (db) db.close()
})

function authHeaders() {
  return { authorization: `Bearer ${token}` }
}

async function invite(email = 'member@example.com', role = 'member') {
  return app.inject({
    method: 'POST',
    url: '/team/invite',
    headers: authHeaders(),
    payload: { email, role },
  })
}

describe('team routes', () => {
  it('POST /team/invite with valid email returns 201 and creates invite', async () => {
    const response = await invite()

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      email: 'member@example.com',
      role: 'member',
      inviteUrl: expect.stringContaining('/accept-invite?token='),
    })
    expect(db.prepare('SELECT * FROM invites WHERE email = ?').get('member@example.com'))
      .toMatchObject({ tenant_id: tenantId, status: 'pending', invited_by: ownerId })
  })

  it('POST /team/invite when at seat limit returns 403 seat_limit_reached', async () => {
    db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run('trial', tenantId)

    const response = await invite()

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('seat_limit_reached')
  })

  it('POST /team/invite duplicate email returns 409 already_invited', async () => {
    expect((await invite()).statusCode).toBe(201)

    const response = await invite()

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('already_invited')
  })

  it('POST /team/invite already member returns 409 already_member', async () => {
    const response = await invite('owner@example.com')

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('already_member')
  })

  it('GET /team returns members, pending invites, and seat usage', async () => {
    await invite()

    const response = await app.inject({
      method: 'GET',
      url: '/team',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      members: [expect.objectContaining({ id: ownerId, role: 'owner' })],
      invites: [expect.objectContaining({ email: 'member@example.com' })],
      seatsUsed: 2,
      seatLimit: 10,
    })
  })

  it('DELETE /team/invite/:id cancels invite', async () => {
    const created = (await invite()).json()

    const response = await app.inject({
      method: 'DELETE',
      url: `/team/invite/${created.inviteId}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ cancelled: true })
    expect(db.prepare('SELECT status FROM invites WHERE id = ?').get(created.inviteId).status)
      .toBe('cancelled')
  })

  it('DELETE /team/members/:userId removes member', async () => {
    const memberId = nanoid()
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, password_hash, role)
      VALUES (?, ?, ?, ?, 'hash', 'member')
    `).run(memberId, tenantId, 'remove@example.com', 'Remove Me')

    const response = await app.inject({
      method: 'DELETE',
      url: `/team/members/${memberId}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ removed: true })
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(memberId)).toBeUndefined()
  })

  it('DELETE /team/members/self returns 400 cannot_remove_self', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/team/members/${ownerId}`,
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('cannot_remove_self')
  })

  it('PATCH /team/members/:userId/role changes a member role', async () => {
    const memberId = nanoid()
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, password_hash, role)
      VALUES (?, ?, ?, ?, 'hash', 'member')
    `).run(memberId, tenantId, 'admin@example.com', 'Future Admin')

    const response = await app.inject({
      method: 'PATCH',
      url: `/team/members/${memberId}/role`,
      headers: authHeaders(),
      payload: { role: 'admin' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ role: 'admin' })
    expect(db.prepare('SELECT role FROM users WHERE id = ?').get(memberId).role).toBe('admin')
  })

  it('GET /auth/invite/:token valid returns invite details', async () => {
    const created = (await invite()).json()
    const inviteToken = new URL(created.inviteUrl).searchParams.get('token')

    const response = await app.inject({
      method: 'GET',
      url: `/auth/invite/${inviteToken}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      email: 'member@example.com',
      role: 'member',
      tenantName: 'Eudora Test Team',
    })
  })

  it('GET /auth/invite/:token expired returns 404', async () => {
    const created = (await invite()).json()
    const inviteToken = new URL(created.inviteUrl).searchParams.get('token')
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run(Date.now() - 1, inviteToken)

    const response = await app.inject({
      method: 'GET',
      url: `/auth/invite/${inviteToken}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('invalid_invite')
  })

  it('POST /auth/accept-invite valid creates user in correct tenant', async () => {
    const created = (await invite('accepted@example.com', 'admin')).json()
    const inviteToken = new URL(created.inviteUrl).searchParams.get('token')

    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: {
        token: inviteToken,
        name: 'Accepted User',
        password: 'password123',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      onboardingCompleted: true,
      user: {
        email: 'accepted@example.com',
        name: 'Accepted User',
        role: 'admin',
        onboardingCompleted: true,
      },
    })
    expect(db.prepare('SELECT * FROM users WHERE email = ?').get('accepted@example.com'))
      .toMatchObject({
        tenant_id: tenantId,
        role: 'admin',
        onboarding_completed: 1,
      })
    expect(db.prepare('SELECT status FROM invites WHERE token = ?').get(inviteToken).status)
      .toBe('accepted')
  })

  it('POST /auth/accept-invite expired token returns 404', async () => {
    const created = (await invite()).json()
    const inviteToken = new URL(created.inviteUrl).searchParams.get('token')
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run(Date.now() - 1, inviteToken)

    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: {
        token: inviteToken,
        name: 'Expired User',
        password: 'password123',
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('invalid_invite')
  })

  it('POST /auth/accept-invite email already taken returns 409', async () => {
    const created = (await invite('taken@example.com')).json()
    const inviteToken = new URL(created.inviteUrl).searchParams.get('token')
    const otherTenantId = nanoid()
    db.prepare(`
      INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
      VALUES (?, 'Other Tenant', 'trial', ?, ?)
    `).run(otherTenantId, Date.now() + 100000, Date.now())
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, password_hash, role)
      VALUES (?, ?, 'taken@example.com', 'Existing User', 'hash', 'owner')
    `).run(nanoid(), otherTenantId)

    const response = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: {
        token: inviteToken,
        name: 'Duplicate User',
        password: 'password123',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('email_taken')
  })
})
