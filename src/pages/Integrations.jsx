import { useEffect, useState } from 'react'
import api from '../api/client'
import AzureOpenAI from './integrations/AzureOpenAI'

function formatDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : 'Never'
}

export default function Integrations() {
  const [integrations, setIntegrations] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAzureForm, setShowAzureForm] = useState(false)
  const [syncingId, setSyncingId] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadIntegrations = async () => {
    try {
      const response = await api.get('/integrations')
      setIntegrations(response.data || [])
      setError('')
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadIntegrations()
  }, [])

  const handleSaved = async () => {
    setShowAzureForm(false)
    setMessage('Azure OpenAI integration connected.')
    await loadIntegrations()
  }

  const handleSync = async (integration) => {
    setSyncingId(integration.id)
    setError('')
    setMessage('')
    try {
      const response = await api.post(`/integrations/${integration.id}/sync`)
      setMessage(`Imported ${response.data.imported} Azure OpenAI audit event${response.data.imported === 1 ? '' : 's'}.`)
      await loadIntegrations()
    } catch (err) {
      setError(err.response?.data?.message || 'Azure OpenAI sync failed')
      await loadIntegrations()
    } finally {
      setSyncingId(null)
    }
  }

  const handleDelete = async (integration) => {
    if (!window.confirm(`Remove "${integration.name}"? Stored credentials and sync configuration will be deleted.`)) return
    setError('')
    setMessage('')
    try {
      await api.delete(`/integrations/${integration.id}`)
      setMessage('Integration removed.')
      await loadIntegrations()
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove integration')
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="font-mono text-[20px] font-bold text-white uppercase tracking-tight">Integrations</h1>
          <p className="font-mono text-[10px] text-text-muted mt-1">
            Import provider-native activity into the Eudora audit trail.
          </p>
        </div>
        {!showAzureForm && (
          <button
            type="button"
            onClick={() => { setShowAzureForm(true); setError(''); setMessage('') }}
            className="bg-primary text-[#050505] px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest cursor-pointer hover:bg-primary/90 transition-colors"
          >
            Connect Azure OpenAI
          </button>
        )}
      </div>

      <div className="flex border-b border-[#262626]">
        <div className="border-b border-primary px-4 py-3 font-mono text-[10px] text-primary uppercase tracking-widest">
          Azure OpenAI
        </div>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/5 p-4">
          <p className="font-mono text-[10px] text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="border border-primary/30 bg-primary/5 p-4">
          <p className="font-mono text-[10px] text-primary">{message}</p>
        </div>
      )}

      {showAzureForm && (
        <AzureOpenAI
          onSaved={handleSaved}
          onCancel={() => setShowAzureForm(false)}
        />
      )}

      <div className="space-y-3">
        {loading ? (
          <div className="border border-[#262626] px-5 py-8 text-center">
            <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">Loading integrations...</p>
          </div>
        ) : integrations.length === 0 ? (
          <div className="border border-[#262626] bg-[#0a0a0a] px-5 py-8 text-center">
            <span className="material-symbols-outlined text-text-muted text-[28px]">cloud_off</span>
            <p className="font-mono text-[11px] text-white uppercase tracking-widest mt-3">No integrations connected</p>
            <p className="font-mono text-[9px] text-text-muted mt-2">
              Connect Azure OpenAI to import Azure Monitor activity without changing agent traffic.
            </p>
          </div>
        ) : integrations.map(integration => {
          const failed = integration.last_sync_status?.startsWith('failed')
          return (
            <div key={integration.id} className="border border-[#262626] bg-[#0a0a0a] p-5">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-primary text-[18px]">cloud_sync</span>
                    <h2 className="font-mono text-[12px] font-bold text-white truncate">{integration.name}</h2>
                    <span className="border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[8px] text-primary uppercase tracking-widest">
                      Active
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 mt-4">
                    <div>
                      <p className="font-mono text-[8px] text-text-muted uppercase tracking-widest">Last Sync</p>
                      <p className="font-mono text-[9px] text-white mt-1">{formatDate(integration.last_sync_at)}</p>
                    </div>
                    <div>
                      <p className="font-mono text-[8px] text-text-muted uppercase tracking-widest">Events Imported</p>
                      <p className="font-mono text-[9px] text-white mt-1">{integration.last_sync_count || 0}</p>
                    </div>
                    <div>
                      <p className="font-mono text-[8px] text-text-muted uppercase tracking-widest">Sync Status</p>
                      <p className={`font-mono text-[9px] mt-1 ${failed ? 'text-red-400' : 'text-primary'}`}>
                        {integration.last_sync_status || 'Not synced'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSync(integration)}
                    disabled={syncingId === integration.id}
                    className="border border-primary/40 text-primary px-4 py-2 font-mono text-[9px] uppercase tracking-widest cursor-pointer hover:bg-primary/10 disabled:opacity-50 transition-colors"
                  >
                    {syncingId === integration.id ? 'Syncing...' : 'Sync Now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(integration)}
                    className="w-9 h-9 border border-[#262626] text-text-muted hover:border-red-500/40 hover:text-red-400 flex items-center justify-center cursor-pointer transition-colors"
                    title="Remove integration"
                  >
                    <span className="material-symbols-outlined text-[17px]">delete</span>
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
