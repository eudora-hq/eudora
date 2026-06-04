import { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { useTierLimits } from '../hooks/useTierLimits';
import { useSelfHosted } from '../hooks/useSelfHosted';
import { PlanModal } from './PlanModal';

export default function Header() {
  const isSelfHosted = useSelfHosted();
  const { user, plan } = useAuthStore();
  const { usage } = useTierLimits();
  const [showModal, setShowModal] = useState(false);
  const trialEndsAt = usage?.trial_ends_at;
  const activePlan = usage?.plan || plan;
  const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000))) : null;

  const getInitials = (name) => {
    if (!name) return '??';
    return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  };

  return (
    <>
    <header className="fixed top-0 right-0 left-[256px] z-40 flex items-center justify-between px-8 h-[64px] bg-[#050505] border-b border-[#262626]">
      <div className="flex items-center gap-4">
        <span className="font-mono text-[18px] font-bold text-primary tracking-tighter uppercase">EUDORA</span>
        <div className="flex items-center gap-2 border border-primary/20 bg-surface px-3 py-1.5 ml-4">
          <span className="w-2 h-2 bg-primary rounded-full pulse-dot"></span>
          <span className="font-mono text-[9px] tracking-[0.2em] text-primary uppercase">STATUS: VIGILANCE ACTIVE</span>
        </div>
      </div>
      
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-4">
          <button className="text-text-muted hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-[20px]">notifications</span>
          </button>
          <button className="text-text-muted hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-[20px]">security</span>
          </button>
          <button className="text-text-muted hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-[20px]">terminal</span>
          </button>
        </div>
        <div className="hidden lg:flex flex-col items-end">
          <span className="font-mono text-[9px] text-[#A3A3A3]/50 uppercase tracking-[0.2em] mb-0.5">{(activePlan || 'trial').toUpperCase()} PLAN</span>
          <span className="font-mono text-[11px] text-[#A3A3A3] font-bold uppercase tracking-tight">{user?.name || user?.email || 'UNKNOWN USER'}</span>
        </div>
        <div className="w-8 h-8 bg-surface border border-[#262626] flex items-center justify-center">
          <span className="font-mono text-[12px] text-primary font-bold">{getInitials(user?.name || user?.email || 'USER')}</span>
        </div>
      </div>
    </header>
    {!isSelfHosted && activePlan === 'trial' && trialEndsAt && (
      <div className="fixed top-[64px] right-0 left-[256px] z-30 bg-warning/10 border-b border-warning/30 flex items-center justify-center py-2">
        <span className="font-mono text-[9px] uppercase text-warning tracking-[0.1em]">
          TRIAL PERIOD — {trialDaysLeft} DAYS REMAINING —
        </span>
        <button
          onClick={() => setShowModal(true)}
          className="font-mono text-[9px] uppercase text-warning tracking-[0.1em] hover:underline ml-1 cursor-pointer"
        >
          UPGRADE TO PRO
        </button>
      </div>
    )}
    {showModal && <PlanModal onClose={() => setShowModal(false)} />}
    </>
  );
}
