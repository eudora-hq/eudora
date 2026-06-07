import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import notificationsRoutes from '../notifications.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration007 = readFileSync(
  resolve(__dirname, '../../db/migrations/007_notifications.sql'),
  'utf8'
)

let app
let db
let tenantId
let userId

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migration001)
  db.exec(migration007)

  tenantId = nanoid()
  userId = nanoid()
  db.prepare(`
    INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
    VALUES (?, ?, 'trial', ?, ?)
  `).run(tenantId, 'Notification Tenant', Date.now() + 2 * 24 * 60 * 60 * 1000, Date.now())
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, ?, 'hash', 'owner')
  `).run(userId, tenantId, 'owner@example.com')

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request) => {
    request.tenantId = tenantId
    request.user = { userId, tenantId, role: 'owner' }
  })
  await app.register(notificationsRoutes, { prefix: '/notifications' })
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  if (db) db.close()
})

function insertNotification(overrides = {}) {
  const id = nanoid()
  db.prepare(`
    INSERT INTO notifications (
      id, tenant_id, user_id, type, title, message, read, action_url, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    tenantId,
    overrides.userId ?? null,
    overrides.type || 'high_risk',
    overrides.title || 'High risk',
    overrides.message || 'Review this interaction',
    overrides.read || 0,
    overrides.actionUrl || '/audit',
    overrides.createdAt || Date.now()
  )
  return id
}

describe('notifications routes', () => {
  it('GET /notifications returns visible notifications and unread count', async () => {
    insertNotification()
    insertNotification({ read: 1 })

    const response = await app.inject({ method: 'GET', url: '/notifications' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      unreadCount: 2,
      notifications: expect.arrayContaining([
        expect.objectContaining({ type: 'high_risk' }),
        expect.objectContaining({ type: 'trial_expiring' }),
      ]),
    })
  })

  it('POST /notifications/:id/read marks one notification as read', async () => {
    const id = insertNotification()

    const response = await app.inject({
      method: 'POST',
      url: `/notifications/${id}/read`,
    })

    expect(response.statusCode).toBe(200)
    expect(db.prepare('SELECT read FROM notifications WHERE id = ?').get(id).read).toBe(1)
  })

  it('POST /notifications/read-all marks visible notifications as read', async () => {
    insertNotification()
    insertNotification({ userId })

    const response = await app.inject({
      method: 'POST',
      url: '/notifications/read-all',
    })

    expect(response.statusCode).toBe(200)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE tenant_id = ? AND read = 0')
        .get(tenantId).count
    ).toBe(0)
  })

  it('DELETE /notifications/:id dismisses a notification', async () => {
    const id = insertNotification()

    const response = await app.inject({
      method: 'DELETE',
      url: `/notifications/${id}`,
    })

    expect(response.statusCode).toBe(200)
    expect(db.prepare('SELECT id FROM notifications WHERE id = ?').get(id)).toBeUndefined()
  })

  it('trial warning is created only once', async () => {
    await app.inject({ method: 'GET', url: '/notifications' })
    await app.inject({ method: 'GET', url: '/notifications' })

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type = 'trial_expiring'")
        .get().count
    ).toBe(1)
  })
})
