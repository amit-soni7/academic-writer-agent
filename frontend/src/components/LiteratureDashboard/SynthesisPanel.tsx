/**
 * SynthesisPanel
 *
 * Shows cross-paper synthesis results in five tabs:
 *   Evidence Matrix | Methods Comparison | Contradictions | Gaps | Fact Bank
 */
import { useState } from 'react';
import type { SynthesisResult } from '../../types/paper';

interface Props {
  result: SynthesisResult;
}

const CONSISTENCY_CLS: Record<string, string> = {
  high:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  moderate:'bg-blue-50 text-blue-700 border-blue-200',
  low:     'bg-amber-50 text-amber-700 border-amber-200',
  mixed:   'bg-violet-50 text-violet-700 border-violet-200',
  unknown: 'bg-slate-50 text-slate-500 border-slate-200',
};

function StrengthBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-100 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-500 w-7 text-right">{pct}%</span>
    </div>
  );
}

type Tab = 'matrix' | 'methods' | 'contradictions' | 'gaps' | 'factbank';

export default function SynthesisPanel({ result }: Props) {
  const [tab, setTab] = useState<Tab>('matrix');
  const [factFilter, setFactFilter] = useState('');

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'matrix',        label: 'Evidence Matrix',     count: result.evidence_matrix.length },
    { id: 'methods',       label: 'Methods',             count: result.methods_comparison.length },
    { id: 'contradictions',label: 'Contradictions',      count: result.contradictions.length },
    { id: 'gaps',          label: 'Gaps',                count: result.gaps.length },
    { id: 'factbank',      label: 'Fact Bank',           count: result.fact_bank.length },
  ];

  const filteredFacts = factFilter.trim()
    ? result.fact_bank.filter(f =>
        f.fact.toLowerCase().includes(factFilter.toLowerCase()) ||
        f.paper_key.toLowerCase().includes(factFilter.toLowerCase())
      )
    : result.fact_bank;

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 flex-wrap border-b border-slate-200 pb-0">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-xs font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
              tab === t.id
                ? 'border-brand-500 text-brand-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                tab === t.id ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Evidence Matrix ─────────────────────────────────────────────────── */}
      {tab === 'matrix' && (
        <div className="space-y-3">
          {result.evidence_matrix.length === 0 ? (
            <p className="text-sm text-slate-400 italic py-4 text-center">No evidence matrix generated.</p>
          ) : result.evidence_matrix.map((claim, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-4 bg-white space-y-2">
              <p className="text-sm font-semibold text-slate-800 leading-snug">{claim.claim}</p>
              <StrengthBar score={claim.strength_score} />
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${CONSISTENCY_CLS[claim.consistency] ?? CONSISTENCY_CLS.unknown}`}>
                  {claim.consistency} consistency
                </span>
                {claim.study_designs.map((d, j) => (
                  <span key={j} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
                    {d}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {claim.supporting_papers.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide mb-1">Supporting</p>
                    <div className="space-y-0.5">
                      {claim.supporting_papers.map((p, j) => (
                        <span key={j} className="inline-block text-[10px] font-mono text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded mr-1">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {claim.contradicting_papers.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-rose-600 uppercase tracking-wide mb-1">Contradicting</p>
                    <div className="space-y-0.5">
                      {claim.contradicting_papers.map((p, j) => (
                        <span key={j} className="inline-block text-[10px] font-mono text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded mr-1">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Methods Comparison ──────────────────────────────────────────────── */}
      {tab === 'methods' && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Paper', 'N', 'Tools / Instruments', 'Outcomes', 'Stats', 'Risk of Bias'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.methods_comparison.map((row, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 align-top">
                  <td className="px-3 py-2.5 font-mono text-slate-700 text-[10px] max-w-[120px]">
                    <span className="line-clamp-2" title={row.paper_key}>{row.paper_key}</span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{row.sample_n || '—'}</td>
                  <td className="px-3 py-2.5 max-w-[140px]">
                    <div className="flex flex-wrap gap-1">
                      {row.tools.length ? row.tools.map((t, j) => (
                        <span key={j} className="text-[10px] px-1.5 py-0.5 bg-teal-50 text-teal-700 border border-teal-200 rounded">
                          {t}
                        </span>
                      )) : <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 max-w-[160px]">
                    {row.outcomes.length ? (
                      <ul className="space-y-0.5">
                        {row.outcomes.map((o, j) => (
                          <li key={j} className="text-slate-600 leading-snug">• {o}</li>
                        ))}
                      </ul>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5 max-w-[120px]">
                    <div className="flex flex-wrap gap-1">
                      {row.stats.length ? row.stats.map((s, j) => (
                        <span key={j} className="text-[10px] px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded">
                          {s}
                        </span>
                      )) : <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 max-w-[180px]">
                    <p className="text-slate-600 leading-snug line-clamp-3" title={row.risk_of_bias}>
                      {row.risk_of_bias || <span className="text-slate-300">—</span>}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Contradictions ──────────────────────────────────────────────────── */}
      {tab === 'contradictions' && (
        <div className="space-y-3">
          {result.contradictions.length === 0 ? (
            <p className="text-sm text-slate-400 italic py-4 text-center">
              No contradictions detected across the corpus.
            </p>
          ) : result.contradictions.map((c, i) => (
            <div key={i} className="rounded-xl border border-amber-200 bg-amber-50/30 p-4 space-y-3">
              <p className="text-sm font-semibold text-amber-900">{c.topic}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-white border border-slate-200 p-3">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    Position A — {c.papers_a.join(', ')}
                  </p>
                  <p className="text-xs text-slate-700 leading-relaxed">{c.finding_a}</p>
                </div>
                <div className="rounded-lg bg-white border border-slate-200 p-3">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    Position B — {c.papers_b.join(', ')}
                  </p>
                  <p className="text-xs text-slate-700 leading-relaxed">{c.finding_b}</p>
                </div>
              </div>
              {c.likely_reason && (
                <div className="flex gap-2 text-xs text-amber-800 bg-amber-100 rounded-lg px-3 py-2">
                  <span className="flex-shrink-0 font-semibold">Likely reason:</span>
                  <span>{c.likely_reason}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Gaps ────────────────────────────────────────────────────────────── */}
      {tab === 'gaps' && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500 mb-3">
            Evidence gaps identified — areas where the current corpus provides no answer.
          </p>
          {result.gaps.length === 0 ? (
            <p className="text-sm text-slate-400 italic py-4 text-center">No gaps identified.</p>
          ) : result.gaps.map((gap, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <p className="text-sm text-slate-700 leading-relaxed">{gap}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Fact Bank ───────────────────────────────────────────────────────── */}
      {tab === 'factbank' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={factFilter}
              onChange={(e) => setFactFilter(e.target.value)}
              placeholder="Filter facts…"
              className="flex-1 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm
                focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
            />
            <span className="text-xs text-slate-400 whitespace-nowrap">
              {filteredFacts.length} / {result.fact_bank.length}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Only facts with direct verbatim quote support. Safe to cite in manuscript.
          </p>
          {filteredFacts.map((entry, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
              <div className="flex items-start gap-3">
                <span className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full border font-medium mt-0.5 ${
                  entry.claim_type === 'reported_fact'
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-violet-50 text-violet-700 border-violet-200'
                }`}>
                  {entry.claim_type === 'reported_fact' ? 'Fact' : 'Author interp.'}
                </span>
                <p className="text-sm font-medium text-slate-800 leading-snug">{entry.fact}</p>
              </div>
              {entry.verbatim_quote && (
                <blockquote className="ml-2 pl-3 border-l-2 border-slate-300 text-xs text-slate-500 italic leading-relaxed">
                  "{entry.verbatim_quote}"
                </blockquote>
              )}
              <p className="text-[10px] font-mono text-slate-400 ml-2">
                Source: {entry.paper_key}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
