import { useEffect, useRef, useState } from 'react';
import { streamCrossReferences, type CrossRefEvent } from '../../api/crossref';

interface Props {
  sessionId: string;
  onBack: () => void;
  onGoToJournals: (sessionId: string) => void;
  onOpenSettings: () => void;
}

interface FetchedPaper {
  paper_key: string;
  title: string;
  depth: number;
  text_source: string;
  triage_decision: string;
  one_line_takeaway: string;
  focus_notes: string[];
  success: boolean;
  error?: string;
}

type RunState = 'idle' | 'running' | 'done' | 'error';

export default function CrossReferenceDashboard({
  sessionId,
  onBack,
  onGoToJournals,
  onOpenSettings,
}: Props) {
  const [depth, setDepth] = useState<1 | 2>(1);
  const [runState, setRunState]   = useState<RunState>('idle');
  const [fetchedPapers, setFetchedPapers] = useState<FetchedPaper[]>([]);
  const [skipLog, setSkipLog]     = useState<{ ref: string; reason: string }[]>([]);
  const [progress, setProgress]   = useState({ index: 0, total: 0 });
  const [currentRef, setCurrentRef] = useState('');
  const [summary, setSummary]     = useState<{ total: number; by_depth: Record<string, number> } | null>(null);
  const [startStats, setStartStats] = useState<{ total_cited: number; intro_hits: number; disc_hits: number } | null>(null);
  const [warnings, setWarnings]   = useState<string[]>([]);
  const [showSkipLog, setShowSkipLog] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll live feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [fetchedPapers.length, currentRef]);

  function handleStart() {
    if (runState === 'running') return;
    setRunState('running');
    setFetchedPapers([]);
    setSkipLog([]);
    setProgress({ index: 0, total: 0 });
    setCurrentRef('');
    setSummary(null);
    setStartStats(null);
    setWarnings([]);

    esRef.current = streamCrossReferences(sessionId, depth, (evt: CrossRefEvent) => {
      switch (evt.type) {
        case 'start':
          setProgress({ index: 0, total: evt.to_process ?? 0 });
          setStartStats({
            total_cited: evt.total_cited ?? 0,
            intro_hits: evt.priority_intro_hits ?? 0,
            disc_hits: evt.priority_discussion_hits ?? 0,
          });
          break;
        case 'resolving':
          setCurrentRef(evt.ref ?? '');
          setProgress({ index: evt.index ?? 0, total: evt.total ?? 0 });
          break;
        case 'paper_done':
          setProgress((p) => ({ ...p, index: evt.index ?? p.index }));
          if (evt.success) {
            setFetchedPapers((prev) => [
              ...prev,
              {
                paper_key: evt.paper_key ?? '',
                title: evt.title ?? '',
                depth: evt.depth ?? 1,
                text_source: evt.text_source ?? 'abstract_only',
                triage_decision: evt.triage_decision ?? 'maybe',
                one_line_takeaway: evt.one_line_takeaway ?? '',
                focus_notes: evt.focus_notes ?? [],
                success: true,
              },
            ]);
          } else {
            setFetchedPapers((prev) => [
              ...prev,
              {
                paper_key: '',
                title: evt.title ?? '',
                depth: evt.depth ?? 1,
                text_source: 'none',
                triage_decision: 'exclude',
                one_line_takeaway: '',
                focus_notes: [],
                success: false,
                error: evt.error,
              },
            ]);
          }
          break;
        case 'skip':
          setSkipLog((prev) => [...prev, { ref: evt.ref ?? '', reason: evt.reason ?? '' }]);
          break;
        case 'warning':
          setWarnings((prev) => [...prev, evt.message ?? '']);
          break;
        case 'complete':
          setRunState('done');
          setCurrentRef('');
          setSummary({
            total: evt.total_fetched ?? 0,
            by_depth: evt.by_depth ?? {},
          });
          break;
        case 'error':
          setRunState('error');
          setWarnings((prev) => [...prev, evt.message ?? 'Unknown error']);
          break;
      }
    });
  }

  function handleStop() {
    esRef.current?.close();
    setRunState('idle');
    setCurrentRef('');
  }

  const progressPct = progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0;

  const sourceLabel: Record<string, string> = {
    pmc_xml:       'PMC XML',
    full_pdf:      'PDF',
    full_html:     'HTML',
    abstract_only: 'Abstract',
    none:          'No text',
  };


  const decisionColor: Record<string, string> = {
    include: 'bg-green-100 text-green-700',
    maybe:   'bg-amber-100 text-amber-700',
    exclude: 'bg-rose-100 text-rose-700',
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="text-slate-400 hover:text-slate-700 shrink-0"
              title="Back to Literature"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                </svg>
              </div>
              <div className="min-w-0">
                <h1 className="font-semibold text-slate-900 text-sm truncate">Cross-Reference Analysis</h1>
                <p className="text-xs text-slate-400">Phase 3 · Session {sessionId}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onOpenSettings}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              title="Settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={() => onGoToJournals(sessionId)}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 transition-colors"
            >
              {runState === 'done' ? 'Continue to Journals →' : 'Skip to Journals →'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* ── Info banner ──────────────────────────────────────────────────── */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-5">
          <h2 className="font-semibold text-indigo-900 mb-1 text-sm">
            What is Cross-Reference Analysis?
          </h2>
          <p className="text-sm text-indigo-700 leading-relaxed">
            Your primary papers cite other works in their Introduction and Discussion sections.
            These cited papers contain the authentic background facts and context your manuscript
            needs. This step fetches and analyses those cited papers — giving you properly
            referenced claims to weave into your article.
          </p>
          <p className="text-xs text-indigo-500 mt-2">
            Tip: Papers must be summarized with full text (PMC XML or PDF) for their reference
            lists to be extracted. Abstract-only papers will yield no citations.
          </p>
        </div>

        {/* ── Citation stats (populated once 'start' event arrives) ───────── */}
        {startStats && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-center">
              <div className="text-xl font-bold text-slate-800">{startStats.total_cited}</div>
              <div className="text-xs text-slate-500 mt-0.5">citations found</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-center">
              <div className="text-xl font-bold text-indigo-600">{startStats.intro_hits}</div>
              <div className="text-xs text-slate-500 mt-0.5">from Introduction</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-center">
              <div className="text-xl font-bold text-violet-600">{startStats.disc_hits}</div>
              <div className="text-xs text-slate-500 mt-0.5">from Discussion</div>
            </div>
          </div>
        )}

        {/* ── Control panel ────────────────────────────────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Search Depth
            </label>
            <div className="flex gap-3">
              {([1, 2] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={runState === 'running'}
                  onClick={() => setDepth(d)}
                  className={`flex-1 rounded-xl border-2 px-4 py-3 text-sm font-medium text-left transition-all
                    ${depth === d
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <div className="font-semibold">
                    {d === 1 ? '1 Level Deep' : '2 Levels Deep'}
                    {d === 1 && (
                      <span className="ml-2 text-xs font-normal text-indigo-500">(Recommended)</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {d === 1
                      ? 'Papers cited by your primary papers'
                      : 'Also papers cited by those depth-1 papers — much larger corpus'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            {runState !== 'running' ? (
              <button
                onClick={handleStart}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white
                  bg-indigo-600 hover:bg-indigo-700 transition-colors"
              >
                {runState === 'idle' ? 'Fetch Cross-References' : 'Re-run Cross-Reference Fetch'}
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white
                  bg-rose-500 hover:bg-rose-600 transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {/* Progress bar */}
          {runState === 'running' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="truncate max-w-xs" title={currentRef}>
                  {currentRef ? `Resolving: ${currentRef}` : 'Starting…'}
                </span>
                <span className="shrink-0 ml-2">
                  {progress.index} / {progress.total}
                </span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-300 rounded-full"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Warnings ─────────────────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <div className="space-y-2">
            {warnings.map((w, i) => (
              <div key={i} className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
                {w}
              </div>
            ))}
          </div>
        )}

        {/* ── Summary stats ─────────────────────────────────────────────────── */}
        {summary && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-5">
            <h3 className="font-semibold text-green-800 text-sm mb-3">Fetch Complete</h3>
            <div className="flex flex-wrap gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-700">{summary.total}</div>
                <div className="text-xs text-green-600 mt-0.5">papers fetched</div>
              </div>
              {Object.entries(summary.by_depth).map(([d, count]) => (
                <div key={d} className="text-center">
                  <div className="text-2xl font-bold text-green-700">{count}</div>
                  <div className="text-xs text-green-600 mt-0.5">depth-{d}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Live paper feed ───────────────────────────────────────────────── */}
        {fetchedPapers.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 text-sm">
                Fetched Papers ({fetchedPapers.length})
              </h3>
            </div>
            <div
              ref={feedRef}
              className="max-h-96 overflow-y-auto divide-y divide-slate-50"
            >
              {fetchedPapers.map((p, i) => (
                <div key={i} className={`px-5 py-3 ${!p.success ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-3">
                    {/* Depth badge */}
                    <span className="mt-0.5 shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                      D{p.depth}
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 font-medium line-clamp-2">{p.title}</p>
                      {p.success ? (
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-slate-400">{sourceLabel[p.text_source] ?? p.text_source}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${decisionColor[p.triage_decision] ?? 'bg-slate-100 text-slate-600'}`}>
                            {p.triage_decision}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-rose-500 mt-0.5">{p.error || 'Failed'}</p>
                      )}
                    </div>

                    {p.success ? (
                      <svg className="w-4 h-4 text-green-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </div>

                  {/* One-line takeaway */}
                  {p.success && p.one_line_takeaway && (
                    <p className="mt-1.5 ml-9 text-xs text-slate-500 italic line-clamp-2">
                      {p.one_line_takeaway}
                    </p>
                  )}

                  {/* Claim context: why this paper was fetched */}
                  {p.success && p.focus_notes.length > 0 && (
                    <div className="mt-1.5 ml-9 space-y-1">
                      {p.focus_notes.map((note, ni) => {
                        const isIntro = note.startsWith('Introduction');
                        return (
                          <div key={ni} className="flex items-start gap-1.5">
                            <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full mt-0.5
                              ${isIntro ? 'bg-indigo-50 text-indigo-500' : 'bg-violet-50 text-violet-500'}`}>
                              {isIntro ? 'Intro' : 'Discussion'}
                            </span>
                            <p className="text-xs text-slate-400 line-clamp-2">{note.replace(/^(Introduction|Discussion) support point: /, '')}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Skip log ─────────────────────────────────────────────────────── */}
        {skipLog.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowSkipLog((v) => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm text-slate-600
                hover:bg-slate-50 transition-colors"
            >
              <span>Skipped / Unresolvable ({skipLog.length})</span>
              <svg
                className={`w-4 h-4 transition-transform ${showSkipLog ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showSkipLog && (
              <div className="divide-y divide-slate-50 max-h-60 overflow-y-auto">
                {skipLog.map((s, i) => (
                  <div key={i} className="px-5 py-2.5 flex items-start gap-3">
                    <span className="text-xs text-slate-400 shrink-0 mt-0.5">{s.reason}</span>
                    <p className="text-xs text-slate-600 line-clamp-2">{s.ref}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
