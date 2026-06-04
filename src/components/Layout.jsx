import Header from './Header';
import Sidebar from './Sidebar';
import FloatingStatus from './FloatingStatus';
import { Outlet, useLocation } from 'react-router-dom';
import { useTierLimits } from '../hooks/useTierLimits';

export default function Layout() {
  const location = useLocation();
  const { usage } = useTierLimits();
  const hasTrialBanner = usage?.plan === 'trial' && usage?.trial_ends_at;

  // Chat page overrides standard padding
  const isChat = location.pathname.startsWith('/chat');

  return (
    <div className="dark">
      <Header />
      <Sidebar />
      <main className={`ml-[256px] ${hasTrialBanner ? 'pt-[96px]' : 'pt-[64px]'} min-h-screen terminal-grid bg-bg overflow-y-auto ${!isChat ? 'pb-12' : ''}`}>
        {isChat ? (
          <div className={hasTrialBanner ? 'h-[calc(100vh-96px)]' : 'h-[calc(100vh-64px)]'}>
             <Outlet />
          </div>
        ) : (
          <div className="p-8 max-w-[1600px] mx-auto">
            <Outlet />
          </div>
        )}
      </main>
      <FloatingStatus />
    </div>
  );
}
