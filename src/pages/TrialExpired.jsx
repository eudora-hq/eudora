import { useState } from 'react'
import api from '../api/client'
import { PlanModal } from '../components/PlanModal'

export default function TrialExpired() {
  const [exporting, setExporting] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [error, setError] = useState('')

  const exportData = async () => {
    setExporting(true)
    setError('')
    try {
      const res = await api.get('/account/export', { responseType: 'blob' })
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/zip' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'eudora-export.zip'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setError('Unable to export your data. Try again shortly.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#050505] text-white font-sans flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-6xl">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 border border-primary/20 bg-surface px-3 py-1.5 mb-5">
            <span className="w-2 h-2 bg-primary rounded-full"></span>
            <span className="font-mono text-[9px] tracking-[0.2em] text-primary uppercase">EUDORA BILLING</span>
          </div>
          <h1 className="font-mono text-3xl md:text-5xl font-bold uppercase tracking-tight">
            YOUR TRIAL HAS ENDED
          </h1>
          <p className="mt-4 text-text-muted font-mono text-xs uppercase tracking-[0.14em]">
            Your 14-day free trial has ended. Choose a plan to continue using Eudora.
          </p>
        </div>

        <div className="border border-border bg-bg p-8 text-center">
          <button
            onClick={() => setShowModal(true)}
            className="border border-primary bg-primary text-black font-mono text-xs uppercase tracking-widest py-3 px-10 hover:bg-transparent hover:text-primary transition-colors cursor-pointer"
          >
            CHOOSE A PLAN →
          </button>
        </div>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={exportData}
            disabled={exporting}
            className="font-mono text-xs uppercase tracking-widest text-text-muted hover:text-primary transition-colors disabled:opacity-50"
          >
            {exporting ? 'Preparing export...' : 'Export my data and leave'}
          </button>
          {error && (
            <p className="mt-4 font-mono text-xs uppercase tracking-widest text-danger">{error}</p>
          )}
        </div>
      </div>
      {showModal && <PlanModal onClose={() => setShowModal(false)} />}
    </main>
  )
}
