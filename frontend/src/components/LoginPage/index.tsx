import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import appLogo from '../../assets/firstquill-logo.png';

const serif = { fontFamily: '"Cormorant Garamond", Georgia, serif' };
const mono  = { fontFamily: '"JetBrains Mono", Menlo, monospace' };

const BENEFITS = [
  'AI-powered literature search across PubMed, Semantic Scholar & arXiv',
  'Cross-paper evidence synthesis for your research question',
  'Journal-aware manuscript drafting — 50+ journals, 12 article types',
  'Peer review simulation + revision pipeline with .docx export',
];

export default function LoginPage() {
  const navigate = useNavigate();

  // Render the Google Sign-In button — poll until GIS script is ready
  useEffect(() => {
    let tries = 0;
    const attempt = () => {
      const google = (window as any).google;
      const btn = document.getElementById('gis-login-btn');
      if (google?.accounts?.id && btn) {
        google.accounts.id.renderButton(btn, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 320,
        });
      } else if (tries++ < 30) {
        // GIS script or DOM not ready yet — retry
        setTimeout(attempt, 200);
      }
    };
    attempt();
  }, []);

  return (
    <div
      className="min-h-screen flex"
      style={{ background: 'var(--bg-base)', color: 'var(--text-body)' }}
    >
      {/* ── Left panel — branding ───────────────────────────────────────────── */}
      <div
        className="hidden lg:flex flex-col justify-between w-[480px] shrink-0 p-12"
        style={{ background: 'var(--gold)', color: '#fff' }}
      >
        {/* Logo */}
        <button onClick={() => navigate('/')} className="flex items-center gap-3">
          <img src={appLogo} alt="First Quill" className="w-10 h-10 object-contain" />
          <span className="text-xl font-semibold" style={serif}>First Quill</span>
        </button>

        {/* Mid */}
        <div>
          <h2 className="text-4xl font-light leading-snug mb-6" style={serif}>
            The intelligent<br />academic writing<br />pipeline.
          </h2>
          <ul className="space-y-4">
            {BENEFITS.map(b => (
              <li key={b} className="flex items-start gap-3 text-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
                <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                {b}
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.5)', ...mono }}>
          © 2026 First Quill · All rights reserved
        </p>
      </div>

      {/* ── Right panel — sign in ────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">

        {/* Mobile logo */}
        <button
          onClick={() => navigate('/')}
          className="lg:hidden flex items-center gap-2.5 mb-10"
        >
          <img src={appLogo} alt="First Quill" className="w-8 h-8 object-contain" />
          <span className="text-xl font-semibold" style={{ ...serif, color: 'var(--gold)' }}>First Quill</span>
        </button>

        <div className="w-full max-w-sm">

          {/* Heading */}
          <div className="mb-8">
            <h1 className="text-3xl font-light mb-2" style={{ ...serif, color: 'var(--text-bright)' }}>
              Sign in to continue
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Use your Google account to access First Quill.
            </p>
          </div>

          {/* Card */}
          <div
            className="rounded-2xl border p-8"
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-faint)' }}
          >
            {/* GIS button container */}
            <div className="flex justify-center mb-6">
              <div id="gis-login-btn" />
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px" style={{ background: 'var(--border-faint)' }} />
              <span className="text-xs" style={{ color: 'var(--text-faint)', ...mono }}>secure sign-in</span>
              <div className="flex-1 h-px" style={{ background: 'var(--border-faint)' }} />
            </div>

            {/* Trust indicators */}
            <div className="space-y-2.5">
              {[
                { icon: '🔒', text: 'Your data is encrypted and never shared' },
                { icon: '✦', text: 'Free to start · No credit card required' },
                { icon: '↺', text: 'Cancel or sign out anytime' },
              ].map(({ icon, text }) => (
                <div key={text} className="flex items-center gap-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span className="w-4 text-center text-sm">{icon}</span>
                  {text}
                </div>
              ))}
            </div>
          </div>

          {/* Back link */}
          <div className="mt-6 text-center">
            <button
              onClick={() => navigate('/')}
              className="text-xs transition-colors"
              style={{ color: 'var(--text-faint)', ...mono }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}
            >
              ← Back to firstquill.com
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
