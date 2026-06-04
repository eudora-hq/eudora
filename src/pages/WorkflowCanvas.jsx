import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import api from '../api/client';
import { TierGate } from '../components/TierGate';

const EDGE_STYLE = { stroke: '#10b981', strokeWidth: 2 };

function AgentNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-primary' : 'border-[#262626]'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-primary !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.agent?.name || data.label || 'AGENT'}</h3>
        <span className="border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-[8px] text-primary uppercase tracking-widest shrink-0">
          {data.agent?.model_provider || data.agent?.provider || 'MODEL'}
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.agent?.purpose || 'No mission profile configured.'}
      </p>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-primary !border-[#050505]" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

export default function WorkflowCanvas() {
  const { id } = useParams();
  return id ? (
    <ReactFlowProvider>
      <WorkflowEditor workflowId={id} />
    </ReactFlowProvider>
  ) : (
    <WorkflowList />
  );
}

function WorkflowList() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [workflowRes, agentRes] = await Promise.all([
          api.get('/workflows'),
          api.get('/agents'),
        ]);
        const enriched = await Promise.all((workflowRes.data || []).map(async (workflow) => {
          try {
            const runsRes = await api.get(`/workflows/${workflow.id}/runs`, { params: { page: 1, limit: 1 } });
            return { ...workflow, lastRun: runsRes.data.runs?.[0] || null };
          } catch {
            return { ...workflow, lastRun: null };
          }
        }));
        if (mounted) {
          setWorkflows(enriched);
          setAgents(agentRes.data || []);
        }
      } catch (err) {
        if (mounted) setError(err.response?.data?.error || 'Unable to load workflows');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  const createWorkflow = async (template = false) => {
    setCreating(true);
    setError('');
    try {
      const payload = template ? buildStarterWorkflow(agents) : {
        name: 'UNTITLED WORKFLOW',
        description: '',
        nodes: [],
        edges: [],
      };
      const res = await api.post('/workflows', payload);
      navigate(`/workflows/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error === 'upgrade_required' ? 'Workflow builder is available on Team and Pro plans' : err.response?.data?.error || 'Unable to create workflow');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2 flex items-start justify-between gap-6">
        <div>
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">WORKFLOWS</h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">MULTI-AGENT EXECUTION CHAINS</p>
        </div>
        <button
          onClick={() => createWorkflow(false)}
          disabled={creating}
          className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50"
        >
          <span className="relative z-10">{creating ? 'CREATING...' : 'NEW WORKFLOW'}</span>
          <div className="scan-line"></div>
        </button>
      </div>

      {error && <div className="border border-danger/40 bg-danger/10 p-4 font-mono text-[11px] text-danger uppercase tracking-widest">{error}</div>}

      {loading ? (
        <div className="border border-[#262626] bg-[#0a0a0a] p-8 font-mono text-[10px] text-text-muted uppercase tracking-widest">LOADING WORKFLOWS...</div>
      ) : workflows.length === 0 ? (
        <div className="border border-[#262626] bg-[#0a0a0a] p-8 lg:p-10">
          <div className="max-w-2xl">
            <span className="material-symbols-outlined text-primary text-[32px] mb-6 block">account_tree</span>
            <h2 className="font-mono text-[18px] text-white uppercase font-bold tracking-widest mb-4">NO WORKFLOWS DEPLOYED</h2>
            <p className="font-mono text-[12px] text-text-muted leading-relaxed mb-8">
              Chain agents together into repeatable operations. Each node runs an agent, passes its output forward, and records a traceable run history.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => createWorkflow(false)}
                disabled={creating}
                className="bg-primary text-[#050505] px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-widest disabled:opacity-50"
              >
                BUILD YOUR FIRST WORKFLOW
              </button>
              <button
                onClick={() => createWorkflow(true)}
                disabled={creating || agents.length < 3}
                className="border border-[#262626] bg-[#050505] text-primary px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-widest disabled:opacity-40"
              >
                USE STARTER TEMPLATE
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              onClick={() => navigate(`/workflows/${workflow.id}`)}
              className="text-left border border-[#262626] bg-[#0a0a0a] p-6 hover:border-primary/60 transition-colors"
            >
              <div className="flex items-start justify-between gap-4 mb-6">
                <h2 className="font-mono text-[15px] text-white uppercase font-bold tracking-widest leading-tight">{workflow.name}</h2>
                <span className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest border ${statusClass(workflow.lastRun?.status)}`}>
                  {workflow.lastRun?.status || 'NO RUNS'}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono text-[10px] text-text-muted uppercase tracking-widest">
                <span>{workflow.nodes?.length || 0} NODES</span>
                <span>{workflow.lastRun ? relativeTime(workflow.lastRun.completed_at || workflow.lastRun.started_at) : 'NEVER RUN'}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowEditor({ workflowId }) {
  const navigate = useNavigate();
  const wrapperRef = useRef(null);
  const { screenToFlowPosition } = useReactFlow();
  const [workflow, setWorkflow] = useState(null);
  const [workflowName, setWorkflowName] = useState('');
  const [description, setDescription] = useState('');
  const [agents, setAgents] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showTooltip, setShowTooltip] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const selectedAgent = selectedNode?.data?.agent;
  const outgoingEdges = edges.filter(edge => edge.source === selectedNodeId);

  useEffect(() => {
    try {
      setShowTooltip(localStorage.getItem('eudora-canvas-visited') !== 'true');
    } catch {
      setShowTooltip(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setError('');
      try {
        const [workflowRes, agentRes, runsRes] = await Promise.all([
          api.get(`/workflows/${workflowId}`),
          api.get('/agents'),
          api.get(`/workflows/${workflowId}/runs`, { params: { page: 1, limit: 5 } }),
        ]);
        if (!mounted) return;
        setWorkflow(workflowRes.data);
        setWorkflowName(workflowRes.data.name || '');
        setDescription(workflowRes.data.description || '');
        setAgents(agentRes.data || []);
        setRuns(runsRes.data.runs || []);
        const lookup = new Map((agentRes.data || []).map(agent => [agent.id, agent]));
        setNodes((workflowRes.data.nodes || []).map(node => toFlowNode(node, lookup)));
        setEdges((workflowRes.data.edges || []).map(toFlowEdge));
      } catch (err) {
        if (mounted) setError(err.response?.data?.error || 'Unable to load workflow');
      }
    }
    load();
    return () => { mounted = false; };
  }, [workflowId, setNodes, setEdges]);

  const onConnect = useCallback((connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      style: EDGE_STYLE,
      animated: false,
      data: { condition: '' },
    }, eds));
  }, [setEdges]);

  const onDragStart = (event, agent) => {
    event.dataTransfer.setData('application/eudora-agent', JSON.stringify(agent));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/eudora-agent');
    if (!raw) return;
    const agent = JSON.parse(raw);
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = `node-${agent.id}-${Date.now()}`;
    setNodes((nds) => nds.concat({
      id,
      type: 'agent',
      position,
      data: { agentId: agent.id, agent, label: agent.name },
    }));
  }, [screenToFlowPosition, setNodes]);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const saveWorkflow = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: workflowName || 'UNTITLED WORKFLOW',
        description,
        nodes: nodes.map(fromFlowNode),
        edges: edges.map(fromFlowEdge),
      };
      const res = await api.patch(`/workflows/${workflowId}`, payload);
      setWorkflow(res.data);
      return true;
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to save workflow');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runWorkflow = async () => {
    setRunning(true);
    setError('');
    try {
      const saved = await saveWorkflow();
      if (!saved) {
        setRunning(false);
        return;
      }
      const res = await api.post(`/workflows/${workflowId}/run`, { trigger: 'manual' });
      pollRun(res.data.runId);
    } catch (err) {
      setRunning(false);
      setError(err.response?.data?.error === 'upgrade_required' ? 'Workflow builder is available on Team and Pro plans' : err.response?.data?.error || 'Unable to run workflow');
    }
  };

  const pollRun = (runId) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const res = await api.get(`/workflows/${workflowId}/runs`, { params: { page: 1, limit: 5 } });
        const nextRuns = res.data.runs || [];
        setRuns(nextRuns);
        const current = nextRuns.find(run => run.id === runId);
        if ((current && current.status !== 'running') || attempts >= 30) {
          clearInterval(interval);
          setRunning(false);
          setExpandedRunId(runId);
          setHistoryOpen(true);
        }
      } catch {
        clearInterval(interval);
        setRunning(false);
      }
    }, 2000);
  };

  const updateEdgeCondition = (edgeId, condition) => {
    setEdges((eds) => eds.map(edge => edge.id === edgeId ? { ...edge, condition, data: { ...(edge.data || {}), condition } } : edge));
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter(node => node.id !== selectedNodeId));
    setEdges((eds) => eds.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  const dismissTooltip = () => {
    try {
      localStorage.setItem('eudora-canvas-visited', 'true');
    } catch {
      // Local storage can be unavailable in private browser contexts.
    }
    setShowTooltip(false);
  };

  return (
    <TierGate feature="workflow_builder" message="Available on Team and Pro plans">
      <div className="flex flex-col gap-4 fade-in w-full h-[calc(100vh-120px)] min-h-[720px]">
        <div className="border border-[#262626] bg-[#050505] px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <button onClick={() => navigate('/workflows')} className="font-mono text-[10px] text-text-muted hover:text-primary uppercase tracking-widest whitespace-nowrap">← Back to workflows</button>
            <input
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              className="bg-transparent font-mono text-[16px] text-white uppercase font-bold tracking-widest focus:outline-none border-b border-transparent focus:border-primary min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-3">
            {error && <span className="font-mono text-[10px] text-danger uppercase tracking-widest hidden lg:block">{error}</span>}
            <button onClick={saveWorkflow} disabled={saving} className="border border-[#262626] bg-[#0a0a0a] text-white px-4 py-2 font-mono text-[10px] uppercase tracking-widest disabled:opacity-50">
              {saving ? 'SAVING...' : 'SAVE'}
            </button>
            <button onClick={runWorkflow} disabled={running || nodes.length === 0} className="bg-primary text-[#050505] px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest disabled:opacity-50">
              {running ? 'RUNNING...' : 'RUN NOW'}
            </button>
          </div>
        </div>

        {error && <div className="lg:hidden border border-danger/40 bg-danger/10 p-3 font-mono text-[10px] text-danger uppercase tracking-widest">{error}</div>}

        <div className="grid flex-1 min-h-0 border border-[#262626] bg-[#050505]" style={{ gridTemplateColumns: '200px minmax(0, 1fr) 280px' }}>
          <aside className="border-r border-[#262626] bg-[#0a0a0a] overflow-y-auto">
            <div className="p-4 border-b border-[#262626]">
              <h2 className="font-mono text-[11px] text-white uppercase font-bold tracking-widest">AGENT PALETTE</h2>
            </div>
            <div className="p-3 space-y-3">
              {agents.length === 0 ? (
                <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">NO AGENTS AVAILABLE</span>
              ) : agents.map(agent => (
                <div
                  key={agent.id}
                  draggable
                  onDragStart={(event) => onDragStart(event, agent)}
                  className="border border-[#262626] bg-[#050505] p-3 cursor-grab active:cursor-grabbing hover:border-primary/60 transition-colors"
                >
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight mb-2">{agent.name}</div>
                  <span className="border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-[8px] text-primary uppercase tracking-widest">
                    {agent.model_provider || agent.provider || 'MODEL'}
                  </span>
                </div>
              ))}
            </div>
          </aside>

          <main ref={wrapperRef} className="relative min-w-0 min-h-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              onDrop={onDrop}
              onDragOver={onDragOver}
              fitView
              defaultEdgeOptions={{ style: EDGE_STYLE }}
              className="bg-[#050505]"
            >
              <Background variant="dots" color="#262626" gap={18} size={1} />
              <Controls className="!bg-[#0a0a0a] !border !border-[#262626]" />
            </ReactFlow>
            {showTooltip && <CanvasTooltip onDismiss={dismissTooltip} />}
          </main>

          <aside className="border-l border-[#262626] bg-[#0a0a0a] overflow-y-auto">
            <div className="p-4 border-b border-[#262626]">
              <h2 className="font-mono text-[11px] text-white uppercase font-bold tracking-widest">NODE CONFIG</h2>
            </div>
            {selectedNode ? (
              <div className="p-4 space-y-6">
                <div>
                  <h3 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest mb-2">{selectedAgent?.name || selectedNode.data.label}</h3>
                  <p className="font-mono text-[10px] text-text-muted leading-relaxed">{selectedAgent?.purpose || 'No purpose configured.'}</p>
                  <Link to="/agents" className="font-mono text-[10px] text-primary uppercase tracking-widest mt-4 block hover:underline">View agent settings →</Link>
                </div>

                <div className="space-y-3">
                  <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">EDGE CONDITIONS</label>
                  {outgoingEdges.length === 0 ? (
                    <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">NO OUTGOING EDGES</p>
                  ) : outgoingEdges.map(edge => {
                    const target = nodes.find(node => node.id === edge.target);
                    return (
                      <div key={edge.id} className="border border-[#262626] bg-[#050505] p-3">
                        <div className="font-mono text-[9px] text-primary uppercase tracking-widest mb-2">TO {target?.data?.agent?.name || target?.data?.label || edge.target}</div>
                        <textarea
                          value={edge.data?.condition || edge.condition || ''}
                          onChange={(event) => updateEdgeCondition(edge.id, event.target.value)}
                          placeholder="Only continue if output contains..."
                          className="w-full bg-transparent border border-[#262626] text-white font-mono text-[11px] p-3 min-h-[84px] resize-none focus:outline-none focus:border-primary placeholder:text-[#404040]"
                        />
                      </div>
                    );
                  })}
                </div>

                <button onClick={removeSelectedNode} className="w-full border border-danger/40 text-danger px-4 py-3 font-mono text-[10px] uppercase tracking-widest hover:bg-danger/10">
                  REMOVE NODE
                </button>
              </div>
            ) : (
              <div className="p-4 font-mono text-[10px] text-text-muted uppercase tracking-widest leading-relaxed">
                SELECT A NODE TO CONFIGURE CONDITIONS OR REMOVE IT FROM THE WORKFLOW.
              </div>
            )}
          </aside>
        </div>

        <div className="border border-[#262626] bg-[#0a0a0a]">
          <button onClick={() => setHistoryOpen(!historyOpen)} className="w-full px-4 py-3 flex items-center justify-between bg-[#050505] border-b border-[#262626]">
            <span className="font-mono text-[11px] text-white uppercase font-bold tracking-widest">RUN HISTORY</span>
            <span className="material-symbols-outlined text-primary text-[18px]">{historyOpen ? 'expand_more' : 'chevron_right'}</span>
          </button>
          {historyOpen && (
            <div className="divide-y divide-[#262626] max-h-[260px] overflow-y-auto">
              {runs.length === 0 ? (
                <div className="p-4 font-mono text-[10px] text-text-muted uppercase tracking-widest">NO RUNS RECORDED</div>
              ) : runs.map(run => (
                <div key={run.id}>
                  <button onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)} className="w-full px-4 py-3 flex items-center justify-between text-left">
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest border ${statusClass(run.status)}`}>{run.status}</span>
                      <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">{relativeTime(run.completed_at || run.started_at)}</span>
                    </div>
                    <span className="material-symbols-outlined text-text-muted text-[16px]">{expandedRunId === run.id ? 'expand_more' : 'chevron_right'}</span>
                  </button>
                  {expandedRunId === run.id && (
                    <div className="px-4 pb-4 space-y-2">
                      {(run.node_results || []).map((result) => (
                        <div key={result.nodeId} className="border border-[#262626] bg-[#050505] p-3">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <span className="font-mono text-[10px] text-primary uppercase tracking-widest">{result.nodeId}</span>
                            <span className={`font-mono text-[8px] uppercase tracking-widest ${result.status === 'success' ? 'text-primary' : result.status === 'skipped' ? 'text-text-muted' : 'text-danger'}`}>{result.status}</span>
                          </div>
                          <p className="font-mono text-[10px] text-text-muted leading-relaxed whitespace-pre-wrap">{result.output || 'No output'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </TierGate>
  );
}

function CanvasTooltip({ onDismiss }) {
  return (
    <div className="absolute inset-0 z-20 bg-[#050505]/75 backdrop-blur-[1px] pointer-events-auto">
      <div className="absolute left-[-176px] top-[120px] flex items-center gap-3">
        <div className="border border-primary/40 bg-[#0a0a0a] px-4 py-3 shadow-lg">
          <span className="font-mono text-[10px] text-primary uppercase font-bold tracking-widest">Drag agents here</span>
        </div>
        <svg width="72" height="24" viewBox="0 0 72 24" fill="none" aria-hidden="true">
          <path d="M1 12H64" stroke="#10b981" strokeWidth="2" />
          <path d="M58 4L70 12L58 20" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-primary/40 bg-[#0a0a0a] p-6 max-w-[360px] text-center shadow-lg">
        <svg className="mx-auto mb-4" width="140" height="40" viewBox="0 0 140 40" fill="none" aria-hidden="true">
          <path d="M10 20H130" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
          <path d="M122 10L134 20L122 30" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <h3 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest mb-3">Connect them with edges</h3>
        <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest leading-relaxed mb-6">Drag from an output handle to another node input to define execution order.</p>
        <button onClick={onDismiss} className="bg-primary text-[#050505] px-6 py-3 font-mono text-[10px] font-bold uppercase tracking-widest">Got it</button>
      </div>

      <div className="absolute right-[20px] top-[-54px] flex items-end gap-3">
        <svg width="46" height="62" viewBox="0 0 46 62" fill="none" aria-hidden="true">
          <path d="M42 60C42 22 18 10 4 4" stroke="#10b981" strokeWidth="2" />
          <path d="M5 16L4 4L16 7" stroke="#10b981" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <div className="border border-primary/40 bg-[#0a0a0a] px-4 py-3 shadow-lg">
          <span className="font-mono text-[10px] text-primary uppercase font-bold tracking-widest">Save and run</span>
        </div>
      </div>
    </div>
  );
}

function toFlowNode(node, agentById) {
  const agent = agentById.get(node.agentId);
  return {
    id: node.id,
    type: 'agent',
    position: node.position || { x: 0, y: 0 },
    data: {
      agentId: node.agentId,
      agent,
      label: node.label || agent?.name || 'Agent',
    },
  };
}

function fromFlowNode(node) {
  return {
    id: node.id,
    agentId: node.data.agentId,
    label: node.data.label || node.data.agent?.name || 'Agent',
    position: node.position,
  };
}

function toFlowEdge(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    style: EDGE_STYLE,
    data: { condition: edge.condition || '' },
    condition: edge.condition || '',
  };
}

function fromFlowEdge(edge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    condition: edge.data?.condition || edge.condition || '',
  };
}

function buildStarterWorkflow(agents) {
  const firstThree = agents.slice(0, 3);
  return {
    name: 'STARTER WORKFLOW',
    description: 'Research, summarise, and report on the requested task.',
    nodes: firstThree.map((agent, index) => ({
      id: `starter-${index + 1}`,
      agentId: agent.id,
      label: ['Research', 'Summarise', 'Report'][index],
      position: { x: index * 300, y: 160 },
    })),
    edges: [
      { id: 'starter-e1', source: 'starter-1', target: 'starter-2', condition: '' },
      { id: 'starter-e2', source: 'starter-2', target: 'starter-3', condition: '' },
    ].filter((edge) => firstThree.length > Number(edge.target.split('-')[1]) - 1),
  };
}

function statusClass(status) {
  if (status === 'success') return 'border-primary/40 bg-primary/10 text-primary';
  if (status === 'failed') return 'border-danger/40 bg-danger/10 text-danger';
  if (status === 'running') return 'border-warning/40 bg-warning/10 text-warning';
  return 'border-[#262626] bg-[#050505] text-text-muted';
}

function relativeTime(timestamp) {
  if (!timestamp) return 'UNKNOWN';
  const diff = Date.now() - Number(timestamp);
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return 'JUST NOW';
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  return `${Math.floor(hours / 24)}D AGO`;
}
