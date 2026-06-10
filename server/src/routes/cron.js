import { adaptDatabase } from '../db/index.js'
import { nanoid } from 'nanoid'
import cronParser from 'cron-parser'
import { isUnderLimit } from '../billing/canAccess.js'

async function registerCronJob(job) {
  try {
    const { registerJob } = await import('../scheduler/cronRunner.js')
    registerJob(job)
  } catch {
    // Scheduler is introduced in Task 5.2. CRUD should work before it exists.
  }
}

async function deregisterCronJob(id) {
  try {
    const { deregisterJob } = await import('../scheduler/cronRunner.js')
    deregisterJob(id)
  } catch {
    // Scheduler is introduced in Task 5.2. CRUD should work before it exists.
  }
}

function validateSchedule(schedule, reply) {
  try {
    return cronParser.parseExpression(schedule)
  } catch (err) {
    reply.code(400).send({
      error: 'invalid_cron_expression',
      message: `Invalid schedule: "${schedule}" — ${err.message}`,
    })
    return null
  }
}

async function findJobForTenant(db, id, tenantId, reply) {
  const job = await db.get('SELECT * FROM cron_jobs WHERE id = ?', [id])
  if (!job) {
    reply.code(404).send({ error: 'cron_job_not_found' })
    return null
  }
  if (job.tenant_id !== tenantId) {
    reply.code(403).send({ error: 'forbidden' })
    return null
  }
  return job
}

function truncateOutput(output) {
  if (!output) return null
  return output.slice(0, 200) + (output.length > 200 ? '...' : '')
}

function parseContextInjected(value) {
  try {
    return JSON.parse(value || '[]')
  } catch {
    return []
  }
}

