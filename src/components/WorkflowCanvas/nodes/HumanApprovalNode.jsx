import { Handle, Position } from '@xyflow/react'

export default function HumanApprovalNode({ data, selected }) {
  const threshold = data.config?.risk_threshold ?? 70
  const timeout = data.config?.timeout_minutes ?? 60

  return (
    <div className={`w-[240px] border bg-[#0a0a0a] p-4 transition-colors ${
      selected ? 'border-amber-300' : 'border-amber-500/50'
    }`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-amber-400 !border-[#050505]" />
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-amber-400 text-[18px]">shield_person</span>
          <h3 className="font-mono text-[12px] text-white uppercase font-bold tracking-widest leading-tight">
            {data.label || 'HUMAN APPROVAL'}
          </h3>
        </div>
        <span className="border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[8px] text-amber-400 uppercase tracking-widest shrink-0">
          GATE
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="border border-[#262626] px-2 py-2">
          <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest block">Threshold</span>
          <span className="font-mono text-[11px] text-amber-400">{threshold}/100</span>
        </div>
        <div className="border border-[#262626] px-2 py-2">
          <span className="font-mono text-[8px] text-text-muted uppercase tracking-widest block">Timeout</span>
          <span className="font-mono text-[11px] text-white">{timeout} min</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-amber-400 !border-[#050505]" />
    </div>
  )
}
