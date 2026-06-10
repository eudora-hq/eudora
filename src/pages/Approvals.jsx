import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '../api/client'

const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'timed_out', 'auto_approved'])

export default function Approvals() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [tab, setTab] = useState(id ? 'pending' : 'pending')
  const [approvals, setApprovals] = useState([])
  const [selected, setSelected] = useState(null)
  const [reason, setReason] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState('')
  const [error, setError] = useState('')
  const [, setClock] = useState(Date.now())

  const load = async () => {
    try {
      const res = await api.get('/v1/approvals')
      setApprovals(res.data.approvals || [])
      if (id) {
        const detail = await api.get(`/v1/approvals/${id}`)
        setSelected(detail.data)
        if (TERMINAL_STATUSES.has(detail.data.status)) setTab('resolved')
      }
      setError('')
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to load approvals')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const poll = setInterval(load, 15_000)
    const countdown = setInterval(() => setClock(Date.now()), 1_000)
    return () => {
      clearInterval(poll)
      clearInterval(countdown)
    }
  }, [id])

  const visible = useMemo(
    () => approvals.filter(gate => tab === 'pending'
      ? gate.status === 'pending'
      : TERMINAL_STATUSES.has(gate.status)),
    [approvals, tab]
  )

  const openGate = async (gateId) => {
    navigate(`/approvals/${gateId}`)
    const res = await api.get(`/v1/approvals/${gateId}`)
    setSelected(res.data)
    setReason('')
    setExpanded(false)
  }

  const decide = async (decision) => {
    if (!selected || reason.trim().length < 10) {
      setError('Enter a reason of at least 10 characters.')
      return
    }
    setSubmitting(decision)
    setError('')
    try {
      const res = await api.post(`/v1/approvals/${selected.id}/decide`, {
        decision,
        reason: reason.trim(),
      })
      setSelected(res.data)
      setReason('')
      setTab(res.data.status === 'pending' ? 'pending' : 'resolved')
      await load()
    } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.error || 'Decision failed')
    } finally {
      setSubmitting('')
    }
  }

  if (loading) {
    return <div className="p-8 font-mono text-[10px] text-text-muted uppercase tracking-widest">Loading approvals...</div>
  }

  return (
    <div className="p-8 max-w-6xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-mono text-[20px] font-bold text-white uppercase tracking-tight">Pending Approvals</h1>
          <p className="font-mono text-[10px] text-text-muted mt-1">Human oversight for high-risk agent actions</p>
        </div>
        <span className="border border-amber-500/30 bg-amber-500/5 px-3 py-1 font-mono text-[9px] text-amber-400 uppercase tracking-widest">
          {approvals.filter(gate => gate.status === 'pending').length} awaiting action
        </span>
      </div>

      {error && <div className="border border-red-500/30 bg-red-500/5 p-3 font-mono text-[10px] text-red-400">{error}</div>}

      <div className="flex border-b border-[#262626]">
        {['pending', 'resolved'].map(value => (
          <button key={value} onClick={() => setTab(value)}
            className={`px-4 py-3 border-b-2 font-mono text-[10px] uppercase tracking-widest ${
              tab === value ? 'border-amber-400 text-amber-400' : 'border-transparent text-text-muted'
            }`}>
            {value}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6">
        <div className="space-y-3">
          {visible.length === 0 ? (
            <div className="border border-[#262626] bg-[#0a0a0a] p-8 text-center font-mono text-[10px] text-text-muted uppercase tracking-widest">
              No {tab} approvals
            </div>
          ) : visible.map(gate => (
            <button key={gate.id} onClick={() => openGate(gate.id)}
              className={`w-full text-left border bg-[#0a0a0a] p-4 transition-colors ${
                selected?.id === gate.id ? 'border-amber-400' : 'border-[#262626] hover:border-amber-500/50'
              }`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[12px] text-white font-bold uppercase tracking-widest">{gate.agent_name}</p>
                  <p className="font-mono text-[9px] text-text-muted mt-1">{new Date(gate.created_at).toLocaleString()}</p>
                </div>
                <RiskBadge score={gate.risk_score} />
              </div>
              <p className="font-mono text-[10px] text-text-muted mt-3 line-clamp-2">{gate.risk_reason}</p>
              <div className="flex items-center justify-between mt-3">
                <StatusBadge status={gate.status} />
                {gate.status === 'pending' && (
                  <span className="font-mono text-[9px] text-amber-400">{timeRemaining(gate.expires_at)}</span>
                )}
              </div>
            </button>
          ))}
        </div>

        <aside className="border border-[#262626] bg-[#0a0a0a] h-fit">
          {!selected ? (
            <p className="p-6 font-mono text-[10px] text-text-muted uppercase tracking-widest">Select an approval gate</p>
          ) : (
            <>
              <div className="p-4 border-b border-[#262626] flex items-center justify-between">
                <span className="font-mono text-[10px] text-white uppercase tracking-widest">Gate detail</span>
                <StatusBadge status={selected.status} />
              </div>
              <div className="p-4 space-y-4">
                <Detail label="Agent" value={selected.agent_name} />
                <Detail label="Risk score" value={`${selected.risk_score}/100`} />
                <Detail label="Reason" value={selected.risk_reason} />
                <TextBlock label="Prompt" value={selected.agent_prompt} expanded={expanded} />
                {selected.agent_response_draft && (
                  <TextBlock label="Response draft" value={selected.agent_response_draft} expanded={expanded} />
                )}
                {((selected.agent_prompt?.length || 0) > 200 || (selected.agent_response_draft?.length || 0) > 200) && (
                  <button onClick={() => setExpanded(!expanded)}
                    className="font-mono text-[9px] text-amber-400 uppercase tracking-widest">
                    {expanded ? 'Show less' : 'Show more'}
                  </button>
                )}

                {selected.status === 'pending' ? (
                  <>
                    <div>
                      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block mb-2">
                        Decision reason
                      </label>
                      <textarea value={reason} onChange={event => setReason(event.target.value)}
                        placeholder="Explain why this action should proceed or be blocked..."
                        className="w-full min-h-[110px] bg-[#050505] border border-[#262626] p-3 text-white font-mono text-[11px] resize-y focus:outline-none focus:border-amber-400" />
                      <p className="font-mono text-[8px] text-text-muted mt-1">{reason.trim().length}/10 minimum</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <button onClick={() => decide('approved')} disabled={submitting || reason.trim().length < 10}
                        className="bg-primary text-[#050505] py-3 font-mono text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">
                        {submitting === 'approved' ? 'Approving...' : 'Approve'}
                      </button>
                      <button onClick={() => decide('rejected')} disabled={submitting || reason.trim().length < 10}
                        className="border border-red-500/40 text-red-400 py-3 font-mono text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">
                        {submitting === 'rejected' ? 'Rejecting...' : 'Reject'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    {(selected.decisions || []).map(decision => (
                      <div key={decision.id} className="border border-[#262626] p-3">
                        <p className="font-mono text-[9px] text-white uppercase tracking-widest">
                          {decision.decision} by {decision.approver_name || decision.approver_email}
                        </p>
                        <p className="font-mono text-[10px] text-text-muted mt-2">{decision.reason}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function RiskBadge({ score }) {
  const high = Number(score) >= 70
  return <span className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${
    high ? 'border-red-500/40 bg-red-500/5 text-red-400' : 'border-amber-500/40 bg-amber-500/5 text-amber-400'
  }`}>Risk {score}</span>
}

function StatusBadge({ status }) {
  const colours = status === 'approved' || status === 'auto_approved'
    ? 'text-primary border-primary/30'
    : status === 'pending'
      ? 'text-amber-400 border-amber-500/30'
      : 'text-red-400 border-red-500/30'
  return <span className={`border px-2 py-1 font-mono text-[8px] uppercase tracking-widest ${colours}`}>{status.replace('_', ' ')}</span>
}

function Detail({ label, value }) {
  return <div><p className="font-mono text-[8px] text-text-muted uppercase tracking-widest">{label}</p><p className="font-mono text-[10px] text-white mt-1">{value || '—'}</p></div>
}

function TextBlock({ label, value, expanded }) {
  const text = value || '—'
  return <div><p className="font-mono text-[8px] text-text-muted uppercase tracking-widest mb-1">{label}</p><pre className="font-mono text-[10px] text-white whitespace-pre-wrap break-words">{expanded ? text : text.slice(0, 200)}</pre></div>
}

function timeRemaining(expiresAt) {
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'Expired'
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}m ${seconds}s remaining`
}
