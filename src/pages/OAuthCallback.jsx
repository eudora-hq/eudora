import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

export default function OAuthCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setAuth = useAuthStore(state => state.setAuth)
  const [error, setError] = useState('')

  useEffect(() => {
    const accessToken = searchParams.get('accessToken')
    const refreshToken = searchParams.get('refreshToken')
    if (!accessToken || !refreshToken) {
      setError('OAuth login failed. Please return to login and try again.')
      return
    }

    const trialEndsAt = Number(searchParams.get('trialEndsAt')) || null
    const onboardingCompleted = searchParams.get('onboardingCompleted') === 'true'
    const user = {
      id: searchParams.get('userId'),
      email: searchParams.get('email'),
      name: searchParams.get('name') || null,
      role: searchParams.get('role') || 'member',
      plan: searchParams.get('plan') || 'trial',
      trial_ends_at: trialEndsAt,
      onboardingCompleted,
    }

    setAuth(user, accessToken, refreshToken)
    navigate(onboardingCompleted ? '/dashboard' : '/onboarding', { replace: true })
  }, [navigate, searchParams, setAuth])

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center p-8">
      <div className="border border-[#262626] bg-[#0a0a0a] p-6 w-full max-w-md text-center">
        {error ? (
          <>
            <p className="font-mono text-[11px] text-red-400">{error}</p>
            <button
              onClick={() => navigate('/login', { replace: true })}
              className="mt-5 border border-[#262626] text-text-muted hover:border-primary hover:text-primary px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors"
            >
              Return to Login
            </button>
          </>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <span className="w-2 h-2 bg-primary animate-pulse" />
            <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
              Establishing secure session...
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
