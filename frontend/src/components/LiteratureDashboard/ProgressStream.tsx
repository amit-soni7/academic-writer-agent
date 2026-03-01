import { useState } from 'react';

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

const SOURCES = ['pubmed', 'pmc', 'openalex', 'semantic_scholar', 'crossref', 'europe_pmc', 'clinical_trials', 'arxiv'];

interface Props {
  sourceProgress: Record<string, number>;
  sourcesDone: Set<string>;
  sourcesError: Record<string, string>;
  isDeduplicating: boolean;
  rankingInfo: { candidates: number; selected: number; requested: number } | null;
  isEnriching: boolean;
  isComplete: boolean;
  // AI query expansion data
  expandedQueries?: string[];
  pubmedQueries?: string[];
  meshTerms?: string[];
  booleanQuery?: string;
  pico?: Record<string, string>;
  studyTypeFilters?: string[];
  aiRationale?: string;
  facets?: Record<string, { mesh: string[]; freetext: string[] }>;
  strategyNotes?: string[];
}

function StatusIcon({ state }: { state: 'pending' | 'active' | 'done' | 'error' }) {
  if (state === 'done') return (
    <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
      <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
    </div>
  );
  if (state === 'error') return (
    <div className="w-5 h-5 rounded-full bg-rose-100 flex items-center justify-center flex-shrink-0">
      <svg className="w-3 h-3 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </div>
  );
  if (state === 'active') return (
    <div className="w-5 h-5 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0">
      <svg className="w-3 h-3 text-brand-600 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
      </svg>
    </div>
  );
  return <div className="w-5 h-5 rounded-full bg-slate-100 flex-shrink-0" />;
}

const PICO_LABELS: Record<string, string> = {
  population:   'Population',
  intervention: 'Intervention',
  comparator:   'Comparator',
  outcome:      'Outcome',
};

const FACET_LABELS: Record<string, string> = {
  population:   'Population',
  intervention: 'Intervention',
  comparator:   'Comparator',
  outcome:      'Outcome',
};

