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
import { WORKFLOW_TEMPLATES } from '../constants/agentTemplates';
import HumanApprovalNode from '../components/WorkflowCanvas/nodes/HumanApprovalNode';

const EDGE_STYLE = { stroke: '#10b981', strokeWidth: 2 };
const NODE_DEFINITIONS = {
  fetch_url: {
    label: 'Fetch URL',
    icon: 'link',
    description: 'Fetches content from a URL and returns plain text',
    color: 'border-blue-500/40 bg-blue-500/5',
    inputs: ['url'],
    outputs: ['text'],
    config: {
      url: { type: 'text', placeholder: 'https://example.com/document', label: 'URL (optional - uses input if empty)' },
    },
  },
  fetch_api: {
    label: 'API Call',
    icon: 'api',
    description: 'Call any REST API with custom headers and authentication',
    color: 'border-purple-500/40 bg-purple-500/5',
    config: {
      url: { type: 'text', label: 'API URL', placeholder: 'https://api.example.com/endpoint' },
      method: { type: 'select', label: 'HTTP Method', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      authType: { type: 'select', label: 'Authentication', options: ['none', 'bearer', 'basic', 'apikey'], default: 'none' },
      authValue: { type: 'password', label: 'Auth Token / Credentials', placeholder: 'Token or username:password' },
      authHeader: { type: 'text', label: 'API Key Header Name', placeholder: 'X-API-Key' },
      headers: { type: 'textarea', label: 'Custom Headers (one per line: Key: Value)', placeholder: 'Content-Type: application/json\nX-Custom-Header: value' },
      body: { type: 'textarea', label: 'Request Body (JSON)', placeholder: '{"key": "value"}' },
    },
  },
  fetch_rss: {
    label: 'RSS Feed',
    icon: 'rss_feed',
    description: 'Monitor RSS/Atom feeds - EBA, ECB, FCA, ESMA, news sources',
    color: 'border-amber-500/40 bg-amber-500/5',
    config: {
      url: { type: 'text', label: 'RSS/Atom Feed URL', placeholder: 'https://www.eba.europa.eu/rss.xml' },
      maxItems: { type: 'select', label: 'Max articles to fetch', options: ['5', '10', '20', '50'], default: '10' },
    },
  },
  webhook_out: {
    label: 'Webhook Out',
    icon: 'webhook',
    description: 'POST workflow results to any external endpoint (Zapier, Slack, Make, Jira, etc.)',
    color: 'border-orange-500/40 bg-orange-500/5',
    config: {
      url: { type: 'text', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/... or https://hooks.zapier.com/...' },
      payloadMode: {
        type: 'select',
        label: 'Payload Mode',
        options: [
          { value: 'auto', label: 'Auto - Eudora envelope (recommended)' },
          { value: 'raw', label: 'Raw - send input directly' },
          { value: 'custom', label: 'Custom - use JSON template' },
        ],
        default: 'auto',
      },
      customPayload: { type: 'textarea', label: 'Custom JSON Template (use {{input}} for workflow output)', placeholder: '{"text": "Eudora alert: {{input}}"}' },
      secret: { type: 'password', label: 'Webhook Secret (optional - for HMAC signature)', placeholder: 'your-webhook-secret' },
      headers: { type: 'textarea', label: 'Custom Headers (optional, one per line: Key: Value)', placeholder: 'Authorization: Bearer token\nX-Custom: value' },
    },
  },
  send_email: {
    label: 'Send Email',
    icon: 'mail',
    description: 'Send an email notification from a workflow run',
    color: 'border-blue-500/40 bg-blue-500/5',
    config: {
      to: { type: 'text', label: 'Recipient Email', placeholder: 'compliance@yourcompany.com' },
      subject: { type: 'text', label: 'Subject', placeholder: 'Eudora Compliance Alert' },
      from: { type: 'text', label: 'From Address (optional - defaults to security@geteudora.com)', placeholder: 'alerts@yourcompany.com' },
      fromName: { type: 'text', label: 'From Name (optional)', placeholder: 'Eudora Compliance' },
      htmlMode: {
        type: 'select',
        label: 'Body Format',
        options: [
          { value: 'false', label: 'Plain text / markdown (auto-styled)' },
          { value: 'true', label: 'Raw HTML' },
        ],
        default: 'false',
      },
    },
  },
  human_approval: {
    label: 'Human Approval',
    icon: 'shield_person',
    description: 'Pause high-risk actions until designated human approvers decide',
    color: 'border-amber-500/40 bg-amber-500/5',
    config: {
      risk_threshold: { type: 'range', label: 'Risk threshold', default: 70 },
      required_approvers: { type: 'number', label: 'Required approvers', default: 1 },
      approver_user_ids: { type: 'multiselect', label: 'Designated approvers', default: [] },
      timeout_minutes: {
        type: 'select',
        label: 'Timeout',
        options: [
          { value: '15', label: '15 minutes' },
          { value: '30', label: '30 minutes' },
          { value: '60', label: '60 minutes' },
          { value: '120', label: '120 minutes' },
          { value: '240', label: '240 minutes' },
        ],
        default: '60',
      },
      on_timeout: {
        type: 'select',
        label: 'On timeout',
        options: [
          { value: 'reject', label: 'Reject' },
          { value: 'escalate_owner', label: 'Escalate to owner' },
        ],
        default: 'reject',
      },
      approval_message: {
        type: 'textarea',
        label: 'Approval message',
        placeholder: 'Review this agent action before it proceeds.',
        default: 'Review this agent action before it proceeds.',
      },
    },
  },
};

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

function FetchUrlNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-blue-400' : 'border-blue-500/40'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-blue-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-blue-400 text-[18px]">link</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.label || 'FETCH URL'}</h3>
        </div>
        <span className="border border-blue-500/40 bg-blue-500/10 px-2 py-1 font-mono text-[8px] text-blue-400 uppercase tracking-widest shrink-0">
          URL
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.config?.url || 'Uses incoming text as the URL when no URL is configured.'}
      </p>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-blue-400 !border-[#050505]" />
    </div>
  );
}

function FetchApiNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-purple-400' : 'border-purple-500/40'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-purple-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-purple-400 text-[18px]">api</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.label || 'API CALL'}</h3>
        </div>
        <span className="border border-purple-500/40 bg-purple-500/10 px-2 py-1 font-mono text-[8px] text-purple-400 uppercase tracking-widest shrink-0">
          {data.config?.method || 'GET'}
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.config?.url || 'Uses incoming text as the API URL when no URL is configured.'}
      </p>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-purple-400 !border-[#050505]" />
    </div>
  );
}

function FetchRssNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-amber-400' : 'border-amber-500/40'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-amber-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-amber-400 text-[18px]">rss_feed</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.label || 'RSS FEED'}</h3>
        </div>
        <span className="border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[8px] text-amber-400 uppercase tracking-widest shrink-0">
          {data.config?.maxItems || '10'} ITEMS
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.config?.url || 'Uses incoming text as the RSS or Atom feed URL.'}
      </p>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-amber-400 !border-[#050505]" />
    </div>
  );
}

function WebhookOutNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-orange-400' : 'border-orange-500/40'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-orange-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-orange-400 text-[18px]">webhook</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.label || 'WEBHOOK OUT'}</h3>
        </div>
        <span className="border border-orange-500/40 bg-orange-500/10 px-2 py-1 font-mono text-[8px] text-orange-400 uppercase tracking-widest shrink-0">
          POST
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.config?.url || 'Configure an external endpoint to receive workflow output.'}
      </p>
    </div>
  );
}

function SendEmailNode({ data, selected }) {
  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${selected ? 'border-blue-400' : 'border-blue-500/40'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-blue-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-blue-400 text-[18px]">mail</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{data.label || 'SEND EMAIL'}</h3>
        </div>
        <span className="border border-blue-500/40 bg-blue-500/10 px-2 py-1 font-mono text-[8px] text-blue-400 uppercase tracking-widest shrink-0">
          EMAIL
        </span>
      </div>
      <p
        className="font-mono text-[10px] text-text-muted leading-relaxed overflow-hidden"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
      >
        {data.config?.to || 'Configure a recipient for workflow notifications.'}
      </p>
    </div>
  );
}

