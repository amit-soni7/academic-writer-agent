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

// ── M3 Palette ──────────────────────────────────────────────────────────────

const M3 = {
  surface:       '#f8f9fa',
  surfaceLowest: '#ffffff',
  surfaceHigh:   '#e7e8e9',
  surfaceContainer: '#edeeef',
  surfaceLow:    '#f3f4f5',
  onBg:          '#191c1d',
  onSurfVar:     '#464555',
  primary:       '#3632b7',
  primaryFixed:  '#e2dfff',
  primaryContainer: '#504ed0',
  onPrimaryFixed: '#0b006b',
  outlineVar:    '#c7c4d8',
  secondaryFixed:'#d5e3fd',
  onSecFixed:    '#0d1c2f',
  tertiaryFixed: '#ffdbcc',
  onTertFixed:   '#351000',
};

// ── Main component ──────────────────────────────────────────────────────────

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
    <div style={{ minHeight: '100vh', background: M3.surface, fontFamily: 'Newsreader, serif', color: M3.onBg }}>

      {/* ── TopAppBar ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50, background: M3.surface,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 2rem', height: '4rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            onClick={onBack}
            className="jd-icon-btn" title="Back"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>arrow_back</span>
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
            <h2 style={{
              fontFamily: 'Newsreader, serif', fontStyle: 'italic',
              fontSize: '1.25rem', fontWeight: 400, color: M3.onBg, margin: 0,
            }}>
              Select Target Journal
            </h2>
            <span style={{
              fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: M3.primary, marginTop: '0.25rem',
            }}>
              {journals.length} journals ranked
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <button className="jd-icon-btn" onClick={onOpenSettings} title="Settings">
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>
      </header>

      {/* ── Page Content ── */}
      <div style={{ padding: '3rem', maxWidth: '72rem', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

          {/* ── Header Section ── */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '2rem', flexWrap: 'wrap' }}>
            <div style={{ maxWidth: '40rem' }}>
              <h1 style={{
                fontFamily: 'Newsreader, serif', fontSize: '3rem', fontWeight: 500,
                color: M3.onBg, margin: '0 0 0.5rem', lineHeight: 1.2,
              }}>
                Select Target Journal
              </h1>
              <p style={{
                fontFamily: 'Newsreader, serif', fontSize: '1.125rem', fontStyle: 'italic',
                color: M3.onSurfVar, lineHeight: 1.7, margin: 0,
              }}>
                Our AI has analyzed your manuscript corpus and citations to rank the most
                suitable publications for your current research focus.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexShrink: 0 }}>
              <button
                onClick={loadRecommendations}
                disabled={loading}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.625rem 1.25rem', borderRadius: '999px',
                  background: M3.surfaceHigh, border: 'none',
                  fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem', fontWeight: 600,
                  color: M3.onBg, cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.5 : 1, transition: 'all 0.15s',
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '1.125rem' }}>refresh</span>
                {loading ? 'Loading…' : 'Refresh Rankings'}
              </button>
              <button
                onClick={() => chosenJournal && onGoToWrite(sessionId, chosenJournal)}
                disabled={!chosenJournal}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.625rem 1.5rem', borderRadius: '999px',
                  background: chosenJournal
                    ? `linear-gradient(135deg, ${M3.primary}, ${M3.primaryContainer})`
                    : M3.surfaceHigh,
                  color: chosenJournal ? '#fff' : M3.onSurfVar,
                  border: 'none', fontFamily: 'Manrope, sans-serif',
                  fontSize: '0.875rem', fontWeight: 700,
                  cursor: chosenJournal ? 'pointer' : 'not-allowed',
                  opacity: chosenJournal ? 1 : 0.5,
                  boxShadow: chosenJournal ? '0 4px 12px rgba(54,50,183,0.2)' : 'none',
                  transition: 'all 0.15s',
                }}
              >
                Write Article
                <span className="material-symbols-outlined" style={{ fontSize: '1.125rem' }}>arrow_forward</span>
              </button>
            </div>
          </div>

          {/* ── Error ── */}
          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
              borderRadius: '0.75rem', padding: '1rem 1.25rem',
              fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem',
            }}>
              {error}
            </div>
          )}

          {/* ── Loading skeleton ── */}
          {loading && !journals.length && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center' }}>
              <LoadingLottie className="w-24 h-24" label="Analyzing journal corpus..." />
              {[1, 2, 3].map(i => (
                <div key={i} style={{
                  width: '100%', background: M3.surfaceLowest, borderRadius: '0.75rem',
                  padding: '2rem', opacity: 0.6,
                }}>
                  <div style={{ height: '1.25rem', background: M3.surfaceLow, borderRadius: '0.5rem', width: '40%', marginBottom: '1rem' }} />
                  <div style={{ height: '0.875rem', background: M3.surfaceLow, borderRadius: '0.5rem', width: '65%', marginBottom: '0.75rem' }} />
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <div style={{ height: '1.5rem', background: M3.surfaceLow, borderRadius: '999px', width: '5rem' }} />
                    <div style={{ height: '1.5rem', background: M3.surfaceLow, borderRadius: '999px', width: '6rem' }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Journal Cards ── */}
          {!loading && journals.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {journals.map((j, idx) => (
                <JournalCard
                  key={j.name}
                  journal={j}
                  rank={idx + 1}
                  isSelected={selected === j.name}
                  onSelect={() => setSelected(selected === j.name ? null : j.name)}
                />
              ))}

              {/* Custom journal input */}
              <div style={{
                borderRadius: '0.75rem', padding: '1.5rem',
                border: selected === '__custom__'
                  ? `2px solid ${M3.primary}`
                  : `2px dashed ${M3.outlineVar}`,
                background: selected === '__custom__' ? `${M3.primaryFixed}40` : M3.surfaceLowest,
                transition: 'all 0.15s',
              }}>
                <p style={{
                  fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem', fontWeight: 700,
                  color: M3.onSurfVar, marginBottom: '0.75rem', textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                }}>
                  Enter a different journal
                </p>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <input
                    type="text"
                    value={customJournal}
                    onChange={(e) => {
                      setCustomJournal(e.target.value);
                      if (e.target.value.trim()) setSelected('__custom__');
                      else if (selected === '__custom__') setSelected(null);
                    }}
                    placeholder="Journal name…"
                    style={{
                      flex: 1, borderRadius: '999px', border: `2px solid ${M3.outlineVar}`,
                      padding: '0.625rem 1.25rem', fontSize: '0.875rem',
                      fontFamily: 'Manrope, sans-serif', color: M3.onBg,
                      background: M3.surfaceLowest, outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => { if (customJournal.trim()) setSelected('__custom__'); }}
                    disabled={!customJournal.trim()}
                    style={{
                      padding: '0.625rem 1.25rem', borderRadius: '999px',
                      fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem', fontWeight: 600,
                      background: M3.onBg, color: '#fff', border: 'none',
                      cursor: customJournal.trim() ? 'pointer' : 'not-allowed',
                      opacity: customJournal.trim() ? 1 : 0.4, transition: 'opacity 0.15s',
                    }}
                  >
                    Use
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Footer ── */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '2rem 0', borderTop: `1px solid ${M3.outlineVar}20`,
          }}>
            <button
              onClick={onBack}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem', fontWeight: 600,
                color: M3.primary, background: 'none', border: 'none', cursor: 'pointer',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.125rem' }}>arrow_back</span>
              Back to Research Library
            </button>
            <p style={{
              fontFamily: 'Newsreader, serif', fontSize: '0.875rem', fontStyle: 'italic',
              color: M3.onSurfVar, margin: 0,
            }}>
              Rankings based on current Journal Citation Reports.
            </p>
          </div>
        </div>
      </div>

      {/* ── Sticky bottom banner ── */}
      {chosenJournal && (
        <div style={{
          position: 'sticky', bottom: '1rem',
          maxWidth: '72rem', margin: '0 auto', padding: '0 3rem',
        }}>
          <div style={{
            background: `linear-gradient(135deg, ${M3.primary}, ${M3.primaryContainer})`,
            color: '#fff', borderRadius: '1rem',
            boxShadow: '0 8px 32px rgba(54,50,183,0.3)',
            padding: '1.25rem 1.5rem',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
          }}>
            <div>
              <p style={{
                fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.7, margin: '0 0 0.25rem',
              }}>
                Selected journal
              </p>
              <p style={{ fontFamily: 'Newsreader, serif', fontSize: '1.25rem', margin: 0 }}>
                {chosenJournal}
              </p>
              {journalStyle && (
                <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                  <span style={{
                    fontFamily: 'Manrope, sans-serif', fontSize: '0.6875rem', fontWeight: 600,
                    padding: '0.2rem 0.625rem', borderRadius: '999px',
                    background: 'rgba(255,255,255,0.2)', color: '#fff',
                  }}>
                    {journalStyle.reference_format_name} · {
                      journalStyle.in_text_format === 'superscript' ? 'Superscript' :
                      journalStyle.in_text_format === 'author_year' ? 'Author-Year' : 'Numbered'
                    }
                  </span>
                  {journalStyle.accepted_article_types.slice(0, 3).map(t => (
                    <span key={t} style={{
                      fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem',
                      padding: '0.2rem 0.5rem', borderRadius: '999px',
                      background: 'rgba(255,255,255,0.15)', color: '#fff',
                    }}>
                      {t.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => onGoToWrite(sessionId, chosenJournal)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.75rem 1.5rem', borderRadius: '999px',
                background: '#fff', color: M3.primary, border: 'none',
                fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem', fontWeight: 700,
                cursor: 'pointer', flexShrink: 0, transition: 'transform 0.1s',
              }}
            >
              Write Article
              <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_forward</span>
            </button>
          </div>
        </div>
      )}

      {/* Scoped styles */}
      <style>{`
        .jd-icon-btn {
          width: 2.25rem; height: 2.25rem; border-radius: 999px;
          display: flex; align-items: center; justify-content: center;
          background: none; border: none; cursor: pointer;
          color: ${M3.onSurfVar}; transition: background 0.15s;
        }
        .jd-icon-btn:hover { background: ${M3.surfaceContainer}; }
        .jd-icon-btn:active { transform: scale(0.95); }
      `}</style>
    </div>
  );
}

// ── JournalCard ─────────────────────────────────────────────────────────────

function JournalCard({ journal: j, rank, isSelected, onSelect }: {
  journal: JournalRecommendation; rank: number; isSelected: boolean; onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isTop = rank === 1;

  // Badge colors for rank
  const rankBg = isTop ? M3.primaryFixed : M3.surfaceContainer;
  const rankColor = isTop ? M3.onPrimaryFixed : M3.onSurfVar;

  // Accent bar color
  const accentColor = isTop ? M3.primary : `${M3.outlineVar}40`;
  const accentHeight = hovered ? '6rem' : '4rem';

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative', background: M3.surfaceLowest,
        borderRadius: '0.75rem', padding: '2rem', cursor: 'pointer',
        transition: 'all 0.2s',
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered
          ? '0 8px 24px rgba(54,50,183,0.08)'
          : isSelected ? `0 0 0 2px ${M3.primary}` : 'none',
      }}
    >
      {/* Left accent bar */}
      <div style={{
        position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
        width: '6px', height: accentHeight, background: accentColor,
        borderRadius: '0 999px 999px 0', transition: 'height 0.2s',
      }} />

      <div style={{ display: 'flex', gap: '2rem' }}>
        {/* Rank badge */}
        <div style={{ flexShrink: 0 }}>
          <div style={{
            width: '4rem', height: '4rem', borderRadius: '0.75rem',
            background: rankBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontFamily: 'Manrope, sans-serif', fontWeight: 700,
              fontSize: '1.5rem', color: rankColor,
            }}>
              #{rank}
            </span>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title + tags */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
            <div>
              <h3 style={{
                fontFamily: 'Newsreader, serif', fontSize: '1.875rem', fontWeight: 600,
                color: M3.onBg, margin: '0 0 0.75rem', lineHeight: 1.3,
              }}>
                {j.website_url ? (
                  <a
                    href={j.website_url} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = M3.primary; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'inherit'; }}
                  >
                    {j.name}
                  </a>
                ) : j.name}
              </h3>
              {j.website_url && (
                <a
                  href={j.website_url} target="_blank" rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                    fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem', fontWeight: 600,
                    color: M3.primary, textDecoration: 'none', marginBottom: '0.75rem',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '0.875rem' }}>open_in_new</span>
                  Visit journal homepage
                </a>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {j.open_access === true && (
                  <TagPill bg={M3.tertiaryFixed} color={M3.onTertFixed}>Open Access</TagPill>
                )}
                {j.open_access === false && (
                  <TagPill bg={M3.surfaceContainer} color={M3.onSurfVar}>Subscription</TagPill>
                )}
                {j.frequency_in_results > 0 && (
                  <TagPill bg={M3.secondaryFixed} color={M3.onSecFixed}>{j.frequency_in_results}x in corpus</TagPill>
                )}
                {j.frequency_in_results === 0 && (
                  <TagPill bg={M3.primaryFixed} color={M3.primary}>AI suggested</TagPill>
                )}
                {j.indexed_pubmed && (
                  <TagPill bg={M3.surfaceContainer} color={M3.onSurfVar} border>PubMed Verified</TagPill>
                )}
                {j.indexed_scopus && (
                  <TagPill bg={M3.surfaceContainer} color={M3.onSurfVar} border>Scopus</TagPill>
                )}
                {j.onos_supported && (
                  <TagPill bg='#f3e8ff' color='#6b21a8'>ONOS Supported</TagPill>
                )}
              </div>
            </div>
            {/* Radio circle */}
            <div style={{
              width: '1.5rem', height: '1.5rem', borderRadius: '999px', flexShrink: 0,
              border: `2px solid ${isSelected ? M3.primary : hovered ? M3.primary : M3.outlineVar}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.15s',
            }}>
              {isSelected && (
                <div style={{
                  width: '0.75rem', height: '0.75rem', borderRadius: '999px',
                  background: M3.primary,
                }} />
              )}
              {!isSelected && hovered && (
                <div style={{
                  width: '0.75rem', height: '0.75rem', borderRadius: '999px',
                  background: M3.primary, opacity: 0.3,
                }} />
              )}
            </div>
          </div>

          {/* Publisher */}
          {j.publisher && (
            <p style={{
              fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem',
              color: M3.onSurfVar, margin: '0 0 1rem', opacity: 0.7,
            }}>
              {j.publisher}
            </p>
          )}

          {/* Metrics grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem',
            padding: '1rem 1.5rem', background: `${M3.surfaceLow}80`,
            borderRadius: '0.5rem', marginBottom: '1rem',
          }}>
            {j.avg_citations != null && (
              <div>
                <span style={{
                  fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.15em', color: `${M3.onSurfVar}99`,
                }}>
                  Impact Factor
                </span>
                <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: '1.25rem', fontWeight: 700, color: M3.onBg }}>
                  {j.avg_citations.toFixed(2)}
                </div>
              </div>
            )}
            {j.h_index != null && (
              <div>
                <span style={{
                  fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.15em', color: `${M3.onSurfVar}99`,
                }}>
                  h-index
                </span>
                <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: '1.25rem', fontWeight: 700, color: M3.onBg }}>
                  {j.h_index}
                </div>
              </div>
            )}
            {j.issn && (
              <div>
                <span style={{
                  fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.15em', color: `${M3.onSurfVar}99`,
                }}>
                  ISSN
                </span>
                <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: '1.25rem', fontWeight: 700, color: M3.onBg }}>
                  {j.issn}
                </div>
              </div>
            )}
          </div>

          {/* APC info */}
          {(j.apc_usd != null || j.apc_note || j.onos_supported) && (
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              {j.onos_supported && (
                <TagPill bg='#f3e8ff' color='#6b21a8'>APC Waived · ONOS</TagPill>
              )}
              {!j.onos_supported && j.apc_usd != null && (
                <TagPill
                  bg={j.apc_usd === 0 ? '#ecfdf5' : '#fffbeb'}
                  color={j.apc_usd === 0 ? '#065f46' : '#92400e'}
                >
                  {j.apc_usd === 0 ? 'APC Free' : `APC $${j.apc_usd.toLocaleString()}`}
                </TagPill>
              )}
              {!j.onos_supported && j.apc_note && !j.apc_usd && (
                <TagPill bg={M3.surfaceContainer} color={M3.onSurfVar}>{j.apc_note}</TagPill>
              )}
            </div>
          )}

          {/* Scope match / AI rationale */}
          {j.scope_match && (
            <div style={{
              padding: '1rem', borderRadius: '0.5rem',
              background: 'rgba(248,249,250,0.8)', backdropFilter: 'blur(12px)',
              borderLeft: `4px solid ${isTop ? `${M3.primary}50` : `${M3.outlineVar}50`}`,
            }}>
              <p style={{
                fontFamily: 'Newsreader, serif', fontStyle: 'italic',
                fontSize: '1rem', color: M3.onSurfVar, lineHeight: 1.7, margin: 0,
              }}>
                "{j.scope_match}"
              </p>
            </div>
          )}

          {/* OpenAlex link */}
          {j.openalex_url && (
            <a
              href={j.openalex_url} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                marginTop: '0.75rem', fontFamily: 'Manrope, sans-serif',
                fontSize: '0.6875rem', color: M3.primary, textDecoration: 'none',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
            >
              OpenAlex <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>open_in_new</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── TagPill ─────────────────────────────────────────────────────────────────

function TagPill({ bg, color, border, children }: {
  bg: string; color: string; border?: boolean; children: React.ReactNode;
}) {
  return (
    <span style={{
      fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.12em',
      padding: '0.25rem 0.75rem', borderRadius: '999px',
      background: bg, color,
      border: border ? `1px solid ${M3.outlineVar}30` : 'none',
    }}>
      {children}
    </span>
  );
}
