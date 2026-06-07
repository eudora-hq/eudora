import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useTierLimits } from '../hooks/useTierLimits';
import { useSelfHosted } from '../hooks/useSelfHosted';
import { PlanModal } from './PlanModal';
import api from '../api/client';

export default function Header() {
  const navigate = useNavigate();
  const isSelfHosted = useSelfHosted();
  const { user, plan } = useAuthStore();
  const { usage } = useTierLimits();
  const [showModal, setShowModal] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const trialEndsAt = usage?.trial_ends_at;
  const activePlan = usage?.plan || plan;
  const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000))) : null;

  useEffect(() => {
    const fetchNotifications = () => {
      api.get('/notifications')
        .then((response) => {
          setNotifications(response.data.notifications || []);
          setUnreadCount(response.data.unreadCount || 0);
        })
        .catch(() => {});
    };

    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setNotificationsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await api.post('/notifications/read-all');
      setNotifications((current) => current.map(notification => ({ ...notification, read: 1 })));
      setUnreadCount(0);
    } catch {
      // Polling will reconcile state on the next successful request.
    }
  };

  const handleNotificationClick = async (notification) => {
    if (!notification.read) {
      setNotifications((current) => current.map(item => (
        item.id === notification.id ? { ...item, read: 1 } : item
      )));
      setUnreadCount((current) => Math.max(0, current - 1));
      api.post(`/notifications/${notification.id}/read`).catch(() => {});
    }

    setNotificationsOpen(false);
    if (notification.action_url) navigate(notification.action_url);
  };

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
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setNotificationsOpen(current => !current)}
              className="relative text-text-muted hover:text-primary transition-colors cursor-pointer"
              aria-label="Notifications"
              aria-expanded={notificationsOpen}
            >
              <span className="material-symbols-outlined text-[20px]">notifications</span>
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 bg-danger rounded-full flex items-center justify-center font-mono text-[8px] text-white font-bold">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {notificationsOpen && (
              <div className="absolute right-0 top-8 w-80 bg-[#0a0a0a] border border-[#262626] shadow-2xl z-50 max-h-96 overflow-y-auto">
                <div className="sticky top-0 bg-[#0a0a0a] flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
                  <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">Notifications</span>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={handleMarkAllRead}
                      className="font-mono text-[9px] text-primary/60 hover:text-primary uppercase tracking-widest cursor-pointer"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="px-4 py-6 text-center">
                    <p className="font-mono text-[10px] text-text-muted/50">No notifications</p>
                  </div>
                ) : (
                  notifications.slice(0, 20).map(notification => (
                    <button
                      type="button"
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className={`w-full text-left px-4 py-3 border-b border-[#1a1a1a] cursor-pointer hover:bg-[#111] transition-colors ${
                        !notification.read ? 'bg-primary/5' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={`font-mono text-[10px] ${!notification.read ? 'text-white' : 'text-text-muted'}`}>
                          {notification.title}
                        </span>
                        {!notification.read && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                        )}
                      </div>
                      <span className="font-mono text-[9px] text-text-muted/60 mt-1 line-clamp-2 block">
                        {notification.message}
                      </span>
                      <span className="font-mono text-[8px] text-text-muted/40 mt-1 block">
                        {new Date(notification.created_at).toLocaleString()}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
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
          UPGRADE PLAN
        </button>
      </div>
    )}
    {showModal && <PlanModal onClose={() => setShowModal(false)} />}
    </>
  );
}
