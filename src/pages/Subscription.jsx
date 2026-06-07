import { useEffect, useState } from 'react'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: '€99',
    period: '/mo',
    features: [
      '10 agents monitored',
      '3 seats',
      '90-day audit retention',
      'Full audit trail + SHA-256',
      'Human accountability chain',
      'Managed infrastructure',
    ],
    checkoutPlan: 'starter',
  },
  {
    id: 'professional',
    name: 'Professional',
    price: '€399',
    period: '/mo',
    recommended: true,
    features: [
      '50 agents monitored',
      '10 seats',
      '1-year audit retention',
      'Proxy mode',
      'Audit export (JSON/CSV/PDF)',
      'Priority support',
    ],
    checkoutPlan: 'professional',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '€999',
    period: '/mo',
    features: [
      'Unlimited agents',
      'Unlimited seats',
      '3-year audit retention',
      'DORA compliance reports',
      'PBAC + scope policies',
      'EU data residency SLA',
    ],
    checkoutPlan: 'enterprise',
  },
]

export default function Subscription() {
  const user = useAuthStore((state) => state.user)
  const [subscription, setSubscription] = useState(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  const [upgrading, setUpgrading] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const isSelfHosted = import.meta.env.VITE_SELF_HOSTED === 'true'

  useEffect(() => {
    // self-hosted: skip early return, show banner inline with plans

    api.get('/billing/subscription')
      .then((response) => setSubscription(response.data))
      .catch((requestError) => {
        setError(requestError.response?.data?.message || 'Unable to load subscription')
      })
      .finally(() => setLoading(false))
  }, [isSelfHosted])

  const handleUpgrade = async (plan) => {
    setUpgrading(plan)
    setError('')
    setSuccess('')
    try {
      const response = await api.post('/billing/checkout', { plan })
      if (response.data.checkoutUrl) {
        window.location.href = response.data.checkoutUrl
        return
      }
      setError('Checkout URL was not returned')
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Failed to start checkout')
    }
    setUpgrading(null)
  }

  const handleCancel = async () => {
    setCancelling(true)
    setError('')
    setSuccess('')
    try {
      const response = await api.post('/billing/cancel')
      const cancelAt = response.data.cancel_at || response.data.current_period_end
      setSuccess(
        cancelAt
          ? `Subscription cancelled. Access continues until ${formatUnixDate(cancelAt)}.`
          : response.data.message
      )
      setSubscription((current) => ({
        ...current,
        cancelling: true,
        cancel_at: cancelAt || null,
        current_period_end: response.data.current_period_end || null,
      }))
      setConfirmCancel(false)
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Failed to cancel subscription')
    } finally {
      setCancelling(false)
    }
  }

  const handleReactivate = async () => {
    setReactivating(true)
    setError('')
    setSuccess('')
    try {
      await api.post('/billing/reactivate')
      setSuccess('Subscription reactivated successfully.')
      setSubscription((current) => ({
        ...current,
        cancelling: false,
        cancel_at: null,
      }))
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Failed to reactivate')
    } finally {
      setReactivating(false)
    }
  }

  if (isSelfHosted) {
    return (
      <div className="max-w-2xl space-y-6">
        <PageHeader />
        <div className="border border-primary/30 bg-primary/5 p-6">
          <p className="font-mono text-[12px] text-primary uppercase tracking-widest mb-2">
            Self-Hosted
          </p>
          <p className="font-mono text-[11px] text-text-muted">
            All features are unlocked. No subscription required.
          </p>
          <a
            href="https://geteudora.com"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-primary/60 hover:text-primary uppercase tracking-widest mt-3 block transition-colors"
          >
            Learn about cloud plans →
          </a>
        </div>
      </div>
    )
  }

  const currentPlan = subscription?.plan || user?.plan || 'trial'
  const isTrial = currentPlan === 'trial'
  const cancelAt = subscription?.cancel_at || subscription?.current_period_end

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader />

      {error && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}

      <div className="border border-[#262626] bg-[#0a0a0a] p-6">
        <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-3">
          Current Plan
        </p>
        {loading ? (
          <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            Loading subscription...
          </p>
        ) : (
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="font-mono text-[18px] font-bold text-primary uppercase">
                {currentPlan}
              </p>
              {isTrial && subscription?.trial_ends_at && (
                <p className="font-mono text-[10px] text-amber-400 mt-1">
                  Trial ends {new Date(subscription.trial_ends_at).toLocaleDateString()}
                </p>
              )}
              {subscription?.cancelling && cancelAt && (
                <p className="font-mono text-[10px] text-amber-400 mt-1">
                  Cancels {formatUnixDate(cancelAt)}
                  <button
                    onClick={handleReactivate}
                    disabled={reactivating}
                    className="text-primary hover:underline ml-2 cursor-pointer disabled:opacity-50"
                  >
                    {reactivating ? 'Reactivating...' : 'Reactivate'}
                  </button>
                </p>
              )}
            </div>
            {subscription?.usage && (
              <div className="text-right space-y-1">
                <p className="font-mono text-[10px] text-text-muted">
                  {subscription.usage.agents} agents used
                </p>
                <p className="font-mono text-[10px] text-text-muted">
                  {subscription.usage.seats} seats used
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-4">
          {isTrial ? 'Choose a plan to continue after trial' : 'Change your plan'}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              current={currentPlan === plan.id}
              upgrading={upgrading === plan.checkoutPlan}
              onUpgrade={handleUpgrade}
            />
          ))}
        </div>
      </div>

      <div className="border border-[#262626] p-4 flex items-center justify-between gap-6">
        <p className="font-mono text-[11px] text-text-muted">
          Need more? Enterprise+ from €3,000/mo — custom contracts, dedicated support.
        </p>
        <a
          href="mailto:hello@geteudora.com"
          className="font-mono text-[10px] text-primary hover:underline uppercase tracking-widest whitespace-nowrap"
        >
          Contact Sales →
        </a>
      </div>

      {subscription?.has_subscription && !subscription?.cancelling && !isTrial && (
        <div className="border-t border-[#1a1a1a] pt-6">
          {!confirmCancel ? (
            <button
              onClick={() => setConfirmCancel(true)}
              className="font-mono text-[10px] text-text-muted/50 hover:text-red-400 uppercase tracking-widest cursor-pointer transition-colors"
            >
              Cancel subscription
            </button>
          ) : (
            <div className="border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <p className="font-mono text-[11px] text-red-400">
                Your subscription remains active until the end of the current billing period.
                Your account then reverts to trial access.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="font-mono text-[10px] text-red-400 border border-red-500/30 px-4 py-2 hover:bg-red-500/10 cursor-pointer disabled:opacity-50 uppercase tracking-widest transition-colors"
                >
                  {cancelling ? 'Cancelling...' : 'Confirm Cancel'}
                </button>
                <button
                  onClick={() => setConfirmCancel(false)}
                  className="font-mono text-[10px] text-text-muted border border-[#262626] px-4 py-2 hover:border-text-muted cursor-pointer uppercase tracking-widest transition-colors"
                >
                  Keep Subscription
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PageHeader() {
  return (
    <div className="border-l-[4px] border-primary pl-6 py-2">
      <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white uppercase tracking-tight leading-none">
        Subscription
      </h1>
      <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] mt-2">
        Plan and Billing Management
      </p>
    </div>
  )
}

function PlanCard({ plan, current, upgrading, onUpgrade }) {
  return (
    <div className={`border p-6 flex flex-col ${
      plan.recommended
        ? 'border-primary bg-primary/5'
        : 'border-[#262626] bg-[#0a0a0a]'
    }`}>
      <div className="h-5">
        {plan.recommended && (
          <p className="font-mono text-[8px] text-primary uppercase tracking-widest">
            Recommended
          </p>
        )}
      </div>
      <p className="font-mono text-[13px] font-bold text-white uppercase mb-1">{plan.name}</p>
      <p className="font-mono text-[22px] font-bold text-white mb-4">
        {plan.price}
        <span className="text-[11px] font-normal text-text-muted">{plan.period}</span>
      </p>
      <ul className="flex-grow space-y-2 mb-6">
        {plan.features.map((feature) => (
          <li key={feature} className="font-mono text-[10px] text-text-muted flex items-start gap-2">
            <span className="text-primary mt-0.5">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {current ? (
        <div className="border border-primary/30 text-primary font-mono text-[10px] uppercase tracking-widest py-2 text-center">
          Current Plan
        </div>
      ) : (
        <button
          onClick={() => onUpgrade(plan.checkoutPlan)}
          disabled={upgrading}
          className={`w-full font-mono text-[10px] uppercase tracking-widest py-2 font-bold transition-colors cursor-pointer disabled:opacity-50 ${
            plan.recommended
              ? 'bg-primary text-[#050505] hover:bg-primary/90'
              : 'border border-[#262626] text-text-muted hover:border-primary hover:text-primary'
          }`}
        >
          {upgrading ? 'Redirecting...' : 'Select Plan →'}
        </button>
      )}
    </div>
  )
}

function Notice({ tone, children }) {
  const styles = tone === 'error'
    ? 'border-red-500/30 bg-red-500/5 text-red-400'
    : 'border-primary/30 bg-primary/5 text-primary'
  return (
    <div className={`border p-4 ${styles}`}>
      <p className="font-mono text-[11px]">{children}</p>
    </div>
  )
}

function formatUnixDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString()
}
