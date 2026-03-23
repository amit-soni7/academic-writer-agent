import { Fragment, useEffect, useState } from 'react';
import type { Paper, PaperSummary } from '../../types/paper';
import { projectPaperPdfUrl } from '../../api/projects';
import { summarizePaper } from '../../api/literature';
import LoadingLottie from '../LoadingLottie';

// PAGE_SIZE=0 means show all papers on one page (no pagination)
const PAGE_SIZE = 0;

interface Screening {
  decision: string;
  reason: string;
}

interface Props {
  papers: Paper[];
  query?: string;
  preloadedSummaries?: Record<string, PaperSummary>;  // from Summarize All
  sessionId?: string;
  screenings?: Record<string, Screening>;
  onOverrideScreening?: (paperKey: string, decision: string) => void;
  onViewDetail?: (paper: Paper, summary: PaperSummary | null) => void;
}

const SOURCE_STYLES: Record<string, string> = {
  pubmed:           'bg-blue-50 text-blue-700 border-blue-200',
  pmc:              'bg-teal-50 text-teal-700 border-teal-200',
  openalex:         'bg-violet-50 text-violet-700 border-violet-200',
  semantic_scholar: 'bg-orange-50 text-orange-700 border-orange-200',
  crossref:         'bg-green-50 text-green-700 border-green-200',
  europe_pmc:       'bg-sky-50 text-sky-700 border-sky-200',
  clinical_trials:  'bg-rose-50 text-rose-700 border-rose-200',
  arxiv:            'bg-yellow-50 text-yellow-700 border-yellow-200',
};

const SOURCE_LABELS: Record<string, string> = {
  pubmed:           'PubMed',
  pmc:              'PMC',
  openalex:         'OpenAlex',
  semantic_scholar: 'S2',
  crossref:         'Crossref',
  europe_pmc:       'Europe PMC',
  clinical_trials:  'ClinicalTrials',
  arxiv:            'arXiv',
};

const EVIDENCE_GRADE_CLS: Record<string, string> = {
  High:      'bg-emerald-50 text-emerald-700 border-emerald-200',
  Moderate:  'bg-blue-50 text-blue-700 border-blue-200',
  Low:       'bg-amber-50 text-amber-700 border-amber-200',
  'Very Low':'bg-rose-50 text-rose-700 border-rose-200',
};

function AuthorCell({ authors }: { authors: string[] }) {
  if (authors.length === 0) return <span className="text-slate-400 italic">—</span>;
  return (
    <span title={authors.join('; ')}>
      {authors[0]}{authors.length > 1 ? <span className="text-slate-400"> et al.</span> : ''}
    </span>
  );
}

function projectPaperKey(paper: Paper) {
  return (paper.doi || paper.title.slice(0, 60)).toLowerCase().trim();
}

function paperPdfHref(paper: Paper, projectId?: string) {
  if (projectId) {
    return projectPaperPdfUrl(projectId, projectPaperKey(paper));
  }
  if (paper.oa_pdf_url) return paper.oa_pdf_url;
  if (paper.doi) return `https://doi.org/${paper.doi}`;
  return '';
}

function getWritingEvidenceMeta(summary: PaperSummary) {
  if (summary.writing_evidence_meta) return summary.writing_evidence_meta;
  const counts = new Map<string, number>();
  for (const item of summary.sentence_bank ?? []) {
    counts.set(item.section, (counts.get(item.section) ?? 0) + 1);
  }
  const dominantSections = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([section]) => section);
  const limitingFactors: string[] = [];
  if (summary.text_source === 'abstract_only') limitingFactors.push('abstract_only');
  if (summary.text_source === 'none') limitingFactors.push('no_text_available');
  return {
    selected_count: summary.sentence_bank?.length ?? 0,
    max_count: 20,
    dominant_sections: dominantSections,
    limiting_factors: limitingFactors,
  };
}

