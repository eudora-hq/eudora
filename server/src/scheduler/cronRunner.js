import cron from 'node-cron'
import { nanoid } from 'nanoid'
import { getDb } from '../db/client.js'
import { adaptDatabase } from '../db/index.js'
import { classify } from '../core/classifier.js'
import { retrieve } from '../core/contextRetriever.js'
import { compose } from '../core/promptComposer.js'
import { relay } from '../core/modelRelay.js'
import { sanitise } from '../security/sanitiser.js'
import { guard } from '../security/guardLayer.js'
import { enforceScope } from '../security/scopeEnforcer.js'
import { score } from '../security/riskScorer.js'
import { log, AUDIT_ACTIONS } from '../audit/auditLogger.js'
import { record } from '../audit/traceRecorder.js'
import { getHumanRoot } from '../utils/ownershipChain.js'
import { createNotification } from '../utils/notify.js'
import cronParser from 'cron-parser'
import { resolveModel } from '../utils/resolveModel.js'

const activeTasks = new Map()

function nextRunTimestamp(schedule) {
  return cronParser.parseExpression(schedule).next().getTime()
}

export function registerJob(job) {
  cronParser.parseExpression(job.schedule)

  if (activeTasks.has(job.id)) {
    deregisterJob(job.id)
  }

  if (job.enabled === 0 || job.enabled === false) return

  const task = cron.schedule(job.schedule, () => {
    runJob(job.id).catch((err) => {
      console.error('[cron] Job failed:', job.id, err)
    })
  })
  activeTasks.set(job.id, task)
  console.log('[cron] Registered job:', job.id, job.name, job.schedule)
}

export function deregisterJob(jobId) {
  const task = activeTasks.get(jobId)
  if (!task) return
  task.destroy()
  activeTasks.delete(jobId)
}

export function loadAllJobs() {
  const db = adaptDatabase(getDb())
  if (db.dialect === 'sqlite') {
    const jobs = db.all('SELECT * FROM cron_jobs WHERE enabled = 1')
    for (const job of jobs) {
      registerJob(job)
    }
    console.log(`[cron] Loaded ${jobs.length} jobs`)
    return
  }
  return loadAllJobsPostgres(db)
}

async function loadAllJobsPostgres(db) {
  const jobs = await db.all('SELECT * FROM cron_jobs WHERE enabled = 1')
  for (const job of jobs) {
    registerJob(job)
  }
  console.log(`[cron] Loaded ${jobs.length} jobs`)
}

