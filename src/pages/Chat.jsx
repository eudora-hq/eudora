import { useState, useRef, useEffect } from 'react';
import { useAgentStore } from '../store/agentStore';
import api from '../api/client';

export default function Chat() {
  const { agents, activeAgent } = useAgentStore();
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [traceOpen, setTraceOpen] = useState(true);
  const [error, setError] = useState('');
  const [expandedContexts, setExpandedContexts] = useState({});
  const [traceData, setTraceData] = useState(null);
  const [contextFiles, setContextFiles] = useState([]);

  const messagesEndRef = useRef(null);

  const currentAgent = useAgentStore.getState().activeAgent || agents[0] || null;

  useEffect(() => {
    let isMounted = true;

    const loadInitialData = async () => {
      try {
        const [agentsRes, conversationsRes] = await Promise.all([
          api.get('/agents'),
          api.get('/chat/conversations'),
        ]);

        if (!isMounted) return;

        const normalizedAgents = agentsRes.data.map(normalizeAgent);
        useAgentStore.getState().setAgents(normalizedAgents);

        const selectedAgent = normalizedAgents.find(agent => agent.id === activeAgent?.id) || normalizedAgents[0] || null;
        if (selectedAgent) useAgentStore.getState().setActiveAgent(selectedAgent);

        const loadedConversations = await Promise.all(
          conversationsRes.data.map(async (conversation) => {
            const messagesRes = await api.get(`/chat/conversations/${conversation.id}/messages`);
            const conversationMessages = messagesRes.data.map(normalizeMessage);
            return {
              id: conversation.id,
              agentId: conversation.agent_id,
              createdAt: conversation.created_at,
              messages: conversationMessages,
              preview: conversationMessages[0]?.content || 'Empty operation...',
              timestamp: conversationMessages[0]?.timestamp || conversation.created_at,
            };
          })
        );

        if (!isMounted) return;
        setConversations(loadedConversations);
      } catch (err) {
        if (isMounted) setError(mapError(err));
      }
    };

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  useEffect(() => {
    if (!currentAgent?.id) {
      setContextFiles([]);
      return;
    }

    let isMounted = true;

    const loadContextFiles = async () => {
      try {
        const res = await api.get('/context', { params: { agentId: currentAgent.id } });
        if (isMounted) setContextFiles(res.data);
      } catch {
        if (isMounted) setContextFiles([]);
      }
    };

    loadContextFiles();

    return () => {
      isMounted = false;
    };
  }, [currentAgent?.id]);

  const fetchTrace = async (conversationId) => {
    try {
      const res = await api.get(`/chat/conversations/${conversationId}/trace`);
      const latest = res.data[res.data.length - 1];
      setTraceData(latest ? traceFromHistory(latest) : null);
    } catch {
      setTraceData(null);
    }
  };

  const handleNewOperation = () => {
    setActiveConvId(null);
    setMessages([]);
    setTraceData(null);
    setError('');
  };

  const handleConversationClick = async (conversation) => {
    setActiveConvId(conversation.id);
    setError('');
    const agent = agents.find(a => a.id === conversation.agentId);
    if (agent) useAgentStore.getState().setActiveAgent(agent);

    if (conversation.messages.length) {
      setMessages(conversation.messages);
      fetchTrace(conversation.id);
      return;
    }

    try {
      const res = await api.get(`/chat/conversations/${conversation.id}/messages`);
      const loadedMessages = res.data.map(normalizeMessage);
      setMessages(loadedMessages);
      setConversations(prev => prev.map(item => item.id === conversation.id ? {
        ...item,
        messages: loadedMessages,
        preview: loadedMessages[0]?.content || 'Empty operation...',
        timestamp: loadedMessages[0]?.timestamp || item.createdAt,
      } : item));
      fetchTrace(conversation.id);
    } catch (err) {
      setError(mapError(err));
    }
  };

  const handleAgentChange = (agentId) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;
    useAgentStore.getState().setActiveAgent(agent);
    handleNewOperation();
  };

  const handleSend = async () => {
    if (!input.trim() || isSending || !currentAgent) return;

    const outgoingContent = input;
    const userMessage = { role: 'user', content: outgoingContent, timestamp: Date.now() };
    const pendingMessage = { role: 'agent', content: '', isLoading: true };
    const previousMessages = messages;

    setInput('');
    setError('');
    setIsSending(true);
    setMessages([...previousMessages, userMessage, pendingMessage]);

    try {
      const res = await api.post('/chat', {
        agentId: currentAgent.id,
        conversationId: activeConvId || undefined,
        message: outgoingContent,
      });

      const assistantMessage = {
        role: 'agent',
        content: res.data.content,
        timestamp: Date.now(),
        metadata: {
          tokensIn: res.data.tokensUsed?.input || 0,
          tokensOut: res.data.tokensUsed?.output || 0,
          riskScore: res.data.riskScore ?? 0,
          contextFilesUsed: res.data.contextFilesUsed || [],
          excluded: res.data.excluded || [],
          intent: res.data.intent,
          durationMs: res.data.durationMs || 0,
        },
      };
      const nextMessages = [...previousMessages, userMessage, assistantMessage];

      setMessages(nextMessages);
      setActiveConvId(res.data.conversationId);
      setTraceData(traceFromResponse(res.data));

      setConversations(prev => {
        const existing = prev.find(item => item.id === res.data.conversationId);
        const nextConversation = {
          id: res.data.conversationId,
          agentId: currentAgent.id,
          createdAt: existing?.createdAt || Date.now(),
          messages: nextMessages,
          preview: nextMessages[0]?.content || outgoingContent,
          timestamp: nextMessages[0]?.timestamp || Date.now(),
        };
        return [nextConversation, ...prev.filter(item => item.id !== res.data.conversationId)];
      });
    } catch (err) {
      setMessages(previousMessages);
      setError(mapError(err));
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      handleSend();
    }
  };

  const renderMessageContent = (content) => {
    if (!content) return null;
    const parts = content.split('```');
    return parts.map((part, index) => {
      if (index % 2 !== 0) {
        const nIdx = part.indexOf('\n');
        const code = nIdx > -1 ? part.substring(nIdx + 1) : part;
        return (
          <div key={index} className="bg-[#050505] border border-[#262626] p-3 my-2 font-mono text-[13px] text-white whitespace-pre-wrap overflow-x-auto">
            {code}
          </div>
        );
      }
      return <span key={index} className="whitespace-pre-wrap">{part}</span>;
    });
  };

  const currentContext = getInjectedContext(traceData, contextFiles);
  const currentRisk = traceData?.riskScore ?? 0;
  const latestTokens = getTraceTokens(traceData);

  return (
    <div className="flex h-full w-full bg-[#050505] font-sans overflow-hidden">
      {/* LEFT COLUMN: Operations List */}
      <div className="w-[240px] flex-shrink-0 flex flex-col border-r border-[#262626] bg-[#050505]">
        <button
          onClick={handleNewOperation}
          className="w-full flex items-center justify-center gap-2 border-b border-[#262626] py-3 text-text-muted hover:text-white transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[18px]">add_circle</span>
          <span className="font-mono text-[10px] uppercase font-bold tracking-widest">NEW OPERATION</span>
        </button>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="p-6 text-center">
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">NO ACTIVE OPERATIONS</span>
            </div>
          ) : (
            conversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => handleConversationClick(conv)}
                className={`px-4 py-3 border-b border-[#262626] cursor-pointer transition-colors ${activeConvId === conv.id ? 'border-l-2 border-primary bg-[#0a0a0a]' : 'hover:bg-[#0a0a0a]/50'}`}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="inline-block border border-primary/30 text-primary font-mono text-[8px] uppercase px-1.5 py-0.5 tracking-widest">
                    {agents.find(a => a.id === conv.agentId)?.name || 'AGENT'}
                  </span>
                </div>
                <p className="text-[13px] text-text-muted truncate mb-1" style={{fontFamily: 'Inter'}}>
                  {conv.preview || 'Empty operation...'}
                </p>
                <p className="font-mono text-[8px] text-text-muted/60">
                  {formatRelativeTime(conv.timestamp)}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* MAIN CHAT AREA */}
      <div className="flex-1 flex flex-col bg-[#050505] min-w-0 relative">
        <div className="h-[48px] border-b border-[#262626] px-4 flex items-center justify-between shrink-0 bg-[#0a0a0a]">
          <div className="flex items-center gap-3">
             <select
               value={currentAgent?.id || ''}
               onChange={(e) => handleAgentChange(e.target.value)}
               className="bg-transparent font-mono text-[14px] font-bold text-white uppercase focus:outline-none cursor-pointer"
             >
               {agents.map(agent => (
                 <option key={agent.id} value={agent.id}>{agent.name}</option>
               ))}
             </select>
             <span className="border border-text-muted px-2 py-0.5 font-mono text-[9px] text-text-muted uppercase tracking-widest">{currentAgent?.provider || 'SYSTEM'}</span>
          </div>
          <div className="flex items-center gap-4">
             <span className="border border-[#262626] font-mono text-[9px] px-2 py-1 text-text-muted uppercase tracking-widest">CONTEXT: {currentContext.length} FILES</span>
             <div className="flex items-center gap-2 border border-primary/30 px-2 py-1">
               <span className="w-1.5 h-1.5 bg-primary rounded-full pulse-dot"></span>
               <span className="font-mono text-[9px] text-primary uppercase tracking-widest">ENCRYPTION: AES-256</span>
             </div>
             <span className="material-symbols-outlined text-text-muted text-[18px] cursor-pointer hover:text-white">settings</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6 terminal-grid bg-[#0a0a0a]/30">
          {error && (
            <div className="border border-danger/30 bg-danger/10 text-danger font-mono text-[12px] uppercase tracking-widest p-3">
              {error}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <span className={`font-mono text-[9px] uppercase tracking-widest mb-1 ${msg.role === 'user' ? 'text-primary' : 'text-primary'}`}>
                {msg.role === 'user' ? 'OPERATOR' : currentAgent?.refId || currentAgent?.name || 'AGENT'}
              </span>
              <div className={`p-4 max-w-[75%] ${
                msg.role === 'user'
                  ? 'bg-primary/10 border border-primary/30 text-white'
                  : 'bg-[#0a0a0a] border border-[#262626] text-white'
              }`}>
                {msg.isLoading ? (
                  <span className="font-mono text-primary text-[14px] font-bold cursor-blink">PROCESSING...</span>
                ) : (
                  <div className="text-[15px] leading-relaxed" style={{fontFamily: 'Inter'}}>
                    {renderMessageContent(msg.content)}
                  </div>
                )}
              </div>

              {msg.role === 'agent' && msg.metadata && (
                 <div className="mt-2 flex flex-col gap-2 items-start pl-1 fade-in">
                   <div className="flex gap-4 items-center">
                    <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">↑ {msg.metadata.tokensIn}  ↓ {msg.metadata.tokensOut}</span>
                    <button
                      onClick={() => setExpandedContexts(prev => ({ ...prev, [i]: !prev[i] }))}
                      className="flex items-center gap-1 cursor-pointer group"
                    >
                        <span className="material-symbols-outlined text-[14px] text-text-muted group-hover:text-white transition-colors">folder_open</span>
                        <span className="font-mono text-[9px] text-text-muted group-hover:text-white uppercase tracking-widest transition-colors">CONTEXT VECTORS:</span>
                    </button>
                    <span className={`border px-2 py-0.5 font-mono text-[8px] uppercase font-bold tracking-widest ${riskClass(msg.metadata.riskScore)}`}>
                      RISK: {msg.metadata.riskScore}
                    </span>
                   </div>
                   {expandedContexts[i] && (
                    <div className="flex flex-wrap gap-2">
                      {(msg.metadata.contextFilesUsed || []).length === 0 ? (
                        <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">NO CONTEXT INJECTED</span>
                      ) : resolveContextFiles(msg.metadata.contextFilesUsed, contextFiles).map((file) => (
                        <span key={file.id} className="border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary uppercase">{file.filename}</span>
                      ))}
                    </div>
                   )}
                 </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-[#262626] p-4 bg-[#0a0a0a] shrink-0">
          <div className="flex bg-[#050505] border border-[#262626] p-2 focus-within:border-primary transition-colors">
            <span className="font-mono text-[12px] text-primary uppercase font-bold mr-2 mt-2 ml-2">CMD:</span>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter neural command sequence..."
              className="flex-1 bg-transparent border-none text-white font-mono text-[13px] resize-none focus:outline-none min-h-[44px] max-h-[120px] p-2 placeholder:text-[#262626]"
            ></textarea>
            <button
              onClick={handleSend}
              disabled={!input.trim() || isSending || !currentAgent}
              className="bg-primary text-[#050505] font-mono text-[11px] font-bold uppercase tracking-widest px-4 flex items-center h-[44px] self-end hover:bg-white transition-colors cursor-pointer disabled:opacity-50"
            >
              TRANSMIT <span className="material-symbols-outlined text-[16px] ml-2">send</span>
            </button>
          </div>
          <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mt-2 ml-1">
            CTRL+ENTER TO TRANSMIT · EST. TOKENS: {Math.floor(input.length / 4)}
          </p>
        </div>
      </div>

      {/* RIGHT PANEL (Trace) */}
      <div className="relative flex-shrink-0 bg-[#050505] flex">
        <div
          onClick={() => setTraceOpen(!traceOpen)}
          className="w-[32px] border-l border-[#262626] bg-[#0a0a0a] flex items-center justify-center cursor-pointer hover:bg-[#141414] transition-colors group z-10"
        >
          <span className="material-symbols-outlined text-text-muted group-hover:text-white transition-colors text-[20px]">
            {traceOpen ? 'chevron_right' : 'chevron_left'}
          </span>
        </div>

        <div className={`overflow-y-auto bg-[#050505] border-l border-[#262626] transition-all duration-300 ease-in-out font-mono ${traceOpen ? 'w-[288px] opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
           <div className="p-4 border-b border-[#262626] flex flex-col gap-1">
             <span className="text-[12px] font-bold text-white uppercase tracking-widest">NEURAL TRACE</span>
             <span className="text-[9px] text-text-muted">{new Date().toISOString().replace('T',' ').substring(0,19)} UTC</span>
           </div>

           {!traceData ? (
             <div className="p-4">
               <span className="text-[10px] text-text-muted uppercase tracking-widest">No trace data. Send a message to see analysis.</span>
             </div>
           ) : (
             <>
               <div className="py-3 px-4 border-b border-[#262626] space-y-2">
                  <span className="text-[9px] text-text-muted uppercase tracking-widest block">INTENT</span>
                  <span className="inline-block border border-primary px-2 py-0.5 text-[10px] text-primary uppercase font-bold tracking-widest bg-primary/10">{traceData.intent || 'PENDING'}</span>
               </div>

               <div className="py-3 px-4 border-b border-[#262626] space-y-2">
                  <span className="text-[9px] text-text-muted uppercase tracking-widest block mb-2">CONTEXT VECTORS</span>
                  <div className="space-y-1">
                    {currentContext.length === 0 && traceData.excluded.length === 0 ? (
                      <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 bg-[#262626] rounded-full"></span>
                        <span className="text-[10px] text-text-muted truncate">NO CONTEXT</span>
                      </div>
                    ) : (
                      <>
                        {currentContext.map((file) => (
                          <div key={file.id} className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-primary rounded-full"></span>
                            <span className="text-[10px] text-white truncate">{file.filename}</span>
                          </div>
                        ))}
                        {traceData.excluded.map((file) => (
                          <div key={`${file.id}-${file.reason}`} className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-[#262626] rounded-full"></span>
                            <span className="text-[10px] text-text-muted truncate">{file.filename} / {file.reason}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
               </div>

               <div className="py-3 px-4 border-b border-[#262626] space-y-3">
                  <span className="text-[9px] text-text-muted uppercase tracking-widest block">TOKEN DISTRIBUTION</span>
                  <div>
                    <div className="flex justify-between text-[9px] mb-1">
                      <span className="text-white">INPUT</span>
                      <span className="text-primary">{latestTokens.input}</span>
                    </div>
                    <div className="h-1 bg-[#262626]"><div className="h-full bg-primary" style={{ width: `${tokenWidth(latestTokens.input, latestTokens.output)}%` }}></div></div>
                  </div>
                   <div>
                    <div className="flex justify-between text-[9px] mb-1">
                      <span className="text-white">OUTPUT</span>
                      <span className="text-primary">{latestTokens.output}</span>
                    </div>
                    <div className="h-1 bg-[#262626]"><div className="h-full bg-primary" style={{ width: `${tokenWidth(latestTokens.output, latestTokens.input)}%` }}></div></div>
                  </div>
               </div>

               <div className="py-3 px-4 border-b border-[#262626] space-y-1">
                  <span className="text-[9px] text-text-muted uppercase tracking-widest block mb-2">PERFORMANCE</span>
                  <p className="text-[11px] text-primary">DURATION: {traceData.durationMs || 0}MS</p>
               </div>

               <div className="py-3 px-4 border-b border-[#262626] flex flex-col items-center justify-center py-6">
                  <span className="text-[48px] font-bold leading-none" style={{ color: riskColor(currentRisk) }}>{String(currentRisk).padStart(2, '0')}</span>
                  <span className="border text-[10px] uppercase font-bold tracking-widest px-3 py-1 mt-2" style={{ color: riskColor(currentRisk), borderColor: `${riskColor(currentRisk)}55` }}>{riskLabel(currentRisk)}</span>
               </div>
             </>
           )}

           <div className="p-4 flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-[14px] text-primary">lock</span>
              <span className="text-[9px] text-primary uppercase font-bold tracking-[0.2em]">AES-256-GCM ACTIVE</span>
           </div>
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
    model: agent.model_provider,
    level: '1',
    knowledge: 'Base_Vectors',
    status: 'active',
    provider: agent.model_provider,
    systemPrompt: agent.system_prompt,
  };
}

function normalizeMessage(message) {
  return {
    role: message.role === 'assistant' ? 'agent' : message.role,
    content: message.content,
    timestamp: message.created_at || Date.now(),
  };
}

function mapError(err) {
  if (!err.response) return 'Connection failed. Is the server running?';
  const { status, data } = err.response;
  if (status === 400 && data?.error === 'invalid_api_key') return 'Invalid API key. Update it in Settings.';
  if (status === 400 && data?.error === 'request_blocked') return `Message blocked by security layer: ${data.violation || 'policy_violation'}`;
  if (status === 429 && data?.error === 'provider_rate_limit') return 'AI provider is rate limiting. Try again shortly.';
  if (status === 429 && data?.error === 'daily_limit_reached') return 'Request limit reached. Try again later or upgrade your plan.';
  return data?.message || data?.error || 'REQUEST FAILED';
}

function riskClass(score = 0) {
  if (score > 50) return 'border-danger/30 text-danger';
  if (score > 20) return 'border-warning/30 text-warning';
  return 'border-primary/30 text-primary';
}

function traceFromResponse(data) {
  return {
    intent: data.intent || 'unknown',
    contextIds: data.contextFilesUsed || [],
    excluded: data.excluded || [],
    tokensIn: data.tokensUsed?.input || 0,
    tokensOut: data.tokensUsed?.output || 0,
    durationMs: data.durationMs || 0,
    riskScore: data.riskScore ?? 0,
  };
}

function traceFromHistory(trace) {
  return {
    intent: trace.intent || 'unknown',
    contextIds: trace.context_injected || [],
    excluded: [],
    tokensIn: trace.tokens_used || 0,
    tokensOut: 0,
    durationMs: trace.duration_ms || 0,
    riskScore: trace.risk_score ?? 0,
  };
}

function resolveContextFiles(contextIds, contextFiles) {
  return (contextIds || []).map((id) => {
    const file = contextFiles.find((item) => item.id === id || item.filename === id);
    return {
      id,
      filename: file?.filename || id,
    };
  });
}

function getInjectedContext(traceData, contextFiles) {
  return resolveContextFiles(traceData?.contextIds || [], contextFiles);
}

function getTraceTokens(traceData) {
  return {
    input: traceData?.tokensIn || 0,
    output: traceData?.tokensOut || 0,
  };
}

function tokenWidth(value, otherValue) {
  const max = Math.max(value, otherValue, 1);
  return Math.max(4, Math.round((value / max) * 100));
}

function riskColor(score = 0) {
  if (score > 50) return '#ef4444';
  if (score > 20) return '#f59e0b';
  return '#10b981';
}

function riskLabel(score = 0) {
  if (score > 50) return 'CRITICAL';
  if (score > 20) return 'ELEVATED';
  return 'NOMINAL';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'JUST NOW';
  const ts = typeof timestamp === 'string' ? new Date(timestamp).getTime() : Number(timestamp);
  const diff = Date.now() - ts;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'JUST NOW';
  if (diff < hour) return `${Math.floor(diff / minute)}M AGO`;
  if (diff < day) return `${Math.floor(diff / hour)}H AGO`;
  return `${Math.floor(diff / day)}D AGO`;
}
