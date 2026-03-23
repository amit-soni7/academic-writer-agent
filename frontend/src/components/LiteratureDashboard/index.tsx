import React, { useEffect, useState } from 'react';
import type { Paper, PaperSummary, SynthesisResult } from '../../types/paper';
import { streamSearch } from '../../api/literature';
import { backfillFiles, createProject, ensureProjectTentativeTitle, loadProject, resetSummaries, synthesizePapers, type LiteratureSearchState, type ProjectData } from '../../api/projects';
import { useSummarizeProgress } from '../../hooks/useSummarizeProgress';
import ExportButtons from './ExportButtons';
import PapersTable from './PapersTable';
import ProgressStream from './ProgressStream';
import SummaryMatrix from './SummaryMatrix';
import SynthesisPanel from './SynthesisPanel';

interface Props {
  initialQuery: string;
  articleType?: string;
  projectDescription?: string;
  initialProject?: ProjectData | null;
  onBack: () => void;
  onOpenSettings: () => void;
  onGoToJournals: (sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onViewPaperDetail: (paper: Paper, summary: PaperSummary | null, projectId: string) => void;
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

function slugifyTitle(text: string): string {
  return (text || '')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'project';
}

function humanizeProjectTitle(text: string): string {
  return (text || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeLegacyProjectTitle(title: string, queryText: string): boolean {
  const name = humanizeProjectTitle(title);
  const source = humanizeProjectTitle(queryText);
  if (!name) return true;
  if (name === source) return true;

  const nameSlug = slugifyTitle(name);
  const querySlug = slugifyTitle(source);
  if (nameSlug === querySlug) return true;
  if (querySlug.startsWith(nameSlug)) return true;

  const nameWords: string[] = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const sourceWords: string[] = source.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (nameWords.length >= 4 && nameWords.every((word, index) => sourceWords[index] === word)) {
    return true;
  }

  if (nameWords.length < 4) return true;
  if (['and', 'or', 'of', 'in', 'on', 'for', 'with', 'to', 'from'].includes(nameWords[0] || '')) {
    return true;
  }
  if (/[*`{}]/.test(title)) return true;
  if (/^(title|working title|tentative title|core concept|focus|topic)\b/i.test(name)) return true;
  if (nameWords.some((word, index) => index > 0 && /^(and|or|of|in|on|for|with|to)[a-z]{4,}$/.test(word))) return true;
  if (nameWords.includes('including') || nameWords.includes('includes')) return true;

  return /^(most research|most psychological research|this study|the present study|background|objective|research on)\b/i.test(name);
}

export default function LiteratureDashboard({ initialQuery, articleType, projectDescription, initialProject, onBack, onOpenSettings, onGoToJournals, onSessionCreated, onViewPaperDetail }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [limit, setLimit] = useState(50);
  const [papers, setPapers] = useState<Paper[]>([]);

  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [searchComplete, setSearchComplete] = useState(false);
  const [searchError, setSearchError]   = useState<string | null>(null);
  const [warnings, setWarnings]         = useState<string[]>([]);

  // SSE search progress
  const [sourceProgress, setSourceProgress] = useState<Record<string, number>>({});
  const [, setSourcePapers]                 = useState<Record<string, Paper[]>>({});
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
  const [frameworkUsed, setFrameworkUsed]     = useState('');
  const [frameworkJustification, setFrameworkJustification] = useState('');
  const [frameworkElements, setFrameworkElements] = useState<Record<string, string | string[]>>({});
  const [studyTypeFilters, setStudyTypeFilters] = useState<string[]>([]);
  const [aiRationale, setAiRationale]         = useState('');
  const [facets, setFacets]                   = useState<Record<string, { mesh: string[]; freetext: string[] }>>({});
  const [strategyNotes, setStrategyNotes]     = useState<string[]>([]);
  const [tentativeTitle, setTentativeTitle]   = useState<string>('');
  const [, setProjectSlug]                    = useState<string>('');

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
  const [currentStep, setCurrentStep]       = useState<string>('');
  const [sumErrors, setSumErrors]           = useState(0);
  const [summaries, setSummaries]           = useState<Record<string, PaperSummary>>({});

  // Background summarization hook — survives navigation
  const bgSummarize = useSummarizeProgress(sessionId);

  useEffect(() => {
    if (!initialProject) return;

    const savedSearch = initialProject.literature_search_state;
    const persistedPapers = initialProject.papers ?? [];
    const restoredSummaries = initialProject.summaries ?? {};
    const restoredSummaryCount = Object.keys(restoredSummaries).length;
    const savedCurrentPapers = savedSearch?.current_papers ?? [];
    const restoredSearchDone = savedSearch?.status === 'done' || persistedPapers.length > 0 || restoredSummaryCount > 0;
    const restoredPapers =
      persistedPapers.length > 0
        ? persistedPapers
        : restoredSearchDone && savedCurrentPapers.length > 0
          ? savedCurrentPapers
          : savedCurrentPapers;
    const fallbackSourceCounts = restoredPapers.reduce<Record<string, number>>((acc, paper) => {
      acc[paper.source] = (acc[paper.source] ?? 0) + 1;
      return acc;
    }, {});
    const restoredSourceCounts = savedSearch?.source_progress ?? fallbackSourceCounts;
    const restoredSourcesDone = savedSearch?.sources_done ?? Object.keys(fallbackSourceCounts);
    const restoredSourcesError = savedSearch?.sources_error ?? {};
    const restoredRanking = savedSearch?.ranking_info ?? (restoredPapers.length > 0 ? {
      candidates: restoredPapers.length,
      selected: restoredPapers.length,
      requested: restoredPapers.length,
    } : null);
    const restoredSourcePapers = savedSearch?.source_papers ?? {};

    setQuery(savedSearch?.query || initialProject.query || initialQuery);
    setPapers(restoredPapers);
    setSummaries(restoredSummaries);
    const restoredTitle = savedSearch?.tentative_title || humanizeProjectTitle(initialProject.project_name || '');
    setSessionId(initialProject.project_id);
    setTentativeTitle(restoredTitle);
    setProjectSlug(slugifyTitle(restoredTitle || initialProject.query || ''));
    setSearchStatus(savedSearch || restoredPapers.length > 0 ? 'done' : 'idle');
    setSearchComplete(restoredSearchDone);
    setSearchError(null);
    setWarnings(savedSearch?.warnings ?? []);
    setSourceProgress(restoredSourceCounts);
    setSourcePapers(restoredSourcePapers);
    setSourcesDone(new Set(restoredSourcesDone));
    setSourcesError(restoredSourcesError);
    setIsDeduplicating(savedSearch?.is_deduplicating ?? restoredPapers.length > 0);
    setRankingInfo(restoredRanking);
    setIsEnriching(savedSearch?.is_enriching ?? false);
    setExpandedQueries(savedSearch?.expanded_queries ?? []);
    setPubmedQueries(savedSearch?.pubmed_queries ?? []);
    setMeshTerms(savedSearch?.mesh_terms ?? []);
    setBooleanQuery(savedSearch?.boolean_query ?? '');
    setPico(savedSearch?.pico ?? {});
    setFrameworkUsed(savedSearch?.framework_used ?? '');
    setFrameworkJustification(savedSearch?.framework_justification ?? '');
    setFrameworkElements(savedSearch?.framework_elements ?? savedSearch?.pico ?? {});
    setStudyTypeFilters(savedSearch?.study_type_filters ?? []);
    setAiRationale(savedSearch?.ai_rationale ?? '');
    setFacets(savedSearch?.facets ?? {});
    setStrategyNotes(savedSearch?.strategy_notes ?? []);
    setSummarizeStatus(restoredSummaryCount > 0 ? 'done' : 'idle');
    setSumProgress({
      current: restoredSummaryCount,
      total: restoredPapers.length,
      title: restoredSummaryCount < restoredPapers.length && restoredPapers.length > 0
        ? 'Resume summarization from saved project state'
        : '',
    });
    setCurrentStep('');
    setSumErrors(0);
  }, [initialProject, initialQuery]);

  // Sync background task status → local UI state
  const prevRunningRef = React.useRef(false);
  useEffect(() => {
    const s = bgSummarize.status;
    if (!s) return;
    if (s.running) {
      prevRunningRef.current = true;
      // Actively running — use live counters from the task
      setSumProgress({ current: s.current, total: s.total || papers.length, title: s.current_title });
      setSumErrors(s.errors);
      setSummarizeStatus('running');
    } else if (s.saved > 0) {
      // Task finished (or was done before the new system) — use the DB-saved count
      setSumProgress(prev => ({
        current: Math.max(prev.current, s.saved),
        total: prev.total || papers.length,
        title: '',
      }));
      setSummarizeStatus('done');

      // Reload summaries from backend when task transitions running → done
      if (prevRunningRef.current && sessionId) {
        prevRunningRef.current = false;
        loadProject(sessionId)
          .then(data => { if (data.summaries) setSummaries(data.summaries as Record<string, PaperSummary>); })
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSummarize.status]);

  useEffect(() => {
    if (!initialProject?.project_id) return;

    const existingTitle = (
      initialProject.literature_search_state?.tentative_title
      || humanizeProjectTitle(initialProject.project_name || '')
      || ''
    ).trim();
    if (existingTitle && !looksLikeLegacyProjectTitle(existingTitle, initialProject.query.trim())) {
      setTentativeTitle(existingTitle);
      setProjectSlug(slugifyTitle(existingTitle));
      return;
    }

    let cancelled = false;
    ensureProjectTentativeTitle(initialProject.project_id)
      .then((result) => {
        if (cancelled) return;
        setTentativeTitle(result.tentative_title);
        setProjectSlug(result.project_slug);
      })
      .catch(() => {
        if (cancelled) return;
        const fallbackTitle = humanizeProjectTitle(initialProject.project_name || initialProject.query || 'Project');
        setTentativeTitle(fallbackTitle);
        setProjectSlug(slugifyTitle(fallbackTitle));
      });

    return () => {
      cancelled = true;
    };
  }, [initialProject]);

  const isStreaming    = searchStatus === 'streaming';
  const isSummarizing = bgSummarize.isRunning || summarizeStatus === 'running';
  const showProgress   = isStreaming || searchStatus === 'done';

  // ── Search ──────────────────────────────────────────────────────────────────

  async function handleSearch() {
    if (!query.trim()) return;

    setSearchStatus('streaming');
    setSearchComplete(false);
    setSearchError(null);
    setWarnings([]);
    setPapers([]);
    setSummaries({});
    setSummarizeStatus('idle');
    setSumProgress({ current: 0, total: 0, title: '' });
    setSumErrors(0);
    setSourceProgress({});
    setSourcePapers({});
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
    setFrameworkUsed('');
    setFrameworkJustification('');
    setFrameworkElements({});
    setStudyTypeFilters([]);
    setAiRationale('');
    setFacets({});
    setStrategyNotes([]);
    setTentativeTitle('');
    setProjectSlug('');
    setShowMatrix(false);
    try {
      const liveSourceProgress: Record<string, number> = {};
      const liveSourcePapers: Record<string, Paper[]> = {};
      const liveSourcesDone = new Set<string>();
      const liveSourcesError: Record<string, string> = {};
      let liveIsDeduplicating = false;
      let liveRankingInfo: LiteratureSearchState['ranking_info'] = null;
      let liveIsEnriching = false;
      let liveExpandedQueries: string[] = [];
      let livePubmedQueries: string[] = [];
      let liveMeshTerms: string[] = [];
      let liveBooleanQuery = '';
      let livePico: Record<string, string> = {};
      let liveFrameworkUsed = '';
      let liveFrameworkJustification = '';
      let liveFrameworkElements: Record<string, string | string[]> = {};
      let liveStudyTypeFilters: string[] = [];
      let liveAiRationale = '';
      let liveFacets: Record<string, { mesh: string[]; freetext: string[] }> = {};
      let liveStrategyNotes: string[] = [];
      const liveWarnings: string[] = [];
      let latestTentativeTitle = '';
      for await (const event of streamSearch(query.trim(), limit, true, articleType, sessionId ?? undefined)) {
        switch (event.type) {
          case 'ai_queries':
            if (event.data) {
              liveExpandedQueries = event.data.queries ?? [];
              livePubmedQueries = event.data.pubmed_queries ?? [];
              liveMeshTerms = event.data.mesh_terms ?? [];
              liveBooleanQuery = event.data.boolean_query ?? '';
              livePico = (event.data.pico ?? {}) as Record<string, string>;
              liveFrameworkUsed = event.data.framework_used ?? '';
              liveFrameworkJustification = event.data.framework_justification ?? '';
              liveFrameworkElements = event.data.framework_elements ?? event.data.pico ?? {};
              liveStudyTypeFilters = event.data.study_type_filters ?? [];
              liveAiRationale = event.data.rationale ?? '';
              liveFacets = event.data.facets ?? {};
              liveStrategyNotes = event.data.strategy_notes ?? [];
              setExpandedQueries(event.data.queries ?? []);
              setPubmedQueries(event.data.pubmed_queries ?? []);
              setMeshTerms(event.data.mesh_terms ?? []);
              setBooleanQuery(event.data.boolean_query ?? '');
              setPico((event.data.pico ?? {}) as Record<string, string>);
              setFrameworkUsed(event.data.framework_used ?? '');
              setFrameworkJustification(event.data.framework_justification ?? '');
              setFrameworkElements(event.data.framework_elements ?? event.data.pico ?? {});
              setStudyTypeFilters(event.data.study_type_filters ?? []);
              setAiRationale(event.data.rationale ?? '');
              setFacets(event.data.facets ?? {});
              setStrategyNotes(event.data.strategy_notes ?? []);
              if (event.data.tentative_title) {
                latestTentativeTitle = event.data.tentative_title;
                setTentativeTitle(event.data.tentative_title);
                setProjectSlug(slugifyTitle(event.data.tentative_title));
              }
            }
            break;
          case 'papers':
            if (event.papers) {
              setPapers((prev) => [...prev, ...event.papers!]);
              if (event.source) {
                liveSourceProgress[event.source] = (liveSourceProgress[event.source] ?? 0) + (event.count ?? event.papers.length);
                liveSourcePapers[event.source] = [...(liveSourcePapers[event.source] ?? []), ...event.papers];
                setSourceProgress((prev) => ({
                  ...prev,
                  [event.source!]: (prev[event.source!] ?? 0) + (event.count ?? event.papers!.length),
                }));
                setSourcePapers((prev) => ({
                  ...prev,
                  [event.source!]: [...(prev[event.source!] ?? []), ...event.papers!],
                }));
              }
            }
            break;
          case 'source_done':
            if (event.source) {
              liveSourcesDone.add(event.source);
              setSourcesDone((prev) => new Set([...prev, event.source!]));
            }
            break;
          case 'source_error':
            if (event.source && event.message) {
              liveSourcesError[event.source] = event.message;
              liveSourcesDone.add(event.source);
              setSourcesError((prev) => ({ ...prev, [event.source!]: event.message! }));
              setSourcesDone((prev) => new Set([...prev, event.source!]));
            }
            break;
          case 'deduplicating':
            liveIsDeduplicating = true;
            setIsDeduplicating(true);
            break;
          case 'ranking':
            liveRankingInfo = {
              candidates: event.candidates ?? 0,
              selected: event.selected ?? 0,
              requested: event.requested ?? 0,
            };
            setRankingInfo({
              candidates: event.candidates ?? 0,
              selected:   event.selected ?? 0,
              requested:  event.requested ?? 0,
            });
            break;
          case 'enriching':
            liveIsEnriching = true;
            setIsEnriching(true);
            break;
          case 'complete':
            if (event.papers) setPapers(event.papers);
            liveIsEnriching = false;
            setSearchStatus('done');
            setSearchComplete(true);
            // Auto-create session only for brand-new searches.
            if (!sessionId && event.papers && event.papers.length > 0) {
              try {
                const meta = await createProject(
                  query.trim(),
                  event.papers,
                  articleType,
                  projectDescription,
                  latestTentativeTitle || undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  {
                    status: 'done',
                    query: query.trim(),
                    total_limit: limit,
                    warnings: liveWarnings,
                    source_progress: liveSourceProgress,
                    sources_done: Array.from(liveSourcesDone),
                    sources_error: liveSourcesError,
                    is_deduplicating: liveIsDeduplicating,
                    ranking_info: liveRankingInfo,
                    is_enriching: liveIsEnriching,
                    expanded_queries: liveExpandedQueries,
                    pubmed_queries: livePubmedQueries,
                    mesh_terms: liveMeshTerms,
                    boolean_query: liveBooleanQuery,
                    pico: livePico,
                    framework_elements: liveFrameworkElements,
                    framework_used: liveFrameworkUsed,
                    framework_justification: liveFrameworkJustification,
                    study_type_filters: liveStudyTypeFilters,
                    ai_rationale: liveAiRationale,
                    facets: liveFacets,
                    strategy_notes: liveStrategyNotes,
                    tentative_title: latestTentativeTitle || undefined,
                    source_papers: liveSourcePapers,
                    current_papers: event.papers,
                  },
                );
                setSessionId(meta.project_id);
                onSessionCreated?.(meta.project_id);
              } catch {
                // Session creation is non-critical
              }
            }
            break;
          case 'warning':
            if (event.message) {
              liveWarnings.push(event.message);
              setWarnings((w) => [...w, event.message!]);
            }
            break;
          case 'error':
            throw new Error(event.message ?? 'Unknown error from server');
        }
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed. Is the backend running on port 8010?');
      setSearchStatus('error');
      setSearchComplete(false);
    }
  }

  // ── Summarize All — background task (survives navigation) ─────────────────

  async function handleSummarizeAll() {
    if (papers.length === 0) return;
    setSumErrors(0);
    setCurrentStep('');
    setSumProgress({ current: summaryCount, total: papers.length, title: '' });

    try {
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const meta = await createProject(query.trim(), papers, articleType, projectDescription, tentativeTitle || undefined);
        targetSessionId = meta.project_id;
        setSessionId(targetSessionId);
        onSessionCreated?.(targetSessionId);
      }
      // Kick off the backend background task — returns immediately
      await bgSummarize.start(targetSessionId, papers, query);
      setSummarizeStatus('running');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Summarize all failed.');
      setSummarizeStatus('error');
    }
  }

  async function handleResetSummaries() {
    if (!sessionId) return;
    if (!confirm('Reset all summaries? This will delete all analysed data and you will need to re-run summarisation.')) return;
    try {
      await resetSummaries(sessionId);
      setSummaries({});
      setSummarizeStatus('idle');
      setSumProgress({ current: 0, total: papers.length, title: '' });
      setSumErrors(0);
      setCurrentStep('');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to reset summaries.');
    }
  }

  async function handleBackfillFiles() {
    if (!sessionId) return;
    try {
      const result = await backfillFiles(sessionId);
      alert(`Files backfilled: ${result.saved} new, ${result.already_existed} already existed, ${result.failed} failed (of ${result.total_summarised} summarised papers).`);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to backfill files.');
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

  // Only count summaries that match current papers (avoid stale orphan summaries)
  const paperKeys = new Set(papers.map(p => (p.doi || p.title.slice(0, 60)).toLowerCase().trim()));
  const summaryCount   = Object.keys(summaries).filter(k => paperKeys.has(k)).length;
  const hasSummaries   = summaryCount > 0;
  const allSummarized  = summaryCount >= papers.length && papers.length > 0;
  const resolvedProjectTitle = tentativeTitle || humanizeProjectTitle(initialProject?.project_name || '') || humanizeProjectTitle(query) || 'Project';
  // During active summarisation use the live counter from the polling task;
  // otherwise fall back to the loaded summary count (works for idle projects).
  const liveCurrent = isSummarizing ? Math.max(sumProgress.current, summaryCount) : summaryCount;
  const liveTotal   = sumProgress.total || papers.length || 1;
  const sumPercent  = papers.length > 0
    ? Math.min(100, Math.round((liveCurrent / liveTotal) * 100))
    : 0;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>

      {/* Header — "No-Line Rule": background shift instead of border */}
      <header className="w-full sticky top-0 z-10 flex justify-between items-center px-8 py-3"
        style={{ background: 'var(--bg-elevated)', boxShadow: '0 1px 0 rgba(199,196,216,0.15)' }}>
        <div className="flex items-center gap-4 flex-1">
          <button onClick={onBack}
            className="w-8 h-8 rounded-xl flex items-center justify-center hover:opacity-80 transition-all active:scale-95"
            style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright)' }}>Literature</span>
            {sessionId && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
                {sessionId}
              </span>
            )}
          </div>
          {/* Input pill — design system: surface-container-high background, no border, rounded-full */}
          <div className="relative flex-1 max-w-xl ml-4">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-lg" style={{ color: 'var(--text-muted)' }}>search</span>
            <input type="text" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isStreaming && handleSearch()}
              placeholder="Explore scientific databases..."
              className="w-full border-none rounded-full py-2.5 pl-11 pr-4 text-sm outline-none transition-all
                focus:ring-2 focus:ring-[var(--gold)]/20"
              style={{ background: 'var(--bg-surface)', color: 'var(--text-body)', fontFamily: 'Manrope, sans-serif' }}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Phase chips — full roundedness for chips */}
          <div className="hidden md:flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ fontFamily: 'Manrope, sans-serif' }}>
            <span className="px-3 py-1.5 rounded-full" style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>2 · Search</span>
            <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>→</span>
            <span className="px-3 py-1.5 rounded-full"
              style={{ background: summarizeStatus === 'done' ? 'rgba(16,185,129,0.08)' : 'var(--bg-surface)', color: summarizeStatus === 'done' ? '#10b981' : 'var(--text-muted)' }}>
              3 · Summarise
            </span>
            <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>→</span>
            <span className="px-3 py-1.5 rounded-full" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>4 · Journals</span>
            <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>→</span>
            <span className="px-3 py-1.5 rounded-full" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>5 · Write</span>
          </div>
          <button onClick={onOpenSettings}
            className="p-2 rounded-xl hover:opacity-80 transition-all active:scale-95"
            style={{ color: 'var(--text-muted)' }}
            title="AI Settings">
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>
      </header>

      {/* Scrollable Workspace — generous breathing space */}
      <div className="flex-1 overflow-y-auto px-10 py-10">
        <div className="mx-auto space-y-12">

          {/* Search Header & Status */}
          <section className="space-y-8">
            <div className="flex justify-between items-end flex-wrap gap-6">
              <div className="space-y-2">
                <h1 className="text-5xl font-bold tracking-tight" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                  Literature Search
                </h1>
                <p className="text-sm leading-relaxed max-w-xl" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                  {resolvedProjectTitle}
                </p>
              </div>
              <div className="flex gap-3 items-center">
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={isStreaming}
                  className="rounded-full border-none px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'Manrope, sans-serif' }}>
                  {RESULT_LIMITS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label} results</option>
                  ))}
                </select>
                {/* Primary CTA — Signature Gradient */}
                <button onClick={handleSearch} disabled={isStreaming || !query.trim()}
                  className="px-6 py-2.5 text-sm font-bold text-white rounded-xl transition-all active:scale-95
                    disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                  style={{ background: 'linear-gradient(135deg, var(--gold), var(--gold-light))', fontFamily: 'Manrope, sans-serif',
                    boxShadow: isStreaming ? 'none' : '0 4px 24px rgba(54,50,183,0.15)' }}>
                  {isStreaming ? (
                    <><span className="material-symbols-outlined text-lg animate-spin">progress_activity</span>Searching…</>
                  ) : (
                    <><span className="material-symbols-outlined text-lg">search</span>Search</>
                  )}
                </button>
              </div>
            </div>

            {/* Warnings & errors — no hard borders, use background shifts */}
            {warnings.map((w, i) => (
              <p key={i} className="text-xs rounded-xl px-4 py-3"
                style={{ color: '#92400e', background: 'rgba(251,191,36,0.06)' }}>
                ⚠ {w}
              </p>
            ))}
            {searchStatus === 'error' && searchError && (
              <p className="text-sm rounded-xl px-5 py-4" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.04)' }}>
                {searchError}
              </p>
            )}

            {/* AI Research Engine Status — Glassmorphic panel */}
            {showProgress && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {/* Main AI status — Glass & Gradient rule: 80% opacity + backdrop-blur(16px) + 2px left accent */}
                <div className="md:col-span-2 rounded-2xl p-8 flex flex-col justify-between relative overflow-hidden"
                  style={{
                    background: 'rgba(248,249,250,0.8)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    boxShadow: '0 8px 32px rgba(25,28,29,0.04)',
                  }}>
                  {/* AI Insight accent — 2px left highlight */}
                  <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl" style={{ background: 'linear-gradient(to bottom, var(--gold), var(--gold-light))' }} />
                  <div className="flex items-start justify-between mb-10">
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <span className="material-symbols-outlined text-sm" style={{ color: 'var(--gold)', fontVariationSettings: "'FILL' 1" }}>bolt</span>
                        <span className="text-[10px] font-extrabold uppercase tracking-[0.2em]" style={{ color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>
                          AI Research Engine {isStreaming ? 'Active' : isSummarizing ? 'Summarising' : searchComplete ? 'Complete' : 'Ready'}
                        </span>
                      </div>
                      <h3 className="text-2xl font-semibold italic leading-snug" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                        "{resolvedProjectTitle}"
                      </h3>
                    </div>
                    {(isSummarizing || summarizeStatus === 'done') && (
                      <div className="text-right ml-6">
                        <span className="text-3xl font-bold" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold)' }}>{sumPercent}%</span>
                        <p className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
                          Synthesis Progress
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Progress bar */}
                  {(isSummarizing || summarizeStatus === 'done') && (
                    <div className="space-y-5">
                      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                        <div className="h-full relative transition-all duration-700 ease-out" style={{
                          width: `${sumPercent}%`,
                          background: 'linear-gradient(90deg, var(--gold), var(--gold-light))',
                        }}>
                          <div className="absolute top-0 right-0 w-6 h-full" style={{ background: 'rgba(255,255,255,0.4)', filter: 'blur(6px)' }}></div>
                        </div>
                      </div>
                      <div className="flex justify-between text-xs font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                        <span className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: searchComplete ? '#22c55e' : 'var(--gold)', boxShadow: searchComplete ? '0 0 8px rgba(34,197,94,0.5)' : 'none' }}></span>
                          Database Fetching
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: searchComplete ? '#22c55e' : 'var(--text-muted)', boxShadow: searchComplete ? '0 0 8px rgba(34,197,94,0.5)' : 'none' }}></span>
                          Metadata Extraction
                        </span>
                        <span className={`flex items-center gap-2 ${isSummarizing ? 'animate-pulse' : ''}`}
                          style={{ color: isSummarizing ? 'var(--gold)' : summarizeStatus === 'done' ? '#22c55e' : 'var(--text-muted)' }}>
                          <span className="w-2 h-2 rounded-full" style={{
                            background: isSummarizing ? 'var(--gold)' : summarizeStatus === 'done' ? '#22c55e' : 'var(--text-muted)',
                            boxShadow: summarizeStatus === 'done' ? '0 0 8px rgba(34,197,94,0.5)' : isSummarizing ? '0 0 8px rgba(54,50,183,0.5)' : 'none',
                          }}></span>
                          Abstract Summarization
                        </span>
                      </div>
                      {isSummarizing && (
                        <div>
                          <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }} title={sumProgress.title}>
                            {sumProgress.title}
                          </p>
                          {currentStep && (
                            <p className="text-xs mt-1" style={{ color: 'var(--gold-light)' }}>{currentStep}</p>
                          )}
                          {sumErrors > 0 && <span className="text-xs text-rose-500">{sumErrors} errors</span>}
                        </div>
                      )}
                      {summarizeStatus === 'done' && (
                        <p className="text-xs font-medium" style={{ color: '#10b981' }}>
                          ✓ {summaryCount} summaries saved
                        </p>
                      )}
                    </div>
                  )}

                  {/* Compact progress when no summarize yet */}
                  {!(isSummarizing || summarizeStatus === 'done') && (
                    <div className="flex justify-between text-xs font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                      <span className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{
                          background: searchComplete ? '#22c55e' : isStreaming ? 'var(--gold)' : 'var(--text-muted)',
                          boxShadow: searchComplete ? '0 0 8px rgba(34,197,94,0.5)' : isStreaming ? '0 0 8px rgba(54,50,183,0.5)' : 'none',
                        }}></span>
                        {isStreaming ? 'Fetching from databases…' : searchComplete ? 'Search Complete' : 'Ready to search'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Right: Insights panel — surface-container-low for "recessed" look */}
                <div className="rounded-2xl p-6 space-y-5" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                  <h4 className="text-xs font-bold uppercase tracking-[0.2em]" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                    Insights Found
                  </h4>
                  {/* No dividers — use spacing-4 between items (design system: "Forbid Dividers") */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
                        <span className="material-symbols-outlined">article</span>
                      </div>
                      <div>
                        <p className="text-sm font-bold leading-none" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{papers.length} Papers</p>
                        <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>Found in databases</p>
                      </div>
                    </div>
                    {summaryCount > 0 && (
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(16,185,129,0.08)', color: '#10b981' }}>
                          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold leading-none" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{summaryCount} Analysed</p>
                          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>AI evidence extraction</p>
                        </div>
                      </div>
                    )}
                    {Object.entries(sourceCounts).slice(0, 4).map(([src, count]) => (
                      <div key={src} className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                          <span className="material-symbols-outlined text-lg">database</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold leading-none" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{count}</p>
                          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{SOURCE_LABELS[src] ?? src}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Two-column layout: Papers (main) + Right sidebar */}
          {showProgress && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8 items-start">

              {/* Left: Research Catalog (main content) */}
              <section className="space-y-6 min-w-0">
                {papers.length > 0 && (
                  <div className="flex items-center justify-between flex-wrap gap-4 mb-2">
                    <h2 className="text-2xl font-semibold" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                      Research Catalog
                    </h2>
                    <div className="flex items-center gap-3">
                      {/* View toggle — always visible once papers are loaded */}
                      <div className="flex rounded-xl overflow-hidden text-xs font-bold" style={{ background: 'var(--bg-elevated)', fontFamily: 'Manrope, sans-serif' }}>
                        <button
                          onClick={() => setShowMatrix(false)}
                          className="px-4 py-2 transition-all"
                          style={!showMatrix ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : { color: 'var(--text-muted)' }}
                        >
                          Papers
                        </button>
                        <button
                          onClick={() => setShowMatrix(true)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 transition-all"
                          style={showMatrix ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : { color: 'var(--text-muted)' }}
                        >
                          Summary Table
                          {summaryCount > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                              style={{ background: showMatrix ? 'rgba(54,50,183,0.15)' : 'var(--bg-surface)', color: showMatrix ? 'var(--gold)' : 'var(--text-muted)' }}>
                              {summaryCount}
                            </span>
                          )}
                        </button>
                        {synthesis && (
                          <button
                            onClick={() => setShowSynthesis(v => !v)}
                            className="px-4 py-2 transition-all"
                            style={showSynthesis ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : { color: 'var(--text-muted)' }}
                          >
                            Synthesis
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Filter chips row */}
                {papers.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold"
                      style={{ background: 'var(--gold-faint)', color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>
                      <span className="material-symbols-outlined text-[14px]">database</span>
                      All Databases ({Object.keys(sourceCounts).length})
                    </span>
                    {Object.entries(sourceCounts).map(([src, count]) => (
                      <span key={src} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[10px] font-semibold"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
                        {SOURCE_LABELS[src] ?? src}: {count}
                      </span>
                    ))}
                    {searchComplete && <ExportButtons papers={papers} />}
                    {summaryCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[10px] font-semibold"
                        style={{ background: 'rgba(16,185,129,0.08)', color: '#10b981', fontFamily: 'Manrope, sans-serif' }}>
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        {summaryCount} analysed
                      </span>
                    )}
                  </div>
                )}

                {showMatrix ? (
                  summaryCount > 0 ? (
                    <div className="rounded-2xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                      <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>
                        Evidence Extraction Table
                      </h3>
                      <SummaryMatrix papers={papers} summaries={summaries} projectId={sessionId || undefined} />
                    </div>
                  ) : (
                    <div className="rounded-2xl p-12 text-center" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                      <span className="material-symbols-outlined text-4xl block mx-auto mb-4" style={{ color: 'var(--text-muted)' }}>table_chart</span>
                      <p className="text-base font-semibold mb-2" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                        No summaries yet
                      </p>
                      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
                        Run "Summarise All" to extract AI evidence from your {papers.length} papers — then this table will populate.
                      </p>
                      <button
                        onClick={() => { setShowMatrix(false); handleSummarizeAll(); }}
                        disabled={bgSummarize.isRunning || papers.length === 0}
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold text-white transition-all active:scale-95 disabled:opacity-40"
                        style={{ background: 'linear-gradient(135deg, var(--gold), var(--gold-light))', fontFamily: 'Manrope, sans-serif',
                          boxShadow: '0 4px 16px rgba(54,50,183,0.15)' }}
                      >
                        <span className="material-symbols-outlined text-base">summarize</span>
                        Summarise All {papers.length} Papers
                      </button>
                    </div>
                  )
                ) : (
                  <PapersTable
                    papers={papers}
                    query={query}
                    preloadedSummaries={summaries}
                    sessionId={sessionId ?? ''}
                    onViewDetail={(paper, summary) => onViewPaperDetail(paper, summary, sessionId ?? '')}
                  />
                )}

                {/* Synthesis panel — Glassmorphic floating sheet */}
                {showSynthesis && (
                  <div className="rounded-2xl p-6 relative overflow-hidden" style={{
                    background: 'rgba(248,249,250,0.85)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    boxShadow: '0 8px 32px rgba(25,28,29,0.06)',
                  }}>
                    <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl" style={{ background: 'var(--gold)' }} />
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>Cross-paper Synthesis</h3>
                      <button onClick={() => setShowSynthesis(false)}
                        className="text-xs hover:opacity-70 transition-opacity" style={{ color: 'var(--text-muted)' }}>✕ hide</button>
                    </div>
                    {synthError && (
                      <p className="text-sm rounded-xl px-5 py-4 mb-4" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.04)' }}>
                        {synthError}
                      </p>
                    )}
                    {synthState === 'running' && (
                      <div className="py-12 text-center">
                        <span className="material-symbols-outlined text-2xl animate-spin block mx-auto mb-3" style={{ color: 'var(--gold)' }}>progress_activity</span>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Synthesising evidence across {summaryCount} papers…</p>
                      </div>
                    )}
                    {synthesis && synthState !== 'running' && (
                      <SynthesisPanel result={synthesis} />
                    )}
                  </div>
                )}
              </section>

              {/* Right sidebar: Database Health + Deep Insights + Actions + Synthesis Progress */}
              <div className="space-y-5 lg:sticky lg:top-20">

                {/* Database Health */}
                <div className="rounded-2xl p-5 space-y-4" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                  <h4 className="text-[10px] font-extrabold uppercase tracking-[0.2em]" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                    Database Health
                  </h4>
                  <div className="space-y-3">
                    {Object.entries(sourceCounts).map(([src, count]) => {
                      const hasError = src in sourcesError;
                      const isDone = sourcesDone.has(src) || searchComplete;
                      return (
                        <div key={src} className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{
                            background: hasError ? '#ef4444' : isDone ? '#22c55e' : isStreaming ? 'var(--gold)' : 'var(--text-muted)',
                            boxShadow: isDone ? '0 0 6px rgba(34,197,94,0.4)' : hasError ? '0 0 6px rgba(239,68,68,0.4)' : 'none',
                          }} />
                          <span className="text-xs flex-1" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-body)' }}>
                            {SOURCE_LABELS[src] ?? src}
                          </span>
                          <span className="text-xs font-bold tabular-nums" style={{ color: 'var(--text-muted)' }}>{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Deep Insights — AI panel with glass effect */}
                <div className="rounded-2xl p-5 relative overflow-hidden" style={{
                  background: 'rgba(248,249,250,0.85)',
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  boxShadow: '0 4px 32px rgba(25,28,29,0.04)',
                }}>
                  <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: 'linear-gradient(to bottom, var(--gold), var(--gold-light))' }} />
                  <div className="flex items-center gap-2 mb-3">
                    <span className="material-symbols-outlined text-sm" style={{ color: 'var(--gold)', fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                    <h4 className="text-[10px] font-extrabold uppercase tracking-[0.2em]" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold)' }}>
                      Deep Insights
                    </h4>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
                        <span className="material-symbols-outlined text-lg">article</span>
                      </div>
                      <div>
                        <p className="text-sm font-bold" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{papers.length}</p>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Papers found</p>
                      </div>
                    </div>
                    {summaryCount > 0 && (
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(16,185,129,0.08)', color: '#10b981' }}>
                          <span className="material-symbols-outlined text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{summaryCount}</p>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>AI analysed</p>
                        </div>
                      </div>
                    )}
                    {rankingInfo && (
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.08)', color: '#8b5cf6' }}>
                          <span className="material-symbols-outlined text-lg">filter_list</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold" style={{ color: 'var(--text-bright)', fontFamily: 'Manrope, sans-serif' }}>{rankingInfo.selected}/{rankingInfo.candidates}</p>
                          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Selected after ranking</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Synthesis Progress — circular gauge */}
                {(isSummarizing || summarizeStatus === 'done') && (
                  <div className="rounded-2xl p-5 text-center" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                    <h4 className="text-[10px] font-extrabold uppercase tracking-[0.2em] mb-4" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                      Synthesis Progress
                    </h4>
                    {/* Large circular gauge */}
                    <div className="relative inline-flex items-center justify-center mx-auto" style={{ width: 100, height: 100 }}>
                      <svg width={100} height={100} className="-rotate-90">
                        <circle cx={50} cy={50} r={42} fill="none" stroke="var(--border-faint)" strokeWidth={6} />
                        <circle cx={50} cy={50} r={42} fill="none"
                          stroke={summarizeStatus === 'done' ? '#10b981' : 'var(--gold)'}
                          strokeWidth={6}
                          strokeDasharray={2 * Math.PI * 42}
                          strokeDashoffset={2 * Math.PI * 42 - (sumPercent / 100) * 2 * Math.PI * 42}
                          strokeLinecap="round" className="transition-all duration-700" />
                      </svg>
                      <span className="absolute text-xl font-bold tabular-nums"
                        style={{ color: summarizeStatus === 'done' ? '#10b981' : 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>
                        {sumPercent}%
                      </span>
                    </div>
                    <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                      {sumProgress.current}/{sumProgress.total} papers
                    </p>
                    {isSummarizing && currentStep && (
                      <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--gold-light)' }}>{currentStep}</p>
                    )}
                    {sumErrors > 0 && <p className="text-[10px] mt-1 text-rose-500">{sumErrors} errors</p>}
                  </div>
                )}

                {/* Action buttons */}
                {(searchComplete || papers.length > 0 || summaryCount > 0) && papers.length > 0 && (
                  <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
                    <button
                      onClick={handleSummarizeAll}
                      disabled={isSummarizing || papers.length === 0}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-xl text-sm font-bold text-white transition-all active:scale-95
                        disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        background: 'linear-gradient(135deg, var(--gold), var(--gold-light))',
                        fontFamily: 'Manrope, sans-serif',
                        boxShadow: isSummarizing ? 'none' : '0 4px 16px rgba(54,50,183,0.15)',
                      }}
                    >
                      {isSummarizing ? (
                        <><span className="material-symbols-outlined text-base animate-spin">progress_activity</span>Analysing {sumProgress.current}/{sumProgress.total}</>
                      ) : allSummarized ? (
                        <><span className="material-symbols-outlined text-base">refresh</span>Re-run All</>
                      ) : hasSummaries ? (
                        <>Resume ({summaryCount}/{papers.length})</>
                      ) : (
                        <><span className="material-symbols-outlined text-base">summarize</span>Summarise All</>
                      )}
                    </button>

                    {hasSummaries && !isSummarizing && sessionId && (
                      <button onClick={handleResetSummaries}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2
                          rounded-xl text-[11px] font-medium transition-all hover:opacity-70"
                        style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
                        <span className="material-symbols-outlined text-sm">restart_alt</span>
                        Reset Summaries
                      </button>
                    )}

                    {hasSummaries && !isSummarizing && sessionId && (
                      <button onClick={handleBackfillFiles}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2
                          rounded-xl text-[11px] font-medium transition-all hover:opacity-70"
                        style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}
                        title="Save a PDF or text file for each summarised paper that has no file yet">
                        <span className="material-symbols-outlined text-sm">folder_sync</span>
                        Backfill Files
                      </button>
                    )}

                    {hasSummaries && sessionId && (
                      <button onClick={handleSynthesize} disabled={synthState === 'running'}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2
                          rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-40"
                        style={{ background: 'var(--gold-faint)', color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>
                        {synthState === 'running' ? (
                          <><span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>Synthesising…</>
                        ) : (
                          <><span className="material-symbols-outlined text-sm">auto_awesome</span>{synthesis ? 'Re-synthesise' : 'Synthesis'}</>
                        )}
                      </button>
                    )}

                    {hasSummaries && sessionId && (
                      <button onClick={() => onGoToJournals(sessionId)}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5
                          rounded-xl text-sm font-bold text-white transition-all active:scale-95"
                        style={{ background: 'linear-gradient(135deg, #059669, #10b981)', fontFamily: 'Manrope, sans-serif',
                          boxShadow: '0 4px 16px rgba(16,185,129,0.2)' }}>
                        <span className="material-symbols-outlined text-base">arrow_forward</span>
                        Phase 4 → Journals
                      </button>
                    )}
                  </div>
                )}

                {/* Collapsible search strategy */}
                <ProgressStream
                  sourceProgress={sourceProgress}
                  sourcesDone={sourcesDone}
                  sourcesError={sourcesError}
                  isDeduplicating={isDeduplicating}
                  rankingInfo={rankingInfo}
                  isEnriching={isEnriching}
                  isStreaming={isStreaming}
                  isComplete={searchComplete || (!isStreaming && (papers.length > 0 || summaryCount > 0))}
                  expandedQueries={expandedQueries}
                  pubmedQueries={pubmedQueries}
                  meshTerms={meshTerms}
                  booleanQuery={booleanQuery}
                  frameworkUsed={frameworkUsed}
                  frameworkJustification={frameworkJustification}
                  frameworkElements={frameworkElements}
                  pico={pico}
                  studyTypeFilters={studyTypeFilters}
                  aiRationale={aiRationale}
                  facets={facets}
                  strategyNotes={strategyNotes}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
