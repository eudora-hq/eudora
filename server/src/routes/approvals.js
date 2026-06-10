import { nanoid } from 'nanoid'
import { createNotification } from '../utils/notify.js'
import {
  isAgentOwner,
  markGateBlocked,
} from '../services/approvalGates.js'

function parseGate(row) {
  if (!row) return row
  const blocked = ['rejected', 'timed_out'].includes(row.status)
  return {
    ...row,
    blocked,
    blocked_reason: blocked
      ? (row.status === 'timed_out' ? 'Approval window expired' : 'A designated approver rejected the action')
      : null,
    approvers: row.approvers ? JSON.parse(row.approvers) : [],
    decisions: row.decisions ? JSON.parse(row.decisions) : [],
  }
}

function gateDetail(db, tenantId, gateId) {
  const gate = db.prepare(`
    SELECT ag.*, a.name AS agent_name,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', u.id, 'name', u.name, 'email', u.email
        ))
        FROM approval_gate_approvers aga
        JOIN users u ON u.id = aga.user_id
        WHERE aga.gate_id = ag.id
      ), '[]') AS approvers,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', ad.id, 'approver_id', ad.approver_id,
          'approver_name', u.name, 'approver_email', u.email,
          'decision', ad.decision, 'reason', ad.reason,
          'decided_at', ad.decided_at, 'ip_address', ad.ip_address
        ))
        FROM approval_decisions ad
        JOIN users u ON u.id = ad.approver_id
        WHERE ad.gate_id = ag.id AND ad.tenant_id = ag.tenant_id
      ), '[]') AS decisions
    FROM approval_gates ag
    JOIN agents a ON a.id = ag.agent_id AND a.tenant_id = ag.tenant_id
    WHERE ag.id = ? AND ag.tenant_id = ?
  `).get(gateId, tenantId)
  return parseGate(gate)
}

