import { useEffect, useMemo, useState } from 'react';
import cronParser from 'cron-parser';
import { format, formatDistanceToNow } from 'date-fns';
import api from '../api/client';

const PRESETS = [
  { id: 'every_hour', label: 'Every hour', icon: 'schedule', schedule: '0 * * * *' },
  { id: 'daily_9am', label: 'Every day', icon: 'wb_sunny', schedule: '0 9 * * *' },
  { id: 'weekly_monday', label: 'Every week', icon: 'calendar_today', schedule: '0 9 * * 1' },
  { id: 'monthly', label: 'Every month', icon: 'calendar_month', schedule: '0 9 1 * *' },
  { id: 'custom', label: 'Custom', icon: 'tune', schedule: '* * * * *' },
];

const FIELD_RULES = [
  { key: 'minute', label: 'MINUTE 0-59', min: 0, max: 59 },
  { key: 'hour', label: 'HOUR 0-23', min: 0, max: 23 },
  { key: 'day', label: 'DAY 1-31', min: 1, max: 31 },
  { key: 'month', label: 'MONTH 1-12', min: 1, max: 12 },
  { key: 'weekday', label: 'WEEKDAY 0-6', min: 0, max: 6 },
];

const WEEKDAYS = [
  ['1', 'MON'],
  ['2', 'TUE'],
  ['3', 'WED'],
  ['4', 'THU'],
  ['5', 'FRI'],
  ['6', 'SAT'],
  ['0', 'SUN'],
];

