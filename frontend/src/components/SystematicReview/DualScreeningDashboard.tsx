/**
 * DualScreeningDashboard — SR Phase 3 (title/abstract or full-text)
 * Two-panel layout: paper list on left, decision form on right.
 */
import { useState, useEffect, useRef } from 'react';
import {
  getScreeningQueue,
  streamAIScreen,
  saveHumanScreening,
  getPrismaFlow,
  type ScreeningEntry,
  type PRISMAFlow,
} from '../../api/sr';

interface Props {
  projectId: string;
  stage: 'title_abstract' | 'full_text';
  onGoToNext: () => void;
  onOpenSettings: () => void;
}

const DECISION_CONFIG: Record<string, { label: string; dot: string; border: string; text: string }> = {
  include:    { label: 'Include',     dot: 'bg-emerald-500', border: 'border-emerald-300 bg-emerald-50', text: 'text-emerald-700' },
  exclude:    { label: 'Exclude',     dot: 'bg-rose-500',    border: 'border-rose-300 bg-rose-50',       text: 'text-rose-700' },
  uncertain:  { label: 'Uncertain',   dot: 'bg-amber-500',   border: 'border-amber-300 bg-amber-50',     text: 'text-amber-700' },
  conflict:   { label: 'Conflict',    dot: 'bg-orange-500',  border: 'border-orange-200 bg-orange-50',   text: 'text-orange-700' },
  unscreened: { label: 'Unscreened',  dot: 'bg-slate-300',   border: 'border-slate-200 bg-slate-50',     text: 'text-slate-500' },
};

const EXCLUSION_CATEGORIES = [
  'Wrong population', 'Wrong intervention', 'Wrong comparator',
  'Wrong outcome', 'Wrong study design', 'Duplicate', 'Not peer reviewed',
  'Wrong language', 'Conference abstract only', 'Other',
];

function getDecisionKey(entry: ScreeningEntry): string {
  if (entry.is_conflict) return 'conflict';
  const d = entry.human_decision || entry.final_decision || entry.ai_decision;
  if (!d) return 'unscreened';
  return d.toLowerCase();
}

function StatusDot({ entry }: { entry: ScreeningEntry }) {
  const key = getDecisionKey(entry);
  const cfg = DECISION_CONFIG[key] ?? DECISION_CONFIG.unscreened;
  return <span className={`inline-block w-2 h-2 rounded-full ${cfg.dot} shrink-0`} />;
}

