/**
 * DataExtractionDashboard — SR Phase 4
 * Extract all papers, view/edit per-field AI extractions, verify, export CSV.
 */
import { useState, useEffect, useRef } from 'react';
import {
  getScreeningQueue,
  streamExtractAll,
  getExtraction,
  getProtocol,
  saveHumanVerification,
  type ScreeningEntry,
  type ExtractionData,
  type SchemaField,
} from '../../api/sr';

interface Props {
  projectId: string;
  onGoToRoB: () => void;
  onOpenSettings: () => void;
}

const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

function confidenceBadge(conf: number) {
  const pct = Math.round(conf * 100);
  const cls =
    pct >= 80 ? 'bg-emerald-100 text-emerald-700' :
    pct >= 50 ? 'bg-amber-100 text-amber-700' :
                'bg-rose-100 text-rose-600';
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}>{pct}%</span>;
}

export default function DataExtractionDashboard({ projectId, onGoToRoB }: Props) {
  const [papers, setPapers] = useState<ScreeningEntry[]>([]);
  const [loadingPapers, setLoadingPapers] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);
  const [extractTotal, setExtractTotal] = useState(0);
  const [currentPaperKey, setCurrentPaperKey] = useState('');
  const [selectedPaper, setSelectedPaper] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [loadingExtraction, setLoadingExtraction] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [extractedSet, setExtractedSet] = useState<Set<string>>(new Set());
  const [schemaMap, setSchemaMap] = useState<Record<string, SchemaField>>({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getProtocol(projectId)
      .then((p) => {
        const map: Record<string, SchemaField> = {};
        (p.data_extraction_schema || []).forEach((f) => { map[f.field] = f; });
        setSchemaMap(map);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    getScreeningQueue(projectId, 'full_text', 'include')
      .then(({ papers: p }) => {
        setPapers(p);
        if (p.length > 0) setExtractTotal(p.length);
      })
      .catch(() => setError('Failed to load included papers.'))
      .finally(() => setLoadingPapers(false));
  }, [projectId]);

  useEffect(() => {
    if (!selectedPaper) return;
    setLoadingExtraction(true);
    setExtraction(null);
    setOverrides({});
    setNotes('');
    getExtraction(projectId, selectedPaper)
      .then((d) => {
        setExtraction(d);
        const initial: Record<string, string> = {};
        Object.entries(d.human_verified || {}).forEach(([k, v]) => {
          initial[k] = String(v ?? '');
        });
        setOverrides(initial);
        setNotes(d.extraction_notes || '');
      })
      .catch(() => {})
      .finally(() => setLoadingExtraction(false));
  }, [selectedPaper, projectId]);

  function handleExtractAll() {
    setExtracting(true);
    setExtractProgress(0);

    abortRef.current = streamExtractAll(
      projectId,
      (ev) => {
        if (ev.paper_key) {
          setCurrentPaperKey(ev.paper_key as string);
          setExtractedSet((s) => new Set([...s, ev.paper_key as string]));
        }
        if (typeof ev.completed === 'number') setExtractProgress(ev.completed as number);
        if (typeof ev.total === 'number') setExtractTotal(ev.total as number);
      },
      () => {
        setExtracting(false);
        setCurrentPaperKey('');
      },
      (err) => { setError(err); setExtracting(false); },
    );
  }

  async function handleSave() {
    if (!selectedPaper) return;
    setSaving(true);
    const humanVerified: Record<string, unknown> = {};
    Object.entries(overrides).forEach(([k, v]) => {
      humanVerified[k] = v;
    });
    try {
      await saveHumanVerification(projectId, selectedPaper, humanVerified, notes);
      setExtractedSet((s) => new Set([...s, selectedPaper]));
    } catch {
      setError('Failed to save verification.');
    } finally {
      setSaving(false);
    }
  }

  const extractedFields = extraction
    ? { ...extraction.ai_extracted, ...extraction.final_data }
    : {};

  return (
    <div className="space-y-4 pb-8">
      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg border border-rose-200">{error}</div>
      )}

      {/* Top bar */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
          Data Extraction — {papers.length} included papers
        </span>
        <div className="flex gap-2">
          <a
            href={`${baseUrl}/api/sr/${projectId}/extraction/export_csv`}
            download
            className="text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 transition-colors"
          >
            Export CSV
          </a>
          <button
            onClick={handleExtractAll}
            disabled={extracting || loadingPapers}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {extracting ? 'Extracting…' : 'Extract All Papers'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {extracting && extractTotal > 0 && (
        <div>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>{currentPaperKey ? `Extracting: ${currentPaperKey}` : 'Starting…'}</span>
            <span>{extractProgress}/{extractTotal}</span>
          </div>
          <div className="rounded-full overflow-hidden h-2" style={{ background: 'var(--bg-surface)' }}>
            <div
              className="h-full transition-all duration-300"
              style={{ width: `${extractTotal > 0 ? Math.round((extractProgress / extractTotal) * 100) : 0}%`, background: 'var(--gold)' }}
            />
          </div>
        </div>
      )}

      {/* Two-panel layout */}
      {!loadingPapers && (
        <div className="grid grid-cols-5 gap-4" style={{ minHeight: '480px' }}>
          {/* Left: paper list */}
          <div
            className="col-span-2 rounded-xl border overflow-hidden flex flex-col"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
          >
            <div className="px-3 py-2 border-b text-[10px] font-mono uppercase tracking-wider text-slate-400" style={{ borderColor: 'var(--border-muted)' }}>
              Included Papers
            </div>
            <div className="flex-1 overflow-y-auto">
              {papers.map((p) => {
                const hasData = extractedSet.has(p.paper_key);
                return (
                  <button
                    key={p.paper_key}
                    onClick={() => setSelectedPaper(p.paper_key)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-b text-xs transition-colors hover:bg-amber-50/30 ${
                      selectedPaper === p.paper_key ? 'bg-amber-50/60' : ''
                    }`}
                    style={{ borderColor: 'var(--border-muted)' }}
                  >
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${hasData ? 'bg-emerald-400' : 'bg-slate-200'}`} />
                    <span className="flex-1 font-mono text-slate-600 truncate">{p.paper_key}</span>
                  </button>
                );
              })}
              {papers.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-8">No included papers yet.</p>
              )}
            </div>
          </div>

          {/* Right: extraction form */}
          <div
            className="col-span-3 rounded-xl border p-4 flex flex-col gap-3 overflow-y-auto"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
          >
            {!selectedPaper ? (
              <p className="text-sm text-slate-400 text-center py-12">Select a paper to view extraction data.</p>
            ) : loadingExtraction ? (
              <p className="text-sm text-slate-400 text-center py-12">Loading…</p>
            ) : !extraction ? (
              <p className="text-sm text-slate-400 text-center py-12">No extraction data yet. Run extraction first.</p>
            ) : (
              <>
                <p className="font-mono text-xs text-slate-500">{selectedPaper}</p>
                <div className="space-y-3">
                  {Object.entries(extractedFields).map(([field]) => {
                    const aiInfo = extraction.ai_extracted?.[field];
                    const aiVal = aiInfo ? String(aiInfo.value ?? '') : '';
                    const conf = aiInfo?.confidence ?? 0;
                    const quote = aiInfo?.quote ?? '';
                    const fieldMeta = schemaMap[field];
                    return (
                      <div key={field} className="rounded-lg border p-3" style={{ background: 'var(--bg-base)', borderColor: 'var(--border-muted)' }}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{field}</span>
                          {fieldMeta?.type && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-400 font-mono">{fieldMeta.type}</span>
                          )}
                          {aiInfo && confidenceBadge(conf)}
                        </div>
                        {fieldMeta?.description && (
                          <p className="text-[10px] text-slate-400 mb-2">{fieldMeta.description}</p>
                        )}
                        {aiVal && (
                          <div className="mb-2 px-2 py-1.5 rounded text-xs" style={{ background: 'var(--gold-faint)', color: 'var(--text-primary)' }}>
                            <span className="font-mono text-[9px] text-slate-400 block mb-0.5">AI</span>
                            {aiVal}
                          </div>
                        )}
                        {quote && (
                          <p className="text-[10px] text-slate-400 italic mb-2 line-clamp-2">"{quote}"</p>
                        )}
                        <input
                          value={overrides[field] ?? aiVal}
                          onChange={(e) => setOverrides((o) => ({ ...o, [field]: e.target.value }))}
                          placeholder="Human override (leave blank to use AI value)"
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
                          style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                        />
                      </div>
                    );
                  })}
                </div>

                <div>
                  <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Extraction Notes</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none focus:outline-none"
                    style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                  />
                </div>

                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50 self-start"
                >
                  {saving ? 'Saving…' : 'Save Verification'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Proceed */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onGoToRoB}
          disabled={papers.length === 0}
          className="btn-primary px-5 py-2.5 rounded-lg text-sm disabled:opacity-40"
        >
          Proceed to RoB →
        </button>
      </div>
    </div>
  );
}
