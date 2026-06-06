import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../api/client';

export default function Login() {
  const [searchParams] = useSearchParams();
  const planParam = searchParams.get('plan');
  const tabParam = searchParams.get('tab');
  const selectedPlan = ['starter', 'professional', 'enterprise'].includes(planParam) ? planParam : null;
  const [activeTab, setActiveTab] = useState(
    tabParam === 'register' || planParam ? 'create' : 'signin'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  
  const navigate = useNavigate();

  const handleAuth = async (e) => {
    e.preventDefault();
    if (activeTab === 'create' && password !== confirmPassword) return;
    setIsLoading(true);
    setAuthError('');

    try {
      if (activeTab === 'create') {
        await api.post('/auth/register', { name, email, password });
      }

      const res = await api.post('/auth/login', { email, password });
      const authUser = {
        ...res.data.user,
        plan: res.data.user?.plan || 'trial',
        trial_ends_at: res.data.user?.trial_ends_at ?? null,
        onboardingCompleted: res.data.onboardingCompleted,
      };

      useAuthStore.getState().setAuth(authUser, res.data.accessToken, res.data.refreshToken);

      if (activeTab === 'create' && selectedPlan && selectedPlan !== 'starter') {
        try {
          const checkoutRes = await api.post('/billing/checkout', { plan: selectedPlan });
          if (checkoutRes.data?.checkoutUrl) {
            window.location.href = checkoutRes.data.checkoutUrl;
            return;
          }
        } catch (checkoutError) {
          console.error('Checkout redirect failed:', checkoutError);
        }
      }

      const setupPath = await getSelfHostedSetupPath(res.data.onboardingCompleted);
      if (setupPath) {
        navigate(setupPath);
        return;
      }

      navigate(res.data.onboardingCompleted ? '/agents' : '/onboarding');
    } catch (error) {
      if (!error.response) {
        setAuthError('Unable to connect. Is the server running?');
      } else if (activeTab === 'signin' && error.response.status === 401) {
        setAuthError('Invalid email or password');
      } else if (activeTab === 'create' && error.response.status === 409) {
        setAuthError('An account with this email already exists');
      } else if (activeTab === 'create' && error.response.status === 400) {
        setAuthError(error.response.data?.details || error.response.data?.message || error.response.data?.error || 'Validation error');
      } else {
        setAuthError(error.response.data?.message || error.response.data?.error || 'AUTHENTICATION FAILED');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const getSelfHostedSetupPath = async (onboardingCompleted) => {
    const isSelfHosted = import.meta.env.VITE_SELF_HOSTED === 'true';
    const setupComplete = localStorage.getItem('eudora-setup-complete') === 'true';
    if (!isSelfHosted || setupComplete) return null;

    try {
      const res = await api.get('/api-keys');
      if ((res.data || []).length === 0) return '/setup';
    } catch {
      // If setup detection fails, keep the normal login path.
    }

    return onboardingCompleted ? '/agents' : '/onboarding';
  };

  const handleForgotPassword = async () => {
    setIsLoading(true);
    setAuthError('');
    try {
      await api.post('/auth/forgot-password', { email });
    } catch {
      // Always show the same response to avoid exposing registered emails.
    } finally {
      setForgotSent(true);
      setIsLoading(false);
    }
  };

  const getPasswordStrength = () => {
    if (!password) return 0;
    if (password.length < 8) return 1;
    if (password.match(/[a-z]/) && password.match(/[A-Z]/) && password.match(/[0-9]/)) return 3;
    return 2;
  };

  const strength = getPasswordStrength();
  const pwdMatchError = activeTab === 'create' && confirmPassword && password !== confirmPassword;

  return (
    <div className="flex flex-col min-h-screen text-white font-sans overflow-x-hidden bg-[#050505] relative z-0">
      {/* Background Decorators */}
      <div className="fixed inset-0 pointer-events-none z-[-1]" style={{backgroundImage: 'radial-gradient(circle at 10% 20%, rgba(16, 185, 129, 0.03) 0%, transparent 40%), radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.03) 0%, transparent 40%)'}}></div>
      <div className="fixed inset-0 pointer-events-none z-[-1] opacity-[0.02]" style={{backgroundImage: 'linear-gradient(#10b981 1px, transparent 1px), linear-gradient(90deg, #10b981 1px, transparent 1px)', backgroundSize: '40px 40px'}}></div>

      {/* Header Anchor */}
      <header className="flex justify-between items-center px-12 w-full fixed top-0 z-50 py-6 bg-transparent">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 flex items-center justify-center bg-primary">
            <span className="material-symbols-outlined text-[#050505] text-[20px] font-bold">shield</span>
          </div>
          <span className="font-mono text-[20px] font-bold tracking-tight text-primary uppercase">EUDORA</span>
        </div>
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[#1b1c1c] border border-primary/20">
            <span className="w-2 h-2 bg-primary pulse-dot"></span>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-primary">System Vigilant</span>
          </div>
          <div className="hidden md:flex flex-col items-end border-l border-[#1a1a1a] pl-6">
            <span className="font-mono text-[9px] text-[#A3A3A3]/50 uppercase tracking-[0.2em] mb-0.5">Node Region</span>
            <span className="font-mono text-[12px] text-[#A3A3A3] font-bold uppercase tracking-tight">EU-WEST-01 // PROTOCOL V.4</span>
          </div>
        </div>
      </header>

      {/* Main Canvas */}
      <main className="flex-grow flex items-center justify-center px-12 py-32 z-10">
        <div className="w-full max-w-[480px]">
          <div className="bg-[rgba(10,10,10,0.85)] backdrop-blur-[12px] border border-[rgba(255,255,255,0.05)] p-8 relative overflow-hidden group">
            {/* Corner Accents */}
            <div className="absolute top-0 left-0 w-8 h-8 border-t border-l border-primary/40"></div>
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b border-r border-primary/40"></div>
            
            <div className="mb-8 text-center mt-2">
              <h1 className="font-mono text-[40px] leading-none text-white mb-2 uppercase tracking-tight font-bold">Access Control</h1>
              <p className="font-mono text-[10px] text-[#A3A3A3] uppercase tracking-[0.2em]">Secure Session Initialization Required</p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-[#262626] mb-8">
              <button 
                onClick={() => setActiveTab('signin')}
                className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'signin' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}
              >
                SIGN IN
              </button>
              <button 
                onClick={() => setActiveTab('create')}
                className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'create' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}
              >
                CREATE ACCOUNT
              </button>
            </div>

            {activeTab === 'forgot' ? (
              <div className="space-y-4">
                <p className="font-mono text-[11px] text-text-muted">
                  Enter your email and we'll send you a reset link.
                </p>
                <div className="space-y-1">
                  <label className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                    Email address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[13px] px-4 py-3 focus:outline-none focus:border-primary"
                    placeholder="your@email.com"
                  />
                </div>

                {forgotSent ? (
                  <div className="border border-primary/30 bg-primary/5 p-4">
                    <p className="font-mono text-[11px] text-primary">
                      If that email exists, a reset link has been sent. Check your inbox.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={isLoading || !email}
                    className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isLoading ? 'Sending...' : 'Send Reset Link'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => { setActiveTab('signin'); setForgotSent(false); }}
                  className="w-full font-mono text-[10px] text-text-muted hover:text-primary uppercase tracking-widest cursor-pointer transition-colors"
                >
                  ← Back to login
                </button>
              </div>
            ) : (
            <form className="space-y-6" onSubmit={handleAuth}>
              {activeTab === 'create' && (
                <div className="space-y-2">
                  <label className="font-mono text-[10px] text-[#A3A3A3] uppercase tracking-[0.15em] block">Full Name</label>
                  <div className="relative group/input">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#A3A3A3]/40 group-focus-within/input:text-primary transition-colors">badge</span>
                    <input 
                      required
                      value={name}
                      onChange={e => setName(e.target.value)}
                      className="w-full bg-[#050505] border border-[#262626] text-white px-12 py-4 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px] placeholder:text-[#A3A3A3]/30" 
                      placeholder="Alexander Vance" type="text"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="font-mono text-[10px] text-[#A3A3A3] uppercase tracking-[0.15em] block">Work Email</label>
                <div className="relative group/input">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#A3A3A3]/40 group-focus-within/input:text-primary transition-colors">alternate_email</span>
                  <input 
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full bg-[#050505] border border-[#262626] text-white px-12 py-4 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px] placeholder:text-[#A3A3A3]/30" 
                    placeholder="name@enterprise.com" type="email"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-end">
                  <label className="font-mono text-[10px] text-[#A3A3A3] uppercase tracking-[0.15em] block">Secure Password</label>
                  {activeTab === 'signin' && (
                    <span className="font-mono text-[10px] text-primary uppercase tracking-tight">Secure Access</span>
                  )}
                </div>
                <div className="relative group/input flex flex-col gap-2">
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#A3A3A3]/40 group-focus-within/input:text-primary transition-colors">shield_lock</span>
                    <input 
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className="w-full bg-[#050505] border border-[#262626] text-white px-12 py-4 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px] placeholder:text-[#A3A3A3]/30" 
                      placeholder="••••••••••••" type="password"
                    />
                  </div>
                  {activeTab === 'create' && password.length > 0 && (
                    <div className="flex gap-1 h-1 w-full px-1">
                      <div className={`h-full flex-1 ${strength >= 1 ? (strength === 1 ? 'bg-danger' : 'bg-primary') : 'bg-[#262626]'}`}></div>
                      <div className={`h-full flex-1 ${strength >= 2 ? (strength <= 2 ? 'bg-warning' : 'bg-primary') : 'bg-[#262626]'}`}></div>
                      <div className={`h-full flex-1 ${strength >= 3 ? 'bg-primary' : 'bg-[#262626]'}`}></div>
                    </div>
                  )}
                </div>
              </div>

              {activeTab === 'signin' && (
                <div className="text-right -mt-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('forgot')}
                    className="font-mono text-[10px] text-text-muted hover:text-primary transition-colors uppercase tracking-widest cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {activeTab === 'create' && (
                <div className="space-y-2">
                  <label className="font-mono text-[10px] text-[#A3A3A3] uppercase tracking-[0.15em] block">Confirm Password</label>
                  <div className="relative group/input">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#A3A3A3]/40 group-focus-within/input:text-primary transition-colors">verified_user</span>
                    <input 
                      required
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      className={`w-full bg-[#050505] border ${pwdMatchError ? 'border-danger focus:border-danger focus:ring-danger/20' : 'border-[#262626] focus:border-primary focus:ring-primary/20'} text-white px-12 py-4 focus:outline-none focus:ring-1 transition-all font-mono text-[13px] placeholder:text-[#A3A3A3]/30`}
                      placeholder="••••••••••••" type="password"
                    />
                  </div>
                  {pwdMatchError && <p className="text-danger font-mono text-[10px] mt-1">PASSWORDS DO NOT MATCH</p>}
                </div>
              )}

              {authError && <p className="text-danger font-mono text-[10px] uppercase tracking-[0.15em]">{authError}</p>}

              <div className="pt-4">
                <button 
                  type="submit"
                  disabled={isLoading}
                  className="primary-btn relative w-full bg-primary text-[#050505] py-4 px-6 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer"
                >
                  <span className="relative z-10">{isLoading ? 'ESTABLISHING SECURE LINK...' : (activeTab === 'signin' ? 'Initialize Secure Session' : 'INITIALIZE ACCOUNT')}</span>
                  <div className="scan-line"></div>
                </button>
              </div>

              {activeTab === 'signin' && (
                <>
                  <div className="pt-6 flex items-center gap-4 text-[#A3A3A3]/20">
                    <div className="h-px bg-[#262626] flex-grow"></div>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-[#A3A3A3]/50">Identity Verification</span>
                    <div className="h-px bg-[#262626] flex-grow"></div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <button type="button" className="flex items-center justify-center gap-3 bg-[#050505] border border-[#262626] py-3 px-4 hover:bg-[#141414] hover:border-primary/50 transition-colors group cursor-pointer">
                      <span className="material-symbols-outlined text-[#A3A3A3]/60 group-hover:text-primary transition-colors text-[20px]">fingerprint</span>
                      <span className="font-mono text-[10px] uppercase tracking-tight font-bold">Biometric</span>
                    </button>
                    <button type="button" className="flex items-center justify-center gap-3 bg-[#050505] border border-[#262626] py-3 px-4 hover:bg-[#141414] hover:border-primary/50 transition-colors group cursor-pointer">
                      <span className="material-symbols-outlined text-[#A3A3A3]/60 group-hover:text-primary transition-colors text-[20px]">key_visualizer</span>
                      <span className="font-mono text-[10px] uppercase tracking-tight font-bold">SSO Portal</span>
                    </button>
                  </div>
                </>
              )}
            </form>
            )}
          </div>
          <p className="mt-8 text-center font-mono text-[10px] text-[#A3A3A3]/40 uppercase tracking-[0.2em]">
            Protected by Eudora Sentinel AI Protocol
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full px-12 py-8 border-t border-[#262626]/50 flex flex-col md:flex-row justify-between items-center gap-6 bg-[#0a0a0a]/30">
        <div className="flex items-center gap-8">
          <div className="flex flex-col">
            <span className="font-mono text-[9px] text-[#A3A3A3]/40 uppercase tracking-[0.2em] mb-2">Compliance Standard</span>
            <div className="flex gap-4">
              <span className="font-mono text-[11px] text-primary font-bold border-r border-[#262626] pr-4 tracking-widest">SOC2 TYPE II</span>
              <span className="font-mono text-[11px] text-primary font-bold border-r border-[#262626] pr-4 tracking-widest">GDPR READY</span>
              <span className="font-mono text-[11px] text-primary font-bold tracking-widest">ISO 27001</span>
            </div>
          </div>
        </div>
        <div className="flex gap-8 items-center">
          <button className="font-mono text-[11px] text-[#A3A3A3]/60 hover:text-primary transition-colors uppercase tracking-widest cursor-pointer">Privacy Architecture</button>
          <button className="font-mono text-[11px] text-[#A3A3A3]/60 hover:text-primary transition-colors uppercase tracking-widest cursor-pointer">Global Support</button>
          <div className="flex items-center gap-2 text-[#A3A3A3]/40 border-l border-[#262626] pl-8">
            <span className="material-symbols-outlined text-[18px]">language</span>
            <span className="font-mono text-[11px] uppercase tracking-widest font-bold">EN-US</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
