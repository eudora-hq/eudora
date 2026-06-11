import { useEffect, useState } from 'react'
import api from '../api/client'

const EMPTY_FORM = {
  name: '',
  local_port: '11434',
  local_host: '127.0.0.1',
}

export default function Tunnels() {
  const [tunnels, setTunnels] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [createdTunnel, setCreatedTunnel] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const loadTunnels = async () => {
    try {
      const response = await api.get('/v1/tunnels')
      const rows = response.data.tunnels || []
      const statuses = await Promise.all(rows.map(async (tunnel) => {
        try {
          const status = await api.get(`/v1/tunnels/${tunnel.id}/status`)
          return { ...tunnel, ...status.data }
        } catch {
          return tunnel
        }
      }))
      setTunnels(statuses)
      setError('')
    } catch {
      setError('Unable to load tunnels')
    }
  }

  useEffect(() => {
    loadTunnels()
    const interval = setInterval(loadTunnels, 30_000)
    return () => clearInterval(interval)
  }, [])

  const createTunnel = async () => {
    setSubmitting(true)
    setError('')
    try {
      const response = await api.post('/v1/tunnels', {
        name: form.name,
        local_port: Number(form.local_port),
        local_host: form.local_host,
      })
      setCreatedTunnel(response.data)
      setShowCreate(false)
      setForm(EMPTY_FORM)
      await loadTunnels()
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to create tunnel')
    } finally {
      setSubmitting(false)
    }
  }

  const removeTunnel = async (tunnel) => {
    if (!window.confirm(`Delete tunnel "${tunnel.name}"?`)) return
    try {
      await api.delete(`/v1/tunnels/${tunnel.id}`)
      setTunnels(current => current.filter(item => item.id !== tunnel.id))
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to delete tunnel')
    }
  }

  const copy = async (value, field) => {
    await navigator.clipboard.writeText(value)
    setCopied(field)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="p-8 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-[20px] font-bold text-white uppercase tracking-tight">
            Tunnels
          </h1>
          <p className="font-mono text-[10px] text-text-muted mt-1">
            Connect private Ollama instances to Eudora Cloud through FRP.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-primary text-[#050505] px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest cursor-pointer"
        >
          New Tunnel
        </button>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="font-mono text-[10px] text-red-400 uppercase">{error}</p>
        </div>
      )}

      <div className="border border-[#262626] bg-[#0a0a0a]">
        <div className="grid grid-cols-[minmax(180px,1fr)_110px_180px_48px] gap-4 px-4 py-3 border-b border-[#262626]">
          {['Tunnel', 'Status', 'Last Seen', ''].map(label => (
            <span key={label} className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
              {label}
            </span>
          ))}
        </div>
        {tunnels.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
              No tunnels configured
            </p>
          </div>
        ) : tunnels.map(tunnel => (
          <div
            key={tunnel.id}
            className="grid grid-cols-[minmax(180px,1fr)_110px_180px_48px] gap-4 items-center px-4 py-4 border-b border-[#1a1a1a] last:border-0"
          >
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-white uppercase truncate">{tunnel.name}</p>
              <p className="font-mono text-[9px] text-text-muted mt-1 truncate">
                {tunnel.id}.tunnel.geteudora.com
              </p>
              <p className="font-mono text-[8px] text-text-muted/60 mt-1">
                {tunnel.local_host}:{tunnel.local_port}
              </p>
            </div>
            <StatusBadge status={tunnel.status} />
            <span className="font-mono text-[9px] text-text-muted">
              {tunnel.last_seen_at ? new Date(tunnel.last_seen_at).toLocaleString() : 'Never'}
            </span>
            <button
              title="Delete tunnel"
              onClick={() => removeTunnel(tunnel)}
              className="text-text-muted hover:text-red-400 cursor-pointer transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
            </button>
          </div>
        ))}
      </div>

      {showCreate && (
        <Modal title="New Tunnel" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <Field
              label="Name"
              value={form.name}
              onChange={value => setForm(current => ({ ...current, name: value }))}
              placeholder="Office Ollama"
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Local Host"
                value={form.local_host}
                onChange={value => setForm(current => ({ ...current, local_host: value }))}
              />
              <Field
                label="Local Port"
                type="number"
                value={form.local_port}
                onChange={value => setForm(current => ({ ...current, local_port: value }))}
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowCreate(false)}
                className="border border-[#262626] px-4 py-2 font-mono text-[10px] text-text-muted uppercase cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={createTunnel}
                disabled={submitting || !form.name.trim()}
                className="bg-primary text-[#050505] px-5 py-2 font-mono text-[10px] font-bold uppercase tracking-widest disabled:opacity-50 cursor-pointer"
              >
                {submitting ? 'Creating...' : 'Create Tunnel'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {createdTunnel && (
        <Modal title="Tunnel Created" onClose={() => setCreatedTunnel(null)} wide>
          <div className="space-y-5">
            <div className="border border-red-500/40 bg-red-500/5 p-4">
              <p className="font-mono text-[9px] text-red-400 uppercase tracking-widest mb-2">
                Save this key. It will not be shown again.
              </p>
              <CopyBlock
                value={createdTunnel.tunnel_key}
                copied={copied === 'key'}
                onCopy={() => copy(createdTunnel.tunnel_key, 'key')}
              />
            </div>
            <RevealSection
              title="frpc.toml"
              value={createdTunnel.frpc_config}
              copied={copied === 'config'}
              onCopy={() => copy(createdTunnel.frpc_config, 'config')}
            />
            <RevealSection
              title="Install Command"
              value={createdTunnel.install_command}
              copied={copied === 'command'}
              onCopy={() => copy(createdTunnel.install_command, 'command')}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}

function StatusBadge({ status }) {
  const active = status === 'active'
  return (
    <span className={`w-fit border px-2 py-1 font-mono text-[8px] uppercase tracking-widest ${
      active
        ? 'border-primary/30 bg-primary/5 text-primary'
        : 'border-[#333] bg-white/[0.02] text-text-muted'
    }`}>
      {status || 'inactive'}
    </span>
  )
}

function Field({ label, value, onChange, placeholder = '', type = 'text' }) {
  return (
    <label className="block space-y-2">
      <span className="font-mono text-[9px] text-primary uppercase tracking-widest">{label}</span>
      <input
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#050505] border border-[#262626] px-4 py-3 font-mono text-[12px] text-white focus:outline-none focus:border-primary"
      />
    </label>
  )
}

function Modal({ title, children, onClose, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-6">
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto border border-[#262626] bg-[#0a0a0a]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#262626]">
          <h2 className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">{title}</h2>
          <button title="Close" onClick={onClose} className="text-text-muted hover:text-white cursor-pointer">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function CopyBlock({ value, copied, onCopy }) {
  return (
    <div className="flex items-center gap-3">
      <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-white">{value}</code>
      <button title="Copy" onClick={onCopy} className="text-primary cursor-pointer">
        <span className="material-symbols-outlined text-[18px]">
          {copied ? 'check' : 'content_copy'}
        </span>
      </button>
    </div>
  )
}

function RevealSection({ title, value, copied, onCopy }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{title}</p>
        <button onClick={onCopy} className="flex items-center gap-1 font-mono text-[9px] text-primary uppercase cursor-pointer">
          <span className="material-symbols-outlined text-[15px]">
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap border border-[#262626] bg-[#050505] p-4 font-mono text-[10px] leading-5 text-text-muted">
        {value}
      </pre>
    </section>
  )
}
