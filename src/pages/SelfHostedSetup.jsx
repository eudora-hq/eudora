import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

const MODEL_RECOMMENDATIONS = {
  '8GB': { name: 'qwen2.5-coder:7b', size: '4.7GB', speed: 'Fast', note: 'Lightweight, great for most tasks' },
  '16GB': { name: 'qwen2.5-coder:14b', size: '9.0GB', speed: 'Balanced', note: 'Recommended - best quality/speed balance' },
  '32GB': { name: 'qwen3-coder:30b', size: '19GB', speed: 'Powerful', note: 'High quality, slower responses' },
  '64GB': { name: 'qwen3-coder:70b', size: '42GB', speed: 'Maximum', note: 'Best quality, requires powerful hardware' },
};

export default function SelfHostedSetup() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [models, setModels] = useState([]);
  const [selectedRam, setSelectedRam] = useState('16GB');
  const [selectedModel, setSelectedModel] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const checkOllama = async () => {
    setOllamaStatus(null);
    setError('');
    try {
      const res = await api.get('/health/ollama', { params: { url: ollamaUrl } });
      setOllamaStatus(res.data.ollamaDetected);
      setModels(res.data.models || []);
    } catch (err) {
      setOllamaStatus(false);
      setModels([]);
      if (err.response?.data?.error === 'invalid_url') {
        setError('Ollama URL must begin with http:// or https://');
      }
    }
  };

  useEffect(() => {
    if (step === 1) checkOllama();
  }, [step]);

  useEffect(() => {
    if (models.length > 0) {
      const recommended = MODEL_RECOMMENDATIONS[selectedRam];
      const installedMatch = models.find((model) =>
        model.name === recommended.name ||
        model.name.startsWith(recommended.name.split(':')[0])
      );
      setSelectedModel(installedMatch?.name || models[0].name);
    } else {
      setSelectedModel(MODEL_RECOMMENDATIONS[selectedRam].name);
    }
  }, [models, selectedRam]);

  const handleSkip = () => {
    localStorage.setItem('eudora-setup-complete', 'true');
    navigate('/onboarding');
  };

  const handleComplete = async () => {
    if (!selectedModel) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/api-keys', {
        label: `Ollama - ${selectedModel}`,
        provider: 'ollama',
        base_url: ollamaUrl,
        model_name: selectedModel,
      });
      localStorage.setItem('eudora-setup-complete', 'true');
      navigate('/onboarding');
    } catch (err) {
      setError(err.response?.data?.message || err.response?.data?.error || 'Failed to create Ollama connection');
    } finally {
      setLoading(false);
    }
  };

  const runConnectionTest = async () => {
    setLoading(true);
    setError('');
    try {
      const start = Date.now();
      const res = await api.get('/health/ollama', { params: { url: ollamaUrl } });
      const latency = Date.now() - start;
      setModels(res.data.models || []);
      setTestResult({ success: res.data.ollamaDetected, latency });
    } catch {
      setTestResult({ success: false });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] font-mono flex items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[9px] text-primary border border-primary/30 px-2 py-1 uppercase tracking-widest">
              SELF-HOSTED SETUP
            </span>
            <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
              STEP {step} OF 5
            </span>
          </div>
          <h1 className="font-mono text-[28px] font-bold text-white uppercase tracking-tight">
            {step === 1 && 'Detecting Ollama'}
            {step === 2 && 'Select Hardware Profile'}
            {step === 3 && 'Choose Your Model'}
            {step === 4 && 'Test Connection'}
            {step === 5 && 'Setup Complete'}
          </h1>
        </div>

        {error && (
          <div className="border border-danger/40 bg-danger/10 p-4">
            <p className="font-mono text-[11px] text-danger uppercase tracking-widest">{error}</p>
          </div>
        )}

        {step === 1 && (
          <div className="border border-[#262626] bg-[#0a0a0a] p-6 space-y-4">
            {ollamaStatus === null && (
              <div className="space-y-4">
                <p className="font-mono text-[12px] text-text-muted">
                  Checking for Ollama at {ollamaUrl}...
                </p>
                <OllamaUrlField
                  ollamaUrl={ollamaUrl}
                  onChange={setOllamaUrl}
                  onRecheck={checkOllama}
                  checking
                />
              </div>
            )}
            {ollamaStatus === true && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">check_circle</span>
                  <span className="font-mono text-[12px] text-primary uppercase tracking-widest">Ollama detected</span>
                </div>
                {models.length > 0 && (
                  <p className="font-mono text-[11px] text-text-muted">
                    {models.length} model{models.length !== 1 ? 's' : ''} already installed: {models.map(model => model.name).join(', ')}
                  </p>
                )}
                <OllamaUrlField
                  ollamaUrl={ollamaUrl}
                  onChange={setOllamaUrl}
                  onRecheck={checkOllama}
                  checking={ollamaStatus === null}
                />
                <button
                  onClick={() => setStep(2)}
                  className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Continue →
                </button>
              </div>
            )}
            {ollamaStatus === false && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-400 text-[20px]">warning</span>
                  <span className="font-mono text-[12px] text-amber-400 uppercase tracking-widest">Ollama not detected</span>
                </div>
                <p className="font-mono text-[11px] text-text-muted">
                  Install Ollama first, then come back to complete setup.
                </p>
                <OllamaUrlField
                  ollamaUrl={ollamaUrl}
                  onChange={setOllamaUrl}
                  onRecheck={checkOllama}
                  checking={ollamaStatus === null}
                />
                <div className="bg-[#050505] border border-[#1a1a1a] p-4 space-y-2">
                  <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest mb-3">Install Ollama:</p>
                  <div className="space-y-1">
                    <p className="font-mono text-[10px] text-text-muted">macOS:</p>
                    <code className="font-mono text-[11px] text-primary block">brew install ollama</code>
                  </div>
                  <div className="space-y-1 mt-2">
                    <p className="font-mono text-[10px] text-text-muted">Linux:</p>
                    <code className="font-mono text-[11px] text-primary block">curl -fsSL https://ollama.ai/install.sh | sh</code>
                  </div>
                  <div className="space-y-1 mt-2">
                    <p className="font-mono text-[10px] text-text-muted">Windows:</p>
                    <code className="font-mono text-[11px] text-primary block">winget install Ollama.Ollama</code>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleSkip}
                    className="w-full border border-[#262626] text-text-muted font-mono text-[11px] uppercase tracking-widest py-3 hover:border-text-muted transition-colors cursor-pointer"
                  >
                    Skip - Configure Manually
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="border border-[#262626] bg-[#0a0a0a] p-6 space-y-4">
            <p className="font-mono text-[11px] text-text-muted">
              Select your available RAM to get the right model recommendation.
            </p>
            <div className="grid grid-cols-4 gap-3">
              {Object.keys(MODEL_RECOMMENDATIONS).map((ram) => (
                <button
                  key={ram}
                  onClick={() => setSelectedRam(ram)}
                  className={`py-4 font-mono text-[12px] uppercase tracking-widest border transition-colors cursor-pointer ${
                    selectedRam === ram
                      ? 'border-primary text-primary bg-primary/10'
                      : 'border-[#262626] text-text-muted hover:border-text-muted'
                  }`}
                >
                  {ram}
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep(3)}
              className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Continue →
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {models.length > 0 && (
              <div className="space-y-2">
                <p className="font-mono text-[10px] text-primary uppercase tracking-widest">
                  Already installed on this machine
                </p>
                {models.map((model) => (
                  <button
                    type="button"
                    key={model.name}
                    onClick={() => setSelectedModel(model.name)}
                    className={`w-full text-left border p-4 cursor-pointer transition-colors space-y-1 ${
                      selectedModel === model.name
                        ? 'border-primary bg-primary/5'
                        : 'border-[#262626] hover:border-[#404040]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[13px] font-bold text-white">{model.name}</span>
                      <span className="font-mono text-[8px] text-primary border border-primary/30 px-2 py-0.5 uppercase tracking-widest shrink-0">
                        Installed
                      </span>
                    </div>
                    {model.size && (
                      <p className="font-mono text-[10px] text-text-muted">
                        Size: {(model.size / 1e9).toFixed(1)}GB
                      </p>
                    )}
                  </button>
                ))}
                <div className="border-t border-[#1a1a1a] pt-3 mt-2">
                  <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                    Or choose a different model
                  </p>
                </div>
              </div>
            )}
            <p className="font-mono text-[11px] text-text-muted">
              {models.length > 0
                ? `Recommendations for your ${selectedRam} RAM:`
                : `Based on your ${selectedRam} RAM, we recommend:`}
            </p>
            {Object.entries(MODEL_RECOMMENDATIONS).map(([ram, model]) => {
              const isInstalled = models.some((installedModel) =>
                installedModel.name === model.name ||
                installedModel.name.startsWith(model.name.split(':')[0])
              );

              return (
                <button
                  type="button"
                  key={ram}
                  onClick={() => setSelectedModel(model.name)}
                  className={`w-full text-left border p-4 cursor-pointer transition-colors space-y-2 ${
                    selectedModel === model.name
                      ? 'border-primary bg-primary/5'
                      : 'border-[#262626] hover:border-[#404040]'
                  } ${ram === selectedRam ? 'ring-1 ring-primary/30' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[13px] font-bold text-white">{model.name}</span>
                    <div className="flex gap-2 shrink-0">
                      {isInstalled && (
                        <span className="font-mono text-[8px] text-primary border border-primary/30 px-2 py-0.5 uppercase tracking-widest">
                          Installed
                        </span>
                      )}
                      {ram === selectedRam && (
                        <span className="font-mono text-[8px] text-primary border border-primary/30 px-2 py-0.5 uppercase tracking-widest">
                          Recommended
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-4 flex-wrap">
                    <span className="font-mono text-[10px] text-text-muted">Size: {model.size}</span>
                    <span className="font-mono text-[10px] text-text-muted">Speed: {model.speed}</span>
                    <span className="font-mono text-[10px] text-text-muted">{model.note}</span>
                  </div>
                  {!isInstalled && (
                    <div className="bg-[#050505] border border-[#1a1a1a] px-3 py-2">
                      <code className="font-mono text-[11px] text-primary">ollama pull {model.name}</code>
                    </div>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => setStep(4)}
              disabled={!selectedModel}
              className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              Test Connection →
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="border border-[#262626] bg-[#0a0a0a] p-6 space-y-4">
            <p className="font-mono text-[11px] text-text-muted">
              Testing connection to Ollama with model <span className="text-primary">{selectedModel}</span>...
            </p>
            {testResult === null && (
              <button
                onClick={runConnectionTest}
                disabled={loading}
                className="w-full border border-primary/40 text-primary font-mono text-[11px] uppercase tracking-widest py-3 hover:bg-primary/10 transition-colors cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Testing...' : 'Run Connection Test'}
              </button>
            )}
            {testResult?.success && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[18px]">check_circle</span>
                  <span className="font-mono text-[11px] text-primary">Connection successful - {testResult.latency}ms</span>
                </div>
                <button
                  onClick={() => setStep(5)}
                  className="w-full bg-primary text-[#050505] font-mono text-[11px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Complete Setup →
                </button>
              </div>
            )}
            {testResult?.success === false && (
              <div className="space-y-3">
                <p className="font-mono text-[11px] text-red-400">Connection failed. Is Ollama running?</p>
                <code className="font-mono text-[11px] text-primary block">ollama serve</code>
                <button
                  onClick={() => setTestResult(null)}
                  className="w-full border border-[#262626] text-text-muted font-mono text-[11px] uppercase tracking-widest py-3 hover:border-text-muted transition-colors cursor-pointer"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="border border-primary/30 bg-primary/5 p-6 space-y-4 text-center">
            <span className="material-symbols-outlined text-primary text-[48px] block">check_circle</span>
            <h2 className="font-mono text-[18px] font-bold text-white uppercase tracking-widest">Setup Complete</h2>
            <p className="font-mono text-[11px] text-text-muted">
              Ollama configured with <span className="text-primary">{selectedModel}</span>. Your API key has been created automatically.
            </p>
            <button
              onClick={handleComplete}
              disabled={loading}
              className="w-full bg-primary text-[#050505] font-mono text-[12px] uppercase tracking-widest py-3 font-bold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Creating API key...' : 'Enter Eudora →'}
            </button>
          </div>
        )}

        {step < 5 && (
          <div className="text-center">
            <button
              onClick={handleSkip}
              className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted uppercase tracking-widest cursor-pointer"
            >
              Skip - I'll configure this manually
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function OllamaUrlField({ ollamaUrl, onChange, onRecheck, checking }) {
  return (
    <div className="space-y-1">
      <label className="font-mono text-[9px] text-text-muted uppercase tracking-widest">
        Ollama URL
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={ollamaUrl}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-[#050505] border border-[#262626] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-primary"
          placeholder="http://localhost:11434"
        />
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className="border border-primary/40 text-primary font-mono text-[9px] uppercase tracking-widest px-3 py-2 hover:bg-primary/10 transition-colors cursor-pointer disabled:opacity-50"
        >
          {checking ? 'Checking...' : 'Re-check'}
        </button>
      </div>
      <p className="font-mono text-[9px] text-text-muted/60">
        Change this if Ollama runs on a different machine on your network.
      </p>
    </div>
  );
}
