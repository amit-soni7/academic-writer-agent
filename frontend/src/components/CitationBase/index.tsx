import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import { streamCrossReferences, type CrossRefEvent } from '../../api/crossref';
import type { CitationPurpose, PaperSummary } from '../../types/paper';

// ── Constants ────────────────────────────────────────────────────────────────

const PURPOSE_META: Record<
  CitationPurpose,
  { label: string; bg: string; text: string; border: string; section: string }
> = {
  background:              { label: 'Background',        bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe', section: 'Introduction' },
  prevalence_epidemiology: { label: 'Prevalence',        bg: '#f0fdfa', text: '#0f766e', border: '#99f6e4', section: 'Introduction' },
  theory:                  { label: 'Theory',            bg: '#faf5ff', text: '#7e22ce', border: '#e9d5ff', section: 'Introduction' },
  identify_gap:            { label: 'Research Gap',      bg: '#fffbeb', text: '#b45309', border: '#fde68a', section: 'Introduction' },
  justify_study:           { label: 'Justify Study',     bg: '#fff7ed', text: '#c2410c', border: '#fed7aa', section: 'Introduction' },
  methodology:             { label: 'Methodology',       bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0', section: 'Methods' },
  original_source:         { label: 'Original Source',   bg: '#fefce8', text: '#a16207', border: '#fef08a', section: 'Any' },
  compare_findings:        { label: 'Compare Findings',  bg: '#fff1f2', text: '#be123c', border: '#fecdd3', section: 'Discussion' },
  empirical_support:       { label: 'Empirical Support', bg: '#eef2ff', text: '#4338ca', border: '#c7d2fe', section: 'Any' },
  support_claim:           { label: 'Support Claim',     bg: '#f9fafb', text: '#374151', border: '#e5e7eb', section: 'Any' },
  limitation_acknowledged: { label: 'Limitation',        bg: '#fef2f2', text: '#991b1b', border: '#fecaca', section: 'Discussion' },
  definition_terminology:  { label: 'Definition',        bg: '#f0f9ff', text: '#075985', border: '#bae6fd', section: 'Introduction' },
  clinical_guideline:      { label: 'Guideline',         bg: '#fdf4ff', text: '#86198f', border: '#f5d0fe', section: 'Introduction' },
  population_context:      { label: 'Population',        bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0', section: 'Methods' },
  measurement_validation:  { label: 'Validation',        bg: '#fff7ed', text: '#9a3412', border: '#fed7aa', section: 'Methods' },
  future_direction:        { label: 'Future Direction',  bg: '#f5f3ff', text: '#5b21b6', border: '#ddd6fe', section: 'Discussion' },
};

const PURPOSE_GROUPS: { title: string; purposes: CitationPurpose[] }[] = [
  { title: 'Background & Context',    purposes: ['background', 'prevalence_epidemiology', 'theory', 'definition_terminology'] },
  { title: 'Gap & Justification',     purposes: ['identify_gap', 'justify_study'] },
  { title: 'Methods & Instruments',   purposes: ['methodology', 'original_source', 'measurement_validation', 'population_context'] },
  { title: 'Findings & Comparison',   purposes: ['compare_findings', 'empirical_support', 'support_claim'] },
  { title: 'Discussion & Directions', purposes: ['limitation_acknowledged', 'clinical_guideline', 'future_direction'] },
];

const EVIDENCE_TYPES: Record<string, string> = {
  systematic_review: 'Systematic Review', meta_analysis: 'Meta-Analysis', rct: 'RCT',
  cohort: 'Cohort', cross_sectional: 'Cross-Sectional', qualitative: 'Qualitative',
  mixed_methods: 'Mixed Methods', psychometric_validation: 'Psychometric',
  theoretical: 'Theoretical', guideline: 'Guideline', consensus_statement: 'Consensus',
  review_narrative: 'Narrative Review', primary_empirical: 'Empirical',
};

const FIND_MORE_CARDS: {
  label: string; desc: string; cta: string;
  icon: string; iconBg: string; iconColor: string;
  purposes: CitationPurpose[];
}[] = [
  {
    label: 'Background Papers',
    desc: 'Historical context and foundational research established by early scholars.',
    cta: 'Explore Background',
    icon: 'history_edu', iconBg: '#d5e3fd', iconColor: '#3a485c',
    purposes: ['background', 'prevalence_epidemiology'],
  },
  {
    label: 'Gap Reviews',
    desc: 'Critical systematic reviews that highlight current missing knowledge or flaws.',
    cta: 'Identify Gaps',
    icon: 'troubleshoot', iconBg: '#e2dfff', iconColor: '#3632b7',
    purposes: ['identify_gap', 'justify_study'],
  },
  {
    label: 'Theory Frameworks',
    desc: 'The conceptual models and theoretical underpinnings for your study.',
    cta: 'View Models',
    icon: 'schema', iconBg: '#ffdbcc', iconColor: '#7b2f00',
    purposes: ['methodology', 'original_source', 'theory'],
  },
];

/** Filters shown as pill buttons in the evidence filter row */
const FILTER_PILLS: { key: CitationPurpose | ''; label: string }[] = [
  { key: '',                      label: 'All Papers' },
  { key: 'background',            label: 'Background' },
  { key: 'theory',                label: 'Theory' },
  { key: 'identify_gap',          label: 'Research Gap' },
  { key: 'methodology',           label: 'Methodology' },
  { key: 'limitation_acknowledged',label: 'Limitations' },
  { key: 'clinical_guideline',    label: 'Guidelines' },
  { key: 'future_direction',      label: 'Future' },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  onBack: () => void;
  onGoToJournals: (sessionId: string) => void;
  onOpenSettings: () => void;
}

interface PaperCard {
  paper_key: string;
  title: string;
  year: number | null;
  authors: string[];
  journal: string | null;
  one_line_takeaway: string;
  primary_purpose: CitationPurpose | '';
  secondary_purposes: CitationPurpose[];
  compare_sentiment: 'consistent' | 'contradicts' | null;
  purpose_profile: Record<string, number>;
  is_seminal: boolean;
  evidence_type: string | null;
  evidence_weight: string | null;
  recency_score: number | null;
  depth: number;
  triage_decision: string;
}

function summaryToCard(ps: PaperSummary): PaperCard {
  const profile = ps.purpose_profile ?? {};
  const topPurpose = Object.entries(profile).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const bankPrimary = ps.sentence_bank?.[0]?.primary_purpose ?? '';
  return {
    paper_key: ps.paper_key,
    title: ps.bibliography?.title ?? ps.paper_key,
    year: ps.bibliography?.year ?? null,
    authors: ps.bibliography?.authors ?? [],
    journal: ps.bibliography?.journal ?? null,
    one_line_takeaway: ps.one_line_takeaway ?? '',
    primary_purpose: (topPurpose || bankPrimary) as CitationPurpose | '',
    secondary_purposes: Object.keys(profile).slice(1, 4) as CitationPurpose[],
    compare_sentiment: ps.sentence_bank?.find((s) => s.compare_sentiment)?.compare_sentiment ?? null,
    purpose_profile: profile,
    is_seminal: ps.is_seminal ?? false,
    evidence_type: ps.evidence_type ?? null,
    evidence_weight: ps.evidence_weight ?? null,
    recency_score: ps.recency_score ?? null,
    depth: ps.depth ?? 0,
    triage_decision: ps.triage?.decision ?? 'include',
  };
}

// ── Palette (Material Design 3 tokens) ──────────────────────────────────────

const M3 = {
  surface:       '#f8f9fa',
  surfaceLowest: '#ffffff',
  surfaceHigh:   '#e7e8e9',
  surfaceContainer: '#edeeef',
  onBg:          '#191c1d',
  onSurfVar:     '#464555',
  primary:       '#3632b7',
  primaryFixed:  '#e2dfff',
  outlineVar:    '#c7c4d8',
};

// ── Component ────────────────────────────────────────────────────────────────

export default function CitationBase({ sessionId, onBack, onGoToJournals, onOpenSettings }: Props) {
  const [papers, setPapers]               = useState<PaperCard[]>([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [purposeFilter, setPurposeFilter] = useState<CitationPurpose | ''>('');
  const [search, setSearch]               = useState('');
  const [selected, setSelected]           = useState<PaperCard | null>(null);
  const [expanding, setExpanding]         = useState(false);
  const [expandLog, setExpandLog]         = useState<string[]>([]);
  const expandRef                         = useRef<EventSource | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true); setError('');
      try {
        const { data } = await api.get<{ summaries: Record<string, unknown> }>(`/api/projects/${sessionId}`);
        setPapers((Object.values(data.summaries ?? {}) as PaperSummary[]).map(summaryToCard));
      } catch { setError('Failed to load papers.'); }
      finally { setLoading(false); }
    })();
  }, [sessionId]);

  const currentYear = new Date().getFullYear();

  const filtered = useMemo(() => papers.filter((p) => {
    if (search) {
      const q = search.toLowerCase();
      if (!p.title.toLowerCase().includes(q) && !p.authors.join(' ').toLowerCase().includes(q)) return false;
    }
    if (purposeFilter) {
      const all = new Set<string>([p.primary_purpose, ...p.secondary_purposes].filter(Boolean));
      if (!all.has(purposeFilter)) return false;
    }
    return true;
  }), [papers, search, purposeFilter, currentYear]);

  const grouped = useMemo(() => {
    const result: { title: string; cards: PaperCard[] }[] = [];
    for (const group of PURPOSE_GROUPS) {
      const cards = filtered.filter((p) =>
        group.purposes.some((gp) => p.primary_purpose === gp || p.secondary_purposes.includes(gp))
      );
      if (cards.length > 0) result.push({ title: group.title, cards });
    }
    const categorised = new Set(result.flatMap((g) => g.cards.map((c) => c.paper_key)));
    const rest = filtered.filter((p) => !categorised.has(p.paper_key));
    if (rest.length > 0) result.push({ title: 'Other Papers', cards: rest });
    return result;
  }, [filtered]);

  const handleFindMore = (purposes: CitationPurpose[]) => {
    if (expanding) return;
    setExpanding(true);
    setExpandLog([`Expanding for: ${purposes.join(', ')}…`]);
    const handle = streamCrossReferences(sessionId, 1, (evt: CrossRefEvent) => {
      if (evt.type === 'paper_done' && evt.success && evt.title)
        setExpandLog((l) => [...l, `✓ ${evt.title}`]);
      if (evt.type === 'complete') {
        setExpanding(false);
        setExpandLog((l) => [...l, `Done — ${evt.total_fetched ?? 0} papers added. Reload to see them.`]);
      }
      if (evt.type === 'error') { setExpanding(false); setExpandLog((l) => [...l, `Error: ${evt.message}`]); }
    }, purposes);
    expandRef.current = handle;
  };

  const hasFilters = purposeFilter || search;
  const clearFilters = () => { setPurposeFilter(''); setSearch(''); };

  // ── Render ──

  return (
    <div style={{ minHeight: '100vh', background: M3.surface, color: M3.onBg, fontFamily: 'Newsreader, serif' }}>

      {/* ── TopAppBar ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: M3.surface,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 2rem', height: '4rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            onClick={onBack}
            className="cb-icon-btn"
            title="Back"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>arrow_back</span>
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
            <h2 style={{
              fontFamily: 'Newsreader, serif', fontStyle: 'italic',
              fontSize: '1.25rem', fontWeight: 400, color: M3.onBg, margin: 0,
            }}>
              Citation Base
            </h2>
            <span style={{
              fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em',
              color: M3.primary, marginTop: '0.25rem',
            }}>
              {papers.length} papers identified
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {/* Search pill */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: M3.surfaceHigh, borderRadius: '999px',
            padding: '0.375rem 1rem', width: '16rem',
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1rem', color: M3.onSurfVar }}>search</span>
            <input
              type="text" placeholder="Search literature..."
              value={search} onChange={(e) => setSearch(e.target.value)}
              style={{
                background: 'none', border: 'none', outline: 'none',
                fontSize: '0.875rem', color: M3.onBg,
                fontFamily: 'Manrope, sans-serif', width: '100%',
              }}
            />
          </div>

          {/* Continue to Journals */}
          <button
            onClick={() => onGoToJournals(sessionId)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              background: `linear-gradient(135deg, ${M3.primary}, #504ed0)`,
              color: '#fff', border: 'none', borderRadius: '999px',
              padding: '0.625rem 1.5rem', fontSize: '0.875rem',
              fontWeight: 700, fontFamily: 'Manrope, sans-serif',
              cursor: 'pointer', boxShadow: '0 4px 12px rgba(54,50,183,0.2)',
              transition: 'box-shadow 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 20px rgba(54,50,183,0.35)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(54,50,183,0.2)'; }}
          >
            Continue to Journals
            <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>chevron_right</span>
          </button>

          {/* Icon buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <button className="cb-icon-btn" title="Notifications">
              <span className="material-symbols-outlined">notifications</span>
            </button>
            <button className="cb-icon-btn" onClick={onOpenSettings} title="Settings">
              <span className="material-symbols-outlined">settings</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Page Content ── */}
      <div style={{ padding: '3rem', maxWidth: '72rem', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

          {/* ── Instructional Banner (glass card) ── */}
          <section style={{
            background: 'rgba(255,255,255,0.8)', backdropFilter: 'blur(12px)',
            borderRadius: '1rem', padding: '2rem',
            display: 'flex', alignItems: 'flex-start', gap: '1.5rem',
            borderLeft: `4px solid ${M3.primary}`,
          }}>
            <div style={{
              background: M3.primaryFixed, padding: '0.75rem', borderRadius: '0.75rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <span className="material-symbols-outlined" style={{ color: M3.primary, fontVariationSettings: "'FILL' 1" }}>info</span>
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontFamily: 'Newsreader, serif', fontSize: '1.5rem', margin: '0 0 0.5rem', color: M3.onBg }}>
                Curation Logic
              </h3>
              <p style={{
                fontFamily: 'Newsreader, serif', fontSize: '1.125rem',
                color: M3.onSurfVar, lineHeight: 1.7, margin: 0,
              }}>
                Papers are automatically grouped by their{' '}
                <span style={{ color: M3.primary, fontWeight: 700 }}>citation purpose</span>{' '}
                within your research narrative. Use the evidence filters to refine your argument's foundation
                or locate specific theoretical gaps.
              </p>
            </div>
          </section>

          {/* ── Find More Sources (Bento Grid) ── */}
          <section>
            <div style={{ marginBottom: '2rem' }}>
              <h4 style={{ fontFamily: 'Newsreader, serif', fontSize: '1.875rem', color: M3.onBg, margin: 0 }}>
                Find More Sources
              </h4>
              <p style={{
                fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem', color: M3.onSurfVar,
                textTransform: 'uppercase', letterSpacing: '0.15em', marginTop: '0.25rem',
              }}>
                Targeted literature acquisition
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem' }}>
              {FIND_MORE_CARDS.map((card) => (
                <FindMoreCard
                  key={card.label}
                  card={card}
                  expanding={expanding}
                  onExpand={() => handleFindMore(card.purposes)}
                />
              ))}
            </div>

            {/* Expand log */}
            {expandLog.length > 0 && (
              <div style={{
                marginTop: '1rem', maxHeight: '6rem', overflowY: 'auto',
                fontSize: '0.8125rem', color: M3.onSurfVar, lineHeight: 1.5,
                background: M3.surfaceLowest, borderRadius: '0.75rem', padding: '0.75rem 1rem',
                border: `1px solid ${M3.outlineVar}`,
              }}>
                {expandLog.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </section>

          {/* ── Evidence Filter Pills ── */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem',
              paddingBottom: '0.5rem', borderBottom: `1px solid ${M3.outlineVar}20`,
            }}>
              <span style={{
                fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem',
                fontWeight: 800, color: M3.onSurfVar,
                textTransform: 'uppercase', letterSpacing: '0.2em', marginRight: '0.25rem',
              }}>
                Evidence Filter:
              </span>
              {FILTER_PILLS.map((pill) => {
                const active = purposeFilter === pill.key;
                return (
                  <button
                    key={pill.key}
                    onClick={() => setPurposeFilter(pill.key as CitationPurpose | '')}
                    style={{
                      fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem', fontWeight: 700,
                      padding: '0.375rem 1rem', borderRadius: '999px', cursor: 'pointer',
                      border: 'none', transition: 'all 0.15s',
                      background: active ? M3.primary : M3.surfaceContainer,
                      color: active ? '#fff' : M3.onBg,
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = M3.surfaceHigh; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = M3.surfaceContainer; }}
                  >
                    {pill.label}
                  </button>
                );
              })}
              {hasFilters && (
                <button
                  onClick={clearFilters}
                  style={{
                    fontFamily: 'Manrope, sans-serif', fontSize: '0.6875rem',
                    color: M3.primary, background: 'none', border: 'none',
                    cursor: 'pointer', textDecoration: 'underline',
                  }}
                >
                  Clear all
                </button>
              )}
            </div>

            {/* ── Paper groups ── */}
            {loading ? (
              <div style={{ textAlign: 'center', padding: '4rem 0', color: M3.onSurfVar }}>
                <span className="material-symbols-outlined" style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.75rem', opacity: 0.4 }}>article</span>
                <span style={{ fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem' }}>Loading citation base…</span>
              </div>
            ) : error ? (
              <div style={{ textAlign: 'center', padding: '4rem 0', color: '#ba1a1a', fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem' }}>{error}</div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '4rem 0', color: M3.onSurfVar, fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem' }}>
                No papers match the current filters.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {grouped.map((group) => (
                  <div key={group.title}>
                    <h4 style={{
                      fontFamily: 'Newsreader, serif', fontSize: '1.5rem',
                      color: M3.onBg, margin: '0 0 1rem',
                    }}>
                      {group.title}
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {group.cards.map((card) => (
                        <PaperRow key={card.paper_key} card={card} onClick={() => setSelected(card)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {selected && <PaperDetailModal paper={selected} onClose={() => setSelected(null)} />}

      {/* Scoped styles */}
      <style>{`
        .cb-icon-btn {
          width: 2.25rem; height: 2.25rem; border-radius: 999px;
          display: flex; align-items: center; justify-content: center;
          background: none; border: none; cursor: pointer;
          color: ${M3.onSurfVar}; transition: background 0.15s;
        }
        .cb-icon-btn:hover { background: ${M3.surfaceContainer}; }
        .cb-icon-btn:active { transform: scale(0.95); }
      `}</style>
    </div>
  );
}

// ── FindMoreCard ─────────────────────────────────────────────────────────────

function FindMoreCard({ card, expanding, onExpand }: {
  card: typeof FIND_MORE_CARDS[number]; expanding: boolean; onExpand: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={() => !expanding && onExpand()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: M3.surfaceLowest, padding: '1.5rem', borderRadius: '1rem',
        cursor: expanding ? 'not-allowed' : 'pointer', opacity: expanding ? 0.6 : 1,
        transition: 'all 0.2s',
        boxShadow: hovered ? `0 8px 24px rgba(54,50,183,0.08)` : 'none',
      }}
    >
      <div style={{
        width: '3rem', height: '3rem', borderRadius: '999px',
        background: card.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '1.5rem',
        transition: 'transform 0.2s',
        transform: hovered ? 'scale(1.1)' : 'scale(1)',
      }}>
        <span className="material-symbols-outlined" style={{ color: card.iconColor }}>{card.icon}</span>
      </div>
      <h5 style={{ fontFamily: 'Newsreader, serif', fontSize: '1.25rem', margin: '0 0 0.5rem', color: M3.onBg }}>
        {card.label}
      </h5>
      <p style={{
        fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem',
        color: M3.onSurfVar, margin: '0 0 1.5rem', lineHeight: 1.5,
      }}>
        {card.desc}
      </p>
      <span style={{
        fontFamily: 'Manrope, sans-serif', fontSize: '0.875rem', fontWeight: 700,
        color: M3.primary, display: 'flex', alignItems: 'center', gap: '0.25rem',
        transition: 'gap 0.2s',
        ...(hovered ? { gap: '0.5rem' } : {}),
      }}>
        {expanding ? 'Searching…' : card.cta}
        <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_forward</span>
      </span>
    </div>
  );
}

// ── PaperRow ─────────────────────────────────────────────────────────────────

function PaperRow({ card, onClick }: { card: PaperCard; onClick: () => void }) {
  const meta = card.primary_purpose ? PURPOSE_META[card.primary_purpose as CitationPurpose] : null;
  const firstAuthor = card.authors[0] ?? 'Unknown';
  const [hovered, setHovered] = useState(false);

  // Badge colors per purpose
  const badgeBg = meta?.bg ?? M3.surfaceHigh;
  const badgeColor = meta?.text ?? M3.onSurfVar;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: M3.surfaceLowest, borderRadius: '1rem',
        padding: '1.5rem', cursor: 'pointer',
        display: 'flex', gap: '1.5rem',
        transition: 'all 0.15s',
        transform: hovered ? 'translateX(4px)' : 'none',
        ...(hovered ? { background: '#fff' } : {}),
      }}
    >
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title + badge */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.75rem' }}>
          <h6 style={{
            fontFamily: 'Newsreader, serif', fontSize: '1.5rem', fontWeight: 400,
            color: M3.onBg, margin: 0, lineHeight: 1.3,
          }}>
            {card.title}
          </h6>
          {meta && (
            <span style={{
              fontFamily: 'Manrope, sans-serif', fontSize: '0.625rem', fontWeight: 700,
              textTransform: 'uppercase', padding: '0.25rem 0.625rem', borderRadius: '0.25rem',
              background: badgeBg, color: badgeColor, flexShrink: 0, whiteSpace: 'nowrap',
            }}>
              {meta.label}
            </span>
          )}
        </div>

        {/* Meta row: author · year · journal */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '1rem',
          fontFamily: 'Manrope, sans-serif', fontSize: '0.75rem', color: M3.onSurfVar,
          marginBottom: '1rem',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: 700, color: M3.onBg }}>
            <span className="material-symbols-outlined" style={{ fontSize: '0.875rem' }}>person</span>
            {firstAuthor}{card.authors.length > 1 ? ' et al.' : ''}
          </span>
          {card.year && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '0.875rem' }}>calendar_today</span>
              {card.year}
            </span>
          )}
          {card.journal && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontStyle: 'italic' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '0.875rem' }}>menu_book</span>
              {card.journal}
            </span>
          )}
        </div>

        {/* Takeaway */}
        {card.one_line_takeaway && (
          <p style={{
            fontFamily: 'Newsreader, serif', fontSize: '1rem',
            color: M3.onSurfVar, lineHeight: 1.6, margin: 0,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            "{card.one_line_takeaway}"
          </p>
        )}
      </div>

      {/* Action icons (right column) */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '0.5rem',
        justifyContent: 'center', flexShrink: 0,
      }}>
        <button className="cb-icon-btn" style={{ color: card.is_seminal ? M3.primary : M3.onSurfVar }}>
          <span className="material-symbols-outlined" style={card.is_seminal ? { fontVariationSettings: "'FILL' 1" } : {}}>bookmark</span>
        </button>
        <button className="cb-icon-btn">
          <span className="material-symbols-outlined">share</span>
        </button>
        <button className="cb-icon-btn">
          <span className="material-symbols-outlined">more_vert</span>
        </button>
      </div>
    </div>
  );
}

// ── PaperDetailModal ──────────────────────────────────────────────────────────

function PaperDetailModal({ paper, onClose }: { paper: PaperCard; onClose: () => void }) {
  const allPurposes = [paper.primary_purpose, ...paper.secondary_purposes].filter(Boolean) as CitationPurpose[];
  const profileEntries = Object.entries(paper.purpose_profile).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: M3.surfaceLowest, borderRadius: '1.5rem',
          boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
          maxWidth: '560px', width: '100%', maxHeight: '85vh', overflowY: 'auto',
          padding: '2rem', fontFamily: 'Manrope, sans-serif',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <h3 style={{
            margin: 0, fontFamily: 'Newsreader, serif', fontWeight: 400,
            fontSize: '1.375rem', color: M3.onBg, lineHeight: 1.35, paddingRight: '1rem',
          }}>
            {paper.title}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: M3.onSurfVar, fontSize: '1.125rem', flexShrink: 0, lineHeight: 1,
            }}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Authors · year · journal */}
        <div style={{ fontSize: '0.875rem', color: M3.onSurfVar, marginBottom: '1.25rem' }}>
          {paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}
          {paper.year ? ` · ${paper.year}` : ''}
          {paper.journal ? ` · ${paper.journal}` : ''}
        </div>

        {/* Purpose badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1.25rem' }}>
          {allPurposes.map((p) => {
            const m = PURPOSE_META[p]; if (!m) return null;
            return (
              <span key={p} style={{
                fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase' as const,
                padding: '0.25rem 0.625rem', borderRadius: '0.25rem',
                background: m.bg, color: m.text,
              }}>
                {m.label}
              </span>
            );
          })}
          {paper.is_seminal && (
            <span style={{
              fontSize: '0.6875rem', fontWeight: 700, padding: '0.25rem 0.625rem',
              borderRadius: '0.25rem', background: '#fffbeb', color: '#b45309',
            }}>
              Seminal
            </span>
          )}
        </div>

        {/* Takeaway */}
        {paper.one_line_takeaway && (
          <div style={{
            marginBottom: '1.25rem', fontSize: '1rem',
            fontFamily: 'Newsreader, serif',
            background: M3.surface, borderRadius: '0.75rem',
            padding: '1rem 1.25rem', color: M3.onBg, lineHeight: 1.7,
            borderLeft: `3px solid ${M3.primary}`,
          }}>
            "{paper.one_line_takeaway}"
          </div>
        )}

        {/* Purpose profile bars */}
        {profileEntries.length > 0 && (
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{
              fontSize: '0.625rem', fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.15em', color: M3.onSurfVar, marginBottom: '0.625rem',
            }}>
              Purpose Profile
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {profileEntries.map(([purpose, weight]) => {
                const m = PURPOSE_META[purpose as CitationPurpose];
                const pct = Math.round(weight * 100);
                return (
                  <div key={purpose} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.8125rem' }}>
                    <span style={{
                      width: '8rem', color: M3.onSurfVar, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
                    }}>
                      {m?.label ?? purpose}
                    </span>
                    <div style={{ flex: 1, background: M3.surfaceHigh, borderRadius: '999px', height: '6px' }}>
                      <div style={{
                        background: m?.text ?? M3.primary, height: '6px',
                        borderRadius: '999px', width: `${pct}%`, transition: 'width 0.4s',
                      }} />
                    </div>
                    <span style={{ color: M3.onSurfVar, width: '2.5rem', textAlign: 'right', flexShrink: 0 }}>{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Metadata row */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '1rem', fontSize: '0.8125rem',
          color: M3.onSurfVar, borderTop: `1px solid ${M3.outlineVar}40`, paddingTop: '1rem',
        }}>
          {paper.evidence_type && (
            <span>Study: <strong style={{ color: M3.onBg }}>{EVIDENCE_TYPES[paper.evidence_type] ?? paper.evidence_type}</strong></span>
          )}
          {paper.evidence_weight && (
            <span>Evidence: <strong style={{ color: M3.onBg }}>{paper.evidence_weight}</strong></span>
          )}
          {paper.recency_score != null && (
            <span>Recency: <strong style={{ color: M3.onBg }}>{Math.round(paper.recency_score * 100)}%</strong></span>
          )}
          {paper.depth > 0 && (
            <span>Depth: <strong style={{ color: M3.onBg }}>D{paper.depth}</strong></span>
          )}
        </div>
      </div>
    </div>
  );
}
