import { useState, useEffect } from 'react';
import { useAgentStore } from '../store/agentStore';
import { useAuthStore } from '../store/authStore';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { TemplateGallery } from '../components/TemplateGallery';

const DEFAULT_SCOPE_POLICY = {
  allowed: ['compliance', 'document_qa', 'code_review'],
  blocked: ['financial_advice', 'medical_advice', 'legal_advice'],
};

export default function AgentBuilder() {
  const { agents } = useAgentStore();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  
  const [cmdInput, setCmdInput] = useState('');
  const [isDeploying, setIsDeploying] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [formMode, setFormMode] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newAgentTab, setNewAgentTab] = useState('template');
  const [prefilledTemplate, setPrefilledTemplate] = useState(null);
  const [editingAgentId, setEditingAgentId] = useState(null);
  const [reviewForm, setReviewForm] = useState({
    name: '',
    purpose: '',
    systemPrompt: '',
    apiKeyId: '',
    modelProvider: '',
    scopePolicy: JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2),
  });
  const [formError, setFormError] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('LEVEL');
  const [logs, setLogs] = useState([]);
  const [showExternalModal, setShowExternalModal] = useState(false);
  const [externalForm, setExternalForm] = useState({
    name: '',
    purpose: '',
    providerHint: 'openai',
    interceptionMode: 'observe',
  });
  const [externalError, setExternalError] = useState('');
  const [externalLoading, setExternalLoading] = useState(false);
  const [proxyResult, setProxyResult] = useState(null);

  useEffect(() => {
    let isMounted = true;

    const loadAgents = async () => {
      try {
        const [agentsRes, keysRes] = await Promise.all([
          api.get('/agents'),
          api.get('/api-keys'),
        ]);
        if (isMounted) {
          useAgentStore.getState().setAgents(agentsRes.data.map(normalizeAgent));
          setApiKeys(keysRes.data);
        }
      } catch {
        if (isMounted) useAgentStore.getState().setAgents([]);
      }
    };

    loadAgents();

    const defaultLogs = [
      `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] SYSTEM       INITIALIZING UPLINK TO AGENT_IT_MAX...`,
      `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] AGENT_CR_04  COMPLETED ANALYSIS OF PR_SUBMISSION_#882`,
      `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] AGENT_DC_05  COMPLIANCE AUDIT TRIGGERED FOR CLUSTER_B`,
      `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] SYSTEM       VECTOR RE-INDEXING IN PROGRESS [||||||||||--] 82%`,
      `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] AGENT_QA_02  RESPONDING TO QUERY FROM USER_DEV_09`,
    ];
    setLogs(defaultLogs);

    const interval = setInterval(() => {
      const msgs = [
        "HEARTBEAT    ALL SYSTEMS NOMINAL. FLEET STABILITY 99.98%",
        "AGENT_CR_04  SCANNING NEW COMMITS ON MAIN BRANCH",
        "SYSTEM       THREAT INTELLIGENCE FEED UPDATED",
        "AGENT_IT_MAX CLASSIFIED ALERT ID_773 AS LOW_RISK",
        "AGENT_DC_05  GENERATING MONTHLY DORA REPORT EXPORT"
      ];
      setLogs(prev => [...prev, `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msgs[Math.floor(Math.random() * msgs.length)]}`].slice(-8));
    }, 3000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!location.state?.template) return;
    handleTemplateSelect(location.state.template);
    navigate('/agents', { replace: true, state: null });
  }, [location.state, navigate]);

  const handleDeploy = async () => {
    if (!cmdInput.trim()) return;
    const firstKey = apiKeys[0];
    if (!firstKey) {
      setFormError('Add an API key in Settings first');
      return;
    }

    setIsDeploying(true);
    setFormError('');

    try {
      const res = await api.post('/onboarding/generate-agent', {
        intent: cmdInput,
        apiKeyId: firstKey.id,
      });
      setReviewForm({
        name: res.data.name || '',
        purpose: res.data.purpose || '',
        systemPrompt: res.data.systemPrompt || '',
        apiKeyId: firstKey.id,
        modelProvider: firstKey.provider,
        scopePolicy: JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2),
      });
      setFormMode('create');
      setEditingAgentId(null);
    } catch (err) {
      setFormError(err.response?.data?.error || 'Unable to build agent');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleCreateAgent = async () => {
    setIsDeploying(true);
    setFormError('');

    try {
      const selectedKey = apiKeys.find((key) => key.id === reviewForm.apiKeyId);
      const res = await api.post('/agents', {
        name: reviewForm.name,
        purpose: reviewForm.purpose,
        model_provider: selectedKey?.provider || reviewForm.modelProvider,
        api_key_id: reviewForm.apiKeyId || null,
        system_prompt: reviewForm.systemPrompt,
      });
      useAgentStore.getState().addAgent(normalizeAgent(res.data));
      closeForm();
      setCmdInput('');
    } catch (err) {
      setFormError(err.response?.data?.error || 'Unable to create agent');
    } finally {
      setIsDeploying(false);
    }
  };

  const openNewAgentModal = () => {
    setShowNewModal(true);
    setNewAgentTab('template');
    setPrefilledTemplate(null);
    setFormMode(null);
    setEditingAgentId(null);
    setFormError('');
    setReviewForm({
      name: '',
      purpose: '',
      systemPrompt: '',
      apiKeyId: apiKeys[0]?.id || '',
      modelProvider: apiKeys[0]?.provider || '',
      scopePolicy: JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2),
    });
  };

  const openExternalModal = () => {
    setShowExternalModal(true);
    setExternalError('');
    setProxyResult(null);
    setExternalForm({
      name: '',
      purpose: '',
      providerHint: 'openai',
      interceptionMode: 'observe',
    });
  };

  const closeExternalModal = () => {
    setShowExternalModal(false);
    setExternalError('');
    setProxyResult(null);
    setExternalLoading(false);
  };

  const handleRegisterExternalAgent = async () => {
    const ownerId = user?.id || user?.userId;
    if (!ownerId) {
      setExternalError('Current user owner could not be resolved');
      return;
    }

    setExternalLoading(true);
    setExternalError('');

    try {
      const res = await api.post('/agents/register', {
        name: externalForm.name,
        purpose: externalForm.purpose,
        ownerType: 'human',
        ownerId,
        providerHint: externalForm.providerHint,
        interceptionMode: externalForm.interceptionMode,
      });
      const agentRes = await api.get(`/agents/${res.data.agentId}`);
      useAgentStore.getState().addAgent(normalizeAgent(agentRes.data));
      setProxyResult(res.data);
    } catch (err) {
      setExternalError(err.response?.data?.message || err.response?.data?.error || 'Unable to register external agent');
    } finally {
      setExternalLoading(false);
    }
  };

  const copyProxyKey = async () => {
    if (!proxyResult?.proxyKey) return;
    await navigator.clipboard.writeText(proxyResult.proxyKey);
  };

  const handleTemplateSelect = (template) => {
    const firstKey = apiKeys[0];
    setPrefilledTemplate(template);
    setNewAgentTab('custom');
    setShowNewModal(true);
    setFormMode('create');
    setEditingAgentId(null);
    setFormError('');
    setReviewForm({
      name: template.name.toUpperCase(),
      purpose: template.description,
      systemPrompt: template.systemPrompt,
      apiKeyId: firstKey?.id || '',
      modelProvider: firstKey?.provider || '',
      scopePolicy: JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2),
    });
  };

  const openEditForm = (agent) => {
    setFormMode('edit');
    setEditingAgentId(agent.id);
    setFormError('');
    setReviewForm({
      name: agent.name || '',
      purpose: agent.purpose || agent.mission || '',
      systemPrompt: agent.systemPrompt || '',
      apiKeyId: agent.api_key_id || '',
      modelProvider: agent.provider || agent.model || '',
      scopePolicy: formatScopePolicy(agent.scope_policy),
    });
  };

  const handleUpdateAgent = async () => {
    if (!editingAgentId) return;
    setIsDeploying(true);
    setFormError('');

    try {
      const scopePolicy = parseScopePolicy(reviewForm.scopePolicy);
      const selectedKey = apiKeys.find((key) => key.id === reviewForm.apiKeyId);
      const res = await api.patch(`/agents/${editingAgentId}`, {
        name: reviewForm.name,
        purpose: reviewForm.purpose,
        model_provider: selectedKey?.provider || reviewForm.modelProvider,
        api_key_id: reviewForm.apiKeyId || null,
        system_prompt: reviewForm.systemPrompt,
      });
      const scopeRes = await api.patch(`/agents/${editingAgentId}/scope-policy`, { scopePolicy });
      useAgentStore.getState().updateAgent(editingAgentId, normalizeAgent({
        ...res.data,
        scope_policy: JSON.stringify(scopeRes.data.scopePolicy),
      }));
      closeForm();
    } catch (err) {
      setFormError(err.message === 'invalid_scope_policy'
        ? 'Scope policy must be valid JSON'
        : err.response?.data?.error || 'Unable to update agent');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleSubmitForApproval = async (agent) => {
    try {
      const res = await api.post(`/agents/${agent.id}/submit-for-approval`);
      useAgentStore.getState().updateAgent(agent.id, { status: res.data.status });
    } catch (err) {
      setFormError(err.response?.data?.error || 'Unable to submit agent for approval');
    }
  };

  const handleApproveAgent = async (agent) => {
    try {
      const res = await api.post(`/agents/${agent.id}/approve`);
      useAgentStore.getState().updateAgent(agent.id, { status: res.data.status });
    } catch (err) {
      setFormError(err.response?.data?.error || 'Unable to approve agent');
    }
  };

  const handleDeleteAgent = async (agent) => {
    if (!window.confirm(`Delete ${agent.name}?`)) return;

    try {
      await api.delete(`/agents/${agent.id}`);
      useAgentStore.getState().removeAgent(agent.id);
    } catch (err) {
      setFormError(err.response?.data?.error || 'Unable to delete agent');
    }
  };

  const closeForm = () => {
    setFormMode(null);
    setShowNewModal(false);
    setNewAgentTab('template');
    setPrefilledTemplate(null);
    setEditingAgentId(null);
    setFormError('');
    setReviewForm({
      name: '',
      purpose: '',
      systemPrompt: '',
      apiKeyId: '',
      modelProvider: '',
      scopePolicy: JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2),
    });
  };

  const filteredAgents = agents
    .filter(a => {
      if (filter === 'ALL') return true;
      const status = String(a.status || 'live').toUpperCase();
      if (filter === 'ACTIVE') return status === 'ACTIVE' || status === 'LIVE';
      return status === filter;
    })
    .sort((a, b) => {
      if (sort === 'NAME') return a.name.localeCompare(b.name);
      if (sort === 'MODEL') return a.model.localeCompare(b.model);
      if (sort === 'CREATED') return (b.created_at || 0) - (a.created_at || 0);
      return 0; // LEVEL is complex due to 'MAX', keep simple for mock
    });

  const getLogColorClass = (log) => {
    if (log.includes('SYSTEM')) return 'text-primary';
    if (log.includes('AGENT_IT_MAX')) return 'text-warning';
    if (log.includes('HEARTBEAT')) return 'text-primary font-bold';
    return 'text-white';
  };

  const getIconForAgent = (name) => {
    if (name.includes('CODE')) return 'data_object';
    if (name.includes('DORA') || name.includes('COMPLIANCE')) return 'policy';
    if (name.includes('DOC') || name.includes('Q&A')) return 'description';
    if (name.includes('INCIDENT') || name.includes('TRIAGE')) return 'warning';
    return 'smart_toy';
  };

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
       
      {/* Header section */}
      <div className="border-l-[4px] border-primary pl-6 py-2">
        <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">AGENT FLEET</h1>
        <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">ACTIVE TACTICAL AI UNITS</p>
      </div>

      {/* COMMAND INPUT */}
      <div className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="relative">
        {isDeploying && (
          <div className="absolute inset-0 bg-[#050505]/90 backdrop-blur z-20 flex items-center justify-center">
            <span className="font-mono text-primary uppercase font-bold text-[14px] cursor-blink">Building your agent...</span>
          </div>
        )}
        <div className="flex items-center gap-3 mb-6">
          <span className="material-symbols-outlined text-primary text-[20px]">terminal</span>
          <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">COMMAND: INITIALIZE_AGENT</h2>
          <button
            onClick={openNewAgentModal}
            className="ml-auto border border-primary/30 text-primary hover:border-primary px-4 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer"
          >
            NEW AGENT
          </button>
          <button
            onClick={openExternalModal}
            className="border border-warning/40 text-warning hover:border-warning px-4 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer"
          >
            REGISTER EXTERNAL AGENT
          </button>
        </div>
        
        <div className="flex flex-col md:flex-row gap-6">
          <div className="flex-1 relative border border-[#262626] bg-[#050505] group focus-within:border-primary transition-colors">
            <span className="absolute left-4 top-4 font-mono text-[12px] text-primary uppercase">CMD:</span>
            <textarea 
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              placeholder="Input natural language mission parameters (e.g., 'Initialize a DORA compliance bot for the staging environment')..."
              className="w-full bg-transparent text-white font-mono text-[13px] pl-16 pr-4 py-4 min-h-[96px] resize-none focus:outline-none placeholder:text-[#262626] leading-relaxed"
            ></textarea>
          </div>
          <button 
            onClick={handleDeploy}
            disabled={isDeploying || !cmdInput.trim()}
            className="primary-btn relative bg-primary text-[#050505] font-mono text-[12px] font-bold uppercase tracking-[0.15em] shrink-0 min-w-[140px] flex items-center justify-center transition-all overflow-hidden disabled:opacity-50 cursor-pointer h-auto py-4 md:py-0"
          >
            <span className="relative z-10">{isDeploying ? 'DEPLOYING...' : 'DEPLOY'}</span>
            <div className="scan-line"></div>
          </button>
        </div>
        {formError && (
          <div className="mt-4 font-mono text-[12px] text-danger uppercase tracking-widest">
            {formError === 'Add an API key in Settings first' ? (
              <><Link to="/settings" className="text-primary hover:underline">{formError}</Link></>
            ) : formError}
          </div>
        )}

        {formMode && (
          <div className="mt-8 border border-[#262626] bg-[#050505] p-6 space-y-6 fade-in">
            <div className="flex items-center justify-between border-b border-[#262626] pb-4">
              <h3 className="font-mono text-[13px] text-primary uppercase font-bold tracking-widest">{formMode === 'edit' ? 'EDIT_AGENT' : 'REVIEW_GENERATED_AGENT'}</h3>
              <button onClick={closeForm} className="text-text-muted hover:text-white transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_NAME</label>
                <input
                  type="text"
                  value={reviewForm.name}
                  onChange={(e) => setReviewForm((form) => ({ ...form, name: e.target.value }))}
                  className="w-full bg-[#0a0a0a] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase"
                />
              </div>
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">API_KEY</label>
                <select
                  value={reviewForm.apiKeyId}
                  onChange={(e) => {
                    const selected = apiKeys.find((key) => key.id === e.target.value);
                    setReviewForm((form) => ({ ...form, apiKeyId: e.target.value, modelProvider: selected?.provider || form.modelProvider }));
                  }}
                  className="w-full bg-[#0a0a0a] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase appearance-none cursor-pointer"
                >
                  <option value="">NO API KEY</option>
                  {apiKeys.map((key) => (
                    <option key={key.id} value={key.id}>{key.label || key.provider} / {key.provider}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2 col-span-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_MISSION</label>
                <input
                  type="text"
                  value={reviewForm.purpose}
                  onChange={(e) => setReviewForm((form) => ({ ...form, purpose: e.target.value }))}
                  className="w-full bg-[#0a0a0a] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">SYSTEM_PROTOCOL</label>
                <textarea
                  rows={6}
                  value={reviewForm.systemPrompt}
                  onChange={(e) => setReviewForm((form) => ({ ...form, systemPrompt: e.target.value }))}
                  className="w-full bg-[#0a0a0a] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"
                ></textarea>
              </div>
              {formMode === 'edit' && (
                <div className="space-y-2 col-span-2">
                  <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">SCOPE_POLICY_JSON</label>
                  <textarea
                    rows={6}
                    value={reviewForm.scopePolicy}
                    onChange={(e) => setReviewForm((form) => ({ ...form, scopePolicy: e.target.value }))}
                    className="w-full bg-[#0a0a0a] border border-[#262626] text-white p-4 font-mono text-[12px] focus:border-primary resize-none"
                  ></textarea>
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={formMode === 'edit' ? handleUpdateAgent : handleCreateAgent}
                disabled={isDeploying || !reviewForm.name.trim() || !reviewForm.purpose.trim()}
                className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50"
              >
                <span className="relative z-10">{formMode === 'edit' ? 'UPDATE AGENT' : 'CREATE AGENT'}</span>
                <div className="scan-line"></div>
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-primary rounded-full pulse-dot"></span>
            <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest">UPLINK: STABLE</span>
          </div>
          <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest">LATENCY: 12MS</span>
          <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest">ENCRYPTION: AES-256-GCM</span>
        </div>
        </div>
      </div>

      {/* FLEET REGISTRY */}
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between border-b border-[#262626] pb-4">
          <h2 className="font-mono text-[16px] text-primary uppercase font-bold tracking-widest">FLEET REGISTRY</h2>
          <div className="flex gap-4">
            <button 
              onClick={() => {
                const states = ['ALL', 'ACTIVE', 'CRITICAL'];
                setFilter(states[(states.indexOf(filter) + 1) % states.length]);
              }}
              className="border border-[#262626] text-text-muted hover:border-primary hover:text-white px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer"
            >
              FILTER: {filter}
            </button>
            <button 
              onClick={() => {
                const states = ['LEVEL', 'NAME', 'MODEL', 'CREATED'];
                setSort(states[(states.indexOf(sort) + 1) % states.length]);
              }}
              className="border border-[#262626] text-text-muted hover:border-primary hover:text-white px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer"
            >
              SORT: {sort}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-6">
          {filteredAgents.length === 0 && (
            <div className="col-span-full border border-[#262626] bg-[#0a0a0a] p-8 text-center fade-in">
              <span className="material-symbols-outlined text-primary text-[32px] mb-4">smart_toy</span>
              <h3 className="font-mono text-[16px] text-white uppercase font-bold tracking-widest mb-2">NO AGENTS DEPLOYED</h3>
              <p className="font-sans text-[14px] text-text-muted">Use the command input above to initialize your first tactical AI unit.</p>
            </div>
          )}
          {filteredAgents.map(agent => (
            <div key={agent.id} className="border border-[#262626] bg-[#0a0a0a] p-6 hover:border-primary/50 transition-colors flex flex-col group fade-in">
              <div className="flex justify-between items-start mb-6">
                <div className="w-12 h-12 bg-[#050505] border border-[#262626] flex items-center justify-center text-primary group-hover:bg-primary/5 transition-colors">
                  <span className="material-symbols-outlined text-[24px]">{getIconForAgent(agent.name)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => openEditForm(agent)} className="text-text-muted hover:text-primary transition-colors cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button onClick={() => handleDeleteAgent(agent)} className="text-text-muted hover:text-danger transition-colors cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center gap-3 mb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-2 border border-primary/30 bg-primary/10 px-2 py-1">
                    <span className="w-1.5 h-1.5 bg-primary rounded-full"></span>
                    <span className="font-mono text-[9px] uppercase text-primary font-bold tracking-widest">{agent.provider || 'UNKNOWN'}</span>
                  </div>
                  {agent.agentType === 'external' && (
                    <span className="border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[9px] uppercase text-warning font-bold tracking-widest">
                      EXTERNAL
                    </span>
                  )}
                  {getStatusBadge(agent.status)}
                </div>
                <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{formatRelativeTime(agent.created_at)}</span>
              </div>

              <h3 className="font-mono text-[16px] xl:text-[18px] font-bold text-white uppercase tracking-tight mb-1">{agent.name}</h3>
              <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-6 border-b border-[#262626] pb-4">REF_ID: {agent.refId}</p>

              <div className="space-y-6 flex-1 mb-6">
                <div>
                  <p className="font-mono text-[9px] text-primary uppercase tracking-widest mb-1.5">PURPOSE</p>
                  <p className="font-sans text-[14px] text-white leading-relaxed" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{agent.purpose}</p>
                </div>
                
                <div className="grid grid-cols-2 gap-4 border-l border-[#262626] pl-4">
                  <div>
                    <p className="font-mono text-[9px] text-primary uppercase tracking-widest mb-1">MODEL</p>
                    <p className="font-mono text-[11px] text-white uppercase">{agent.model}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[9px] text-primary uppercase tracking-widest mb-1">STATUS</p>
                    <span className="font-mono text-[9px] uppercase text-primary font-bold tracking-widest">{formatStatus(agent.status)}</span>
                  </div>
                </div>

                <div>
                  <p className="font-mono text-[9px] text-primary uppercase tracking-widest mb-1.5">KNOWLEDGE</p>
                  <p className="font-mono text-[11px] text-white">{agent.knowledge}</p>
                </div>
              </div>

              <button 
                 onClick={() => { useAgentStore.getState().setActiveAgent(agent); navigate('/chat'); }}
                className="w-full py-3 border border-[#262626] text-text-muted hover:border-primary hover:text-white font-mono text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer"
              >
                ACCESS INTERFACE
              </button>
              {String(agent.status || 'live') === 'draft' && (
                <button
                  onClick={() => handleSubmitForApproval(agent)}
                  className="w-full py-3 mt-3 border border-warning/40 text-warning hover:border-warning hover:text-warning font-mono text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer"
                >
                  SUBMIT FOR APPROVAL
                </button>
              )}
              {String(agent.status || 'live') === 'pending_approval' && isCurrentUserOwner(agent, user) && (
                <button
                  onClick={() => handleApproveAgent(agent)}
                  className="w-full py-3 mt-3 border border-primary/40 text-primary hover:border-primary hover:text-primary font-mono text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer"
                >
                  APPROVE
                </button>
              )}
              <button 
                 onClick={() => navigate(`/agents/${agent.id}/context`)}
                className="w-full py-3 mt-3 border border-[#262626] text-text-muted hover:border-primary hover:text-white font-mono text-[10px] font-bold uppercase tracking-widest transition-colors cursor-pointer"
              >
                CONTEXT
              </button>
            </div>
          ))}
        </div>
      </div>

      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-[#050505]/95 flex items-center justify-center p-8">
          <div className="w-full max-w-5xl max-h-[88vh] overflow-y-auto border border-[#262626] bg-[#0a0a0a]">
            <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4 bg-[#050505]">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary text-[20px]">smart_toy</span>
                <h3 className="font-mono text-[13px] text-white uppercase font-bold tracking-widest">NEW_AGENT_DEPLOYMENT</h3>
              </div>
              <button onClick={closeForm} className="text-text-muted hover:text-white transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="flex border-b border-[#262626] bg-[#050505]">
              <button
                onClick={() => setNewAgentTab('template')}
                className={`px-6 py-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors cursor-pointer ${newAgentTab === 'template' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}
              >
                FROM TEMPLATE
              </button>
              <button
                onClick={() => setNewAgentTab('custom')}
                className={`px-6 py-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors cursor-pointer ${newAgentTab === 'custom' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}
              >
                DESCRIBE YOUR OWN
              </button>
            </div>

            <div className="p-6">
              {newAgentTab === 'template' ? (
                <TemplateGallery onSelect={handleTemplateSelect} showPreview={true} />
              ) : (
                <div className="space-y-6">
                  {prefilledTemplate && (
                    <div className="border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
                      <span className="material-symbols-outlined text-primary text-[18px]">{prefilledTemplate.icon}</span>
                      <span className="font-mono text-[10px] text-primary uppercase tracking-widest">
                        TEMPLATE LOADED: {prefilledTemplate.name}
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_NAME</label>
                      <input
                        type="text"
                        value={reviewForm.name}
                        onChange={(e) => setReviewForm((form) => ({ ...form, name: e.target.value }))}
                        className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">API_KEY</label>
                      <select
                        value={reviewForm.apiKeyId}
                        onChange={(e) => {
                          const selected = apiKeys.find((key) => key.id === e.target.value);
                          setReviewForm((form) => ({ ...form, apiKeyId: e.target.value, modelProvider: selected?.provider || form.modelProvider }));
                        }}
                        className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase appearance-none cursor-pointer"
                      >
                        <option value="">NO API KEY</option>
                        {apiKeys.map((key) => (
                          <option key={key.id} value={key.id}>{key.label || key.provider} / {key.provider}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2 col-span-2">
                      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_MISSION</label>
                      <input
                        type="text"
                        value={reviewForm.purpose}
                        onChange={(e) => setReviewForm((form) => ({ ...form, purpose: e.target.value }))}
                        className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary"
                      />
                    </div>
                    <div className="space-y-2 col-span-2">
                      <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">SYSTEM_PROTOCOL</label>
                      <textarea
                        rows={8}
                        value={reviewForm.systemPrompt}
                        onChange={(e) => setReviewForm((form) => ({ ...form, systemPrompt: e.target.value }))}
                        className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"
                      ></textarea>
                    </div>
                  </div>

                  {formError && (
                    <div className="font-mono text-[12px] text-danger uppercase tracking-widest">
                      {formError === 'Add an API key in Settings first' ? (
                        <><Link to="/settings" className="text-primary hover:underline">{formError}</Link></>
                      ) : formError}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-4">
                    <button onClick={closeForm} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Cancel</button>
                    <button
                      onClick={handleCreateAgent}
                      disabled={isDeploying || !reviewForm.name.trim() || !reviewForm.purpose.trim()}
                      className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50"
                    >
                      <span className="relative z-10">{isDeploying ? 'CREATING...' : 'CREATE AGENT'}</span>
                      <div className="scan-line"></div>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showExternalModal && (
        <div className="fixed inset-0 z-50 bg-[#050505]/95 flex items-center justify-center p-8">
          <div className="w-full max-w-2xl border border-[#262626] bg-[#0a0a0a]">
            <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4 bg-[#050505]">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-warning text-[20px]">hub</span>
                <h3 className="font-mono text-[13px] text-white uppercase font-bold tracking-widest">REGISTER_EXTERNAL_AGENT</h3>
              </div>
              <button onClick={closeExternalModal} className="text-text-muted hover:text-white transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            {proxyResult ? (
              <div className="p-6 space-y-6">
                <div className="border border-warning/40 bg-warning/10 p-4">
                  <p className="font-mono text-[10px] text-warning uppercase tracking-widest">
                    This key will not be shown again. Store it securely.
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">PROXY_KEY</label>
                  <div className="flex gap-3">
                    <input
                      readOnly
                      value={proxyResult.proxyKey}
                      className="flex-1 bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[12px]"
                    />
                    <button
                      onClick={copyProxyKey}
                      className="border border-primary/30 text-primary hover:border-primary px-4 py-3 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer"
                    >
                      COPY
                    </button>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeExternalModal}
                    className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer"
                  >
                    <span className="relative z-10">DONE</span>
                    <div className="scan-line"></div>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">AGENT_NAME</label>
                    <input
                      type="text"
                      value={externalForm.name}
                      onChange={(e) => setExternalForm((form) => ({ ...form, name: e.target.value }))}
                      className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">PROVIDER_HINT</label>
                    <select
                      value={externalForm.providerHint}
                      onChange={(e) => setExternalForm((form) => ({ ...form, providerHint: e.target.value }))}
                      className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase appearance-none cursor-pointer"
                    >
                      <option value="openai">OPENAI</option>
                      <option value="anthropic">ANTHROPIC</option>
                      <option value="azure">AZURE</option>
                      <option value="custom">CUSTOM</option>
                    </select>
                  </div>
                  <div className="space-y-2 col-span-2">
                    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">PURPOSE_DESCRIPTION</label>
                    <textarea
                      rows={4}
                      value={externalForm.purpose}
                      onChange={(e) => setExternalForm((form) => ({ ...form, purpose: e.target.value }))}
                      className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"
                    ></textarea>
                  </div>
                  <div className="space-y-3 col-span-2">
                    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">INTERCEPTION_MODE</label>
                    {[
                      ['block', 'Stop and log any injection attempts before they reach your provider'],
                      ['observe', 'Log and flag injection attempts, but always forward the request (recommended)'],
                      ['report_only', 'Log everything, never intervene'],
                    ].map(([mode, description]) => (
                      <button
                        key={mode}
                        onClick={() => setExternalForm((form) => ({ ...form, interceptionMode: mode }))}
                        className={`w-full text-left border px-4 py-3 transition-colors cursor-pointer ${
                          externalForm.interceptionMode === mode
                            ? 'border-primary bg-primary/10'
                            : 'border-[#262626] bg-[#050505] hover:border-text-muted'
                        }`}
                      >
                        <span className="block font-mono text-[10px] text-white uppercase tracking-widest">{mode}</span>
                        <span className="block font-mono text-[10px] text-text-muted mt-1">{description}</span>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2 col-span-2">
                    <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">OWNER</label>
                    <input
                      readOnly
                      value={user?.name || user?.email || user?.id || 'Current user'}
                      className="w-full bg-[#050505] border border-[#262626] text-text-muted px-4 py-3 font-mono text-[13px]"
                    />
                  </div>
                </div>

                {externalError && (
                  <div className="font-mono text-[12px] text-danger uppercase tracking-widest">
                    {externalError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-4">
                  <button onClick={closeExternalModal} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer">Cancel</button>
                  <button
                    onClick={handleRegisterExternalAgent}
                    disabled={externalLoading || !externalForm.name.trim() || !externalForm.purpose.trim()}
                    className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50"
                  >
                    <span className="relative z-10">{externalLoading ? 'REGISTERING...' : 'REGISTER AGENT'}</span>
                    <div className="scan-line"></div>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

       {/* HEARTBEAT STREAM */}
       <div className="border border-[#262626] bg-[#0a0a0a] flex flex-col">
         <div className="px-6 py-4 border-b border-[#262626] flex items-center gap-3 bg-[#050505]">
           <span className="material-symbols-outlined text-primary text-[18px]">monitoring</span>
           <span className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">REAL-TIME HEARTBEAT STREAM</span>
         </div>
         <div className="p-6 bg-[#050505] font-mono text-[12px] md:text-[13px] leading-loose min-h-[160px] max-h-[240px] overflow-y-auto">
            {logs.map((log, i) => (
              <div key={i} className={`fade-in ${getLogColorClass(log)}`}>{log}</div>
            ))}
         </div>
       </div>

    </div>
  );
}

function normalizeAgent(agent) {
  return {
    ...agent,
    refId: `AGENT_${agent.id}`,
    mission: agent.purpose,
    model: agent.provider_hint || agent.model_provider,
    created_at: agent.created_at,
    level: '1',
    knowledge: 'Base_Vectors',
    status: agent.status || 'live',
    provider: agent.provider_hint || agent.model_provider,
    agentType: agent.agent_type || 'internal',
    systemPrompt: agent.system_prompt,
  };
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'JUST NOW';
  const diff = Date.now() - Number(timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return 'JUST NOW';
  if (diff < hour) return `${Math.floor(diff / minute)}M AGO`;
  if (diff < day) return `${Math.floor(diff / hour)}H AGO`;
  return `${Math.floor(diff / day)}D AGO`;
}

function formatScopePolicy(value) {
  if (!value) return JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2);
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2);
  } catch {
    return JSON.stringify(DEFAULT_SCOPE_POLICY, null, 2);
  }
}

function parseScopePolicy(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    throw new Error('invalid_scope_policy');
  }
}

function formatStatus(status) {
  return String(status || 'live').replaceAll('_', ' ').toUpperCase();
}

function isCurrentUserOwner(agent, user) {
  const currentUserId = user?.id || user?.userId;
  return Boolean(currentUserId && agent.owner_id === currentUserId);
}

function getStatusBadge(status) {
  const normalised = String(status || 'live');
  if (normalised === 'live') return null;

  const styles = {
    draft: 'border-[#404040] bg-[#262626]/40 text-text-muted',
    pending_approval: 'border-warning/40 bg-warning/10 text-warning',
    suspended: 'border-danger/40 bg-danger/10 text-danger',
  };

  return (
    <span className={`border px-2 py-1 font-mono text-[9px] uppercase font-bold tracking-widest ${styles[normalised] || styles.draft}`}>
      {formatStatus(normalised)}
    </span>
  );
}