async function runJob(jobId) {
  let db
  let job
  let agent
  let runId = null
  let startedAt = Date.now()
  let intent = 'unknown'
  let contextFilesUsed = []
  let content = ''
  let tokensUsed = { total: 0 }
  let riskScore = 0
  let resolvedModel = null

  try {
    db = adaptDatabase(getDb())
    job = await db.get('SELECT * FROM cron_jobs WHERE id = ?', [jobId])
    if (!job || job.enabled === 0) {
      deregisterJob(jobId)
      return
    }

    agent = await db.get(
      'SELECT * FROM agents WHERE id = ? AND tenant_id = ?',
      [job.agent_id, job.tenant_id]
    )

    runId = nanoid()
    startedAt = Date.now()
    await db.query(
      'INSERT INTO cron_runs (id, tenant_id, cron_job_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
    , [runId, job.tenant_id, job.id, 'running', startedAt])

    if (!agent) {
      const message = 'Agent not found'
      const durationMs = Date.now() - startedAt
      await db.query(
        `UPDATE cron_runs
         SET status = ?, output = ?, duration_ms = ?, completed_at = ?
         WHERE id = ?`
      , ['failed', message, durationMs, Date.now(), runId])
      await db.query('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?', [Date.now(), nextRunTimestamp(job.schedule), job.id])
      createCronFailureNotification(db, job, message)
      return
    }
    const connection = agent.api_key_id
      ? await db.get('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?', [agent.api_key_id, job.tenant_id])
      : null
    resolvedModel = resolveModel(agent, connection)

    const humanRootId = await getHumanRoot(db, agent.id, job.tenant_id) || agent.owner_id
    const sanitiserResult = sanitise(job.prompt)
    const guardResult = guard(sanitiserResult, agent.purpose)
    const durationBeforeRelay = () => Date.now() - startedAt

    if (!guardResult.allowed) {
      riskScore = score(sanitiserResult, guardResult, { compliant: true, violation: null })
      content = `guard_block: ${guardResult.violation}`
      await db.query(
        `UPDATE cron_runs
         SET status = ?, output = ?, tokens_used = ?, duration_ms = ?, risk_score = ?, completed_at = ?
         WHERE id = ?`
      , ['failed', content, 0, durationBeforeRelay(), riskScore, Date.now(), runId])
      await db.query('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?', [Date.now(), nextRunTimestamp(job.schedule), job.id])
      record({
        tenantId: job.tenant_id,
        cronRunId: runId,
        intent,
        contextInjected: contextFilesUsed,
        tokensUsed: 0,
        durationMs: durationBeforeRelay(),
        riskScore,
      })
      log({
        tenantId: job.tenant_id,
        userId: humanRootId,
        action: AUDIT_ACTIONS.CRON_RUN,
        prompt: job.prompt,
        response: content,
        riskScore,
        resolvedModel,
        metadata: { cronJobId: job.id, agentId: agent.id, intent, violation: guardResult.violation },
        initiatedByUserId: humanRootId,
        agentChain: [agent.id],
      })
      await db.query(
        'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
      , [nanoid(), job.tenant_id, 'cron_run', 0, Date.now()])
      createCronFailureNotification(db, job, content)
      return
    }

    const classification = await classify(job.prompt, agent.api_key_id, job.tenant_id)
    intent = classification.intent

    const { files } = await retrieve(agent.id, intent, job.tenant_id, sanitiserResult.sanitised)
    const composed = compose(agent.system_prompt || '', files, sanitiserResult.sanitised)
    contextFilesUsed = composed.contextFilesUsed

    const relayResult = agent.model_override
      ? await relay(composed, agent.api_key_id, job.tenant_id, agent.model_override)
      : await relay(composed, agent.api_key_id, job.tenant_id)
    content = relayResult.content
    tokensUsed = relayResult.tokensUsed || { total: 0 }
    resolvedModel = relayResult.resolvedModel || resolvedModel

    const scopeResult = enforceScope(content, agent.purpose)
    riskScore = score(sanitiserResult, guardResult, scopeResult)
    const durationMs = Date.now() - startedAt

    await db.query(
      `UPDATE cron_runs
       SET status = ?, output = ?, tokens_used = ?, duration_ms = ?, risk_score = ?, completed_at = ?
       WHERE id = ?`
    , ['success', content, tokensUsed.total || 0, durationMs, riskScore, Date.now(), runId])

    await db.query('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?', [Date.now(), nextRunTimestamp(job.schedule), job.id])

    record({
      tenantId: job.tenant_id,
      cronRunId: runId,
      intent,
      contextInjected: contextFilesUsed,
      tokensUsed: tokensUsed.total || 0,
      durationMs,
      riskScore,
    })
    log({
      tenantId: job.tenant_id,
      userId: humanRootId,
      action: AUDIT_ACTIONS.CRON_RUN,
      prompt: job.prompt,
      response: content,
      riskScore,
      resolvedModel,
      metadata: { cronJobId: job.id, agentId: agent.id, intent },
      initiatedByUserId: humanRootId,
      agentChain: [agent.id],
    })
    await db.query(
      'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
    , [nanoid(), job.tenant_id, 'cron_run', tokensUsed.total || 0, Date.now()])
  } catch (err) {
    try {
      const errorMessage = err?.message || 'Cron job failed'
      const durationMs = Date.now() - startedAt
      const humanRootId = agent
        ? await getHumanRoot(db, agent.id, job.tenant_id) || agent.owner_id
        : null
      if (db && runId) {
        await db.query(
          `UPDATE cron_runs
           SET status = ?, output = ?, tokens_used = ?, duration_ms = ?, risk_score = ?, completed_at = ?
           WHERE id = ?`
        , ['failed', errorMessage, tokensUsed?.total || 0, durationMs, riskScore, Date.now(), runId])
      }
      if (db && job) {
        await db.query('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?', [Date.now(), nextRunTimestamp(job.schedule), job.id])
      }
      if (db && job) {
        await db.query(
          'INSERT INTO usage_events (id, tenant_id, event_type, value, ts) VALUES (?, ?, ?, ?, ?)'
        , [nanoid(), job.tenant_id, 'cron_run', tokensUsed?.total || 0, Date.now()])
      }
      if (job && runId) {
        record({
          tenantId: job.tenant_id,
          cronRunId: runId,
          intent,
          contextInjected: contextFilesUsed,
          tokensUsed: tokensUsed?.total || 0,
          durationMs,
          riskScore,
        })
      }
      if (job) {
        log({
          tenantId: job.tenant_id,
          userId: humanRootId,
          action: AUDIT_ACTIONS.CRON_RUN,
          prompt: job.prompt,
          response: errorMessage,
          riskScore,
          resolvedModel,
          metadata: { cronJobId: job.id, agentId: agent?.id || job.agent_id, intent, error: errorMessage },
          initiatedByUserId: humanRootId,
          agentChain: agent?.id ? [agent.id] : [],
        })
        createCronFailureNotification(db, job, errorMessage)
      }
    } catch (updateErr) {
      console.error('[cron] Failed to mark job failed:', jobId, updateErr)
    }
    console.error('[cron] Run failed:', jobId, err)
  }
}

function createCronFailureNotification(db, job, errorMessage) {
  createNotification(db, {
    tenantId: job.tenant_id,
    type: 'cron_failure',
    title: 'Scheduled job failed',
    message: `Job "${job.name}" failed: ${String(errorMessage).substring(0, 100)}`,
    actionUrl: '/cron',
  })
}

export const __test = { runJob, activeTasks }
