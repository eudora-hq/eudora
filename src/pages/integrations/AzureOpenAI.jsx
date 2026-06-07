import { useState } from 'react'
import api from '../../api/client'

const EMPTY_CONFIG = {
  tenantId: '',
  clientId: '',
  clientSecret: '',
  subscriptionId: '',
  resourceGroup: '',
  resourceName: '',
  workspaceId: '',
}

const FIELDS = [
  { key: 'tenantId', label: 'Azure Tenant ID', placeholder: '00000000-0000-0000-0000-000000000000' },
  { key: 'clientId', label: 'Client ID (Service Principal)', placeholder: '00000000-0000-0000-0000-000000000000' },
  { key: 'clientSecret', label: 'Client Secret', placeholder: 'Service principal secret', type: 'password' },
  { key: 'subscriptionId', label: 'Subscription ID', placeholder: '00000000-0000-0000-0000-000000000000' },
  { key: 'resourceGroup', label: 'Resource Group', placeholder: 'rg-ai-production' },
  { key: 'resourceName', label: 'Azure OpenAI Resource Name', placeholder: 'company-openai-prod' },
  { key: 'workspaceId', label: 'Log Analytics Workspace ID', placeholder: 'Optional, enables request-level diagnostics', optional: true },
]

export default function AzureOpenAI({ onSaved, onCancel }) {
  const [name, setName] = useState('')
  const [config, setConfig] = useState(EMPTY_CONFIG)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [error, setError] = useState('')

  const updateConfig = (key, value) => {
    setConfig(current => ({ ...current, [key]: value }))
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const response = await api.post('/integrations/azure-openai/test', { config })
      setTestResult(response.data)
      if (!response.data.success) setError(response.data.error || 'Connection failed')
    } catch (err) {
      setError(err.response?.data?.message || 'Connection test failed')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Integration name is required')
      return
    }

    setSaving(true)
    setError('')
    try {
      const response = await api.post('/integrations/azure-openai', {
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
          <span className="material-symbols-outlined text-primary text-[18px]">cloud_sync</span>
          <div>
            <h2 className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">Connect Azure OpenAI</h2>
            <p className="font-mono text-[9px] text-text-muted mt-1">Service principal credentials are encrypted at rest.</p>
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
        <div className="space-y-1">
          <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">Integration Name</label>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2.5 focus:outline-none focus:border-primary"
            placeholder="Production Azure OpenAI"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {FIELDS.map(field => (
            <div key={field.key} className={`space-y-1 ${field.key === 'workspaceId' ? 'md:col-span-2' : ''}`}>
              <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
                {field.label}{field.optional ? ' (Optional)' : ''}
              </label>
              <input
                type={field.type || 'text'}
                value={config[field.key]}
                onChange={event => updateConfig(field.key, event.target.value)}
                className="w-full bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2.5 focus:outline-none focus:border-primary"
                placeholder={field.placeholder}
                autoComplete={field.type === 'password' ? 'new-password' : 'off'}
              />
            </div>
          ))}
        </div>

        {error && (
          <div className="border border-red-500/30 bg-red-500/5 px-4 py-3">
            <p className="font-mono text-[10px] text-red-400">{error}</p>
          </div>
        )}

        {testResult?.success && (
          <div className="border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="font-mono text-[10px] text-primary uppercase tracking-widest">
              Connection verified
            </p>
            <p className="font-mono text-[9px] text-text-muted mt-1">
              {testResult.resourceName || config.resourceName}
              {testResult.location ? ` · ${testResult.location}` : ''}
            </p>
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="border border-[#262626] text-text-muted hover:border-text-muted hover:text-white px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || saving}
            className="border border-primary/40 text-primary hover:bg-primary/10 px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest cursor-pointer disabled:opacity-50 transition-colors"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            type="button"
            onClick={handleSave}
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