export default function CronJobs() {
  const [jobs, setJobs] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('list');
  const [editingJob, setEditingJob] = useState(null);
  const [historyJob, setHistoryJob] = useState(null);
  const [showFirstVisitTip, setShowFirstVisitTip] = useState(() => localStorage.getItem('eudora-cron-visited') !== 'true');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [jobsRes, agentsRes] = await Promise.all([
        api.get('/cron'),
        api.get('/agents'),
      ]);
      setJobs(jobsRes.data || []);
      setAgents(agentsRes.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load scheduled jobs');
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingJob(null);
    setMode('form');
  };

  const openEdit = async (job) => {
    setError('');
    try {
      const res = await api.get(`/cron/${job.id}`);
      setEditingJob({ ...job, ...res.data });
      setMode('form');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load scheduled job');
    }
  };

  const handleToggle = async (job) => {
    const nextEnabled = job.enabled ? 0 : 1;
    setJobs((prev) => prev.map((item) => item.id === job.id ? { ...item, enabled: nextEnabled } : item));
    try {
      const res = await api.patch(`/cron/${job.id}`, { enabled: nextEnabled });
      setJobs((prev) => prev.map((item) => item.id === job.id ? { ...item, ...res.data } : item));
    } catch (err) {
      setJobs((prev) => prev.map((item) => item.id === job.id ? { ...item, enabled: job.enabled } : item));
      setError(err.response?.data?.message || 'Unable to update scheduled job');
    }
  };

  const handleDelete = async (job) => {
    if (!window.confirm(`Delete ${job.name}?`)) return;
    try {
      await api.delete(`/cron/${job.id}`);
      setJobs((prev) => prev.filter((item) => item.id !== job.id));
      if (historyJob?.id === job.id) setHistoryJob(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to delete scheduled job');
    }
  };

  const handleSaved = (savedJob) => {
    setJobs((prev) => {
      const exists = prev.some((item) => item.id === savedJob.id);
      return exists
        ? prev.map((item) => item.id === savedJob.id ? { ...item, ...savedJob } : item)
        : [{ ...savedJob, agent_name: agents.find((agent) => agent.id === savedJob.agent_id)?.name || 'UNKNOWN AGENT' }, ...prev];
    });
    setMode('list');
    setEditingJob(null);
  };

  if (mode === 'form') {
    return (
      <CronJobForm
        agents={agents}
        job={editingJob}
        onCancel={() => {
          setMode('list');
          setEditingJob(null);
        }}
        onSaved={handleSaved}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2 flex items-start justify-between">
        <div>
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">SCHEDULED JOBS</h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">AUTOMATED AGENT OPERATIONS</p>
        </div>
        <button
          onClick={openCreate}
          className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer"
        >
          <span className="relative z-10">NEW SCHEDULED JOB</span>
          <div className="scan-line"></div>
        </button>
      </div>

      {error && (
        <div className="border border-danger/40 bg-danger/10 px-4 py-3 font-mono text-[11px] text-danger uppercase tracking-widest">{error}</div>
      )}

      <div className="border border-[#262626] bg-[#0a0a0a]">
        <div className="px-6 py-4 border-b border-[#262626] bg-[#050505] flex items-center justify-between">
          <span className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">RUN SCHEDULE</span>
          <button onClick={loadData} className="font-mono text-[10px] text-primary uppercase tracking-widest hover:underline">REFRESH</button>
        </div>

        {loading ? (
          <div className="p-8 text-center font-mono text-[10px] text-text-muted uppercase tracking-widest">LOADING SCHEDULED JOBS...</div>
        ) : jobs.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center gap-5">
            <span className="material-symbols-outlined text-primary text-[44px]">calendar_clock</span>
            <div>
              <h2 className="font-mono text-[16px] text-white font-bold uppercase tracking-widest mb-2">NO SCHEDULED JOBS</h2>
              <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">Schedule your agents to run automatically on any timetable</p>
            </div>
            <button onClick={openCreate} className="bg-primary text-[#050505] px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-widest">
              SCHEDULE FIRST RUN
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#262626]">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onToggle={() => handleToggle(job)}
                onHistory={() => setHistoryJob(job)}
                onEdit={() => openEdit(job)}
                onDelete={() => handleDelete(job)}
              />
            ))}
          </div>
        )}
      </div>

      {historyJob && (
        <RunHistoryPanel job={historyJob} onClose={() => setHistoryJob(null)} />
      )}

      {showFirstVisitTip && mode === 'list' && (
        <div className="fixed inset-0 z-[70] bg-[#050505]/70 flex items-center justify-center p-6">
          <div className="border border-primary/30 bg-[#0a0a0a] max-w-[520px] p-6 shadow-2xl">
            <div className="flex items-start gap-4">
              <span className="material-symbols-outlined text-primary text-[28px]">calendar_clock</span>
              <div className="flex-1">
                <p className="font-mono text-[12px] text-white uppercase tracking-widest leading-relaxed">
                  Scheduled jobs run your agents automatically on any timetable — hourly, daily, weekly, or a custom schedule.
                </p>
                <button
                  onClick={() => {
                    localStorage.setItem('eudora-cron-visited', 'true');
                    setShowFirstVisitTip(false);
                  }}
                  className="mt-6 bg-primary text-[#050505] px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-widest"
                >
                  GOT IT
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onToggle, onHistory, onEdit, onDelete }) {
  const scheduleLabel = job.preset ? presetLabel(job.preset) : humanizeSchedule(job.schedule);
  const status = job.last_run_status || 'never';

  return (
    <div className="px-6 py-5 grid grid-cols-1 xl:grid-cols-[1.4fr_1fr_1fr_1fr_auto] gap-4 items-center hover:bg-white/[0.02] transition-colors">
      <div>
        <h3 className="font-mono text-[14px] text-white font-bold uppercase tracking-widest mb-2">{job.name}</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="border border-primary/30 bg-primary/10 text-primary px-2 py-1 font-mono text-[9px] uppercase tracking-widest">{job.agent_name || 'UNKNOWN AGENT'}</span>
          <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{job.enabled ? 'ENABLED' : 'DISABLED'}</span>
        </div>
      </div>

      <div>
        <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest block mb-1">SCHEDULE</span>
        <span className="font-mono text-[11px] text-white uppercase tracking-widest">{scheduleLabel}</span>
      </div>

      <div>
        <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest block mb-1">LAST RUN</span>
        <StatusBadge status={status} />
      </div>

      <div>
        <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest block mb-1">NEXT RUN</span>
        <span className="font-mono text-[11px] text-white uppercase tracking-widest">{formatNextRun(job.next_run_at)}</span>
      </div>

      <div className="flex items-center gap-2 justify-end">
        <button onClick={onToggle} className={`w-10 h-5 border transition-colors ${job.enabled ? 'border-primary bg-primary/20' : 'border-[#404040] bg-[#050505]'}`} aria-label="Toggle job">
          <span className={`block w-4 h-4 bg-current transition-transform ${job.enabled ? 'translate-x-5 text-primary' : 'translate-x-0.5 text-text-muted'}`}></span>
        </button>
        <button onClick={onHistory} className="border border-[#262626] px-3 py-2 font-mono text-[9px] text-primary uppercase tracking-widest hover:bg-primary/10">VIEW RUNS</button>
        <IconButton icon="edit" onClick={onEdit} label="Edit job" />
        <IconButton icon="delete" onClick={onDelete} label="Delete job" danger />
      </div>
    </div>
  );
}

