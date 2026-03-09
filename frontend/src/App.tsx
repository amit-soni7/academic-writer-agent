import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { getMe, loginWithGoogle, logout as logoutApi } from './api/auth';
import ArticleWriter, { type MainTab } from './components/ArticleWriter';
import CrossReferenceDashboard from './components/CrossReferenceDashboard';
import IntakeForm from './components/IntakeForm';
import JournalsDashboard from './components/JournalsDashboard';
import LiteratureDashboard from './components/LiteratureDashboard';
import ProjectsList from './components/ProjectsList';
import RealRevisionPanel, { type StepId } from './components/RealRevisionPanel';
import SettingsPanel from './components/SettingsPanel';
import { createProject, listProjects, loadProject } from './api/projects';
import type { ProjectData } from './api/projects';
import type { ProjectMeta } from './types/paper';
import { fetchSettings, type AISettings } from './api/settings';
import appLogo from './assets/firstquill-logo.png';
import ThemeToggle, { type ThemePreference } from './components/ThemeToggle';
import LandingPage from './components/LandingPage';
import PricingPage from './components/PricingPage';
import LoginPage from './components/LoginPage';
import type { WritingType } from './types/intent';
import type { RevisionIntakeData } from './types/paper';

type SidebarMode = 'hidden' | 'compact' | 'full';

const PROJECT_STORAGE_KEY = 'awa_last_project_id';
const THEME_STORAGE_KEY   = 'awa_theme_pref';

function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

// ── App context ────────────────────────────────────────────────────────────────

interface AppCtx {
  setSettingsOpen: (v: boolean) => void;
  aiSettings: AISettings | null;
  isConfigured: boolean;
  authUserEmail: string | null;
  setAuthUserEmail: (v: string | null) => void;
  themePref: ThemePreference;
  setThemePref: (t: ThemePreference) => void;
}
const AppCtx = createContext<AppCtx>({
  setSettingsOpen: () => {},
  aiSettings: null,
  isConfigured: false,
  authUserEmail: null,
  setAuthUserEmail: () => {},
  themePref: 'system',
  setThemePref: () => {},
});
function useAppCtx() { return useContext(AppCtx); }

// ── Sidebar nav items ──────────────────────────────────────────────────────────

type PhaseSlug = 'intake' | 'literature' | 'cross-reference' | 'journals' | 'article' | 'revision';
const PHASE_NAV_ITEMS: { id: PhaseSlug; label: string; icon: ReactNode }[] = [
  {
    id: 'intake',
    label: 'Intake',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'literature',
    label: 'Literature',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 16v-2m8-6h-2M6 12H4m11.314-5.314l-1.414 1.414M8.1 15.9l-1.414 1.414m0-10.628L8.1 8.1m7.214 7.214l1.414 1.414M12 16a4 4 0 100-8 4 4 0 000 8z" />
      </svg>
    ),
  },
  {
    id: 'cross-reference',
    label: 'Cross Reference',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h8m-8 10h8M7 7a2 2 0 100-4 2 2 0 000 4zm10 14a2 2 0 100-4 2 2 0 000 4zM7 5v14a2 2 0 002 2h6" />
      </svg>
    ),
  },
  {
    id: 'journals',
    label: 'Journals',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19.5A2.5 2.5 0 016.5 17H20M6.5 17H20V5a2 2 0 00-2-2H6.5A2.5 2.5 0 004 5.5v14z" />
      </svg>
    ),
  },
  {
    id: 'article',
    label: 'Article',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h12a2 2 0 002-2v-5m-7-7l6 6m0 0V7m0 5h-5" />
      </svg>
    ),
  },
];

// ── Tab/step URL maps ──────────────────────────────────────────────────────────

const TAB_TO_URL: Record<MainTab, string> = {
  synthesis: 'synthesis',
  draft: 'draft',
  peerreview: 'peer-review',
  revision: 'revision',
};
const URL_TO_TAB: Record<string, MainTab> = {
  synthesis: 'synthesis',
  draft: 'draft',
  'peer-review': 'peerreview',
  revision: 'revision',
};

