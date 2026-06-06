import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useAgentStore } from '../store/agentStore';
import { useOnboardingStore } from '../store/onboardingStore';
import api from '../api/client';
import { TemplateGallery } from '../components/TemplateGallery';

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'custom'];
const PLACEHOLDERS = [
  'Help me review Python code and suggest improvements',
  'Answer questions about my internal documentation',
  'Summarise my project notes every morning',
  'Analyse CSV data and explain the trends',
];

export default function Onboarding() {
  const { user, accessToken, refreshToken, isAuthenticated, setAuth } = useAuthStore();
  const addAgent = useAgentStore(state => state.addAgent);
  const {
    currentStep,
    setStep,
    apiKeyId,
    apiKeyProvider,
    setApiKey,
    generatedAgent,
    setGeneratedAgent,
    agentId,
    setAgentId,
    setCronJobId,
    reset,
  } = useOnboardingStore();

  const navigate = useNavigate();
  const showWorkflowStep = ['professional', 'enterprise'].includes(user?.plan);

  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
    if (user?.onboardingCompleted) navigate('/agents', { replace: true });
  }, [isAuthenticated, navigate, user?.onboardingCompleted]);

  // If user came from self-hosted wizard, they already have an API key — skip step 1
  useEffect(() => {
    const wizardModel = localStorage.getItem('eudora-wizard-model');
    if (wizardModel && currentStep === 1) {
      api.get('/api-keys').then(res => {
        if (res.data && res.data.length > 0) {
          const key = res.data[0];
          setApiKey(key.id, key.provider);
          setStep(2);
        }
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (currentStep === 6 && !showWorkflowStep) completeOnboarding();
  }, [currentStep, showWorkflowStep]);

  const completeOnboarding = async (target = '/chat') => {
    await api.patch('/users/me', { onboarding_completed: true });
    setAuth({ ...user, onboardingCompleted: true }, accessToken, refreshToken);
    useOnboardingStore.getState().reset();
    navigate(target);
  };

  return (
    <div className="flex flex-col h-screen bg-[#050505] text-white overflow-hidden">
      <header className="h-[64px] border-b border-[#262626] flex items-center justify-between px-8 bg-[#050505] shrink-0">
        <div className="flex items-center gap-6">
          <span className="font-mono text-[20px] font-bold tracking-tight text-primary uppercase">EUDORA</span>
          <span className="font-mono text-[10px] tracking-[0.1em] text-text-muted uppercase border-l border-[#262626] pl-6">AGENT FORGE</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-primary rounded-full"></span>
            <span className="font-mono text-[9px] tracking-[0.2em] text-primary uppercase">SECURE LINK ACTIVE</span>
          </div>
          <span className="material-symbols-outlined text-text-muted text-[20px]">notifications</span>
          <div className="w-8 h-8 bg-[#0a0a0a] border border-[#262626] flex items-center justify-center">
             <span className="material-symbols-outlined text-text-muted text-[18px]">person</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[276px] border-r border-[#262626] bg-[#050505] flex flex-col p-8 flex-shrink-0">
          <h2 className="font-sans font-semibold text-[24px] mb-1">Setup Progress</h2>
          <p className="font-mono text-[13px] text-text-muted mb-12 uppercase tracking-tight">Onboarding AI Agent</p>

          <div className="flex flex-col gap-6 flex-1">
            <StepItem active={currentStep === 1} label="MODEL CONNECT" completed={currentStep > 1} icon="hub" />
            <StepItem active={currentStep === 2} label="AGENT PURPOSE" completed={currentStep > 2} icon="psychology" />
            <StepItem active={currentStep === 3} label="CONFIGURATION" completed={currentStep > 3} icon={currentStep < 3 ? 'shield' : 'settings'} />
            <StepItem active={currentStep === 4} label="KNOWLEDGE BASE" completed={currentStep > 4} icon={currentStep < 4 ? 'database' : 'description'} />
            <StepItem active={currentStep === 5} label="SCHEDULED RUN" completed={currentStep > 5} icon={currentStep < 5 ? 'lock_clock' : 'calendar_today'} />
            {showWorkflowStep && (
              <StepItem active={currentStep === 6} label="WORKFLOW CHAIN" completed={false} icon={currentStep < 6 ? 'account_tree' : 'hub'} />
            )}
          </div>

          <div className="mt-auto border border-primary/30 bg-primary/5 p-4 flex items-center gap-3 relative overflow-hidden group">
            <span className="material-symbols-outlined text-primary text-[18px]">lock</span>
            <div className="flex flex-col">
              <span className="font-mono text-[9px] text-primary uppercase tracking-widest">SECURITY PROTOCOL</span>
              <span className="font-mono text-[9px] text-primary uppercase tracking-widest font-bold">AES-256 ENCRYPTION ACTIVE</span>
            </div>
          </div>
        </aside>

        <main className="flex-1 terminal-grid overflow-y-auto bg-[#0a0a0a]/50 p-12">
          <div className="max-w-[800px] mx-auto">
            {currentStep === 1 && <StepOne setStep={setStep} setApiKey={setApiKey} />}
            {currentStep === 2 && <StepTwo apiKeyId={apiKeyId} setStep={setStep} setGeneratedAgent={setGeneratedAgent} />}
            {currentStep === 3 && (
              <StepThree
                apiKeyId={apiKeyId}
                apiKeyProvider={apiKeyProvider}
                generatedAgent={generatedAgent}
                setAgentId={setAgentId}
                addAgent={addAgent}
                setStep={setStep}
              />
            )}
            {currentStep === 4 && (
              <StepFour
                agentId={agentId}
                generatedAgent={generatedAgent}
                setStep={setStep}
              />
            )}
            {currentStep === 5 && (
              <StepFive
                agentId={agentId}
                completeOnboarding={completeOnboarding}
                setStep={setStep}
                showWorkflowStep={showWorkflowStep}
                setCronJobId={setCronJobId}
              />
            )}
            {currentStep === 6 && showWorkflowStep && (
              <StepSix completeOnboarding={completeOnboarding} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function StepItem({ active, label, completed, icon }) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${active ? 'bg-primary/10 border-l-2 border-primary text-primary' : (completed ? 'text-text-muted' : 'text-[#262626]')}`}>
      <span className="material-symbols-outlined text-[18px]">
        {completed ? 'check_circle' : icon}
      </span>
      <span className="font-mono text-[10px] uppercase font-bold tracking-[0.15em]">{label}</span>
    </div>
  );
}

function StepOne({ setStep, setApiKey }) {
  const [provider, setProvider] = useState('openai');
  const [label, setLabel] = useState('Primary model');
  const [apiKey, setApiKeyValue] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [savedKey, setSavedKey] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [latencyMs, setLatencyMs] = useState(null);
  const [modelName, setModelName] = useState(localStorage.getItem('eudora-wizard-model') || '');
  const needsBaseUrl = provider === 'ollama' || provider === 'custom';
  const optionalKey = needsBaseUrl;

  const resetSavedKey = () => {
    setSavedKey(null);
    setStatus(null);
    setError('');
    setLatencyMs(null);
  };

  const buildPayload = () => ({
    provider,
    label,
    ...(needsBaseUrl ? { base_url: baseUrl } : {}),
    ...(needsBaseUrl ? { model_name: modelName } : {}),
    ...((!optionalKey || apiKey.trim()) ? { key: apiKey } : {}),
  });

  const saveKey = async () => {
    if (!label.trim()) throw new Error('Label is required');
    if (!needsBaseUrl && !apiKey.trim()) throw new Error('API key is required');
    if (needsBaseUrl && !baseUrl.trim()) throw new Error('Base URL is required');

    const res = await api.post('/api-keys', buildPayload());
    return res.data;
  };

  const handleTest = async () => {
    setStatus('testing');
    setError('');
    setLatencyMs(null);

    let createdKey = null;
    try {
      createdKey = await saveKey();
      const testRes = await api.post('/api-keys/test', { id: createdKey.id });
      if (!testRes.data?.success) throw new Error(testRes.data?.error || 'Connection test failed');
      setSavedKey(createdKey);
      setLatencyMs(testRes.data.latencyMs);
      setStatus('success');
    } catch (err) {
      if (createdKey?.id) {
        try {
          await api.delete(`/api-keys/${createdKey.id}`);
        } catch {
          // Best effort cleanup only.
        }
      }
      setSavedKey(null);
      setStatus('fail');
      setError(err.response?.data?.error || err.message || 'Connection failed');
    }
  };

  const handleRegister = async () => {
    if (status === 'fail') return;
    setError('');
    try {
      const key = savedKey || await saveKey();
      setApiKey(key.id, key.provider);
      setStep(2);
    } catch (err) {
      setStatus('fail');
      setError(err.response?.data?.error || err.message || 'Unable to register provider');
    }
  };

  return (
    <div className="fade-in space-y-8">
      <div className="space-y-4">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em]">STEP 01 / CONNECTION PHASE</span>
        <h1 className="font-mono text-[32px] font-bold tracking-tight text-white uppercase">Connect your model</h1>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {PROVIDERS.map(p => (
          <button
            key={p}
            onClick={() => {
              setProvider(p);
              setBaseUrl(p === 'ollama' ? 'http://localhost:11434' : '');
              resetSavedKey();
            }}
            className={`border flex flex-col items-center justify-center p-6 gap-3 transition-colors ${provider === p ? 'border-primary bg-primary/10 text-primary' : 'border-[#262626] bg-[#0a0a0a] text-text-muted hover:border-text-muted'}`}
          >
            <span className="material-symbols-outlined text-[24px]">vpn_key</span>
            <span className="font-mono text-[10px] uppercase font-bold tracking-widest">{p}</span>
          </button>
        ))}
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] p-8 space-y-6">
        <div className="space-y-2">
          <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => { setLabel(e.target.value); resetSavedKey(); }}
            className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px]"
          />
        </div>

        {needsBaseUrl && (
  <div className="space-y-2">
    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">Model Name</label>
    <input
      type="text"
      value={modelName}
      onChange={(e) => { setModelName(e.target.value); resetSavedKey(); }}
      placeholder={provider === 'ollama' ? 'qwen2.5-coder:14b' : 'default'}
      className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px]"
    />
    <p className="font-mono text-[10px] text-text-muted">Exact model name (e.g. qwen2.5-coder:14b, llama3, mistral)</p>
  </div>
)}

        <div className="space-y-2">
          <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">{optionalKey ? 'API Key (optional)' : 'API Key'}</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKeyValue(e.target.value); resetSavedKey(); }}
            placeholder="sk-..."
            className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono text-[13px]"
          />
        </div>

        <div className="flex items-center gap-6">
          <button onClick={handleTest} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-2 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer disabled:opacity-50" disabled={status === 'testing'}>
            TEST CONNECTION
          </button>

          {status === 'success' && <span className="font-mono text-[12px] text-primary uppercase fade-in">✅ Connected · {latencyMs}ms</span>}
          {status === 'fail' && <span className="font-mono text-[12px] text-danger uppercase fade-in">❌ Failed: {error}</span>}
          {status === 'testing' && <span className="font-mono text-[12px] text-warning uppercase cursor-blink">TESTING LINK...</span>}
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button onClick={handleRegister} className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
          <span className="relative z-10">REGISTER PROVIDER →</span>
          <div className="scan-line"></div>
        </button>
      </div>
    </div>
  );
}

function StepTwo({ apiKeyId, setStep, setGeneratedAgent }) {
  const [intent, setIntent] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [error, setError] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIndex(index => (index + 1) % PLACEHOLDERS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const tokenCount = Math.floor(intent.length / 4);
  const isOverLimit = tokenCount > 4000;
  const isWarnLimit = tokenCount > 3000;

  const handleTemplateSelect = (template) => {
    setIntent(template.description);
    setGeneratedAgent({
      name: template.name.toUpperCase(),
      purpose: template.description,
      systemPrompt: template.systemPrompt,
      suggestedTags: template.tags,
    });
    setStep(3);
  };

  const handleOptimize = () => {
    if (!intent) return;
    const optimized = `[SYSTEM_ROLE: EXPERT_AI_AGENT]\n[PRIMARY_OBJECTIVE: CODE_REVIEW_AND_COMPLIANCE]\n\n${intent}\n\n[CONSTRAINTS]\n1. Prioritize secure coding standards.\n2. Output structured JSON for vulnerability findings.`;

    setIntent('');
    let i = 0;
    const interval = setInterval(() => {
      setIntent(prev => prev + optimized.charAt(i));
      i++;
      if (i === optimized.length) clearInterval(interval);
    }, 10);
  };

  const handleGenerate = async () => {
    if (!intent.trim() || !apiKeyId) return;
    setIsGenerating(true);
    setError('');
    setGenProgress(0);

    const progInt = setInterval(() => {
      setGenProgress(p => Math.min(p + 5, 95));
    }, 100);

    try {
      const res = await api.post('/onboarding/generate-agent', { intent, apiKeyId });
      setGeneratedAgent(res.data);
      setStep(3);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Unable to generate agent');
    } finally {
      clearInterval(progInt);
      setGenProgress(100);
      setIsGenerating(false);
    }
  };

  return (
    <div className="fade-in space-y-8 max-w-[1000px] w-full">
      <div className="space-y-4">
        <span className="font-mono text-[10px] text-primary uppercase tracking-[0.2em] border border-primary/30 px-2 py-1">STEP 02 / DEFINITION PHASE</span>
        <h1 className="font-sans text-[48px] font-bold tracking-tight text-white leading-none">Describe your agent</h1>
        <p className="font-sans text-[18px] text-text-muted max-w-2xl">Specify the core behavioral logic and operational parameters. Your system prompt defines the guardrails and expertise of the neural instance.</p>
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] relative overflow-hidden flex flex-col">
        {isGenerating && (
          <div className="absolute inset-0 bg-[#050505]/90 backdrop-blur z-20 flex flex-col items-center justify-center p-8">
             <span className="font-mono text-primary uppercase font-bold text-[14px] mb-4 cursor-blink">Building your agent...</span>
             <div className="w-full h-1 bg-[#262626]">
               <div className="h-full bg-primary transition-all duration-[100ms] ease-linear" style={{width: `${genProgress}%`}}></div>
             </div>
          </div>
        )}

        <div className="flex border-b border-[#262626] px-4 py-2 items-center justify-between bg-[#050505]">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-danger/50 border border-danger"></div>
            <div className="w-3 h-3 rounded-full bg-warning/50 border border-warning"></div>
            <div className="w-3 h-3 rounded-full bg-primary/50 border border-primary"></div>
          </div>
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] ml-12">SYSTEM PROMPT INTERFACE</span>
           <div className="flex items-center gap-6">
            <span className="font-mono text-[9px] uppercase tracking-widest text-primary">LATENCY: ~24MS</span>
            <span className={`font-mono text-[9px] uppercase tracking-widest ${isOverLimit ? 'text-danger' : isWarnLimit ? 'text-warning' : 'text-primary'}`}>
              TOKENS: {tokenCount} / 4,096
            </span>
          </div>
        </div>

        {/* Template gallery toggle */}
        <div className="border border-[#262626] bg-[#050505]">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="w-full flex items-center justify-between px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-text-muted hover:text-white transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[14px]">grid_view</span>
              Start from a template
            </span>
            <span className="material-symbols-outlined text-[14px]">
              {showTemplates ? 'expand_less' : 'expand_more'}
            </span>
          </button>
          {showTemplates && (
            <div className="border-t border-[#262626] p-4">
              <TemplateGallery onSelect={handleTemplateSelect} showPreview={false} />
              <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mt-4 text-center">
                Or describe your own agent below ↓
              </p>
            </div>
          )}
        </div>

        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={intent}
            onChange={e => setIntent(e.target.value)}
            placeholder={PLACEHOLDERS[placeholderIndex]}
            className="w-full min-h-[300px] bg-transparent border-none text-white font-mono text-[13px] p-6 focus:outline-none resize-none placeholder:text-text-muted/40 uppercase leading-relaxed"
          ></textarea>
          <span className="absolute bottom-4 right-4 font-mono text-[9px] text-text-muted uppercase tracking-widest">
            L:{intent.split('\n').length} C:{intent.length}
          </span>
        </div>

        <div className="border-t border-[#262626] px-4 py-3 flex justify-between bg-[#141414]">
           <div className="flex gap-4">
             <button onClick={handleOptimize} className="flex items-center gap-2 text-text-muted hover:text-white font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer">
               <span className="material-symbols-outlined text-[14px]">auto_fix_high</span> OPTIMIZE PROMPT
             </button>
             <button onClick={() => setShowTemplates(value => !value)} className="flex items-center gap-2 text-text-muted hover:text-white font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer">
               <span className="material-symbols-outlined text-[14px]">grid_view</span> TEMPLATE GALLERY
             </button>
           </div>
           <div className="flex gap-1.5 items-center">
             <div className="w-1.5 h-1.5 bg-primary rounded-full"></div>
             <div className="w-1.5 h-1.5 bg-[#262626] rounded-full"></div>
             <div className="w-1.5 h-1.5 bg-[#262626] rounded-full"></div>
           </div>
        </div>
      </div>

      <div className="flex justify-between items-center pt-2">
         <span className="font-mono text-[10px] text-primary uppercase tracking-widest">ESTIMATED COMPUTE COST: <br/> $0.002 / 1K TOKENS</span>
         <div className="flex items-center gap-6">
          {error && <span className="font-mono text-[12px] text-danger uppercase fade-in">{error}</span>}
          <button onClick={handleGenerate} disabled={isGenerating || !intent.trim()} className="primary-btn relative bg-primary text-[#050505] py-4 px-8 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50">
              <span className="relative z-10">Generate →</span>
              <div className="scan-line"></div>
          </button>
         </div>
      </div>

      <div className="grid grid-cols-3 gap-6 pt-12">
        <InfoCard icon="shield" title="PII REDACTION" body="Sensitive data is automatically redacted before transmission." primary />
        <InfoCard icon="speed" title="HIGH THROUGHPUT" body="Optimized for low-latency DevOps and CI/CD pipelines." />
        <InfoCard icon="bar_chart" title="AUDIT LOGGING" body="Every interaction is logged for strict compliance traceability." />
      </div>
    </div>
  );
}

function StepThree({ apiKeyId, apiKeyProvider, generatedAgent, setAgentId, addAgent, setStep }) {
  const [name, setName] = useState(generatedAgent?.name || '');
  const [purpose, setPurpose] = useState(generatedAgent?.purpose || '');
  const [systemPrompt, setSystemPrompt] = useState(generatedAgent?.systemPrompt || '');
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState('');

  useEffect(() => {
    setName(generatedAgent?.name || '');
    setPurpose(generatedAgent?.purpose || '');
    setSystemPrompt(generatedAgent?.systemPrompt || '');
  }, [generatedAgent]);

  const handleCreate = async () => {
    setIsDeploying(true);
    setDeployError('');

    try {
      const res = await api.post('/agents', {
        name,
        purpose,
        model_provider: apiKeyProvider,
        api_key_id: apiKeyId,
        system_prompt: systemPrompt,
      });
      addAgent(normalizeAgent(res.data));
      setAgentId(res.data.id);
      setStep(4);
    } catch (err) {
      setDeployError(err.response?.data?.error || 'DEPLOYMENT FAILED');
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="fade-in space-y-8">
       <div className="space-y-4">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em]">STEP 03 / CONFIGURATION PHASE</span>
        <h1 className="font-mono text-[32px] font-bold tracking-tight text-white uppercase">Review your agent</h1>
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] p-8 space-y-6">
         <div className="grid grid-cols-2 gap-6">
           <div className="space-y-2">
             <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_NAME</label>
             <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase" />
           </div>
           <div className="space-y-2">
             <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">CONNECTOR</label>
             <select value={apiKeyProvider || ''} disabled className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase appearance-none cursor-pointer">
               <option>{apiKeyProvider || 'EUDORA SECURE VAULT #1'}</option>
             </select>
           </div>
           <div className="space-y-2 col-span-2">
             <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_MISSION</label>
             <input type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
           </div>
           <div className="space-y-2 col-span-2">
             <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">SYSTEM_PROTOCOL</label>
             <textarea rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"></textarea>
           </div>
           <div className="space-y-2 col-span-2">
             <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block mb-2">KNOWLEDGE TAGS</label>
             <div className="flex flex-wrap gap-2">
               {generatedAgent?.suggestedTags?.map(tag => (
                 <div key={tag} className="flex items-center gap-2 border border-primary px-3 py-1 bg-primary/10">
                   <span className="font-mono text-[10px] text-primary uppercase">{tag}</span>
                   <span className="material-symbols-outlined text-[14px] text-primary cursor-pointer hover:text-white">close</span>
                 </div>
               ))}
               <button className="flex items-center gap-1 border border-dashed border-text-muted px-3 py-1 text-text-muted hover:border-white hover:text-white transition-colors cursor-pointer">
                 <span className="material-symbols-outlined text-[14px]">add</span>
                 <span className="font-mono text-[10px] uppercase">ADD NEXUS</span>
               </button>
             </div>
           </div>
         </div>
      </div>

       <div className="flex justify-between pt-4">
        <button onClick={() => setStep(2)} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-3 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer">
          REGENERATE
        </button>
        <div className="flex items-center gap-6">
          {deployError && <span className="font-mono text-[12px] text-danger uppercase fade-in">{deployError}</span>}
          <button onClick={handleCreate} disabled={isDeploying || !name.trim() || !purpose.trim()} className="primary-btn relative bg-primary text-[#050505] py-4 px-12 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-80">
            <span className="relative z-10">{isDeploying ? 'ESTABLISHING SECURE NODE...' : 'Confirm and create →'}</span>
            <div className="scan-line"></div>
          </button>
        </div>
      </div>
    </div>
  );
}

function StepFour({ agentId, generatedAgent, setStep }) {
  const [activeTab, setActiveTab] = useState('paste');
  const [filename, setFilename] = useState('onboarding-context.md');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState((generatedAgent?.suggestedTags || []).join(', '));
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setContent(await file.text());
  };

  const handleAddContext = async () => {
    if (!content.trim()) {
      setStep(5);
      return;
    }

    setIsSaving(true);
    setStatus('');
    try {
      await api.post('/context', {
        agentId,
        filename,
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
        content,
      });
      setStep(5);
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to add context');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fade-in space-y-8">
      <div className="space-y-4">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em]">STEP 04 / CONTEXT PHASE</span>
        <h1 className="font-mono text-[32px] font-bold tracking-tight text-white uppercase">Add context</h1>
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] p-8 space-y-6">
        <div className="flex border-b border-[#262626]">
          <button onClick={() => setActiveTab('paste')} className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'paste' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}>
            PASTE TEXT
          </button>
          <button onClick={() => setActiveTab('upload')} className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'upload' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}>
            UPLOAD .MD FILE
          </button>
        </div>

        {activeTab === 'paste' ? (
          <div className="space-y-2">
            <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">CONTEXT_TEXT</label>
            <textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"></textarea>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">MARKDOWN_FILE</label>
            <input type="file" accept=".md,text/markdown,text/plain" onChange={handleFile} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
          </div>
        )}

        <div className="space-y-2">
          <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">FILENAME</label>
          <input type="text" value={filename} onChange={(e) => setFilename(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
        </div>

        <div className="space-y-2">
          <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">TAGS</label>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
        </div>
      </div>

      <div className="flex justify-between items-center pt-4">
        <button onClick={() => setStep(5)} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Skip for now →</button>
        <div className="flex items-center gap-6">
          {status && <span className="font-mono text-[12px] text-danger uppercase fade-in">{status}</span>}
          <button onClick={handleAddContext} disabled={isSaving} className="primary-btn relative bg-primary text-[#050505] py-4 px-12 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-80">
            <span className="relative z-10">{isSaving ? 'ADDING CONTEXT...' : 'Add context →'}</span>
            <div className="scan-line"></div>
          </button>
        </div>
      </div>
    </div>
  );
}

function StepFive({ agentId, completeOnboarding, setStep, showWorkflowStep, setCronJobId }) {
  const [intent, setIntent] = useState('');
  const [schedule, setSchedule] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [jobName, setJobName] = useState('');
  const [status, setStatus] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleGenerate = async () => {
    if (!intent.trim()) return;
    setIsGenerating(true);
    setStatus('');

    try {
      const res = await api.post('/onboarding/generate-cron', { intent, agentId });
      setSchedule(res.data);
      setPrompt(res.data.suggestedPrompt);
      setJobName(res.data.humanLabel ? `Scheduled run - ${res.data.humanLabel}` : 'Scheduled run');
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to generate schedule');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCreateSchedule = async () => {
    if (!schedule) return;
    setIsSaving(true);
    setStatus('');
    try {
      const res = await api.post('/cron', {
        agentId,
        name: jobName.trim() || `Scheduled run - ${schedule.humanLabel}`,
        prompt,
        schedule: schedule.schedule,
        preset: schedule.preset,
      });
      setCronJobId(res.data.id);
      if (showWorkflowStep) setStep(6);
      else await completeOnboarding();
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to create schedule');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fade-in space-y-8">
      <div className="space-y-4">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em]">STEP 05 / SCHEDULING PHASE</span>
        <h1 className="font-mono text-[32px] font-bold tracking-tight text-white uppercase">Schedule a run</h1>
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] p-8 space-y-6">
        <div className="space-y-2">
          <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">When should this agent run automatically?</label>
          <input type="text" value={intent} onChange={(e) => setIntent(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
        </div>

        <button onClick={handleGenerate} disabled={isGenerating || !intent.trim()} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-2 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer disabled:opacity-50">
          {isGenerating ? 'GENERATING...' : 'Generate schedule →'}
        </button>

        {schedule && (
          <div className="space-y-4 border border-primary/30 bg-primary/5 p-4">
            <span className="font-mono text-[12px] text-primary uppercase tracking-widest">{schedule.humanLabel}</span>
            <div className="space-y-2">
              <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">JOB_NAME</label>
              <input type="text" value={jobName} onChange={(e) => setJobName(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
            </div>
            <div className="space-y-2">
              <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">SCHEDULE_PROMPT</label>
              <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"></textarea>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center pt-4">
        <button onClick={() => showWorkflowStep ? setStep(6) : completeOnboarding()} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Skip for now →</button>
        <div className="flex items-center gap-6">
          {status && <span className="font-mono text-[12px] text-danger uppercase fade-in">{status}</span>}
          <button onClick={handleCreateSchedule} disabled={isSaving || !schedule} className="primary-btn relative bg-primary text-[#050505] py-4 px-12 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-80">
            <span className="relative z-10">{isSaving ? 'CREATING SCHEDULE...' : 'Create schedule'}</span>
            <div className="scan-line"></div>
          </button>
        </div>
      </div>
    </div>
  );
}

function StepSix({ completeOnboarding }) {
  const [isCreating, setIsCreating] = useState(false);
  const [status, setStatus] = useState('');

  const handleStarterTemplate = async () => {
    setIsCreating(true);
    setStatus('');
    try {
      const agentsRes = await api.get('/agents');
      const agents = agentsRes.data || [];
      if (agents.length === 0) throw new Error('Create an agent before building a workflow');

      const res = await api.post('/workflows', buildStarterWorkflow(agents));
      await completeOnboarding(`/workflows/${res.data.id}`);
    } catch (err) {
      setStatus(err.response?.data?.error || err.message || 'Unable to create starter workflow');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fade-in space-y-8">
      <div className="space-y-4">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em]">STEP 06 / WORKFLOW PHASE</span>
        <h1 className="font-mono text-[32px] font-bold tracking-tight text-white uppercase">Build a workflow</h1>
        <p className="font-sans text-[18px] text-text-muted max-w-2xl">Connect multiple agents together. The output of one agent becomes the input of the next.</p>
      </div>

      <div className="bg-[#0a0a0a] border border-[#262626] p-8 space-y-8">
        <div className="flex items-center justify-center gap-4 py-8">
          {['Research', 'Summarise', 'Report'].map((label, index) => (
            <div key={label} className="flex items-center gap-4">
              <div className="w-[150px] border border-primary/40 bg-primary/10 p-4 text-center">
                <span className="material-symbols-outlined text-primary text-[22px] block mb-3">smart_toy</span>
                <span className="font-mono text-[10px] text-primary uppercase font-bold tracking-widest">{label}</span>
              </div>
              {index < 2 && (
                <svg width="64" height="18" viewBox="0 0 64 18" fill="none" aria-hidden="true">
                  <path d="M1 9H58" stroke="#10b981" strokeWidth="2" strokeLinecap="square" />
                  <path d="M54 2L62 9L54 16" stroke="#10b981" strokeWidth="2" strokeLinecap="square" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-6">
          <InfoCard icon="account_tree" title="CHAIN OUTPUTS" body="Pass one agent response directly into the next step." primary />
          <InfoCard icon="rule" title="CONDITIONS" body="Gate downstream nodes by checking output text." />
          <InfoCard icon="history" title="RUN HISTORY" body="Review each node result after execution." />
        </div>
      </div>

      <div className="flex justify-between items-center pt-4">
        <button onClick={() => completeOnboarding()} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Skip →</button>
        <div className="flex items-center gap-6">
          {status && <span className="font-mono text-[12px] text-danger uppercase fade-in">{status}</span>}
          <button onClick={handleStarterTemplate} disabled={isCreating} className="primary-btn relative bg-primary text-[#050505] py-4 px-12 font-mono text-[14px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-80">
            <span className="relative z-10">{isCreating ? 'CREATING WORKFLOW...' : 'Try the starter template →'}</span>
            <div className="scan-line"></div>
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ icon, title, body, primary }) {
  return (
    <div className="border border-[#262626] bg-[#0a0a0a] p-6 hover:border-text-muted transition-colors">
      <span className={`material-symbols-outlined ${primary ? 'text-primary' : 'text-white'} mb-4`}>{icon}</span>
      <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest mb-2">{title}</h3>
      <p className="font-sans text-[13px] text-text-muted leading-relaxed">{body}</p>
    </div>
  );
}

function normalizeAgent(agent) {
  return {
    ...agent,
    refId: `AGENT_${agent.id}`,
    mission: agent.purpose,
    model: agent.model_provider,
    level: '1',
    knowledge: 'Base_Vectors',
    status: 'active',
    provider: agent.model_provider,
    systemPrompt: agent.system_prompt,
  };
}

function buildStarterWorkflow(agents) {
  const selectedAgents = [0, 1, 2].map(index => agents[index] || agents[0]);
  return {
    name: 'STARTER WORKFLOW',
    description: 'Research, summarise, and report on the requested task.',
    nodes: selectedAgents.map((agent, index) => ({
      id: `starter-${index + 1}`,
      agentId: agent.id,
      label: ['Research', 'Summarise', 'Report'][index],
      position: { x: index * 300, y: 160 },
    })),
    edges: [
      { id: 'starter-e1', source: 'starter-1', target: 'starter-2', condition: '' },
      { id: 'starter-e2', source: 'starter-2', target: 'starter-3', condition: '' },
    ],
  };
}