function CronJobForm({ agents, job, onCancel, onSaved }) {
  const initialPreset = job?.preset || detectPreset(job?.schedule) || 'daily_9am';
  const [selectedPreset, setSelectedPreset] = useState(initialPreset);
  const [agentId, setAgentId] = useState(job?.agent_id || agents[0]?.id || '');
  const [name, setName] = useState(job?.name || '');
  const [nameTouched, setNameTouched] = useState(Boolean(job?.name));
  const [prompt, setPrompt] = useState(job?.prompt || '');
  const [enabled, setEnabled] = useState(job ? Boolean(job.enabled) : true);
  const [cronFields, setCronFields] = useState(splitSchedule(job?.schedule || PRESETS.find((preset) => preset.id === initialPreset)?.schedule || '0 9 * * *'));
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const expression = cronFields.join(' ');
  const preview = useMemo(() => getPreview(expression), [expression]);
  const scheduleLabel = preview.valid ? humanizeSchedule(expression) : 'INVALID SCHEDULE';

  useEffect(() => {
    if (!nameTouched && selectedAgent && preview.valid) {
      setName(`${selectedAgent.name} - ${scheduleLabel}`);
    }
  }, [nameTouched, selectedAgent, scheduleLabel, preview.valid]);

  const applyPreset = (presetId) => {
    setSelectedPreset(presetId);
    const preset = PRESETS.find((item) => item.id === presetId);
    if (preset) {
      setCronFields(splitSchedule(preset.schedule));
      setFieldErrors({});
    }
  };

  const updateTime = (time) => {
    const [hour = '9', minute = '0'] = time.split(':');
    setCronFields((prev) => [String(Number(minute)), String(Number(hour)), prev[2], prev[3], prev[4]]);
  };

  const updateField = (index, value) => {
    const next = [...cronFields];
    next[index] = value.trim();
    setCronFields(next);
    const rule = FIELD_RULES[index];
    const message = validateCronField(next[index], rule.min, rule.max);
    setFieldErrors((prev) => ({ ...prev, [rule.key]: message }));
  };

  const validateAll = () => {
    const nextErrors = {};
    FIELD_RULES.forEach((rule, index) => {
      const message = validateCronField(cronFields[index], rule.min, rule.max);
      if (message) nextErrors[rule.key] = message;
    });
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0 && preview.valid;
  };

  const submit = async () => {
    if (!agentId) return setError('Select an agent');
    if (!name.trim()) return setError('Job name is required');
    if (!prompt.trim()) return setError('Prompt is required');
    if (!validateAll()) return setError(preview.error || 'Fix schedule fields before saving');

    setSaving(true);
    setError('');
    try {
      const payload = {
        agentId,
        name: name.trim(),
        prompt: prompt.trim(),
        schedule: expression,
        preset: selectedPreset === 'custom' ? null : selectedPreset,
        enabled: enabled ? 1 : 0,
      };
      const res = job
        ? await api.patch(`/cron/${job.id}`, {
            name: payload.name,
            prompt: payload.prompt,
            schedule: payload.schedule,
            preset: payload.preset,
            enabled: payload.enabled,
          })
        : await api.post('/cron', payload);
      onSaved({
        ...res.data,
        name: res.data.name || payload.name,
        prompt: res.data.prompt || payload.prompt,
        agent_id: res.data.agent_id || agentId,
        agent_name: selectedAgent?.name,
        preset: res.data.preset ?? payload.preset,
        schedule: res.data.schedule || payload.schedule,
        enabled: res.data.enabled ?? payload.enabled,
      });
    } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.error || 'Unable to save scheduled job');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2">
        <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">{job ? 'EDIT SCHEDULED JOB' : 'NEW SCHEDULED JOB'}</h1>
        <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">CRON EXECUTION DIRECTIVE</p>
      </div>

      <div className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8 space-y-8">
        {error && <div className="border border-danger/40 bg-danger/10 px-4 py-3 font-mono text-[11px] text-danger uppercase tracking-widest">{error}</div>}

        <Field label="AGENT">
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white uppercase tracking-widest focus:border-primary outline-none">
            <option value="">SELECT AGENT</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </Field>

        <Field label="JOB NAME">
          <input
            value={name}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
            className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white uppercase tracking-widest focus:border-primary outline-none"
          />
        </Field>

        <div>
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest block mb-3">SCHEDULE</span>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className={`border p-4 text-left transition-colors ${selectedPreset === preset.id ? 'border-primary bg-primary/10' : 'border-[#262626] bg-[#050505] hover:border-primary/50'}`}
              >
                <span className="material-symbols-outlined text-primary text-[22px] block mb-3">{preset.icon}</span>
                <span className="font-mono text-[11px] text-white uppercase tracking-widest">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        {selectedPreset === 'daily_9am' && <TimePicker fields={cronFields} onChange={updateTime} />}
        {selectedPreset === 'weekly_monday' && <WeeklyPicker fields={cronFields} setFields={setCronFields} onTime={updateTime} />}
        {selectedPreset === 'monthly' && <MonthlyPicker fields={cronFields} setFields={setCronFields} onTime={updateTime} />}
        {selectedPreset === 'custom' && (
          <CustomCronEditor fields={cronFields} errors={fieldErrors} onChange={updateField} onBlur={updateField} />
        )}

        <SchedulePreview expression={expression} preview={preview} label={scheduleLabel} />

        <Field label="PROMPT">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Summarise the latest activity and send a report"
            rows={2}
            className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white placeholder:text-text-muted uppercase tracking-widest focus:border-primary outline-none resize-y min-h-[88px]"
          />
        </Field>

        <div className="flex items-center gap-3">
          <button onClick={() => setEnabled((value) => !value)} className={`w-10 h-5 border transition-colors ${enabled ? 'border-primary bg-primary/20' : 'border-[#404040] bg-[#050505]'}`}>
            <span className={`block w-4 h-4 bg-current transition-transform ${enabled ? 'translate-x-5 text-primary' : 'translate-x-0.5 text-text-muted'}`}></span>
          </button>
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">ENABLED</span>
        </div>

        <div className="flex items-center gap-4">
          <button onClick={submit} disabled={saving} className="bg-primary text-[#050505] px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-widest disabled:opacity-50">
            {saving ? 'SAVING...' : job ? 'SAVE CHANGES' : 'SCHEDULE JOB'}
          </button>
          <button onClick={onCancel} className="font-mono text-[10px] text-text-muted uppercase tracking-widest hover:text-white">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RunHistoryPanel({ job, onClose }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [details, setDetails] = useState({});

  useEffect(() => {
    setLoading(true);
    api.get(`/cron/${job.id}/runs`, { params: { page: 1, limit: 20 } })
      .then((res) => setRuns(res.data.runs || []))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [job.id]);

  const toggleRun = async (run) => {
    if (expanded === run.id) return setExpanded(null);
    setExpanded(run.id);
    if (!details[run.id]) {
      const res = await api.get(`/cron/${job.id}/runs/${run.id}`);
      setDetails((prev) => ({ ...prev, [run.id]: res.data }));
    }
  };

  return (
    <div className="fixed right-0 top-0 bottom-0 w-full max-w-[400px] bg-[#050505] border-l border-[#262626] z-[60] flex flex-col shadow-2xl">
      <div className="p-5 border-b border-[#262626] flex items-start justify-between">
        <div>
          <h2 className="font-mono text-[14px] text-white font-bold uppercase tracking-widest">RUN HISTORY</h2>
          <p className="font-mono text-[9px] text-primary uppercase tracking-widest mt-1">{job.name}</p>
        </div>
        <button onClick={onClose} className="material-symbols-outlined text-text-muted hover:text-white">close</button>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-[#262626]">
        {loading ? (
          <div className="p-6 font-mono text-[10px] text-text-muted uppercase tracking-widest">LOADING RUNS...</div>
        ) : runs.length === 0 ? (
          <div className="p-6 font-mono text-[10px] text-text-muted uppercase tracking-widest">NO RUNS RECORDED</div>
        ) : runs.map((run) => (
          <div key={run.id} className="p-5">
            <button onClick={() => toggleRun(run)} className="w-full text-left">
              <div className="flex items-center justify-between mb-3">
                <StatusBadge status={run.status} />
                <RiskBadge score={run.risk_score} />
              </div>
              <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-2">{formatTimestamp(run.started_at)}</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <Metric label="Duration" value={`${run.duration_ms || 0}ms`} />
                <Metric label="Tokens" value={run.tokens_used || 0} />
              </div>
              <p className="font-mono text-[10px] text-white leading-relaxed">{run.truncatedOutput || 'NO OUTPUT'}</p>
            </button>

            {expanded === run.id && details[run.id] && (
              <div className="mt-4 border border-[#262626] bg-[#0a0a0a] p-4 space-y-4">
                <div>
                  <span className="font-mono text-[9px] text-primary uppercase tracking-widest block mb-2">FULL OUTPUT</span>
                  <pre className="whitespace-pre-wrap font-mono text-[10px] text-white leading-relaxed">{details[run.id].run.output || 'NO OUTPUT'}</pre>
                </div>
                {details[run.id].trace && (
                  <div>
                    <span className="font-mono text-[9px] text-primary uppercase tracking-widest block mb-2">TRACE</span>
                    <pre className="whitespace-pre-wrap font-mono text-[10px] text-text-muted leading-relaxed">{JSON.stringify(details[run.id].trace, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomCronEditor({ fields, errors, onChange, onBlur }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
      {FIELD_RULES.map((rule, index) => (
        <div key={rule.key}>
          <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest block mb-2">{rule.label}</label>
          <input
            value={fields[index]}
            onChange={(event) => onChange(index, event.target.value)}
            onBlur={(event) => onBlur(index, event.target.value)}
            className={`w-full bg-[#050505] border px-3 py-3 font-mono text-[12px] text-white uppercase tracking-widest outline-none ${errors[rule.key] ? 'border-danger' : 'border-[#262626] focus:border-primary'}`}
          />
          {errors[rule.key] && <span className="font-mono text-[9px] text-danger uppercase tracking-widest mt-2 block">{errors[rule.key]}</span>}
        </div>
      ))}
    </div>
  );
}

function SchedulePreview({ preview, label }) {
  return (
    <div className="border border-[#262626] bg-[#050505] p-5">
      <span className="font-mono text-[10px] text-primary uppercase tracking-widest block mb-3">SCHEDULE PREVIEW</span>
      <p className={`font-mono text-[12px] uppercase tracking-widest mb-5 ${preview.valid ? 'text-white' : 'text-danger'}`}>{preview.valid ? label : preview.error}</p>
      <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest block mb-3">NEXT 3 RUNS:</span>
      <div className="space-y-2">
        {preview.valid ? preview.next3.map((date) => (
          <div key={date.toISOString()} className="font-mono text-[11px] text-white uppercase tracking-widest">{format(date, 'EEE dd MMM yyyy HH:mm:ss')}</div>
        )) : (
          <div className="font-mono text-[11px] text-danger uppercase tracking-widest">INVALID CRON EXPRESSION</div>
        )}
      </div>
    </div>
  );
}

function TimePicker({ fields, onChange }) {
  return (
    <Field label="RUN TIME">
      <input
        type="time"
        value={`${pad(fields[1])}:${pad(fields[0])}`}
        onChange={(event) => onChange(event.target.value)}
        className="bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white uppercase tracking-widest focus:border-primary outline-none"
      />
    </Field>
  );
}

function WeeklyPicker({ fields, setFields, onTime }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="DAY OF WEEK">
        <select value={fields[4]} onChange={(event) => setFields((prev) => [prev[0], prev[1], '*', '*', event.target.value])} className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white uppercase tracking-widest focus:border-primary outline-none">
          {WEEKDAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <TimePicker fields={fields} onChange={onTime} />
    </div>
  );
}

function MonthlyPicker({ fields, setFields, onTime }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="DAY OF MONTH">
        <select value={fields[2]} onChange={(event) => setFields((prev) => [prev[0], prev[1], event.target.value, '*', '*'])} className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white uppercase tracking-widest focus:border-primary outline-none">
          {Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
      </Field>
      <TimePicker fields={fields} onChange={onTime} />
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest block mb-2">{label}</span>
      {children}
    </label>
  );
}

function IconButton({ icon, onClick, label, danger = false }) {
  return (
    <button onClick={onClick} aria-label={label} className={`border border-[#262626] w-9 h-9 flex items-center justify-center hover:bg-white/5 ${danger ? 'text-danger' : 'text-text-muted hover:text-white'}`}>
      <span className="material-symbols-outlined text-[17px]">{icon}</span>
    </button>
  );
}

function StatusBadge({ status }) {
  const normalized = String(status || 'never').toLowerCase();
  const cls = normalized === 'success'
    ? 'border-primary/30 bg-primary/10 text-primary'
    : normalized === 'failed'
      ? 'border-danger/30 bg-danger/10 text-danger'
      : 'border-[#404040] bg-[#050505] text-text-muted';
  return <span className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${cls}`}>{normalized === 'never' ? 'NEVER RUN' : normalized}</span>;
}

function RiskBadge({ score }) {
  const value = Number(score || 0);
  const cls = value <= 20 ? 'text-primary border-primary/30 bg-primary/10' : value <= 50 ? 'text-warning border-warning/30 bg-warning/10' : 'text-danger border-danger/30 bg-danger/10';
  return <span className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-widest ${cls}`}>RISK {value}</span>;
}

function Metric({ label, value }) {
  return (
    <div>
      <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest block mb-1">{label}</span>
      <span className="font-mono text-[10px] text-white uppercase tracking-widest">{value}</span>
    </div>
  );
}

function getPreview(expression) {
  try {
    const interval = cronParser.parseExpression(expression);
    const next3 = [
      interval.next().toDate(),
      interval.next().toDate(),
      interval.next().toDate(),
    ];
    return { valid: true, next3 };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function validateCronField(value, min, max) {
  if (!value) return `Must be ${min}-${max} or *`;
  if (!/^[\d*,/\-]+$/.test(value)) return `Must be ${min}-${max} or *`;
  const parts = value.split(',');
  for (const part of parts) {
    if (!validateCronPart(part, min, max)) return `Must be ${min}-${max} or *`;
  }
  return '';
}

function validateCronPart(part, min, max) {
  if (part === '*') return true;
  const [base, step] = part.split('/');
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1)) return false;
  if (base === '*') return true;
  if (base.includes('-')) {
    const [start, end] = base.split('-').map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
  }
  if (!/^\d+$/.test(base)) return false;
  const numeric = Number(base);
  return numeric >= min && numeric <= max;
}

function splitSchedule(schedule) {
  const fields = String(schedule || '* * * * *').split(/\s+/);
  return fields.length === 5 ? fields : ['0', '9', '*', '*', '*'];
}

function detectPreset(schedule) {
  if (schedule === '0 * * * *') return 'every_hour';
  if (schedule === '0 9 * * *') return 'daily_9am';
  if (schedule === '0 9 * * 1') return 'weekly_monday';
  if (schedule === '0 9 1 * *') return 'monthly';
  return 'custom';
}

function presetLabel(preset) {
  return PRESETS.find((item) => item.id === preset)?.label || humanizeSchedule(preset);
}

function humanizeSchedule(schedule) {
  const [minute, hour, day, month, weekday] = splitSchedule(schedule);
  const time = formatTime(hour, minute);
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every hour';
  if (day === '*' && month === '*' && weekday === '*') return `Every day at ${time}`;
  if (day === '*' && month === '*' && weekday !== '*') return `Every ${weekdayName(weekday)} at ${time}`;
  if (day !== '*' && month === '*' && weekday === '*') return `Day ${day} of every month at ${time}`;
  return schedule;
}

function formatTime(hour, minute) {
  if (hour === '*' || minute === '*') return `${minute} ${hour}`;
  const date = new Date(2026, 0, 1, Number(hour), Number(minute));
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function weekdayName(value) {
  return WEEKDAYS.find(([day]) => day === value)?.[1] || `weekday ${value}`;
}

function formatNextRun(ts) {
  if (!ts) return 'NOT SCHEDULED';
  const date = new Date(Number(ts));
  const diff = date.getTime() - Date.now();
  if (diff > 0 && diff <= 7 * 24 * 60 * 60 * 1000) return `in ${formatDistanceToNow(date)}`;
  return format(date, 'dd MMM yyyy HH:mm');
}

function formatTimestamp(ts) {
  if (!ts) return 'UNKNOWN';
  return format(new Date(Number(ts)), 'dd MMM yyyy HH:mm:ss');
}

function pad(value) {
  return String(value === '*' ? 0 : Number(value || 0)).padStart(2, '0');
}
