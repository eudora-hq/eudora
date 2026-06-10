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

  const groups = [
    {
      header: null,
      items: [
        { id: 'dashboard', icon: 'grid_view', label: 'COMMAND CENTER', path: '/dashboard' },
        { id: 'analytics', icon: 'analytics', label: 'ANALYTICS', path: '/analytics' },
      ],
    },
    {
      header: 'AGENTS',
      items: [
        { id: 'agents', icon: 'smart_toy', label: 'AGENT FLEET', path: '/agents' },
        { id: 'templates', icon: 'grid_view', label: 'TEMPLATES', path: '/templates' },
        { id: 'chat', icon: 'chat', label: 'NEURAL INTERFACE', path: '/chat' },
        { id: 'approvals', icon: 'shield_person', label: 'APPROVALS', path: '/approvals' },
      ],
    },
    {
      header: 'COMPLIANCE',
      items: [
        { id: 'compliance', icon: 'verified', label: 'COMPLIANCE', path: '/compliance', gate: 'compliance' },
        { id: 'audit', icon: 'receipt_long', label: 'NEXUS AUDIT', path: '/audit' },
        { id: 'integrations', icon: 'hub', label: 'INTEGRATIONS', path: '/integrations' },
      ],
    },
    {
      header: 'WORKFLOWS',
      items: [
        { id: 'workflows', icon: 'account_tree', label: 'WORKFLOWS', path: '/workflows', gate: 'workflow_builder' },
        { id: 'cron', icon: 'calendar_today', label: 'SCHEDULED JOBS', path: '/cron' },
      ],
    },
    {
      header: 'ACCOUNT',
      items: [
        ...(plan === 'professional' || plan === 'enterprise' || isSelfHosted
          ? [{ id: 'team', icon: 'group', label: 'TEAM', path: '/team' }]
          : []),
        { id: 'settings', icon: 'settings', label: 'SETTINGS', path: '/settings' },
      ],
    },
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
        {groups.map((group) => (
          <div key={group.header || 'primary'}>
            {group.header && (
              <div className="font-mono text-[8px] text-text-muted/50 uppercase tracking-[0.2em] px-6 pt-3 pb-1">
                {group.header}
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const link = (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    className={({ isActive }) => `w-full flex items-center gap-3 px-6 py-2 transition-all ${
                      isActive
                        ? 'bg-primary/10 text-primary border-r-2 border-primary'
                        : 'text-text-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                    <span className="font-mono text-[10px] tracking-[0.15em] uppercase">{item.label}</span>
                  </NavLink>
                );

                return item.gate ? (
                  <TierGate
                    key={item.id}
                    feature={item.gate}
                    message="Available on Professional and Enterprise plans"
                  >
                    {link}
                  </TierGate>
                ) : link;
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-6 py-2">
        <button
          onClick={() => navigate('/agents')}
          className="w-full bg-primary text-[#050505] py-2 font-mono text-[10px] uppercase font-bold tracking-widest active:scale-[0.98] transition-transform"
        >
          DEPLOY AGENT
        </button>
      </div>

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
      <div className="border-t border-[#262626]">
        <div className="px-4 py-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px] text-text-muted">person</span>
          <span className="font-mono text-[9px] text-text-muted uppercase truncate">{user?.email}</span>
        </div>
        <div className="px-4 py-2 flex items-center gap-2">
          <button
            title="System Health"
            onClick={() => navigate('/system-health')}
            className="flex items-center gap-1 text-text-muted hover:text-white transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">monitor_heart</span>
            <span className="font-mono text-[9px] uppercase tracking-widest">HEALTH</span>
          </button>
          <span className="text-text-muted/30 text-[10px]">|</span>
          <button
            title="Logout"
            onClick={handleLogout}
            className="flex items-center gap-1 text-text-muted hover:text-white transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">logout</span>
            <span className="font-mono text-[9px] uppercase tracking-widest">LOGOUT</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
