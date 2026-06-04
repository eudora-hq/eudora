import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'

export default function BillingSuccess() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/billing/usage')
      .then(res => {
        const { user, accessToken, refreshToken, setAuth } = useAuthStore.getState()
        setAuth(
          { ...user, plan: res.data.plan, trial_ends_at: null },
          accessToken,
          refreshToken
        )
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center font-mono">
      <div className="text-center space-y-8 max-w-md px-8">
        <div className="w-16 h-16 border-2 border-primary mx-auto flex items-center justify-center">
          <span className="material-symbols-outlined text-primary text-4xl">check</span>
        </div>

        <div className="space-y-3">
          <h1 className="text-white text-2xl font-bold uppercase tracking-widest">
            Plan Activated
          </h1>
          <p className="text-text-muted text-sm uppercase tracking-widest">
            Your subscription is now active.
          </p>
        </div>

        <button
          onClick={() => navigate('/dashboard')}
          disabled={loading}
          className="w-full bg-primary text-[#050505] font-mono text-xs uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {loading ? 'Activating...' : 'Continue to Dashboard →'}
        </button>
      </div>
    </div>
  )
}
