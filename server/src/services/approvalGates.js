import { nanoid } from 'nanoid'
import { sanitise } from '../security/sanitiser.js'
import { createNotification } from '../utils/notify.js'
import { sendApprovalRequiredEmail } from '../utils/email.js'
import { log } from '../audit/auditLogger.js'

const APP_URL = process.env.CLIENT_URL || 'http://localhost:5173'

function clamp(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function sanitisedText(value) {
  return sanitise(String(value || '')).sanitisedText
}

function agentOwnerId(db, agentId, tenantId) {
  let currentId = agentId
  const visited = new Set()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const agent = await db.get(
      'SELECT owner_type, owner_id FROM agents WHERE id = ? AND tenant_id = ?'
    , [currentId, tenantId])
    if (!agent) return null
    if (agent.owner_type === 'human') return agent.owner_id
    currentId = agent.owner_id
  }

  return null
}

function validApprovers(db, tenantId, userIds) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean))]
  if (!uniqueIds.length) return []
  const placeholders = uniqueIds.map(() => '?').join(', ')
  return await db.all(
    `SELECT id, email, name FROM users
     WHERE tenant_id = ? AND id IN (${placeholders})`
  , [tenantId, ...uniqueIds])
}

export function createApprovalGate(db, {
  tenantId,
  agentId,
  runId,
  workflowId = null,
  nodeId = null,
  riskScore = 0,
  riskReason = 'Risk threshold exceeded',
  agentPrompt = '',
  agentResponseDraft = '',
  requiredApprovers = 1,
  approverUserIds = [],
  timeoutMinutes = 60,
  onTimeout = 'reject',
  approvalMessage = 'Review this agent action before it proceeds.',
}) {
  const approvers = validApprovers(db, tenantId, approverUserIds)
  if (!approvers.length) {
    const owner = await db.get(
      "SELECT id, email, name FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1"
    , [tenantId])
    if (!owner) throw new Error('no_valid_approvers')
    approvers.push(owner)
  }

  const gateId = nanoid()
  const timeout = clamp(timeoutMinutes, 1, 1440, 60)
  const required = clamp(requiredApprovers, 1, Math.min(5, approvers.length), 1)
  const expiresAt = new Date(Date.now() + timeout * 60 * 1000).toISOString()
  const safePrompt = sanitisedText(agentPrompt)
  const safeDraft = sanitisedText(agentResponseDraft)
  const safeReason = sanitisedText(riskReason)
  const nowIso = new Date().toISOString()

  db.transaction(() => {
    await db.query(`
      INSERT INTO approval_gates (
        id, tenant_id, agent_id, run_id, workflow_id, node_id, status,
        risk_score, risk_reason, agent_prompt, agent_response_draft,
        required_approvers, current_approvals, timeout_minutes, on_timeout, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [gateId,
      tenantId,
      agentId,
      runId,
      workflowId,
      nodeId,
      Math.round(Number(riskScore) || 0),
      safeReason,
      safePrompt,
      safeDraft,
      required,
      timeout,
      onTimeout === 'escalate_owner' ? 'escalate_owner' : 'reject',
      expiresAt])

    const insertApprover = db.prepare(`
      INSERT INTO approval_gate_approvers (gate_id, user_id, notified_at)
      VALUES (?, ?, ?)
    `)
    for (const approver of approvers) insertApprover.run(gateId, approver.id, nowIso)
  })()

  const agent = await db.get(
    'SELECT name FROM agents WHERE id = ? AND tenant_id = ?'
  , [agentId, tenantId])
  const actionUrl = `/approvals/${gateId}`
  for (const approver of approvers) {
    createNotification(db, {
      tenantId,
      userId: approver.id,
      type: 'approval_required',
      title: 'AI action requires approval',
      message: `${agent?.name || 'An agent'} has a risk score of ${Math.round(Number(riskScore) || 0)}. ${approvalMessage}`,
      actionUrl,
    })
    sendApprovalRequiredEmail({
      to: approver.email,
      name: approver.name,
      agentName: agent?.name || 'AI agent',
      riskScore,
      riskReason: safeReason,
      approvalUrl: `${APP_URL}${actionUrl}`,
      expiresAt,
      reminder: false,
    }).catch(err => console.error('[approval] Email failed:', err.message))
  }

  log({
    tenantId,
    userId: agentOwnerId(db, agentId, tenantId),
    agentChain: [agentId],
    action: 'approval_required',
    riskScore,
    prompt: safePrompt,
    response: safeDraft,
    metadata: { gateId, workflowId, nodeId, requiredApprovers: required, expiresAt },
  }, db)

  return await db.get('SELECT * FROM approval_gates WHERE id = ?', [gateId])
}

export function isAgentOwner(db, gate, userId) {
  return agentOwnerId(db, gate.agent_id, gate.tenant_id) === userId
}

export function markGateBlocked(db, gate, status, reason, resolvedBy = null) {
  const resolvedAt = new Date().toISOString()
  await db.query(`
    UPDATE approval_gates
    SET status = ?, resolved_at = ?, resolved_by = ?
    WHERE id = ? AND tenant_id = ? AND status = 'pending'
  `, [status, resolvedAt, resolvedBy, gate.id, gate.tenant_id])

  if (gate.workflow_id) {
    const run = await db.get(
      'SELECT node_results FROM workflow_runs WHERE id = ? AND tenant_id = ?'
    , [gate.run_id, gate.tenant_id])
    const results = JSON.parse(run?.node_results || '[]')
    results.push({
      nodeId: gate.node_id,
      agentId: gate.agent_id,
      gateId: gate.id,
      output: '',
      tokensUsed: 0,
      durationMs: 0,
      status,
      blocked: true,
      reason,
    })
    await db.query(`
      UPDATE workflow_runs
      SET status = 'failed', node_results = ?, completed_at = ?
      WHERE id = ? AND tenant_id = ?
    `, [JSON.stringify(results), Date.now(), gate.run_id, gate.tenant_id])
  }

  log({
    tenantId: gate.tenant_id,
    userId: resolvedBy || agentOwnerId(db, gate.agent_id, gate.tenant_id),
    initiatedByUserId: resolvedBy,
    agentChain: [gate.agent_id],
    action: 'approval_blocked',
    riskScore: gate.risk_score,
    prompt: gate.agent_prompt,
    response: gate.agent_response_draft,
    metadata: { gateId: gate.id, status, reason },
  }, db)
}

export function expireApprovalGates(db, now = new Date()) {
  const expired = await db.all(`
    SELECT * FROM approval_gates
    WHERE status = 'pending' AND expires_at <= ?
  `, [now.toISOString()])

  for (const gate of expired) {
    if (gate.on_timeout === 'escalate_owner') {
      const actionOwner = agentOwnerId(db, gate.agent_id, gate.tenant_id)
      const tenantOwner = await db.get(`
        SELECT id, email, name FROM users
        WHERE tenant_id = ? AND role = 'owner' AND id != ?
        LIMIT 1
      `, [gate.tenant_id, actionOwner || ''])
      if (tenantOwner) {
        const nextExpiry = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
        await db.query(`
          INSERT INTO approval_gate_approvers (gate_id, user_id, notified_at)
          VALUES (?, ?, ?)
          ON CONFLICT(gate_id, user_id) DO UPDATE SET notified_at = excluded.notified_at
        `, [gate.id, tenantOwner.id, now.toISOString()])
        await db.query(`
          UPDATE approval_gates
          SET expires_at = ?, on_timeout = 'reject'
          WHERE id = ? AND tenant_id = ? AND status = 'pending'
        `, [nextExpiry, gate.id, gate.tenant_id])
        createNotification(db, {
          tenantId: gate.tenant_id,
          userId: tenantOwner.id,
          type: 'approval_required',
          title: 'Approval gate escalated',
          message: `A risk score ${gate.risk_score} action was not reviewed before its first deadline.`,
          actionUrl: `/approvals/${gate.id}`,
        })
        sendApprovalRequiredEmail({
          to: tenantOwner.email,
          name: tenantOwner.name,
          agentName: 'AI agent',
          riskScore: gate.risk_score,
          riskReason: gate.risk_reason,
          approvalUrl: `${APP_URL}/approvals/${gate.id}`,
          expiresAt: nextExpiry,
          reminder: true,
        }).catch(err => console.error('[approval] Escalation email failed:', err.message))
        continue
      }
    }
    markGateBlocked(db, gate, 'timed_out', 'Approval window expired')
  }
  return expired.length
}

export async function sendApprovalReminders(db, now = new Date()) {
  const threshold = new Date(now.getTime() - 30 * 60 * 1000).toISOString()
  const rows = await db.all(`
    SELECT aga.gate_id, aga.user_id, u.email, u.name,
           ag.agent_id, ag.risk_score, ag.risk_reason, ag.expires_at,
           a.name AS agent_name
    FROM approval_gate_approvers aga
    JOIN approval_gates ag ON ag.id = aga.gate_id
    JOIN users u ON u.id = aga.user_id AND u.tenant_id = ag.tenant_id
    JOIN agents a ON a.id = ag.agent_id AND a.tenant_id = ag.tenant_id
    WHERE ag.status = 'pending'
      AND ag.timeout_minutes >= 60
      AND ag.created_at <= ?
      AND aga.reminded_at IS NULL
  `, [threshold])

  for (const row of rows) {
    await sendApprovalRequiredEmail({
      to: row.email,
      name: row.name,
      agentName: row.agent_name,
      riskScore: row.risk_score,
      riskReason: row.risk_reason,
      approvalUrl: `${APP_URL}/approvals/${row.gate_id}`,
      expiresAt: row.expires_at,
      reminder: true,
    })
    await db.query(`
      UPDATE approval_gate_approvers SET reminded_at = ?
      WHERE gate_id = ? AND user_id = ?
    `, [now.toISOString(), row.gate_id, row.user_id])
  }
  return rows.length
}

export function startApprovalMonitor(db, logger = console) {
  const interval = setInterval(async () => {
    try {
      expireApprovalGates(db)
      await sendApprovalReminders(db)
    } catch (err) {
      logger.error?.('[approval] monitor failed', err)
    }
  }, 60_000)
  interval.unref?.()
  return interval
}
