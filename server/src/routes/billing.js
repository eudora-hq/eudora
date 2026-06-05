import Stripe from 'stripe'
import { TIER_LIMITS } from '../../../shared/constants/tierLimits.js'
import { normalizePlan, seedFeatureFlags } from '../billing/canAccess.js'

function getStripeClient() {
  return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
}

const VALID_PLANS = new Set(['starter', 'professional', 'enterprise'])

function getPriceIds() {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    professional: process.env.STRIPE_PRICE_PROFESSIONAL,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
  }
}

function serializeLimit(limit) {
  return limit === Infinity ? 'Infinity' : limit
}

export default async function billingRoutes(fastify) {
  const db = fastify.db

  fastify.get('/', async () => [])

  fastify.post('/checkout', async (request, reply) => {
    const { plan } = request.body || {}
    const checkoutPlan = normalizePlan(plan)
    if (!VALID_PLANS.has(plan) || !getPriceIds()[checkoutPlan]) {
      return reply.code(400).send({ error: 'invalid_plan' })
    }

    const stripeClient = getStripeClient()
    if (!stripeClient) return reply.code(503).send({ error: 'stripe_not_configured' })

    try {
      const tenant = db
        .prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?')
        .get(request.tenantId)

      const sessionParams = {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: getPriceIds()[checkoutPlan], quantity: 1 }],
        success_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/billing`,
        metadata: { tenantId: request.tenantId, plan: checkoutPlan },
      }
      if (tenant?.stripe_customer_id) {
        sessionParams.customer = tenant.stripe_customer_id
      }

      const session = await stripeClient.checkout.sessions.create(sessionParams)
      return reply.send({ checkoutUrl: session.url })
    } catch (err) {
      return reply.code(500).send({
        error: 'stripe_error',
        message: err.message,
      })
    }
  })

  fastify.post('/portal', async (request, reply) => {
    const stripeClient = getStripeClient()
    if (!stripeClient) return reply.code(503).send({ error: 'stripe_not_configured' })

    const tenant = db
      .prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?')
      .get(request.tenantId)

    if (!tenant?.stripe_customer_id) {
      return reply.code(400).send({
        error: 'no_subscription',
        message: 'No active subscription found',
      })
    }

    try {
      const session = await stripeClient.billingPortal.sessions.create({
        customer: tenant.stripe_customer_id,
        return_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/settings`,
      })
      return reply.send({ portalUrl: session.url })
    } catch (err) {
      return reply.code(500).send({
        error: 'stripe_error',
        message: err.message,
      })
    }
  })

  fastify.post('/webhook', async (request, reply) => {
    const stripeClient = getStripeClient()
    if (!stripeClient) return reply.code(503).send({ error: 'stripe_not_configured' })

    const sig = request.headers['stripe-signature']
    let event

    try {
      event = stripeClient.webhooks.constructEvent(
        request.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      return reply.code(400).send({ error: `Webhook signature verification failed: ${err.message}` })
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          const { tenantId, plan } = session.metadata || {}
          const customerId = session.customer

          if (!tenantId || !plan) break
          const newPlan = normalizePlan(plan)

          db.prepare(`
            UPDATE tenants SET
              plan = ?,
              trial_ends_at = NULL,
              stripe_customer_id = ?
            WHERE id = ?
          `).run(newPlan, customerId, tenantId)

          await seedFeatureFlags(db, tenantId, newPlan)
          break
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object
          const customerId = subscription.customer
          const tenant = db
            .prepare('SELECT id FROM tenants WHERE stripe_customer_id = ?')
            .get(customerId)
          if (!tenant) break

          const priceId = subscription.items?.data?.[0]?.price?.id
          const priceIds = getPriceIds()
          const planMap = {
            [priceIds.starter]: 'starter',
            [priceIds.professional]: 'professional',
            [priceIds.enterprise]: 'enterprise',
          }
          const newPlan = planMap[priceId]
          if (!newPlan) break

          db.prepare('UPDATE tenants SET plan = ?, trial_ends_at = NULL WHERE id = ?')
            .run(newPlan, tenant.id)
          await seedFeatureFlags(db, tenant.id, newPlan)
          break
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object
          const customerId = subscription.customer
          const tenant = db
            .prepare('SELECT id FROM tenants WHERE stripe_customer_id = ?')
            .get(customerId)
          if (!tenant) break

          const expiredAt = Date.now() - 1
          db.prepare('UPDATE tenants SET plan = ?, trial_ends_at = ? WHERE id = ?')
            .run('trial', expiredAt, tenant.id)
          await seedFeatureFlags(db, tenant.id, 'trial')
          break
        }
      }
    } catch (err) {
      console.error('[webhook] Handler error:', err.message)
    }

    return reply.send({ received: true })
  })

  fastify.get('/usage', async (request, reply) => {
    const tenantId = request.tenantId
    const plan = normalizePlan(request.tenant?.plan || 'trial')
    const limits = process.env.SELF_HOSTED === 'true'
      ? {
          agents: Infinity,
          messages_per_day: Infinity,
          cron_jobs: Infinity,
          context_files: Infinity,
          workflows: Infinity,
        }
      : TIER_LIMITS[plan] || TIER_LIMITS.trial
    const since = Date.now() - 24 * 60 * 60 * 1000

    const agents = db.prepare('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ?').get(tenantId).count
    const messagesToday = db
      .prepare("SELECT COALESCE(SUM(value), 0) AS total FROM usage_events WHERE tenant_id = ? AND event_type = 'message' AND ts > ?")
      .get(tenantId, since).total
    const cronJobs = db.prepare('SELECT COUNT(*) AS count FROM cron_jobs WHERE tenant_id = ?').get(tenantId).count
    const contextFiles = db.prepare('SELECT COUNT(*) AS count FROM context_files WHERE tenant_id = ?').get(tenantId).count
    const workflows = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE tenant_id = ?').get(tenantId).count

    return reply.send({
      plan: process.env.SELF_HOSTED === 'true' ? 'enterprise' : plan,
      trial_ends_at: process.env.SELF_HOSTED === 'true' ? null : request.tenant?.trial_ends_at || null,
      metrics: {
        agents: { used: agents, limit: serializeLimit(limits.agents) },
        messages_today: { used: messagesToday, limit: serializeLimit(limits.messages_per_day) },
        cron_jobs: { used: cronJobs, limit: serializeLimit(limits.cron_jobs) },
        context_files: { used: contextFiles, limit: serializeLimit(limits.context_files) },
        workflows: { used: workflows, limit: serializeLimit(limits.workflows) },
      },
    })
  })
}
