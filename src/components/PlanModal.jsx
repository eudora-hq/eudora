import { useState } from 'react'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'
import { useSelfHosted } from '../hooks/useSelfHosted'

const PLANS = [
  {
    id: 'solo',
    name: 'SOLO',
    price: '€19',
    period: '/mo',
    features: [
      '500 messages / day',
      '5 cron jobs',
      '50 context files',
      '30-day audit retention',
      '1 seat',
    ],
    missing: [
      'Workflow builder',
      'Audit export',
    ],
    recommended: false,
  },
  {
    id: 'team',
    name: 'TEAM',
    price: '€79',
    period: '/mo',
    features: [
      '2,000 messages / day',
      '20 cron jobs',
      '200 context files',
      '90-day audit retention',
      '10 seats',
      'Workflow builder',
    ],
    missing: [
      'Audit export',
    ],
    recommended: true,
  },
  {
    id: 'pro',
    name: 'PRO',
    price: '€199',
    period: '/mo',
    features: [
      'Unlimited messages',
      'Unlimited cron jobs',
      'Unlimited context files',
      '1-year audit retention',
      'Unlimited seats',
      'Workflow builder',
      'Audit export (JSON/CSV/PDF)',
    ],
    missing: [],
    recommended: false,
  },
]

export function PlanModal({ onClose }) {
  const isSelfHosted = useSelfHosted()
  const { user } = useAuthStore()
  const [loadingPlan, setLoadingPlan] = useState(null)
  const [error, setError] = useState('')
  const currentPlan = user?.plan || 'trial'

  const handleUpgrade = async (planId) => {
    try {
      setLoadingPlan(planId)
      setError('')
      const res = await api.post('/billing/checkout', { plan: planId })
      window.location.href = res.data.checkoutUrl
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to start checkout. Please try again.')
      setLoadingPlan(null)
    }
  }

  if (isSelfHosted) {
    return (
      <div className="fixed inset-0 z-50 bg-[#050505]/95 flex items-center justify-center p-8">
        <div className="border border-[#262626] bg-[#0a0a0a] p-12 max-w-lg w-full text-center space-y-6">
          <span className="material-symbols-outlined text-primary text-5xl block">shield</span>
          <h2 className="font-mono text-xl font-bold text-white uppercase tracking-widest">
            Self-Hosted
          </h2>
          <p className="font-mono text-sm text-text-muted leading-relaxed">
            You are running Eudora self-hosted. All features are available with no limits and no expiry.
          </p>
          <a
            href="https://github.com/eudora-hq/eudora"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-primary uppercase tracking-widest hover:underline block"
          >
            View on GitHub →
          </a>
          <button
            onClick={onClose}
            className="w-full border border-[#262626] text-text-muted font-mono text-xs uppercase tracking-widest py-3 hover:border-text-muted transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-[#050505]/95 flex items-center justify-center p-4 overflow-y-auto">
      <div className="border border-[#262626] bg-[#0a0a0a] w-full max-w-4xl">
        <div className="flex items-center justify-between border-b border-[#262626] px-8 py-5">
          <div>
            <h2 className="font-mono text-sm font-bold text-white uppercase tracking-widest">
              Choose a Plan
            </h2>
            <p className="font-mono text-xs text-text-muted mt-1">
              All plans include a 14-day free trial. No credit card required to start.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-white transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <div className="grid grid-cols-3 divide-x divide-[#262626]">
          {PLANS.map((plan) => {
            const isCurrent = currentPlan === plan.id
            const isRecommended = plan.recommended

            return (
              <div
                key={plan.id}
                className={`p-8 space-y-6 ${isCurrent ? 'bg-primary/5' : ''}`}
              >
                <div className="space-y-2">
                  {isRecommended && (
                    <span className="font-mono text-[9px] text-primary border border-primary/40 px-2 py-0.5 uppercase tracking-widest">
                      Recommended
                    </span>
                  )}
                  {isCurrent && (
                    <span className="font-mono text-[9px] text-text-muted border border-[#262626] px-2 py-0.5 uppercase tracking-widest">
                      Current plan
                    </span>
                  )}
                  <h3 className="font-mono text-lg font-bold text-white uppercase tracking-widest">
                    {plan.name}
                  </h3>
                  <div className="flex items-baseline gap-1">
                    <span className="font-mono text-3xl font-bold text-white">{plan.price}</span>
                    <span className="font-mono text-xs text-text-muted">{plan.period}</span>
                  </div>
                </div>

                <ul className="space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <span className="material-symbols-outlined text-primary text-sm mt-0.5 flex-shrink-0">check</span>
                      <span className="font-mono text-xs text-text-muted">{feature}</span>
                    </li>
                  ))}
                  {plan.missing.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 opacity-40">
                      <span className="material-symbols-outlined text-text-muted text-sm mt-0.5 flex-shrink-0">close</span>
                      <span className="font-mono text-xs text-text-muted">{feature}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => !isCurrent && handleUpgrade(plan.id)}
                  disabled={isCurrent || loadingPlan !== null}
                  className={`w-full font-mono text-xs uppercase tracking-widest py-3 transition-colors cursor-pointer disabled:cursor-default ${
                    isCurrent
                      ? 'border border-primary/30 text-primary/50 cursor-default'
                      : isRecommended
                        ? 'bg-primary text-[#050505] font-bold hover:bg-primary/90 disabled:opacity-50'
                        : 'border border-[#262626] text-text-muted hover:border-text-muted disabled:opacity-50'
                  }`}
                >
                  {isCurrent
                    ? 'Current plan'
                    : loadingPlan === plan.id
                      ? 'Redirecting...'
                      : `Choose ${plan.name}`}
                </button>
              </div>
            )
          })}
        </div>

        {error && (
          <div className="border-t border-[#262626] px-8 py-4">
            <p className="font-mono text-xs text-red-400 uppercase tracking-widest">{error}</p>
          </div>
        )}

        <div className="border-t border-[#262626] px-8 py-4 flex items-center justify-between">
          <p className="font-mono text-[10px] text-text-muted">
            All plans billed monthly. Cancel any time. Data export available on cancellation.
          </p>
          <button
            onClick={onClose}
            className="font-mono text-[10px] text-text-muted hover:text-white transition-colors uppercase tracking-widest cursor-pointer"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  )
}
