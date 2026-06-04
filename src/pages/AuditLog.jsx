import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import api from '../api/client';

const ACTIONS = [
  'chat_message',
  'guard_block',
  'scope_violation',
  'injection_detected',
  'cron_run',
  'login',
  'logout',
  'agent_created',
  'context_upload',
  'api_key_added',
];

const LIMIT = 50;

export default function AuditLog() {
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [action, setAction] = useState('');
  const [minRiskScore, setMinRiskScore] = useState('');
  const [expanded, setExpanded] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);

  const fetchAudit = async (nextPage = page) => {
    setIsLoading(true);
    setError('');

    try {
      const res = await api.get('/audit', {
        params: {
          page: nextPage,
          limit: LIMIT,
          ...(action ? { action } : {}),
          ...(minRiskScore !== '' ? { minRiskScore } : {}),
        },
      });
      setEvents(res.data.events);
      setTotal(res.data.total);
      setPage(res.data.page);
      setPages(res.data.pages || 1);
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to load audit events');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAudit(1);
    const interval = setInterval(() => fetchAudit(1), 30000);
    return () => clearInterval(interval);
  }, [action, minRiskScore]);

  const clearFilters = () => {
    setAction('');
    setMinRiskScore('');
    setExpanded({});
  };

  const handleExport = async () => {
    setError('');
    try {
      await api.get('/audit/export', { params: { format: 'json' } });
    } catch (err) {
      if (err.response?.status === 403) {
        setShowUpgrade(true);
      } else {
        setError(err.response?.data?.error || 'Unable to export audit log');
      }
    }
  };

  const start = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const end = Math.min(page * LIMIT, total);

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2 flex items-start justify-between">
        <div>
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">AUDIT LOG</h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">SECURITY EVENT TRACE</p>
        </div>
        <button onClick={handleExport} className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer">
          <span className="relative z-10">EXPORT</span>
          <div className="scan-line"></div>
        </button>
      </div>

      <div className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
        <div className="flex flex-col md:flex-row md:items-end gap-6">
          <div className="space-y-2">
            <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">ACTION TYPE</label>
            <select value={action} onChange={(e) => setAction(e.target.value)} className="bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary uppercase appearance-none cursor-pointer min-w-[220px]">
              <option value="">ALL ACTIONS</option>
              {ACTIONS.map(item => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">MIN RISK SCORE</label>
            <input type="number" min="0" max="100" value={minRiskScore} onChange={(e) => setMinRiskScore(e.target.value)} className="bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary w-[180px]" />
          </div>
          <button onClick={clearFilters} className="font-mono text-[10px] text-text-muted hover:text-white uppercase tracking-widest transition-colors cursor-pointer pb-3">Clear filters</button>
          <button onClick={() => fetchAudit(1)} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-3 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer md:ml-auto">
            REFRESH
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-danger/30 bg-danger/10 text-danger font-mono text-[12px] uppercase tracking-widest p-3">
          {error}
        </div>
      )}

      <div className="border border-[#262626] bg-[#0a0a0a] flex flex-col">
        <div className="grid grid-cols-[1.4fr_1fr_0.7fr_48px] gap-4 px-6 py-4 border-b border-[#262626] bg-[#050505]">
          <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]">Timestamp</span>
          <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]">Action badge</span>
          <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]">Risk score</span>
          <span className="font-mono text-[10px] text-primary uppercase tracking-[0.15em]"></span>
        </div>

        {events.length === 0 ? (
          <div className="p-8 text-center">
            <span className="font-mono text-[12px] text-text-muted uppercase tracking-widest">{isLoading ? 'LOADING AUDIT EVENTS...' : 'NO AUDIT EVENTS'}</span>
          </div>
        ) : events.map(event => (
          <div key={event.id} className="border-b border-[#262626]">
            <button onClick={() => setExpanded(prev => ({ ...prev, [event.id]: !prev[event.id] }))} className="grid grid-cols-[1.4fr_1fr_0.7fr_48px] gap-4 items-center w-full text-left px-6 py-4 hover:bg-[#050505] transition-colors cursor-pointer">
              <span className="font-mono text-[12px] text-white uppercase tracking-widest">{formatTimestamp(event.ts)}</span>
              <span className={`inline-flex w-fit border px-2 py-1 font-mono text-[9px] uppercase font-bold tracking-widest ${actionClass(event.action)}`}>{event.action}</span>
              <span className={`inline-flex w-fit border px-2 py-1 font-mono text-[9px] uppercase font-bold tracking-widest ${riskClass(event.risk_score)}`}>RISK: {event.risk_score}</span>
              <span className="material-symbols-outlined text-text-muted text-[20px]">{expanded[event.id] ? 'expand_less' : 'expand_more'}</span>
            </button>
            {expanded[event.id] && (
              <div className="px-6 pb-6">
                <pre className="bg-[#050505] border border-[#262626] p-4 overflow-x-auto font-mono text-[12px] text-white leading-relaxed">
{JSON.stringify(event.metadata || {}, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">Showing {start}-{end} of {total} events</span>
        <div className="flex gap-4">
          <button onClick={() => fetchAudit(page - 1)} disabled={page <= 1 || isLoading} className="border border-[#262626] text-text-muted hover:border-primary hover:text-white px-4 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-40">
            PREV
          </button>
          <button onClick={() => fetchAudit(page + 1)} disabled={page >= pages || isLoading} className="border border-[#262626] text-text-muted hover:border-primary hover:text-white px-4 py-2 font-mono text-[9px] uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-40">
            NEXT
          </button>
        </div>
      </div>

      {showUpgrade && (
        <div className="fixed inset-0 z-50 bg-[#050505]/90 backdrop-blur flex items-center justify-center p-8">
          <div className="w-full max-w-[420px] border border-[#262626] bg-[#0a0a0a] p-8">
            <div className="flex items-center justify-between border-b border-[#262626] pb-4 mb-6">
              <h3 className="font-mono text-[13px] text-primary uppercase font-bold tracking-widest">UPGRADE REQUIRED</h3>
              <button onClick={() => setShowUpgrade(false)} className="text-text-muted hover:text-white transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <p className="font-sans text-[15px] text-white leading-relaxed mb-6">Audit export is available on the Pro plan</p>
            <button className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer w-full">
              <span className="relative z-10">UPGRADE</span>
              <div className="scan-line"></div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(timestamp) {
  try {
    return format(new Date(Number(timestamp)), 'yyyy-MM-dd HH:mm:ss');
  } catch {
    return new Date(Number(timestamp)).toLocaleString();
  }
}

function actionClass(action) {
  if (['guard_block', 'injection_detected'].includes(action)) return 'border-danger/30 text-danger bg-danger/10';
  if (action === 'scope_violation') return 'border-warning/30 text-warning bg-warning/10';
  if (['cron_run', 'login', 'logout'].includes(action)) return 'border-blue-500/30 text-blue-400 bg-blue-500/10';
  if (['agent_created', 'context_upload', 'api_key_added'].includes(action)) return 'border-primary/30 text-primary bg-primary/10';
  return 'border-[#262626] text-text-muted bg-[#050505]';
}

function riskClass(score = 0) {
  if (score > 50) return 'border-danger/30 text-danger bg-danger/10';
  if (score > 20) return 'border-warning/30 text-warning bg-warning/10';
  return 'border-primary/30 text-primary bg-primary/10';
}
