import { useEffect, useState } from 'react';
import { deleteProject, listProjects } from '../../api/projects';
import type { ProjectMeta } from '../../types/paper';
import LoadingLottie from '../LoadingLottie';

interface Props {
  onResume: (projectId: string, query: string, projectType?: string | null, projectName?: string) => void;
}

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  intake:          { label: 'intake',       color: 'bg-slate-200 text-slate-500' },
  literature:      { label: 'literature',   color: 'bg-blue-100 text-blue-700' },
  cross_reference: { label: 'cross-ref',    color: 'bg-violet-100 text-violet-700' },
  journals:        { label: 'journals',     color: 'bg-indigo-100 text-indigo-700' },
  article:         { label: 'article',      color: 'bg-emerald-100 text-emerald-700' },
};

function PhaseBadge({ phase }: { phase: string | null | undefined }) {
  const cfg = PHASE_LABELS[phase ?? 'intake'] ?? PHASE_LABELS['intake'];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border font-mono text-[10px] ${cfg.color}`}
      style={{ borderColor: 'currentColor', borderOpacity: 0.3 }}>
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
    <ul className="divide-y divide-slate-200">
      {projects.map((p) => (
        <li key={p.project_id}>
          <div
            className="w-full text-left px-5 py-3.5 hover:bg-slate-200 transition-colors group cursor-pointer"
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
                <p className="text-sm font-medium text-slate-800 truncate leading-snug">
                  {p.project_name ?? p.query}
                </p>
                {p.project_name && p.project_name !== p.query && (
                  <p className="text-xs text-slate-500 truncate mt-0.5">{p.query}</p>
                )}
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <PhaseBadge phase={p.current_phase} />
                  <span className="text-slate-400" style={{ fontSize: '10px' }}>·</span>
                  {p.project_type === 'revision' ? (
                    <span className="font-mono text-[10px] text-violet-700 bg-violet-100 border border-violet-200
                      px-1.5 py-0.5 rounded">↺ revision</span>
                  ) : (
                    <span className="font-mono text-[10px] text-slate-400">{p.paper_count} papers</span>
                  )}
                  {p.summary_count > 0 && (
                    <span className="font-mono text-[10px] text-emerald-700">· {p.summary_count} analysed</span>
                  )}
                  {p.has_article && (
                    <span className="font-mono text-[10px]" style={{ color: 'var(--gold)' }}>· article written</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1">
                  {p.project_folder && (
                    <p className="font-mono text-[10px] text-slate-400 truncate" title={p.project_folder}>
                      {truncatePath(p.project_folder)}
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-slate-400">
                    {new Date(p.updated_at).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => handleDelete(e, p.project_id)}
                  disabled={deleting === p.project_id}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded
                    text-slate-400 hover:text-rose-500 disabled:opacity-30"
                  style={{ '--tw-bg-opacity': '1' } as React.CSSProperties}
                  title="Delete project"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                <span className="font-mono text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: 'var(--gold)' }}>
                  open →
                </span>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
