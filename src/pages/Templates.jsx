import { useNavigate } from 'react-router-dom'
import { TemplateGallery } from '../components/TemplateGallery'

export default function Templates() {
  const navigate = useNavigate()

  const handleSelect = (template) => {
    navigate('/agents', { state: { template } })
  }

  return (
    <div className="p-8 space-y-8 max-w-6xl">
      {/* Header */}
      <div className="space-y-2">
        <span className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] border border-primary/30 px-2 py-1">
          AGENT TEMPLATES
        </span>
        <h1 className="font-mono text-[32px] font-bold text-white uppercase tracking-tight">
          Pre-configured agents
        </h1>
        <p className="font-mono text-[13px] text-text-muted max-w-2xl">
          Deploy a pre-configured agent in one click. Each template includes a battle-tested system prompt. Edit it after deployment to match your specific needs.
        </p>
      </div>

      {/* Gallery with preview enabled */}
      <TemplateGallery onSelect={handleSelect} showPreview={true} />
    </div>
  )
}
