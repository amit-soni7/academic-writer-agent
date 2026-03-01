/**
 * JournalsDashboard — Phase 4
 *
 * Loads session → recommends journals → user selects one → go to Phase 5 (Write).
 * Displays impact factor, PubMed/Scopus indexing, APC, and ONOS support.
 */
import { useEffect, useState } from 'react';
import type { JournalRecommendation, JournalStyle } from '../../types/paper';
import { recommendJournals, getJournalStyle } from '../../api/projects';
import LoadingLottie from '../LoadingLottie';

interface Props {
  sessionId: string;
  onBack: () => void;
  onGoToWrite: (sessionId: string, journal: string) => void;
  onOpenSettings: () => void;
}

// ── Small display helpers ─────────────────────────────────────────────────────

function Pill({
  label, value, className,
}: { label: string; value: string | number | null; className?: string }) {
  if (value == null) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium
      ${className ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
      <span className="opacity-60">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function IndexBadge({ label, indexed }: { label: string; indexed: boolean | null }) {
  if (indexed === null) return null;
  return indexed ? (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium
      bg-blue-50 text-blue-700 border-blue-200">
      <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
      {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium
      bg-slate-50 text-slate-400 border-slate-200">
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
      {label}
    </span>
  );
}

function ApcDisplay({ j }: { j: JournalRecommendation }) {
  // Decide what to show
  if (j.onos_supported) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium
        bg-violet-50 text-violet-700 border-violet-200">
        APC Waived · ONOS
      </span>
    );
  }
  if (j.apc_usd != null) {
    const label = j.apc_usd === 0 ? 'APC Free' : `APC $${j.apc_usd.toLocaleString()}`;
    const cls = j.apc_usd === 0
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>
        {label}
      </span>
    );
  }
  if (j.apc_note) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium
        bg-slate-50 text-slate-500 border-slate-200">
        {j.apc_note}
      </span>
    );
  }
  return null;
}

// ── Citation style badge ──────────────────────────────────────────────────────

