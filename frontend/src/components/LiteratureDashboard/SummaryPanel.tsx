import type { CriticalSummary } from '../../types/paper';

interface Props {
  summary: CriticalSummary;
}

function Section({ title, items, accent }: { title: string; items: string[]; accent: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className={`text-xs font-semibold uppercase tracking-widest mb-3 ${accent}`}>{title}</h3>
      <ul className="space-y-2">
        {items.map((point, i) => (
          <li key={i} className="flex items-start gap-3 text-sm text-slate-700 leading-relaxed">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${accent.replace('text-', 'bg-')}`} />
            {point}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SummaryPanel({ summary }: Props) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center">
          <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Critical Summary</h2>
          <p className="text-xs text-slate-400 mt-0.5">Structured extraction · Phase 3 will add LLM synthesis</p>
        </div>
      </div>

      <div className="p-6 space-y-7">
        <Section
          title="Core Points"
          items={summary.core_points}
          accent="text-brand-600"
        />
        <Section
          title="New Data Explained"
          items={summary.new_data_explained}
          accent="text-emerald-600"
        />

        {/* Cross-references */}
        {summary.cross_references.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-amber-600 mb-3">
              Cross-References
            </h3>
            <div className="space-y-2">
              {summary.cross_references.map((ref, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg bg-slate-50 border border-slate-100 p-3">
                  <span className="text-xs text-slate-400 font-mono tabular-nums mt-0.5 w-5 flex-shrink-0">
                    [{i + 1}]
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700 font-medium truncate">{ref.paper_title}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{ref.relevance}</p>
                    {ref.doi && (
                      <a
                        href={`https://doi.org/${ref.doi}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand-600 hover:text-brand-700 underline underline-offset-2 mt-0.5 inline-block"
                      >
                        doi:{ref.doi}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
