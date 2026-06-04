import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import api from '../api/client';

const COMMON_TAGS = ['general', 'coding', 'compliance'];
const CONTEXT_LIMIT = 50;

export default function ContextManager() {
  const { id: agentId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [files, setFiles] = useState([]);
  const [activeTab, setActiveTab] = useState('paste');
  const [filename, setFilename] = useState('context.md');
  const [content, setContent] = useState('');
  const [tagInput, setTagInput] = useState(COMMON_TAGS.join(', '));
  const [selectedFile, setSelectedFile] = useState(null);
  const [newTag, setNewTag] = useState('');
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const loadContext = async () => {
      setIsLoading(true);
      try {
        const [agentRes, contextRes] = await Promise.all([
          api.get(`/agents/${agentId}`),
          api.get('/context', { params: { agentId } }),
        ]);
        if (!isMounted) return;
        setAgent(agentRes.data);
        setFiles(contextRes.data);
      } catch (err) {
        if (isMounted) setStatus(err.response?.data?.error || 'Unable to load context');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    loadContext();

    return () => {
      isMounted = false;
    };
  }, [agentId]);

  const tags = tagInput.split(',').map(tag => tag.trim()).filter(Boolean);
  const usageRatio = files.length / CONTEXT_LIMIT;

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setContent(await file.text());
  };

  const handleUpload = async () => {
    if (!filename.trim() || !content.trim()) return;
    setIsLoading(true);
    setStatus('');

    try {
      const res = await api.post('/context', {
        agentId,
        filename,
        tags,
        content,
      });
      setFiles(prev => [res.data, ...prev]);
      setFilename('context.md');
      setContent('');
      setTagInput(COMMON_TAGS.join(', '));
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to upload context');
    } finally {
      setIsLoading(false);
    }
  };

  const patchTags = async (file, nextTags) => {
    try {
      const res = await api.patch(`/context/${file.id}/tags`, { tags: nextTags });
      setFiles(prev => prev.map(item => item.id === file.id ? { ...item, tags: res.data.tags, updated_at: res.data.updated_at } : item));
      setSelectedFile(prev => prev?.id === file.id ? { ...prev, tags: res.data.tags, updated_at: res.data.updated_at } : prev);
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to update tags');
    }
  };

  const removeTag = (tag) => {
    if (!selectedFile) return;
    patchTags(selectedFile, selectedFile.tags.filter(item => item !== tag));
  };

  const addTag = () => {
    if (!selectedFile || !newTag.trim()) return;
    const nextTags = Array.from(new Set([...selectedFile.tags, newTag.trim()]));
    setNewTag('');
    patchTags(selectedFile, nextTags);
  };

  const openPreview = async (file) => {
    setStatus('');
    try {
      const res = await api.get(`/context/${file.id}`);
      setPreview(res.data);
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to load preview');
    }
  };

  const deleteFile = async (file) => {
    if (!window.confirm(`Delete ${file.filename}?`)) return;

    try {
      await api.delete(`/context/${file.id}`);
      setFiles(prev => prev.filter(item => item.id !== file.id));
      if (selectedFile?.id === file.id) setSelectedFile(null);
      if (preview?.id === file.id) setPreview(null);
    } catch (err) {
      setStatus(err.response?.data?.error || 'Unable to delete context');
    }
  };

  return (
    <div className="flex flex-col gap-8 fade-in pb-12 w-full">
      <div className="border-l-[4px] border-primary pl-6 py-2">
        <button onClick={() => navigate('/agents')} className="font-mono text-[9px] text-text-muted hover:text-white uppercase tracking-[0.2em] mb-2 cursor-pointer">← BACK TO FLEET</button>
        <h1 className="font-mono text-[24px] md:text-[32px] font-bold text-white mb-1 uppercase tracking-tight leading-none">CONTEXT MANAGER</h1>
        <p className="font-mono text-[9px] text-primary uppercase tracking-[0.2em] leading-none mt-2">{agent?.name || 'AGENT'} / KNOWLEDGE BASE</p>
      </div>

      {usageRatio >= 0.8 && (
        <div className="w-full bg-warning/10 border border-warning/30 flex items-center justify-center py-3">
          <span className="font-mono text-[10px] uppercase text-warning tracking-[0.15em]">You're using {files.length} of {CONTEXT_LIMIT} context file slots</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-8">
        <div className="border border-[#262626] bg-[#0a0a0a] p-6 lg:p-8">
          <div className="flex items-center gap-3 mb-6">
            <span className="material-symbols-outlined text-primary text-[20px]">upload_file</span>
            <h2 className="font-mono text-[14px] text-white uppercase font-bold tracking-widest">CONTEXT UPLOAD</h2>
          </div>

          <div className="flex border-b border-[#262626] mb-6">
            <button onClick={() => setActiveTab('paste')} className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'paste' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}>
              PASTE TEXT
            </button>
            <button onClick={() => setActiveTab('upload')} className={`flex-1 pb-3 font-mono text-[10px] uppercase font-bold tracking-[0.15em] transition-colors ${activeTab === 'upload' ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-white'}`}>
              UPLOAD .MD FILE
            </button>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">FILENAME</label>
              <input value={filename} onChange={(e) => setFilename(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
            </div>

            {activeTab === 'paste' ? (
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">MARKDOWN_CONTENT</label>
                <textarea rows={12} value={content} onChange={(e) => setContent(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white p-4 font-mono text-[13px] focus:border-primary resize-none"></textarea>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">MARKDOWN_FILE</label>
                <input type="file" accept=".md" onChange={handleFile} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
              </div>
            )}

            <div className="space-y-2">
              <label className="font-mono text-[10px] text-primary uppercase tracking-[0.15em] block">TAGS</label>
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} className="w-full bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
              <div className="flex flex-wrap gap-2">
                {tags.map(tag => (
                  <span key={tag} className="border border-primary px-3 py-1 bg-primary/10 font-mono text-[10px] text-primary uppercase">{tag}</span>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              {status && <span className="font-mono text-[12px] text-danger uppercase fade-in">{status}</span>}
              <button onClick={handleUpload} disabled={isLoading || !filename.trim() || !content.trim()} className="primary-btn relative bg-primary text-[#050505] py-3 px-8 font-mono text-[12px] font-bold uppercase tracking-[0.15em] transition-all overflow-hidden active:scale-[0.98] cursor-pointer disabled:opacity-50 ml-auto">
                <span className="relative z-10">{isLoading ? 'UPLOADING...' : 'UPLOAD'}</span>
                <div className="scan-line"></div>
              </button>
            </div>
          </div>
        </div>

        <div className="border border-[#262626] bg-[#0a0a0a] flex flex-col min-h-[520px]">
          <div className="px-6 py-4 border-b border-[#262626] flex items-center justify-between bg-[#050505]">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[18px]">folder_open</span>
              <span className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">CONTEXT FILES</span>
            </div>
            <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{files.length} / {CONTEXT_LIMIT}</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {files.length === 0 ? (
              <div className="p-8 text-center">
                <span className="material-symbols-outlined text-primary text-[32px] mb-4">description</span>
                <p className="font-mono text-[12px] text-text-muted uppercase tracking-widest">NO CONTEXT FILES</p>
              </div>
            ) : files.map(file => (
              <div key={file.id} onClick={() => setSelectedFile(file)} className={`p-4 border-b border-[#262626] cursor-pointer transition-colors ${selectedFile?.id === file.id ? 'bg-primary/10 border-l-2 border-primary' : 'hover:bg-[#050505]'}`}>
                <div className="flex items-start justify-between gap-4">
                  <button onClick={(e) => { e.stopPropagation(); openPreview(file); }} className="font-mono text-[12px] text-white uppercase tracking-widest hover:text-primary transition-colors text-left truncate">
                    {file.filename}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); deleteFile(file); }} className="text-text-muted hover:text-danger transition-colors cursor-pointer">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {file.tags.map(tag => (
                    <span key={tag} className="border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary uppercase">{tag}</span>
                  ))}
                </div>
                <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest mt-3 block">UPDATED {formatTimestamp(file.updated_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedFile && (
        <div className="border border-[#262626] bg-[#0a0a0a] p-6">
          <div className="flex items-center justify-between border-b border-[#262626] pb-4 mb-4">
            <h3 className="font-mono text-[13px] text-primary uppercase font-bold tracking-widest">TAG_EDITOR / {selectedFile.filename}</h3>
            <button onClick={() => setSelectedFile(null)} className="text-text-muted hover:text-white transition-colors cursor-pointer">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {selectedFile.tags.map(tag => (
              <button key={tag} onClick={() => removeTag(tag)} className="flex items-center gap-2 border border-primary px-3 py-1 bg-primary/10 cursor-pointer">
                <span className="font-mono text-[10px] text-primary uppercase">{tag}</span>
                <span className="material-symbols-outlined text-[14px] text-primary">close</span>
              </button>
            ))}
          </div>
          <div className="flex gap-4">
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }} className="flex-1 bg-[#050505] border border-[#262626] text-white px-4 py-3 font-mono text-[13px] focus:border-primary" />
            <button onClick={addTag} className="border border-text-muted text-text-muted hover:border-white hover:text-white px-6 py-2 font-mono text-[10px] uppercase font-bold tracking-widest transition-colors cursor-pointer">
              ADD TAG
            </button>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 bg-[#050505]/90 backdrop-blur flex items-center justify-center p-8">
          <div className="w-full max-w-[900px] max-h-[80vh] border border-[#262626] bg-[#0a0a0a] flex flex-col">
            <div className="px-6 py-4 border-b border-[#262626] flex items-center justify-between bg-[#050505]">
              <span className="font-mono text-[12px] font-bold text-white uppercase tracking-widest">{preview.filename}</span>
              <button onClick={() => setPreview(null)} className="text-text-muted hover:text-white transition-colors cursor-pointer">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="p-6 overflow-y-auto text-white font-sans leading-relaxed markdown-preview">
              <ReactMarkdown>{preview.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'JUST NOW';
  return new Date(Number(timestamp)).toLocaleString();
}
