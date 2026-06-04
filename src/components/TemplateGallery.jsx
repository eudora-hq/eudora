import { useState } from 'react'
import { AGENT_TEMPLATES, TEMPLATE_CATEGORIES } from '../constants/agentTemplates'

const BADGE_COLOURS = {
  COMPLIANCE: 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10',
  REGULATORY: 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10',
  RISK:        'border-amber-500/50 text-amber-400 bg-amber-500/10',
  DEVOPS:      'border-blue-500/50 text-blue-400 bg-blue-500/10',
  ENGINEERING: 'border-blue-500/50 text-blue-400 bg-blue-500/10',
  PRODUCTIVITY:'border-purple-500/50 text-purple-400 bg-purple-500/10',
  KNOWLEDGE:   'border-purple-500/50 text-purple-400 bg-purple-500/10',
  SUPPORT:     'border-orange-500/50 text-orange-400 bg-orange-500/10',
  RESEARCH:    'border-cyan-500/50 text-cyan-400 bg-cyan-500/10',
}

export function TemplateGallery({ onSelect, showPreview = false }) {
  const [activeCategory, setActiveCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [previewId, setPreviewId] = useState(null)

  const filtered = AGENT_TEMPLATES.filter(t => {
    const matchesCategory = activeCategory === 'all' || t.category === activeCategory
    const matchesSearch = !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase())
    return matchesCategory && matchesSearch
  })

  const featured = filtered.filter(t => t.featured)
  const rest = filtered.filter(t => !t.featured)
  const ordered = [...featured, ...rest]

  return (
    <div className="space-y-4">
      {/* Search + category filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search templates..."
          className="bg-[#050505] border border-[#262626] text-white px-3 py-2 font-mono text-[11px] focus:outline-none focus:border-primary w-48"
        />
        <div className="flex gap-2">
          {TEMPLATE_CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`font-mono text-[9px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
                activeCategory === cat.id
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-[#262626] text-text-muted hover:border-text-muted'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Template grid */}
      {ordered.length === 0 ? (
        <div className="py-8 text-center">
          <span className="font-mono text-[11px] text-text-muted uppercase tracking-widest">
            No templates match your search
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {ordered.map(template => (
            <div
              key={template.id}
              className={`border bg-[#0a0a0a] p-4 space-y-3 transition-colors ${
                template.featured
                  ? 'border-primary/30 hover:border-primary/60'
                  : 'border-[#262626] hover:border-[#404040]'
              }`}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[18px]">
                    {template.icon}
                  </span>
                  <span className="font-mono text-[12px] font-bold text-white uppercase tracking-wide">
                    {template.name}
                  </span>
                </div>
                <span className={`font-mono text-[8px] uppercase tracking-widest border px-1.5 py-0.5 flex-shrink-0 ${BADGE_COLOURS[template.badge] || 'border-[#262626] text-text-muted'}`}>
                  {template.badge}
                </span>
              </div>

              {/* Description */}
              <p className="font-mono text-[11px] text-text-muted leading-relaxed line-clamp-2">
                {template.description}
              </p>

              {/* Tags */}
              <div className="flex flex-wrap gap-1">
                {template.tags.slice(0, 3).map(tag => (
                  <span key={tag} className="font-mono text-[8px] text-text-muted/60 border border-[#262626] px-1.5 py-0.5 uppercase">
                    {tag}
                  </span>
                ))}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => onSelect(template)}
                  className="flex-1 bg-primary/10 border border-primary/40 text-primary font-mono text-[9px] uppercase tracking-widest py-2 hover:bg-primary/20 transition-colors cursor-pointer"
                >
                  Use Template
                </button>
                {showPreview && (
                  <button
                    onClick={() => setPreviewId(previewId === template.id ? null : template.id)}
                    className="border border-[#262626] text-text-muted font-mono text-[9px] uppercase tracking-widest px-3 py-2 hover:border-text-muted transition-colors cursor-pointer"
                  >
                    {previewId === template.id ? 'Hide' : 'Preview'}
                  </button>
                )}
              </div>

              {/* Preview panel */}
              {showPreview && previewId === template.id && (
                <div className="border-t border-[#262626] pt-3">
                  <p className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-2">System Prompt</p>
                  <pre className="font-mono text-[10px] text-text-muted/80 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto bg-[#050505] p-3 border border-[#1a1a1a]">
                    {template.systemPrompt}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
