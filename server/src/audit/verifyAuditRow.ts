import { createHmac } from 'node:crypto'

export function verifyAuditRow(row: Record<string, any>, signingKey: string): boolean {
  if (!row.row_hmac) return false

  const payload = JSON.stringify({
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    action: row.action,
    context_hash: row.context_hash,
    prompt_hash: row.prompt_hash,
    response_hash: row.response_hash,
    risk_score: row.risk_score,
    metadata: row.metadata,
    initiated_by_user_id: row.initiated_by_user_id,
    agent_chain: row.agent_chain,
    ...(Object.prototype.hasOwnProperty.call(row, 'resolved_model')
      ? { resolved_model: row.resolved_model }
      : {}),
    ...(row.explanation_code != null
      ? { explanation_code: row.explanation_code }
      : {}),
    ts: row.ts,
  })

  const expected = createHmac('sha256', Buffer.from(signingKey, 'hex'))
    .update(payload)
    .digest('hex')

  return expected === row.row_hmac
}