function writingEvidenceCount(summary: PaperSummary) {
  return getWritingEvidenceMeta(summary).selected_count;
}

const SCREEN_CLS: Record<string, string> = {
  include:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  exclude:   'bg-rose-50 text-rose-700 border-rose-200',
  uncertain: 'bg-amber-50 text-amber-700 border-amber-200',
};

// ── Main table ─────────────────────────────────────────────────────────────────
export default function PapersTable({ papers, query = '', preloadedSummaries = {}, sessionId = '', screenings = {}, onOverrideScreening, onViewDetail }: Props) {
  const [page, setPage]                   = useState(0);
  const [summaries, setSummaries]         = useState<Record<string, PaperSummary>>(preloadedSummaries);
  const [loading, setLoading]             = useState<string | null>(null);
  const [overriding, setOverriding]       = useState<string | null>(null); // paper key being overridden
  const showScreeningColumn               = Object.keys(screenings).length > 0 || Boolean(onOverrideScreening);

  // Merge incoming preloaded summaries (from Summarize All stream)
  useEffect(() => {
    if (Object.keys(preloadedSummaries).length > 0) {
      setSummaries((prev) => ({ ...prev, ...preloadedSummaries }));
    }
  }, [preloadedSummaries]);
  const [errors, setErrors]               = useState<Record<string, string>>({});
  const [expanded, setExpanded]           = useState<Set<string>>(new Set());

  const effectivePageSize = PAGE_SIZE > 0 ? PAGE_SIZE : papers.length || 1;
  const totalPages = Math.max(1, Math.ceil(papers.length / effectivePageSize));
  const safePage   = Math.min(page, totalPages - 1);
  const start      = safePage * effectivePageSize;
  const slice      = PAGE_SIZE > 0 ? papers.slice(start, start + effectivePageSize) : papers;

  function paperKey(p: Paper) {
    return projectPaperKey(p);
  }

  async function handleSummarize(paper: Paper, force = false) {
    const key = paperKey(paper);
    if (summaries[key] && !force) {
      // Already summarised — just toggle expand
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    setLoading(key);
    setErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      const result = await summarizePaper(paper, query, sessionId);
      setSummaries((s) => ({ ...s, [key]: result }));
      setExpanded((prev) => new Set([...prev, key]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Summarisation failed';
      setErrors((e) => ({ ...e, [key]: msg }));
    } finally {
      setLoading(null);
    }
  }

  if (papers.length === 0) {
    return (
      <div className="text-center py-16 text-sm" style={{ color: 'var(--text-muted)' }}>
        No results yet. Run a search above.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Results count bar */}
      <div className="flex items-center justify-between text-xs font-bold px-2 pt-2"
        style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
        <span>
          Showing{' '}
          <span style={{ color: 'var(--text-bright)' }}>
            {PAGE_SIZE > 0 ? `${start + 1}–${Math.min(start + effectivePageSize, papers.length)}` : papers.length.toLocaleString()}
          </span> of{' '}
          <span style={{ color: 'var(--text-bright)' }}>{papers.length.toLocaleString()}</span> papers
        </span>
        {PAGE_SIZE > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}
              className="p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: 'var(--text-muted)' }}>
              <span className="material-symbols-outlined text-sm">chevron_left</span>
            </button>
            <button className="px-2 py-1 rounded text-white" style={{ background: 'var(--gold)' }}>{safePage + 1}</button>
            {totalPages > 1 && Array.from({ length: Math.min(totalPages - 1, 3) }, (_, idx) => idx + 1).map(p => (
              <button key={p} onClick={() => setPage(p)} className="px-2 py-1 rounded hover:opacity-80 transition-colors"
                style={{ color: 'var(--text-muted)' }}>{p + 1}</button>
            ))}
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}
              className="p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: 'var(--text-muted)' }}>
              <span className="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl" style={{ border: '1px solid var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ background: 'var(--bg-elevated)' }}>
              <th className="px-4 py-4 text-left text-[10px] font-extrabold uppercase tracking-widest w-8"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>#</th>
              <th className="px-5 py-4 text-left text-[10px] font-extrabold uppercase tracking-widest"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Paper Title & Authors</th>
              <th className="px-4 py-4 text-left text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Source</th>
              <th className="px-4 py-4 text-center text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Citations</th>
              <th className="px-4 py-4 text-left text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Journal</th>
              {showScreeningColumn && (
                <th className="px-3 py-4 text-left text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap min-w-[70px]"
                  style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Screen</th>
              )}
              <th className="px-5 py-4 text-right text-[10px] font-extrabold uppercase tracking-widest whitespace-nowrap"
                style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((paper, i) => {
              const key     = paperKey(paper);
              const isLoading  = loading === key;
              const hasSummary = !!summaries[key];
              const isExpanded = expanded.has(key);
              const hasError   = !!errors[key];
              const pdfHref = paperPdfHref(paper, sessionId || undefined);
              const sentenceCount = hasSummary ? writingEvidenceCount(summaries[key]) : 0;

              return (
                <Fragment key={`group-${key}-${start + i}`}>
                  <tr key={`row-${start + i}`} className="group transition-colors"
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = ''}>
                    {/* Row number */}
                    <td className="px-4 py-5 text-xs tabular-nums text-right align-top" style={{ color: 'var(--text-muted)' }}>{start + i + 1}</td>

                    {/* Paper Title & Authors */}
                    <td className="px-5 py-5 align-top">
                      <div className="space-y-1.5">
                        <div className="text-[15px] font-semibold leading-snug line-clamp-2 cursor-pointer transition-colors"
                          title={paper.title}
                          style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}
                          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--gold)'}
                          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-bright)'}>
                          {paper.doi ? (
                            <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer">
                              {paper.title}
                            </a>
                          ) : paper.title}
                        </div>
                        <div className="flex items-center gap-2 text-xs" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                          <AuthorCell authors={paper.authors} />
                          {paper.year && <span className="opacity-60">{paper.year}</span>}
                        </div>
                      </div>
                    </td>

                    {/* Source badge */}
                    <td className="px-4 py-5 whitespace-nowrap align-top">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                        SOURCE_STYLES[paper.source] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                      }`}>
                        {SOURCE_LABELS[paper.source] ?? paper.source}
                      </span>
                    </td>

                    {/* Citations */}
                    <td className="px-4 py-5 text-center tabular-nums whitespace-nowrap align-top">
                      {paper.citation_count != null ? (
                        <div className="inline-flex items-center gap-1.5">
                          <span className="text-sm font-bold" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright)' }}>
                            {paper.citation_count.toLocaleString()}
                          </span>
                          {paper.citation_count > 50 && (
                            <span className="material-symbols-outlined text-[14px]" style={{ color: '#10b981' }}>trending_up</span>
                          )}
                        </div>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>

                    {/* Journal */}
                    <td className="px-4 py-5 align-top whitespace-nowrap">
                      {paper.journal ? (
                        <span className="text-xs" style={{ color: 'var(--text-secondary)', fontFamily: 'Manrope, sans-serif' }}
                          title={paper.journal}>
                          {paper.journal.length > 30 ? paper.journal.slice(0, 27) + '…' : paper.journal}
                        </span>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>

                    {/* Screen decision badge + override */}
                    {showScreeningColumn && (
                      <td className="px-3 py-5 align-top whitespace-nowrap">
                        {screenings[key] ? (
                          overriding === key ? (
                            <select
                              autoFocus
                              defaultValue={screenings[key].decision}
                              className="text-[10px] rounded px-1 py-0.5"
                              style={{ border: '1px solid var(--border-muted)' }}
                              onChange={(e) => {
                                onOverrideScreening?.(key, e.target.value);
                                setOverriding(null);
                              }}
                              onBlur={() => setOverriding(null)}
                            >
                              <option value="include">include</option>
                              <option value="uncertain">uncertain</option>
                              <option value="exclude">exclude</option>
                            </select>
                          ) : (
                            <button
                              onClick={() => setOverriding(key)}
                              title={screenings[key].reason}
                              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border cursor-pointer hover:opacity-80 ${
                                SCREEN_CLS[screenings[key].decision] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                              }`}
                            >
                              {screenings[key].decision}
                            </button>
                          )
                        ) : (
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                    )}

                    {/* Actions (hover-reveal + inline summary) */}
                    <td className="px-5 py-5 text-right align-top min-w-[200px]">
                      {hasError ? (
                        <div className="space-y-1 text-right">
                          <span className="text-xs text-rose-600">Error</span>
                          <button onClick={() => handleSummarize(paper)}
                            className="block text-xs ml-auto hover:underline" style={{ color: 'var(--gold)' }}>Retry</button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {/* Hover-reveal action buttons (Stitch style) */}
                          <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            {pdfHref && (
                              <a href={pdfHref} target="_blank" rel="noreferrer"
                                className="p-2 rounded-lg transition-all"
                                style={{ color: 'var(--text-muted)' }}
                                title="View PDF"
                                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; e.currentTarget.style.background = 'var(--gold-faint)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = ''; }}>
                                <span className="material-symbols-outlined text-[20px]">picture_as_pdf</span>
                              </a>
                            )}
                            <button
                              onClick={() => handleSummarize(paper)}
                              disabled={isLoading}
                              className="p-2 rounded-lg transition-all disabled:opacity-40"
                              style={{ color: 'var(--text-muted)' }}
                              title={hasSummary ? (isExpanded ? 'Hide Analysis' : 'Show Analysis') : 'Analyse'}
                              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; e.currentTarget.style.background = 'var(--gold-faint)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = ''; }}>
                              {isLoading ? (
                                <LoadingLottie className="w-5 h-5" />
                              ) : (
                                <span className="material-symbols-outlined text-[20px]">
                                  {hasSummary ? (isExpanded ? 'expand_less' : 'expand_more') : 'auto_awesome'}
                                </span>
                              )}
                            </button>
                            {hasSummary && (
                              <button
                                onClick={() => handleSummarize(paper, true)}
                                disabled={isLoading}
                                className="p-2 rounded-lg transition-all disabled:opacity-40"
                                style={{ color: 'var(--text-muted)' }}
                                title="Re-analyse"
                                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; e.currentTarget.style.background = 'var(--gold-faint)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = ''; }}>
                                <span className="material-symbols-outlined text-[20px]">refresh</span>
                              </button>
                            )}
                            {onViewDetail && (
                              <button
                                onClick={() => onViewDetail(paper, summaries[key] ?? null)}
                                className="p-2 rounded-lg transition-all"
                                style={{ color: 'var(--text-muted)' }}
                                title="View full summary"
                                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; e.currentTarget.style.background = 'var(--gold-faint)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = ''; }}>
                                <span className="material-symbols-outlined text-[20px]">open_in_new</span>
                              </button>
                            )}
                          </div>
                          {/* Inline summary preview — compact badges */}
                          {hasSummary && (
                            <div className="flex flex-wrap justify-end items-center gap-1.5 mt-1">
                              {summaries[key].critical_appraisal.evidence_grade && summaries[key].critical_appraisal.evidence_grade !== 'NR' && (
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${
                                  EVIDENCE_GRADE_CLS[summaries[key].critical_appraisal.evidence_grade] ?? EVIDENCE_GRADE_CLS.Low
                                }`}>
                                  {summaries[key].critical_appraisal.evidence_grade}
                                </span>
                              )}
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium"
                                style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
                                {sentenceCount} stmt{sentenceCount === 1 ? '' : 's'}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>

                  {/* Slim accordion — key info only, link to full detail page */}
                  {isExpanded && summaries[key] && (
                    <tr key={`summary-${start + i}`}>
                      <td colSpan={showScreeningColumn ? 8 : 7} className="p-0">
                        <div className="px-6 py-4 space-y-3" style={{ background: 'rgba(248,249,250,0.7)', borderTop: '1px solid var(--border-faint)' }}>

                          {/* Takeaway */}
                          {summaries[key].one_line_takeaway && summaries[key].one_line_takeaway !== 'NR' && (
                            <div className="rounded-xl px-4 py-2.5 relative overflow-hidden" style={{ background: 'var(--gold-faint)' }}>
                              <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'var(--gold)' }} />
                              <p className="text-[10px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>Takeaway</p>
                              <p className="text-sm leading-snug" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                                {summaries[key].one_line_takeaway}
                              </p>
                            </div>
                          )}

                          {/* 4-field key facts row */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
                              <p className="text-[9px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Evidence Grade</p>
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${EVIDENCE_GRADE_CLS[summaries[key].critical_appraisal.evidence_grade] ?? EVIDENCE_GRADE_CLS.Low}`}>
                                {summaries[key].critical_appraisal.evidence_grade}
                              </span>
                            </div>
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
                              <p className="text-[9px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Study Design</p>
                              <p className="text-xs" style={{ color: 'var(--text-body)' }}>
                                {summaries[key].methods.study_design !== 'NR' ? summaries[key].methods.study_design : '—'}
                              </p>
                            </div>
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
                              <p className="text-[9px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Sample Size</p>
                              <p className="text-xs font-medium" style={{ color: 'var(--text-body)' }}>
                                {summaries[key].methods.sample_n !== 'NR' ? summaries[key].methods.sample_n : '—'}
                              </p>
                            </div>
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-surface)' }}>
                              <p className="text-[9px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Writing Statements</p>
                              <p className="text-xs font-bold" style={{ color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>
                                {summaries[key].sentence_bank?.length ?? 0} extracted
                              </p>
                            </div>
                          </div>

                          {/* Main finding excerpt */}
                          {(() => {
                            const finding = summaries[key].results.find(r => r.finding && r.finding !== 'NR')?.finding
                              || summaries[key].sentence_bank?.find(s => s.importance === 'high')?.text;
                            return finding ? (
                              <div className="rounded-xl px-4 py-2.5" style={{ background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.12)' }}>
                                <p className="text-[9px] font-bold uppercase tracking-wide mb-0.5" style={{ color: '#059669', fontFamily: 'Manrope, sans-serif' }}>Main Finding</p>
                                <p className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--text-body)' }}>{finding}</p>
                              </div>
                            ) : null;
                          })()}

                          {/* Full detail link */}
                          {onViewDetail && (
                            <div className="flex justify-end">
                              <button
                                onClick={() => onViewDetail(paper, summaries[key])}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold transition-all hover:opacity-70"
                                style={{ color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}
                              >
                                View full summary
                                <span className="material-symbols-outlined text-sm">arrow_forward</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Error row */}
                  {hasError && (
                    <tr key={`error-${start + i}`}>
                      <td colSpan={showScreeningColumn ? 8 : 7} className="px-6 py-2 text-xs text-rose-600"
                        style={{ background: 'rgba(220,38,38,0.05)', borderTop: '1px solid rgba(220,38,38,0.1)' }}>
                        {errors[key]}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Bottom pagination */}
      {PAGE_SIZE > 0 && totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 pt-2"
          style={{ fontFamily: 'Manrope, sans-serif' }}>
          {Array.from({ length: totalPages }, (_, i) => (
            <button key={i} onClick={() => setPage(i)}
              className="px-2 py-1 rounded text-xs font-bold transition-colors"
              style={i === safePage
                ? { background: 'var(--gold)', color: '#fff' }
                : { color: 'var(--text-muted)' }}>
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
