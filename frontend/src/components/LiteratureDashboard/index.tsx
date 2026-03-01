import { useState } from 'react';
import type { Paper, PaperSummary, SynthesisResult } from '../../types/paper';
import { streamSearch } from '../../api/literature';
import { createProject, streamSummarizeAll, synthesizePapers } from '../../api/projects';
import ExportButtons from './ExportButtons';
import PapersTable from './PapersTable';
import ProgressStream from './ProgressStream';
import SummaryMatrix from './SummaryMatrix';
import SynthesisPanel from './SynthesisPanel';

interface Props {
  initialQuery: string;
  articleType?: string;
  projectDescription?: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onGoToJournals: (sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void;
}

type SearchStatus    = 'idle' | 'streaming' | 'done' | 'error';
type SummarizeStatus = 'idle' | 'running' | 'done' | 'error';

const RESULT_LIMITS = [
  { value: 20,   label: '20' },
  { value: 50,   label: '50' },
  { value: 100,  label: '100' },
  { value: 200,  label: '200' },
  { value: 500,  label: '500' },
  { value: 1000, label: '1,000' },
  { value: 9999, label: 'All possible' },
];

const SOURCE_LABELS: Record<string, string> = {
  pubmed:           'PubMed',
  pmc:              'PMC',
  openalex:         'OpenAlex',
  semantic_scholar: 'Semantic Scholar',
  crossref:         'Crossref',
  europe_pmc:       'Europe PMC',
  clinical_trials:  'ClinicalTrials.gov',
  arxiv:            'arXiv',
};

export default function LiteratureDashboard({ initialQuery, articleType, projectDescription, onBack, onOpenSettings, onGoToJournals, onSessionCreated }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [limit, setLimit] = useState(50);
  const [papers, setPapers] = useState<Paper[]>([]);

  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [searchError, setSearchError]   = useState<string | null>(null);
  const [warnings, setWarnings]         = useState<string[]>([]);

  // SSE search progress
  const [sourceProgress, setSourceProgress] = useState<Record<string, number>>({});
  const [sourcesDone, setSourcesDone]       = useState<Set<string>>(new Set());
  const [sourcesError, setSourcesError]     = useState<Record<string, string>>({});
  const [isDeduplicating, setIsDeduplicating] = useState(false);
  const [rankingInfo, setRankingInfo]         = useState<{ candidates: number; selected: number; requested: number } | null>(null);
  const [isEnriching, setIsEnriching]         = useState(false);
  const [expandedQueries, setExpandedQueries] = useState<string[]>([]);
  const [pubmedQueries, setPubmedQueries]     = useState<string[]>([]);
  const [meshTerms, setMeshTerms]             = useState<string[]>([]);
  const [booleanQuery, setBooleanQuery]       = useState('');
  const [pico, setPico]                       = useState<Record<string, string>>({});
  const [studyTypeFilters, setStudyTypeFilters] = useState<string[]>([]);
  const [aiRationale, setAiRationale]         = useState('');
  const [facets, setFacets]                   = useState<Record<string, { mesh: string[]; freetext: string[] }>>({});
  const [strategyNotes, setStrategyNotes]     = useState<string[]>([]);
  const [tentativeTitle, setTentativeTitle]   = useState<string>('');

  // Summary view toggle
  const [showMatrix, setShowMatrix] = useState(false);

  // Cross-paper synthesis
  const [synthesis, setSynthesis]   = useState<SynthesisResult | null>(null);
  const [synthState, setSynthState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [synthError, setSynthError] = useState<string | null>(null);
  const [showSynthesis, setShowSynthesis] = useState(false);

  // Project + summarize-all state
  const [sessionId, setSessionId]           = useState<string | null>(null); // aliased as projectId
  const [summarizeStatus, setSummarizeStatus] = useState<SummarizeStatus>('idle');
  const [sumProgress, setSumProgress]       = useState({ current: 0, total: 0, title: '' });
  const [sumErrors, setSumErrors]           = useState(0);
  const [summaries, setSummaries]           = useState<Record<string, PaperSummary>>({});

  const isStreaming    = searchStatus === 'streaming';
  const isSummarizing = summarizeStatus === 'running';
  const showProgress   = isStreaming || searchStatus === 'done';

  // ── Search ──────────────────────────────────────────────────────────────────

  async function handleSearch() {
    if (!query.trim()) return;

    setSearchStatus('streaming');
    setSearchError(null);
    setWarnings([]);
    setPapers([]);
    setSummaries({});
    setSessionId(null);
    setSummarizeStatus('idle');
    setSumProgress({ current: 0, total: 0, title: '' });
    setSumErrors(0);
    setSourceProgress({});
    setSourcesDone(new Set());
    setSourcesError({});
    setIsDeduplicating(false);
    setRankingInfo(null);
    setIsEnriching(false);
    setExpandedQueries([]);
    setPubmedQueries([]);
    setMeshTerms([]);
    setBooleanQuery('');
    setPico({});
    setStudyTypeFilters([]);
    setAiRationale('');
    setFacets({});
    setStrategyNotes([]);
    setTentativeTitle('');
    setShowMatrix(false);

    try {
      for await (const event of streamSearch(query.trim(), limit, true, articleType)) {
        switch (event.type) {
          case 'ai_queries':
            if (event.data) {
              setExpandedQueries(event.data.queries ?? []);
              setPubmedQueries(event.data.pubmed_queries ?? []);
              setMeshTerms(event.data.mesh_terms ?? []);
              setBooleanQuery(event.data.boolean_query ?? '');
              setPico(event.data.pico ?? {});
              setStudyTypeFilters(event.data.study_type_filters ?? []);
              setAiRationale(event.data.rationale ?? '');
              setFacets(event.data.facets ?? {});
              setStrategyNotes(event.data.strategy_notes ?? []);
              if (event.data.tentative_title) setTentativeTitle(event.data.tentative_title);
            }
            break;
          case 'papers':
            if (event.papers) {
              setPapers((prev) => [...prev, ...event.papers!]);
              if (event.source) {
                setSourceProgress((prev) => ({
                  ...prev,
                  [event.source!]: (prev[event.source!] ?? 0) + (event.count ?? event.papers!.length),
                }));
              }
            }
            break;
          case 'source_done':
            if (event.source) setSourcesDone((prev) => new Set([...prev, event.source!]));
            break;
          case 'source_error':
            if (event.source && event.message) {
              setSourcesError((prev) => ({ ...prev, [event.source!]: event.message! }));
              setSourcesDone((prev) => new Set([...prev, event.source!]));
            }
            break;
          case 'deduplicating':
            setIsDeduplicating(true);
            break;
          case 'ranking':
            setRankingInfo({
              candidates: event.candidates ?? 0,
              selected:   event.selected ?? 0,
              requested:  event.requested ?? 0,
            });
            break;
          case 'enriching':
            setIsEnriching(true);
            break;
          case 'complete':
            if (event.papers) setPapers(event.papers);
            setSearchStatus('done');
            // Auto-create session
            if (event.papers && event.papers.length > 0) {
              try {
                const meta = await createProject(query.trim(), event.papers, articleType, projectDescription, tentativeTitle || undefined);
                setSessionId(meta.project_id);
                onSessionCreated?.(meta.project_id);
              } catch {
                // Session creation is non-critical
              }
            }
            break;
          case 'warning':
            if (event.message) setWarnings((w) => [...w, event.message!]);
            break;
          case 'error':
            throw new Error(event.message ?? 'Unknown error from server');
        }
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed. Is the backend running on port 8010?');
      setSearchStatus('error');
    }
  }

  // ── Summarize All ──────────────────────────────────────────────────────────

  async function handleSummarizeAll() {
    if (papers.length === 0) return;
    setSummarizeStatus('running');
    setSumErrors(0);
    setSumProgress({ current: 0, total: papers.length, title: '' });

    try {
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const meta = await createProject(query.trim(), papers, articleType, projectDescription, tentativeTitle || undefined);
        targetSessionId = meta.project_id;
        setSessionId(targetSessionId);
        onSessionCreated?.(targetSessionId);
      }

      for await (const event of streamSummarizeAll(targetSessionId, papers, query)) {
        switch (event.type) {
          case 'progress':
            setSumProgress({
              current: event.current ?? 0,
              total:   event.total ?? papers.length,
              title:   event.title ?? '',
            });
            break;
          case 'summary_done':
            if (event.paper_key && event.summary) {
              setSummaries((prev) => ({ ...prev, [event.paper_key!]: event.summary! }));
            }
            break;
          case 'paper_error':
            setSumErrors((n) => n + 1);
            break;
          case 'complete':
            setSummarizeStatus('done');
            break;
          case 'error':
            throw new Error(event.message ?? 'Summarize failed');
        }
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Summarize all failed.');
      setSummarizeStatus('error');
    }
  }

  async function handleSynthesize() {
    if (!sessionId) return;
    setSynthState('running');
    setSynthError(null);
    setShowSynthesis(true);
    try {
      const result = await synthesizePapers(sessionId);
      setSynthesis(result);
      setSynthState('done');
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : 'Synthesis failed.');
      setSynthState('error');
    }
  }

  const sourceCounts = papers.reduce<Record<string, number>>((acc, p) => {
    acc[p.source] = (acc[p.source] ?? 0) + 1;
    return acc;
  }, {});

  const summaryCount   = Object.keys(summaries).length;
  const hasSummaries   = summaryCount > 0;
  const allSummarized  = summaryCount >= papers.length && papers.length > 0;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Intake
            </button>
            <span className="text-slate-300">/</span>
            <span className="font-semibold text-slate-800">Literature Search</span>
            {sessionId && (
              <span className="text-xs text-slate-400 font-mono bg-slate-100 px-2 py-0.5 rounded-md">
                session: {sessionId}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Phase indicator */}
            <div className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <span className="px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">2 · Search</span>
              <span className="text-slate-300">→</span>
              <span className={`px-2 py-0.5 rounded-full ${summarizeStatus === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                3 · Summarise
              </span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">4 · Journals</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">5 · Write</span>
            </div>
            <button onClick={onOpenSettings}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors"
              title="AI Settings">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8 space-y-6">

        {/* Search card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <h1 className="text-lg font-semibold text-slate-800 mb-4">Search Literature</h1>
          <div className="flex gap-3 flex-wrap">
            <input type="text" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isStreaming && handleSearch()}
              placeholder="Enter query or key idea…"
              className="flex-1 min-w-[260px] rounded-xl border-2 border-slate-200 px-4 py-2.5 text-sm
                text-slate-800 placeholder-slate-400 focus:outline-none focus:border-brand-500
                focus:ring-2 focus:ring-brand-100 transition-all"
            />
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={isStreaming}
              className="rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm text-slate-700
                focus:outline-none focus:border-brand-500 bg-white disabled:opacity-50">
              {RESULT_LIMITS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label} results</option>
              ))}
            </select>
            <button onClick={handleSearch} disabled={isStreaming || !query.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              {isStreaming ? (
                <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>Searching…</>
              ) : (
                <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>Search</>
              )}
            </button>
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠ {w}</p>
          ))}
          {searchStatus === 'error' && searchError && (
            <p className="mt-3 text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{searchError}</p>
          )}
        </div>

        {/* Two-column layout */}
        {showProgress && (
          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">

            {/* Left: progress + session panel */}
            <div className="space-y-4 lg:sticky lg:top-24">
              <ProgressStream
                sourceProgress={sourceProgress}
                sourcesDone={sourcesDone}
                sourcesError={sourcesError}
                isDeduplicating={isDeduplicating}
                rankingInfo={rankingInfo}
                isEnriching={isEnriching}
                isComplete={searchStatus === 'done'}
                expandedQueries={expandedQueries}
                pubmedQueries={pubmedQueries}
                meshTerms={meshTerms}
                booleanQuery={booleanQuery}
                pico={pico}
                studyTypeFilters={studyTypeFilters}
                aiRationale={aiRationale}
                facets={facets}
                strategyNotes={strategyNotes}
              />

              {/* Summarize-all panel */}
              {searchStatus === 'done' && papers.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">Phase 3 · AI Summarise All</h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Reads each paper (full text if available, otherwise abstract) and
                      generates a reviewer-grade structured analysis. Saved to disk so you
                      can continue later.
                    </p>
                  </div>

                  {/* Progress bar */}
                  {(isSummarizing || summarizeStatus === 'done') && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>{sumProgress.current} / {sumProgress.total} papers</span>
                        <span>{sumErrors > 0 && <span className="text-rose-500">{sumErrors} errors</span>}</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div
                          className="bg-brand-500 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${sumProgress.total ? (sumProgress.current / sumProgress.total) * 100 : 0}%` }}
                        />
                      </div>
                      {isSummarizing && (
                        <p className="text-xs text-slate-400 truncate" title={sumProgress.title}>
                          Analysing: {sumProgress.title}
                        </p>
                      )}
                      {summarizeStatus === 'done' && (
                        <p className="text-xs text-emerald-600 font-medium">
                          ✓ {summaryCount} summaries saved · session {sessionId}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={handleSummarizeAll}
                      disabled={isSummarizing || papers.length === 0}
                      className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700
                        disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {isSummarizing ? (
                        <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                        </svg>Analysing {sumProgress.current}/{sumProgress.total}…</>
                      ) : allSummarized ? (
                        '↻ Re-run Summarise All'
                      ) : (
                        <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                        </svg>Summarise All {papers.length} Papers</>
                      )}
                    </button>
                  </div>

                  {/* Cross-paper synthesis */}
                  {hasSummaries && sessionId && (
                    <button
                      onClick={handleSynthesize}
                      disabled={synthState === 'running'}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-xl text-sm font-semibold border border-indigo-200 text-indigo-700
                        bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 transition-all"
                    >
                      {synthState === 'running' ? (
                        <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                        </svg>Synthesising…</>
                      ) : (
                        <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>{synthesis ? '↻ Re-synthesise' : 'Cross-paper Synthesis'}</>
                      )}
                    </button>
                  )}

                  {/* Go to journals (Phase 4) — available as soon as any summary exists */}
                  {hasSummaries && sessionId && (
                    <button
                      onClick={() => onGoToJournals(sessionId)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-all"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
                      </svg>
                      Phase 4 → Journals
                      {!allSummarized && (
                        <span className="text-xs opacity-80 ml-1">
                          ({summaryCount}/{papers.length} analysed)
                        </span>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Right: papers / summary matrix */}
            <div className="space-y-4 min-w-0">
              {papers.length > 0 && (
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-medium text-slate-700">
                      {papers.length.toLocaleString()} paper{papers.length !== 1 ? 's' : ''}
                      {isStreaming && <span className="text-slate-400"> · loading…</span>}
                      {summaryCount > 0 && (
                        <span className="ml-2 text-emerald-600">· {summaryCount} analysed</span>
                      )}
                    </span>
                    {Object.entries(sourceCounts).map(([src, count]) => (
                      <span key={src} className="text-xs text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full">
                        {SOURCE_LABELS[src] ?? src}: {count}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    {/* View toggle */}
                    {summaryCount > 0 && (
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
                        <button
                          onClick={() => setShowMatrix(false)}
                          className={`px-3 py-1.5 transition-colors ${!showMatrix ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          Papers
                        </button>
                        <button
                          onClick={() => setShowMatrix(true)}
                          className={`px-3 py-1.5 transition-colors ${showMatrix ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          Summary Table
                        </button>
                        {synthesis && (
                          <button
                            onClick={() => setShowSynthesis(v => !v)}
                            className={`px-3 py-1.5 transition-colors ${showSynthesis ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                          >
                            Synthesis
                          </button>
                        )}
                      </div>
                    )}
                    {searchStatus === 'done' && <ExportButtons papers={papers} />}
                  </div>
                </div>
              )}

              {showMatrix && summaryCount > 0 ? (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                  <h3 className="text-sm font-semibold text-slate-800 mb-4">
                    Evidence Extraction Table
                  </h3>
                  <SummaryMatrix papers={papers} summaries={summaries} />
                </div>
              ) : (
                <PapersTable papers={papers} query={query} preloadedSummaries={summaries} sessionId={sessionId ?? ''} />
              )}

              {/* Synthesis panel */}
              {showSynthesis && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-800">Cross-paper Synthesis</h3>
                    <button onClick={() => setShowSynthesis(false)}
                      className="text-xs text-slate-400 hover:text-slate-600">✕ hide</button>
                  </div>
                  {synthError && (
                    <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 mb-4">{synthError}</p>
                  )}
                  {synthState === 'running' && (
                    <div className="py-10 text-center">
                      <svg className="w-6 h-6 animate-spin text-brand-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                      </svg>
                      <p className="text-sm text-slate-500">Synthesising evidence across {summaryCount} papers…</p>
                    </div>
                  )}
                  {synthesis && synthState !== 'running' && (
                    <SynthesisPanel result={synthesis} />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
