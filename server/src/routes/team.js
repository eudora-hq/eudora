import { randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import { TIER_LIMITS } from '../../../shared/constants/tierLimits.js'
import { sendInviteEmail } from '../utils/email.js'

function requireTeamAdmin(request, reply) {
  if (!['owner', 'admin'].includes(request.user?.role)) {
    reply.code(403).send({
      error: 'forbidden',
      message: 'Only team owners and admins can manage members.',
    })
    return false
  }
  return true
}

function serializeSeatLimit(limit) {
  return limit === Infinity ? 'Infinity' : limit
}

export default async function teamRoutes(fastify) {
  const db = fastify.db

  fastify.get('/', async (request) => {
    const members = await db.all(`
      SELECT id, email, name, role, last_login, onboarding_completed
      FROM users
      WHERE tenant_id = ?
      ORDER BY rowid ASC
    `, [request.tenantId])

    const invites = await db.all(`
      SELECT id, email, role, status, expires_at, created_at
      FROM invites
      WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC
    `, [request.tenantId, Date.now()])

    const tenant = await db.get('SELECT plan FROM tenants WHERE id = ?', [request.tenantId])
    const seatLimit = process.env.SELF_HOSTED === 'true'
      ? Infinity
      : TIER_LIMITS[tenant?.plan || 'trial']?.seats ?? 1

    return {
      members,
      invites,
      seatsUsed: members.length + invites.length,
      seatLimit: serializeSeatLimit(seatLimit),
    }
  })

  fastify.post('/invite', async (request, reply) => {
    if (!requireTeamAdmin(request, reply)) return

    const { email, role = 'member' } = request.body || {}
    const normalisedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''

    if (!normalisedEmail) return reply.code(400).send({ error: 'email_required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
      return reply.code(400).send({ error: 'invalid_email' })
    }
    if (!['member', 'admin'].includes(role)) {
      return reply.code(400).send({
        error: 'invalid_role',
        message: 'Role must be member or admin',
      })
    }

    const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [request.tenantId])
    const seatLimit = process.env.SELF_HOSTED === 'true'
      ? Infinity
      : TIER_LIMITS[tenant?.plan || 'trial']?.seats ?? 1

    if (seatLimit !== Infinity) {
      const memberCount = db
        .prepare('SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?')
        .get(request.tenantId).count
      const pendingCount = await db.get(`
        SELECT COUNT(*) AS count
        FROM invites
        WHERE tenant_id = ? AND status = 'pending' AND expires_at > ?
      `, [request.tenantId, Date.now()]).count

      if (memberCount + pendingCount >= seatLimit) {
        return reply.code(403).send({
          error: 'seat_limit_reached',
          message: `Your plan allows ${seatLimit} seat${seatLimit === 1 ? '' : 's'}. Upgrade to add more team members.`,
          upgradeUrl: '/billing',
        })
      }
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(email) = ? AND tenant_id = ?')
      .get(normalisedEmail, request.tenantId)
    if (existing) {
      return reply.code(409).send({
        error: 'already_member',
        message: 'This user is already a member of your team.',
      })
    }

    const existingInvite = await db.get(`
      SELECT id
      FROM invites
      WHERE LOWER(email) = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?
    `, [normalisedEmail, request.tenantId, Date.now()])
    if (existingInvite) {
      return reply.code(409).send({
        error: 'already_invited',
        message: 'An invite has already been sent to this email.',
      })
    }

    const token = randomBytes(32).toString('hex')
    const inviteId = nanoid()
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const createdAt = Date.now()

    await db.query(`
      INSERT INTO invites (
        id, tenant_id, invited_by, email, role, token, status, expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `, [inviteId,
      request.tenantId,
      request.user.userId,
      normalisedEmail,
      role,
      token,
      expiresAt,
      createdAt])

    const inviter = db
      .prepare('SELECT name, email FROM users WHERE id = ?')
      .get(request.user.userId)
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    const inviteUrl = `${clientUrl}/accept-invite?token=${token}`

    await sendInviteEmail({
      to: normalisedEmail,
      inviterName: inviter?.name || inviter?.email || 'A teammate',
      inviteUrl,
      role,
      tenantName: tenant?.name || 'your team',
    }).catch((err) => {
      console.error('[email] Invite email failed:', err.message)
    })

    return reply.code(201).send({
      inviteId,
      email: normalisedEmail,
      role,
      expiresAt,
      inviteUrl,
    })
  })

  fastify.delete('/invite/:id', async (request, reply) => {
    if (!requireTeamAdmin(request, reply)) return

    const invite = db
      .prepare('SELECT * FROM invites WHERE id = ? AND tenant_id = ?')
      .get(request.params.id, request.tenantId)
    if (!invite) return reply.code(404).send({ error: 'not_found' })

    await db.query('UPDATE invites SET status = ? WHERE id = ?', ['cancelled', request.params.id])
    return reply.send({ cancelled: true })
  })

  fastify.delete('/members/:userId', async (request, reply) => {
    if (!requireTeamAdmin(request, reply)) return

    const { userId } = request.params
    if (userId === request.user.userId) {
      return reply.code(400).send({
        error: 'cannot_remove_self',
        message: "You can't remove yourself from the team.",
      })
    }

    const member = db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(userId, request.tenantId)
    if (!member) return reply.code(404).send({ error: 'not_found' })
    if (member.role === 'owner') {
      return reply.code(403).send({
        error: 'cannot_remove_owner',
        message: 'The account owner cannot be removed.',
      })
    }

    db.transaction(() => {
      await db.query('DELETE FROM refresh_tokens WHERE user_id = ?', [userId])
      await db.query('DELETE FROM users WHERE id = ? AND tenant_id = ?', [userId, request.tenantId])
    })()

    return reply.send({ removed: true })
  })

  fastify.patch('/members/:userId/role', async (request, reply) => {
    if (!requireTeamAdmin(request, reply)) return

    const { role } = request.body || {}
    if (!['member', 'admin'].includes(role)) {
      return reply.code(400).send({ error: 'invalid_role' })
    }

    const member = db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(request.params.userId, request.tenantId)
    if (!member) return reply.code(404).send({ error: 'not_found' })
    if (member.role === 'owner') {
      return reply.code(403).send({ error: 'cannot_change_owner_role' })
    }

    await db.query('UPDATE users SET role = ? WHERE id = ? AND tenant_id = ?', [role, request.params.userId, request.tenantId])

    return reply.send({ role })
  })
}
