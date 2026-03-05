import { Fragment, useEffect, useState } from 'react';
import type { Paper, PaperSummary, ResultItem } from '../../types/paper';
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

const TEXT_SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  pmc_xml:      { label: 'Full text (PMC)', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  full_pdf:     { label: 'Full text (PDF)', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  abstract_only:{ label: 'Abstract only',  cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  none:         { label: 'No text',         cls: 'bg-slate-50 text-slate-500 border-slate-200' },
};

const EVIDENCE_GRADE_CLS: Record<string, string> = {
  High:      'bg-emerald-50 text-emerald-700 border-emerald-200',
  Moderate:  'bg-blue-50 text-blue-700 border-blue-200',
  Low:       'bg-amber-50 text-amber-700 border-amber-200',
  'Very Low':'bg-rose-50 text-rose-700 border-rose-200',
};

const DECISION_CLS: Record<string, string> = {
  include: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  maybe:   'bg-amber-50 text-amber-700 border-amber-200',
  exclude: 'bg-rose-50 text-rose-700 border-rose-200',
};

const CLAIM_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  reported_fact:        { label: 'Fact',          cls: 'bg-blue-50 text-blue-600 border-blue-200' },
  author_interpretation:{ label: 'Author interp.',cls: 'bg-violet-50 text-violet-600 border-violet-200' },
  inference:            { label: 'Inference',     cls: 'bg-amber-50 text-amber-600 border-amber-200' },
};

function AuthorCell({ authors }: { authors: string[] }) {
  if (authors.length === 0) return <span className="text-slate-400 italic">—</span>;
  return (
    <span title={authors.join('; ')}>
      {authors[0]}{authors.length > 1 ? <span className="text-slate-400"> et al.</span> : ''}
    </span>
  );
}

function OALink({ url }: { url: string | null }) {
  if (!url) return <span className="text-slate-300">—</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-medium"
      title="Open Access PDF"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      PDF
    </a>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value === 'NR') return null;
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-0.5">{label}</span>
      <span className="text-sm text-slate-700 leading-relaxed">{value}</span>
    </div>
  );
}

