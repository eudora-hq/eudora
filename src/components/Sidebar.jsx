import { useAuthStore } from '../store/authStore';
import { NavLink, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { TierGate } from './TierGate';

export default function Sidebar() {
  const isSelfHosted = import.meta.env.VITE_SELF_HOSTED === 'true';
  const { user, plan, trialDaysLeft, refreshToken, clearAuth } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch {
      // Local auth state should still be cleared if the server session is already gone.
    }
    clearAuth();
    navigate('/login');
  };

  const navItems = [
    { id: 'dashboard', icon: 'grid_view', label: 'COMMAND CENTER', path: '/dashboard' },
    { id: 'analytics', icon: 'analytics', label: 'ANALYTICS', path: '/analytics' },
    { id: 'agents', icon: 'smart_toy', label: 'AGENT FLEET', path: '/agents' },
    { id: 'templates', icon: 'grid_view', label: 'TEMPLATES', path: '/templates' },
    { id: 'chat', icon: 'chat', label: 'NEURAL INTERFACE', path: '/chat' },
    { id: 'workflows', icon: 'account_tree', label: 'WORKFLOWS', path: '/workflows' },
    { id: 'audit', icon: 'receipt_long', label: 'NEXUS AUDIT', path: '/audit' },
    { id: 'cron', icon: 'calendar_today', label: 'SCHEDULED JOBS', path: '/cron' },
    { id: 'integrations', icon: 'hub', label: 'INTEGRATIONS', path: '/integrations' },
    ...((plan === 'professional' || plan === 'enterprise' || isSelfHosted)
      ? [{ id: 'team', icon: 'group', label: 'TEAM', path: '/team' }]
      : []),
    { id: 'settings', icon: 'settings', label: 'SETTINGS', path: '/settings' },
  ];

  return (
    <aside className="fixed left-0 top-0 bottom-0 flex flex-col w-[256px] h-screen border-r border-[#262626] bg-[#050505] z-50">
      {/* Top Section */}
      <div className="p-6 border-b border-[#262626] flex items-center gap-3">
        <div className="w-2 h-8 bg-primary"></div>
        <div>
          <h2 className="font-mono text-[18px] font-bold text-primary tracking-tighter uppercase leading-none mb-1">EUDORA OS</h2>
          <p className="font-mono text-[9px] tracking-[0.15em] text-primary opacity-70 uppercase leading-none">SECURE AI NODE</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto min-h-0">
        <div className="space-y-1">
          {navItems.map((item) => {
            const link = (
              <NavLink
                key={item.id}
                to={item.path}
                className={({ isActive }) => `w-full flex items-center gap-3 px-6 py-3 transition-all ${
                  isActive 
                    ? 'bg-primary/10 text-primary border-r-2 border-primary' 
                    : 'text-text-muted hover:text-white hover:bg-white/5'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                <span className="font-mono text-[10px] tracking-[0.15em] uppercase">{item.label}</span>
              </NavLink>
            );

            return item.id === 'workflows' ? (
              <TierGate key={item.id} feature="workflow_builder" message="Available on Professional and Enterprise plans">
                {link}
              </TierGate>
            ) : link;
          })}
        </div>

        <div className="mt-8 px-6">
          <button 
            onClick={() => navigate('/agents')}
            className="w-full bg-primary text-[#050505] py-2 font-mono text-[10px] uppercase font-bold tracking-widest active:scale-[0.98] transition-transform"
          >
            DEPLOY AGENT
          </button>
        </div>
      </nav>

      {/* Plan Badge */}
      <div className="px-6 py-4">
        {isSelfHosted ? (
          <span className="border border-primary/30 text-primary font-mono text-[9px] uppercase tracking-widest px-2 py-1">SELF-HOSTED</span>
        ) : plan === 'trial' ? (
          <div className="border-l-2 border-warning pl-3 py-1">
            <span className="font-mono text-[9px] text-warning uppercase font-bold tracking-[0.15em]">TRIAL — {trialDaysLeft} DAYS</span>
          </div>
        ) : (
          <div className="border-l-2 border-primary pl-3 py-1">
            <span className="font-mono text-[9px] text-primary uppercase font-bold tracking-[0.15em]">{plan}</span>
          </div>
        )}
      </div>

      {/* Bottom Section */}
      <div className="p-4 border-t border-[#262626]">
        <div className="px-2 pb-3 mb-2 border-b border-[#262626]">
          <span className="font-mono text-[9px] text-text-muted uppercase tracking-[0.15em] block">OPERATOR</span>
          <span className="font-mono text-[10px] text-white uppercase tracking-[0.1em] block truncate">{user?.name || user?.email || 'UNKNOWN USER'}</span>
        </div>
        <div className="space-y-1">
          <button
            onClick={() => navigate('/system-health')}
            className="w-full flex items-center gap-3 px-2 py-2 text-text-muted hover:text-white font-mono text-[10px] tracking-[0.15em] uppercase transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">monitor_heart</span>
            SYSTEM HEALTH
          </button>
          <button 
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-2 py-2 text-text-muted hover:text-white font-mono text-[10px] tracking-[0.15em] uppercase transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">logout</span>
            LOGOUT
          </button>
        </div>
      </div>

      {isSelfHosted && (
        <div className="border-t border-[#1a1a1a] p-4">
          <div className="space-y-2">
            <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest leading-relaxed">
              Self-Hosted
            </p>
            <p className="font-mono text-[9px] text-primary/70 uppercase tracking-widest">
              All features unlocked
            </p>
            <a
              href="https://geteudora.com"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[9px] text-primary border border-primary/30 px-2 py-1.5 hover:bg-primary/10 uppercase tracking-widest transition-colors block text-center mt-1"
            >
              Upgrade to Cloud →
            </a>
          </div>
        </div>
      )}
    </aside>
  );
}
