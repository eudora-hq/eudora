import { useEffect, useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import api from '../api/client'

const RISK_COLOURS = ['#10b981', '#f59e0b', '#ef4444']

function SummaryCard({ label, value, icon, detail, tone = 'primary' }) {
  const toneClass = {
    primary: 'text-primary',
    warning: 'text-amber-400',
    danger: 'text-red-400',
  }[tone]

  return (
    <div className="border border-[#262626] bg-[#0a0a0a] p-5 min-h-[132px] flex flex-col justify-between">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{label}</span>
        <span className={`material-symbols-outlined text-[18px] ${toneClass}`}>{icon}</span>
      </div>
      <div>
        <p className="font-mono text-[26px] font-bold text-white leading-none">{Number(value || 0).toLocaleString()}</p>
        {detail && <p className={`font-mono text-[9px] uppercase tracking-widest mt-3 ${toneClass}`}>{detail}</p>}
      </div>
    </div>
  )
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="border border-[#262626] bg-[#050505] px-3 py-2 shadow-xl">
      <p className="font-mono text-[9px] text-text-muted mb-2">{label}</p>
      {payload.map(item => (
        <p key={item.dataKey} className="font-mono text-[9px]" style={{ color: item.color }}>
          {item.name}: {item.value}
        </p>
      ))}
    </div>
  )
}

export default function Analytics() {
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/analytics/overview')
      .then(response => setAnalytics(response.data))
      .catch(err => setError(err.response?.data?.message || 'Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [])

  const chartData = useMemo(() => (
    (analytics?.dailyActivity || []).map(item => ({
      ...item,
      label: new Date(`${item.day}T00:00:00Z`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    }))
  ), [analytics])

  const riskData = useMemo(() => [
    { name: 'Nominal', value: analytics?.riskDistribution?.nominal || 0 },
    { name: 'Elevated', value: analytics?.riskDistribution?.elevated || 0 },
    { name: 'Critical', value: analytics?.riskDistribution?.critical || 0 },
  ], [analytics])

  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 bg-primary animate-pulse" />
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">Loading analytics...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-red-500/30 bg-red-500/5 p-4">
        <p className="font-mono text-[11px] text-red-400">{error}</p>
      </div>
    )
  }

  const trend = analytics?.summary?.trend || 0
  const trendDetail = `${trend > 0 ? '↑' : trend < 0 ? '↓' : '→'} ${Math.abs(trend)}% vs previous 30d`
  const riskTotal = riskData.reduce((sum, item) => sum + item.value, 0)

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="font-mono text-[20px] font-bold text-white uppercase tracking-tight">Usage Analytics</h1>
        <p className="font-mono text-[10px] text-text-muted mt-1">
          Tenant AI governance posture · rolling 30-day window
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard
          label="AI Interactions"
          value={analytics?.summary?.totalInteractions}
          icon="query_stats"
          detail={trendDetail}
          tone={trend < 0 ? 'warning' : 'primary'}
        />
        <SummaryCard
          label="Risk Events"
          value={analytics?.summary?.riskEvents}
          icon="warning"
          detail="Risk score above 20"
          tone="warning"
        />
        <SummaryCard
          label="Blocked Requests"
          value={analytics?.summary?.blockedRequests}
          icon="block"
          detail="Guard or proxy blocked"
          tone="danger"
        />
        <SummaryCard
          label="DLP Events"
          value={analytics?.summary?.dlpEvents}
          icon="key_off"
          detail="Credentials detected"
          tone="danger"
        />
      </div>

      <section className="border border-[#262626] bg-[#0a0a0a]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#1a1a1a]">
          <span className="material-symbols-outlined text-primary text-[18px]">timeline</span>
          <div>
            <h2 className="font-mono text-[11px] font-bold text-white uppercase tracking-widest">Daily Activity</h2>
            <p className="font-mono text-[8px] text-text-muted mt-1 uppercase tracking-widest">Interactions and risk events</p>
          </div>
        </div>
        <div className="h-[340px] p-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 18, left: -18, bottom: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fill: '#737373', fontFamily: 'monospace', fontSize: 9 }}
                axisLine={{ stroke: '#262626' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: '#737373', fontFamily: 'monospace', fontSize: 9 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ fontFamily: 'monospace', fontSize: '9px', textTransform: 'uppercase' }}
              />
              <Line
                type="monotone"
                dataKey="interactions"
                name="Interactions"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#10b981' }}
              />
              <Line
                type="monotone"
                dataKey="risk_events"
                name="Risk Events"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#f59e0b' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-[#262626] bg-[#0a0a0a]">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-[#1a1a1a]">
            <span className="material-symbols-outlined text-primary text-[18px]">smart_toy</span>
            <h2 className="font-mono text-[11px] font-bold text-white uppercase tracking-widest">Top Agents</h2>
          </div>
          {(analytics?.topAgents || []).length === 0 ? (
            <p className="font-mono text-[10px] text-text-muted text-center py-12">No agent activity in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#1a1a1a]">
                    <th className="text-left px-5 py-3 font-mono text-[8px] text-text-muted uppercase tracking-widest">Agent</th>
                    <th className="text-right px-3 py-3 font-mono text-[8px] text-text-muted uppercase tracking-widest">Interactions</th>
                    <th className="text-right px-5 py-3 font-mono text-[8px] text-text-muted uppercase tracking-widest">Avg Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.topAgents.map(agent => (
                    <tr key={agent.id} className="border-b border-[#1a1a1a] last:border-0">
                      <td className="px-5 py-4 font-mono text-[10px] text-white">{agent.name}</td>
                      <td className="px-3 py-4 font-mono text-[10px] text-right text-text-muted">{agent.interactions}</td>
                      <td className={`px-5 py-4 font-mono text-[10px] text-right ${
                        agent.avg_risk > 50 ? 'text-red-400' : agent.avg_risk > 20 ? 'text-amber-400' : 'text-primary'
                      }`}>
                        {agent.avg_risk}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="border border-[#262626] bg-[#0a0a0a]">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-[#1a1a1a]">
            <span className="material-symbols-outlined text-primary text-[18px]">donut_large</span>
            <h2 className="font-mono text-[11px] font-bold text-white uppercase tracking-widest">Risk Distribution</h2>
          </div>
          <div className="grid grid-cols-[minmax(180px,1fr)_minmax(150px,1fr)] items-center min-h-[270px] px-4">
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={riskData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={58}
                    outerRadius={82}
                    paddingAngle={riskTotal > 0 ? 2 : 0}
                    stroke="none"
                  >
                    {riskData.map((entry, index) => (
                      <Cell key={entry.name} fill={RISK_COLOURS[index]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-4">
              {riskData.map((item, index) => {
                const pct = riskTotal ? Math.round((item.value / riskTotal) * 100) : 0
                return (
                  <div key={item.name}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest flex items-center gap-2">
                        <span className="w-2 h-2" style={{ backgroundColor: RISK_COLOURS[index] }} />
                        {item.name}
                      </span>
                      <span className="font-mono text-[10px] text-white">{item.value}</span>
                    </div>
                    <p className="font-mono text-[8px] text-text-muted/60 text-right mt-1">{pct}%</p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