export default function ProgressStream({
  sourceProgress, sourcesDone, sourcesError,
  isDeduplicating, rankingInfo, isEnriching, isComplete,
  expandedQueries, pubmedQueries, meshTerms, booleanQuery,
  pico, studyTypeFilters, aiRationale, facets, strategyNotes,
}: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const hasExpansion = expandedQueries && expandedQueries.length > 0;
  const hasPico = pico && Object.values(pico).some(v => v && v !== 'Not specified');
  const hasFacets = facets && Object.keys(facets).length > 0;
  const hasNotes = strategyNotes && strategyNotes.length > 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">

      {/* ── AI Search Strategy ─────────────────────────────────────────────── */}
      {hasExpansion && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">
              AI Search Strategy
            </p>
            <button
              onClick={() => setShowDetails(v => !v)}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              {showDetails ? 'less ▲' : 'more ▼'}
            </button>
          </div>

          {/* General queries */}
          <div className="space-y-1 mb-3">
            {expandedQueries!.map((q, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-slate-600">
                <span className="text-brand-400 font-mono text-xs mt-0.5 flex-shrink-0">{i + 1}.</span>
                <span className="italic">{q}</span>
              </div>
            ))}
          </div>

          {/* Rationale always shown */}
          {aiRationale && (
            <p className="text-xs text-slate-500 leading-relaxed bg-slate-50 rounded-lg px-3 py-2 mb-2">
              {aiRationale}
            </p>
          )}

          {/* Expandable details */}
          {showDetails && (
            <div className="space-y-3 border-t border-slate-100 pt-3">

              {/* Strategy notes (self-check warnings) */}
              {hasNotes && (
                <div>
                  <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1.5">
                    Strategy Notes
                  </p>
                  <div className="space-y-1">
                    {strategyNotes!.map((note, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 rounded px-2.5 py-1.5 leading-snug">
                        <span className="flex-shrink-0 mt-0.5">⚠</span>
                        <span>{note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Facets (PICO concept blocks) */}
              {hasFacets && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Search Facets (PICO Concept Blocks)
                  </p>
                  <div className="space-y-2">
                    {Object.entries(FACET_LABELS).map(([key, label]) => {
                      const facet = facets![key];
                      if (!facet) return null;
                      const hasContent = (facet.mesh?.length ?? 0) + (facet.freetext?.length ?? 0) > 0;
                      if (!hasContent) return null;
                      return (
                        <div key={key} className="rounded-lg border border-slate-100 overflow-hidden">
                          <div className="bg-slate-50 px-3 py-1.5">
                            <span className="text-xs font-semibold text-slate-600">{label}</span>
                          </div>
                          <div className="px-3 py-2 space-y-1.5">
                            {facet.mesh && facet.mesh.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {facet.mesh.map((t, i) => (
                                  <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 font-mono">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                            {facet.freetext && facet.freetext.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {facet.freetext.map((t, i) => (
                                  <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* PICO */}
              {hasPico && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    PICO Framework
                  </p>
                  <div className="rounded-lg border border-slate-100 overflow-hidden divide-y divide-slate-100">
                    {Object.entries(PICO_LABELS).map(([key, label]) => {
                      const val = pico![key];
                      if (!val || val === 'Not specified') return null;
                      return (
                        <div key={key} className="grid grid-cols-[90px_1fr] gap-2 px-3 py-1.5">
                          <span className="text-xs font-semibold text-slate-400">{label}</span>
                          <span className="text-xs text-slate-700">{val}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* PubMed-specific queries */}
              {pubmedQueries && pubmedQueries.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    PubMed / PMC Queries (MeSH)
                  </p>
                  <div className="space-y-1">
                    {pubmedQueries.map((q, i) => (
                      <p key={i} className="text-xs font-mono text-teal-700 bg-teal-50 rounded px-2.5 py-1.5 leading-snug break-all">
                        {q}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* MeSH terms */}
              {meshTerms && meshTerms.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    MeSH Terms
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {meshTerms.map((t, i) => (
                      <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Boolean query */}
              {booleanQuery && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Boolean Query
                  </p>
                  <p className="text-xs font-mono text-indigo-700 bg-indigo-50 rounded-lg px-3 py-2 leading-relaxed break-all">
                    {booleanQuery}
                  </p>
                </div>
              )}

              {/* Study type filters */}
              {studyTypeFilters && studyTypeFilters.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                    Study Type Filters
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {studyTypeFilters.map((f, i) => (
                      <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Per-source progress ────────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          Database Search Progress
        </p>
        <div className="space-y-2">
          {SOURCES.map((src) => {
            const done   = sourcesDone.has(src);
            const error  = src in sourcesError;
            const active = !done && !error;
            const count  = sourceProgress[src] ?? 0;
            const state  = error ? 'error' : done ? 'done' : active ? 'active' : 'pending';
            const isNcbi = src === 'pubmed' || src === 'pmc';

            return (
              <div key={src} className="flex items-center gap-3">
                <StatusIcon state={state} />
                <span className={`text-sm flex-1 ${done ? 'text-slate-700' : 'text-slate-400'}`}>
                  {SOURCE_LABELS[src]}
                  {isNcbi && pubmedQueries && pubmedQueries.length > 0 && done && (
                    <span className="ml-1 text-xs text-teal-600">MeSH</span>
                  )}
                </span>
                {count > 0 && (
                  <span className="text-xs font-medium text-slate-500 tabular-nums">
                    {count.toLocaleString()} candidates
                  </span>
                )}
                {error && (
                  <span className="text-xs text-rose-500" title={sourcesError[src]}>failed</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Post-processing steps ──────────────────────────────────────────── */}
      <div className="pt-3 border-t border-slate-100 space-y-2">

        <div className="flex items-center gap-3">
          <StatusIcon state={
            isComplete || rankingInfo ? 'done'
            : isDeduplicating ? 'active' : 'pending'
          } />
          <span className={`text-sm flex-1 ${isDeduplicating || rankingInfo || isComplete ? 'text-slate-700' : 'text-slate-400'}`}>
            Deduplicating results
          </span>
        </div>

        <div className="flex items-center gap-3">
          <StatusIcon state={
            isComplete || isEnriching ? 'done'
            : rankingInfo ? 'active' : 'pending'
          } />
          <span className={`text-sm flex-1 ${rankingInfo || isEnriching || isComplete ? 'text-slate-700' : 'text-slate-400'}`}>
            Ranking — best by citations &amp; recency
          </span>
          {rankingInfo && (
            <span className="text-xs font-medium text-indigo-600 tabular-nums whitespace-nowrap">
              {rankingInfo.selected} / {rankingInfo.candidates} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <StatusIcon state={isComplete ? 'done' : isEnriching ? 'active' : 'pending'} />
          <span className={`text-sm flex-1 ${isEnriching || isComplete ? 'text-slate-700' : 'text-slate-400'}`}>
            Enriching with Unpaywall OA
          </span>
        </div>

        <div className="flex items-center gap-3">
          <StatusIcon state={isComplete ? 'done' : 'pending'} />
          <span className={`text-sm font-medium ${isComplete ? 'text-slate-700' : 'text-slate-400'}`}>
            Complete
          </span>
        </div>
      </div>
    </div>
  );
}