export default function DualScreeningDashboard({ projectId, stage, onGoToNext }: Props) {
  const [papers, setPapers] = useState<ScreeningEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ScreeningEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiTotal, setAiTotal] = useState(0);
  const [flow, setFlow] = useState<PRISMAFlow | null>(null);
  const [humanDecision, setHumanDecision] = useState('');
  const [exclusionCategory, setExclusionCategory] = useState('');
  const [exclusionReason, setExclusionReason] = useState('');
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function loadQueue() {
    getScreeningQueue(projectId, stage)
      .then(({ papers: p, total: t }) => {
        setPapers(p);
        setTotal(t);
        if (p.length > 0 && !selected) setSelected(p[0]);
      })
      .catch(() => setError('Failed to load screening queue.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setLoading(true);
    loadQueue();
    getPrismaFlow(projectId).then(setFlow).catch(() => {});
  }, [projectId, stage]);

  useEffect(() => {
    if (selected) {
      setHumanDecision(selected.human_decision || '');
      setExclusionCategory(selected.exclusion_reason_category || '');
      setExclusionReason('');
    }
  }, [selected?.paper_key]);

  function handleAIScreen() {
    setAiRunning(true);
    setAiProgress(0);
    setAiTotal(papers.length);

    abortRef.current = streamAIScreen(
      projectId,
      stage,
      undefined,
      (ev) => {
        if (typeof ev.completed === 'number') setAiProgress(ev.completed as number);
        if (typeof ev.total === 'number') setAiTotal(ev.total as number);
        if (ev.paper_key && ev.decision) {
          setPapers((ps) =>
            ps.map((p) =>
              p.paper_key === ev.paper_key
                ? { ...p, ai_decision: ev.decision as string, ai_confidence: ev.confidence as number ?? p.ai_confidence, ai_reason: ev.reason as string ?? p.ai_reason }
                : p,
            ),
          );
        }
      },
      () => {
        setAiRunning(false);
        loadQueue();
        getPrismaFlow(projectId).then(setFlow).catch(() => {});
      },
      (err) => { setError(err); setAiRunning(false); },
    );
  }

  async function handleSaveDecision() {
    if (!selected || !humanDecision) return;
    setSaving(true);
    try {
      await saveHumanScreening(
        projectId,
        selected.paper_key,
        stage,
        humanDecision,
        exclusionReason,
        exclusionCategory || undefined,
      );
      setPapers((ps) =>
        ps.map((p) =>
          p.paper_key === selected.paper_key
            ? { ...p, human_decision: humanDecision, exclusion_reason_category: exclusionCategory }
            : p,
        ),
      );
      setSelected((s) => s ? { ...s, human_decision: humanDecision } : s);
    } catch {
      setError('Failed to save decision.');
    } finally {
      setSaving(false);
    }
  }

  const screened = papers.filter((p) => p.human_decision || p.final_decision).length;
  const allDone = total > 0 && screened === total;

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-sm text-slate-400">Loading queue…</div>;
  }

  return (
    <div className="space-y-4 pb-8">
      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg border border-rose-200">{error}</div>
      )}

      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
            {stage === 'title_abstract' ? 'Title / Abstract' : 'Full Text'} Screening
          </span>
          {flow && (
            <span className="text-xs text-slate-400">
              Identified: {flow.identified} | After dedup: {Math.max(0, flow.identified - flow.duplicates_removed)} | Included: {flow.included}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{screened}/{total} screened</span>
          <button
            onClick={handleAIScreen}
            disabled={aiRunning}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {aiRunning ? 'AI Screening…' : 'AI Screen All'}
          </button>
        </div>
      </div>

      {/* AI progress bar */}
      {aiRunning && aiTotal > 0 && (
        <div className="rounded-lg overflow-hidden h-2" style={{ background: 'var(--bg-surface)' }}>
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${Math.round((aiProgress / aiTotal) * 100)}%`, background: 'var(--gold)' }}
          />
        </div>
      )}

      {/* Two-panel layout */}
      <div className="grid grid-cols-5 gap-4" style={{ minHeight: '480px' }}>
        {/* Left: paper list */}
        <div
          className="col-span-2 rounded-xl border overflow-hidden flex flex-col"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div className="px-3 py-2 border-b text-[10px] font-mono uppercase tracking-wider text-slate-400" style={{ borderColor: 'var(--border-muted)' }}>
            {total} Papers
          </div>
          <div className="flex-1 overflow-y-auto">
            {papers.map((p) => {
              const key = getDecisionKey(p);
              const cfg = DECISION_CONFIG[key] ?? DECISION_CONFIG.unscreened;
              return (
                <button
                  key={p.paper_key}
                  onClick={() => setSelected(p)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-b text-xs transition-colors hover:bg-amber-50/30 ${
                    selected?.paper_key === p.paper_key ? 'bg-amber-50/60' : ''
                  }`}
                  style={{ borderColor: 'var(--border-muted)' }}
                >
                  <StatusDot entry={p} />
                  <span className="flex-1 font-mono text-slate-600 truncate">{p.paper_key}</span>
                  {p.ai_decision && (
                    <span className={`shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded border ${cfg.border} ${cfg.text}`}>
                      AI:{p.ai_decision.slice(0, 3)}
                    </span>
                  )}
                </button>
              );
            })}
            {papers.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8">No papers in queue.</p>
            )}
          </div>
        </div>

        {/* Right: detail panel */}
        <div
          className="col-span-3 rounded-xl border p-4 flex flex-col gap-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          {!selected ? (
            <p className="text-sm text-slate-400 text-center py-12">Select a paper to review.</p>
          ) : (
            <>
              <div>
                <p className="font-mono text-xs text-slate-500 mb-1">Paper Key</p>
                <p className="text-sm font-medium break-all" style={{ color: 'var(--text-bright)' }}>{selected.paper_key}</p>
              </div>

              {selected.ai_decision && (
                <div
                  className="rounded-lg p-3 border"
                  style={{ background: 'var(--bg-base)', borderColor: 'var(--border-muted)' }}
                >
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-2">AI Decision</p>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-mono px-2 py-0.5 rounded border ${(DECISION_CONFIG[selected.ai_decision.toLowerCase()] ?? DECISION_CONFIG.unscreened).border} ${(DECISION_CONFIG[selected.ai_decision.toLowerCase()] ?? DECISION_CONFIG.unscreened).text}`}>
                      {selected.ai_decision}
                    </span>
                    {selected.ai_confidence != null && (
                      <span className="text-xs text-slate-400">
                        {Math.round(selected.ai_confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  {selected.ai_reason && (
                    <p className="text-xs text-slate-500 mt-1">{selected.ai_reason}</p>
                  )}
                </div>
              )}

              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-2">Your Decision</p>
                <div className="flex gap-2">
                  {['include', 'exclude', 'uncertain'].map((d) => {
                    const cfg = DECISION_CONFIG[d];
                    return (
                      <button
                        key={d}
                        onClick={() => setHumanDecision(d)}
                        className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                          humanDecision === d
                            ? `${cfg.border} ${cfg.text} font-medium`
                            : 'border-slate-200 text-slate-500 hover:border-slate-300'
                        }`}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {humanDecision === 'exclude' && (
                <div className="space-y-2">
                  <div>
                    <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Exclusion Reason</label>
                    <select
                      value={exclusionCategory}
                      onChange={(e) => setExclusionCategory(e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
                      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                    >
                      <option value="">— Select category —</option>
                      {EXCLUSION_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    rows={2}
                    value={exclusionReason}
                    onChange={(e) => setExclusionReason(e.target.value)}
                    placeholder="Optional: additional notes"
                    className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none focus:outline-none"
                    style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                  />
                </div>
              )}

              <button
                onClick={handleSaveDecision}
                disabled={!humanDecision || saving}
                className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-40 self-start"
              >
                {saving ? 'Saving…' : 'Save Decision'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Proceed */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onGoToNext}
          disabled={!allDone}
          className="btn-primary px-5 py-2.5 rounded-lg text-sm disabled:opacity-40"
        >
          Proceed →
        </button>
      </div>
    </div>
  );
}
