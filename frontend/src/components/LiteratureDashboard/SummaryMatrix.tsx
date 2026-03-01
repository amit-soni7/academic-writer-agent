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

interface Props {
  papers: Paper[];
  summaries: Record<string, PaperSummary>;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function paperKey(p: Paper) {
  return (p.doi || p.title.slice(0, 60)).toLowerCase().trim();
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
  const cols = ['#', 'Authors (Year)', 'Study Design', 'N', 'Main Finding', 'Effect / Stats', 'Evidence Grade', 'Takeaway'];
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
    const r0 = s.results[0];
    const statParts = [r0?.effect_size, r0?.ci_95, r0?.p_value].filter(x => x && x !== 'NR');
    const cells = [
      String(n),
      `${firstAuthor} (${year})`.replace(/\|/g, '\\|'),
      (s.methods.study_design ?? '—').replace(/\|/g, '\\|').slice(0, 30),
      s.methods.sample_n ?? '—',
      (r0?.finding ?? '—').replace(/\|/g, '\\|').slice(0, 120),
      statParts.join('; ').replace(/\|/g, '\\|').slice(0, 60) || '—',
      s.critical_appraisal.evidence_grade,
      (s.one_line_takeaway ?? '').replace(/\|/g, '\\|').slice(0, 100),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  downloadBlob(lines.join('\n'), 'evidence_table.md', 'text/markdown;charset=utf-8;');
}

// ── component ──────────────────────────────────────────────────────────────────

export default function SummaryMatrix({ papers, summaries }: Props) {
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
        <table className="w-full text-xs border-collapse min-w-[1200px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {['#', 'Authors (Year)', 'Study Design', 'N', 'Main Finding',
                'Effect / Stats', 'Evidence Grade', 'One-line Takeaway'].map(h => (
                <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summarisedPapers.map((p, i) => {
              const s  = summaries[paperKey(p)]!;
              const r0 = s.results[0];
              const authors = s.bibliography.authors;
              const firstAuthor = authors.length ? authors[0] : 'Unknown';
              const year = s.bibliography.year ?? 'n.d.';
              const statParts = [r0?.effect_size, r0?.ci_95, r0?.p_value].filter(x => x && x !== 'NR');
              const grade = s.critical_appraisal.evidence_grade;

              return (
                <tr key={paperKey(p)}
                  className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors align-top">

                  <td className="px-3 py-2.5 text-slate-400 tabular-nums text-right w-6">{i + 1}</td>

                  <td className="px-3 py-2.5 max-w-[160px]">
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

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 font-medium">
                      {s.methods.study_design !== 'NR' ? s.methods.study_design : s.triage.category}
                    </span>
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap text-slate-600 tabular-nums">
                    {s.methods.sample_n !== 'NR' ? s.methods.sample_n : <span className="text-slate-300">—</span>}
                  </td>

                  <td className="px-3 py-2.5 max-w-[220px]">
                    <p className="text-slate-700 leading-snug line-clamp-3" title={r0?.finding ?? ''}>
                      {r0?.finding ?? <span className="text-slate-300">—</span>}
                    </p>
                  </td>

                  <td className="px-3 py-2.5 max-w-[160px]">
                    {statParts.length > 0 ? (
                      <p className="text-slate-600 leading-snug font-mono text-[11px]"
                         title={statParts.join(' | ')}>
                        {statParts.join(' | ').slice(0, 80)}
                      </p>
                    ) : (
                      <span className="text-slate-300 font-sans">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className={`px-2 py-0.5 rounded-full border font-medium ${gradeCls(grade)}`}>
                      {grade}
                    </span>
                  </td>

                  <td className="px-3 py-2.5 max-w-[200px]">
                    <p className="text-slate-700 italic leading-snug line-clamp-2"
                       title={s.one_line_takeaway}>
                      {s.one_line_takeaway}
                    </p>
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
