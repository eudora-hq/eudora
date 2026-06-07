import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { useSelfHosted } from './hooks/useSelfHosted'
import api from './api/client'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import AgentBuilder from './pages/AgentBuilder'
import Chat from './pages/Chat'
import Layout from './components/Layout'
import ContextManager from './pages/ContextManager'
import AuditLog from './pages/AuditLog'
import Settings from './pages/Settings'
import Dashboard from './pages/Dashboard'
import WorkflowCanvas from './pages/WorkflowCanvas'
import CronJobs from './pages/CronJobs'
import TrialExpired from './pages/TrialExpired'
import BillingSuccess from './pages/BillingSuccess'
import Templates from './pages/Templates'
import SelfHostedSetup from './pages/SelfHostedSetup'
import ResetPassword from './pages/ResetPassword'
import AcceptInvite from './pages/AcceptInvite'
import Team from './pages/Team'
import Subscription from './pages/Subscription'
import SystemHealth from './pages/SystemHealth'
import Integrations from './pages/Integrations'
import OAuthCallback from './pages/OAuthCallback'
import Analytics from './pages/Analytics'

function ProtectedRoute({ children }) {
  const { isAuthenticated, user } = useAuthStore()
  const location = useLocation()
  const isSelfHosted = useSelfHosted()
  const [setupCheck, setSetupCheck] = useState({ loading: false, required: false, checked: false })
  const setupComplete = localStorage.getItem('eudora-setup-complete') === 'true'
  const shouldCheckSetup = isAuthenticated && isSelfHosted && !setupComplete && location.pathname !== '/setup'

  useEffect(() => {
    let mounted = true

    if (!shouldCheckSetup) {
      setSetupCheck({ loading: false, required: false, checked: false })
      return () => { mounted = false }
    }

    setSetupCheck({ loading: true, required: false, checked: false })
    api.get('/api-keys')
      .then((res) => {
        if (mounted) setSetupCheck({ loading: false, required: (res.data || []).length === 0, checked: true })
      })
      .catch(() => {
        if (mounted) setSetupCheck({ loading: false, required: false, checked: true })
      })

    return () => { mounted = false }
  }, [shouldCheckSetup])

  if (!isAuthenticated) return <Navigate to="/login" replace />

  const isTrialExpired = user?.plan === 'trial' &&
    user?.trial_ends_at &&
    Date.now() > user.trial_ends_at &&
    !isSelfHosted

  if (
    isTrialExpired &&
    location.pathname !== '/billing/expired' &&
    location.pathname !== '/billing'
  ) {
    return <Navigate to="/billing/expired" replace />
  }

  if (setupCheck.loading || (shouldCheckSetup && !setupCheck.checked)) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">CHECKING SELF-HOSTED SETUP...</span>
      </div>
    )
  }

  if (setupCheck.required && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />
  }

  if (user && !user.onboardingCompleted && location.pathname !== '/billing/expired' && location.pathname !== '/setup') {
    return <Navigate to="/onboarding" replace />
  }
  return children
}

function AuthRoute({ children }) {
  const { isAuthenticated } = useAuthStore()
  if (isAuthenticated) return <Navigate to="/agents" replace />
  return children
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<AuthRoute><Login /></AuthRoute>} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/auth/callback" element={<OAuthCallback />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/setup" element={<ProtectedRoute><SelfHostedSetup /></ProtectedRoute>} />
        <Route path="/billing/success" element={<BillingSuccess />} />
        <Route path="/billing/expired" element={<ProtectedRoute><TrialExpired /></ProtectedRoute>} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/agents" replace />} />
          <Route path="agents" element={<AgentBuilder />} />
          <Route path="templates" element={<Templates />} />
          <Route path="agents/:id/context" element={<ContextManager />} />
          <Route path="chat" element={<Chat />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="settings" element={<Settings />} />
          <Route path="team" element={<Team />} />
          <Route path="subscription" element={<Subscription />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="workflows" element={<WorkflowCanvas />} />
          <Route path="workflows/:id" element={<WorkflowCanvas />} />
          <Route path="cron" element={<CronJobs />} />
          <Route path="system-health" element={<SystemHealth />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="analytics" element={<Analytics />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