function CitationBadge({ style }: { style: JournalStyle }) {
  const low = style.confidence < 0.7;
  const label = `${style.reference_format_name} · ${
    style.in_text_format === 'superscript' ? 'Superscript' :
    style.in_text_format === 'author_year' ? 'Author-Year' : 'Numbered'
  }`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-semibold
        ${low ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-sky-50 text-sky-700 border-sky-200'}`}>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {label}
      </span>
      {style.accepted_article_types.map(t => (
        <span key={t} className="text-[10px] px-2 py-0.5 rounded-full border font-medium
          bg-indigo-50 text-indigo-700 border-indigo-200">
          {t.replace('_', ' ')}
        </span>
      ))}
      {low && (
        <span className="text-[10px] text-amber-600 italic">
          Style inferred — may vary
        </span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function JournalsDashboard({ sessionId, onBack, onGoToWrite, onOpenSettings }: Props) {
  const [journals, setJournals]           = useState<JournalRecommendation[]>([]);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [selected, setSelected]           = useState<string | null>(null);
  const [customJournal, setCustomJournal] = useState('');
  const [journalStyle, setJournalStyle]   = useState<JournalStyle | null>(null);

  async function loadRecommendations() {
    setLoading(true);
    setError(null);
    try {
      const recs = await recommendJournals(sessionId);
      setJournals(recs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recommendations.');
    } finally {
      setLoading(false);
    }
  }

  async function loadJournalStyle(name: string, publisher?: string) {
    try {
      const style = await getJournalStyle(name, publisher);
      setJournalStyle(style);
    } catch {
      setJournalStyle(null);
    }
  }

  useEffect(() => { loadRecommendations(); }, [sessionId]);

  // When a journal is selected, fetch its style
  useEffect(() => {
    if (selected && selected !== '__custom__') {
      const j = journals.find(j => j.name === selected);
      loadJournalStyle(selected, j?.publisher ?? undefined);
    } else if (selected === '__custom__' && customJournal.trim()) {
      loadJournalStyle(customJournal.trim());
    } else {
      setJournalStyle(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, customJournal]);

  const chosenJournal = selected === '__custom__' ? customJournal.trim() : selected;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Literature
            </button>
            <span className="text-slate-300">/</span>
            <span className="font-semibold text-slate-800">Journal Recommendations</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">2 · Search</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">3 · Summarise</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">4 · Journals</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">5 · Write</span>
            </div>
            <button onClick={onOpenSettings}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8 space-y-6">

        {/* ── Action bar ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Select Target Journal</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              AI-ranked journals from your paper corpus — enriched with APC, PubMed, and ONOS data.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadRecommendations} disabled={loading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200
                text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors">
              {loading ? (
                <LoadingLottie className="w-5 h-5" />
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              onClick={() => chosenJournal && onGoToWrite(sessionId, chosenJournal)}
              disabled={!chosenJournal}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold
                text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Write Article →
            </button>
          </div>
        </div>

        {/* ── Error ────────────────────────────────────────────────────────── */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* ── Loading skeleton ─────────────────────────────────────────────── */}
        {loading && !journals.length && (
          <div className="space-y-3">
            <div className="flex justify-center py-2">
              <LoadingLottie className="w-24 h-24" label="Loading journal recommendations..." />
            </div>
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-white rounded-2xl border border-slate-200 p-5 animate-pulse">
                <div className="h-4 bg-slate-100 rounded w-1/3 mb-3" />
                <div className="h-3 bg-slate-100 rounded w-2/3 mb-2" />
                <div className="flex gap-2">
                  <div className="h-5 bg-slate-100 rounded-full w-16" />
                  <div className="h-5 bg-slate-100 rounded-full w-20" />
                  <div className="h-5 bg-slate-100 rounded-full w-24" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Journal cards ────────────────────────────────────────────────── */}
        {!loading && journals.length > 0 && (
          <div className="space-y-3">
            {journals.map((j, idx) => {
              const isSelected = selected === j.name;
              return (
                <button
                  key={j.name}
                  onClick={() => setSelected(isSelected ? null : j.name)}
                  className={`w-full text-left rounded-2xl border-2 p-5 transition-all ${
                    isSelected
                      ? 'border-brand-400 bg-brand-50 shadow-sm'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">

                      {/* Row 1: rank + name (link) + OA/Subscription + corpus frequency + AI suggested */}
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <span className="text-[10px] font-bold text-slate-400">#{idx + 1}</span>
                        {j.website_url ? (
                          <a href={j.website_url} target="_blank" rel="noreferrer"
                             className="font-semibold text-brand-700 text-sm hover:underline"
                             onClick={(e) => e.stopPropagation()}>
                            {j.name}
                          </a>
                        ) : (
                          <h3 className="font-semibold text-slate-800 text-sm">{j.name}</h3>
                        )}
                        {j.open_access === true && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium
                            bg-emerald-50 text-emerald-700 border-emerald-200">
                            Open Access
                          </span>
                        )}
                        {j.open_access === false && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium
                            bg-slate-50 text-slate-500 border-slate-200">
                            Subscription
                          </span>
                        )}
                        {j.frequency_in_results > 0 ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700
                            border border-teal-200 font-medium">
                            {j.frequency_in_results}× in corpus
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700
                            border border-indigo-200 font-medium">
                            AI suggested
                          </span>
                        )}
                        {j.onos_supported && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold
                            bg-violet-100 text-violet-800 border-violet-300">
                            ONOS Supported
                          </span>
                        )}
                      </div>

                      {/* Row 2: publisher */}
                      {j.publisher && (
                        <p className="text-xs text-slate-500 mb-2">{j.publisher}</p>
                      )}

                      {/* Row 3: numeric metrics */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        <Pill
                          label="Impact Factor (est.)"
                          value={j.avg_citations != null ? j.avg_citations.toFixed(2) : null}
                          className="bg-slate-100 text-slate-700 border-slate-200"
                        />
                        <Pill
                          label="h-index"
                          value={j.h_index}
                          className="bg-slate-100 text-slate-600 border-slate-200"
                        />
                        {j.issn && (
                          <Pill
                            label="ISSN"
                            value={j.issn}
                            className="bg-slate-100 text-slate-500 border-slate-200"
                          />
                        )}
                      </div>

                      {/* Row 4: PubMed / Scopus index badges */}
                      {(j.indexed_pubmed !== null || j.indexed_scopus !== null) && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          <IndexBadge label="PubMed" indexed={j.indexed_pubmed} />
                          <IndexBadge label="Scopus"  indexed={j.indexed_scopus} />
                        </div>
                      )}

                      {/* Row 5: APC info */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        <ApcDisplay j={j} />
                      </div>

                      {/* Row 6: scope match note */}
                      {j.scope_match && (
                        <p className="text-xs text-slate-600 leading-relaxed italic">{j.scope_match}</p>
                      )}
                    </div>

                    {/* Selection radio dot */}
                    <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 mt-1 ${
                      isSelected ? 'border-brand-500 bg-brand-500' : 'border-slate-300'
                    }`}>
                      {isSelected && (
                        <svg className="w-full h-full text-white" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                  </div>

                  {j.openalex_url && (
                    <a href={j.openalex_url} target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mt-2 inline-flex items-center gap-1 text-[10px] text-brand-600 hover:underline">
                      OpenAlex →
                    </a>
                  )}
                </button>
              );
            })}

            {/* Custom journal input */}
            <div className={`rounded-2xl border-2 p-5 transition-all ${
              selected === '__custom__'
                ? 'border-brand-400 bg-brand-50'
                : 'border-dashed border-slate-300 bg-white'
            }`}>
              <p className="text-xs font-semibold text-slate-600 mb-2">Enter a different journal</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customJournal}
                  onChange={(e) => {
                    setCustomJournal(e.target.value);
                    if (e.target.value.trim()) setSelected('__custom__');
                    else if (selected === '__custom__') setSelected(null);
                  }}
                  placeholder="Journal name…"
                  className="flex-1 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm
                    focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
                <button
                  onClick={() => { if (customJournal.trim()) setSelected('__custom__'); }}
                  disabled={!customJournal.trim()}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-slate-600
                    hover:bg-slate-700 disabled:opacity-40 transition-all"
                >
                  Use
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Sticky bottom banner when a journal is selected ──────────────── */}
        {chosenJournal && (
          <div className="sticky bottom-4 bg-brand-600 text-white rounded-2xl shadow-lg px-6 py-4
            flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-brand-200 uppercase tracking-wide">Selected journal</p>
              <p className="font-semibold mt-0.5">{chosenJournal}</p>
              {journalStyle && (
                <div className="mt-1.5">
                  <CitationBadge style={journalStyle} />
                </div>
              )}
            </div>
            <button
              onClick={() => onGoToWrite(sessionId, chosenJournal)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold
                bg-white text-brand-700 hover:bg-brand-50 transition-all flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Phase 5 — Write Article →
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
