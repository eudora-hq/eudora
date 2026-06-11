import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import getDb from '../db/client.js'
import { adaptDatabase } from '../db/index.js'

export interface AuditLogEntry {
  id: string
  tenant_id: string
  agent_id: string
  session_id: string
  event_type: 'request' | 'response' | 'error' | 'blocked'
  resolved_model?: string
  risk_score: number
  dlp_triggered: boolean
  dlp_findings?: string
  injection_detected: boolean
  decision?: string
  created_at: number
}

export interface AuditLogInput {
  tenantId: string
  userId: string
  action: string
  context?: string | null
  prompt?: string | null
  response?: string | null
  riskScore?: number
  metadata?: Record<string, unknown>
  initiatedByUserId?: string | null
  agentChain?: string[]
  resolvedModel?: string | null
}

interface DatabaseColumn {
  name: string
}

interface AuditDatabase {
  columns(table: string): Promise<DatabaseColumn[]> | DatabaseColumn[]
  query(sql: string, params?: unknown[]): Promise<unknown> | unknown
}

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

function sha256(value: string | null | undefined): string | null {
  if (value == null) return null
  return createHash('sha256').update(value).digest('hex')
}

export function log(entry: AuditLogInput, db?: AuditDatabase): void {
  setImmediate(async () => {
    try {
      const _db = adaptDatabase(db ?? getDb()) as AuditDatabase
      const hasResolvedModel = (await _db.columns('audit_log'))
        .some((column: DatabaseColumn) => column.name === 'resolved_model')
      const columns = [
        'id', 'tenant_id', 'user_id', 'action', 'context_hash', 'prompt_hash',
        'response_hash', 'risk_score', 'metadata', 'initiated_by_user_id',
        'agent_chain', ...(hasResolvedModel ? ['resolved_model'] : []), 'ts',
      ]
      const values = [
        nanoid(),
        entry.tenantId,
        entry.userId,
        entry.action,
        sha256(entry.context),
        sha256(entry.prompt),
        sha256(entry.response),
        entry.riskScore || 0,
        JSON.stringify(entry.metadata || {}),
        entry.initiatedByUserId || null,
        JSON.stringify(entry.agentChain || []),
        ...(hasResolvedModel ? [entry.resolvedModel || null] : []),
        Date.now()
      ]
      await _db.query(`
        INSERT INTO audit_log (${columns.join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})
      `, values)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[auditLogger] insert failed:', message)
    }
  })
}
