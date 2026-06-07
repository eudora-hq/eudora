import { nanoid } from 'nanoid'

export function createNotification(db, {
  tenantId,
  userId = null,
  type,
  title,
  message,
  actionUrl = null,
}) {
  try {
    db.prepare(`
      INSERT INTO notifications (
        id, tenant_id, user_id, type, title, message, action_url, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(),
      tenantId,
      userId,
      type,
      title,
      message,
      actionUrl,
      Date.now()
    )
  } catch (err) {
    // Isolated tests may use an older partial schema without notifications.
    if (err.message?.includes('no such table: notifications')) return
    console.error('[notify] Failed to create notification:', err.message)
  }
}
