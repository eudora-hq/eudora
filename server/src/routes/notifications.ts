import { adaptDatabase } from '../db/index.ts'
import { createNotification } from '../utils/notify.ts'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

export default async function notificationsRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

  fastify.get('/', async (request) => {
    await ensureTrialNotification(db, request.tenantId)

    const notifications = await db.all(`
      SELECT *
      FROM notifications
      WHERE tenant_id = ? AND (user_id IS NULL OR user_id = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `, [request.tenantId, request.user.userId])

    return {
      notifications,
      unreadCount: notifications.filter(notification => !notification.read).length,
    }
  })

  fastify.post('/read-all', async (request, reply) => {
    await db.query(`
      UPDATE notifications
      SET read = 1
      WHERE tenant_id = ? AND (user_id IS NULL OR user_id = ?)
    `, [request.tenantId, request.user.userId])
    return reply.send({ read: true })
  })

  fastify.post('/:id/read', async (request, reply) => {
    await db.query(`
      UPDATE notifications
      SET read = 1
      WHERE id = ? AND tenant_id = ? AND (user_id IS NULL OR user_id = ?)
    `, [request.params.id, request.tenantId, request.user.userId])
    return reply.send({ read: true })
  })

  fastify.delete('/:id', async (request, reply) => {
    await db.query(`
      DELETE FROM notifications
      WHERE id = ? AND tenant_id = ? AND (user_id IS NULL OR user_id = ?)
    `, [request.params.id, request.tenantId, request.user.userId])
    return reply.send({ deleted: true })
  })
}

async function ensureTrialNotification(db, tenantId) {
  const tenant = await db.get(
    'SELECT plan, trial_ends_at FROM tenants WHERE id = ?',
    [tenantId]
  )

  if (!tenant || tenant.plan !== 'trial' || tenant.trial_ends_at === null) return

  const remainingMs = tenant.trial_ends_at - Date.now()
  const type = remainingMs <= 0
    ? 'trial_expired'
    : remainingMs <= THREE_DAYS_MS
      ? 'trial_expiring'
      : null

  if (!type) return

  const existing = await db.get(`
    SELECT id
    FROM notifications
    WHERE tenant_id = ? AND type = ?
    LIMIT 1
  `, [tenantId, type])
  if (existing) return

  const daysLeft = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)))
  await createNotification(db, {
    tenantId,
    type,
    title: type === 'trial_expired' ? 'Trial has ended' : 'Trial ending soon',
    message: type === 'trial_expired'
      ? 'Your Eudora trial has ended. Choose a plan to restore access.'
      : `Your Eudora trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
    actionUrl: '/subscription',
  })
}
