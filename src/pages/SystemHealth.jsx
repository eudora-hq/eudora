import { useEffect, useState } from 'react'
import api from '../api/client'

function StatusBadge({ status }) {
  const colours = {
    operational: 'text-primary border-primary/30 bg-primary/5',
    degraded: 'text-amber-400 border-amber-400/30 bg-amber-400/5',
    down: 'text-red-400 border-red-400/30 bg-red-400/5',
  }

  return (
    <span className={`font-mono text-[8px] uppercase tracking-widest border px-2 py-0.5 ${colours[status] || colours.operational}`}>
      {status}
    </span>
  )
}

function MetricRow({ label, value, sub }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-[#1a1a1a] last:border-0">
      <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">{label}</span>
      <div className="text-right min-w-0">
        <span className="font-mono text-[11px] text-white break-words">{value ?? '-'}</span>
        {sub && <span className="font-mono text-[9px] text-text-muted block">{sub}</span>}
      </div>
    </div>
  )
}

function Section({ title, icon, children, status }) {
  return (
    <section className="border border-[#262626] bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[16px]">{icon}</span>
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">{title}</span>
        </div>
        {status && <StatusBadge status={status} />}
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  )
}

export default function SystemHealth() {
  const [health, setHealth] = useState(null)
  const [apiLatency, setApiLatency] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)

  const fetchHealth = async () => {
    const start = performance.now()
    setRefreshing(true)

    try {
      const response = await api.get('/health/system')
      setApiLatency(Math.round(performance.now() - start))
      setHealth(response.data)
      setLastRefresh(new Date())
      setError('')
    } catch {
      setError('Failed to load system health data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchHealth()
    const interval = setInterval(fetchHealth, 30000)
    return () => clearInterval(interval)
  }, [])

  const formatDate = (timestamp) => timestamp ? new Date(timestamp).toLocaleString() : '-'
  const formatBytes = (bytes) => {
    if (!bytes) return '0 KB'
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        <span className="font-mono text-[11px] text-text-muted uppercase tracking-widest">Loading system health...</span>
      </div>
    )
  }

  if (error && !health) {
    return (
      <div className="border border-red-500/30 bg-red-500/5 p-4">
        <p className="font-mono text-[11px] text-red-400">{error}</p>
      </div>
    )
  }

  const hasIssues = health?.scheduler?.failuresLast24h > 0
    || health?.security?.highRiskLast24h > 0

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-[20px] font-bold text-white uppercase tracking-tight mb-1">System Health</h1>
          <p className="font-mono text-[10px] text-text-muted">
            Last updated: {lastRefresh?.toLocaleTimeString() || '-'} · Auto-refreshes every 30s
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={hasIssues ? 'degraded' : 'operational'} />
          <button
            type="button"
            onClick={fetchHealth}
            disabled={refreshing}
            className="font-mono text-[9px] text-text-muted border border-[#262626] px-3 py-1.5 hover:border-primary hover:text-primary uppercase tracking-widest cursor-pointer transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/5 p-3">
          <p className="font-mono text-[10px] text-red-400">{error}</p>
        </div>
      )}

      <Section title="API" icon="cloud" status="operational">
        <MetricRow label="Status" value="Operational" />
        <MetricRow label="Response time" value={apiLatency !== null ? `${apiLatency}ms` : '-'} />
        <MetricRow label="Node.js" value={health?.environment?.nodeVersion} />
        <MetricRow label="Mode" value={health?.environment?.selfHosted ? 'Self-Hosted' : 'Cloud'} />
      </Section>

      <Section title="Database" icon="database" status="operational">
        <MetricRow label="Size" value={formatBytes(health?.database?.sizeBytes)} />
        <MetricRow label="Audit entries" value={health?.audit?.totalEntries?.toLocaleString()} />
        <MetricRow label="Trace records" value={health?.audit?.traceRecords?.toLocaleString()} />
        <MetricRow label="Oldest entry" value={formatDate(health?.audit?.firstEntry)} />
        <MetricRow label="Latest entry" value={formatDate(health?.audit?.lastEntry)} />
      </Section>

      <Section
        title="Security"
        icon="security"
        status={health?.security?.highRiskLast24h > 0 ? 'degraded' : 'operational'}
      >
        <MetricRow label="Encryption" value={health?.security?.encryption} />
        <MetricRow label="Audit integrity" value={health?.security?.auditIntegrity} />
        <MetricRow
          label="High-risk events (24h)"
          value={health?.security?.highRiskLast24h}
          sub={health?.security?.highRiskLast24h > 0 ? 'Review audit log' : undefined}
        />
        <MetricRow label="DLP events (24h)" value={health?.security?.dlpEventsLast24h} />
        <MetricRow label="Total events (24h)" value={health?.security?.totalEventsLast24h} />
      </Section>

      <Section title="Agents" icon="smart_toy" status="operational">
        <MetricRow label="Total agents" value={health?.agents?.total} />
        <MetricRow label="External agents" value={health?.agents?.external} />
        <MetricRow
          label="Internal agents"
          value={(health?.agents?.total || 0) - (health?.agents?.external || 0)}
        />
      </Section>

      <Section
        title="Scheduler"
        icon="schedule"
        status={health?.scheduler?.failuresLast24h > 0 ? 'degraded' : 'operational'}
      >
        <MetricRow label="Total jobs" value={health?.scheduler?.totalJobs} />
        <MetricRow label="Active jobs" value={health?.scheduler?.activeJobs} />
        <MetricRow
          label="Failures (24h)"
          value={health?.scheduler?.failuresLast24h}
          sub={health?.scheduler?.failuresLast24h > 0 ? 'Check scheduled jobs' : undefined}
        />
      </Section>
    </div>
  )
}
