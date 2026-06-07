import { useState, useEffect } from 'react';

export default function FloatingStatus() {
  return (
    <div className="fixed bottom-6 right-6 flex flex-col gap-2 items-end pointer-events-none z-50">
      <div className="bg-[#050505] border border-primary/50 px-3 py-1 flex items-center gap-3">
        <span className="material-symbols-outlined text-primary text-[14px]">lock</span>
        <span className="font-mono text-[9px] tracking-[0.2em] text-primary uppercase">
          AES-256-GCM: Active
        </span>
      </div>
      <div className="bg-[#050505] border border-[#262626] px-3 py-1 flex items-center gap-3">
        <LatencyIndicator />
      </div>
    </div>
  );
}

function LatencyIndicator() {
  const [latency, setLatency] = useState(null);
  useEffect(() => {
    const measure = async () => {
      const base = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const start = performance.now();
      try {
        await fetch(`${base}/health`, { cache: 'no-store' });
        setLatency(Math.round(performance.now() - start));
      } catch {
        setLatency(null);
      }
    };
    measure();
    const interval = setInterval(measure, 30000);
    return () => clearInterval(interval);
  }, []);
  return (
    <span className="font-mono text-[9px] tracking-[0.2em] text-text-muted uppercase">
      {latency !== null ? `Latency: ${latency}ms` : 'Latency: --'}
    </span>
  );
}
