import { createHash } from 'crypto'
import { createHmac } from 'node:crypto'
import { nanoid } from 'nanoid'
import getDb from '../db/client.ts'
import { adaptDatabase } from '../db/index.ts'

export const AUDIT_ACTIONS = {
  CHAT_MESSAGE:       'chat_message',
  GUARD_BLOCK:        'guard_block',
  SCOPE_VIOLATION:    'scope_violation',
  INJECTION_DETECTED: 'injection_detected',
  CRON_RUN:           'cron_run',
  WORKFLOW_RUN:       'workflow_run',
  CONTEXT_UPLOAD:     'context_upload',
  AGENT_CREATED:      'agent_created',
  API_KEY_ADDED:      'api_key_added',
  LOGIN:              'login',
  LOGOUT:             'logout',
}

function sha256(value) {
  if (value == null) return null
  return createHash('sha256').update(value).digest('hex')
}

export function log(entry: any, db?: any) {
  setImmediate(async () => {
    try {
      const _db = adaptDatabase(db ?? getDb())
      const auditColumns = await _db.columns('audit_log')
      const hasResolvedModel = auditColumns
        .some(column => column.name === 'resolved_model')
      const hasHmacColumn = auditColumns
        .some(column => column.name === 'row_hmac')
      const id = nanoid()
      const tenant_id = entry.tenantId
      const user_id = entry.userId
      const action = entry.action
      const context_hash = sha256(entry.context)
      const prompt_hash = sha256(entry.prompt)
      const response_hash = sha256(entry.response)
      const risk_score = entry.riskScore || 0
      const metadata = JSON.stringify(entry.metadata || {})
      const initiated_by_user_id = entry.initiatedByUserId || null
      const agent_chain = JSON.stringify(entry.agentChain || [])
      const resolved_model = entry.resolvedModel || null
      const ts = Date.now()

      const payload = JSON.stringify({
        id,
        tenant_id,
        user_id,
        action,
        context_hash,
        prompt_hash,
        response_hash,
        risk_score,
        metadata,
        initiated_by_user_id,
        agent_chain,
        ...(hasResolvedModel ? { resolved_model } : {}),
        ts,
      })
      const signingKey = process.env.AUDIT_HMAC_KEY
      const row_hmac = signingKey
        ? createHmac('sha256', Buffer.from(signingKey, 'hex'))
          .update(payload)
          .digest('hex')
        : null

      const columns = [
        'id', 'tenant_id', 'user_id', 'action', 'context_hash', 'prompt_hash',
        'response_hash', 'risk_score', 'metadata', 'initiated_by_user_id',
        'agent_chain', ...(hasResolvedModel ? ['resolved_model'] : []),
        ...(hasHmacColumn ? ['row_hmac'] : []), 'ts',
      ]
      const values = [
        id,
        tenant_id,
        user_id,
        action,
        context_hash,
        prompt_hash,
        response_hash,
        risk_score,
        metadata,
        initiated_by_user_id,
        agent_chain,
        ...(hasResolvedModel ? [resolved_model] : []),
        ...(hasHmacColumn ? [row_hmac] : []),
        ts,
      ]
      await _db.query(`
        INSERT INTO audit_log (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
      `, values)
    } catch (err) {
      console.warn('[auditLogger] insert failed:', err.message)
    }
  })
}
