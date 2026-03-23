import type { Paper, PaperSummary, ResultItem } from '../../types/paper';
import { projectPaperPdfUrl } from '../../api/projects';

interface Props {
  paper: Paper;
  summary: PaperSummary | null;
  projectId: string;
  onBack: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEXT_SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  pmc_xml:      { label: 'Full text (PMC)',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  full_pdf:     { label: 'Full text (PDF)',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  full_html:    { label: 'Full text (HTML)', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  abstract_only:{ label: 'Abstract only',   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  none:         { label: 'No text',          cls: 'bg-slate-50 text-slate-500 border-slate-200' },
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
  author_interpretation:{ label: 'Author interp.', cls: 'bg-violet-50 text-violet-600 border-violet-200' },
  inference:            { label: 'Inference',      cls: 'bg-amber-50 text-amber-600 border-amber-200' },
};

const SECTION_LABELS: Record<string, string> = {
  background: 'Background', methods: 'Methods',
  results: 'Results', discussion: 'Discussion', conclusion: 'Conclusion',
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value === 'NR') return null;
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 px-5 py-2 border-b border-slate-100 last:border-0">
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
        <span key={i} className={`text-xs px-2 py-0.5 rounded-full border ${cls ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{t}</span>
      ))}
    </div>
  );
}

function SectionBlock({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h4 className={`text-xs font-bold uppercase tracking-widest mb-3 ${color}`}>{title}</h4>
      <div className="rounded-xl border border-slate-100 overflow-hidden divide-y divide-slate-100 bg-white">
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
              <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const ct = CLAIM_TYPE_BADGE[r.claim_type] ?? CLAIM_TYPE_BADGE.reported_fact;
            return (
              <tr key={i} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-slate-700 max-w-[140px]">
                  <span className="line-clamp-2" title={r.outcome}>{r.outcome}</span>
                </td>
                <td className="px-3 py-2 text-slate-600 max-w-[220px]">
                  <span className="line-clamp-3" title={r.finding}>{r.finding}</span>
                  {r.supporting_quote && r.supporting_quote !== 'NR' && (
                    <details className="mt-1">
                      <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600 select-none">quote ▼</summary>
                      <p className="mt-1 text-[11px] italic text-slate-500 bg-slate-50 rounded px-2 py-1 leading-relaxed">"{r.supporting_quote}"</p>
                    </details>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-slate-700 whitespace-nowrap">
                  {r.effect_size !== 'NR' ? r.effect_size : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap">
                  {r.ci_95 !== 'NR' ? r.ci_95 : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap">
                  {r.p_value !== 'NR' ? r.p_value : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${ct.cls}`}>{ct.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PaperDetailPage({ paper, summary, projectId, onBack }: Props) {
  const pdfHref = projectId
    ? projectPaperPdfUrl(projectId, (paper.doi || paper.title.slice(0, 60)).toLowerCase().trim())
    : paper.oa_pdf_url || (paper.doi ? `https://doi.org/${paper.doi}` : '');

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>

      {/* Header */}
      <header className="w-full sticky top-0 z-10 flex items-center gap-4 px-8 py-3"
        style={{ background: 'var(--bg-elevated)', boxShadow: '0 1px 0 rgba(199,196,216,0.15)' }}>
        <button onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 active:scale-95"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Literature Search
        </button>
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
          Paper Detail
        </span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-10 max-w-5xl mx-auto w-full">

        {/* Paper title block */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold leading-tight mb-3"
            style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
            {paper.title}
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
            {paper.authors.length > 0 && (
              <span>{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}</span>
            )}
            {paper.year && <span className="opacity-60">· {paper.year}</span>}
            {paper.journal && (
              <span className="px-2.5 py-1 text-[11px] font-bold rounded-full"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                {paper.journal}
              </span>
            )}
            {paper.citation_count != null && (
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">format_quote</span>
                {paper.citation_count.toLocaleString()} citations
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {pdfHref && (
              <a href={pdfHref} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'rgba(16,185,129,0.08)', color: '#059669', border: '1px solid rgba(16,185,129,0.2)' }}>
                <span className="material-symbols-outlined text-base">open_in_new</span>
                Open PDF
              </a>
            )}
            {paper.doi && (
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                <span className="material-symbols-outlined text-base">link</span>
                DOI: {paper.doi}
              </a>
            )}
          </div>
        </div>

        {/* Abstract */}
        {paper.abstract && (
          <div className="mb-8 rounded-2xl p-6" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
            <h3 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>Abstract</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-body)', fontFamily: 'Newsreader, Georgia, serif' }}>{paper.abstract}</p>
          </div>
        )}

        {/* No summary state */}
        {!summary && (
          <div className="rounded-2xl p-12 text-center" style={{ background: 'var(--bg-surface)', boxShadow: '0 4px 32px rgba(25,28,29,0.04)' }}>
            <span className="material-symbols-outlined text-4xl block mx-auto mb-4" style={{ color: 'var(--text-muted)' }}>analytics</span>
            <p className="text-base font-semibold mb-2" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
              No AI analysis yet
            </p>
            <p className="text-sm" style={{ color: 'var(--text-muted)', fontFamily: 'Manrope, sans-serif' }}>
              Use "Summarise All" in Literature Search or click Analyse on this paper to extract evidence.
            </p>
          </div>
        )}

        {/* Full summary */}
        {summary && (
          <div className="space-y-6">

            {/* Meta badges */}
            <div className="flex flex-wrap gap-2 items-center">
              {(summary.depth ?? 0) > 0 && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-indigo-100 text-indigo-700 border-indigo-200">
                  Cross-ref D{summary.depth}
                </span>
              )}
              {(() => {
                const ts = TEXT_SOURCE_BADGE[summary.text_source] ?? TEXT_SOURCE_BADGE.none;
                return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${ts.cls}`}>{ts.label}</span>;
              })()}
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${EVIDENCE_GRADE_CLS[summary.critical_appraisal.evidence_grade] ?? EVIDENCE_GRADE_CLS.Low}`}>
                Evidence: {summary.critical_appraisal.evidence_grade}
              </span>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${DECISION_CLS[summary.triage.decision] ?? DECISION_CLS.maybe}`}>
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
            </div>

            {/* One-line takeaway */}
            {summary.one_line_takeaway && summary.one_line_takeaway !== 'NR' && (
              <div className="rounded-2xl px-6 py-4 relative overflow-hidden" style={{
                background: 'rgba(248,249,250,0.85)',
                backdropFilter: 'blur(16px)',
                boxShadow: '0 4px 32px rgba(25,28,29,0.04)',
              }}>
                <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl" style={{ background: 'linear-gradient(to bottom, var(--gold), var(--gold-light))' }} />
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--gold)', fontFamily: 'Manrope, sans-serif' }}>One-line Takeaway</p>
                <p className="text-base leading-relaxed font-medium" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                  {summary.one_line_takeaway}
                </p>
              </div>
            )}

            {/* 3-col summary cards */}
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2">Main Finding</p>
                <p className="text-sm text-emerald-950 leading-relaxed">
                  {summary.results.find(r => r.finding && r.finding !== 'NR')?.finding
                    || summary.sentence_bank?.find(s => s.importance === 'high')?.text
                    || summary.one_line_takeaway
                    || 'Not extracted.'}
                </p>
              </div>
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
                <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-2">Study Snapshot</p>
                <div className="space-y-1 text-sm text-indigo-950">
                  <p>{summary.methods.study_design !== 'NR' ? summary.methods.study_design : 'Design NR'}</p>
                  <p>{summary.methods.sample_n !== 'NR' ? `n = ${summary.methods.sample_n}` : 'Sample NR'}</p>
                  <p>{(summary.sentence_bank?.length ?? 0)} writing statement{summary.sentence_bank?.length === 1 ? '' : 's'} extracted</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Keywords</p>
                <div className="flex flex-wrap gap-1.5">
                  {summary.keywords.map((kw, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">#{kw}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Triage */}
            <SectionBlock title="Triage" color="text-slate-600">
              <Field label="Category"   value={summary.triage.category} />
              <Field label="Context"    value={summary.triage.context} />
              <Field label="Decision"   value={`${summary.triage.decision} — ${summary.triage.decision_reason}`} />
              {summary.triage.contributions.length > 0 && (
                <div className="py-2 px-4">
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
                <div className="py-2 px-4">
                  <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1.5">Correctness Flags</p>
                  <ul className="space-y-1">
                    {summary.triage.correctness_flags.map((f, i) => (
                      <li key={i} className="text-sm text-amber-700 flex gap-2"><span className="flex-shrink-0">⚠</span>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </SectionBlock>

            {/* Methods */}
            <SectionBlock title="Methods" color="text-violet-600">
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
                <div className="py-2 px-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Primary Outcomes</p>
                  <TagList items={summary.methods.primary_outcomes} cls="bg-teal-50 text-teal-700 border-teal-200" />
                </div>
              )}
              {summary.methods.statistical_methods.length > 0 && (
                <div className="py-2 px-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Statistical Methods</p>
                  <TagList items={summary.methods.statistical_methods} cls="bg-indigo-50 text-indigo-700 border-indigo-200" />
                </div>
              )}
            </SectionBlock>

            {/* Results */}
            <div className="mb-6">
              <h4 className="text-xs font-bold uppercase tracking-widest mb-3 text-emerald-600">Results</h4>
              <ResultsTable results={summary.results} />
            </div>

            {/* Limitations */}
            {summary.limitations.length > 0 && (
              <SectionBlock title="Limitations" color="text-amber-600">
                <div className="py-2 px-4">
                  <ul className="space-y-1">
                    {summary.limitations.map((lim, i) => (
                      <li key={i} className="text-sm text-slate-700 flex gap-2">
                        <span className="text-amber-500 flex-shrink-0">•</span>{lim}
                      </li>
                    ))}
                  </ul>
                </div>
              </SectionBlock>
            )}

            {/* Critical Appraisal */}
            <SectionBlock title="Critical Appraisal" color="text-rose-600">
              <Field label="Evidence Grade"    value={`${summary.critical_appraisal.evidence_grade} — ${summary.critical_appraisal.evidence_grade_justification}`} />
              <Field label="Selection Bias"    value={summary.critical_appraisal.selection_bias} />
              <Field label="Measurement Bias"  value={summary.critical_appraisal.measurement_bias} />
              <Field label="Confounding"       value={summary.critical_appraisal.confounding} />
              <Field label="Attrition"         value={summary.critical_appraisal.attrition} />
              <Field label="External Validity" value={summary.critical_appraisal.external_validity} />
              {summary.critical_appraisal.methodological_strengths.length > 0 && (
                <div className="py-2 px-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Strengths</p>
                  <TagList items={summary.critical_appraisal.methodological_strengths} cls="bg-emerald-50 text-emerald-700 border-emerald-200" />
                </div>
              )}
            </SectionBlock>

            {/* Writing Evidence — sentence bank */}
            {summary.sentence_bank && summary.sentence_bank.length > 0 && (
              <div className="mb-6">
                <h4 className="text-xs font-bold uppercase tracking-widest mb-3 text-indigo-600">
                  Writing Evidence ({summary.sentence_bank.length} statement{summary.sentence_bank.length === 1 ? '' : 's'})
                </h4>
                <div className="space-y-2">
                  {summary.sentence_bank.map((sentence, i) => (
                    <div key={i} className="rounded-xl border border-slate-100 bg-white px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="inline-flex items-center justify-center min-w-[22px] h-5 rounded-full border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-600">
                          {i + 1}
                        </span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${
                          sentence.importance === 'high' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-slate-50 text-slate-600 border-slate-200'
                        }`}>
                          {sentence.importance}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                          {sentence.use_in}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-violet-50 text-violet-700 border-violet-200">
                          {SECTION_LABELS[sentence.section] ?? sentence.section}
                        </span>
                      </div>
                      <p className="text-sm text-slate-700 leading-relaxed">{sentence.text}</p>
                      {sentence.stats && sentence.stats !== 'NR' && (
                        <p className="mt-1 text-[11px] font-mono text-slate-500">{sentence.stats}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bibliography */}
            <SectionBlock title="Bibliography" color="text-slate-600">
              <Field label="Authors" value={summary.bibliography.authors.join('; ') || undefined} />
              <Field label="Journal" value={summary.bibliography.journal} />
              <Field label="Year"    value={summary.bibliography.year?.toString()} />
              <Field label="Volume / Issue" value={[summary.bibliography.volume, summary.bibliography.issue].filter(Boolean).join(' / ') || undefined} />
              <Field label="Pages"   value={summary.bibliography.pages} />
              <Field label="DOI"     value={summary.bibliography.doi} />
              <Field label="PMID"    value={summary.bibliography.pmid} />
            </SectionBlock>

            {/* Extraction confidence */}
            {summary.confidence.notes && summary.confidence.notes !== 'NR' && (
              <p className="text-xs text-slate-400 italic pt-3 border-t border-slate-100">
                Extraction confidence {Math.round(summary.confidence.overall * 100)}%: {summary.confidence.notes}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
