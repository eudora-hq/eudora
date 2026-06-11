import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../api/client';
import { PlanModal } from '../components/PlanModal';
import { useSelfHosted } from '../hooks/useSelfHosted';

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'tunnel', 'custom'];
const METRIC_LABELS = {
  agents: 'Agents',
  cron_jobs: 'Cron jobs',
  context_files: 'Context files',
  workflows: 'Workflows',
};

export default function Settings() {
  const navigate = useNavigate();
  const isSelfHosted = useSelfHosted();
  const { user, accessToken, refreshToken, setAuth, plan, trialDaysLeft } = useAuthStore();
  const [keys, setKeys] = useState([]);
  const [usage, setUsage] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [provider, setProvider] = useState('openai');
  const [label, setLabel] = useState('Primary model');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [ollamaModels, setOllamaModels] = useState([]);
  const [availableTunnels, setAvailableTunnels] = useState([]);
  const [selectedTunnelId, setSelectedTunnelId] = useState('');
  const [statuses, setStatuses] = useState({});
  const [profileName, setProfileName] = useState(user?.name || user?.email || '');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [profileMessage, setProfileMessage] = useState('');
  const [billingError, setBillingError] = useState('');
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [mfaStatus, setMfaStatus] = useState({ enabled: false, pending: false });
  const [mfaSetup, setMfaSetup] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaMessage, setMfaMessage] = useState('');
  const [showDisableMfa, setShowDisableMfa] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [keysRes, usageRes, mfaRes, tunnelsRes] = await Promise.all([
        api.get('/api-keys'),
        api.get('/billing/usage').catch(() => ({ data: placeholderUsage(plan) })),
        api.get('/auth/mfa/status').catch(() => ({ data: { enabled: false, pending: false } })),
        api.get('/v1/tunnels').catch(() => ({ data: { tunnels: [] } })),
      ]);
      setKeys(keysRes.data);
      setUsage(usageRes.data);
      setMfaStatus(mfaRes.data);
      setAvailableTunnels(tunnelsRes.data.tunnels || []);
    } catch {
      setKeys([]);
      setBillingError('Unable to load settings');
    }
  };

  const needsBaseUrl = provider === 'ollama' || provider === 'custom';
  const optionalKey = needsBaseUrl || provider === 'tunnel';

  const showStatus = (id, status) => {
    setStatuses(prev => ({ ...prev, [id]: status }));
    setTimeout(() => {
      setStatuses(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 3000);
  };

  const testKey = async (key) => {
    setStatuses(prev => ({ ...prev, [key.id]: { type: 'loading', text: 'Testing...' } }));
    try {
      const res = await api.post('/api-keys/test', { id: key.id });
      if (!res.data.success) throw new Error(res.data.error || 'Connection failed');
      showStatus(key.id, { type: 'success', text: `PING: ${res.data.latencyMs}MS — VERIFIED` });
    } catch (err) {
      showStatus(key.id, { type: 'error', text: err.response?.data?.error || err.message || 'Connection failed' });
    }
  };

  const deleteKey = async (key) => {
    if (!window.confirm(`Remove ${key.label}? Agents using this key will stop working.`)) return;
    try {
      await api.delete(`/api-keys/${key.id}`);
      setKeys(prev => prev.filter(item => item.id !== key.id));
    } catch (err) {
      showStatus(key.id, { type: 'error', text: err.response?.data?.error || 'Delete failed' });
    }
  };

  const addConnection = async (testOnly = false) => {
    const payload = {
      provider,
      label,
      ...(needsBaseUrl ? { base_url: baseUrl } : {}),
      ...(provider === 'tunnel' ? { tunnel_id: selectedTunnelId } : {}),
      ...((!optionalKey || apiKey.trim()) ? { key: apiKey } : {}),
      default_model: defaultModel.trim() || null,
    };

    try {
      const res = await api.post('/api-keys', payload);
      if (testOnly) {
        const testRes = await api.post('/api-keys/test', { id: res.data.id });
        if (provider === 'ollama' && testRes.data.success) {
          const models = await fetchOllamaModels(baseUrl);
          if (models.length) setOllamaModels(models);
        }
        await api.delete(`/api-keys/${res.data.id}`);
        if (!testRes.data.success) throw new Error(testRes.data.error || 'Connection failed');
        showStatus('new', { type: 'success', text: `PING: ${testRes.data.latencyMs}MS — VERIFIED` });
        return;
      }
      setKeys(prev => [res.data, ...prev]);
      resetAddForm();
    } catch (err) {
      showStatus('new', { type: 'error', text: err.response?.data?.error || err.message || 'Save failed' });
    }
  };

  const resetAddForm = () => {
    setShowAdd(false);
    setProvider('openai');
    setLabel('Primary model');
    setApiKey('');
    setBaseUrl('');
    setDefaultModel('');
    setOllamaModels([]);
    setSelectedTunnelId('');
  };

  const saveProfile = async () => {
    setProfileMessage('');
    try {
      await api.patch('/users/me', { name: profileName });
      setAuth({ ...user, name: profileName }, accessToken, refreshToken);
      setProfileMessage('PROFILE UPDATED');
    } catch (err) {
      setProfileMessage(err.response?.data?.error || 'PROFILE UPDATE FAILED');
    }
  };

  const changePassword = async () => {
    setProfileMessage('');
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setProfileMessage('PASSWORDS DO NOT MATCH');
      return;
    }
    try {
      await api.post('/auth/change-password', {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      setProfileMessage('PASSWORD UPDATED');
    } catch (err) {
      setProfileMessage(err.response?.status === 404 ? 'Coming soon' : err.response?.data?.error || 'PASSWORD UPDATE FAILED');
    }
  };

  const beginMfaSetup = async () => {
    setMfaLoading(true);
    setMfaMessage('');
    setMfaCode('');
    try {
      const res = await api.post('/auth/mfa/setup');
      setMfaSetup(res.data);
      setMfaStatus({ enabled: false, pending: true });
    } catch (err) {
      setMfaMessage(err.response?.data?.message || 'MFA SETUP FAILED');
    } finally {
      setMfaLoading(false);
    }
  };

  const verifyMfa = async () => {
    setMfaLoading(true);
    setMfaMessage('');
    try {
      await api.post('/auth/mfa/verify', { code: mfaCode });
      setMfaStatus({ enabled: true, pending: false });
      setMfaSetup(null);
      setMfaCode('');
      setMfaMessage('MFA ENABLED');
    } catch (err) {
      setMfaMessage(err.response?.data?.message || 'INVALID VERIFICATION CODE');
    } finally {
      setMfaLoading(false);
    }
  };

  const disableMfa = async () => {
    setMfaLoading(true);
    setMfaMessage('');
    try {
      await api.post('/auth/mfa/disable', { code: mfaCode });
      setMfaStatus({ enabled: false, pending: false });
      setMfaCode('');
      setShowDisableMfa(false);
      setMfaMessage('MFA DISABLED');
    } catch (err) {
      setMfaMessage(err.response?.data?.message || 'INVALID AUTHENTICATION CODE');
    } finally {
      setMfaLoading(false);
    }
  };

  const activePlan = usage?.plan || plan;
  const showUpgradeButton = activePlan === 'trial' && !isSelfHosted;
  const showManageButton = ['starter', 'professional', 'enterprise'].includes(activePlan) && !isSelfHosted;
  const showSelfHostedButton = isSelfHosted;

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2">
        <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">SETTINGS</h1>
        <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">SECURE NODE CONFIGURATION</p>
      </div>

      <section className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[20px]">vpn_key</span>
            <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">API CONNECTIONS</h2>
          </div>
          <button onClick={() => setShowAdd(true)} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-2 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer">ADD CONNECTION</button>
        </div>

        <div className="space-y-3">
          {keys.length === 0 ? (
            <div className="border border-[#262626] bg-[#050505] p-6 text-center">
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">NO API CONNECTIONS</span>
            </div>
          ) : keys.map(key => (
            <div key={key.id} className="border border-[#262626] bg-[#050505] p-4 flex items-center gap-4">
              <span className="material-symbols-outlined text-primary text-[20px]">vpn_key</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[12px] text-white uppercase tracking-widest">{key.label}</span>
                  <span className="border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary uppercase">{key.provider}</span>
                  {(key.provider === 'ollama' || key.provider === 'custom') && !key.has_key && <span className="font-mono text-[9px] text-text-muted uppercase">(No auth)</span>}
                </div>
                {key.base_url && <p className="font-mono text-[10px] text-text-muted truncate mt-1">{key.base_url}</p>}
                {key.tunnel_id && <p className="font-mono text-[9px] text-text-muted truncate mt-1">TUNNEL: {key.tunnel_id}</p>}
                {key.default_model && <p className="font-mono text-[9px] text-primary/70 uppercase tracking-widest mt-1">MODEL: {key.default_model}</p>}
                {statuses[key.id] && (
                  <p className={`font-mono text-[10px] uppercase tracking-widest mt-2 ${statuses[key.id].type === 'success' ? 'text-primary' : statuses[key.id].type === 'error' ? 'text-danger' : 'text-warning'}`}>
                    {statuses[key.id].type === 'success' ? '✅ ' : statuses[key.id].type === 'error' ? '❌ ' : ''}{statuses[key.id].text}
                  </p>
                )}
              </div>
              <button onClick={() => testKey(key)} className="border border-[#262626] text-text-muted hover:border-primary hover:text-white px-4 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer">
                {statuses[key.id]?.type === 'loading' ? 'Testing...' : 'Test'}
              </button>
              <button onClick={() => deleteKey(key)} className="text-text-muted hover:text-danger transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          ))}
        </div>

        {showAdd && (
          <div className="mt-8 border border-[#262626] bg-[#050505] p-6 space-y-6 fade-in">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {PROVIDERS.map(item => (
                <button key={item} onClick={() => { setProvider(item); setBaseUrl(item === 'ollama' ? 'http://localhost:11434' : ''); setDefaultModel(''); setOllamaModels([]); setSelectedTunnelId(''); }} className={`border flex flex-col items-center justify-center p-4 gap-3 transition-colors ${provider === item ? 'border-primary bg-primary/10 text-primary' : 'border-[#262626] bg-[#0a0a0a] text-text-muted hover:border-text-muted'}`}>
                  <span className="material-symbols-outlined text-[24px]">vpn_key</span>
                  <span className="font-mono text-[10px] uppercase font-bold tracking-widest">{item}</span>
                </button>
              ))}
            </div>
            <FormField label="Label" value={label} onChange={setLabel} />
            {needsBaseUrl && <FormField label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://model-gateway.example.com'} />}
            {provider === 'tunnel' && (
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">Tunnel</label>
                <select
                  value={selectedTunnelId}
                  onChange={(event) => setSelectedTunnelId(event.target.value)}
                  className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary"
                >
                  <option value="">SELECT A TUNNEL</option>
                  {availableTunnels.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name} — {item.status}
                    </option>
                  ))}
                </select>
                {availableTunnels.length === 0 && (
                  <button
                    onClick={() => navigate('/tunnels')}
                    className="font-mono text-[9px] text-primary uppercase tracking-widest cursor-pointer"
                  >
                    Create a tunnel first
                  </button>
                )}
              </div>
            )}
            <ModelField
              provider={provider}
              value={defaultModel}
              onChange={setDefaultModel}
              options={provider === 'ollama' ? ollamaModels : []}
              label="DEFAULT_MODEL"
              helper="Used by all agents on this connection unless overridden per-agent"
            />
            {provider !== 'tunnel' && (
              <FormField label={optionalKey ? 'API Key (optional)' : 'API Key'} value={apiKey} onChange={setApiKey} type="password" placeholder="sk-..." />
            )}
            {statuses.new && (
              <p className={`font-mono text-[10px] uppercase tracking-widest ${statuses.new.type === 'success' ? 'text-primary' : 'text-danger'}`}>{statuses.new.type === 'success' ? '✅ ' : '❌ '}{statuses.new.text}</p>
            )}
            <div className="flex items-center justify-end gap-4">
              <button onClick={resetAddForm} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Cancel</button>
              <button onClick={() => addConnection(true)} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-2 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer">TEST CONNECTION</button>
              <button onClick={() => addConnection(false)} className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
                <span className="relative z-10">SAVE CONNECTION</span>
                <div className="scan-line"></div>
              </button>
            </div>
          </div>
        )}
      </section>

      {isSelfHosted && (
        <section className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
          <div className="flex items-start justify-between gap-6">
            <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-primary text-[20px]">cable</span>
            <div>
              <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">Use With Cloud Eudora</h2>
              <p className="font-mono text-[9px] text-text-muted mt-1">
                Expose this Ollama instance through an authenticated FRP tunnel.
              </p>
            </div>
            </div>
            <button
              onClick={() => navigate('/tunnels')}
              className="border border-primary/40 text-primary hover:bg-primary/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors whitespace-nowrap"
            >
              Manage Tunnels
            </button>
          </div>
        </section>
      )}

      <section className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[20px]">security</span>
            <div>
              <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">Two-Factor Authentication</h2>
              <p className="font-mono text-[9px] text-text-muted mt-1">TOTP compatible with Google Authenticator, Authy, and 1Password.</p>
            </div>
          </div>
          {mfaStatus.enabled && (
            <span className="border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[9px] text-primary uppercase font-bold tracking-widest">
              MFA Active
            </span>
          )}
        </div>

        {!mfaStatus.enabled && !mfaSetup && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border border-[#262626] bg-[#050505] p-4">
            <p className="font-mono text-[10px] text-text-muted">Require a rotating 6-digit code when signing in.</p>
            <button
              onClick={beginMfaSetup}
              disabled={mfaLoading}
              className="border border-primary/40 text-primary hover:bg-primary/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer disabled:opacity-50 transition-colors"
            >
              {mfaLoading ? 'Preparing...' : 'Enable MFA'}
            </button>
          </div>
        )}

        {mfaSetup && !mfaStatus.enabled && (
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 border border-[#262626] bg-[#050505] p-5">
            <div className="bg-white p-3 w-fit">
              <img src={mfaSetup.qrDataUrl} alt="Eudora MFA QR code" className="w-44 h-44" />
            </div>
            <div className="space-y-4 min-w-0">
              <div>
                <p className="font-mono text-[10px] text-white uppercase tracking-widest">1. Scan the QR code</p>
                <p className="font-mono text-[9px] text-text-muted mt-1">Open your authenticator app and add a new account.</p>
              </div>
              <div>
                <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest">Manual setup key</p>
                <code className="font-mono text-[10px] text-primary break-all block mt-1 border border-[#262626] p-3">{mfaSetup.secret}</code>
              </div>
              <div className="space-y-2">
                <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">2. Verify 6-digit code</label>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="flex-1 bg-[#0a0a0a] border border-[#262626] text-white px-4 py-3 font-mono text-[14px] tracking-[0.3em] focus:outline-none focus:border-primary"
                    placeholder="000000"
                  />
                  <button
                    onClick={verifyMfa}
                    disabled={mfaLoading || mfaCode.length !== 6}
                    className="bg-primary text-[#050505] px-6 py-3 font-mono text-[10px] font-bold uppercase tracking-widest cursor-pointer disabled:opacity-50 hover:bg-primary/90 transition-colors"
                  >
                    {mfaLoading ? 'Verifying...' : 'Verify & Enable'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {mfaStatus.enabled && (
          <div className="border border-[#262626] bg-[#050505] p-4">
            {!showDisableMfa ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <p className="font-mono text-[10px] text-text-muted">Your account requires an authenticator code at login.</p>
                <button
                  onClick={() => { setShowDisableMfa(true); setMfaCode(''); setMfaMessage(''); }}
                  className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors"
                >
                  Disable MFA
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-text-muted">Enter your current authenticator code to disable MFA.</p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="flex-1 bg-[#0a0a0a] border border-[#262626] text-white px-4 py-3 font-mono text-[14px] tracking-[0.3em] focus:outline-none focus:border-primary"
                    placeholder="000000"
                  />
                  <button
                    onClick={disableMfa}
                    disabled={mfaLoading || mfaCode.length !== 6}
                    className="border border-red-500/30 text-red-400 hover:bg-red-500/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer disabled:opacity-50 transition-colors"
                  >
                    {mfaLoading ? 'Disabling...' : 'Confirm Disable'}
                  </button>
                  <button
                    onClick={() => { setShowDisableMfa(false); setMfaCode(''); }}
                    className="border border-[#262626] text-text-muted hover:text-white px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {mfaMessage && (
          <p className={`font-mono text-[10px] uppercase tracking-widest mt-4 ${mfaMessage.includes('ENABLED') ? 'text-primary' : 'text-warning'}`}>
            {mfaMessage}
          </p>
        )}
      </section>

      <section className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="material-symbols-outlined text-primary text-[20px]">badge</span>
          <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">USER IDENTITY</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <FormField label="Name" value={profileName} onChange={setProfileName} />
          <div className="space-y-2">
            <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">Email</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-text-muted text-[18px]" title="Cannot be changed">lock</span>
              <input readOnly value={user?.email || ''} className="w-full bg-[#050505] border border-[#262626] text-text-muted px-4 py-3 font-mono text-[13px]" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-6">
          {profileMessage && <span className="font-mono text-[10px] text-primary uppercase tracking-widest">{profileMessage}</span>}
          <button onClick={saveProfile} className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer ml-auto">
            <span className="relative z-10">SAVE PROFILE</span>
            <div className="scan-line"></div>
          </button>
        </div>
        <button onClick={() => setShowPassword(!showPassword)} className="mt-6 font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">CHANGE PASSWORD</button>
        {showPassword && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6 fade-in">
            <FormField label="Current password" value={passwordForm.currentPassword} onChange={(value) => setPasswordForm(form => ({ ...form, currentPassword: value }))} type="password" />
            <FormField label="New password" value={passwordForm.newPassword} onChange={(value) => setPasswordForm(form => ({ ...form, newPassword: value }))} type="password" />
            <FormField label="Confirm new password" value={passwordForm.confirmPassword} onChange={(value) => setPasswordForm(form => ({ ...form, confirmPassword: value }))} type="password" />
            <button onClick={changePassword} className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer md:col-span-3">
              <span className="relative z-10">SAVE PASSWORD</span>
              <div className="scan-line"></div>
            </button>
          </div>
        )}
      </section>

      <section className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-[20px]">credit_card</span>
            <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">PLAN & BILLING</h2>
          </div>
          {showUpgradeButton && (
            <button onClick={() => setShowPlanModal(true)} className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
              <span className="relative z-10">UPGRADE PLAN</span>
              <div className="scan-line"></div>
            </button>
          )}
          {showManageButton && (
            <button onClick={() => navigate('/subscription')} className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
              <span className="relative z-10">MANAGE SUBSCRIPTION</span>
              <div className="scan-line"></div>
            </button>
          )}
          {showSelfHostedButton && (
            <button onClick={() => setShowPlanModal(true)} className="border border-primary/30 text-primary font-mono text-[10px] uppercase tracking-widest px-4 py-2 hover:border-primary transition-colors cursor-pointer">
              SELF-HOSTED
            </button>
          )}
        </div>
        <div className="flex items-center gap-4 mb-6">
          <span className="border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[10px] text-primary uppercase font-bold tracking-widest">{activePlan}</span>
          {activePlan === 'trial' && <span className="font-mono text-[10px] text-warning uppercase tracking-widest">TRIAL — {trialDaysLeft} DAYS REMAINING</span>}
        </div>
        {billingError && <p className="font-mono text-[10px] text-danger uppercase tracking-widest mb-4">{billingError}</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Object.entries(usage?.metrics || placeholderUsage(plan).metrics)
            .filter(([key]) => key !== 'messages_today')
            .map(([key, metric]) => (
              <UsageBar key={key} label={METRIC_LABELS[key] || key} used={metric.used} limit={metric.limit} />
            ))}
        </div>
      </section>

      {showPlanModal && <PlanModal onClose={() => setShowPlanModal(false)} />}
    </div>
  );
}

function FormField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <div className="space-y-2">
      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
    </div>
  );
}

function ModelField({ provider, value, onChange, options = [], label, helper }) {
  const placeholders = {
    ollama: 'qwen2.5:14b',
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
    gemini: 'gemini-2.0-flash',
    custom: 'deployment-name',
    tunnel: 'qwen2.5:14b',
    azure: 'deployment-name',
  };
  return (
    <div className="space-y-2">
      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">{label}</label>
      {options.length ? (
        <select value={value} onChange={(event) => onChange(event.target.value)}
          className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary">
          <option value="">NO DEFAULT MODEL</option>
          {options.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)}
          placeholder={placeholders[provider] || 'deployment-name'}
          className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
      )}
      <p className="font-mono text-[9px] text-text-muted">{helper}</p>
    </div>
  );
}

async function fetchOllamaModels(baseUrl) {
  if (!baseUrl) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(model => model.name).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function UsageBar({ label, used, limit }) {
  const finite = Number.isFinite(limit);
  const pct = finite ? Math.min(100, Math.round((used / Math.max(limit, 1)) * 100)) : 8;
  return (
    <div className="border border-[#262626] bg-[#050505] p-4">
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-widest mb-3">
        <span className="text-primary">{label}</span>
        <span className="text-text-muted">{used} / {finite ? limit : '∞'}</span>
      </div>
      <div className="h-1 bg-[#262626]">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }}></div>
      </div>
    </div>
  );
}

function placeholderUsage(plan) {
  return {
    plan,
    trial_ends_at: null,
    metrics: {
      agents: { used: 0, limit: Infinity },
      cron_jobs: { used: 0, limit: 3 },
      context_files: { used: 0, limit: 50 },
      workflows: { used: 0, limit: 0 },
    },
  };
}
