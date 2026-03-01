import type { Paper } from '../../types/paper';

interface Props {
  papers: Paper[];
}

// ── BibTeX ────────────────────────────────────────────────────────────────────

function formatAuthorsForBib(authors: string[]): string {
  // BibTeX uses " and " as the separator between authors.
  return authors
    .map((a) => {
      // Authors stored as "Last, First" — BibTeX wants "Last, First"
      return a;
    })
    .join(' and ');
}

function generateBibKey(paper: Paper, index: number): string {
  const firstAuthorLast = paper.authors[0]?.split(',')[0]?.trim().replace(/\s+/g, '') || 'Unknown';
  const year = paper.year ?? 'nd';
  const titleWord = paper.title.split(' ')[0].replace(/[^a-zA-Z]/g, '') || 'article';
  return `${firstAuthorLast}${year}${titleWord}${index}`;
}

function paperToBibTeX(paper: Paper, index: number): string {
  const key = generateBibKey(paper, index);
  const lines: string[] = [`@article{${key},`];

  lines.push(`  title     = {${paper.title}},`);

  if (paper.authors.length > 0) {
    lines.push(`  author    = {${formatAuthorsForBib(paper.authors)}},`);
  }
  if (paper.year) lines.push(`  year      = {${paper.year}},`);
  if (paper.journal) lines.push(`  journal   = {${paper.journal}},`);
  if (paper.doi) lines.push(`  doi       = {${paper.doi}},`);
  if (paper.pmid) lines.push(`  note      = {PMID: ${paper.pmid}},`);

  lines.push(`}`);
  return lines.join('\n');
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExportButtons({ papers }: Props) {
  function exportBibTeX() {
    const bib = papers.map((p, i) => paperToBibTeX(p, i)).join('\n\n');
    downloadBlob(bib, 'references.bib', 'text/plain;charset=utf-8');
  }

  function exportCSV() {
    const header = ['Title', 'Authors', 'Year', 'Journal', 'DOI', 'PMID', 'Citation Count', 'OA PDF', 'Source'];
    const rows = papers.map((p) => [
      `"${p.title.replace(/"/g, '""')}"`,
      `"${p.authors.join('; ').replace(/"/g, '""')}"`,
      p.year ?? '',
      `"${(p.journal ?? '').replace(/"/g, '""')}"`,
      p.doi ?? '',
      p.pmid ?? '',
      p.citation_count ?? '',
      p.oa_pdf_url ?? '',
      p.source,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    downloadBlob(csv, 'references.csv', 'text/csv;charset=utf-8');
  }

  if (papers.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 mr-1">Export:</span>

      <button
        onClick={exportBibTeX}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200
          bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300
          transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
        .bib
      </button>

      <button
        onClick={exportCSV}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200
          bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300
          transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
        .csv
      </button>
    </div>
  );
}