const STEP_TO_URL: Record<StepId, string> = {
  manuscript: 'manuscript',
  comments: 'comments',
  edit_comments: 'edit-comments',
  responses: 'responses',
  download: 'download',
};
const URL_TO_STEP: Record<string, StepId> = {
  manuscript: 'manuscript',
  comments: 'comments',
  'edit-comments': 'edit_comments',
  responses: 'responses',
  download: 'download',
};

// ── Loading spinner ────────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 rounded-full border-2 border-slate-200 opacity-20" />
        <div className="absolute inset-0 rounded-full border-2 border-t-brand-500 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
      </div>
      <span className="font-mono text-xs text-slate-400 tracking-widest uppercase">loading</span>
    </div>
  );
}

// ── Legacy redirect ────────────────────────────────────────────────────────────

function LegacyRedir({ phase }: { phase: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/projects/${id}/${phase}`} replace />;
}

// ── Page components ────────────────────────────────────────────────────────────

function IntakePage() {
  const navigate = useNavigate();
  const { setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail, themePref, setThemePref } = useAppCtx();
  const [showProjects, setShowProjects] = useState(false);

  async function handleIntakeComplete(idea: string, wt: WritingType, desc?: string) {
    navigate('/new/literature', { state: { keyIdea: idea, writingType: wt, projectDescription: desc } });
  }

  async function handleIntakeCompleteRevision(data: RevisionIntakeData) {
    try {
      const meta = await createProject(
        data.project_name || data.project_description || 'Revision project',
        [],
        undefined,
        data.project_description,
        data.project_name,
        'revision',
      );
      localStorage.setItem(PROJECT_STORAGE_KEY, meta.project_id);
      navigate(`/projects/${meta.project_id}/revision/manuscript`, { state: { initialData: data } });
    } catch {
      // navigate anyway
      navigate('/intake');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white animate-in delay-0">
        <div className="max-w-3xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={appLogo}
              alt="First Quill logo"
              className="w-7 h-7 rounded-md object-contain"
            />
            <span className="font-serif font-medium tracking-wide text-lg leading-none"
              style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--gold)' }}>
              First Quill
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 font-mono text-[10px] font-medium px-2.5 py-1 rounded border ${
              isConfigured
                ? 'border-green-200 bg-green-100 text-green-700'
                : 'border-slate-200 bg-slate-100 text-slate-500'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConfigured ? 'bg-green-500' : 'bg-slate-400'}`} />
              {isConfigured ? aiSettings!.model : 'AI not configured'}
            </div>

            <button
              onClick={async () => {
                try { await logoutApi(); } finally {
                  setAuthUserEmail(null);
                  navigate('/login');
                }
              }}
              className="font-mono text-[10px] font-medium text-slate-500 bg-slate-100 border border-slate-200
                px-2.5 py-1 rounded hover:bg-slate-200 transition-colors"
              title={authUserEmail ?? ''}
            >
              {authUserEmail ?? 'sign out'}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:bg-slate-200
                hover:text-slate-800 transition-colors border border-slate-200"
              title="AI Settings"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            <ThemeToggle value={themePref} onChange={setThemePref} compact />
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-4 py-12">
        <div className="w-full max-w-2xl space-y-4">

          {/* Hero heading */}
          <div className="animate-in delay-75 px-1 mb-6">
            <h1 className="font-serif text-4xl font-light leading-tight"
              style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--text-bright)' }}>
              New Research Project
            </h1>
            <p className="text-slate-500 text-sm mt-2 leading-relaxed">
              Three questions to configure your AI-powered writing pipeline.
            </p>
          </div>

          {!isConfigured && (
            <div className="animate-in delay-100">
              <button
                onClick={() => setSettingsOpen(true)}
                className="w-full text-left text-xs text-amber-600 bg-amber-100 border border-amber-200
                  rounded-lg px-4 py-3 hover:bg-amber-200 transition-colors flex items-center gap-2.5"
              >
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Configure an AI provider to enable query expansion and smart summaries
                <span className="ml-auto text-amber-500">→</span>
              </button>
            </div>
          )}

          {/* Main form card */}
          <div className="animate-in delay-150 bg-white rounded-xl border border-slate-200 p-8 sm:p-10"
            style={{ boxShadow: '0 4px 32px rgba(0,0,0,0.35), 0 1px 6px rgba(0,0,0,0.25)' }}>
            <IntakeForm onComplete={handleIntakeComplete} onCompleteRevision={handleIntakeCompleteRevision} />
          </div>

          {/* Previous projects */}
          <div className="animate-in delay-250 bg-white rounded-xl border border-slate-200 overflow-hidden"
            style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.25)' }}>
            <button
              onClick={() => setShowProjects((v) => !v)}
              className="w-full flex items-center justify-between px-5 py-3.5 text-sm font-medium
                text-slate-600 hover:bg-slate-200 transition-colors"
            >
              <span className="flex items-center gap-2 text-xs font-mono tracking-wide uppercase text-slate-500">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Previous Projects
              </span>
              <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${showProjects ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showProjects && (
              <ProjectsList
                onResume={(projectId, _query, projectType) => {
                  localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
                  if (projectType === 'revision') {
                    navigate(`/projects/${projectId}/revision/manuscript`);
                  } else {
                    navigate(`/projects/${projectId}/literature`);
                  }
                }}
              />
            )}
          </div>

          <p className="animate-in delay-350 text-center font-mono text-[10px] text-slate-400 tracking-wider uppercase">
            All processing is local · No third-party data sharing during intake
          </p>
        </div>
      </main>
    </div>
  );
}

function NewLiteraturePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setSettingsOpen } = useAppCtx();
  const state = location.state as { keyIdea?: string; writingType?: WritingType; projectDescription?: string } | null;

  if (!state?.keyIdea) return <Navigate to="/" replace />;

  return (
    <LiteratureDashboard
      initialQuery={state.keyIdea}
      articleType={state.writingType ?? undefined}
      projectDescription={state.projectDescription}
      onBack={() => navigate('/')}
      onOpenSettings={() => setSettingsOpen(true)}
      onGoToJournals={(pid) => {
        localStorage.setItem(PROJECT_STORAGE_KEY, pid);
        navigate(`/projects/${pid}/cross-reference`);
      }}
      onSessionCreated={(pid) => {
        localStorage.setItem(PROJECT_STORAGE_KEY, pid);
        navigate(`/projects/${pid}/literature`, { replace: true });
      }}
    />
  );
}

function LiteraturePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  const [proj, setProj] = useState<ProjectData | null>(null);

  useEffect(() => {
    loadProject(id!).then(setProj).catch(() => navigate('/'));
  }, [id]);

  if (!proj) return <LoadingSpinner />;

  return (
    <LiteratureDashboard
      initialQuery={proj.query}
      articleType={proj.article_type ?? undefined}
      projectDescription={proj.project_description ?? undefined}
      onBack={() => navigate('/')}
      onOpenSettings={() => setSettingsOpen(true)}
      onGoToJournals={(pid) => navigate(`/projects/${pid}/cross-reference`)}
      onSessionCreated={(pid) => navigate(`/projects/${pid}/literature`, { replace: true })}
    />
  );
}

function CrossReferencePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();

  return (
    <CrossReferenceDashboard
      sessionId={id!}
      onBack={() => navigate(`/projects/${id}/literature`)}
      onGoToJournals={(pid) => navigate(`/projects/${pid}/journals`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function JournalsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();

  return (
    <JournalsDashboard
      sessionId={id!}
      onBack={() => navigate(`/projects/${id}/cross-reference`)}
      onGoToWrite={(pid, journal) => navigate(`/projects/${pid}/article/synthesis`, { state: { journal } })}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function ArticlePage() {
  const { id, tab } = useParams<{ id: string; tab: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { setSettingsOpen } = useAppCtx();
  const [proj, setProj] = useState<ProjectData | null>(null);

  useEffect(() => { loadProject(id!).then(setProj).catch(() => navigate('/')); }, [id]);
  if (!proj) return <LoadingSpinner />;

  const stateJournal = (location.state as any)?.journal;
  const activeTab: MainTab = URL_TO_TAB[tab ?? ''] ?? 'synthesis';

  return (
    <ArticleWriter
      sessionId={id!}
      selectedJournal={stateJournal ?? proj.selected_journal ?? ''}
      initialArticleType={proj.article_type ?? undefined}
      activeTab={activeTab}
      onTabChange={(t) => navigate(`/projects/${id}/article/${TAB_TO_URL[t]}`, { replace: true })}
      onBack={() => navigate(`/projects/${id}/journals`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function RevisionPage() {
  const { id, step } = useParams<{ id: string; step: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { setSettingsOpen } = useAppCtx();
  const initialData = (location.state as any)?.initialData as RevisionIntakeData | undefined;
  const activeStep: StepId = URL_TO_STEP[step ?? ''] ?? 'manuscript';

  return (
    <RealRevisionPanel
      projectId={id!}
      initialData={initialData}
      activeStep={activeStep}
      onStepChange={(s) => navigate(`/projects/${id}/revision/${STEP_TO_URL[s]}`, { replace: true })}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const [settingsOpen, setSettingsOpen]   = useState(false);
  const [aiSettings, setAiSettings]       = useState<AISettings | null>(null);
  const [authUserEmail, setAuthUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading]     = useState(true);
  const [sidebarMode, setSidebarMode]     = useState<SidebarMode>('full');
  const [recentProjects, setRecentProjects] = useState<ProjectMeta[]>([]);
  const [themePref, setThemePref]         = useState<ThemePreference>(
    () => (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null) ?? 'system'
  );

  const navigate   = useNavigate();
  const location   = useLocation();

  // Apply theme immediately and on change
  useEffect(() => {
    applyTheme(themePref);
    localStorage.setItem(THEME_STORAGE_KEY, themePref);
  }, [themePref]);

  // Listen for OS theme changes when preference is "system"
  useEffect(() => {
    if (themePref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themePref]);

  useEffect(() => {
    getMe()
      .then((user) => setAuthUserEmail(user.email))
      .catch(() => setAuthUserEmail(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    fetchSettings().then((s) => setAiSettings(s)).catch(() => {});
  }, []);

  // Refresh project list whenever auth is ready or user navigates
  useEffect(() => {
    if (!authUserEmail) return;
    listProjects().then(setRecentProjects).catch(() => {});
  }, [authUserEmail, location.pathname]);

  const isConfigured = Boolean(
    aiSettings?.api_key ||
    aiSettings?.has_api_key ||
    aiSettings?.provider_configs?.gemini?.oauth_connected,
  );

  const sidebarWidthClass = sidebarMode === 'full'
    ? 'lg:grid-cols-[248px_minmax(0,1fr)]'
    : sidebarMode === 'compact'
      ? 'lg:grid-cols-[72px_minmax(0,1fr)]'
      : 'lg:grid-cols-[0px_minmax(0,1fr)]';
  const isSidebarVisible = sidebarMode !== 'hidden';
  const isSidebarCompact = sidebarMode === 'compact';
  const showSidebarText  = sidebarMode === 'full';

  function cycleSidebarMode() {
    setSidebarMode((prev) => (prev === 'hidden' ? 'compact' : prev === 'compact' ? 'full' : 'hidden'));
  }

  // Derive active phase and project ID from current URL for sidebar highlight
  function urlPhase(): PhaseSlug {
    const p = location.pathname;
    if (p === '/intake' || p === '/' || p === '') return 'intake';
    const m = p.match(/^\/projects\/[^/]+\/(literature|cross-reference|journals|article|revision)/);
    return (m?.[1] as PhaseSlug) ?? 'intake';
  }

  function urlProjectId(): string | null {
    const m = location.pathname.match(/^\/projects\/([^/]+)/);
    return m?.[1] ?? null;
  }

  function handleSidebarNav(id: PhaseSlug) {
    if (id === 'intake') { navigate('/intake'); return; }
    const lastId = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (lastId) navigate(`/projects/${lastId}/${id}`);
  }

  const activePhase     = urlPhase();
  const activeProjectId = urlProjectId();

  const PUBLIC_PATHS = ['/', '/pricing', '/login'];
  const isPublicPage = PUBLIC_PATHS.includes(location.pathname);

  // Public marketing + auth pages — no sidebar
  if (isPublicPage) {
    return (
      <AppCtx.Provider value={{ setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail, themePref, setThemePref }}>
        <Routes>
          <Route path="/" element={<LandingPage themePref={themePref} setThemePref={setThemePref} />} />
          <Route path="/pricing" element={<PricingPage themePref={themePref} setThemePref={setThemePref} />} />
          <Route path="/login" element={
            // Already logged in → skip login page
            !authLoading && authUserEmail
              ? <Navigate to="/intake" replace />
              : <LoginPage />
          } />
        </Routes>
      </AppCtx.Provider>
    );
  }

  // Auth guard: while checking session show spinner; if unauthenticated redirect to login
  if (authLoading) return <LoadingSpinner />;
  if (!authUserEmail) return <Navigate to="/login" replace />;

  return (
    <AppCtx.Provider value={{ setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail, themePref, setThemePref }}>
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => { setAiSettings(s); setSettingsOpen(false); }}
      />

      {sidebarMode === 'hidden' && (
        <button
          type="button"
          onClick={cycleSidebarMode}
          className="hidden lg:inline-flex fixed top-4 left-4 z-30 w-9 h-9 items-center justify-center
            rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 transition-colors"
          style={{ background: 'var(--bg-surface)' }}
          aria-label="Open navigation"
          title="Open navigation"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      <div className={`h-screen overflow-hidden grid grid-cols-1 ${sidebarWidthClass} transition-[grid-template-columns] duration-300 ease-in-out`}>
        <aside
          className={`hidden lg:flex lg:flex-col border-r border-slate-200 transition-[width,border-color] duration-300 ease-in-out overflow-hidden ${
            isSidebarVisible ? '' : 'lg:border-r-0'
          }`}
          style={{ background: 'var(--bg-surface)' }}
        >
          <div className="h-full flex flex-col">
              {/* Sidebar header */}
              <div className="px-4 py-4 border-b border-slate-200">
                <div className={`flex items-center transition-all duration-300 ${isSidebarCompact ? 'justify-center' : 'gap-3'}`}>
                  <button
                    type="button"
                    onClick={cycleSidebarMode}
                    className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-slate-500
                      hover:text-slate-700 hover:bg-slate-200 transition-colors"
                    aria-label="Navigation menu"
                    title="Navigation"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </button>
                  <div
                    className={`min-w-0 overflow-hidden transition-all duration-300 ease-in-out ${
                      showSidebarText ? 'max-w-[160px] opacity-100 translate-x-0' : 'max-w-0 opacity-0 -translate-x-1'
                    }`}
                    aria-hidden={!showSidebarText}
                  >
                    <div className="flex items-center gap-2">
                      <img
                        src={appLogo}
                        alt="First Quill logo"
                        className="w-4 h-4 rounded-sm object-contain"
                      />
                      <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-slate-400">Researcher</p>
                    </div>
                    <h2
                      className="text-base font-medium leading-tight mt-0.5"
                      style={{
                        fontFamily: '"Cormorant Garamond", Georgia, serif',
                        color: 'var(--gold)',
                      }}
                    >
                      First Quill
                    </h2>
                  </div>
                </div>
              </div>

              {/* Nav items */}
              <nav
                className={`p-2 space-y-0.5 flex-shrink-0 transition-opacity duration-200 ${
                  isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              >
                {PHASE_NAV_ITEMS.map(({ id, label, icon }, idx) => {
                  const isActive = id === 'article'
                    ? activePhase === 'article'
                    : id === 'revision'
                      ? activePhase === 'revision'
                      : activePhase === id;
                  return (
                    <button
                      key={id}
                      onClick={() => handleSidebarNav(id)}
                      className={`
                        w-full flex items-center ${isSidebarCompact ? 'justify-center px-0' : 'gap-3 px-3'}
                        py-2.5 rounded-lg text-sm font-medium text-left
                        transition-all duration-200 border-l-2 animate-in
                        ${isActive ? '' : 'border-transparent text-slate-500 hover:bg-slate-200 hover:text-slate-700'}
                      `}
                      style={{
                        animationDelay: `${idx * 60}ms`,
                        ...(isActive ? {
                          borderLeftColor: 'var(--gold)',
                          background: 'var(--gold-faint)',
                          color: 'var(--gold)',
                        } : {}),
                      }}
                      title={label}
                    >
                      <span
                        className="inline-flex items-center justify-center flex-shrink-0 transition-colors"
                        style={{ color: isActive ? 'var(--gold)' : undefined }}
                      >
                        {icon}
                      </span>
                      <span
                        className={`truncate overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${
                          showSidebarText ? 'max-w-[120px] opacity-100' : 'max-w-0 opacity-0'
                        }`}
                        aria-hidden={!showSidebarText}
                      >
                        {label}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* Spacer when no projects (keeps footer at bottom) */}
              {recentProjects.length === 0 && <div className="flex-1" />}

              {/* Recent projects — separated by type */}
              {recentProjects.length > 0 && (() => {
                const writeProjects    = recentProjects.filter((p) => p.project_type !== 'revision');
                const revisionProjects = recentProjects.filter((p) => p.project_type === 'revision');

                // Resolve where to resume based on project type + current phase
                function getResumeDest(proj: ProjectMeta): string {
                  if (proj.project_type === 'revision') {
                    return 'revision/manuscript';
                  }
                  const phase = proj.current_phase ?? 'intake';
                  const map: Record<string, string> = {
                    intake:          'literature',
                    literature:      'literature',
                    cross_reference: 'cross-reference',
                    journals:        'journals',
                    article:         'article/synthesis',
                  };
                  return map[phase] ?? 'literature';
                }

                function PhaseLabel({ proj }: { proj: ProjectMeta }) {
                  if (proj.project_type === 'revision') return <span>Revision</span>;
                  const phase = proj.current_phase ?? 'intake';
                  const labels: Record<string, string> = {
                    intake: 'Intake', literature: 'Literature',
                    cross_reference: 'Cross Reference', journals: 'Journals',
                    article: 'Article',
                  };
                  return <span>{labels[phase] ?? phase}</span>;
                }

                function ProjectRow({ proj }: { proj: ProjectMeta }) {
                  const isCurrentProject = proj.project_id === activeProjectId;
                  const dest = getResumeDest(proj);
                  const displayName = proj.manuscript_title || proj.project_name || proj.query || 'Untitled';
                  return (
                    <button
                      key={proj.project_id}
                      onClick={() => navigate(`/projects/${proj.project_id}/${dest}`)}
                      title={displayName}
                      className={`w-full flex items-center rounded-lg transition-all duration-150 ${
                        isSidebarCompact ? 'justify-center px-0 py-2' : 'gap-2.5 px-3 py-2'
                      } ${isCurrentProject ? 'font-medium' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-700'}`}
                      style={isCurrentProject ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : {}}
                    >
                      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                        isCurrentProject ? 'bg-current' : 'bg-slate-300'
                      }`} />
                      <span className={`min-w-0 flex-1 text-left overflow-hidden transition-all duration-300 ${
                        showSidebarText ? 'opacity-100 max-w-full' : 'opacity-0 max-w-0'
                      }`} aria-hidden={!showSidebarText}>
                        <span className="block text-xs font-medium truncate leading-tight">{displayName}</span>
                        <span className="block text-[10px] text-slate-400 truncate">
                          <PhaseLabel proj={proj} />
                        </span>
                      </span>
                    </button>
                  );
                }

                return (
                  <div className={`flex-1 overflow-y-auto min-h-0 border-t border-slate-200 transition-opacity duration-200 ${
                    isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}>
                    {/* Write projects */}
                    {writeProjects.length > 0 && (
                      <>
                        {showSidebarText && (
                          <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-[0.15em] text-slate-400">
                            Research Projects
                          </p>
                        )}
                        <div className="px-2 pb-1 space-y-0.5">
                          {writeProjects.slice(0, 8).map((proj) => <ProjectRow key={proj.project_id} proj={proj} />)}
                        </div>
                      </>
                    )}
                    {/* Revision projects */}
                    {revisionProjects.length > 0 && (
                      <>
                        {showSidebarText && (
                          <p className={`px-4 pb-1 text-[9px] font-mono uppercase tracking-[0.15em] text-slate-400 ${
                            writeProjects.length > 0 ? 'pt-2 border-t border-slate-100 mt-1' : 'pt-3'
                          }`}>
                            Revisions
                          </p>
                        )}
                        <div className="px-2 pb-2 space-y-0.5">
                          {revisionProjects.slice(0, 6).map((proj) => <ProjectRow key={proj.project_id} proj={proj} />)}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Sidebar footer — theme toggle */}
              <div className="px-3 py-3 border-t border-slate-200">
                {isSidebarCompact ? (
                  /* Compact: single cycling icon button */
                  <button
                    type="button"
                    onClick={() => {
                      const next: ThemePreference = themePref === 'light' ? 'dark' : themePref === 'dark' ? 'system' : 'light';
                      setThemePref(next);
                    }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500
                      hover:bg-slate-200 hover:text-slate-700 transition-colors mx-auto"
                    title={`Theme: ${themePref}`}
                  >
                    {themePref === 'dark' ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                      </svg>
                    ) : themePref === 'light' ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                ) : (
                  /* Full: labeled 3-way toggle */
                  <div className="space-y-2">
                    <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-slate-400">
                      Appearance
                    </p>
                    <ThemeToggle value={themePref} onChange={setThemePref} />
                  </div>
                )}
              </div>
            </div>
        </aside>

        <div className="min-w-0 h-full overflow-y-auto">
          <Routes>
            <Route path="/intake"                        element={<IntakePage />} />
            <Route path="/new/literature"               element={<NewLiteraturePage />} />
            <Route path="/projects/:id/literature"      element={<LiteraturePage />} />
            <Route path="/projects/:id/cross-reference" element={<CrossReferencePage />} />
            <Route path="/projects/:id/journals"        element={<JournalsPage />} />
            <Route path="/projects/:id/article"         element={<Navigate to="synthesis" replace />} />
            <Route path="/projects/:id/article/:tab"    element={<ArticlePage />} />
            <Route path="/projects/:id/revision"        element={<Navigate to="manuscript" replace />} />
            <Route path="/projects/:id/revision/:step"  element={<RevisionPage />} />
            {/* Legacy redirects */}
            <Route path="/p/:id/literature"      element={<LegacyRedir phase="literature" />} />
            <Route path="/p/:id/cross_reference" element={<LegacyRedir phase="cross-reference" />} />
            <Route path="/p/:id/journals"        element={<LegacyRedir phase="journals" />} />
            <Route path="/p/:id/article"         element={<LegacyRedir phase="article/synthesis" />} />
            <Route path="/s/:id/*"               element={<LegacyRedir phase="literature" />} />
            <Route path="*"                      element={<Navigate to="/intake" replace />} />
          </Routes>
        </div>
      </div>
    </AppCtx.Provider>
  );
}

// ── GIS initialization (runs once on load) ────────────────────────────────────

declare global {
  interface Window { google?: any }
}

(() => {
  const tryInit = () => {
    const google = (window as any).google;
    if (!google?.accounts?.id) return;
    google.accounts.id.initialize({
      client_id: (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
      callback: async (resp: any) => {
        try {
          await loginWithGoogle(resp.credential);
          window.location.href = '/#/intake';   // HashRouter: hash prefix required
        } catch {}
      },
    });
    // LoginPage's useEffect handles renderButton — nothing to do here at init time
  };
  if (document.readyState === 'complete') tryInit();
  else window.addEventListener('load', tryInit);
})();
