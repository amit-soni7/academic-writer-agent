import { useEffect, useState } from 'react';
import { deleteProject, listProjects } from '../../api/projects';
import type { ProjectMeta } from '../../types/paper';
import LoadingLottie from '../LoadingLottie';

interface Props {
  onResume: (projectId: string, query: string, projectType?: string | null, projectName?: string) => void;
}

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  intake:          { label: 'Intake',       color: 'bg-slate-100 text-slate-600' },
  literature:      { label: 'Literature',   color: 'bg-blue-100 text-blue-700' },
  cross_reference: { label: 'Cross-ref',    color: 'bg-violet-100 text-violet-700' },
  journals:        { label: 'Journals',     color: 'bg-indigo-100 text-indigo-700' },
  article:         { label: 'Article',      color: 'bg-emerald-100 text-emerald-700' },
};

function PhaseBadge({ phase }: { phase: string | null | undefined }) {
  const cfg = PHASE_LABELS[phase ?? 'intake'] ?? PHASE_LABELS['intake'];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function truncatePath(p: string | null | undefined, parts = 2): string {
  if (!p) return '';
  const segs = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return '…/' + segs.slice(-parts).join('/');
}

export default function ProjectsList({ onResume }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e?.message ?? 'Failed to load projects'))
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    if (!confirm('Delete this project and all its data?')) return;
    setDeleting(projectId);
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => p.project_id !== projectId));
    } catch {
      alert('Failed to delete project.');
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="px-6 py-8 text-center">
        <LoadingLottie className="w-20 h-20" label="Loading projects..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-4 text-sm text-rose-600">
        {error}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-sm text-slate-400">
        No previous projects found.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {projects.map((p) => (
        <li key={p.project_id}>
          <div
            className="w-full text-left px-6 py-4 hover:bg-slate-50 transition-colors group"
            role="button"
            tabIndex={0}
            onClick={() => onResume(p.project_id, p.query, p.project_type, p.project_name ?? undefined)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onResume(p.project_id, p.query, p.project_type, p.project_name ?? undefined);
              }
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                {/* Project name (prominent) */}
                <p className="text-sm font-semibold text-slate-800 truncate">
                  {p.project_name ?? p.query}
                </p>
                {/* Query as subtitle if project_name differs */}
                {p.project_name && p.project_name !== p.query && (
                  <p className="text-xs text-slate-500 truncate mt-0.5">{p.query}</p>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  <span className="font-mono text-xs text-slate-400">{p.project_id}</span>
                  <span className="text-xs text-slate-400">·</span>
                  <PhaseBadge phase={p.current_phase} />
                  <span className="text-xs text-slate-400">·</span>
                  {p.project_type === 'revision' ? (
                    <span className="text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded-full">↺ Revision</span>
                  ) : (
                    <span className="text-xs text-slate-500">{p.paper_count} papers</span>
                  )}
                  {p.summary_count > 0 && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-emerald-600">{p.summary_count} analysed</span>
                    </>
                  )}
                  {p.has_journals && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-indigo-600">journals done</span>
                    </>
                  )}
                  {p.has_article && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-amber-600">article written</span>
                    </>
                  )}
                </div>
                {p.project_folder && (
                  <p className="text-xs text-slate-400 mt-0.5 font-mono" title={p.project_folder}>
                    {truncatePath(p.project_folder)}
                  </p>
                )}
                <p className="text-xs text-slate-400 mt-1">
                  {new Date(p.updated_at).toLocaleString()}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => handleDelete(e, p.project_id)}
                  disabled={deleting === p.project_id}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg
                    text-slate-400 hover:text-rose-500 hover:bg-rose-50 disabled:opacity-30"
                  title="Delete project"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                <span className="text-xs font-medium text-brand-600 group-hover:underline">
                  Resume →
                </span>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
