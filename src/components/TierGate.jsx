import { useTierLimits } from '../hooks/useTierLimits'
import { useSelfHosted } from '../hooks/useSelfHosted'

export function TierGate({ feature, message, children }) {
  const isSelfHosted = useSelfHosted()
  const { usage } = useTierLimits()

  if (isSelfHosted) return children

  const GATED_FEATURES = {
    workflow_builder: ['team', 'pro', 'enterprise'],
    audit_export: ['pro', 'enterprise'],
    compliance_reports: ['enterprise'],
    team_members: ['team', 'pro', 'enterprise'],
  }

  const plan = usage?.plan || 'trial'
  const allowed = GATED_FEATURES[feature]?.includes(plan) ?? true

  if (allowed) return children

  return (
    <div className="relative">
      <div className="opacity-30 pointer-events-none select-none">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-bg/80">
        <div className="text-center p-4 border border-border">
          <span className="material-symbols-outlined text-text-muted text-4xl block mb-2">lock</span>
          <p className="font-mono text-xs text-text-muted uppercase tracking-widest">
            {message || `Available on higher plans`}
          </p>
          <a href="/settings" className="text-primary font-mono text-xs uppercase tracking-widest mt-2 block hover:underline">
            Upgrade →
          </a>
        </div>
      </div>
    </div>
  )
}
