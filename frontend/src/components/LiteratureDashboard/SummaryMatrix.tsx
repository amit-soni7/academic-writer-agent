/**
 * SummaryMatrix
 *
 * Shows all completed summaries as a wide evidence-table (systematic-review style).
 * Columns: #, Citation, Study Design, N, Main Finding, Effect / Stats,
 *          Evidence Grade, One-line Takeaway
 *
 * Export buttons: CSV (full nested fields) | Markdown table
 */
import type { Paper, PaperSummary } from '../../types/paper';
import { projectPaperPdfUrl } from '../../api/projects';

interface Props {
  papers: Paper[];
  summaries: Record<string, PaperSummary>;
  projectId?: string;
}

const WRITING_LIMITER_LABELS: Record<string, string> = {
  abstract_only: 'Abstract only',
  no_text_available: 'No text available',
  sparse_quantitative_findings: 'Sparse quantitative findings',
  limited_traceable_claims: 'Limited traceable claims',
  low_topic_overlap: 'Low topic overlap',
  high_redundancy_removed: 'High redundancy removed',
};

const SECTION_LABELS: Record<string, string> = {
  background: 'Background',
  methods: 'Methods',
  results: 'Results',
  discussion: 'Discussion',
  conclusion: 'Conclusion',
};

// ── helpers ────────────────────────────────────────────────────────────────────

function paperKey(p: Paper) {
  return (p.doi || p.title.slice(0, 60)).toLowerCase().trim();
}

function paperPdfHref(paper: Paper, projectId?: string): string {
  if (projectId) {
    return projectPaperPdfUrl(projectId, paperKey(paper));
  }
  if (paper.oa_pdf_url) return paper.oa_pdf_url;
  if (paper.doi) return `https://doi.org/${paper.doi}`;
  return '';
}

function mainFinding(summary: PaperSummary): string {
  const firstResult = summary.results.find((item) => item.finding && item.finding !== 'NR');
  if (firstResult?.finding) return firstResult.finding;
  const topSentence = summary.sentence_bank?.find((item) => item.importance === 'high' && item.text)
    || summary.sentence_bank?.find((item) => item.text);
  if (topSentence?.text) return topSentence.text;
  return summary.one_line_takeaway || '';
}

function statsSummary(summary: PaperSummary): string {
  const result = summary.results.find((item) => item.effect_size !== 'NR' || item.ci_95 !== 'NR' || item.p_value !== 'NR');
  if (!result) return '';
  return [result.effect_size, result.ci_95, result.p_value].filter((item) => item && item !== 'NR').join(' | ');
}

