import { useState } from 'react'
import api from '../../api/client'

export default function GithubCopilot({ onSaved, onCancel }) {
  const [name, setName] = useState('')
  const [config, setConfig] = useState({ org: '', token: '' })
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [error, setError] = useState('')

  const updateConfig = (key, value) => {
    setConfig(current => ({ ...current, [key]: value }))
    setTestResult(null)
  }

  const testConnection = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const response = await api.post('/integrations/github-copilot/test', { config })
      setTestResult(response.data)
      if (!response.data.success) setError(response.data.error || 'Connection failed')
    } catch (err) {
      setError(err.response?.data?.message || 'Connection test failed')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!name.trim()) {
      setError('Integration name is required')
      return
    }

    setSaving(true)
    setError('')
    try {
      const response = await api.post('/integrations/github-copilot', {
        name: name.trim(),
        config,
      })
      onSaved?.(response.data)
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save integration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-[#262626] bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-[#1a1a1a] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-[18px]">code</span>
          <div>
            <h2 className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">Connect GitHub Copilot</h2>
            <p className="font-mono text-[9px] text-text-muted mt-1">Requires read:audit_log and read:org permissions.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="material-symbols-outlined text-text-muted hover:text-white text-[18px] cursor-pointer transition-colors"
          title="Close"
        >
          close
        </button>
      </div>

      <div className="p-5 space-y-5">
        <Field
          label="Integration Name"
          value={name}
          onChange={setName}
          placeholder="Production Copilot Business"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="GitHub Organization"
            value={config.org}
            onChange={value => updateConfig('org', value)}
            placeholder="your-organization"
          />
          <Field
            label="Personal Access Token / App Token"
            value={config.token}
            onChange={value => updateConfig('token', value)}
            placeholder="github_pat_..."
            type="password"
          />
        </div>

        {error && (
          <div className="border border-red-500/30 bg-red-500/5 px-4 py-3">
            <p className="font-mono text-[10px] text-red-400">{error}</p>
          </div>
        )}
        {testResult?.success && (
          <div className="border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="font-mono text-[10px] text-primary uppercase tracking-widest">Connection verified</p>
            <p className="font-mono text-[9px] text-text-muted mt-1">
              {testResult.org}{testResult.plan ? ` · ${testResult.plan}` : ''}
            </p>
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="border border-[#262626] text-text-muted hover:text-white px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={testing || saving}
            className="border border-primary/40 text-primary hover:bg-primary/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer disabled:opacity-50 transition-colors"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={testing || saving}
            className="bg-primary text-[#050505] px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest cursor-pointer disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Integration'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div className="space-y-1">
      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{label}</label>
      <input
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2.5 focus:outline-none focus:border-primary"
      />
    </div>
  )
}
