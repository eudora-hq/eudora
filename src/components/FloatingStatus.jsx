export default function FloatingStatus() {
  return (
    <div className="fixed bottom-6 right-6 flex flex-col gap-2 items-end pointer-events-none z-50">
      <div className="bg-[#050505] border border-primary/50 px-3 py-1 flex items-center gap-3">
        <span className="material-symbols-outlined text-primary text-[14px]">lock</span>
        <span className="font-mono text-[9px] tracking-[0.2em] text-primary uppercase">
          Quantum Encryption: Active
        </span>
      </div>
      <div className="bg-[#050505] border border-[#262626] px-3 py-1 flex items-center gap-3">
        <LatencyIndicator />
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';

function LatencyIndicator() {
  const [latency, setLatency] = useState(24);

  useEffect(() => {
    const interval = setInterval(() => {
      setLatency(Math.floor(Math.random() * (42 - 18 + 1)) + 18);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="font-mono text-[9px] tracking-[0.2em] text-text-muted uppercase">
      Latency: {latency}ms
    </span>
  );
}