function compactList(items: string[], maxItems = 2): string {
  return items.filter(Boolean).slice(0, maxItems).join('; ');
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

function sectionMixLabel(summary: PaperSummary): string {
  const labels = getWritingEvidenceMeta(summary).dominant_sections
    .map((section) => SECTION_LABELS[section] ?? section)
    .filter(Boolean);
  return labels.length ? `${labels.join(' + ')} dominant` : '';
}

function limiterLabels(summary: PaperSummary): string[] {
  return getWritingEvidenceMeta(summary).limiting_factors
    .map((factor) => WRITING_LIMITER_LABELS[factor] ?? factor.replace(/_/g, ' '))
    .filter(Boolean);
}

function escCsv(v: string | null | undefined): string {
  const s = (v ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// CSV field definitions using the new nested structure
const CSV_FIELDS: Array<{ header: string; get: (s: PaperSummary) => string | null | undefined }> = [
  { header: 'Paper Key',                  get: s => s.paper_key },
  { header: 'Text Source',                get: s => s.text_source },
  // Triage
  { header: 'Category',                   get: s => s.triage.category },
  { header: 'Context',                    get: s => s.triage.context },
  { header: 'Decision',                   get: s => s.triage.decision },
  { header: 'Decision Reason',            get: s => s.triage.decision_reason },
  { header: 'Clarity (1-5)',              get: s => String(s.triage.clarity_score_1_5) },
  { header: 'Contributions',              get: s => s.triage.contributions.join('; ') },
  { header: 'Correctness Flags',          get: s => s.triage.correctness_flags.join('; ') },
  // Bibliography
  { header: 'Authors',                    get: s => s.bibliography.authors.join('; ') },
  { header: 'Year',                       get: s => s.bibliography.year?.toString() },
  { header: 'Journal',                    get: s => s.bibliography.journal },
  { header: 'DOI',                        get: s => s.bibliography.doi },
  { header: 'PMID',                       get: s => s.bibliography.pmid },
  // Methods
  { header: 'Study Design',               get: s => s.methods.study_design },
  { header: 'Setting',                    get: s => s.methods.setting },
  { header: 'Sample N',                   get: s => s.methods.sample_n },
  { header: 'Inclusion Criteria',         get: s => s.methods.inclusion_criteria },
  { header: 'Exclusion Criteria',         get: s => s.methods.exclusion_criteria },
  { header: 'Intervention / Exposure',    get: s => s.methods.intervention_or_exposure },
  { header: 'Comparator',                 get: s => s.methods.comparator },
  { header: 'Primary Outcomes',           get: s => s.methods.primary_outcomes.join('; ') },
  { header: 'Secondary Outcomes',         get: s => s.methods.secondary_outcomes.join('; ') },
  { header: 'Statistical Methods',        get: s => s.methods.statistical_methods.join('; ') },
  { header: 'Funding',                    get: s => s.methods.funding },
  { header: 'COI',                        get: s => s.methods.conflicts_of_interest },
  { header: 'Preregistration',            get: s => s.methods.preregistration },
  // Results (first result)
  { header: 'Primary Outcome Name',       get: s => s.results[0]?.outcome },
  { header: 'Primary Finding',            get: s => s.results[0]?.finding },
  { header: 'Effect Size',                get: s => s.results[0]?.effect_size },
  { header: '95% CI',                     get: s => s.results[0]?.ci_95 },
  { header: 'p-value',                    get: s => s.results[0]?.p_value },
  { header: 'Claim Type',                 get: s => s.results[0]?.claim_type },
  { header: 'All Results (summary)',      get: s => s.results.map(r => `${r.outcome}: ${r.finding} (${r.effect_size}; ${r.ci_95}; ${r.p_value})`).join(' | ') },
  // Limitations
  { header: 'Limitations',                get: s => s.limitations.join('; ') },
  // Critical Appraisal
  { header: 'Evidence Grade',             get: s => s.critical_appraisal.evidence_grade },
  { header: 'Grade Justification',        get: s => s.critical_appraisal.evidence_grade_justification },
  { header: 'Selection Bias',             get: s => s.critical_appraisal.selection_bias },
  { header: 'Measurement Bias',           get: s => s.critical_appraisal.measurement_bias },
  { header: 'Confounding',                get: s => s.critical_appraisal.confounding },
  { header: 'Attrition',                  get: s => s.critical_appraisal.attrition },
  { header: 'External Validity',          get: s => s.critical_appraisal.external_validity },
  { header: 'Methodological Strengths',   get: s => s.critical_appraisal.methodological_strengths.join('; ') },
  { header: 'Reproducibility Signals',    get: s => s.critical_appraisal.reproducibility_signals.join('; ') },
  // Misc
  { header: 'Missing Info',               get: s => s.missing_info.join('; ') },
  { header: 'Confidence Score',           get: s => s.confidence.overall.toFixed(2) },
  { header: 'Confidence Notes',           get: s => s.confidence.notes },
  { header: 'One-line Takeaway',          get: s => s.one_line_takeaway },
  { header: 'Keywords',                   get: s => s.keywords.join('; ') },
  { header: 'Writing Evidence Count',     get: s => String(getWritingEvidenceMeta(s).selected_count) },
  { header: 'Writing Evidence Sections',  get: s => getWritingEvidenceMeta(s).dominant_sections.join('; ') },
  { header: 'Writing Evidence Limiters',  get: s => getWritingEvidenceMeta(s).limiting_factors.join('; ') },
];

const GRADE_CLS: Record<string, string> = {
  High:      'bg-emerald-50 text-emerald-700 border-emerald-200',
  Moderate:  'bg-blue-50 text-blue-700 border-blue-200',
  Low:       'bg-amber-50 text-amber-700 border-amber-200',
  'Very Low':'bg-rose-50 text-rose-700 border-rose-200',
};
function gradeCls(grade: string) {
  return GRADE_CLS[grade] ?? GRADE_CLS.Low;
}

// ── export helpers ─────────────────────────────────────────────────────────────

function exportCsv(papers: Paper[], summaries: Record<string, PaperSummary>) {
  const rows: string[] = [CSV_FIELDS.map(f => escCsv(f.header)).join(',')];
  for (const p of papers) {
    const s = summaries[paperKey(p)];
    if (!s) continue;
    rows.push(CSV_FIELDS.map(f => escCsv(f.get(s))).join(','));
  }
  downloadBlob(rows.join('\r\n'), 'evidence_extraction.csv', 'text/csv;charset=utf-8;');
}

function exportMarkdown(papers: Paper[], summaries: Record<string, PaperSummary>) {
  const cols = ['#', 'Paper', 'Study / Source', 'Sample / Setting', 'Main Finding', 'Effect / Stats', 'Evidence / Decision', 'Takeaway'];
  const sep  = cols.map(() => '---');
  const lines: string[] = [
    `| ${cols.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
  ];
  let n = 0;
  for (const p of papers) {
    const s = summaries[paperKey(p)];
    if (!s) continue;
    n++;
    const authors = s.bibliography.authors;
    const firstAuthor = authors.length ? authors[0] : 'Unknown';
    const year = s.bibliography.year ?? 'n.d.';
    const finding = mainFinding(s);
    const statText = statsSummary(s);
    const cells = [
      String(n),
      `${p.title} — ${firstAuthor} (${year})`.replace(/\|/g, '\\|').slice(0, 110),
      `${s.methods.study_design || '—'}; ${s.text_source}`.replace(/\|/g, '\\|').slice(0, 60),
      `${s.methods.sample_n || '—'}; ${(s.methods.setting || '—')}`.replace(/\|/g, '\\|').slice(0, 80),
      (finding || '—').replace(/\|/g, '\\|').slice(0, 140),
      (statText || '—').replace(/\|/g, '\\|').slice(0, 70),
      `${s.critical_appraisal.evidence_grade}; ${s.triage.decision}`.replace(/\|/g, '\\|'),
      (s.one_line_takeaway ?? '').replace(/\|/g, '\\|').slice(0, 100),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  downloadBlob(lines.join('\n'), 'evidence_table.md', 'text/markdown;charset=utf-8;');
}

// ── component ──────────────────────────────────────────────────────────────────

export default function SummaryMatrix({ papers, summaries, projectId }: Props) {
  const summarisedPapers = papers.filter(p => summaries[paperKey(p)]);

  if (summarisedPapers.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm">
        No summaries yet. Use "Summarise All" or click "Analyse" on individual papers.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{summarisedPapers.length}</span> papers analysed
          {papers.length > summarisedPapers.length && (
            <span className="text-slate-400"> · {papers.length - summarisedPapers.length} pending</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => exportCsv(papers, summaries)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200
              text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV ({CSV_FIELDS.length} fields)
          </button>
          <button
            onClick={() => exportMarkdown(papers, summaries)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200
              text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export Markdown
          </button>
        </div>
      </div>

      {/* Evidence table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs border-collapse min-w-[1800px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {['#', 'Paper', 'Study / Source', 'Sample / Setting', 'Outcomes / Exposure', 'Main Finding',
                'Effect / Stats', 'Evidence / Decision', 'Limitations', 'One-line Takeaway', 'Writing Evidence', 'Paper PDF'].map(h => (
                <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summarisedPapers.map((p, i) => {
              const s  = summaries[paperKey(p)]!;
              const authors = s.bibliography.authors;
              const firstAuthor = authors.length ? authors[0] : 'Unknown';
              const year = s.bibliography.year ?? 'n.d.';
              const grade = s.critical_appraisal.evidence_grade;
              const finding = mainFinding(s);
              const statText = statsSummary(s);
              const pdfHref = paperPdfHref(p, projectId);
              const writingMeta = getWritingEvidenceMeta(s);
              const sentenceCount = writingMeta.selected_count;
              const sectionMix = sectionMixLabel(s);
              const limiters = limiterLabels(s);
              const outcomeSummary = compactList(s.methods.primary_outcomes, 2)
                || compactList(s.methods.secondary_outcomes, 2)
                || s.methods.intervention_or_exposure
                || '—';
              const limitations = compactList(s.limitations, 2) || '—';

              return (
                <tr key={paperKey(p)}
                  className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors align-top">

                  <td className="px-3 py-2.5 text-slate-400 tabular-nums text-right w-6">{i + 1}</td>

                  <td className="px-3 py-2.5 min-w-[260px] max-w-[320px]">
                    <p className="font-semibold text-slate-800 leading-snug" title={p.title}>
                      {p.title}
                    </p>
                    <p className="font-medium text-slate-800 leading-snug">
                      {firstAuthor} ({year})
                    </p>
                    {authors.length > 1 && (
                      <p className="text-slate-400 text-[10px] mt-0.5">et al.</p>
                    )}
                    {s.bibliography.journal && (
                      <p className="text-slate-500 text-[10px] mt-0.5 italic line-clamp-1"
                         title={s.bibliography.journal}>
                        {s.bibliography.journal}
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-2.5 min-w-[190px] max-w-[220px]">
                    <div className="space-y-1.5">
                      <span className="inline-flex px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 font-medium">
                        {s.methods.study_design !== 'NR' ? s.methods.study_design : s.triage.category}
                      </span>
                      <div className="text-[11px] text-slate-500 space-y-1">
                        <p>Source: {s.text_source}</p>
                        <p>Category: {s.triage.category || '—'}</p>
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 min-w-[220px] max-w-[260px]">
                    <p className="text-slate-700 leading-snug">
                      {s.methods.sample_n !== 'NR' ? s.methods.sample_n : <span className="text-slate-300">—</span>}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500 leading-snug" title={s.methods.setting}>
                      {s.methods.setting && s.methods.setting !== 'NR' ? s.methods.setting : 'Setting not reported'}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 min-w-[220px] max-w-[280px]">
                    <p className="text-slate-700 leading-snug" title={outcomeSummary}>
                      {outcomeSummary}
                    </p>
                    {s.methods.intervention_or_exposure && s.methods.intervention_or_exposure !== 'NR' && (
                      <p className="mt-1 text-[11px] text-slate-500 leading-snug line-clamp-2" title={s.methods.intervention_or_exposure}>
                        {s.methods.intervention_or_exposure}
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-2.5 min-w-[260px] max-w-[320px]">
                    <p className="text-slate-700 leading-snug line-clamp-4" title={finding}>
                      {finding || <span className="text-slate-300">—</span>}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 min-w-[180px] max-w-[220px]">
                    {statText ? (
                      <p className="text-slate-600 leading-snug font-mono text-[11px]"
                         title={statText}>
                        {statText}
                      </p>
                    ) : (
                      <span className="text-slate-300 font-sans">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2.5 min-w-[160px]">
                    <div className="space-y-1.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-full border font-medium ${gradeCls(grade)}`}>
                        {grade}
                      </span>
                      <span className="inline-flex px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200 font-medium">
                        {s.triage.decision}
                      </span>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 min-w-[220px] max-w-[260px]">
                    <p className="text-slate-700 leading-snug line-clamp-4" title={limitations}>
                      {limitations}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 min-w-[220px] max-w-[260px]">
                    <p className="text-slate-700 italic leading-snug line-clamp-2"
                       title={s.one_line_takeaway}>
                      {s.one_line_takeaway}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 min-w-[170px]">
                    <div className="space-y-1.5">
                      <span className="inline-flex px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200 font-medium">
                        {sentenceCount} high-quality statement{sentenceCount === 1 ? '' : 's'}
                      </span>
                      {sectionMix && (
                        <p className="text-[11px] text-slate-500 leading-snug">
                          {sectionMix}
                        </p>
                      )}
                      {limiters.length > 0 && (
                        <p className="text-[11px] text-amber-700 leading-snug">
                          {limiters.join(' • ')}
                        </p>
                      )}
                      {s.sentence_bank?.[0]?.text && (
                        <p className="text-[11px] text-slate-500 leading-snug line-clamp-3" title={s.sentence_bank[0].text}>
                          {s.sentence_bank[0].text}
                        </p>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {pdfHref ? (
                      <a
                        href={pdfHref}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 transition-colors"
                      >
                        Open PDF
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Field legend */}
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-700 select-none">
          All {CSV_FIELDS.length} fields captured per paper (click to expand)
        </summary>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-1.5 pl-2">
          {CSV_FIELDS.map(f => (
            <span key={f.header} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0" />
              {f.header}
            </span>
          ))}
        </div>
      </details>
    </div>
  );
}