export default async function cronRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

  fastify.post('/', async (request, reply) => {
    const { agentId, name, prompt, schedule, preset } = request.body || {}
    if (!agentId || !name || !prompt || !schedule) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'agentId, name, prompt and schedule are required',
      })
    }

    const interval = validateSchedule(schedule, reply)
    if (!interval) return reply

    if (!await isUnderLimit(db, request.tenantId, request.tenant.plan, 'cron_jobs')) {
      return reply.code(403).send({
        error: 'limit_reached',
        message: 'Upgrade to add more scheduled jobs',
        upgradeUrl: '/billing',
      })
    }

    const agent = await db.get('SELECT id FROM agents WHERE id = ? AND tenant_id = ?', [agentId, request.tenantId])
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })

    const id = nanoid()
    const createdAt = Date.now()
    const nextRunAt = interval.next().getTime()

    await db.query(
      `INSERT INTO cron_jobs
        (id, tenant_id, agent_id, name, prompt, schedule, preset, enabled, created_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    , [id,
      request.tenantId,
      agentId,
      name,
      prompt,
      schedule,
      preset || null,
      1,
      createdAt,
      nextRunAt])

    const newJob = await db.get('SELECT * FROM cron_jobs WHERE id = ?', [id])
    await registerCronJob(newJob)

    await db.query(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    , [nanoid(), request.tenantId, 'cron_job_created', 1, Date.now()])
    await db.query(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    , [nanoid(), request.tenantId, 'cron_jobs', 1, Date.now()])

    return reply.code(201).send({
      id,
      name,
      agent_id: agentId,
      schedule,
      preset: preset || null,
      enabled: 1,
      next_run_at: nextRunAt,
      created_at: createdAt,
    })
  })

  fastify.get('/', async (request) => {
    const { enabled } = request.query || {}
    const rows = enabled === undefined
      ? await db.all(
          `SELECT cj.*, a.name AS agent_name
           FROM cron_jobs cj
           JOIN agents a ON a.id = cj.agent_id
           WHERE cj.tenant_id = ?
           ORDER BY cj.created_at DESC`
        , [request.tenantId])
      : await db.all(
          `SELECT cj.*, a.name AS agent_name
           FROM cron_jobs cj
           JOIN agents a ON a.id = cj.agent_id
           WHERE cj.tenant_id = ? AND cj.enabled = ?
           ORDER BY cj.created_at DESC`
        , [request.tenantId, Number(enabled)])

    return await Promise.all(rows.map(async (job) => {
      const lastRun = await db.get('SELECT status FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT 1', [job.id])
      return {
        id: job.id,
        name: job.name,
        agent_id: job.agent_id,
        agent_name: job.agent_name,
        schedule: job.schedule,
        preset: job.preset,
        enabled: job.enabled,
        last_run_at: job.last_run_at,
        next_run_at: job.next_run_at,
        last_run_status: lastRun?.status || null,
        created_at: job.created_at,
      }
    }))
  })

  fastify.get('/:id/runs', async (request, reply) => {
    const job = await findJobForTenant(db, request.params.id, request.tenantId, reply)
    if (!job) return reply

    const { page = 1, limit = 20 } = request.query || {}
    const numericPage = Math.max(1, Number(page) || 1)
    const numericLimit = Math.max(1, Number(limit) || 20)
    const offset = (numericPage - 1) * numericLimit

    const countRow = await db.get(
      'SELECT COUNT(*) AS count FROM cron_runs WHERE cron_job_id = ? AND tenant_id = ?',
      [job.id, request.tenantId]
    )
    const total = countRow.count
    const rows = await db.all(
      `SELECT id, status, output, tokens_used, duration_ms, risk_score, started_at, completed_at
       FROM cron_runs
       WHERE cron_job_id = ? AND tenant_id = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
      [job.id, request.tenantId, numericLimit, offset]
    )

    const runs = await Promise.all(rows.map(async (run) => {
      const trace = await db.get('SELECT id FROM traces WHERE cron_run_id = ? LIMIT 1', [run.id])
      return {
        id: run.id,
        status: run.status,
        truncatedOutput: truncateOutput(run.output),
        tokens_used: run.tokens_used,
        duration_ms: run.duration_ms,
        risk_score: run.risk_score,
        started_at: run.started_at,
        completed_at: run.completed_at,
        trace_id: trace?.id || null,
      }
    }))

    return {
      runs,
      total,
      page: numericPage,
      pages: Math.ceil(total / numericLimit),
    }
  })

  fastify.get('/:id/runs/:runId', async (request, reply) => {
    const job = await findJobForTenant(db, request.params.id, request.tenantId, reply)
    if (!job) return reply

    const run = await db.get(
        `SELECT id, status, output, tokens_used, duration_ms, risk_score, started_at, completed_at
         FROM cron_runs
         WHERE id = ? AND cron_job_id = ? AND tenant_id = ?`
      , [request.params.runId, job.id, request.tenantId])
    if (!run) return reply.code(404).send({ error: 'cron_run_not_found' })

    const traceRow = await db.get(
        `SELECT id, intent, context_injected, tokens_used, duration_ms, risk_score, ts
         FROM traces
         WHERE cron_run_id = ?`
      , [run.id])

    const trace = traceRow
      ? {
          id: traceRow.id,
          intent: traceRow.intent,
          context_injected: parseContextInjected(traceRow.context_injected),
          tokens_used: traceRow.tokens_used,
          duration_ms: traceRow.duration_ms,
          risk_score: traceRow.risk_score,
          ts: traceRow.ts,
        }
      : null

    return { run, trace }
  })

  fastify.get('/:id', async (request, reply) => {
    const job = await findJobForTenant(db, request.params.id, request.tenantId, reply)
    if (!job) return reply
    return job
  })

  fastify.patch('/:id', async (request, reply) => {
    const job = await findJobForTenant(db, request.params.id, request.tenantId, reply)
    if (!job) return reply

    const { name, prompt, schedule, preset, enabled } = request.body || {}
    let nextRunAt = null
    if (schedule !== undefined) {
      const interval = validateSchedule(schedule, reply)
      if (!interval) return reply
      nextRunAt = interval.next().getTime()
    }

    await db.query(
      `UPDATE cron_jobs SET
        name = COALESCE(?, name),
        prompt = COALESCE(?, prompt),
        schedule = COALESCE(?, schedule),
        preset = COALESCE(?, preset),
        enabled = COALESCE(?, enabled),
        next_run_at = COALESCE(?, next_run_at)
       WHERE id = ? AND tenant_id = ?`
    , [name ?? null,
      prompt ?? null,
      schedule ?? null,
      preset ?? null,
      enabled === undefined ? null : Number(enabled),
      nextRunAt,
      request.params.id,
      request.tenantId])

    const updatedJob = await db.get('SELECT * FROM cron_jobs WHERE id = ?', [request.params.id])
    if (schedule !== undefined || enabled !== undefined) {
      await deregisterCronJob(job.id)
      await registerCronJob(updatedJob)
    }

    return updatedJob
  })

  fastify.delete('/:id', async (request, reply) => {
    const job = await findJobForTenant(db, request.params.id, request.tenantId, reply)
    if (!job) return reply

    await deregisterCronJob(job.id)
    await db.query('DELETE FROM cron_jobs WHERE id = ? AND tenant_id = ?', [job.id, request.tenantId])
    return reply.code(200).send({ success: true })
  })
}
