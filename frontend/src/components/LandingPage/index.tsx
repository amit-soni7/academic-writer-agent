import { useNavigate } from 'react-router-dom';
import appLogo from '../../assets/firstquill-logo.png';
import ThemeToggle, { type ThemePreference } from '../ThemeToggle';

interface Props {
  themePref: ThemePreference;
  setThemePref: (t: ThemePreference) => void;
}

// ── Reusable inline styles ──────────────────────────────────────────────────

const serif = { fontFamily: '"Cormorant Garamond", Georgia, serif' };
const mono  = { fontFamily: '"JetBrains Mono", Menlo, monospace' };

// ── Mini app-preview mockups ─────────────────────────────────────────────────

function LiteratureMockup() {
  const papers = [
    { title: 'CRISPR-Cas9 enables precise oncogene editing in solid tumors', authors: 'Zhang et al.', journal: 'Nature Medicine · 2024', relevance: 'High relevance' },
    { title: 'Off-target effects in CRISPR therapies: systematic meta-analysis', authors: 'Kim & Patel', journal: 'Cell · 2023', relevance: 'High relevance' },
    { title: 'Clinical outcomes of CAR-T with CRISPR gene knock-in', authors: 'Torres et al.', journal: 'NEJM · 2024', relevance: 'Moderate relevance' },
  ];
  return (
    <div
      className="rounded-xl overflow-hidden shadow-2xl w-full"
      style={{ background: '#0f1828', border: '1px solid #253448', fontFamily: 'inherit' }}
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-4 py-3" style={{ background: '#0d1520', borderBottom: '1px solid #1e2a3e' }}>
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <div className="ml-3 flex-1 rounded" style={{ background: '#19223a', height: 20 }}>
          <span className="px-3 text-[10px]" style={{ color: '#4c6280', ...mono }}>
            CRISPR gene editing in cancer therapy
          </span>
        </div>
      </div>
      {/* Search results */}
      <div className="p-4 space-y-3">
        {papers.map((p, i) => (
          <div key={i} className="rounded-lg p-3" style={{ background: '#131a28', border: '1px solid #1e2a3e' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium leading-snug" style={{ color: '#dcd7ce' }}>
                {p.title}
              </p>
              <span
                className="shrink-0 text-[9px] px-1.5 py-0.5 rounded"
                style={{ background: '#0e1e38', color: '#5a9fd6', border: '1px solid #253448', ...mono }}
              >
                {p.relevance === 'High relevance' ? '★ High' : '◆ Mid'}
              </span>
            </div>
            <p className="text-[10px] mt-1" style={{ color: '#4c6280', ...mono }}>
              {p.authors} · {p.journal}
            </p>
          </div>
        ))}
        <div className="flex gap-2 pt-1">
          <div className="rounded px-3 py-1.5 text-[10px] font-medium" style={{ background: '#1e3a5f', color: '#fff', ...mono }}>
            Summarize All
          </div>
          <div className="rounded px-3 py-1.5 text-[10px]" style={{ background: '#19223a', color: '#4c6280', border: '1px solid #1e2a3e', ...mono }}>
            Expand Search
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftMockup() {
  return (
    <div
      className="rounded-xl overflow-hidden shadow-2xl w-full"
      style={{ background: '#0f1828', border: '1px solid #253448' }}
    >
      <div className="flex items-center gap-1.5 px-4 py-3" style={{ background: '#0d1520', borderBottom: '1px solid #1e2a3e' }}>
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <div className="ml-3 flex gap-3">
          {['Draft', 'Peer Review', 'Revision'].map((tab, i) => (
            <span
              key={tab}
              className="text-[10px] px-3 py-1 rounded"
              style={i === 0
                ? { background: '#1e3a5f', color: '#fff', ...mono }
                : { color: '#4c6280', ...mono }}
            >
              {tab}
            </span>
          ))}
        </div>
      </div>
      <div className="p-4">
        <div className="mb-3">
          <span className="text-[9px] px-2 py-0.5 rounded" style={{ background: '#0e1e38', color: '#5a9fd6', border: '1px solid #253448', ...mono }}>
            NEJM · Original Research
          </span>
        </div>
        <h3 className="text-sm font-semibold mb-2" style={{ color: '#ece7df', ...serif }}>
          Efficacy of CRISPR-Cas9 in Solid Tumor Oncogene Correction: A Systematic Review
        </h3>
        <div className="space-y-1.5">
          <p className="text-[10px] leading-relaxed" style={{ color: '#94aec5' }}>
            <span style={{ color: '#5a9fd6', ...mono }}>## Abstract</span>
          </p>
          <p className="text-[10px] leading-relaxed" style={{ color: '#dcd7ce' }}>
            <strong>Background:</strong> CRISPR-Cas9 genome editing has emerged as a transformative approach for targeted oncogene correction in solid tumors...
          </p>
          <p className="text-[10px] leading-relaxed" style={{ color: '#dcd7ce' }}>
            <strong>Methods:</strong> We conducted a systematic review of 47 studies (2019–2024) examining CRISPR-Cas9 efficacy in breast, lung, and colorectal carcinoma models...
          </p>
          <div className="mt-2 pt-2 border-t flex items-center gap-3" style={{ borderColor: '#1e2a3e' }}>
            <span className="text-[9px]" style={{ color: '#4c6280', ...mono }}>4,280 words</span>
            <span className="text-[9px]" style={{ color: '#4c6280', ...mono }}>47 references</span>
            <span className="text-[9px] px-2 py-0.5 rounded" style={{ background: '#0d2219', color: '#57a87b', border: '1px solid #163c2a', ...mono }}>
              AMA style
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RevisionMockup() {
  const comments = [
    {
      reviewer: 'Reviewer 1',
      num: '#3',
      text: '"The statistical methods need clarification regarding sample size justification and power analysis."',
      response: 'We have added a detailed power analysis to the Methods section. A sample size of n=120 provides 80% power (α=0.05) to detect a 15% difference in editing efficiency...',
    },
    {
      reviewer: 'Reviewer 2',
      num: '#1',
      text: '"Figure 2 lacks appropriate error bars and statistical annotations."',
      response: 'Figure 2 has been revised to include SEM error bars and Bonferroni-corrected p-values for all pairwise comparisons...',
    },
  ];
  return (
    <div
      className="rounded-xl overflow-hidden shadow-2xl w-full"
      style={{ background: '#0f1828', border: '1px solid #253448' }}
    >
      <div className="flex items-center gap-1.5 px-4 py-3" style={{ background: '#0d1520', borderBottom: '1px solid #1e2a3e' }}>
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="w-3 h-3 rounded-full" style={{ background: '#3a506a' }} />
        <span className="ml-3 text-[10px]" style={{ color: '#4c6280', ...mono }}>
          Point-by-point Response Letter
        </span>
      </div>
      <div className="p-4 space-y-3">
        {comments.map((c, i) => (
          <div key={i} className="rounded-lg overflow-hidden" style={{ border: '1px solid #1e2a3e' }}>
            <div className="px-3 py-2 flex items-center gap-2" style={{ background: '#141f35', borderBottom: '1px solid #1e2a3e' }}>
              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: '#0e1e38', color: '#5a9fd6', border: '1px solid #253448', ...mono }}>
                {c.reviewer}
              </span>
              <span className="text-[9px]" style={{ color: '#4c6280', ...mono }}>{c.num}</span>
            </div>
            <div className="px-3 py-2" style={{ background: '#131a28' }}>
              <p className="text-[10px] italic leading-relaxed" style={{ color: '#94aec5' }}>{c.text}</p>
            </div>
            <div className="px-3 py-2" style={{ background: '#0e1e38', borderTop: '1px solid #1e2a3e' }}>
              <p className="text-[9px] mb-1 font-medium" style={{ color: '#5a9fd6', ...mono }}>Response:</p>
              <p className="text-[10px] leading-relaxed" style={{ color: '#dcd7ce' }}>{c.response}</p>
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <div className="rounded px-3 py-1.5 text-[10px] font-medium" style={{ background: '#1e3a5f', color: '#fff', ...mono }}>
            Download .docx
          </div>
          <div className="rounded px-3 py-1.5 text-[10px]" style={{ background: '#19223a', color: '#4c6280', border: '1px solid #1e2a3e', ...mono }}>
            Track Changes
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section components ────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    label: 'Literature Discovery',
    desc: 'Search PubMed, Semantic Scholar, and arXiv. AI summarizes each paper and scores its relevance to your question.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h8m-8 10h8M7 7a2 2 0 100-4 2 2 0 000 4zm10 14a2 2 0 100-4 2 2 0 000 4zM7 5v14a2 2 0 002 2h6" />
      </svg>
    ),
    label: 'Evidence Synthesis',
    desc: 'Cross-reference findings across all retrieved papers. Spot consensus, gaps, and conflicts automatically.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h12a2 2 0 002-2v-5m-7-7l6 6m0 0V7m0 5h-5" />
      </svg>
    ),
    label: 'Journal-Aware Drafting',
    desc: 'Select your target journal and get a manuscript formatted to its exact style, word limits, and section structure.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    label: 'AI Peer Review',
    desc: 'Simulate rigorous peer review before submission. Get structured critique on methods, data, and argumentation.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
    label: 'Revision Pipeline',
    desc: 'Upload reviewer decision letters. Get point-by-point AI responses and a revised manuscript ready to resubmit.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    label: 'Export Ready',
    desc: 'Download as .docx, track-changes, or response letter formats. BibTeX references auto-saved to your project folder.',
  },
];

const PIPELINE_STEPS = [
  { n: '01', label: 'Describe your idea', sub: 'Enter your research question, select your article type and target journal.' },
  { n: '02', label: 'Search literature', sub: 'AI retrieves and summarizes relevant papers, scoring each for relevance.' },
  { n: '03', label: 'Synthesize evidence', sub: 'Cross-paper analysis identifies the key findings that support your argument.' },
  { n: '04', label: 'Draft the manuscript', sub: 'A full journal-formatted draft — abstract, methods, results, discussion, references.' },
  { n: '05', label: 'Review & revise', sub: 'Run AI peer review, then respond to real reviewer comments point-by-point.' },
];

// ── Main landing page ─────────────────────────────────────────────────────────

export default function LandingPage({ themePref, setThemePref }: Props) {
  const navigate = useNavigate();

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div style={{ background: 'var(--bg-base)', color: 'var(--text-body)', minHeight: '100vh' }}>

      {/* ── NAV ─────────────────────────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-40 border-b"
        style={{ background: 'color-mix(in srgb, var(--bg-base) 88%, transparent)', backdropFilter: 'blur(12px)', borderColor: 'var(--border-faint)' }}
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src={appLogo} alt="First Quill" className="w-7 h-7 object-contain" />
            <span className="text-lg font-semibold" style={{ ...serif, color: 'var(--gold)' }}>
              First Quill
            </span>
          </div>

          <div className="hidden md:flex items-center gap-6">
            <button onClick={() => scrollTo('features')} className="text-sm transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}>
              Features
            </button>
            <button onClick={() => scrollTo('pipeline')} className="text-sm transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}>
              How It Works
            </button>
            <button onClick={() => navigate('/pricing')} className="text-sm transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}>
              Pricing
            </button>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle value={themePref} onChange={setThemePref} compact />
            <button
              onClick={() => navigate('/intake')}
              className="text-sm font-medium px-4 py-1.5 rounded-lg transition-all"
              style={{ background: 'var(--gold)', color: '#fff' }}
            >
              Get Started
            </button>
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">

            {/* Left — copy */}
            <div className="animate-in delay-0">
              <div className="inline-flex items-center gap-2 mb-6 px-3 py-1.5 rounded-full border text-xs"
                style={{ borderColor: 'var(--border-muted)', color: 'var(--text-secondary)', background: 'var(--bg-surface)', ...mono }}>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--gold)' }} />
                AI-Powered Academic Writing Pipeline
              </div>

              <h1 className="text-5xl lg:text-6xl font-light leading-[1.1] mb-6 animate-in delay-75"
                style={{ ...serif, color: 'var(--text-bright)' }}>
                From research idea<br />
                <em style={{ color: 'var(--gold)', fontStyle: 'italic' }}>to published paper.</em>
              </h1>

              <p className="text-lg leading-relaxed mb-8 animate-in delay-150"
                style={{ color: 'var(--text-secondary)', maxWidth: '520px' }}>
                First Quill is the intelligent writing pipeline for researchers. Search literature,
                synthesize evidence, draft journal-ready manuscripts, and respond to peer review — all in one place.
              </p>

              <div className="flex flex-wrap items-center gap-3 animate-in delay-250">
                <button
                  onClick={() => navigate('/intake')}
                  className="btn-primary inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold"
                >
                  Start Your Project
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </button>
                <button
                  onClick={() => scrollTo('pipeline')}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium border transition-colors"
                  style={{ borderColor: 'var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent' }}
                >
                  See how it works
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Right — logo */}
            <div className="hidden lg:flex items-center justify-center animate-in delay-150">
              <div className="relative">
                {/* Glow ring */}
                <div className="absolute inset-0 rounded-full scale-110"
                  style={{
                    background: 'radial-gradient(circle, var(--gold-faint) 0%, transparent 70%)',
                    filter: 'blur(32px)',
                  }} />
                {/* Logo */}
                <img
                  src={appLogo}
                  alt="First Quill"
                  className="relative w-72 h-72 object-contain drop-shadow-2xl"
                  style={{ filter: 'drop-shadow(0 12px 40px rgba(30,58,95,0.25))' }}
                />
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── STATS BAR ────────────────────────────────────────────────────────── */}
      <div className="border-y" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-center gap-8 md:gap-16">
          {[
            { val: '5', label: 'Pipeline Stages' },
            { val: '12', label: 'Article Types' },
            { val: '50+', label: 'Journal Styles' },
            { val: '3', label: 'Export Formats' },
          ].map(({ val, label }) => (
            <div key={label} className="text-center">
              <p className="text-2xl font-semibold" style={{ ...serif, color: 'var(--gold)' }}>{val}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)', ...mono }}>{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── FEATURES GRID ────────────────────────────────────────────────────── */}
      <section id="features" className="py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <p className="text-xs font-medium tracking-widest uppercase mb-3"
              style={{ color: 'var(--gold)', ...mono }}>Capabilities</p>
            <h2 className="text-4xl font-light" style={{ ...serif, color: 'var(--text-bright)' }}>
              Everything a researcher needs
            </h2>
            <p className="mt-3 text-base" style={{ color: 'var(--text-secondary)', maxWidth: 480, margin: '12px auto 0' }}>
              A complete pipeline from first idea to final submission, designed around how academic writing actually works.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <div
                key={f.label}
                className="rounded-xl p-6 border transition-all duration-200"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-faint)' }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--gold)';
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--gold-faint)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-faint)';
                  (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-surface)';
                }}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-4"
                  style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
                  {f.icon}
                </div>
                <h3 className="font-semibold text-sm mb-2" style={{ color: 'var(--text-bright)' }}>{f.label}</h3>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────────── */}
      <section id="pipeline" className="py-24 border-t" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <p className="text-xs font-medium tracking-widest uppercase mb-3"
              style={{ color: 'var(--gold)', ...mono }}>Pipeline</p>
            <h2 className="text-4xl font-light" style={{ ...serif, color: 'var(--text-bright)' }}>
              How it works
            </h2>
            <p className="mt-3 text-base" style={{ color: 'var(--text-secondary)', maxWidth: 480, margin: '12px auto 0' }}>
              Five guided stages take you from a rough idea to a submission-ready manuscript.
            </p>
          </div>

          <div className="relative">
            {/* Connector line */}
            <div className="absolute left-[28px] top-10 bottom-10 w-px hidden md:block"
              style={{ background: 'linear-gradient(to bottom, var(--gold), var(--border-faint))' }} />

            <div className="space-y-6">
              {PIPELINE_STEPS.map((s, i) => (
                <div key={s.n} className="relative flex gap-6 md:gap-8 items-start animate-in"
                  style={{ animationDelay: `${i * 80}ms` }}>
                  <div
                    className="shrink-0 w-14 h-14 rounded-full flex items-center justify-center z-10"
                    style={{ background: 'var(--bg-base)', border: '2px solid var(--gold)' }}
                  >
                    <span className="text-xs font-semibold" style={{ color: 'var(--gold)', ...mono }}>{s.n}</span>
                  </div>
                  <div className="flex-1 pt-3">
                    <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-bright)', ...serif }}>
                      {s.label}
                    </h3>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{s.sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURE DEEP-DIVE 1: Literature ──────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'var(--border-faint)' }}>
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-medium tracking-widest uppercase mb-4"
              style={{ color: 'var(--gold)', ...mono }}>Literature Search</p>
            <h2 className="text-4xl font-light leading-tight mb-5" style={{ ...serif, color: 'var(--text-bright)' }}>
              Discover and summarize<br />the evidence base
            </h2>
            <p className="text-base leading-relaxed mb-6" style={{ color: 'var(--text-secondary)' }}>
              Enter your research question and First Quill retrieves papers from PubMed, Semantic Scholar, and arXiv.
              Each paper gets an AI summary and relevance score — so you only read what matters.
            </p>
            <ul className="space-y-3">
              {['Relevance-scored retrieval across multiple databases', 'Structured per-paper summaries with key findings', 'BibTeX export saved to your project folder', 'AI-expanded query for broader coverage'].map(item => (
                <li key={item} className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--gold)' }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <LiteratureMockup />
          </div>
        </div>
      </section>

      {/* ── FEATURE DEEP-DIVE 2: Drafting ────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div className="order-2 lg:order-1">
            <DraftMockup />
          </div>
          <div className="order-1 lg:order-2">
            <p className="text-xs font-medium tracking-widest uppercase mb-4"
              style={{ color: 'var(--gold)', ...mono }}>Manuscript Drafting</p>
            <h2 className="text-4xl font-light leading-tight mb-5" style={{ ...serif, color: 'var(--text-bright)' }}>
              Write for your<br />target journal
            </h2>
            <p className="text-base leading-relaxed mb-6" style={{ color: 'var(--text-secondary)' }}>
              Select any of 50+ journals and 12 article types. First Quill drafts a complete manuscript
              formatted to that journal's exact requirements — word limits, section structure, citation style, and abstract format.
            </p>
            <ul className="space-y-3">
              {['50+ journal styles (NEJM, Nature, Cell, Lancet, PLOS ONE...)', 'PRISMA / CARE / CONSORT guidance embedded', 'CSL-based reference formatting (AMA, Vancouver, APA...)', 'Approved title gate before drafting'].map(item => (
                <li key={item} className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--gold)' }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── FEATURE DEEP-DIVE 3: Revision ─────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'var(--border-faint)' }}>
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-medium tracking-widest uppercase mb-4"
              style={{ color: 'var(--gold)', ...mono }}>Peer Review Revision</p>
            <h2 className="text-4xl font-light leading-tight mb-5" style={{ ...serif, color: 'var(--text-bright)' }}>
              Respond to reviewers<br />professionally
            </h2>
            <p className="text-base leading-relaxed mb-6" style={{ color: 'var(--text-secondary)' }}>
              Upload your reviewer decision letter. First Quill parses every comment, drafts a polished
              point-by-point response, and produces a revised manuscript with track changes — ready to resubmit.
            </p>
            <ul className="space-y-3">
              {['Structured parsing of reviewer decision letters (.docx or text)', 'AI-suggested response for each comment', 'Revised manuscript with real OOXML track changes', 'Download: response letter, clean .docx, track-changes .docx'].map(item => (
                <li key={item} className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--gold)' }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <RevisionMockup />
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────────── */}
      <section className="py-24 border-t" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="max-w-2xl mx-auto px-6 text-center">
          <img src={appLogo} alt="First Quill" className="w-16 h-16 object-contain mx-auto mb-6 opacity-90" />
          <h2 className="text-4xl lg:text-5xl font-light mb-4" style={{ ...serif, color: 'var(--text-bright)' }}>
            Start your first<br />research project today.
          </h2>
          <p className="text-base mb-8" style={{ color: 'var(--text-secondary)' }}>
            No credit card required. Set up your AI provider and start writing in minutes.
          </p>
          <button
            onClick={() => navigate('/intake')}
            className="btn-primary inline-flex items-center gap-2 px-8 py-3.5 rounded-lg text-sm font-semibold"
          >
            Start Writing Free
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </button>
        </div>
      </section>

      {/* ── FOOTER ───────────────────────────────────────────────────────────── */}
      <footer className="border-t py-8" style={{ borderColor: 'var(--border-faint)' }}>
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img src={appLogo} alt="First Quill" className="w-5 h-5 object-contain opacity-80" />
            <span className="text-sm font-medium" style={{ ...serif, color: 'var(--text-secondary)' }}>First Quill</span>
          </div>
          <div className="flex items-center gap-6">
            {[
              { label: 'Features', action: () => scrollTo('features') },
              { label: 'Pricing', action: () => navigate('/pricing') },
              { label: 'Get Started', action: () => navigate('/intake') },
            ].map(({ label, action }) => (
              <button key={label} onClick={action} className="text-xs transition-colors"
                style={{ color: 'var(--text-faint)', ...mono }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-faint)', ...mono }}>
            © 2026 First Quill. All rights reserved.
          </p>
        </div>
      </footer>

    </div>
  );
}
