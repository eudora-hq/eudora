import { nanoid } from 'nanoid'
import getDb from '../db/client.js'
import { adaptDatabase } from '../db/index.js'

export function record(traceData, db) {
  setImmediate(async () => {
    try {
      const _db = adaptDatabase(db ?? getDb())
      await _db.query(`
        INSERT INTO traces
          (id, tenant_id, conversation_id, cron_run_id, workflow_run_id,
           intent, context_injected, tokens_used, duration_ms, risk_score, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [nanoid(),
        traceData.tenantId,
        traceData.conversationId || null,
        traceData.cronRunId || null,
        traceData.workflowRunId || null,
        traceData.intent,
        JSON.stringify(traceData.contextInjected),
        traceData.tokensUsed,
        traceData.durationMs,
        traceData.riskScore,
        Date.now()])
    } catch (err) {
      console.warn('[traceRecorder] insert failed:', err.message)
    }
  })
}
