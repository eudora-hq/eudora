import { adaptDatabase } from '../db/index.ts'

export async function checkTrialExpiry(request, reply, done) {
  if (process.env.SELF_HOSTED === 'true') {
    request.tenant = { plan: 'enterprise', trial_ends_at: null }
    return done()
  }

  const path = request.url.split('?')[0]
  const skipTrialCheck =
    path.startsWith('/auth') ||
    path.startsWith('/billing') ||
    path.startsWith('/notifications') ||
    path === '/account/export' ||
    path.startsWith('/health')

  // Use the Fastify-decorated db so tests can inject an in-memory instance
  const db = adaptDatabase(request.server.db)
  const tenant = await db.get('SELECT plan, trial_ends_at FROM tenants WHERE id = ?', [request.tenantId])

  if (!tenant) {
    reply.code(401).send({ error: 'unauthorized' })
    return done()
  }

  request.tenant = { plan: tenant.plan, trial_ends_at: tenant.trial_ends_at }

  if (skipTrialCheck) return done()

  if (
    tenant.plan === 'trial' &&
    tenant.trial_ends_at !== null &&
    tenant.trial_ends_at < Date.now()
  ) {
    reply.code(402).send({ error: 'trial_expired', upgradeUrl: '/billing' })
    return done()
  }

  done()
}
