import { useEffect, useMemo, useState } from 'react'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'

export default function Team() {
  const user = useAuthStore((state) => state.user)
  const [team, setTeam] = useState({
    members: [],
    invites: [],
    seatsUsed: 0,
    seatLimit: 1,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [submitting, setSubmitting] = useState(false)
  const canManage = ['owner', 'admin'].includes(user?.role)

  const seatLabel = useMemo(() => {
    if (team.seatLimit === 'Infinity') return `${team.seatsUsed} / unlimited seats used`
    return `${team.seatsUsed} / ${team.seatLimit} seats used`
  }, [team.seatLimit, team.seatsUsed])

  const loadTeam = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/team')
      setTeam(response.data)
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load team')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTeam()
  }, [])

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await api.post('/team/invite', {
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      setInviteEmail('')
      setInviteRole('member')
      setShowInvite(false)
      await loadTeam()
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to send invite')
    } finally {
      setSubmitting(false)
    }
  }

  const cancelInvite = async (invite) => {
    if (!window.confirm(`Cancel invite for ${invite.email}?`)) return
    try {
      await api.delete(`/team/invite/${invite.id}`)
      await loadTeam()
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to cancel invite')
    }
  }

  const removeMember = async (member) => {
    if (!window.confirm(`Remove ${member.name || member.email} from the team?`)) return
    try {
      await api.delete(`/team/members/${member.id}`)
      await loadTeam()
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to remove member')
    }
  }

  const changeRole = async (member, role) => {
    try {
      await api.patch(`/team/members/${member.id}/role`, { role })
      setTeam((current) => ({
        ...current,
        members: current.members.map((item) => (
          item.id === member.id ? { ...item, role } : item
        )),
      }))
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to change role')
    }
  }

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="flex items-end justify-between gap-6">
        <div className="border-l-[4px] border-primary pl-6 py-2">
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">
            Team
          </h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">
            Tenant Access Management
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            {seatLabel}
          </span>
          {canManage && (
            <button
              onClick={() => setShowInvite(true)}
              className="bg-primary text-[#050505] px-6 py-3 font-mono text-[10px] uppercase font-bold tracking-widest hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Invite Member
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="font-mono text-[10px] text-red-400 uppercase tracking-widest">{error}</p>
        </div>
      )}

      <section className="border border-[#262626] bg-[#0a0a0a]">
        <SectionHeader icon="group" title="Current Members" count={team.members.length} />
        {loading ? (
          <EmptyRow text="Loading team..." />
        ) : team.members.length === 0 ? (
          <EmptyRow text="No members found" />
        ) : (
          <div className="divide-y divide-[#262626]">
            {team.members.map((member) => (
              <div key={member.id} className="grid grid-cols-[1.4fr_1.5fr_0.7fr_1fr_auto] items-center gap-4 px-6 py-4">
                <div className="min-w-0">
                  <p className="font-mono text-[12px] text-white uppercase tracking-wider truncate">
                    {member.name || 'Unnamed User'}
                  </p>
                  {member.id === user?.id && (
                    <span className="font-mono text-[8px] text-primary uppercase tracking-widest">You</span>
                  )}
                </div>
                <p className="font-mono text-[10px] text-text-muted truncate">{member.email}</p>
                {canManage && member.role !== 'owner' ? (
                  <select
                    value={member.role}
                    onChange={(event) => changeRole(member, event.target.value)}
                    className="bg-[#050505] border border-[#262626] text-white font-mono text-[9px] uppercase tracking-widest px-2 py-2 focus:outline-none focus:border-primary"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <RoleBadge role={member.role} />
                )}
                <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
                  {member.last_login ? formatDate(member.last_login) : 'Never logged in'}
                </p>
                <div className="w-8">
                  {canManage && member.role !== 'owner' && member.id !== user?.id && (
                    <button
                      onClick={() => removeMember(member)}
                      className="text-text-muted hover:text-red-400 transition-colors cursor-pointer"
                      title="Remove member"
                    >
                      <span className="material-symbols-outlined text-[18px]">person_remove</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border border-[#262626] bg-[#0a0a0a]">
        <SectionHeader icon="outgoing_mail" title="Pending Invites" count={team.invites.length} />
        {!loading && team.invites.length === 0 ? (
          <EmptyRow text="No pending invites" />
        ) : (
          <div className="divide-y divide-[#262626]">
            {team.invites.map((invite) => (
              <div key={invite.id} className="grid grid-cols-[1.6fr_0.7fr_1fr_auto] items-center gap-4 px-6 py-4">
                <p className="font-mono text-[11px] text-white truncate">{invite.email}</p>
                <RoleBadge role={invite.role} />
                <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
                  Expires {formatDate(invite.expires_at)}
                </p>
                {canManage && (
                  <button
                    onClick={() => cancelInvite(invite)}
                    className="font-mono text-[9px] text-text-muted hover:text-red-400 uppercase tracking-widest transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {showInvite && (
        <div className="fixed inset-0 z-[80] bg-[#050505]/95 flex items-center justify-center p-8">
          <div className="border border-[#262626] bg-[#0a0a0a] w-full max-w-md">
            <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
              <h2 className="font-mono text-[13px] text-white uppercase font-bold tracking-widest">
                Invite Team Member
              </h2>
              <button
                onClick={() => setShowInvite(false)}
                className="text-text-muted hover:text-white cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <div className="p-6 space-y-5">
              <TeamField
                label="Email Address"
                type="email"
                value={inviteEmail}
                onChange={setInviteEmail}
                placeholder="colleague@company.com"
              />
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                  Role
                </label>
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-3 focus:outline-none focus:border-primary"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                onClick={sendInvite}
                disabled={submitting || !inviteEmail.trim()}
                className="w-full bg-primary text-[#050505] py-3 font-mono text-[10px] uppercase font-bold tracking-widest hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
              >
                {submitting ? 'Sending...' : 'Send Invitation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionHeader({ icon, title, count }) {
  return (
    <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-primary text-[18px]">{icon}</span>
        <h2 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest">{title}</h2>
      </div>
      <span className="font-mono text-[9px] text-text-muted border border-[#262626] px-2 py-1 uppercase">
        {count}
      </span>
    </div>
  )
}

function RoleBadge({ role }) {
  return (
    <span className={`w-fit border px-2 py-1 font-mono text-[8px] uppercase tracking-widest ${
      role === 'owner'
        ? 'border-primary/40 text-primary bg-primary/10'
        : role === 'admin'
          ? 'border-amber-500/40 text-amber-400 bg-amber-500/10'
          : 'border-[#262626] text-text-muted'
    }`}>
      {role}
    </span>
  )
}

function EmptyRow({ text }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">{text}</p>
    </div>
  )
}

function TeamField({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <div className="space-y-2">
      <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-3 focus:outline-none focus:border-primary"
      />
    </div>
  )
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