const nodeTypes = {
  agent: AgentNode,
  fetch_url: FetchUrlNode,
  fetch_api: FetchApiNode,
  fetch_rss: FetchRssNode,
  webhook_out: WebhookOutNode,
  send_email: SendEmailNode,
  human_approval: HumanApprovalNode,
};

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
      setError(err.response?.data?.error === 'upgrade_required' ? 'Workflow builder is available on Professional and Enterprise plans' : err.response?.data?.error || 'Unable to create workflow');
    } finally {
      setCreating(false);
    }
  };

  const createResearchWorkflow = async (template) => {
    setCreating(true);
    setError('');
    try {
      const payload = buildWorkflowTemplatePayload(template, agents);
      const res = await api.post('/workflows', payload);
      navigate(`/workflows/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error === 'upgrade_required' ? 'Workflow builder is available on Professional and Enterprise plans' : err.response?.data?.error || 'Unable to create research workflow');
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

      {!loading && (
        <div className="border border-[#262626] bg-[#0a0a0a] p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">RESEARCH TEMPLATES</h2>
              <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest mt-1">COMPLIANCE RESEARCH CHAINS WITH URL FETCHING</p>
            </div>
            <span className="material-symbols-outlined text-primary text-[22px]">travel_explore</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {WORKFLOW_TEMPLATES.map((template) => (
              <div key={template.id} className="border border-[#262626] bg-[#050505] p-4 space-y-4 hover:border-primary/50 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">{template.name}</h3>
                  <span className={`border px-2 py-1 font-mono text-[8px] uppercase tracking-widest shrink-0 ${template.badge === 'RISK' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-primary/40 bg-primary/10 text-primary'}`}>
                    {template.badge}
                  </span>
                </div>
                <p className="font-mono text-[10px] text-text-muted leading-relaxed">{template.description}</p>
                <button
                  onClick={() => createResearchWorkflow(template)}
                  disabled={creating || (template.nodes.some(node => node.type === 'agent') && agents.length === 0)}
                  className="w-full border border-primary/40 bg-primary/10 text-primary px-4 py-2 font-mono text-[10px] uppercase font-bold tracking-widest disabled:opacity-40"
                >
                  USE TEMPLATE
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
  const [teamMembers, setTeamMembers] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savedRecently, setSavedRecently] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showTooltip, setShowTooltip] = useState(false);
  const savedStateTimerRef = useRef(null);
  const [nodes, setNodes, applyNodeChanges] = useNodesState([]);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState([]);

  const agentById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const selectedAgent = selectedNode?.data?.agent;
  const selectedDefinition = selectedNode?.type ? NODE_DEFINITIONS[selectedNode.type] : null;
  const outgoingEdges = edges.filter(edge => edge.source === selectedNodeId);

  useEffect(() => {
    try {
      setShowTooltip(localStorage.getItem('eudora-canvas-visited') !== 'true');
    } catch {
      setShowTooltip(false);
    }
  }, []);

  useEffect(() => () => {
    if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
  }, []);

  const markDirty = useCallback(() => {
    if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
    setSavedRecently(false);
    setIsDirty(true);
  }, []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setError('');
      try {
        const [workflowRes, agentRes, runsRes, teamRes] = await Promise.all([
          api.get(`/workflows/${workflowId}`),
          api.get('/agents'),
          api.get(`/workflows/${workflowId}/runs`, { params: { page: 1, limit: 5 } }),
          api.get('/team').catch(() => ({ data: { members: [] } })),
        ]);
        if (!mounted) return;
        setWorkflow(workflowRes.data);
        setWorkflowName(workflowRes.data.name || '');
        setDescription(workflowRes.data.description || '');
        setAgents(agentRes.data || []);
        setTeamMembers(teamRes.data?.members || []);
        setRuns(runsRes.data.runs || []);
        const lookup = new Map((agentRes.data || []).map(agent => [agent.id, agent]));
        setNodes((workflowRes.data.nodes || []).map(node => toFlowNode(node, lookup)));
        setEdges((workflowRes.data.edges || []).map(toFlowEdge));
        setIsDirty(false);
        setSavedRecently(false);
      } catch (err) {
        if (mounted) setError(err.response?.data?.error || 'Unable to load workflow');
      }
    }
    load();
    return () => { mounted = false; };
  }, [workflowId, setNodes, setEdges]);

  const onNodesChange = useCallback((changes) => {
    applyNodeChanges(changes);
    if (changes.some(change => !['select', 'dimensions'].includes(change.type))) markDirty();
  }, [applyNodeChanges, markDirty]);

  const onEdgesChange = useCallback((changes) => {
    applyEdgeChanges(changes);
    if (changes.some(change => change.type !== 'select')) markDirty();
  }, [applyEdgeChanges, markDirty]);

  const onConnect = useCallback((connection) => {
    setEdges((eds) => addEdge({
      ...connection,
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      style: EDGE_STYLE,
      animated: false,
      data: { condition: '' },
    }, eds));
    markDirty();
  }, [markDirty, setEdges]);

  const onDragStart = (event, agent) => {
    event.dataTransfer.setData('application/eudora-agent', JSON.stringify(agent));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onUtilityDragStart = (event, type) => {
    event.dataTransfer.setData('application/eudora-node-type', type);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const rawAgent = event.dataTransfer.getData('application/eudora-agent');
    const utilityType = event.dataTransfer.getData('application/eudora-node-type');

    if (rawAgent) {
      const agent = JSON.parse(rawAgent);
      const id = `node-${agent.id}-${Date.now()}`;
      setNodes((nds) => nds.concat({
        id,
        type: 'agent',
        position,
        data: { agentId: agent.id, agent, label: agent.name },
      }));
      markDirty();
      return;
    }

    if (utilityType && NODE_DEFINITIONS[utilityType]) {
      const definition = NODE_DEFINITIONS[utilityType];
      const id = `node-${utilityType}-${Date.now()}`;
      const config = Object.fromEntries(
        Object.entries(definition.config || {}).map(([key, field]) => [key, field.default ?? ''])
      );
      setNodes((nds) => nds.concat({
        id,
        type: utilityType,
        position,
        data: {
          label: definition.label,
          config,
        },
      }));
      markDirty();
    }
  }, [markDirty, screenToFlowPosition, setNodes]);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const saveWorkflow = async () => {
    if (!isDirty) return true;
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
      setIsDirty(false);
      setSavedRecently(true);
      if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
      savedStateTimerRef.current = setTimeout(() => {
        setSavedRecently(false);
        savedStateTimerRef.current = null;
      }, 2000);
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
      setError(err.response?.data?.error === 'upgrade_required' ? 'Workflow builder is available on Professional and Enterprise plans' : err.response?.data?.error || 'Unable to run workflow');
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
    markDirty();
  };

  const updateNodeConfig = (nodeId, key, value) => {
    if (!nodeId) return;
    setNodes((nds) => nds.map(node => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        config: {
          ...(node.data.config || {}),
          [key]: value,
        },
      },
    } : node));
    markDirty();
  };

  const updateAgentNode = (nodeId, agentId) => {
    const agent = agentById.get(agentId);
    if (!nodeId || !agent) return;
    setNodes((nds) => nds.map(node => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        agentId,
        agent,
        label: agent.name,
      },
    } : node));
    markDirty();
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter(node => node.id !== selectedNodeId));
    setEdges((eds) => eds.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
    markDirty();
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
    <TierGate feature="workflow_builder" message="Available on Professional and Enterprise plans">
      <div className="flex flex-col gap-4 fade-in w-full h-[calc(100vh-120px)] min-h-[720px]">
        <div className="border border-[#262626] bg-[#050505] px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <button onClick={() => navigate('/workflows')} className="font-mono text-[10px] text-text-muted hover:text-primary uppercase tracking-widest whitespace-nowrap">← Back to workflows</button>
            <input
              value={workflowName}
              onChange={(e) => {
                setWorkflowName(e.target.value);
                markDirty();
              }}
              className="bg-transparent font-mono text-[16px] text-white uppercase font-bold tracking-widest focus:outline-none border-b border-transparent focus:border-primary min-w-0 flex-1"
            />
          </div>
          <div className="flex items-center gap-3">
            {error && <span className="font-mono text-[10px] text-danger uppercase tracking-widest hidden lg:block">{error}</span>}
            <button
              onClick={saveWorkflow}
              disabled={saving || !isDirty}
              className={`border px-4 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors disabled:cursor-default ${
                savedRecently
                  ? 'border-primary/40 bg-primary/5 text-primary'
                  : isDirty
                  ? 'border-primary bg-primary text-[#050505] font-bold'
                  : 'border-[#262626] bg-[#0a0a0a] text-text-muted'
              }`}
            >
              {saving ? 'SAVING...' : savedRecently ? 'SAVED ✓' : isDirty ? 'SAVE CHANGES' : 'SAVED'}
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
            <div className="p-4 border-y border-[#262626]">
              <h2 className="font-mono text-[11px] text-white uppercase font-bold tracking-widest">UTILITY NODES</h2>
            </div>
            <div className="p-3 space-y-3">
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'fetch_url')}
                className="border border-blue-500/40 bg-blue-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-blue-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-blue-400 text-[16px]">link</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">Fetch URL</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">Fetches text content from a URL.</p>
              </div>
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'fetch_api')}
                className="border border-purple-500/40 bg-purple-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-purple-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-purple-400 text-[16px]">api</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">API Call</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">Calls a REST API with headers and authentication.</p>
              </div>
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'fetch_rss')}
                className="border border-amber-500/40 bg-amber-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-amber-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-amber-400 text-[16px]">rss_feed</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">RSS Feed</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">Monitors RSS and Atom feeds for new articles.</p>
              </div>
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'webhook_out')}
                className="border border-orange-500/40 bg-orange-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-orange-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-orange-400 text-[16px]">webhook</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">Webhook Out</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">POSTs workflow output to an external endpoint.</p>
              </div>
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'send_email')}
                className="border border-blue-500/40 bg-blue-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-blue-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-blue-400 text-[16px]">mail</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">Send Email</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">Sends workflow output through Resend.</p>
              </div>
              <div
                draggable
                onDragStart={(event) => onUtilityDragStart(event, 'human_approval')}
                className="border border-amber-500/40 bg-amber-500/5 p-3 cursor-grab active:cursor-grabbing hover:border-amber-400 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-amber-400 text-[16px]">shield_person</span>
                  <div className="font-mono text-[11px] text-white uppercase font-bold tracking-widest leading-tight">Human Approval</div>
                </div>
                <p className="font-mono text-[9px] text-text-muted leading-relaxed">Pauses high-risk actions for explicit review.</p>
              </div>
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
                  <p className="font-mono text-[10px] text-text-muted leading-relaxed">{selectedAgent?.purpose || selectedDefinition?.description || 'No purpose configured.'}</p>
                  {selectedNode.type === 'agent' && (
                    <div className="space-y-3 mt-4">
                      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">Agent</label>
                      <select
                        value={selectedNode.data.agentId || ''}
                        onChange={(event) => updateAgentNode(selectedNode.id, event.target.value)}
                        className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-primary"
                      >
                        {agents.map(agent => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                      <Link to="/agents" className="font-mono text-[10px] text-primary uppercase tracking-widest block hover:underline">View agent settings →</Link>
                    </div>
                  )}
                </div>

                {selectedNode.type === 'fetch_url' && (
                  <div className="space-y-2">
                    <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">URL</label>
                    <input
                      value={selectedNode.data.config?.url || ''}
                      onChange={(event) => updateNodeConfig(selectedNode.id, 'url', event.target.value)}
                      placeholder={NODE_DEFINITIONS.fetch_url.config.url.placeholder}
                      className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-primary placeholder:text-[#404040]"
                    />
                    <p className="font-mono text-[9px] text-text-muted/70 leading-relaxed">Leave empty to use the previous node output as the URL.</p>
                  </div>
                )}

                {selectedNode.type === 'fetch_api' && (
                  <div className="space-y-4">
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_api.config.url}
                      value={selectedNode.data.config?.url || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'url', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_api.config.method}
                      value={selectedNode.data.config?.method || 'GET'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'method', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_api.config.authType}
                      value={selectedNode.data.config?.authType || 'none'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'authType', value)}
                    />
                    {(selectedNode.data.config?.authType || 'none') !== 'none' && (
                      <ConfigInput
                        field={NODE_DEFINITIONS.fetch_api.config.authValue}
                        value={selectedNode.data.config?.authValue || ''}
                        onChange={(value) => updateNodeConfig(selectedNode.id, 'authValue', value)}
                      />
                    )}
                    {selectedNode.data.config?.authType === 'apikey' && (
                      <ConfigInput
                        field={NODE_DEFINITIONS.fetch_api.config.authHeader}
                        value={selectedNode.data.config?.authHeader || ''}
                        onChange={(value) => updateNodeConfig(selectedNode.id, 'authHeader', value)}
                      />
                    )}
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_api.config.headers}
                      value={selectedNode.data.config?.headers || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'headers', value)}
                    />
                    {(selectedNode.data.config?.method || 'GET') !== 'GET' && (
                      <ConfigInput
                        field={NODE_DEFINITIONS.fetch_api.config.body}
                        value={selectedNode.data.config?.body || ''}
                        onChange={(value) => updateNodeConfig(selectedNode.id, 'body', value)}
                      />
                    )}
                  </div>
                )}

                {selectedNode.type === 'fetch_rss' && (
                  <div className="space-y-4">
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_rss.config.url}
                      value={selectedNode.data.config?.url || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'url', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.fetch_rss.config.maxItems}
                      value={selectedNode.data.config?.maxItems || '10'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'maxItems', value)}
                    />
                    <p className="font-mono text-[9px] text-text-muted/70 leading-relaxed">Leave the URL empty to use the previous node output.</p>
                  </div>
                )}

                {selectedNode.type === 'webhook_out' && (
                  <div className="space-y-4">
                    <ConfigInput
                      field={NODE_DEFINITIONS.webhook_out.config.url}
                      value={selectedNode.data.config?.url || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'url', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.webhook_out.config.payloadMode}
                      value={selectedNode.data.config?.payloadMode || 'auto'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'payloadMode', value)}
                    />
                    {selectedNode.data.config?.payloadMode === 'custom' && (
                      <ConfigInput
                        field={NODE_DEFINITIONS.webhook_out.config.customPayload}
                        value={selectedNode.data.config?.customPayload || ''}
                        onChange={(value) => updateNodeConfig(selectedNode.id, 'customPayload', value)}
                      />
                    )}
                    <ConfigInput
                      field={NODE_DEFINITIONS.webhook_out.config.secret}
                      value={selectedNode.data.config?.secret || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'secret', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.webhook_out.config.headers}
                      value={selectedNode.data.config?.headers || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'headers', value)}
                    />
                  </div>
                )}

                {selectedNode.type === 'send_email' && (
                  <div className="space-y-4">
                    <ConfigInput
                      field={NODE_DEFINITIONS.send_email.config.to}
                      value={selectedNode.data.config?.to || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'to', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.send_email.config.subject}
                      value={selectedNode.data.config?.subject || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'subject', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.send_email.config.from}
                      value={selectedNode.data.config?.from || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'from', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.send_email.config.fromName}
                      value={selectedNode.data.config?.fromName || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'fromName', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.send_email.config.htmlMode}
                      value={selectedNode.data.config?.htmlMode || 'false'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'htmlMode', value)}
                    />
                  </div>
                )}

                {selectedNode.type === 'human_approval' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">Risk threshold</label>
                        <span className="font-mono text-[10px] text-amber-400">{selectedNode.data.config?.risk_threshold ?? 70}/100</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                        value={selectedNode.data.config?.risk_threshold ?? 70}
                        onChange={(event) => updateNodeConfig(selectedNode.id, 'risk_threshold', Number(event.target.value))}
                        className="w-full accent-amber-400"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">Required approvers</label>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={selectedNode.data.config?.required_approvers ?? 1}
                        onChange={(event) => updateNodeConfig(selectedNode.id, 'required_approvers', Math.min(5, Math.max(1, Number(event.target.value))))}
                        className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">Designated approvers</label>
                      <div className="border border-[#262626] bg-[#050505] divide-y divide-[#1a1a1a] max-h-44 overflow-y-auto">
                        {teamMembers.length === 0 ? (
                          <p className="p-3 font-mono text-[9px] text-text-muted">No team members available</p>
                        ) : teamMembers.map(member => {
                          const configuredIds = Array.isArray(selectedNode.data.config?.approver_user_ids)
                            ? selectedNode.data.config.approver_user_ids
                            : [];
                          const selected = configuredIds.includes(member.id);
                          return (
                            <label key={member.id} className="flex items-center gap-3 p-3 cursor-pointer hover:bg-white/[0.03]">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => {
                                  updateNodeConfig(
                                    selectedNode.id,
                                    'approver_user_ids',
                                    selected
                                      ? configuredIds.filter(id => id !== member.id)
                                      : [...configuredIds, member.id]
                                  );
                                }}
                                className="accent-amber-400"
                              />
                              <span className="min-w-0">
                                <span className="font-mono text-[10px] text-white block truncate">{member.name || member.email}</span>
                                <span className="font-mono text-[8px] text-text-muted block truncate">{member.email}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <ConfigInput
                      field={NODE_DEFINITIONS.human_approval.config.timeout_minutes}
                      value={String(selectedNode.data.config?.timeout_minutes || '60')}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'timeout_minutes', Number(value))}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.human_approval.config.on_timeout}
                      value={selectedNode.data.config?.on_timeout || 'reject'}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'on_timeout', value)}
                    />
                    <ConfigInput
                      field={NODE_DEFINITIONS.human_approval.config.approval_message}
                      value={selectedNode.data.config?.approval_message || ''}
                      onChange={(value) => updateNodeConfig(selectedNode.id, 'approval_message', value)}
                    />
                  </div>
                )}

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

