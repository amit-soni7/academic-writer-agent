import { useNavigate } from 'react-router-dom';
import appLogo from '../../assets/firstquill-logo.png';
import ThemeToggle, { type ThemePreference } from '../ThemeToggle';

interface Props {
  themePref: ThemePreference;
  setThemePref: (t: ThemePreference) => void;
}

const serif = { fontFamily: '"Cormorant Garamond", Georgia, serif' };
const mono  = { fontFamily: '"JetBrains Mono", Menlo, monospace' };

// ── Shared nav ───────────────────────────────────────────────────────────────

function NavLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-sm transition-colors"
      style={{ color: 'var(--text-secondary)' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-bright)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
    >
      {label}
    </button>
  );
}

// ── Plan data ────────────────────────────────────────────────────────────────

const FREE_FEATURES = [
  '1 active research project',
  'Literature search (up to 10 papers)',
  'Basic per-paper AI summaries',
  'Manuscript draft (standard format)',
  'Markdown export',
];

const FREE_LIMITATIONS = [
  'No cross-paper evidence synthesis',
  'No journal-aware formatting',
  'No peer review simulation',
  'No revision pipeline',
];

const PRO_FEATURES = [
  'Unlimited research projects',
  'Literature search (unlimited papers)',
  'AI cross-paper evidence synthesis',
  'Journal-aware drafting — 50+ journals',
  '12 article types (PRISMA, CARE, CONSORT…)',
  'AI peer review simulation',
  'Revision pipeline with .docx export',
  'Real OOXML track-changes download',
  'Point-by-point response letter',
  'BibTeX auto-saved to project folder',
  'Priority AI processing',
  'All future features included',
];

const FAQS = [
  {
    q: 'What AI provider does First Quill use?',
    a: 'First Quill works with your own API key — Gemini, OpenAI, or other compatible providers. You bring your key, we build the pipeline around it. Your key is encrypted at rest.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Cancel any time from your account settings and your subscription stops at the end of the billing period. No questions asked.',
  },
  {
    q: 'Is my research data private?',
    a: 'Your manuscripts, notes, and project data are stored securely in your account and never shared or used to train any model.',
  },
  {
    q: 'What journals are supported?',
    a: 'Over 50 curated journals including NEJM, Nature, Cell, The Lancet, PLOS ONE, Frontiers, eLife, BMJ, and more — plus publisher-family defaults for thousands more.',
  },
  {
    q: 'Do I need a credit card to start the free plan?',
    a: 'No. Sign up with Google and start immediately. A card is only required when you upgrade to Pro.',
  },
];

// ── Main page ────────────────────────────────────────────────────────────────

