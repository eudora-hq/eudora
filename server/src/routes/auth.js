import { nanoid } from 'nanoid'
import { randomBytes } from 'crypto'
import { generateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../utils/auth.js'
import authenticate from '../middleware/auth.js'
import { seedFeatureFlags } from '../billing/canAccess.js'
import { createState, validateState } from '../utils/oauthState.js'
import { encrypt } from '../utils/encryption.js'
import { sendPasswordResetEmail, sendWelcomeEmail } from '../utils/email.js'
import { createNotification } from '../utils/notify.js'

const resetTokens = new Map()

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

export default async function authRoutes(fastify) {
  const db = fastify.db

  fastify.post('/auth/register', async (request, reply) => {
    const { name, email, password } = request.body || {}

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'validation_error', details: 'name is required' })
    }
    if (!isValidEmail(email)) {
      return reply.code(400).send({ error: 'validation_error', details: 'valid email is required' })
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'validation_error', details: 'password must be at least 8 characters' })
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) {
      return reply.code(409).send({ error: 'email_already_registered' })
    }

    const tenantId = nanoid()
    db.prepare(
      'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(tenantId, name.trim(), 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())

    const passwordHash = await hashPassword(password)
    const userId = nanoid()
    if (hasColumn(db, 'users', 'name')) {
      db.prepare(
        'INSERT INTO users (id, tenant_id, email, name, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(userId, tenantId, email.toLowerCase(), name.trim(), passwordHash, 'owner', 0)
    } else {
      db.prepare(
        'INSERT INTO users (id, tenant_id, email, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, tenantId, email.toLowerCase(), passwordHash, 'owner', 0)
    }

    seedFeatureFlags(db, tenantId, 'trial')
    sendWelcomeEmail({ to: email, name }).catch((err) => {
      console.error('[email] Welcome email failed:', err.message)
    })

    return reply.code(201).send({ tenantId, userId, email })
  })

  fastify.post('/auth/login', async (request, reply) => {
    const { email, password, mfaCode } = request.body || {}

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (!user) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    const valid = await verifyPassword(password || '', user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    if (user.mfa_secret && !user.mfa_secret.startsWith('pending:')) {
      if (!mfaCode) {
        return reply.code(200).send({ mfaRequired: true, email: user.email })
      }

      let verification
      try {
        verification = await verify({
          token: String(mfaCode).replace(/\s/g, ''),
          secret: user.mfa_secret,
        })
      } catch {
        verification = { valid: false }
      }
      if (!verification.valid) {
        return reply.code(401).send({ error: 'invalid_mfa_code' })
      }
    }

    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id)
    const tenant = db.prepare('SELECT plan, trial_ends_at FROM tenants WHERE id = ?').get(user.tenant_id)

    const accessToken = generateAccessToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    })
    const { raw, hashed } = generateRefreshToken()
    db.prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), user.id, hashed, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now())

    return reply.code(200).send({
      accessToken,
      refreshToken: raw,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || null,
        role: user.role,
        plan: tenant?.plan || 'trial',
        trial_ends_at: tenant?.trial_ends_at ?? null,
      },
      onboardingCompleted: user.onboarding_completed === 1,
    })
  })

  fastify.get('/auth/mfa/status', { preHandler: authenticate }, async (request, reply) => {
    const user = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(request.user.userId)
    if (!user) return reply.code(404).send({ error: 'user_not_found' })

    return reply.send({
      enabled: Boolean(user.mfa_secret && !user.mfa_secret.startsWith('pending:')),
      pending: Boolean(user.mfa_secret?.startsWith('pending:')),
    })
  })

  fastify.post('/auth/mfa/setup', { preHandler: authenticate }, async (request, reply) => {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(request.user.userId)
    if (!user) return reply.code(404).send({ error: 'user_not_found' })

    const secret = generateSecret()
    const otpauth = generateURI({
      issuer: 'Eudora',
      label: user.email,
      secret,
    })
    const qrDataUrl = await QRCode.toDataURL(otpauth)

    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?')
      .run(`pending:${secret}`, request.user.userId)

    return reply.send({ secret, qrDataUrl, otpauth })
  })

  fastify.post('/auth/mfa/verify', { preHandler: authenticate }, async (request, reply) => {
    const { code } = request.body || {}
    const user = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(request.user.userId)

    if (!user?.mfa_secret?.startsWith('pending:')) {
      return reply.code(400).send({ error: 'no_pending_setup' })
    }
    if (!code) {
      return reply.code(400).send({
        error: 'invalid_code',
        message: 'Enter the 6-digit verification code.',
      })
    }

    const secret = user.mfa_secret.slice('pending:'.length)
    let verification
    try {
      verification = await verify({
        token: String(code).replace(/\s/g, ''),
        secret,
      })
    } catch {
      verification = { valid: false }
    }
    if (!verification.valid) {
      return reply.code(400).send({
        error: 'invalid_code',
        message: 'Invalid verification code. Please try again.',
      })
    }

    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?')
      .run(secret, request.user.userId)
    return reply.send({ enabled: true })
  })

  fastify.post('/auth/mfa/disable', { preHandler: authenticate }, async (request, reply) => {
    const { code } = request.body || {}
    const user = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get(request.user.userId)

    if (!user?.mfa_secret || user.mfa_secret.startsWith('pending:')) {
      return reply.code(400).send({ error: 'mfa_not_enabled' })
    }
    if (!code) return reply.code(400).send({ error: 'invalid_code' })

    let verification
    try {
      verification = await verify({
        token: String(code).replace(/\s/g, ''),
        secret: user.mfa_secret,
      })
    } catch {
      verification = { valid: false }
    }
    if (!verification.valid) {
      return reply.code(400).send({ error: 'invalid_code' })
    }

    db.prepare('UPDATE users SET mfa_secret = NULL WHERE id = ?').run(request.user.userId)
    return reply.send({ disabled: true })
  })

  fastify.post('/auth/forgot-password', async (request, reply) => {
    const { email } = request.body || {}
    if (!email) {
      return reply.code(400).send({ error: 'email_required' })
    }

    const normalisedEmail = String(email).trim().toLowerCase()
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(normalisedEmail)
    const message = 'If that email exists, a reset link has been sent.'

    if (!user) {
      return reply.send({ message })
    }

    const token = randomBytes(32).toString('hex')
    resetTokens.set(token, {
      userId: user.id,
      email: user.email,
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    const resetUrl = `${clientUrl}/reset-password?token=${token}`
    await sendPasswordResetEmail({
      to: user.email,
      resetUrl,
      name: user.name || null,
    })

    return reply.send({ message })
  })

  fastify.post('/auth/reset-password', async (request, reply) => {
    const { token, password } = request.body || {}

    if (!token || !password) {
      return reply.code(400).send({ error: 'token_and_password_required' })
    }

    if (password.length < 8) {
      return reply.code(400).send({
        error: 'password_too_short',
        message: 'Password must be at least 8 characters',
      })
    }

    const record = resetTokens.get(token)
    if (!record) {
      return reply.code(400).send({
        error: 'invalid_token',
        message: 'Invalid or expired reset token',
      })
    }

    if (Date.now() > record.expiresAt) {
      resetTokens.delete(token)
      return reply.code(400).send({
        error: 'token_expired',
        message: 'Reset token has expired. Please request a new one.',
      })
    }

    const passwordHash = await hashPassword(password)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, record.userId)
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(record.userId)
    resetTokens.delete(token)

    return reply.send({ message: 'Password updated successfully.' })
  })

  fastify.get('/auth/invite/:token', async (request, reply) => {
    const invite = db.prepare(`
      SELECT i.*, t.name AS tenant_name
      FROM invites i
      JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token = ? AND i.status = 'pending' AND i.expires_at > ?
    `).get(request.params.token, Date.now())

    if (!invite) {
      return reply.code(404).send({
        error: 'invalid_invite',
        message: 'This invite link is invalid or has expired.',
      })
    }

    return reply.send({
      email: invite.email,
      role: invite.role,
      tenantName: invite.tenant_name,
      expiresAt: invite.expires_at,
    })
  })

  fastify.post('/auth/accept-invite', async (request, reply) => {
    const { token, name, password } = request.body || {}

    if (!token || !name || !password) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'password_too_short' })
    }

    const invite = db.prepare(`
      SELECT *
      FROM invites
      WHERE token = ? AND status = 'pending' AND expires_at > ?
    `).get(token, Date.now())

    if (!invite) {
      return reply.code(404).send({
        error: 'invalid_invite',
        message: 'This invite link is invalid or has expired.',
      })
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
      .get(invite.email)
    if (existing) {
      return reply.code(409).send({
        error: 'email_taken',
        message: 'This email is already registered. Try logging in.',
      })
    }

    const passwordHash = await hashPassword(password)
    const userId = nanoid()
    const now = Date.now()
    const { raw, hashed } = generateRefreshToken()

    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (
          id, tenant_id, email, name, password_hash, role, onboarding_completed
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        userId,
        invite.tenant_id,
        invite.email,
        name.trim(),
        passwordHash,
        invite.role
      )

      db.prepare('UPDATE invites SET status = ?, accepted_at = ? WHERE id = ?')
        .run('accepted', now, invite.id)

      db.prepare(`
        INSERT INTO refresh_tokens (
          id, user_id, token_hash, expires_at, created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(nanoid(), userId, hashed, now + 30 * 24 * 60 * 60 * 1000, now)
    })()

    const tenant = db
      .prepare('SELECT plan, trial_ends_at FROM tenants WHERE id = ?')
      .get(invite.tenant_id)
    const accessToken = generateAccessToken({
      userId,
      tenantId: invite.tenant_id,
      role: invite.role,
    })
    const owner = db.prepare(`
      SELECT id
      FROM users
      WHERE tenant_id = ? AND role = 'owner'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(invite.tenant_id)
    createNotification(db, {
      tenantId: invite.tenant_id,
      userId: owner?.id || null,
      type: 'invite_accepted',
      title: 'Team member joined',
      message: `${name.trim()} (${invite.email}) accepted your invitation and joined as ${invite.role}.`,
      actionUrl: '/team',
    })

    return reply.code(201).send({
      accessToken,
      refreshToken: raw,
      user: {
        id: userId,
        email: invite.email,
        name: name.trim(),
        role: invite.role,
        plan: tenant?.plan || 'trial',
        trial_ends_at: tenant?.trial_ends_at ?? null,
        onboardingCompleted: true,
      },
      onboardingCompleted: true,
    })
  })

  fastify.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body || {}

    if (!refreshToken) {
      return reply.code(401).send({ error: 'invalid_refresh_token' })
    }

    const hashed = hashRefreshToken(refreshToken)
    const stored = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashed)

    if (!stored) {
      return reply.code(401).send({ error: 'invalid_refresh_token' })
    }

    if (stored.expires_at <= Date.now()) {
      return reply.code(401).send({ error: 'refresh_token_expired' })
    }

    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id)

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id)
    const accessToken = generateAccessToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    })
    const { raw: newRaw, hashed: newHashed } = generateRefreshToken()
    db.prepare(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), user.id, newHashed, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now())

    return reply.code(200).send({ accessToken, refreshToken: newRaw })
  })

  fastify.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (refreshToken) {
      db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hashRefreshToken(refreshToken))
    }
    return reply.code(200).send({ success: true })
  })

  fastify.patch('/users/me', { preHandler: authenticate }, async (request, reply) => {
    const { onboarding_completed, name } = request.body || {}
    const { userId } = request.user

    if (onboarding_completed !== undefined) {
      db.prepare('UPDATE users SET onboarding_completed = ? WHERE id = ?').run(
        onboarding_completed ? 1 : 0,
        userId
      )
    }
    if (typeof name === 'string' && name.trim()) {
      db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name.trim(), request.tenantId)
      if (hasColumn(db, 'users', 'name')) {
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), userId)
      }
    }

    return reply.code(200).send({ success: true })
  })

  // GET /auth/oauth/openai — initiate OAuth flow (requires auth via global middleware)
  fastify.get('/auth/oauth/openai', async (request, reply) => {
    const clientId = process.env.OPENAI_OAUTH_CLIENT_ID
    if (!clientId) {
      return reply.code(503).send({ error: 'oauth_not_configured' })
    }

    const randomState = createState()
    const fullState = `${request.tenantId}:${randomState}`

    const url = new URL('https://auth.openai.com/authorize')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', process.env.OPENAI_OAUTH_REDIRECT_URI || '')
    url.searchParams.set('scope', 'openai.model.request')
    url.searchParams.set('state', fullState)

    return reply.redirect(url.toString())
  })

  // GET /auth/oauth/callback/openai — handle OAuth redirect from OpenAI (public route)
  fastify.get('/auth/oauth/callback/openai', async (request, reply) => {
    const { code, state: fullState, error: oauthError } = request.query
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'

    if (oauthError) {
      return reply.redirect(`${clientUrl}/settings/api-keys?error=oauth_denied`)
    }

    // Recover tenantId from encoded state: "{tenantId}:{randomState}"
    const colonIdx = fullState ? fullState.indexOf(':') : -1
    if (colonIdx === -1) {
      return reply.code(400).send({ error: 'invalid_oauth_state' })
    }
    const tenantId = fullState.slice(0, colonIdx)
    const randomState = fullState.slice(colonIdx + 1)

    if (!validateState(randomState)) {
      return reply.code(400).send({ error: 'invalid_oauth_state' })
    }

    // Exchange code for tokens
    let tokenData
    try {
      const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.OPENAI_OAUTH_REDIRECT_URI,
          client_id: process.env.OPENAI_OAUTH_CLIENT_ID,
          client_secret: process.env.OPENAI_OAUTH_CLIENT_SECRET,
        }),
      })
      if (!tokenRes.ok) throw new Error('Token exchange failed')
      tokenData = await tokenRes.json()
    } catch {
      return reply.redirect(`${clientUrl}/settings/api-keys?error=oauth_failed`)
    }

    const { access_token, refresh_token, expires_in, scope } = tokenData
    const { ciphertext: accessCt, iv: accessIv } = encrypt(access_token)
    const { ciphertext: refreshCt, iv: refreshIv } = encrypt(refresh_token)
    const oauthExpiresAt = Date.now() + expires_in * 1000

    const owner = db
      .prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1")
      .get(tenantId)
    const userId = owner?.id ?? null

    const existing = db
      .prepare("SELECT id FROM api_keys WHERE tenant_id = ? AND provider = 'openai_oauth' LIMIT 1")
      .get(tenantId)

    if (existing) {
      db.prepare(`
        UPDATE api_keys
           SET oauth_access_token_encrypted = ?,
               oauth_access_token_iv = ?,
               oauth_refresh_token_encrypted = ?,
               oauth_refresh_token_iv = ?,
               oauth_expires_at = ?,
               oauth_scope = ?
         WHERE id = ?
      `).run(accessCt, accessIv, refreshCt, refreshIv, oauthExpiresAt, scope ?? null, existing.id)
    } else {
      db.prepare(`
        INSERT INTO api_keys
          (id, tenant_id, user_id, provider, auth_type, label,
           oauth_access_token_encrypted, oauth_access_token_iv,
           oauth_refresh_token_encrypted, oauth_refresh_token_iv,
           oauth_expires_at, oauth_scope, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(), tenantId, userId,
        'openai_oauth', 'oauth', 'ChatGPT Subscription',
        accessCt, accessIv, refreshCt, refreshIv,
        oauthExpiresAt, scope ?? null,
        Date.now()
      )
    }

    return reply.redirect(`${clientUrl}/settings/api-keys?connected=openai`)
  })
}
