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
import { createProject, loadProject } from './api/projects';
import type { ProjectData } from './api/projects';
import { fetchSettings, type AISettings } from './api/settings';
import appLogo from './assets/logo.png';
import type { WritingType } from './types/intent';
import type { RevisionIntakeData } from './types/paper';

type SidebarMode = 'hidden' | 'compact' | 'full';

const PROJECT_STORAGE_KEY = 'awa_last_project_id';

// ── App context ────────────────────────────────────────────────────────────────

interface AppCtx {
  setSettingsOpen: (v: boolean) => void;
  aiSettings: AISettings | null;
  isConfigured: boolean;
  authUserEmail: string | null;
  setAuthUserEmail: (v: string | null) => void;
}
const AppCtx = createContext<AppCtx>({
  setSettingsOpen: () => {},
  aiSettings: null,
  isConfigured: false,
  authUserEmail: null,
  setAuthUserEmail: () => {},
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
    <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
      Loading…
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
  const { setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail } = useAppCtx();
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
      navigate('/');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={appLogo}
              alt="Academic Writer Agent logo"
              className="w-8 h-8 rounded-lg object-contain bg-white border border-slate-200 p-0.5"
            />
            <span className="font-semibold text-slate-800 tracking-tight">Academic Writer Agent</span>
          </div>

          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
              isConfigured
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-slate-100 text-slate-500'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConfigured ? 'bg-green-500' : 'bg-slate-400'}`} />
              {isConfigured ? `AI: ${aiSettings!.model}` : 'AI not configured'}
            </div>

            {!authUserEmail ? (
              <div id="gis-btn" className="inline-flex" />
            ) : (
              <button
                onClick={async () => {
                  try { await logoutApi(); } finally {
                    setAuthUserEmail(null);
                    window.location.reload();
                  }
                }}
                className="text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full hover:bg-slate-200"
                title={authUserEmail}
              >
                Sign out
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors"
              title="AI Settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
              Phase 1 · Intake
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-4 py-14">
        <div className="w-full max-w-2xl space-y-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 sm:p-10">
            <div className="mb-8">
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">New Project</h1>
              <p className="text-slate-500 text-sm mt-1">
                Answer three quick questions to configure your research pipeline.
              </p>
              {!isConfigured && (
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200
                    rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
                >
                  ⚠ Configure an AI provider to enable query expansion and smart summaries →
                </button>
              )}
            </div>
            <IntakeForm onComplete={handleIntakeComplete} onCompleteRevision={handleIntakeCompleteRevision} />
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <button
              onClick={() => setShowProjects((v) => !v)}
              className="w-full flex items-center justify-between px-6 py-4 text-sm font-medium
                text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Previous Projects
              </span>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${showProjects ? 'rotate-180' : ''}`}
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

          <p className="text-center text-xs text-slate-400">
            Data is processed locally. Nothing is sent to third-party servers during this intake step.
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings]     = useState<AISettings | null>(null);
  const [authUserEmail, setAuthUserEmail] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode]   = useState<SidebarMode>('full');

  const navigate   = useNavigate();
  const location   = useLocation();

  useEffect(() => {
    getMe().then((user) => setAuthUserEmail(user.email)).catch(() => setAuthUserEmail(null));
  }, []);

  useEffect(() => {
    fetchSettings().then((s) => setAiSettings(s)).catch(() => {});
  }, []);

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

  // Derive active phase from current URL for sidebar highlight
  function urlPhase(): PhaseSlug {
    const p = location.pathname;
    if (p === '/' || p === '') return 'intake';
    const m = p.match(/^\/projects\/[^/]+\/(literature|cross-reference|journals|article|revision)/);
    return (m?.[1] as PhaseSlug) ?? 'intake';
  }

  function handleSidebarNav(id: PhaseSlug) {
    if (id === 'intake') { navigate('/'); return; }
    const lastId = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (lastId) navigate(`/projects/${lastId}/${id}`);
  }

  const activePhase = urlPhase();

  return (
    <AppCtx.Provider value={{ setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail }}>
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => { setAiSettings(s); setSettingsOpen(false); }}
      />

      {sidebarMode === 'hidden' && (
        <button
          type="button"
          onClick={cycleSidebarMode}
          className="hidden lg:inline-flex fixed top-4 left-4 z-30 w-10 h-10 items-center justify-center rounded-xl bg-white border border-slate-200 shadow text-slate-600 hover:bg-slate-50"
          aria-label="Open navigation"
          title="Open navigation"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      <div className={`min-h-screen grid grid-cols-1 ${sidebarWidthClass} transition-[grid-template-columns] duration-300 ease-in-out`}>
        <aside
          className={`hidden lg:flex lg:flex-col bg-white border-r border-slate-200 transition-[width,border-color] duration-300 ease-in-out overflow-hidden ${
            isSidebarVisible ? '' : 'lg:border-r-0'
          }`}
        >
          <div className="sticky top-0 h-screen">
            <div className="h-full flex flex-col">
              <div className="px-4 py-4 border-b border-slate-200">
                <div className={`flex items-center transition-all duration-300 ${isSidebarCompact ? 'justify-center' : 'gap-3'}`}>
                  <button
                    type="button"
                    onClick={cycleSidebarMode}
                    className="w-10 h-10 inline-flex items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 transition-colors"
                    aria-label="Navigation menu"
                    title="Navigation"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                        alt="Academic Writer Agent logo"
                        className="w-5 h-5 rounded-sm object-contain"
                      />
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Developer</p>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-800">Phase Navigation</h2>
                  </div>
                </div>
              </div>

              <div
                className={`p-3 space-y-1 overflow-y-auto transition-opacity duration-200 ${
                  isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              >
                {PHASE_NAV_ITEMS.map(({ id, label, icon }) => {
                  const isActive = id === 'article'
                    ? activePhase === 'article'
                    : id === 'revision'
                      ? activePhase === 'revision'
                      : activePhase === id;
                  return (
                    <button
                      key={id}
                      onClick={() => handleSidebarNav(id)}
                      className={`w-full flex items-center ${isSidebarCompact ? 'justify-center gap-0' : 'gap-3'} px-3 py-2.5 rounded-xl text-sm font-medium text-left transition-all duration-300 ${
                        isActive
                          ? 'bg-brand-600 text-white'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                      title={label}
                    >
                      <span className={`inline-flex items-center justify-center ${isActive ? 'text-white' : 'text-slate-500'}`}>
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
                      <span
                        className={`ml-auto rounded-full transition-all duration-300 ${
                          isActive ? 'bg-white' : 'bg-slate-300'
                        } ${showSidebarText ? 'w-2 h-2 opacity-100 scale-100' : 'w-0 h-0 opacity-0 scale-75'}`}
                        aria-hidden={!showSidebarText}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <Routes>
            <Route path="/"                              element={<IntakePage />} />
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
            <Route path="*"                      element={<Navigate to="/" replace />} />
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
          window.location.reload();
        } catch {}
      },
    });
    const btn = document.getElementById('gis-btn');
    if (btn) google.accounts.id.renderButton(btn, { theme: 'outline', size: 'medium' });
  };
  if (document.readyState === 'complete') tryInit();
  else window.addEventListener('load', tryInit);
})();
