import { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom';
import { getMe, loginWithGoogle, logout as logoutApi } from './api/auth';
import ArticleWriter, { type MainTab } from './components/ArticleWriter';
import CrossReferenceDashboard from './components/CrossReferenceDashboard';
import CitationBase from './components/CitationBase';
import IntakeForm from './components/IntakeForm';
import type { SRIntakeCompleteData } from './components/IntakeForm';
import JournalsDashboard from './components/JournalsDashboard';
import LiteratureDashboard from './components/LiteratureDashboard';
import PaperDetailPage from './components/PaperDetailPage';
import { useSummarizeProgress } from './hooks/useSummarizeProgress';
import RealRevisionPanel, { type StepId } from './components/RealRevisionPanel';
import SettingsPanel from './components/SettingsPanel';
import ProtocolDashboard from './components/SystematicReview/ProtocolDashboard';
import ProtocolExportDashboard from './components/SystematicReview/ProtocolExportDashboard';
import SRSearchDashboard from './components/SystematicReview/SRSearchDashboard';
import DualScreeningDashboard from './components/SystematicReview/DualScreeningDashboard';
import DataExtractionDashboard from './components/SystematicReview/DataExtractionDashboard';
import RiskOfBiasDashboard from './components/SystematicReview/RiskOfBiasDashboard';
import SRSynthesisDashboard from './components/SystematicReview/SRSynthesisDashboard';
import { backfillLegacyProjectTitles, createProject, deleteProject, listProjects, loadProject, normalizeProjectStorage } from './api/projects';
import type { ProjectData } from './api/projects';
// savePico no longer called at intake — moved to Protocol Builder
import type { ProjectMeta } from './types/paper';
import { fetchSettings, type AISettings } from './api/settings';
import appLogo from './assets/firstquill-logo.png';
import ThemeToggle, { type ThemePreference } from './components/ThemeToggle';
import LandingPage from './components/LandingPage';
import PricingPage from './components/PricingPage';
import LoginPage from './components/LoginPage';
import type { WritingType } from './types/intent';
import type { RevisionIntakeData } from './types/paper';
import ProjectCoverArt from './components/ProjectCoverArt';
import UsageDashboard from './components/UsageDashboard';
import LoadingLottie from './components/LoadingLottie';

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

function humanizeProjectTitle(text: string | null | undefined): string {
  return (text || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resumeProjectDestination(proj: ProjectMeta): string {
  if (proj.project_type === 'revision') {
    return 'revision/manuscript';
  }
  if (proj.project_type === 'systematic_review') {
    const srStageMap: Record<string, string> = {
      protocol: 'sr/protocol',
      search: 'sr/search',
      screen_ta: 'sr/screen-ta',
      screen_ft: 'sr/screen-ft',
      extraction: 'sr/extraction',
      rob: 'sr/rob',
      synthesis: 'sr/synthesis',
      sr_protocol: 'sr/protocol',
    };
    const srStage = proj.sr_current_stage ?? 'protocol';
    return srStageMap[srStage] ?? 'sr/protocol';
  }
  const phase = proj.current_phase ?? 'intake';
  const map: Record<string, string> = {
    intake: 'literature',
    literature: 'literature',
    cross_reference: 'cross-reference',
    journals: 'journals',
    article: 'article/synthesis',
  };
  return map[phase] ?? 'literature';
}

function projectPhaseLabel(proj: ProjectMeta): string {
  if (proj.project_type === 'revision') return 'Revision';
  if (proj.project_type === 'systematic_review') {
    const srLabels: Record<string, string> = {
      protocol: 'SR · Protocol',
      search: 'SR · Search',
      screen_ta: 'SR · Title/Abs Screen',
      screen_ft: 'SR · Full-text Screen',
      extraction: 'SR · Data Extraction',
      rob: 'SR · Risk of Bias',
      synthesis: 'SR · Synthesis',
      sr_protocol: 'SR · Protocol',
    };
    const stage = proj.sr_current_stage ?? 'protocol';
    return srLabels[stage] ?? `SR · ${stage}`;
  }
  const phase = proj.current_phase ?? 'intake';
  const labels: Record<string, string> = {
    intake: 'Literature Intake',
    literature: 'Literature Search',
    cross_reference: 'Cross Reference',
    journals: 'Journal Selection',
    article: 'Article Writing',
  };
  return labels[phase] ?? phase;
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

type PhaseSlug = 'dashboard' | 'intake' | 'literature' | 'cross-reference' | 'journals' | 'article' | 'revision' | 'sr';
const PHASE_NAV_ITEMS: { id: PhaseSlug; label: string; iconName: string }[] = [
  { id: 'dashboard',       label: 'Dashboard',       iconName: 'dashboard' },
  { id: 'intake',          label: 'Intake',           iconName: 'input' },
  { id: 'literature',      label: 'Literature',       iconName: 'library_books' },
  { id: 'cross-reference', label: 'Cross Reference',  iconName: 'compare_arrows' },
  { id: 'journals',        label: 'Journals',         iconName: 'menu_book' },
  { id: 'article',         label: 'Article',          iconName: 'article' },
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
    <div className="min-h-screen flex flex-col items-center justify-center">
      <LoadingLottie className="w-20 h-20" label="loading" textClassName="font-mono text-xs text-slate-400 tracking-widest uppercase" />
    </div>
  );
}

// ── Legacy redirect ────────────────────────────────────────────────────────────

function LegacyRedir({ phase }: { phase: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/projects/${id}/${phase}`} replace />;
}

// ── Page components ────────────────────────────────────────────────────────────

function WorkspaceTopBar() {
  const navigate = useNavigate();
  const { setSettingsOpen, aiSettings, isConfigured, authUserEmail, setAuthUserEmail, themePref, setThemePref } = useAppCtx();

  return (
    <header className="animate-in delay-0 ghost-border" style={{ background: 'var(--bg-surface)' }}>
      <div className="max-w-3xl mx-auto px-6 py-3.5 flex items-center justify-between">
        <button onClick={() => navigate('/dashboard')} className="flex items-center gap-3">
          <img
            src={appLogo}
            alt="First Quill logo"
            className="w-7 h-7 rounded-md object-contain"
          />
          <span className="font-serif font-medium tracking-wide text-lg leading-none"
            style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--gold)' }}>
            First Quill
          </span>
        </button>

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
  );
}

function DashboardPage({ recentProjects, projectsLoading, onDeleteProject }: {
  recentProjects: ProjectMeta[];
  projectsLoading: boolean;
  onDeleteProject?: (projectId: string) => void;
}) {
  const navigate = useNavigate();
  const { setSettingsOpen, isConfigured, authUserEmail, setAuthUserEmail, themePref, setThemePref } = useAppCtx();
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const writeProjects = recentProjects.filter((p) => p.project_type !== 'revision' && p.project_type !== 'systematic_review');
  const srProjects = recentProjects.filter((p) => p.project_type === 'systematic_review');
  const revisionProjects = recentProjects.filter((p) => p.project_type === 'revision');
  const orderedProjects = [...writeProjects, ...srProjects, ...revisionProjects];

  function openProject(proj: ProjectMeta) {
    localStorage.setItem(PROJECT_STORAGE_KEY, proj.project_id);
    navigate(`/projects/${proj.project_id}/${resumeProjectDestination(proj)}`);
  }

  async function handleDeleteProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    setMenuOpen(null);
    if (!confirm('Delete this project and all its data?')) return;
    try {
      await deleteProject(projectId);
      onDeleteProject?.(projectId);
    } catch {
      alert('Failed to delete project.');
    }
  }

  // Derive user first name from email for greeting
  const userName = (authUserEmail ?? 'Researcher').split('@')[0].split('.')[0];
  const capitalizedName = userName.charAt(0).toUpperCase() + userName.slice(1);

  // Relative time helper
  function relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'Yesterday';
    return `${days}d ago`;
  }

  // (Cover art is now generated dynamically by ProjectCoverArt component)

  function projectBadge(proj: ProjectMeta): { label: string; cls: string } {
    if (proj.project_type === 'revision') return { label: 'Revision', cls: 'bg-violet-500/20 text-violet-400' };
    if (proj.project_type === 'systematic_review') return { label: 'SR', cls: 'bg-emerald-500/20 text-emerald-400' };
    if (proj.has_article) return { label: 'Active', cls: 'bg-amber-500/20 text-amber-400' };
    return { label: 'Research', cls: 'bg-indigo-500/20 text-indigo-400' };
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Top NavBar */}
      <header className="sticky top-0 z-40 flex justify-between items-center px-8 h-16 backdrop-blur-md border-b"
        style={{ background: 'color-mix(in srgb, var(--bg-base) 80%, transparent)', borderColor: 'var(--border-faint)' }}>
        <div className="flex items-center w-1/3">
          <div className="relative w-full max-w-sm">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input
              className="w-full border-0 rounded-full pl-10 pr-4 py-2 text-sm font-medium focus:ring-1 focus:ring-indigo-500/30 transition-all outline-none"
              placeholder="Search curated knowledge..."
              type="text"
              style={{ fontFamily: 'Manrope, sans-serif', background: 'var(--bg-surface)', color: 'var(--text-body)' }}
            />
          </div>
        </div>
        <div className="flex items-center gap-6">
          <button className="transition-colors" title="Notifications"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="transition-colors"
            title="AI Settings"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--gold)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
            <span className="material-symbols-outlined">settings</span>
          </button>
          <ThemeToggle value={themePref} onChange={setThemePref} compact />
          <button
            onClick={async () => {
              try { await logoutApi(); } finally {
                setAuthUserEmail(null);
                navigate('/login');
              }
            }}
            className="flex items-center gap-2 pl-4"
            title={authUserEmail ?? 'Sign out'}
            style={{ fontFamily: 'Manrope, sans-serif', borderLeft: '1px solid var(--border-faint)' }}
          >
            <span className="material-symbols-outlined" style={{ color: 'var(--gold)', fontVariationSettings: "'FILL' 1" }}>account_circle</span>
            <span className="text-xs uppercase tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-body)' }}>
              {capitalizedName}
            </span>
          </button>
        </div>
      </header>

      <main className="flex-1 p-12 w-full">
        {/* Hero Section */}
        <section className="mb-16 flex flex-col md:flex-row md:items-end justify-between gap-8 animate-in delay-75">
          <div className="space-y-4 max-w-2xl">
            <h2 className="text-5xl font-medium italic tracking-tight leading-tight"
              style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
              Welcome back, <span className="font-semibold not-italic" style={{ color: 'var(--gold)' }}>{capitalizedName}</span>.{' '}
              Your manuscript awaits.
            </h2>
            <p className="text-lg leading-relaxed max-w-xl" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-secondary)' }}>
              The curator is ready. Start a new research project or continue where you left off in your digital atelier.
            </p>
          </div>
          <button
            onClick={() => navigate('/intake')}
            className="flex items-center gap-3 px-8 py-4 rounded-full font-bold tracking-tight
              shadow-xl shadow-indigo-500/20 hover:scale-105 active:opacity-80 transition-all group"
            style={{
              fontFamily: 'Manrope, sans-serif',
              background: 'linear-gradient(135deg, var(--gold-light), var(--gold))',
              color: 'var(--bg-base)',
            }}
          >
            Start New Project
            <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">arrow_forward</span>
          </button>
        </section>

        {/* Bento Grid for Stats & AI Insight */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16 animate-in delay-150">
          <div className="md:col-span-2 p-8 rounded-xl flex flex-col justify-between min-h-[240px]"
            style={{ background: 'var(--bg-surface)' }}>
            <div className="flex justify-between items-center">
              <div className="space-y-1">
                <span className="text-[10px] uppercase font-bold tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold)' }}>Project Velocity</span>
                <h3 className="text-2xl font-semibold" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>Weekly Writing Activity</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ background: 'var(--gold)' }} />
                <span className="text-[10px] uppercase font-bold tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>Word Count Progress</span>
              </div>
            </div>
            <div className="flex items-end gap-4 h-48 mt-4 px-2">
              {/* Bar chart — proportional to project counts */}
              {[
                { h: '40%', active: false },
                { h: '65%', active: false },
                { h: '50%', active: false },
                { h: '85%', active: true, peak: true },
                { h: `${Math.min(95, Math.max(20, recentProjects.length * 15))}%`, active: false },
                { h: '55%', active: false },
                { h: '45%', active: false },
              ].map((bar, i) => (
                <div key={i} className="flex-1 rounded-t-lg transition-all relative cursor-pointer"
                  style={{
                    height: bar.h,
                    background: bar.active ? 'var(--gold)' : 'var(--bg-hover)',
                  }}
                  onMouseEnter={(e) => { if (!bar.active) (e.currentTarget.style.background = 'var(--gold)'); (e.currentTarget.style.opacity = '0.6'); }}
                  onMouseLeave={(e) => { if (!bar.active) (e.currentTarget.style.background = 'var(--bg-hover)'); (e.currentTarget.style.opacity = '1'); }}
                >
                  {(bar as any).peak && (
                    <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 rounded text-[10px] font-bold"
                      style={{ background: 'var(--gold-light)', color: 'var(--bg-base)' }}>
                      Peak
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-3 px-2">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <span key={d} className="flex-1 text-center text-[10px] font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>{d}</span>
              ))}
            </div>
          </div>
          <div className="glass-card p-8 rounded-xl flex flex-col gap-6"
            style={{ borderLeft: '3px solid var(--gold)' }}>
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", color: 'var(--gold)' }}>auto_awesome</span>
              <span className="text-xs font-bold uppercase tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-body)' }}>AI Intelligence Insight</span>
            </div>
            <p className="leading-snug italic" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-secondary)' }}>
              {recentProjects.length > 1
                ? `You have ${recentProjects.length} active projects. Consider cross-referencing recent literature findings across projects for synthesis opportunities.`
                : 'Start your first project and the AI curator will surface connections and insights as your research grows.'}
            </p>
            <button
              onClick={() => navigate('/intake')}
              className="mt-auto text-xs font-bold flex items-center gap-1 group"
              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold)' }}
            >
              Explore connections
              <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">arrow_forward</span>
            </button>
          </div>
        </section>

        {/* Stats row */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12 animate-in delay-200">
          <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-faint)' }}>
            <p className="text-[10px] uppercase font-bold tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>All Projects</p>
            <p className="mt-2 text-2xl font-semibold" style={{ color: 'var(--text-bright)' }}>{recentProjects.length}</p>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-[10px] uppercase font-bold tracking-widest text-blue-500" style={{ fontFamily: 'Manrope, sans-serif' }}>Research</p>
            <p className="mt-2 text-2xl font-semibold text-blue-700">{writeProjects.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-[10px] uppercase font-bold tracking-widest text-emerald-500" style={{ fontFamily: 'Manrope, sans-serif' }}>Systematic Reviews</p>
            <p className="mt-2 text-2xl font-semibold text-emerald-700">{srProjects.length}</p>
          </div>
          <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3">
            <p className="text-[10px] uppercase font-bold tracking-widest text-violet-500" style={{ fontFamily: 'Manrope, sans-serif' }}>Revisions</p>
            <p className="mt-2 text-2xl font-semibold text-violet-700">{revisionProjects.length}</p>
          </div>
        </section>

        {!isConfigured && (
          <div className="animate-in delay-100 mb-8">
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-full text-left text-xs text-amber-600 bg-amber-100 border border-amber-200
                rounded-lg px-4 py-3 hover:bg-amber-200 transition-colors flex items-center gap-2.5"
            >
              <span className="material-symbols-outlined text-sm">warning</span>
              Configure an AI provider to enable query expansion and smart summaries
              <span className="ml-auto text-amber-500">→</span>
            </button>
          </div>
        )}

        {/* Recent Projects */}
        <section className="animate-in delay-250">
          <div className="flex justify-between items-center mb-8" style={{ borderBottom: '1px solid var(--border-faint)', paddingBottom: '1rem' }}>
            <h3 className="text-3xl font-semibold" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>Recent Projects</h3>
            <button
              onClick={() => navigate('/dashboard')}
              className="text-xs font-bold uppercase tracking-widest hover:underline transition-colors"
              style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold)' }}
            >
              View All Projects
            </button>
          </div>

          {projectsLoading ? (
            <div className="rounded-xl px-6 py-10 text-center" style={{ background: 'var(--bg-surface)' }}>
              <LoadingLottie className="w-16 h-16 mx-auto" />
              <p className="mt-2 text-[11px] uppercase tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                Loading saved projects
              </p>
            </div>
          ) : orderedProjects.length === 0 ? (
            <div className="rounded-xl px-6 py-10 text-center" style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-muted)' }}>
              <p className="text-2xl font-light" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                No saved projects yet.
              </p>
              <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                Click <strong>Start New Project</strong> above to begin your first research.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-6">
              {orderedProjects.map((proj, idx) => {
                const displayName = humanizeProjectTitle(proj.manuscript_title || proj.project_name || proj.query || 'Untitled project');
                const badge = projectBadge(proj);
                const isMenuOpen = menuOpen === proj.project_id;
                return (
                  <div key={proj.project_id} className="relative group rounded-xl overflow-hidden" style={{ width: 293, height: 363 }}>
                    <button
                      type="button"
                      onClick={() => openProject(proj)}
                      className="w-full h-full flex flex-col rounded-xl overflow-hidden text-left transition-all duration-300
                        hover:translate-y-[-4px] hover:shadow-2xl"
                      style={{ background: 'var(--bg-surface)', animationDelay: `${idx * 40}ms` }}
                    >
                      {/* Generated cover art */}
                      <div style={{ height: 160 }} className="overflow-hidden relative">
                        <ProjectCoverArt
                          title={displayName}
                          description={proj.project_description || proj.query || ''}
                          projectType={proj.project_type ?? 'write'}
                          className="w-full h-full group-hover:scale-105 transition-transform duration-700"
                        />
                        <div className="absolute inset-0"
                          style={{ background: `linear-gradient(to top, var(--bg-surface), transparent, transparent)` }} />
                        <div className="absolute top-4 left-4 flex gap-2">
                          <span className={`${badge.cls} px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest backdrop-blur-md`}>
                            {badge.label}
                          </span>
                        </div>
                      </div>
                      {/* Card body */}
                      <div className="p-5 space-y-3 flex-1 flex flex-col">
                        <h4 className="text-lg font-semibold line-clamp-2 transition-colors"
                          style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
                          {displayName}
                        </h4>
                        <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                          {proj.project_description || proj.query}
                        </p>
                        <div className="mt-auto flex justify-between items-center pt-4">
                          <div className="flex -space-x-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold"
                              style={{ border: '2px solid var(--bg-surface)', background: 'var(--bg-hover)', color: 'var(--text-body)' }}>
                              {capitalizedName.substring(0, 2).toUpperCase()}
                            </div>
                          </div>
                          <span className="text-[10px] italic uppercase tracking-widest" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted)' }}>
                            Edited {relativeTime(proj.updated_at)}
                          </span>
                        </div>
                      </div>
                    </button>
                    {/* Three-dot menu */}
                    <div className="absolute top-4 right-4 z-10">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(isMenuOpen ? null : proj.project_id); }}
                        className="w-7 h-7 rounded-full flex items-center justify-center backdrop-blur-md transition-all
                          opacity-0 group-hover:opacity-100"
                        style={{ background: 'rgba(0,0,0,0.35)', color: '#fff' }}
                        title="More options"
                      >
                        <span className="material-symbols-outlined text-base">more_vert</span>
                      </button>
                      {isMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
                          <div className="absolute right-0 mt-1 z-20 w-36 rounded-lg shadow-xl overflow-hidden"
                            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-faint)' }}>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteProject(e, proj.project_id)}
                              className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors hover:bg-rose-50 text-rose-600"
                            >
                              <span className="material-symbols-outlined text-base">delete</span>
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Recently Saved Sources / Quick Start */}
        <section className="mt-16 animate-in delay-350 rounded-xl p-8"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-faint)' }}>
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-2xl font-semibold" style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>Quick Start</h3>
          </div>
          <div className="flex flex-col gap-px" style={{ borderTop: '1px solid var(--border-faint)' }}>
            {[
              { icon: 'article', label: 'Novel Article', desc: 'Define research idea and launch literature search', color: 'var(--gold)' },
              { icon: 'fact_check', label: 'Systematic Review', desc: 'Set up SR workflow and begin protocol drafting', color: 'var(--gold)' },
              { icon: 'history_edu', label: 'Revision Project', desc: 'Start from manuscript and reviewer material intake', color: 'var(--gold)' },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => navigate('/intake')}
                className="py-4 flex items-center justify-between px-4 rounded-lg transition-colors cursor-pointer group"
                style={{ fontFamily: 'Manrope, sans-serif' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded flex items-center justify-center" style={{ background: 'var(--bg-hover)' }}>
                    <span className="material-symbols-outlined" style={{ color: item.color }}>{item.icon}</span>
                  </div>
                  <div className="text-left">
                    <h4 className="font-semibold text-sm" style={{ color: 'var(--text-bright)' }}>{item.label}</h4>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.desc}</p>
                  </div>
                </div>
                <span className="material-symbols-outlined transition-colors" style={{ color: 'var(--text-muted)' }}>arrow_forward</span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function IntakePage() {
  const navigate = useNavigate();
  const { setSettingsOpen, isConfigured } = useAppCtx();

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
      navigate('/intake');
    }
  }

  async function handleIntakeCompleteSR(srIntakeData: SRIntakeCompleteData) {
    try {
      const meta = await createProject(
        srIntakeData.keyIdea || 'Systematic Review',
        [],
        srIntakeData.writingType,
        srIntakeData.projectDescription,
        undefined,
        'systematic_review',
      );
      localStorage.setItem(PROJECT_STORAGE_KEY, meta.project_id);
      navigate(`/projects/${meta.project_id}/sr/protocol`);
    } catch {
      navigate('/intake');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <WorkspaceTopBar />

      <main className="flex-1 flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-3xl space-y-6">
          <div className="animate-in delay-75 rounded-[28px] border border-slate-200 bg-white px-6 py-8 sm:px-8"
            style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.08), 0 2px 12px rgba(0,0,0,0.05)' }}>
            <button
              onClick={() => navigate('/dashboard')}
              className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.14em] text-slate-400 hover:text-slate-600"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to dashboard
            </button>
            <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">New Project Intake</p>
            <h1 className="mt-2 font-serif text-4xl font-light leading-tight"
              style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}>
              Start a new project
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">
              Configure a new literature project, systematic review, or revision workflow from one dedicated intake page.
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

          <section className="animate-in delay-150 rounded-[28px] border border-slate-200 bg-white p-8 sm:p-10"
            style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.08), 0 2px 12px rgba(0,0,0,0.05)' }}>
            <IntakeForm onComplete={handleIntakeComplete} onCompleteRevision={handleIntakeCompleteRevision} onCompleteSR={handleIntakeCompleteSR} />
          </section>

          <p className="animate-in delay-200 text-center font-mono text-[10px] text-slate-400 tracking-wider uppercase">
            Need an existing workspace? Return to the dashboard and resume a saved project
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
  const [paperDetail, setPaperDetail] = useState<{ paper: import('./types/paper').Paper; summary: import('./types/paper').PaperSummary | null; projectId: string } | null>(null);

  if (!state?.keyIdea) return <Navigate to="/dashboard" replace />;

  if (paperDetail) {
    return (
      <PaperDetailPage
        paper={paperDetail.paper}
        summary={paperDetail.summary}
        projectId={paperDetail.projectId}
        onBack={() => setPaperDetail(null)}
      />
    );
  }

  return (
    <LiteratureDashboard
      initialQuery={state.keyIdea}
      articleType={state.writingType ?? undefined}
      projectDescription={state.projectDescription}
      onBack={() => navigate('/intake')}
      onOpenSettings={() => setSettingsOpen(true)}
      onGoToJournals={(pid) => {
        localStorage.setItem(PROJECT_STORAGE_KEY, pid);
        navigate(`/projects/${pid}/cross-reference`);
      }}
      onSessionCreated={(pid) => {
        localStorage.setItem(PROJECT_STORAGE_KEY, pid);
        navigate(`/projects/${pid}/literature`, { replace: true });
      }}
      onViewPaperDetail={(paper, summary, projectId) => setPaperDetail({ paper, summary, projectId })}
    />
  );
}

function LiteraturePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  const [proj, setProj] = useState<ProjectData | null>(null);
  const [paperDetail, setPaperDetail] = useState<{ paper: import('./types/paper').Paper; summary: import('./types/paper').PaperSummary | null; projectId: string } | null>(null);

  useEffect(() => {
    loadProject(id!).then(setProj).catch(() => navigate('/dashboard'));
  }, [id]);

  if (!proj) return <LoadingSpinner />;

  if (paperDetail) {
    return (
      <PaperDetailPage
        paper={paperDetail.paper}
        summary={paperDetail.summary}
        projectId={paperDetail.projectId}
        onBack={() => setPaperDetail(null)}
      />
    );
  }

  return (
    <LiteratureDashboard
      initialQuery={proj.query}
      articleType={proj.article_type ?? undefined}
      projectDescription={proj.project_description ?? undefined}
      initialProject={proj}
      onBack={() => navigate('/dashboard')}
      onOpenSettings={() => setSettingsOpen(true)}
      onGoToJournals={(pid) => navigate(`/projects/${pid}/cross-reference`)}
      onSessionCreated={(pid) => navigate(`/projects/${pid}/literature`, { replace: true })}
      onViewPaperDetail={(paper, summary, projectId) => setPaperDetail({ paper, summary, projectId })}
    />
  );
}

function CrossReferencePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  const [showExpand, setShowExpand] = useState(false);

  if (showExpand) {
    return (
      <CrossReferenceDashboard
        sessionId={id!}
        onBack={() => setShowExpand(false)}
        onGoToJournals={(pid) => navigate(`/projects/${pid}/journals`)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  }

  return (
    <CitationBase
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

  useEffect(() => { loadProject(id!).then(setProj).catch(() => navigate('/dashboard')); }, [id]);
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

// ── SR page components ────────────────────────────────────────────────────────

function SRProtocolPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <ProtocolDashboard
      projectId={id!}
      onGoToExportHub={() => navigate(`/projects/${id}/sr/protocol-export`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRProtocolExportPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  return (
    <ProtocolExportDashboard
      projectId={id!}
      onBackToProtocol={() => navigate(`/projects/${id}/sr/protocol`)}
      onGoToSearch={() => navigate(`/projects/${id}/sr/search`)}
    />
  );
}

function SRSearchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <SRSearchDashboard
      projectId={id!}
      onGoToScreening={() => navigate(`/projects/${id}/sr/screen-ta`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRScreenTAPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <DualScreeningDashboard
      projectId={id!}
      stage="title_abstract"
      onGoToNext={() => navigate(`/projects/${id}/sr/screen-ft`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRScreenFTPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <DualScreeningDashboard
      projectId={id!}
      stage="full_text"
      onGoToNext={() => navigate(`/projects/${id}/sr/extraction`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRExtractionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <DataExtractionDashboard
      projectId={id!}
      onGoToRoB={() => navigate(`/projects/${id}/sr/rob`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRRoBPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <RiskOfBiasDashboard
      projectId={id!}
      onGoToSynthesis={() => navigate(`/projects/${id}/sr/synthesis`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function SRSynthesisPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { setSettingsOpen } = useAppCtx();
  return (
    <SRSynthesisDashboard
      projectId={id!}
      onGoToManuscript={() => navigate(`/projects/${id}/article/synthesis`)}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  );
}

function UsagePage() {
  const navigate = useNavigate();
  return <UsageDashboard onBack={() => navigate('/dashboard')} />;
}

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const [settingsOpen, setSettingsOpen]   = useState(() => window.location.search.includes('gemini_oauth='));
  const [aiSettings, setAiSettings]       = useState<AISettings | null>(null);
  const [authUserEmail, setAuthUserEmail] = useState<string | null>(null);
  const [authLoading, setAuthLoading]     = useState(true);
  const [sidebarMode, setSidebarMode]     = useState<SidebarMode>('compact');
  const [recentProjects, setRecentProjects] = useState<ProjectMeta[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [titleBackfillDone, setTitleBackfillDone] = useState(false);
  const [storageNormalizationDone, setStorageNormalizationDone] = useState(false);
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState<string | null>(null);
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

  useEffect(() => {
    if (!authUserEmail) {
      setTitleBackfillDone(false);
      setStorageNormalizationDone(false);
    }
  }, [authUserEmail]);

  // Refresh project list whenever auth is ready or user navigates
  useEffect(() => {
    if (!authUserEmail) return;
    let cancelled = false;
    setProjectsLoading(true);
    listProjects()
      .then((items) => {
        if (cancelled) return;
        setRecentProjects(items);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUserEmail, location.pathname]);

  useEffect(() => {
    if (!authUserEmail || (titleBackfillDone && storageNormalizationDone)) return;
    let cancelled = false;

    async function runProjectBackfills() {
      let changed = false;

      if (!titleBackfillDone) {
        try {
          const result = await backfillLegacyProjectTitles();
          if (cancelled) return;
          setTitleBackfillDone(true);
          changed = changed || result.updated_count > 0;
        } catch {
          if (!cancelled) setTitleBackfillDone(true);
        }
      }

      if (!storageNormalizationDone) {
        try {
          const result = await normalizeProjectStorage();
          if (cancelled) return;
          setStorageNormalizationDone(true);
          changed = changed
            || result.projects_updated > 0
            || result.pdfs_moved > 0
            || result.pdfs_copied > 0
            || result.bibs_rebuilt > 0
            || result.unassigned_files.length > 0
            || result.missing_pdfs.length > 0;
        } catch {
          if (!cancelled) setStorageNormalizationDone(true);
        }
      }

      if (!changed || cancelled) return;
      try {
        const fresh = await listProjects();
        if (!cancelled) setRecentProjects(fresh);
      } catch {
        // ignore refresh failures; regular page navigation reload still works
      }
    }

    void runProjectBackfills();
    return () => {
      cancelled = true;
    };
  }, [authUserEmail, titleBackfillDone, storageNormalizationDone]);

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
    if (p === '/dashboard' || p === '/' || p === '') return 'dashboard';
    if (p === '/intake') return 'intake';
    const m = p.match(/^\/projects\/[^/]+\/(literature|cross-reference|journals|article|revision|sr)/);
    return (m?.[1] as PhaseSlug) ?? 'dashboard';
  }

  function urlProjectId(): string | null {
    const m = location.pathname.match(/^\/projects\/([^/]+)/);
    return m?.[1] ?? null;
  }

  async function handleSidebarDeleteProject(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    setSidebarMenuOpen(null);
    if (!confirm('Delete this project and all its data?')) return;
    try {
      await deleteProject(projectId);
      setRecentProjects((prev) => prev.filter((p) => p.project_id !== projectId));
    } catch {
      alert('Failed to delete project.');
    }
  }

  function handleSidebarNav(id: PhaseSlug) {
    if (id === 'dashboard') { navigate('/dashboard'); return; }
    if (id === 'intake') { navigate('/intake'); return; }
    const lastId = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (lastId) navigate(`/projects/${lastId}/${id}`);
  }

  const activePhase     = urlPhase();
  const activeProjectId = urlProjectId();

  // Global background summarization progress — polls the active project
  const globalSummarize = useSummarizeProgress(activeProjectId);

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
              ? <Navigate to="/dashboard" replace />
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
        onSaved={(s) => { setAiSettings(s); }}
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
          className={`hidden lg:flex lg:flex-col transition-[width,border-color] duration-300 ease-in-out overflow-hidden ${
            isSidebarVisible ? '' : 'lg:border-r-0'
          }`}
          style={{ background: 'var(--bg-surface)', borderRight: '1px solid var(--border-faint)' }}
        >
          <div className="h-full flex flex-col">
              {/* Sidebar header */}
              <div className="p-6 pb-4">
                <div className={`flex items-center transition-all duration-300 ${isSidebarCompact ? 'justify-center' : 'gap-4'}`}>
                  <button
                    type="button"
                    onClick={cycleSidebarMode}
                    className="w-12 h-12 flex items-center justify-center rounded-xl transition-colors flex-shrink-0"
                    style={{ border: '2px solid var(--border-muted)' }}
                    aria-label="Navigation menu"
                    title="Navigation"
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="material-symbols-outlined" style={{ color: 'var(--text-secondary)' }}>menu</span>
                  </button>
                  <div
                    className={`min-w-0 overflow-hidden transition-all duration-300 ease-in-out ${
                      showSidebarText ? 'max-w-[180px] opacity-100 translate-x-0' : 'max-w-0 opacity-0 -translate-x-1'
                    }`}
                    aria-hidden={!showSidebarText}
                  >
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-xs text-indigo-600" style={{ fontVariationSettings: "'FILL' 1" }}>edit_quill</span>
                      <span className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase" style={{ fontFamily: 'Manrope, sans-serif' }}>Researcher</span>
                    </div>
                    <h2
                      className="text-2xl font-semibold leading-tight"
                      style={{
                        fontFamily: 'Newsreader, Georgia, serif',
                        color: 'var(--text-bright)',
                      }}
                    >
                      First <span className="italic">Quill</span>
                    </h2>
                  </div>
                </div>
              </div>

              {/* Nav items */}
              <nav
                className={`px-4 space-y-1 flex-shrink-0 transition-opacity duration-200 ${
                  isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              >
                {PHASE_NAV_ITEMS.map(({ id, label, iconName }, idx) => {
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
                        w-full flex items-center ${isSidebarCompact ? 'justify-center px-0' : 'gap-4 px-4'}
                        py-3.5 rounded-xl text-sm text-left
                        transition-all duration-200 animate-in active:scale-95
                      `}
                      style={{
                        animationDelay: `${idx * 60}ms`,
                        fontFamily: 'Manrope, sans-serif',
                        fontWeight: isActive ? 700 : 500,
                        ...(isActive ? {
                          background: 'var(--gold-light)',
                          color: '#ffffff',
                          boxShadow: '0 4px 16px rgba(129, 140, 248, 0.2)',
                          transform: 'translateX(2px)',
                        } : {
                          color: 'var(--text-secondary)',
                        }),
                      }}
                      onMouseEnter={(e) => { if (!isActive) { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-bright)'; } }}
                      onMouseLeave={(e) => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
                      title={label}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">{iconName}</span>
                      <span
                        className={`truncate overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${
                          showSidebarText ? 'max-w-[140px] opacity-100' : 'max-w-0 opacity-0'
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
                const writeProjects    = recentProjects.filter((p) => p.project_type !== 'revision' && p.project_type !== 'systematic_review');
                const srProjects      = recentProjects.filter((p) => p.project_type === 'systematic_review');
                const revisionProjects = recentProjects.filter((p) => p.project_type === 'revision');

                function PhaseLabel({ proj }: { proj: ProjectMeta }) {
                  return <span>{projectPhaseLabel(proj)}</span>;
                }

                function ProjectRow({ proj }: { proj: ProjectMeta }) {
                  const isCurrentProject = proj.project_id === activeProjectId;
                  const dest = resumeProjectDestination(proj);
                  const displayName = humanizeProjectTitle(proj.manuscript_title || proj.project_name || proj.query || 'Untitled');
                  const isSidebarRowMenuOpen = sidebarMenuOpen === proj.project_id;
                  return (
                    <div className="relative group/row">
                      <button
                        key={proj.project_id}
                        onClick={() => navigate(`/projects/${proj.project_id}/${dest}`)}
                        title={displayName}
                        className={`w-full flex items-start rounded-lg transition-all duration-150 ${
                          isSidebarCompact ? 'justify-center px-0 py-2' : 'gap-3 px-4 py-3 pr-8'
                        } ${isCurrentProject ? 'font-medium' : 'text-slate-500 hover:bg-slate-200/50'}`}
                        style={isCurrentProject ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : {}}
                      >
                        <span className={`mt-1.5 flex-shrink-0 w-2 h-2 rounded-full transition-colors ${
                          isCurrentProject ? 'bg-indigo-500' : 'bg-slate-300 group-hover/row:bg-indigo-400'
                        }`} />
                        <span className={`min-w-0 flex-1 text-left overflow-hidden transition-all duration-300 ${
                          showSidebarText ? 'opacity-100 max-w-full' : 'opacity-0 max-w-0'
                        }`} aria-hidden={!showSidebarText}>
                          <span className="block text-sm font-bold truncate leading-tight text-slate-700" style={{ fontFamily: 'Manrope, sans-serif' }}>{displayName}</span>
                          <span className="block text-[11px] text-slate-400 truncate" style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 500 }}>
                            <PhaseLabel proj={proj} />
                          </span>
                        </span>
                      </button>
                      {/* Three-dot menu — full sidebar only */}
                      {!isSidebarCompact && (
                        <div className="absolute right-1 top-1/2 -translate-y-1/2 z-10">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setSidebarMenuOpen(isSidebarRowMenuOpen ? null : proj.project_id); }}
                            className="w-6 h-6 rounded-full flex items-center justify-center transition-all
                              opacity-0 group-hover/row:opacity-100"
                            style={{ color: 'var(--text-muted)' }}
                            title="More options"
                          >
                            <span className="material-symbols-outlined text-sm">more_vert</span>
                          </button>
                          {isSidebarRowMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setSidebarMenuOpen(null)} />
                              <div className="absolute right-0 mt-1 z-20 w-36 rounded-lg shadow-xl overflow-hidden"
                                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-faint)' }}>
                                <button
                                  type="button"
                                  onClick={(e) => handleSidebarDeleteProject(e, proj.project_id)}
                                  className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors hover:bg-rose-50 text-rose-600"
                                >
                                  <span className="material-symbols-outlined text-base">delete</span>
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div className={`flex-1 overflow-y-auto min-h-0 transition-opacity duration-200 px-4 space-y-6 pb-12 ${
                    isSidebarVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}>
                    <hr style={{ borderColor: 'var(--border-faint)' }} className="mx-2" />
                    {/* Write projects */}
                    {writeProjects.length > 0 && (
                      <div>
                        {showSidebarText && (
                          <h3 className="px-4 text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-3" style={{ fontFamily: 'Manrope, sans-serif' }}>
                            Research Projects
                          </h3>
                        )}
                        <div className="space-y-1">
                          {writeProjects.slice(0, 8).map((proj) => <ProjectRow key={proj.project_id} proj={proj} />)}
                        </div>
                      </div>
                    )}
                    {/* SR projects */}
                    {srProjects.length > 0 && (
                      <div>
                        {showSidebarText && (
                          <h3 className="px-4 text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-3" style={{ fontFamily: 'Manrope, sans-serif' }}>
                            Systematic Reviews
                          </h3>
                        )}
                        <div className="space-y-1">
                          {srProjects.slice(0, 6).map((proj) => <ProjectRow key={proj.project_id} proj={proj} />)}
                        </div>
                      </div>
                    )}
                    {/* Revision projects */}
                    {revisionProjects.length > 0 && (
                      <div>
                        {showSidebarText && (
                          <h3 className="px-4 text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-3" style={{ fontFamily: 'Manrope, sans-serif' }}>
                            Revisions
                          </h3>
                        )}
                        <div className="space-y-1">
                          {revisionProjects.slice(0, 6).map((proj) => <ProjectRow key={proj.project_id} proj={proj} />)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Sidebar footer — usage + theme toggle */}
              <div className="px-3 py-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
                <button
                  type="button"
                  onClick={() => navigate('/usage')}
                  className={`w-full flex items-center rounded-lg transition-colors mb-2 ${
                    isSidebarCompact ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2'
                  } ${location.pathname === '/usage' ? 'font-medium' : 'text-slate-500'}`}
                  style={location.pathname === '/usage' ? { background: 'var(--gold-faint)', color: 'var(--gold)' } : {}}
                  onMouseEnter={(e) => { if (location.pathname !== '/usage') e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { if (location.pathname !== '/usage') e.currentTarget.style.background = 'transparent'; }}
                  title="AI Usage & Costs"
                >
                  <span className="material-symbols-outlined text-lg">bar_chart</span>
                  <span className={`text-xs font-medium transition-all duration-300 ${
                    showSidebarText ? 'opacity-100 max-w-full' : 'opacity-0 max-w-0 overflow-hidden'
                  }`} style={{ fontFamily: 'Manrope, sans-serif' }}>Usage & Costs</span>
                </button>
              </div>
              <div className="px-3 py-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
                {isSidebarCompact ? (
                  /* Compact: single cycling icon button */
                  <button
                    type="button"
                    onClick={() => {
                      const next: ThemePreference = themePref === 'light' ? 'dark' : themePref === 'dark' ? 'system' : 'light';
                      setThemePref(next);
                    }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors mx-auto"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
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
                    <p className="font-mono text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-muted)' }}>
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
            <Route path="/dashboard"                     element={<DashboardPage recentProjects={recentProjects} projectsLoading={projectsLoading} onDeleteProject={(id) => setRecentProjects((prev) => prev.filter((p) => p.project_id !== id))} />} />
            <Route path="/usage"                         element={<UsagePage />} />
            <Route path="/intake"                        element={<IntakePage />} />
            <Route path="/new/literature"               element={<NewLiteraturePage />} />
            <Route path="/projects/:id/literature"      element={<LiteraturePage />} />
            <Route path="/projects/:id/cross-reference" element={<CrossReferencePage />} />
            <Route path="/projects/:id/journals"        element={<JournalsPage />} />
            <Route path="/projects/:id/article"         element={<Navigate to="synthesis" replace />} />
            <Route path="/projects/:id/article/:tab"    element={<ArticlePage />} />
            <Route path="/projects/:id/revision"        element={<Navigate to="manuscript" replace />} />
            <Route path="/projects/:id/revision/:step"  element={<RevisionPage />} />
            {/* SR pipeline routes */}
            <Route path="/projects/:id/sr/protocol"     element={<SRProtocolPage />} />
            <Route path="/projects/:id/sr/protocol-export" element={<SRProtocolExportPage />} />
            <Route path="/projects/:id/sr/search"        element={<SRSearchPage />} />
            <Route path="/projects/:id/sr/screen-ta"     element={<SRScreenTAPage />} />
            <Route path="/projects/:id/sr/screen-ft"     element={<SRScreenFTPage />} />
            <Route path="/projects/:id/sr/extraction"    element={<SRExtractionPage />} />
            <Route path="/projects/:id/sr/rob"           element={<SRRoBPage />} />
            <Route path="/projects/:id/sr/synthesis"     element={<SRSynthesisPage />} />
            <Route path="/projects/:id/sr"               element={<Navigate to="protocol" replace />} />
            {/* Legacy redirects */}
            <Route path="/p/:id/literature"      element={<LegacyRedir phase="literature" />} />
            <Route path="/p/:id/cross_reference" element={<LegacyRedir phase="cross-reference" />} />
            <Route path="/p/:id/journals"        element={<LegacyRedir phase="journals" />} />
            <Route path="/p/:id/article"         element={<LegacyRedir phase="article/synthesis" />} />
            <Route path="/s/:id/*"               element={<LegacyRedir phase="literature" />} />
            <Route path="*"                      element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
      </div>

      {/* Global background summarization progress pill */}
      {globalSummarize.isRunning && globalSummarize.status && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl"
          style={{
            background: 'rgba(248,249,250,0.95)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--border-faint)',
            boxShadow: '0 8px 32px rgba(25,28,29,0.12)',
            fontFamily: 'Manrope, sans-serif',
          }}>
          {/* Spinner */}
          <div className="w-8 h-8 flex-shrink-0 relative">
            <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
              <circle cx="16" cy="16" r="12" fill="none" stroke="var(--border-faint)" strokeWidth="3" />
              <circle cx="16" cy="16" r="12" fill="none"
                stroke="var(--gold)" strokeWidth="3"
                strokeDasharray={2 * Math.PI * 12}
                strokeDashoffset={2 * Math.PI * 12 - (globalSummarize.status.total > 0 ? (globalSummarize.status.current / globalSummarize.status.total) : 0) * 2 * Math.PI * 12}
                strokeLinecap="round" className="transition-all duration-700" />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold tabular-nums" style={{ color: 'var(--gold)' }}>
              {globalSummarize.status.total > 0 ? Math.round((globalSummarize.status.current / globalSummarize.status.total) * 100) : 0}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold" style={{ color: 'var(--text-bright)' }}>
              Analysing papers
            </p>
            <p className="text-[10px] truncate max-w-[180px]" style={{ color: 'var(--text-muted)' }}>
              {globalSummarize.status.current}/{globalSummarize.status.total}
              {globalSummarize.status.current_title ? ` · ${globalSummarize.status.current_title.slice(0, 30)}…` : ''}
            </p>
          </div>
          <div className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse" style={{ background: 'var(--gold)', boxShadow: '0 0 8px rgba(54,50,183,0.4)' }} />
        </div>
      )}
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
          window.location.href = '/#/dashboard';   // HashRouter: hash prefix required
        } catch {}
      },
    });
    // LoginPage's useEffect handles renderButton — nothing to do here at init time
  };
  if (document.readyState === 'complete') tryInit();
  else window.addEventListener('load', tryInit);
})();