function TagList({ items, cls }: { items: string[]; cls?: string }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <span key={i} className={`text-xs px-2 py-0.5 rounded-full border ${cls ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
          {t}
        </span>
      ))}
    </div>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className={`text-xs font-bold uppercase tracking-widest mb-2 ${color}`}>{title}</h4>
      <div className="border border-slate-100 rounded-xl overflow-hidden divide-y divide-slate-100 bg-white">
        {children}
      </div>
    </div>
  );
}

function ResultsTable({ results }: { results: ResultItem[] }) {
  if (!results.length) return <p className="text-xs text-slate-400 italic">No results extracted.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-100">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {['Outcome', 'Finding', 'Effect Size', '95% CI', 'p-value', 'Type'].map(h => (
              <th key={h} className="px-2.5 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const ct = CLAIM_TYPE_BADGE[r.claim_type] ?? CLAIM_TYPE_BADGE.reported_fact;
            return (
              <tr key={i} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50">
                <td className="px-2.5 py-2 font-medium text-slate-700 max-w-[140px]">
                  <span className="line-clamp-2" title={r.outcome}>{r.outcome}</span>
                </td>
                <td className="px-2.5 py-2 text-slate-600 max-w-[200px]">
                  <span className="line-clamp-3" title={r.finding}>{r.finding}</span>
                  {r.supporting_quote && r.supporting_quote !== 'NR' && (
                    <details className="mt-1">
                      <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600 select-none">
                        quote ▼
                      </summary>
                      <p className="mt-1 text-[11px] italic text-slate-500 bg-slate-50 rounded px-2 py-1 leading-relaxed">
                        "{r.supporting_quote}"
                      </p>
                    </details>
                  )}
                </td>
                <td className="px-2.5 py-2 font-mono text-slate-700 whitespace-nowrap">
                  {r.effect_size !== 'NR' ? r.effect_size : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2.5 py-2 font-mono text-slate-600 whitespace-nowrap">
                  {r.ci_95 !== 'NR' ? r.ci_95 : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2.5 py-2 font-mono text-slate-600 whitespace-nowrap">
                  {r.p_value !== 'NR' ? r.p_value : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2.5 py-2">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${ct.cls}`}>
                    {ct.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Expandable per-paper summary card ─────────────────────────────────────────
function SummaryCard({ summary }: { summary: PaperSummary }) {
  const ts     = TEXT_SOURCE_BADGE[summary.text_source] ?? TEXT_SOURCE_BADGE.none;
  const grade  = summary.critical_appraisal.evidence_grade;
  const gradeCls = EVIDENCE_GRADE_CLS[grade] ?? EVIDENCE_GRADE_CLS.Low;
  const decisionCls = DECISION_CLS[summary.triage.decision] ?? DECISION_CLS.maybe;

  return (
    <div className="p-5 bg-slate-50 border-t border-slate-200 text-sm space-y-4">

      {/* Meta bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Depth badge — only shown for cross-referenced papers */}
        {(summary.depth ?? 0) > 0 && (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-indigo-100 text-indigo-700 border-indigo-200">
            Cross-ref D{summary.depth}
          </span>
        )}
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${ts.cls}`}>
          {ts.label}
        </span>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${gradeCls}`}>
          Evidence: {grade}
        </span>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${decisionCls}`}>
          {summary.triage.decision}
        </span>
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-slate-100 text-slate-600 border-slate-200">
          Clarity {summary.triage.clarity_score_1_5}/5
        </span>
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-violet-50 text-violet-700 border-violet-200">
          {summary.triage.category}
        </span>
        {summary.confidence.overall > 0 && (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-indigo-50 text-indigo-700 border-indigo-200">
            Confidence {Math.round(summary.confidence.overall * 100)}%
          </span>
        )}
        {summary.keywords.map((kw) => (
          <span key={kw} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 border border-slate-200">
            #{kw}
          </span>
        ))}
      </div>

      {/* One-line takeaway — highlighted */}
      {summary.one_line_takeaway && summary.one_line_takeaway !== 'NR' && (
        <div className="rounded-xl bg-brand-50 border border-brand-200 px-4 py-3">
          <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide mb-1">One-line Takeaway</p>
          <p className="text-sm text-brand-900 font-medium leading-relaxed">{summary.one_line_takeaway}</p>
        </div>
      )}

      {/* Triage */}
      <Section title="Triage (Pass 1)" color="text-slate-600">
        <Field label="Category"       value={summary.triage.category} />
        <Field label="Context"        value={summary.triage.context} />
        <Field label="Decision"       value={`${summary.triage.decision} — ${summary.triage.decision_reason}`} />
        {summary.triage.contributions.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Contributions</p>
            <ul className="space-y-1">
              {summary.triage.contributions.map((c, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-2">
                  <span className="text-brand-400 flex-shrink-0">→</span>{c}
                </li>
              ))}
            </ul>
          </div>
        )}
        {summary.triage.correctness_flags.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1.5">Correctness Flags</p>
            <ul className="space-y-1">
              {summary.triage.correctness_flags.map((f, i) => (
                <li key={i} className="text-sm text-amber-700 flex gap-2">
                  <span className="flex-shrink-0">⚠</span>{f}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Bibliography */}
      <Section title="Bibliography (Pass 2)" color="text-slate-600">
        <Field label="Authors"  value={summary.bibliography.authors.join('; ') || undefined} />
        <Field label="Journal"  value={summary.bibliography.journal} />
        <Field label="Year"     value={summary.bibliography.year?.toString()} />
        <Field label="Volume / Issue" value={[summary.bibliography.volume, summary.bibliography.issue].filter(Boolean).join(' / ') || undefined} />
        <Field label="Pages"    value={summary.bibliography.pages} />
        <Field label="DOI"      value={summary.bibliography.doi} />
        <Field label="PMID"     value={summary.bibliography.pmid} />
      </Section>

      {/* Methods */}
      <Section title="Methods" color="text-violet-600">
        <Field label="Study Design"          value={summary.methods.study_design} />
        <Field label="Setting"               value={summary.methods.setting} />
        <Field label="Sample N"              value={summary.methods.sample_n} />
        <Field label="Inclusion Criteria"    value={summary.methods.inclusion_criteria} />
        <Field label="Exclusion Criteria"    value={summary.methods.exclusion_criteria} />
        <Field label="Intervention/Exposure" value={summary.methods.intervention_or_exposure} />
        <Field label="Comparator"            value={summary.methods.comparator} />
        <Field label="Preregistration"       value={summary.methods.preregistration} />
        <Field label="Funding"               value={summary.methods.funding} />
        <Field label="COI"                   value={summary.methods.conflicts_of_interest} />
        {summary.methods.primary_outcomes.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Primary Outcomes</p>
            <TagList items={summary.methods.primary_outcomes} cls="bg-teal-50 text-teal-700 border-teal-200" />
          </div>
        )}
        {summary.methods.statistical_methods.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Statistical Methods</p>
            <TagList items={summary.methods.statistical_methods} cls="bg-indigo-50 text-indigo-700 border-indigo-200" />
          </div>
        )}
      </Section>

      {/* Results */}
      <div className="mb-4">
        <h4 className="text-xs font-bold uppercase tracking-widest mb-2 text-emerald-600">Results</h4>
        <ResultsTable results={summary.results} />
      </div>

      {/* Limitations */}
      {summary.limitations.length > 0 && (
        <Section title="Limitations" color="text-amber-600">
          <div className="py-1.5 px-4">
            <ul className="space-y-1">
              {summary.limitations.map((lim, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-2">
                  <span className="text-amber-500 flex-shrink-0">•</span>{lim}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {/* Critical Appraisal */}
      <Section title="Critical Appraisal (Pass 3)" color="text-rose-600">
        <Field label="Evidence Grade"   value={`${grade} — ${summary.critical_appraisal.evidence_grade_justification}`} />
        <Field label="Selection Bias"   value={summary.critical_appraisal.selection_bias} />
        <Field label="Measurement Bias" value={summary.critical_appraisal.measurement_bias} />
        <Field label="Confounding"      value={summary.critical_appraisal.confounding} />
        <Field label="Attrition"        value={summary.critical_appraisal.attrition} />
        <Field label="External Validity" value={summary.critical_appraisal.external_validity} />
        {summary.critical_appraisal.other_internal_validity_risks.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Other Validity Risks</p>
            <TagList items={summary.critical_appraisal.other_internal_validity_risks} cls="bg-rose-50 text-rose-600 border-rose-200" />
          </div>
        )}
        {summary.critical_appraisal.methodological_strengths.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Strengths</p>
            <TagList items={summary.critical_appraisal.methodological_strengths} cls="bg-emerald-50 text-emerald-700 border-emerald-200" />
          </div>
        )}
        {summary.critical_appraisal.reproducibility_signals.length > 0 && (
          <div className="py-1.5 px-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Reproducibility</p>
            <TagList items={summary.critical_appraisal.reproducibility_signals} cls="bg-teal-50 text-teal-700 border-teal-200" />
          </div>
        )}
      </Section>

      {/* Missing info */}
      {summary.missing_info.length > 0 && (
        <Section title="Missing Information" color="text-slate-500">
          <div className="py-1.5 px-4">
            <ul className="space-y-1">
              {summary.missing_info.map((m, i) => (
                <li key={i} className="text-sm text-slate-500 flex gap-2">
                  <span className="flex-shrink-0 text-slate-400">◦</span>{m}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {/* Extraction confidence */}
      {summary.confidence.notes && summary.confidence.notes !== 'NR' && (
        <p className="text-xs text-slate-400 italic border-t border-slate-100 pt-3">
          Extraction confidence {Math.round(summary.confidence.overall * 100)}%: {summary.confidence.notes}
        </p>
      )}
    </div>
  );
}

const SCREEN_CLS: Record<string, string> = {
  include:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  exclude:   'bg-rose-50 text-rose-700 border-rose-200',
  uncertain: 'bg-amber-50 text-amber-700 border-amber-200',
};

// ── Main table ─────────────────────────────────────────────────────────────────
export default function PapersTable({ papers, query = '', preloadedSummaries = {}, sessionId = '', screenings = {}, onOverrideScreening }: Props) {
  const [page, setPage]                   = useState(0);
  const [summaries, setSummaries]         = useState<Record<string, PaperSummary>>(preloadedSummaries);
  const [loading, setLoading]             = useState<string | null>(null);
  const [overriding, setOverriding]       = useState<string | null>(null); // paper key being overridden

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
    return (p.doi || p.title.slice(0, 60)).toLowerCase().trim();
  }

  async function handleSummarize(paper: Paper) {
    const key = paperKey(paper);
    if (summaries[key]) {
      // Already summarised — just toggle expand
      setExpanded((prev) => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
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
      <div className="text-center py-16 text-slate-400 text-sm">
        No results yet. Run a search above.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Results count bar */}
      <div className="flex items-center justify-between text-xs text-slate-500 px-1">
        <span>
          Showing <span className="font-semibold text-slate-700">
            {PAGE_SIZE > 0 ? `${start + 1}–${Math.min(start + effectivePageSize, papers.length)}` : papers.length.toLocaleString()}
          </span> of{' '}
          <span className="font-semibold text-slate-700">{papers.length.toLocaleString()}</span> papers
        </span>
        {PAGE_SIZE > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}
              className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              ← Prev
            </button>
            <span className="px-2 tabular-nums">{safePage + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}
              className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide w-8">#</th>
              {['Title', 'First Author', 'Year', 'Journal', 'Citations', 'OA PDF', 'Source'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
              {/* Extraction columns — shown when any summary exists */}
              <th className="px-2 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap min-w-[80px]">Design</th>
              <th className="px-2 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap min-w-[50px]">N</th>
              <th className="px-2 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap min-w-[70px]">Grade</th>
              <th className="px-2 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap min-w-[70px]">Screen</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">AI Analysis</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((paper, i) => {
              const key     = paperKey(paper);
              const isLoading  = loading === key;
              const hasSummary = !!summaries[key];
              const isExpanded = expanded.has(key);
              const hasError   = !!errors[key];

              return (
                <Fragment key={`group-${key}-${start + i}`}>
                  <tr key={`row-${start + i}`} className="hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0">
                    {/* Row number */}
                    <td className="px-3 py-3 text-xs text-slate-400 tabular-nums text-right align-top">{start + i + 1}</td>

                    {/* Title */}
                    <td className="px-4 py-3 max-w-xs align-top">
                      <div className="font-medium text-slate-800 leading-snug line-clamp-2" title={paper.title}>
                        {paper.doi ? (
                          <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer"
                            className="hover:text-brand-600 hover:underline underline-offset-2">
                            {paper.title}
                          </a>
                        ) : paper.title}
                      </div>
                      {paper.doi && <p className="text-xs text-slate-400 mt-0.5 font-mono truncate">{paper.doi}</p>}
                    </td>

                    {/* First Author */}
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap align-top">
                      <AuthorCell authors={paper.authors} />
                    </td>

                    {/* Year */}
                    <td className="px-4 py-3 text-slate-600 tabular-nums whitespace-nowrap align-top">
                      {paper.year ?? <span className="text-slate-300">—</span>}
                    </td>

                    {/* Journal */}
                    <td className="px-4 py-3 text-slate-600 max-w-[160px] align-top">
                      <span className="line-clamp-2" title={paper.journal ?? ''}>
                        {paper.journal ?? <span className="text-slate-300">—</span>}
                      </span>
                    </td>

                    {/* Citations */}
                    <td className="px-4 py-3 text-slate-600 tabular-nums whitespace-nowrap text-right align-top">
                      {paper.citation_count != null
                        ? <span className="font-medium">{paper.citation_count.toLocaleString()}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>

                    {/* OA PDF */}
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      <OALink url={paper.oa_pdf_url} />
                    </td>

                    {/* Source badge */}
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        SOURCE_STYLES[paper.source] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                      }`}>
                        {SOURCE_LABELS[paper.source] ?? paper.source}
                      </span>
                    </td>

                    {/* Design */}
                    <td className="px-2 py-3 align-top text-xs text-slate-600 max-w-[90px]">
                      {summaries[key]
                        ? <span className="line-clamp-2" title={summaries[key].methods.study_design}>
                            {summaries[key].methods.study_design !== 'NR' ? summaries[key].methods.study_design.slice(0, 20) : <span className="text-slate-300">NR</span>}
                          </span>
                        : <span className="text-slate-300">—</span>}
                    </td>

                    {/* N */}
                    <td className="px-2 py-3 align-top text-xs text-slate-600 text-right whitespace-nowrap">
                      {summaries[key]
                        ? (summaries[key].methods.sample_n !== 'NR'
                            ? summaries[key].methods.sample_n.slice(0, 12)
                            : <span className="text-slate-300">NR</span>)
                        : <span className="text-slate-300">—</span>}
                    </td>

                    {/* Evidence Grade */}
                    <td className="px-2 py-3 align-top whitespace-nowrap">
                      {summaries[key]
                        ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${
                            EVIDENCE_GRADE_CLS[summaries[key].critical_appraisal.evidence_grade] ?? EVIDENCE_GRADE_CLS.Low
                          }`}>
                            {summaries[key].critical_appraisal.evidence_grade}
                          </span>
                        : <span className="text-slate-300 text-xs">—</span>}
                    </td>

                    {/* Screen decision badge + override */}
                    <td className="px-2 py-3 align-top whitespace-nowrap">
                      {screenings[key] ? (
                        overriding === key ? (
                          <select
                            autoFocus
                            defaultValue={screenings[key].decision}
                            className="text-[10px] border border-slate-300 rounded px-1 py-0.5"
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
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>

                    {/* Summarise button */}
                    <td className="px-4 py-3 whitespace-nowrap align-top">
                      {hasError ? (
                        <div className="space-y-1">
                          <span className="text-xs text-rose-600">Error</span>
                          <button onClick={() => handleSummarize(paper)}
                            className="block text-xs text-brand-600 hover:underline">Retry</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSummarize(paper)}
                          disabled={isLoading}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            hasSummary
                              ? isExpanded
                                ? 'bg-brand-100 text-brand-700 border border-brand-300'
                                : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-brand-50 hover:text-brand-700'
                              : 'bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 disabled:opacity-40'
                          }`}
                        >
                          {isLoading ? (
                            <>
                              <LoadingLottie className="w-4 h-4" />
                              Analysing…
                            </>
                          ) : hasSummary ? (
                            isExpanded ? '▲ Hide' : '▼ Show Analysis'
                          ) : (
                            <>
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                              </svg>
                              Analyse
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>

                  {/* Expandable summary row */}
                  {isExpanded && summaries[key] && (
                    <tr key={`summary-${start + i}`}>
                      <td colSpan={13} className="p-0">
                        <SummaryCard summary={summaries[key]} />
                      </td>
                    </tr>
                  )}

                  {/* Error row */}
                  {hasError && (
                    <tr key={`error-${start + i}`}>
                      <td colSpan={13} className="px-6 py-2 bg-rose-50 text-xs text-rose-600 border-t border-rose-100">
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
        <div className="flex items-center justify-center gap-2 pt-1">
          {Array.from({ length: totalPages }, (_, i) => (
            <button key={i} onClick={() => setPage(i)}
              className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors ${
                i === safePage ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}>
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
