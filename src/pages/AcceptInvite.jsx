import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'

export default function AcceptInvite() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const navigate = useNavigate()
  const setAuth = useAuthStore((state) => state.setAuth)
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('Invalid invite link.')
      setLoading(false)
      return
    }

    api.get(`/auth/invite/${token}`)
      .then((response) => setInvite(response.data))
      .catch(() => setError('This invite link is invalid or has expired.'))
      .finally(() => setLoading(false))
  }, [token])

  const handleAccept = async () => {
    setError('')
    if (!name.trim()) {
      setError('Please enter your name')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      const response = await api.post('/auth/accept-invite', {
        token,
        name: name.trim(),
        password,
      })
      const { accessToken, refreshToken, user } = response.data
      setAuth({ ...user, onboardingCompleted: true }, accessToken, refreshToken)
      navigate('/dashboard', { replace: true })
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ||
        'Failed to accept invite. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <p className="font-mono text-[11px] text-text-muted uppercase tracking-widest">
          Validating invite...
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#050505] font-mono flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div>
          <p className="font-mono text-[9px] text-primary border border-primary/30 px-2 py-1 uppercase tracking-widest inline-block mb-4">
            EUDORA
          </p>
          <h1 className="font-mono text-[24px] font-bold text-white uppercase tracking-tight">
            Accept Invitation
          </h1>
          {invite && (
            <p className="font-mono text-[11px] text-text-muted mt-2">
              Join <span className="text-white">{invite.tenantName}</span> as{' '}
              <span className="text-primary">{invite.role}</span>
            </p>
          )}
        </div>

        {error && !invite ? (
          <div className="border border-red-500/30 bg-red-500/5 p-4">
            <p className="font-mono text-[11px] text-red-400">{error}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {invite && (
              <p className="font-mono text-[11px] text-text-muted">
                Joining as: <span className="text-primary">{invite.email}</span>
              </p>
            )}

            <InviteField
              label="Your Name"
              value={name}
              onChange={setName}
              placeholder="Jane Smith"
            />
            <InviteField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="Min. 8 characters"
            />
            <InviteField
              label="Confirm Password"
              type="password"
              value={confirm}
              onChange={setConfirm}
              placeholder="Repeat password"
              onKeyDown={(event) => event.key === 'Enter' && handleAccept()}
            />

            {error && <p className="font-mono text-[10px] text-red-400">{error}</p>}

            <button
              onClick={handleAccept}
              disabled={submitting || !name || !password || !confirm}
              className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {submitting ? 'Joining...' : 'Join Team →'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function InviteField({ label, value, onChange, type = 'text', placeholder, onKeyDown }) {
  return (
    <div className="space-y-1">
      <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[13px] px-4 py-3 focus:outline-none focus:border-primary"
        placeholder={placeholder}
      />
    </div>
  )
}
