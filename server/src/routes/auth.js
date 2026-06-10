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

async function hasColumn(db, table, column) {
  const columns = await db.all(`PRAGMA table_info(${table})`)
  return columns.some((item) => item.name === column)
}

function oauthCallbackUrl(provider) {
  const apiUrl = process.env.API_URL || 'http://localhost:3001'
  return `${apiUrl.replace(/\/$/, '')}/auth/callback/${provider}`
}

function oauthFrontendRedirect(result) {
  const clientUrl = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '')
  const params = new URLSearchParams({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    userId: result.user.id,
    email: result.user.email,
    name: result.user.name || '',
    role: result.user.role,
    plan: result.tenant?.plan || 'trial',
    trialEndsAt: String(result.tenant?.trial_ends_at ?? ''),
    onboardingCompleted: String(result.user.onboarding_completed === 1),
  })
  return `${clientUrl}/auth/callback?${params}`
}

async function findOrCreateOAuthUser({ email, name, provider, providerId, db }) {
  if (!isValidEmail(email)) throw new Error('OAuth provider did not return a valid email')

  const normalisedEmail = email.trim().toLowerCase()
  let user = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', [normalisedEmail])

  if (!user) {
    const userId = nanoid()
    const tenantId = nanoid()
    const now = Date.now()
    const displayName = name?.trim() || normalisedEmail.split('@')[0]

    db.transaction(() => {
      await db.query(`
        INSERT INTO tenants (id, name, plan, trial_ends_at, created_at)
        VALUES (?, ?, 'trial', ?, ?)
      `, [tenantId,
        `${displayName}'s workspace`,
        now + 14 * 24 * 60 * 60 * 1000,
        now])

      if (hasColumn(db, 'users', 'name')) {
        await db.query(`
          INSERT INTO users (
            id, tenant_id, email, name, password_hash, role, onboarding_completed
          )
          VALUES (?, ?, ?, ?, '', 'owner', 0)
        `, [userId, tenantId, normalisedEmail, displayName])
      } else {
        await db.query(`
          INSERT INTO users (
            id, tenant_id, email, password_hash, role, onboarding_completed
          )
          VALUES (?, ?, ?, '', 'owner', 0)
        `, [userId, tenantId, normalisedEmail])
      }
    })()

    seedFeatureFlags(db, tenantId, 'trial')
    sendWelcomeEmail({ to: normalisedEmail, name: displayName }).catch((error) => {
      console.error('[email] Welcome email failed:', error.message)
    })
    user = await db.get('SELECT * FROM users WHERE id = ?', [userId])
  }

  const tenant = await db.get('SELECT * FROM tenants WHERE id = ?', [user.tenant_id])
  const accessToken = generateAccessToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
  })
  const { raw, hashed } = generateRefreshToken()
  const now = Date.now()
  await db.query(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `, [nanoid(), user.id, hashed, now + 30 * 24 * 60 * 60 * 1000, now])

  await db.query('UPDATE users SET last_login = ? WHERE id = ?', [now, user.id])

  // Provider identifiers are intentionally not persisted until a dedicated
  // linked-identities table is introduced.
  void provider
  void providerId

  return { accessToken, refreshToken: raw, user, tenant }
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

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email])
    if (existing) {
      return reply.code(409).send({ error: 'email_already_registered' })
    }

    const tenantId = nanoid()
    await db.query(
      'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
    , [tenantId, name.trim(), 'trial', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now()])

    const passwordHash = await hashPassword(password)
    const userId = nanoid()
    if (hasColumn(db, 'users', 'name')) {
      await db.query(
        'INSERT INTO users (id, tenant_id, email, name, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?, ?)'
      , [userId, tenantId, email.toLowerCase(), name.trim(), passwordHash, 'owner', 0])
    } else {
      await db.query(
        'INSERT INTO users (id, tenant_id, email, password_hash, role, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?)'
      , [userId, tenantId, email.toLowerCase(), passwordHash, 'owner', 0])
    }

    seedFeatureFlags(db, tenantId, 'trial')
    sendWelcomeEmail({ to: email, name }).catch((err) => {
      console.error('[email] Welcome email failed:', err.message)
    })

    return reply.code(201).send({ tenantId, userId, email })
  })

  fastify.post('/auth/login', async (request, reply) => {
    const { email, password, mfaCode } = request.body || {}

    const user = await db.get('SELECT * FROM users WHERE email = ?', [email])
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

    await db.query('UPDATE users SET last_login = ? WHERE id = ?', [Date.now(), user.id])
    const tenant = await db.get('SELECT plan, trial_ends_at FROM tenants WHERE id = ?', [user.tenant_id])

    const accessToken = generateAccessToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    })
    const { raw, hashed } = generateRefreshToken()
    await db.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    , [nanoid(), user.id, hashed, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()])

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
    const user = await db.get('SELECT mfa_secret FROM users WHERE id = ?', [request.user.userId])
    if (!user) return reply.code(404).send({ error: 'user_not_found' })

    return reply.send({
      enabled: Boolean(user.mfa_secret && !user.mfa_secret.startsWith('pending:')),
      pending: Boolean(user.mfa_secret?.startsWith('pending:')),
    })
  })

  fastify.post('/auth/mfa/setup', { preHandler: authenticate }, async (request, reply) => {
    const user = await db.get('SELECT id, email FROM users WHERE id = ?', [request.user.userId])
    if (!user) return reply.code(404).send({ error: 'user_not_found' })

    const secret = generateSecret()
    const otpauth = generateURI({
      issuer: 'Eudora',
      label: user.email,
      secret,
    })
    const qrDataUrl = await QRCode.toDataURL(otpauth)

    await db.query('UPDATE users SET mfa_secret = ? WHERE id = ?', [`pending:${secret}`, request.user.userId])

    return reply.send({ secret, qrDataUrl, otpauth })
  })

  fastify.post('/auth/mfa/verify', { preHandler: authenticate }, async (request, reply) => {
    const { code } = request.body || {}
    const user = await db.get('SELECT mfa_secret FROM users WHERE id = ?', [request.user.userId])

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

    await db.query('UPDATE users SET mfa_secret = ? WHERE id = ?', [secret, request.user.userId])
    return reply.send({ enabled: true })
  })

  fastify.post('/auth/mfa/disable', { preHandler: authenticate }, async (request, reply) => {
    const { code } = request.body || {}
    const user = await db.get('SELECT mfa_secret FROM users WHERE id = ?', [request.user.userId])

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

    await db.query('UPDATE users SET mfa_secret = NULL WHERE id = ?', [request.user.userId])
    return reply.send({ disabled: true })
  })

  fastify.post('/auth/forgot-password', async (request, reply) => {
    const { email } = request.body || {}
    if (!email) {
      return reply.code(400).send({ error: 'email_required' })
    }

    const normalisedEmail = String(email).trim().toLowerCase()
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', [normalisedEmail])
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
    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, record.userId])
    await db.query('DELETE FROM refresh_tokens WHERE user_id = ?', [record.userId])
    resetTokens.delete(token)

    return reply.send({ message: 'Password updated successfully.' })
  })

  fastify.get('/auth/invite/:token', async (request, reply) => {
    const invite = await db.get(`
      SELECT i.*, t.name AS tenant_name
      FROM invites i
      JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token = ? AND i.status = 'pending' AND i.expires_at > ?
    `, [request.params.token, Date.now()])

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

    const invite = await db.get(`
      SELECT *
      FROM invites
      WHERE token = ? AND status = 'pending' AND expires_at > ?
    `, [token, Date.now()])

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
      await db.query(`
        INSERT INTO users (
          id, tenant_id, email, name, password_hash, role, onboarding_completed
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, [userId,
        invite.tenant_id,
        invite.email,
        name.trim(),
        passwordHash,
        invite.role])

      await db.query('UPDATE invites SET status = ?, accepted_at = ? WHERE id = ?', ['accepted', now, invite.id])

      await db.query(`
        INSERT INTO refresh_tokens (
          id, user_id, token_hash, expires_at, created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `, [nanoid(), userId, hashed, now + 30 * 24 * 60 * 60 * 1000, now])
    })()

    const tenant = db
      .prepare('SELECT plan, trial_ends_at FROM tenants WHERE id = ?')
      .get(invite.tenant_id)
    const accessToken = generateAccessToken({
      userId,
      tenantId: invite.tenant_id,
      role: invite.role,
    })
    const owner = await db.get(`
      SELECT id
      FROM users
      WHERE tenant_id = ? AND role = 'owner'
      ORDER BY rowid ASC
      LIMIT 1
    `, [invite.tenant_id])
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
    const stored = await db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [hashed])

    if (!stored) {
      return reply.code(401).send({ error: 'invalid_refresh_token' })
    }

    if (stored.expires_at <= Date.now()) {
      return reply.code(401).send({ error: 'refresh_token_expired' })
    }

    await db.query('DELETE FROM refresh_tokens WHERE id = ?', [stored.id])

    const user = await db.get('SELECT * FROM users WHERE id = ?', [stored.user_id])
    const accessToken = generateAccessToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    })
    const { raw: newRaw, hashed: newHashed } = generateRefreshToken()
    await db.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    , [nanoid(), user.id, newHashed, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now()])

    return reply.code(200).send({ accessToken, refreshToken: newRaw })
  })

  fastify.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = request.body || {}
    if (refreshToken) {
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = ?', [hashRefreshToken(refreshToken)])
    }
    return reply.code(200).send({ success: true })
  })

  fastify.get('/auth/oauth/google', async (request, reply) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return reply.code(503).send({ error: 'google_oauth_not_configured' })
    }

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: oauthCallbackUrl('google'),
      response_type: 'code',
      scope: 'openid email profile',
      state: createState(),
      access_type: 'online',
      prompt: 'select_account',
    })
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })

  fastify.get('/auth/callback/google', async (request, reply) => {
    const { code, error, state } = request.query
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    if (error) return reply.redirect(`${clientUrl}/login?error=oauth_cancelled`)
    if (!code || !validateState(state)) {
      return reply.redirect(`${clientUrl}/login?error=oauth_invalid_state`)
    }

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: oauthCallbackUrl('google'),
          grant_type: 'authorization_code',
        }),
      })
      if (!tokenResponse.ok) throw new Error(`Google token exchange failed: ${tokenResponse.status}`)
      const tokenData = await tokenResponse.json()
      if (!tokenData.access_token) throw new Error('Google access token missing')

      const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      if (!userResponse.ok) throw new Error(`Google user lookup failed: ${userResponse.status}`)
      const googleUser = await userResponse.json()
      if (googleUser.verified_email === false) throw new Error('Google email is not verified')

      const result = await findOrCreateOAuthUser({
        email: googleUser.email,
        name: googleUser.name,
        provider: 'google',
        providerId: googleUser.id,
        db,
      })
      return reply.redirect(oauthFrontendRedirect(result))
    } catch (oauthError) {
      console.error('[oauth] Google login failed:', oauthError.message)
      return reply.redirect(`${clientUrl}/login?error=oauth_failed`)
    }
  })

  fastify.get('/auth/oauth/github', async (request, reply) => {
    if (!process.env.GITHUB_CLIENT_ID) {
      return reply.code(503).send({ error: 'github_oauth_not_configured' })
    }

    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: oauthCallbackUrl('github'),
      scope: 'user:email',
      state: createState(),
    })
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`)
  })

  fastify.get('/auth/callback/github', async (request, reply) => {
    const { code, error, state } = request.query
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    if (error) return reply.redirect(`${clientUrl}/login?error=oauth_cancelled`)
    if (!code || !validateState(state)) {
      return reply.redirect(`${clientUrl}/login?error=oauth_invalid_state`)
    }

    try {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: oauthCallbackUrl('github'),
        }),
      })
      if (!tokenResponse.ok) throw new Error(`GitHub token exchange failed: ${tokenResponse.status}`)
      const tokenData = await tokenResponse.json()
      if (!tokenData.access_token) throw new Error(tokenData.error_description || 'GitHub access token missing')

      const githubHeaders = {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Eudora',
      }
      const userResponse = await fetch('https://api.github.com/user', {
        headers: githubHeaders,
      })
      if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status}`)
      const githubUser = await userResponse.json()

      let email = githubUser.email
      if (!email) {
        const emailResponse = await fetch('https://api.github.com/user/emails', {
          headers: githubHeaders,
        })
        if (!emailResponse.ok) throw new Error(`GitHub email lookup failed: ${emailResponse.status}`)
        const emails = await emailResponse.json()
        email = emails.find(item => item.primary && item.verified)?.email
          || emails.find(item => item.verified)?.email
      }

      const result = await findOrCreateOAuthUser({
        email,
        name: githubUser.name || githubUser.login,
        provider: 'github',
        providerId: String(githubUser.id),
        db,
      })
      return reply.redirect(oauthFrontendRedirect(result))
    } catch (oauthError) {
      console.error('[oauth] GitHub login failed:', oauthError.message)
      return reply.redirect(`${clientUrl}/login?error=oauth_failed`)
    }
  })

  fastify.patch('/users/me', { preHandler: authenticate }, async (request, reply) => {
    const { onboarding_completed, name } = request.body || {}
    const { userId } = request.user

    if (onboarding_completed !== undefined) {
      await db.query('UPDATE users SET onboarding_completed = ? WHERE id = ?', [onboarding_completed ? 1 : 0,
        userId])
    }
    if (typeof name === 'string' && name.trim()) {
      await db.query('UPDATE tenants SET name = ? WHERE id = ?', [name.trim(), request.tenantId])
      if (hasColumn(db, 'users', 'name')) {
        await db.query('UPDATE users SET name = ? WHERE id = ?', [name.trim(), userId])
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
      await db.query(`
        UPDATE api_keys
           SET oauth_access_token_encrypted = ?,
               oauth_access_token_iv = ?,
               oauth_refresh_token_encrypted = ?,
               oauth_refresh_token_iv = ?,
               oauth_expires_at = ?,
               oauth_scope = ?
         WHERE id = ?
      `, [accessCt, accessIv, refreshCt, refreshIv, oauthExpiresAt, scope ?? null, existing.id])
    } else {
      await db.query(`
        INSERT INTO api_keys
          (id, tenant_id, user_id, provider, auth_type, label,
           oauth_access_token_encrypted, oauth_access_token_iv,
           oauth_refresh_token_encrypted, oauth_refresh_token_iv,
           oauth_expires_at, oauth_scope, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [nanoid(), tenantId, userId,
        'openai_oauth', 'oauth', 'ChatGPT Subscription',
        accessCt, accessIv, refreshCt, refreshIv,
        oauthExpiresAt, scope ?? null,
        Date.now()])
    }

    return reply.redirect(`${clientUrl}/settings/api-keys?connected=openai`)
  })
}
