import { useEffect, useState } from 'react';
import { useTierLimits } from '../hooks/useTierLimits';
import { useSelfHosted } from '../hooks/useSelfHosted';
import api from '../api/client'
import { PlanModal } from '../components/PlanModal';

const METRICS = [
  ['agents', 'Agents', 'smart_toy'],
  ['cron_jobs', 'Cron Jobs', 'calendar_today'],
  ['context_files', 'Context Files', 'description'],
  ['workflows', 'Workflows', 'account_tree'],
];

export default function Dashboard() {
  const { usage, loading } = useTierLimits();
  const isSelfHosted = useSelfHosted();
  const [activity, setActivity] = useState([]);
  const [showPlanModal, setShowPlanModal] = useState(false);

  useEffect(() => {
    api.get('/audit', { params: { limit: 5 } })
      .then(res => setActivity(res.data.events || []))
      .catch(() => setActivity([]));
  }, []);

  const plan = usage?.plan || 'trial';
  const planBadge = isSelfHosted ? 'SELF-HOSTED' : plan.toUpperCase();
  const trialDays = usage?.trial_ends_at
    ? Math.max(0, Math.ceil((usage.trial_ends_at - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  const showUpgrade = !isSelfHosted && plan !== 'enterprise';

  return (
  <>
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2 flex items-start justify-between">
        <div>
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">COMMAND CENTER</h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">OPERATIONAL OVERVIEW</p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <span className="border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary uppercase font-bold tracking-widest">{planBadge}</span>
          {showUpgrade && (
            <button onClick={() => setShowPlanModal(true)} className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
              <span className="relative z-10">UPGRADE PLAN</span>
              <div className="scan-line"></div>
            </button>
          )}
        </div>
      </div>

      <div className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8 flex items-center gap-4">
        <span className="border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary uppercase font-bold tracking-widest">{planBadge}</span>
        {plan === 'trial' && trialDays !== null && (
          <span className="font-mono text-[12px] text-warning uppercase tracking-widest font-bold">TRIAL — {trialDays} DAYS REMAINING</span>
        )}
        {loading && <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">LOADING USAGE...</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-6">
        {METRICS.map(([key, label, icon]) => {
          const metric = usage?.metrics?.[key] || { used: 0, limit: 'Infinity' };
          const pct = progressPercent(metric);
          return (
            <div key={key} className="border border-[#262626] bg-[#0a0a0a] p-6">
              <div className="flex items-start justify-between mb-6">
                <span className="material-symbols-outlined text-primary text-[24px]">{icon}</span>
                <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">{metric.used} / {formatLimit(metric.limit)}</span>
              </div>
              <h3 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest mb-4">{label}</h3>
              <div className="h-1 bg-[#262626]">
                <div className="h-full" style={{ width: `${pct}%`, backgroundColor: progressColor(pct) }}></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border border-[#262626] bg-[#0a0a0a] flex flex-col">
        <div className="px-6 py-4 border-b border-[#262626] flex items-center gap-3 bg-[#050505]">
          <span className="material-symbols-outlined text-primary text-[18px]">receipt_long</span>
          <span className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">RECENT ACTIVITY</span>
        </div>
        <div className="divide-y divide-[#262626]">
          {activity.length === 0 ? (
            <div className="p-6 text-center">
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">NO RECENT ACTIVITY</span>
            </div>
          ) : activity.map(event => (
            <div key={event.id} className="px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-1.5 h-1.5 bg-primary rounded-full"></span>
                <span className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 border ${actionBadgeClass(event.action)}`}>{event.action}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className={`font-mono text-[9px] uppercase tracking-widest px-2 py-1 border ${riskBadgeClass(event.risk_score)}`}>RISK {event.risk_score ?? 0}</span>
                <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{formatTimestamp(event.ts)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
    {showPlanModal && <PlanModal onClose={() => setShowPlanModal(false)} />}
  </>
  );
}

function progressPercent(metric) {
  if (!metric || metric.limit === 'Infinity') return 0;
  const limit = Number(metric.limit);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, (Number(metric.used || 0) / limit) * 100);
}

function progressColor(percent) {
  if (percent >= 100) return '#ef4444';
  if (percent >= 80) return '#f59e0b';
  return '#737373';
}

function formatLimit(limit) {
  return limit === null || limit === undefined || limit === 'Infinity' ? '∞' : limit;
}

function formatTimestamp(timestamp) {
  return new Date(Number(timestamp)).toLocaleString();
}

function riskBadgeClass(score) {
  const risk = Number(score || 0);
  if (risk >= 51) return 'border-danger/40 bg-danger/10 text-danger';
  if (risk >= 21) return 'border-warning/40 bg-warning/10 text-warning';
  return 'border-primary/40 bg-primary/10 text-primary';
}

function actionBadgeClass(action) {
  if (['guard_block', 'injection_detected'].includes(action)) return 'border-danger/40 bg-danger/10 text-danger';
  if (action === 'scope_violation') return 'border-warning/40 bg-warning/10 text-warning';
  if (['agent_created', 'context_upload', 'api_key_added'].includes(action)) return 'border-primary/40 bg-primary/10 text-primary';
  if (['cron_run', 'login', 'logout'].includes(action)) return 'border-blue-500/40 bg-blue-500/10 text-blue-400';
  return 'border-[#404040] bg-[#171717] text-text-muted';
}