export default function PricingPage({ themePref, setThemePref }: Props) {
  const navigate = useNavigate();

  return (
    <div style={{ background: 'var(--bg-base)', color: 'var(--text-body)', minHeight: '100vh' }}>

      {/* NAV */}
      <nav
        className="sticky top-0 z-40 border-b"
        style={{ background: 'color-mix(in srgb, var(--bg-base) 88%, transparent)', backdropFilter: 'blur(12px)', borderColor: 'var(--border-faint)' }}
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2.5"
          >
            <img src={appLogo} alt="First Quill" className="w-7 h-7 object-contain" />
            <span className="text-lg font-semibold" style={{ ...serif, color: 'var(--gold)' }}>
              First Quill
            </span>
          </button>

          <div className="hidden md:flex items-center gap-6">
            <NavLink label="Features" onClick={() => navigate('/#features')} />
            <NavLink label="How It Works" onClick={() => navigate('/#pipeline')} />
            <NavLink label="Pricing" onClick={() => {}} />
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle value={themePref} onChange={setThemePref} compact />
            <button
              onClick={() => navigate('/intake')}
              className="text-sm font-medium px-4 py-1.5 rounded-lg"
              style={{ background: 'var(--gold)', color: '#fff' }}
            >
              Get Started
            </button>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="pt-20 pb-16 text-center px-6">
        <p className="text-xs font-medium tracking-widest uppercase mb-4"
          style={{ color: 'var(--gold)', ...mono }}>Pricing</p>
        <h1 className="text-5xl font-light mb-4 animate-in delay-0"
          style={{ ...serif, color: 'var(--text-bright)' }}>
          Simple, transparent pricing.
        </h1>
        <p className="text-lg max-w-md mx-auto animate-in delay-75"
          style={{ color: 'var(--text-secondary)' }}>
          Start free. Upgrade when you need the full pipeline.
          No hidden fees, no per-paper charges.
        </p>
      </section>

      {/* PRICING CARDS */}
      <section className="pb-24 px-6">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6 items-start">

          {/* Free plan */}
          <div
            className="rounded-2xl border p-8"
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-faint)' }}
          >
            <div className="mb-6">
              <p className="text-xs font-medium uppercase tracking-widest mb-2"
                style={{ color: 'var(--text-muted)', ...mono }}>Free</p>
              <div className="flex items-end gap-1">
                <span className="text-5xl font-light" style={{ ...serif, color: 'var(--text-bright)' }}>$0</span>
                <span className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>/month</span>
              </div>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                Get started with the core pipeline at no cost.
              </p>
            </div>

            <button
              onClick={() => navigate('/intake')}
              className="w-full py-2.5 rounded-lg text-sm font-medium border mb-8 transition-colors"
              style={{ borderColor: 'var(--border-solid)', color: 'var(--text-body)', background: 'transparent' }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              Start for free
            </button>

            <div className="space-y-3 mb-6">
              {FREE_FEATURES.map(f => (
                <div key={f} className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    style={{ color: 'var(--gold)' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </div>
              ))}
            </div>

            <div className="pt-6 border-t space-y-3" style={{ borderColor: 'var(--border-faint)' }}>
              {FREE_LIMITATIONS.map(f => (
                <div key={f} className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--text-faint)' }}>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    style={{ color: 'var(--text-faint)' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  {f}
                </div>
              ))}
            </div>
          </div>

          {/* Pro plan */}
          <div
            className="rounded-2xl p-8 relative overflow-hidden"
            style={{ background: 'var(--gold)', color: '#fff' }}
          >
            {/* Background decoration */}
            <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full opacity-10"
              style={{ background: '#fff' }} />
            <div className="absolute -bottom-8 -left-8 w-32 h-32 rounded-full opacity-5"
              style={{ background: '#fff' }} />

            <div className="relative">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-xs font-medium uppercase tracking-widest opacity-80" style={mono}>Pro</p>
                    <span
                      className="text-[9px] px-2 py-0.5 rounded-full font-medium"
                      style={{ background: 'rgba(255,255,255,0.2)', ...mono }}
                    >
                      Most Popular
                    </span>
                  </div>
                  <div className="flex items-end gap-1">
                    <span className="text-5xl font-light" style={serif}>$20</span>
                    <span className="text-sm mb-2 opacity-80">/month</span>
                  </div>
                  <p className="text-sm mt-2 opacity-80">
                    Full pipeline. Unlimited projects. Every feature.
                  </p>
                </div>
              </div>

              <button
                onClick={() => navigate('/intake')}
                className="w-full py-2.5 rounded-lg text-sm font-semibold mb-8 transition-all"
                style={{ background: '#fff', color: 'var(--gold)' }}
                onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.opacity = '0.92'}
                onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.opacity = '1'}
              >
                Get started with Pro
              </button>

              <div className="space-y-3">
                {PRO_FEATURES.map(f => (
                  <div key={f} className="flex items-center gap-2.5 text-sm" style={{ color: 'rgba(255,255,255,0.92)' }}>
                    <svg className="w-4 h-4 shrink-0 opacity-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Billing note */}
        <p className="text-center text-xs mt-8" style={{ color: 'var(--text-muted)', ...mono }}>
          Billed monthly. Cancel anytime. Prices in USD.
        </p>
      </section>

      {/* FEATURE COMPARISON TABLE */}
      <section className="py-20 border-t px-6" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-light text-center mb-12" style={{ ...serif, color: 'var(--text-bright)' }}>
            Compare plans
          </h2>

          <div className="rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border-faint)' }}>
            {/* Header */}
            <div className="grid grid-cols-3 text-xs font-medium uppercase tracking-widest"
              style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-faint)', ...mono }}>
              <div className="px-6 py-4" style={{ color: 'var(--text-muted)' }}>Feature</div>
              <div className="px-6 py-4 text-center" style={{ color: 'var(--text-muted)' }}>Free</div>
              <div className="px-6 py-4 text-center" style={{ color: 'var(--gold)' }}>Pro · $20/mo</div>
            </div>

            {[
              { label: 'Research projects',        free: '1',         pro: 'Unlimited' },
              { label: 'Literature search',        free: '10 papers', pro: 'Unlimited' },
              { label: 'Per-paper AI summaries',   free: true,        pro: true },
              { label: 'Evidence synthesis',       free: false,       pro: true },
              { label: 'Journal-aware drafting',   free: false,       pro: '50+ journals' },
              { label: 'Article types',            free: '1 (basic)', pro: '12 types' },
              { label: 'AI peer review',           free: false,       pro: true },
              { label: 'Revision pipeline',        free: false,       pro: true },
              { label: 'Track-changes .docx',      free: false,       pro: true },
              { label: 'Response letter export',   free: false,       pro: true },
              { label: 'BibTeX export',            free: true,        pro: true },
              { label: 'Priority AI processing',   free: false,       pro: true },
            ].map((row, i) => (
              <div
                key={row.label}
                className="grid grid-cols-3 text-sm border-t"
                style={{ borderColor: 'var(--border-faint)', background: i % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-base)' }}
              >
                <div className="px-6 py-3.5" style={{ color: 'var(--text-body)' }}>{row.label}</div>
                <div className="px-6 py-3.5 flex items-center justify-center">
                  {typeof row.free === 'boolean' ? (
                    row.free
                      ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--gold)' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                      : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--text-faint)' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', ...mono, fontSize: 11 }}>{row.free}</span>
                  )}
                </div>
                <div className="px-6 py-3.5 flex items-center justify-center">
                  {typeof row.pro === 'boolean' ? (
                    row.pro
                      ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--gold)' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                      : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--text-faint)' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  ) : (
                    <span className="font-medium" style={{ color: 'var(--gold)', ...mono, fontSize: 11 }}>{row.pro}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 border-t px-6" style={{ borderColor: 'var(--border-faint)' }}>
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-light text-center mb-12" style={{ ...serif, color: 'var(--text-bright)' }}>
            Frequently asked questions
          </h2>
          <div className="space-y-6">
            {FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6" style={{ borderColor: 'var(--border-faint)' }}>
                <h3 className="font-semibold text-base mb-2" style={{ color: 'var(--text-bright)' }}>{faq.q}</h3>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 border-t text-center px-6" style={{ borderColor: 'var(--border-faint)', background: 'var(--bg-surface)' }}>
        <h2 className="text-4xl font-light mb-4" style={{ ...serif, color: 'var(--text-bright)' }}>
          Ready to write your next paper?
        </h2>
        <p className="text-base mb-8" style={{ color: 'var(--text-secondary)' }}>
          Start free. No credit card required.
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
      </section>

      {/* FOOTER */}
      <footer className="border-t py-8 px-6" style={{ borderColor: 'var(--border-faint)' }}>
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <button onClick={() => navigate('/')} className="flex items-center gap-2.5">
            <img src={appLogo} alt="First Quill" className="w-5 h-5 object-contain opacity-80" />
            <span className="text-sm font-medium" style={{ ...serif, color: 'var(--text-secondary)' }}>First Quill</span>
          </button>
          <div className="flex items-center gap-6">
            <button onClick={() => navigate('/')} className="text-xs transition-colors"
              style={{ color: 'var(--text-faint)', ...mono }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}>
              Home
            </button>
            <button onClick={() => navigate('/pricing')} className="text-xs transition-colors"
              style={{ color: 'var(--text-faint)', ...mono }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}>
              Pricing
            </button>
            <button onClick={() => navigate('/intake')} className="text-xs transition-colors"
              style={{ color: 'var(--text-faint)', ...mono }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}>
              Sign In
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-faint)', ...mono }}>
            © 2026 First Quill. All rights reserved.
          </p>
        </div>
      </footer>

    </div>
  );
}
