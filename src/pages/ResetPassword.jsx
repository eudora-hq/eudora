import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../api/client'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleReset = async () => {
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (!token) {
      setError('Invalid reset link - please request a new one')
      return
    }

    setLoading(true)
    try {
      await api.post('/auth/reset-password', { token, password })
      setSuccess(true)
      setTimeout(() => navigate('/login'), 3000)
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid or expired reset link')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#050505] font-mono flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div>
          <p className="font-mono text-[9px] text-primary border border-primary/30 px-2 py-1 uppercase tracking-widest inline-block mb-4">
            EUDORA
          </p>
          <h1 className="font-mono text-[24px] font-bold text-white uppercase tracking-tight">
            Reset Password
          </h1>
          <p className="font-mono text-[11px] text-text-muted mt-2">
            Enter your new password below.
          </p>
        </div>

        {success ? (
          <div className="border border-primary/30 bg-primary/5 p-4">
            <p className="font-mono text-[11px] text-primary">
              Password updated successfully. Redirecting to login...
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[13px] px-4 py-3 focus:outline-none focus:border-primary"
                placeholder="Min. 8 characters"
              />
            </div>
            <div className="space-y-1">
              <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[13px] px-4 py-3 focus:outline-none focus:border-primary"
                placeholder="Repeat password"
                onKeyDown={e => e.key === 'Enter' && handleReset()}
              />
            </div>
            {error && (
              <p className="font-mono text-[10px] text-red-400">{error}</p>
            )}
            <button
              type="button"
              onClick={handleReset}
              disabled={loading || !password || !confirm}
              className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Updating...' : 'Update Password'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="w-full font-mono text-[10px] text-text-muted hover:text-primary uppercase tracking-widest cursor-pointer transition-colors"
            >
              ← Back to login
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
