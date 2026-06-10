import { useEffect, useMemo, useState } from 'react'
import api from '../api/client'

const MODES = [
  { value: 'flagged', label: 'FLAGGED' },
  { value: 'full', label: 'FULL' },
  { value: 'summary', label: 'SUMMARY' },
  { value: 'article50', label: 'EU AI ACT ARTICLE 50' },
]

const SECTORS = [
  { value: 'general', label: 'GENERAL' },
  { value: 'healthcare', label: 'HEALTHCARE' },
  { value: 'financial', label: 'FINANCIAL SERVICES' },
  { value: 'hr_legal', label: 'HR / LEGAL' },
]

export default function Compliance() {
  const [tab, setTab] = useState('reports')
  const [agents, setAgents] = useState([])
  const [reports, setReports] = useState([])
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showGenerate, setShowGenerate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [verification, setVerification] = useState(null)
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [reportForm, setReportForm] = useState({
    agentId: '',
    mode: 'flagged',
    template: 'general',
  })
  const [filters, setFilters] = useState({
    agentId: '',
    dateFrom: '',
    dateTo: '',
    sectorTemplate: '',
  })

  const agentNames = useMemo(
    () => Object.fromEntries(agents.map(agent => [agent.id, agent.name])),
    [agents]
  )

  useEffect(() => {
    loadInitialData()
  }, [])

  useEffect(() => {
    if (tab === 'article50') loadRecords()
  }, [tab, filters.agentId, filters.dateFrom, filters.dateTo, filters.sectorTemplate])

  const loadInitialData = async () => {
    setLoading(true)
    setError('')
    try {
      const [agentRows, reportRows] = await Promise.all([
        getWithFallback('/v1/agents', '/agents'),
        getWithFallback('/v1/compliance/reports', '/reports'),
      ])
      setAgents(agentRows || [])
      setReports(reportRows || [])
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load compliance data')
    } finally {
      setLoading(false)
    }
  }

  const loadRecords = async () => {
    setError('')
    try {
      const params = {
        ...(filters.agentId ? { agent_id: filters.agentId } : {}),
        ...(filters.dateFrom ? { dateFrom: startOfDay(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { dateTo: endOfDay(filters.dateTo) } : {}),
        ...(filters.sectorTemplate ? { sector_template: filters.sectorTemplate } : {}),
      }
      const res = await api.get('/v1/compliance/article50/records', { params })
      setRecords(res.data || [])
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load Article 50 records')
    }
  }

  const generateReport = async () => {
    if (!reportForm.agentId) return
    setGenerating(true)
    setError('')

    try {
      const payload = {
        agent_id: reportForm.agentId,
        mode: reportForm.mode,
        ...(reportForm.mode === 'article50' ? { template: reportForm.template } : {}),
      }
      let response
      try {
        response = await api.post('/v1/compliance/reports', payload, { responseType: 'blob' })
      } catch (err) {
        if (err.response?.status !== 404) throw err
        response = await api.post('/reports/generate', {
          agentId: reportForm.agentId,
          mode: reportForm.mode,
          ...(reportForm.mode === 'article50' ? { sectorTemplate: reportForm.template } : {}),
          dateFrom: Date.now() - 30 * 24 * 60 * 60 * 1000,
          dateTo: Date.now(),
          format: 'pdf',
        }, { responseType: 'blob' })
      }

      downloadBlob(response.data, 'eudora-compliance-report.pdf')
      setShowGenerate(false)
      const reportRows = await getWithFallback('/v1/compliance/reports', '/reports')
      setReports(reportRows || [])
      if (reportForm.mode === 'article50') await loadRecords()
    } catch (err) {
      setError(await blobError(err, 'Unable to generate compliance report'))
    } finally {
      setGenerating(false)
    }
  }

  const downloadPdf = async (report) => {
    setError('')
    try {
      let response
      try {
        response = await api.get(`/v1/compliance/reports/${report.id}/pdf`, { responseType: 'blob' })
      } catch (err) {
        if (err.response?.status !== 404) throw err
        response = await api.get(`/reports/${report.id}`, { responseType: 'blob' })
      }
      downloadBlob(response.data, `eudora-compliance-report-${report.id}.pdf`)
    } catch {
      setError('Unable to download report PDF')
    }
  }

  const downloadJson = async (report) => {
    setError('')
    try {
      try {
        const response = await api.get(`/v1/compliance/reports/${report.id}/json`, { responseType: 'blob' })
        downloadBlob(response.data, `eudora-compliance-report-${report.id}.json`)
      } catch (err) {
        if (err.response?.status !== 404) throw err
        const res = await api.get(`/v1/compliance/reports/${report.id}/verify`)
        downloadBlob(
          new Blob([JSON.stringify({ ...report, verification: res.data }, null, 2)], { type: 'application/json' }),
          `eudora-compliance-report-${report.id}.json`
        )
      }
    } catch {
      setError('Unable to download report JSON')
    }
  }

  const verifyReport = async (report) => {
    setVerificationLoading(true)
    setError('')
    try {
      const res = await api.get(`/v1/compliance/reports/${report.id}/verify`)
      setVerification(res.data)
    } catch {
      setError('Unable to verify report timestamp')
    } finally {
      setVerificationLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2 flex items-start justify-between">
        <div>
          <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white uppercase tracking-tight leading-none">
            COMPLIANCE
          </h1>
          <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">
            REGULATORY EVIDENCE & TRANSPARENCY RECORDS
          </p>
        </div>
        {tab === 'reports' && (
          <button
            onClick={() => setShowGenerate(true)}
            className="primary-btn relative bg-primary text-[#050505] py-3 px-6 font-mono text-[11px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer"
          >
            <span className="relative z-10">GENERATE REPORT</span>
            <span className="scan-line" />
          </button>
        )}
      </div>

      <div className="flex border-b border-[#262626]">
        {[
          ['reports', 'REPORTS'],
          ['article50', 'ARTICLE 50 RECORDS'],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-5 py-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] border-b-2 transition-colors cursor-pointer ${
              tab === value
                ? 'text-primary border-primary'
                : 'text-text-muted border-transparent hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/5 p-4">
          <p className="font-mono text-[10px] text-red-400 uppercase tracking-widest">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-3 py-10">
          <span className="w-2 h-2 bg-primary animate-pulse" />
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            Loading compliance data...
          </span>
        </div>
      ) : tab === 'reports' ? (
        <ReportsTable
          reports={reports}
          agentNames={agentNames}
          onVerify={verifyReport}
          onDownloadPdf={downloadPdf}
          onDownloadJson={downloadJson}
          verificationLoading={verificationLoading}
        />
      ) : (
        <Article50Records
          records={records}
          agents={agents}
          agentNames={agentNames}
          filters={filters}
          setFilters={setFilters}
        />
      )}

      {showGenerate && (
        <GenerateModal
          agents={agents}
          form={reportForm}
          setForm={setReportForm}
          generating={generating}
          onClose={() => setShowGenerate(false)}
          onGenerate={generateReport}
        />
      )}

      {verification && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6" onClick={() => setVerification(null)}>
          <div className="w-full max-w-2xl border border-[#262626] bg-[#0a0a0a]" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#262626]">
              <div>
                <p className="font-mono text-[10px] text-primary uppercase tracking-widest">Timestamp Verification</p>
                <p className="font-mono text-[9px] text-text-muted mt-1">{verification.report_id}</p>
              </div>
              <button
                onClick={() => setVerification(null)}
                className="material-symbols-outlined text-text-muted hover:text-white text-[20px] cursor-pointer"
              >
                close
              </button>
            </div>
            <pre className="m-5 bg-[#050505] border border-[#262626] p-4 overflow-auto max-h-[60vh] font-mono text-[10px] text-text-muted leading-relaxed">
              {JSON.stringify(verification, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function ReportsTable({ reports, agentNames, onVerify, onDownloadPdf, onDownloadJson, verificationLoading }) {
  return (
    <section className="border border-[#262626] bg-[#0a0a0a] overflow-x-auto">
      <table className="w-full min-w-[900px]">
        <thead>
          <tr className="border-b border-[#262626]">
            {['DATE', 'AGENT', 'MODE', 'TIMESTAMP STATUS', 'ACTIONS'].map(label => (
              <th key={label} className="text-left px-5 py-3 font-mono text-[8px] text-primary uppercase tracking-widest">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reports.length === 0 ? (
            <tr>
              <td colSpan="5" className="px-5 py-12 text-center font-mono text-[10px] text-text-muted uppercase tracking-widest">
                No compliance reports generated
              </td>
            </tr>
          ) : reports.map(report => (
            <tr key={report.id} className="border-b border-[#1a1a1a] last:border-0">
              <td className="px-5 py-4 font-mono text-[10px] text-white">{formatDate(report.generated_at)}</td>
              <td className="px-5 py-4 font-mono text-[10px] text-text-muted">
                {agentNames[report.agent_id] || report.agent_id || 'ALL AGENTS'}
              </td>
              <td className="px-5 py-4 font-mono text-[9px] text-text-muted uppercase tracking-widest">
                {modeLabel(report.report_mode)}
              </td>
              <td className="px-5 py-4">
                <button
                  onClick={() => onVerify(report)}
                  disabled={verificationLoading}
                  className={`border px-2 py-1.5 font-mono text-[8px] uppercase tracking-widest cursor-pointer disabled:opacity-50 ${timestampClass(report.timestamp_status)}`}
                >
                  {timestampLabel(report)}
                </button>
              </td>
              <td className="px-5 py-4">
                <div className="flex gap-2">
                  <button
                    onClick={() => onDownloadPdf(report)}
                    className="border border-[#262626] text-text-muted hover:border-primary hover:text-primary px-3 py-2 font-mono text-[8px] uppercase tracking-widest cursor-pointer transition-colors"
                  >
                    PDF
                  </button>
                  <button
                    onClick={() => onDownloadJson(report)}
                    className="border border-[#262626] text-text-muted hover:border-primary hover:text-primary px-3 py-2 font-mono text-[8px] uppercase tracking-widest cursor-pointer transition-colors"
                  >
                    JSON
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Article50Records({ records, agents, agentNames, filters, setFilters }) {
  return (
    <div className="space-y-4">
      <div className="border border-[#262626] bg-[#0a0a0a] p-5 grid grid-cols-1 md:grid-cols-4 gap-4">
        <FilterSelect
          label="AGENT"
          value={filters.agentId}
          onChange={value => setFilters(current => ({ ...current, agentId: value }))}
          options={agents.map(agent => ({ value: agent.id, label: agent.name }))}
          emptyLabel="ALL AGENTS"
        />
        <FilterInput
          label="DATE FROM"
          value={filters.dateFrom}
          onChange={value => setFilters(current => ({ ...current, dateFrom: value }))}
        />
        <FilterInput
          label="DATE TO"
          value={filters.dateTo}
          onChange={value => setFilters(current => ({ ...current, dateTo: value }))}
        />
        <FilterSelect
          label="SECTOR TEMPLATE"
          value={filters.sectorTemplate}
          onChange={value => setFilters(current => ({ ...current, sectorTemplate: value }))}
          options={SECTORS}
          emptyLabel="ALL SECTORS"
        />
      </div>

      <section className="border border-[#262626] bg-[#0a0a0a] overflow-x-auto">
        <table className="w-full min-w-[960px]">
          <thead>
            <tr className="border-b border-[#262626]">
              {['TIMESTAMP', 'AGENT', 'SECTOR TEMPLATE', 'REGULATIONS', 'DISCLOSURE'].map(label => (
                <th key={label} className="text-left px-5 py-3 font-mono text-[8px] text-primary uppercase tracking-widest">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr>
                <td colSpan="5" className="px-5 py-12 text-center font-mono text-[10px] text-text-muted uppercase tracking-widest">
                  No Article 50 records found
                </td>
              </tr>
            ) : records.map(record => (
              <tr key={record.id} className="border-b border-[#1a1a1a] last:border-0 align-top">
                <td className="px-5 py-4 font-mono text-[10px] text-white">{formatDate(record.interaction_timestamp)}</td>
                <td className="px-5 py-4 font-mono text-[10px] text-text-muted">
                  {agentNames[record.agent_id] || record.agent_id}
                </td>
                <td className="px-5 py-4 font-mono text-[9px] text-text-muted uppercase tracking-widest">
                  {sectorLabel(record.sector_template)}
                </td>
                <td className="px-5 py-4 font-mono text-[9px] text-text-muted leading-relaxed">
                  {(record.regulation_refs || []).join(' · ') || '—'}
                </td>
                <td className="px-5 py-4">
                  <span className={`border px-2 py-1 font-mono text-[8px] uppercase tracking-widest ${
                    record.disclosure_made
                      ? 'border-primary/30 bg-primary/5 text-primary'
                      : 'border-red-400/30 bg-red-400/5 text-red-400'
                  }`}>
                    {record.disclosure_made ? 'MADE' : 'NOT RECORDED'}
                  </span>
                  {record.disclosure_method && (
                    <p className="font-mono text-[8px] text-text-muted mt-2 uppercase">{record.disclosure_method}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function GenerateModal({ agents, form, setForm, generating, onClose, onGenerate }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-xl border border-[#262626] bg-[#0a0a0a]" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#262626]">
          <h2 className="font-mono text-[12px] text-white font-bold uppercase tracking-widest">Generate Compliance Report</h2>
          <button onClick={onClose} className="material-symbols-outlined text-text-muted hover:text-white cursor-pointer">close</button>
        </div>
        <div className="p-6 space-y-5">
          <FilterSelect
            label="AGENT"
            value={form.agentId}
            onChange={value => setForm(current => ({ ...current, agentId: value }))}
            options={agents.map(agent => ({ value: agent.id, label: agent.name }))}
            emptyLabel="SELECT AGENT"
          />
          <FilterSelect
            label="MODE"
            value={form.mode}
            onChange={value => setForm(current => ({ ...current, mode: value }))}
            options={MODES}
          />
          {form.mode === 'article50' && (
            <>
              <FilterSelect
                label="SECTOR TEMPLATE"
                value={form.template}
                onChange={value => setForm(current => ({ ...current, template: value }))}
                options={SECTORS}
              />
              <div className="border border-amber-400/30 bg-amber-400/5 p-4 flex gap-3">
                <span className="material-symbols-outlined text-amber-400 text-[18px]">info</span>
                <p className="font-mono text-[10px] text-amber-400 uppercase tracking-widest leading-relaxed">
                  EU AI Act Article 50 transparency obligations apply from August 2, 2026
                </p>
              </div>
            </>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="font-mono text-[9px] text-text-muted hover:text-white uppercase tracking-widest cursor-pointer">
              CANCEL
            </button>
            <button
              onClick={onGenerate}
              disabled={generating || !form.agentId}
              className="bg-primary text-[#050505] px-6 py-3 font-mono text-[10px] font-bold uppercase tracking-widest cursor-pointer disabled:opacity-50"
            >
              {generating ? 'GENERATING...' : 'GENERATE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FilterSelect({ label, value, onChange, options, emptyLabel }) {
  return (
    <div className="space-y-2">
      <label className="font-mono text-[9px] text-primary uppercase tracking-widest block">{label}</label>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full bg-[#050505] border border-[#262626] text-white px-3 py-3 font-mono text-[10px] uppercase appearance-none cursor-pointer focus:border-primary"
      >
        {emptyLabel && <option value="">{emptyLabel}</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  )
}

function FilterInput({ label, value, onChange }) {
  return (
    <div className="space-y-2">
      <label className="font-mono text-[9px] text-primary uppercase tracking-widest block">{label}</label>
      <input
        type="date"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full bg-[#050505] border border-[#262626] text-white px-3 py-3 font-mono text-[10px] focus:border-primary"
      />
    </div>
  )
}

async function getWithFallback(primary, fallback) {
  try {
    return (await api.get(primary)).data
  } catch (err) {
    if (err.response?.status !== 404) throw err
    return (await api.get(fallback)).data
  }
}

async function blobError(err, fallback) {
  try {
    if (err.response?.data instanceof Blob) {
      const parsed = JSON.parse(await err.response.data.text())
      return parsed.message || parsed.error || fallback
    }
  } catch {
    // Use the generic message when the error response is not JSON.
  }
  return err.response?.data?.message || fallback
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

function startOfDay(value) {
  return new Date(`${value}T00:00:00`).getTime()
}

function endOfDay(value) {
  return new Date(`${value}T23:59:59.999`).getTime()
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function modeLabel(mode) {
  return MODES.find(item => item.value === mode)?.label || String(mode || 'flagged').toUpperCase()
}

function sectorLabel(sector) {
  return SECTORS.find(item => item.value === sector)?.label || String(sector || 'general').toUpperCase()
}

function timestampClass(status) {
  if (status === 'ok') return 'border-primary/30 bg-primary/5 text-primary'
  if (status === 'pending') return 'border-amber-400/30 bg-amber-400/5 text-amber-400'
  return 'border-[#333] bg-[#111] text-text-muted'
}

function timestampLabel(report) {
  if (report.timestamp_status === 'ok') {
    return `VERIFIED ✓ ${report.timestamp_time ? new Date(report.timestamp_time).toLocaleString() : ''}`
  }
  if (report.timestamp_status === 'pending') return 'PENDING'
  return 'UNAVAILABLE'
}