export default async function approvalsRoutes(fastify) {
  const db = fastify.db

  fastify.get('/stats', async (request) => {
    const rows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM approval_gates
      WHERE tenant_id = ?
      GROUP BY status
    `).all(request.tenantId)
    const counts = Object.fromEntries(rows.map(row => [row.status, row.count]))
    return {
      pending: counts.pending || 0,
      approved: counts.approved || 0,
      rejected: counts.rejected || 0,
      timed_out: counts.timed_out || 0,
      total: rows.reduce((sum, row) => sum + row.count, 0),
    }
  })

  fastify.get('/', async (request) => {
    const { status, limit = 100 } = request.query || {}
    const validStatuses = new Set(['pending', 'approved', 'rejected', 'timed_out', 'auto_approved'])
    const selectedStatus = validStatuses.has(status) ? status : null
    const rows = selectedStatus
      ? db.prepare(`
          SELECT ag.*, a.name AS agent_name
          FROM approval_gates ag
          JOIN agents a ON a.id = ag.agent_id AND a.tenant_id = ag.tenant_id
          WHERE ag.tenant_id = ? AND ag.status = ?
          ORDER BY ag.created_at DESC LIMIT ?
        `).all(request.tenantId, selectedStatus, Math.min(Number(limit) || 100, 200))
      : db.prepare(`
          SELECT ag.*, a.name AS agent_name
          FROM approval_gates ag
          JOIN agents a ON a.id = ag.agent_id AND a.tenant_id = ag.tenant_id
          WHERE ag.tenant_id = ?
          ORDER BY ag.created_at DESC LIMIT ?
        `).all(request.tenantId, Math.min(Number(limit) || 100, 200))
    return { approvals: rows }
  })

  fastify.get('/:id', async (request, reply) => {
    const gate = gateDetail(db, request.tenantId, request.params.id)
    if (!gate) return reply.code(404).send({ error: 'not_found' })

    // Poll this endpoint after a 202 pending_approval response. When status
    // changes, the caller can continue or surface the blocked reason.
    return gate
  })

  fastify.post('/:id/decide', async (request, reply) => {
    const { decision, reason } = request.body || {}
    if (!['approved', 'rejected'].includes(decision)) {
      return reply.code(400).send({ error: 'invalid_decision' })
    }
    if (!reason || String(reason).trim().length < 10) {
      return reply.code(400).send({
        error: 'reason_required',
        message: 'A reason of at least 10 characters is required.',
      })
    }

    const gate = db.prepare(
      'SELECT * FROM approval_gates WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!gate) return reply.code(404).send({ error: 'not_found' })
    if (gate.status !== 'pending') {
      return reply.code(409).send({ error: 'already_resolved', status: gate.status })
    }

    const designated = db.prepare(`
      SELECT 1 FROM approval_gate_approvers
      WHERE gate_id = ? AND user_id = ?
    `).get(gate.id, request.user.userId)
    if (!designated) return reply.code(403).send({ error: 'not_designated_approver' })
    if (isAgentOwner(db, gate, request.user.userId)) {
      return reply.code(403).send({ error: 'conflict_of_interest' })
    }
    const existing = db.prepare(`
      SELECT 1 FROM approval_decisions
      WHERE gate_id = ? AND tenant_id = ? AND approver_id = ?
    `).get(gate.id, request.tenantId, request.user.userId)
    if (existing) return reply.code(409).send({ error: 'already_decided' })

    let shouldResume = false
    db.transaction(() => {
      db.prepare(`
        INSERT INTO approval_decisions (
          id, gate_id, tenant_id, approver_id, decision, reason, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(),
        gate.id,
        request.tenantId,
        request.user.userId,
        decision,
        String(reason).trim(),
        request.ip
      )

      if (decision === 'rejected') {
        markGateBlocked(db, gate, 'rejected', String(reason).trim(), request.user.userId)
        return
      }

      const approvals = db.prepare(`
        SELECT COUNT(*) AS count FROM approval_decisions
        WHERE gate_id = ? AND tenant_id = ? AND decision = 'approved'
      `).get(gate.id, request.tenantId).count
      if (approvals >= gate.required_approvers) {
        db.prepare(`
          UPDATE approval_gates
          SET status = 'approved', current_approvals = ?,
              resolved_at = ?, resolved_by = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending'
        `).run(
          approvals,
          new Date().toISOString(),
          request.user.userId,
          gate.id,
          request.tenantId
        )
        shouldResume = true
      } else {
        db.prepare(`
          UPDATE approval_gates SET current_approvals = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending'
        `).run(approvals, gate.id, request.tenantId)
      }
    })()

    if (shouldResume && gate.workflow_id) {
      setImmediate(async () => {
        try {
          const { executeWorkflow } = await import('../workflow/executionEngine.js')
          await executeWorkflow(
            gate.workflow_id,
            request.tenantId,
            db,
            gate.run_id,
            request.user.userId,
            { resumeGateId: gate.id }
          )
        } catch (err) {
          fastify.log.error(err)
        }
      })
    }

    return gateDetail(db, request.tenantId, gate.id)
  })

  fastify.post('/:id/escalate', async (request, reply) => {
    const { userId } = request.body || {}
    const gate = db.prepare(
      'SELECT * FROM approval_gates WHERE id = ? AND tenant_id = ?'
    ).get(request.params.id, request.tenantId)
    if (!gate) return reply.code(404).send({ error: 'not_found' })
    if (gate.status !== 'pending') return reply.code(409).send({ error: 'already_resolved' })
    if (!['owner', 'admin'].includes(request.user.role)) {
      return reply.code(403).send({ error: 'admin_required' })
    }

    const user = db.prepare(
      'SELECT id, name, email FROM users WHERE id = ? AND tenant_id = ?'
    ).get(userId, request.tenantId)
    if (!user) return reply.code(400).send({ error: 'invalid_approver' })

    db.prepare(`
      INSERT INTO approval_gate_approvers (gate_id, user_id, notified_at)
      VALUES (?, ?, ?)
      ON CONFLICT(gate_id, user_id) DO UPDATE SET notified_at = excluded.notified_at
    `).run(gate.id, user.id, new Date().toISOString())
    createNotification(db, {
      tenantId: request.tenantId,
      userId: user.id,
      type: 'approval_required',
      title: 'AI action escalated to you',
      message: `Approval gate for risk score ${gate.risk_score} requires your decision.`,
      actionUrl: `/approvals/${gate.id}`,
    })

    return gateDetail(db, request.tenantId, gate.id)
  })
}
