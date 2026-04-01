import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { redirectToGoogleLogin } from '../../api/auth';
import appLogo from '../../assets/firstquill-logo.png';

const serif = { fontFamily: 'Newsreader, Georgia, serif' };
const mono  = { fontFamily: '"JetBrains Mono", Menlo, monospace' };

const BENEFITS = [
  'AI-powered literature search across PubMed, Semantic Scholar & arXiv',
  'Cross-paper evidence synthesis for your research question',
  'Journal-aware manuscript drafting — 50+ journals, 12 article types',
  'Peer review simulation + revision pipeline with .docx export',
];

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Sign-in was cancelled. Please try again.',
  csrf_failed: 'Security check failed. Please try again.',
  no_code: 'Something went wrong. Please try again.',
  exchange_failed: 'Could not complete sign-in. Please try again.',
};

export default function LoginPage() {
  const navigate = useNavigate();

  const oauthError = useMemo(() => {
    const hash = window.location.hash; // e.g. #/login?error=access_denied
    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return null;
    const params = new URLSearchParams(hash.slice(qIdx));
    return params.get('error');
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
            {/* OAuth error banner */}
            {oauthError && (
              <div
                className="rounded-lg px-4 py-3 mb-6 text-sm"
                style={{ background: 'rgba(220, 38, 38, 0.08)', color: '#dc2626', border: '1px solid rgba(220, 38, 38, 0.2)' }}
              >
                {ERROR_MESSAGES[oauthError] || 'Something went wrong. Please try again.'}
              </div>
            )}

            {/* Google Sign-In button */}
            <div className="flex justify-center mb-6">
              <button
                onClick={() => redirectToGoogleLogin()}
                className="flex items-center gap-3 px-6 py-3 rounded-lg border transition-colors"
                style={{
                  background: '#fff',
                  borderColor: 'var(--border-faint)',
                  color: '#3c4043',
                  fontFamily: '"Roboto", sans-serif',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  width: 320,
                  justifyContent: 'center',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f8f9fa')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
              >
                <svg width="18" height="18" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Sign in with Google
              </button>
            </div>

            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 h-px" style={{ background: 'var(--border-faint)' }} />
              <span className="text-xs" style={{ color: 'var(--text-faint)', ...mono }}>secure sign-in</span>
              <div className="flex-1 h-px" style={{ background: 'var(--border-faint)' }} />
            </div>

            {/* Trust indicators */}
            <div className="space-y-2.5">
              {[
                { icon: '\u{1F512}', text: 'Your data is encrypted and never shared' },
                { icon: '\u2726', text: 'Free to start \u00B7 No credit card required' },
                { icon: '\u21BA', text: 'Cancel or sign out anytime' },
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
              \u2190 Back to firstquill.com
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