function ConfigInput({ field, value, onChange }) {
  const baseClass = 'w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-primary placeholder:text-[#404040]';

  return (
    <div className="space-y-2">
      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block">{field.label}</label>
      {field.type === 'select' ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} className={baseClass}>
          {field.options.map((option) => {
            const optionValue = typeof option === 'string' ? option : option.value;
            const optionLabel = typeof option === 'string' ? option.toUpperCase() : option.label;
            return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
          })}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className={`${baseClass} min-h-[88px] resize-y`}
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          autoComplete={field.type === 'password' ? 'new-password' : undefined}
          className={baseClass}
        />
      )}
    </div>
  );
}

function toFlowNode(node, agentById) {
  if (node.type === 'fetch_url' || node.type === 'fetch_api' || node.type === 'fetch_rss' || node.type === 'webhook_out' || node.type === 'send_email' || node.type === 'human_approval') {
    const definition = NODE_DEFINITIONS[node.type];
    return {
      id: node.id,
      type: node.type,
      position: node.position || { x: 0, y: 0 },
      data: {
        label: node.label || definition.label,
        config: node.config || {},
      },
    };
  }

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
  if (node.type === 'fetch_url' || node.type === 'fetch_api' || node.type === 'fetch_rss' || node.type === 'webhook_out' || node.type === 'send_email' || node.type === 'human_approval') {
    const definition = NODE_DEFINITIONS[node.type];
    return {
      id: node.id,
      type: node.type,
      label: node.data.label || definition.label,
      config: node.data.config || {},
      position: node.position,
    };
  }

  return {
    id: node.id,
    type: 'agent',
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

function buildWorkflowTemplatePayload(template, agents) {
  const agentNodes = template.nodes.filter(node => node.type === 'agent');
  const assignedAgents = new Map(agentNodes.map((node, index) => [node.id, agents[index % Math.max(agents.length, 1)]]));
  const positionById = template.nodes.reduce((positions, node, index) => {
    const row = index % 2;
    const column = Math.floor(index / 2);
    positions[node.id] = { x: column * 320, y: 120 + row * 180 };
    return positions;
  }, {});

  return {
    name: template.name.toUpperCase(),
    description: template.description,
    nodes: template.nodes.map((node) => {
      if (node.type === 'fetch_url' || node.type === 'fetch_api' || node.type === 'fetch_rss' || node.type === 'webhook_out' || node.type === 'send_email') {
        return {
          id: node.id,
          type: node.type,
          label: node.label,
          config: node.config || {},
          position: positionById[node.id],
        };
      }

      const agent = assignedAgents.get(node.id);
      return {
        id: node.id,
        type: 'agent',
        agentId: agent?.id || null,
        label: node.label,
        position: positionById[node.id],
      };
    }),
    edges: template.edges.map((edge, index) => ({
      id: edge.id || `${template.id}-edge-${index + 1}`,
      source: edge.source,
      target: edge.target,
      condition: edge.condition || '',
    })),
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
