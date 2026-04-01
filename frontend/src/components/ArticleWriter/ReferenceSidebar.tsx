import { useState, useEffect, useRef, useCallback } from 'react';
import { getCitationStatus } from '../../api/projects';
import type { CitationStatusResponse, CitationStatusSummary, PaperBibliography } from '../../types/paper';

interface Props {
  sessionId: string;
  articleText: string;
  selectedJournal: string;
  highlightedCiteKey: string | null;
  onCiteClick: (paperKey: string | null) => void;
  isOpen: boolean;
  onToggle: () => void;
  writingState: string;
}

type Filter = 'all' | 'resolved' | 'fuzzy_matched' | 'unresolved' | 'uncited';

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function formatAuthors(bib: PaperBibliography): string {
  if (!bib.authors?.length) return 'Unknown';
  if (bib.authors.length === 1) return bib.authors[0];
  if (bib.authors.length === 2) return `${bib.authors[0]} & ${bib.authors[1]}`;
  return `${bib.authors[0]} et al.`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

const ACCENT: Record<string, string> = {
  resolved:      'var(--gold, #3632b7)',
  fuzzy_matched: '#d97706',
  unresolved:    'var(--ember, #ba1a1a)',
};

/* ── Component ───────────────────────────────────────────────────────────── */

export default function ReferenceSidebar({
  sessionId, articleText, selectedJournal,
  highlightedCiteKey, onCiteClick, isOpen, onToggle, writingState,
}: Props) {
  const [data, setData] = useState<CitationStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!articleText.trim() || !sessionId) return;
    setLoading(true);
    try { setData(await getCitationStatus(sessionId, articleText, selectedJournal)); }
    catch { /* silent */ }
    finally { setLoading(false); }
  }, [sessionId, articleText, selectedJournal]);

  useEffect(() => {
    if (writingState === 'running') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetchStatus, 800);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [articleText, fetchStatus, writingState]);

  useEffect(() => {
    if (!highlightedCiteKey || !data) return;
    const el = rowRefs.current[highlightedCiteKey];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [highlightedCiteKey, data]);

  const summary: CitationStatusSummary = data?.summary ?? {
    total: 0, resolved: 0, fuzzy_matched: 0, unresolved: 0, uncited_count: 0, uncited_keys: [],
  };

  const filtered = (data?.citations ?? []).filter(c => {
    if (filter === 'uncited') return false;
    if (filter !== 'all' && c.status !== filter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (c.bibliography?.title?.toLowerCase() ?? '').includes(q)
        || (c.bibliography?.authors?.join(' ').toLowerCase() ?? '').includes(q)
        || c.cited_key.toLowerCase().includes(q);
    }
    return true;
  });

  const cnt = (f: Filter) =>
    f === 'all' ? summary.total
    : f === 'uncited' ? summary.uncited_count
    : summary[f as 'resolved' | 'fuzzy_matched' | 'unresolved'];

  /* ── Closed: render nothing (toggle is in the tab bar) ─────────────── */
  if (!isOpen) return null;

  /* ── Open sidebar (fixed overlay) ────────────────────────────────────── */
  return (
    <div className="fixed right-0 top-0 h-screen flex flex-col z-40"
      style={{
        width: 370,
        background: 'var(--bg-base, #f8f9fa)',
        borderLeft: '1px solid var(--border-faint)',
        boxShadow: '-8px 0 30px rgba(0,0,0,0.03)',
      }}>

      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="px-5 pt-5 pb-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-muted, rgba(199,196,216,0.30))' }}>
        <div className="flex items-center justify-between">
          <h2 style={{ fontFamily: 'Newsreader, Georgia, serif', fontSize: '1.35rem', fontWeight: 600, color: 'var(--text-bright, #191c1d)', letterSpacing: '-0.01em' }}>
            References
          </h2>
          <div className="flex items-center gap-1">
            <button onClick={fetchStatus} disabled={loading}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30"
              style={{ color: 'var(--text-muted)' }}
              title="Refresh">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className={loading ? 'animate-spin' : ''}>
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button onClick={onToggle}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="Collapse">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>

        {/* subtitle stats */}
        <p className="mt-1 text-[11px] font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted, #777587)' }}>
          {summary.total} citations &middot; {summary.resolved} verified
          {summary.fuzzy_matched > 0 && <span style={{ color: '#d97706' }}> &middot; {summary.fuzzy_matched} fuzzy</span>}
          {summary.unresolved > 0 && <span style={{ color: 'var(--ember, #ba1a1a)' }}> &middot; {summary.unresolved} unresolved</span>}
        </p>
      </header>

      {/* ── Filters ──────────────────────────────────────────────────── */}
      <div className="px-5 py-2.5 flex items-center gap-1 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-faint)' }}>
        {(['all', 'resolved', 'fuzzy_matched', 'unresolved', 'uncited'] as Filter[]).map(f => {
          const active = filter === f;
          const label = { all: 'All', resolved: 'Verified', fuzzy_matched: 'Fuzzy', unresolved: 'Issues', uncited: 'Uncited' }[f];
          return (
            <button key={f} onClick={() => setFilter(f)}
              className="px-2.5 py-1 rounded-md text-[10px] font-semibold tracking-wide transition-all"
              style={{
                fontFamily: 'Manrope, sans-serif',
                background: active ? 'var(--gold, #3632b7)' : 'transparent',
                color: active ? '#fff' : 'var(--text-muted, #777587)',
              }}>
              {label} ({cnt(f)})
            </button>
          );
        })}
      </div>

      {/* ── Search ───────────────────────────────────────────────────── */}
      <div className="px-5 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border-faint)' }}>
        <div className="relative">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="text" placeholder="Search by author, title, or key\u2026"
            value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2 text-xs rounded-lg focus:outline-none transition-all"
            style={{
              fontFamily: 'Manrope, sans-serif',
              background: 'var(--bg-surface, #fff)',
              border: '1px solid var(--border-faint)',
              color: 'var(--text-body, #191c1d)',
            }} />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-faint)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Loading ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="px-5 py-2 flex items-center gap-2 flex-shrink-0"
          style={{ background: 'var(--gold-faint, #e2dfff)', borderBottom: '1px solid var(--border-faint)' }}>
          <div className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin"
            style={{ borderColor: 'var(--gold, #3632b7)', borderTopColor: 'transparent' }} />
          <span className="text-[11px] font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #3632b7)' }}>
            Analysing citations\u2026
          </span>
        </div>
      )}

      {/* ── Citation list ────────────────────────────────────────────── */}
      <div ref={listRef} className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        <div className="px-5 py-4 space-y-0">

          {/* Uncited */}
          {filter === 'uncited' && (
            summary.uncited_keys.length === 0
              ? <Empty msg="All papers are cited in the manuscript." />
              : summary.uncited_keys.map((pk, i) => (
                <div key={pk} className="py-4" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <div className="flex items-baseline gap-3">
                    <RefNum n={i + 1} muted />
                    <p className="text-xs italic leading-relaxed" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-muted)' }}>
                      {truncate(pk, 70)}
                    </p>
                  </div>
                </div>
              ))
          )}

          {/* Main list */}
          {filter !== 'uncited' && (
            filtered.length === 0 && !loading
              ? <Empty msg={summary.total === 0 ? 'Citations appear after drafting.' : 'No citations match this filter.'} />
              : filtered.map((entry, idx) => {
                const bib = entry.bibliography;
                const refNum = entry.ref_number ?? (idx + 1);
                const accent = ACCENT[entry.status] ?? 'var(--gold)';
                const isHl = highlightedCiteKey === entry.cited_key;

                return (
                  <div
                    key={entry.cited_key}
                    ref={el => { rowRefs.current[entry.cited_key] = el; }}
                    className="py-5 cursor-pointer transition-colors"
                    style={{
                      borderBottom: '1px solid var(--border-faint)',
                      borderLeft: `3px solid ${accent}`,
                      paddingLeft: 16,
                      marginLeft: -5,
                      background: isHl ? 'var(--gold-faint, #e2dfff)' : undefined,
                    }}
                    onClick={() => onCiteClick(entry.resolved_key || entry.cited_key)}
                  >
                    {bib ? (
                      <>
                        {/* ── Author line ── */}
                        <div className="flex items-baseline justify-between gap-3">
                          <div className="flex items-baseline gap-3 min-w-0">
                            <RefNum n={refNum} />
                            <span className="text-[13px] font-bold uppercase tracking-wide"
                              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #191c1d)', letterSpacing: '0.03em' }}>
                              {formatAuthors(bib)} ({bib.year ?? 'n.d.'})
                            </span>
                          </div>
                          {/* cites badge */}
                          <span className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-[10px] font-semibold tabular-nums"
                              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                              CITES: {entry.occurrences}
                            </span>
                            {entry.status === 'resolved' && (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                style={{ color: 'var(--gold, #3632b7)' }}>
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                              </svg>
                            )}
                          </span>
                        </div>

                        {/* ── Title ── */}
                        <p className="mt-2 leading-relaxed"
                          style={{ fontFamily: 'Newsreader, Georgia, serif', fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--text-secondary, #464555)' }}>
                          &ldquo;{bib.title}&rdquo;
                        </p>

                        {/* ── DOI + section badge row ── */}
                        <div className="flex items-center gap-3 mt-3 flex-wrap">
                          {bib.doi && (
                            <a href={`https://doi.org/${bib.doi}`} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-[10px] font-semibold transition-opacity hover:opacity-70"
                              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #3632b7)' }}
                              onClick={e => e.stopPropagation()}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                              </svg>
                              DOI: {truncate(bib.doi, 22)}
                            </a>
                          )}
                          {bib.pmid && (
                            <a href={`https://pubmed.ncbi.nlm.nih.gov/${bib.pmid}`} target="_blank" rel="noopener noreferrer"
                              className="text-[10px] font-semibold transition-opacity hover:opacity-70"
                              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #3632b7)' }}
                              onClick={e => e.stopPropagation()}>
                              PMID: {bib.pmid}
                            </a>
                          )}
                          {entry.first_section && (
                            <span className="px-2 py-0.5 rounded text-[8px] font-bold tracking-[0.12em] uppercase"
                              style={{
                                fontFamily: 'Manrope, sans-serif',
                                background: 'var(--bg-hover, #e7e8e9)',
                                color: 'var(--text-muted, #777587)',
                              }}>
                              {entry.first_section.replace(/^#+\s*/, '').split(' ').slice(0, 2).join(' ')}
                            </span>
                          )}
                        </div>

                        {/* ── Fuzzy match warning ── */}
                        {entry.status === 'fuzzy_matched' && (
                          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
                            <div className="flex items-center gap-2">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                              </svg>
                              <span className="text-[9px] font-bold tracking-[0.12em] uppercase" style={{ color: '#d97706', fontFamily: 'Manrope, sans-serif' }}>
                                Incomplete Metadata
                              </span>
                            </div>
                            <p className="mt-1.5 text-xs italic leading-relaxed" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-muted)' }}>
                              The citation key was fuzzy-matched ({entry.match_method?.replace(/_/g, ' ') ?? 'heuristic'}). Verify the reference is correct.
                            </p>
                            <div className="flex items-center gap-3 mt-2.5">
                              {bib.doi && (
                                <a href={`https://doi.org/${bib.doi}`} target="_blank" rel="noopener noreferrer"
                                  className="text-[10px] font-bold underline underline-offset-2 transition-opacity hover:opacity-70"
                                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #3632b7)' }}
                                  onClick={e => e.stopPropagation()}>
                                  RESOLVE DOI
                                </a>
                              )}
                              <span style={{ color: 'var(--text-faint)' }}>&bull;</span>
                              <button className="text-[10px] font-bold uppercase tracking-wide transition-opacity hover:opacity-70"
                                style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}
                                onClick={e => e.stopPropagation()}>
                                Dismiss
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      /* ── Unresolved ── */
                      <>
                        <div className="flex items-baseline gap-3">
                          <RefNum n={refNum} />
                          <span className="text-[13px] font-bold uppercase tracking-wide break-all"
                            style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--ember, #ba1a1a)' }}>
                            {truncate(entry.cited_key, 35)}
                          </span>
                          <span className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                              style={{ color: 'var(--ember)' }}>
                              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            <span className="text-[9px] font-bold tracking-[0.1em] uppercase"
                              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--ember)' }}>
                              Citation Mismatch
                            </span>
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-secondary)' }}>
                          The referenced text does not match any paper in the project library.
                        </p>
                        <button
                          className="mt-2.5 text-[10px] font-bold uppercase tracking-wide underline underline-offset-2 transition-opacity hover:opacity-70"
                          style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #3632b7)' }}
                          onClick={e => { e.stopPropagation(); onCiteClick(entry.cited_key); }}>
                          View Conflict
                        </button>
                      </>
                    )}
                  </div>
                );
              })
          )}
        </div>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="px-5 py-3 flex items-center gap-5 flex-shrink-0"
        style={{ borderTop: '1px solid var(--border-muted, rgba(199,196,216,0.30))', background: 'var(--bg-base)' }}>
        <Dot color="var(--gold, #3632b7)" label={`${summary.resolved} verified`} />
        {summary.fuzzy_matched > 0 && <Dot color="#d97706" label={`${summary.fuzzy_matched} fuzzy`} />}
        {summary.unresolved > 0 && <Dot color="var(--ember, #ba1a1a)" label={`${summary.unresolved} issues`} />}
      </footer>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function RefNum({ n, muted }: { n: number; muted?: boolean }) {
  return (
    <span className="tabular-nums flex-shrink-0"
      style={{
        fontFamily: 'Newsreader, Georgia, serif',
        fontSize: '1.1rem',
        fontWeight: 700,
        color: muted ? 'var(--text-faint, #908f9e)' : 'var(--gold, #3632b7)',
        minWidth: '2rem',
      }}>
      [{n}]
    </span>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-[6px] h-[6px] rounded-full" style={{ background: color }} />
      <span className="text-[10px] font-semibold" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
        {label}
      </span>
    </span>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="py-16 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        className="mx-auto mb-3" style={{ color: 'var(--text-faint)' }}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
      <p className="text-xs" style={{ fontFamily: 'Newsreader, Georgia, serif', fontStyle: 'italic', color: 'var(--text-muted)' }}>
        {msg}
      </p>
    </div>
  );
}
