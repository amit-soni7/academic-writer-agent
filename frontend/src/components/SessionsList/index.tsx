import { useEffect, useState } from 'react';
import { deleteProject as deleteSession, listProjects as listSessions } from '../../api/projects';
import type { ProjectMeta as SessionMeta } from '../../types/paper';
import LoadingLottie from '../LoadingLottie';

interface Props {
  onResume: (sessionId: string, query: string) => void;
}

export default function SessionsList({ onResume }: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setError(e?.message ?? 'Failed to load sessions'))
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    if (!confirm('Delete this session and all its data?')) return;
    setDeleting(sessionId);
    try {
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.project_id !== sessionId));
    } catch {
      alert('Failed to delete session.');
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="px-6 py-8 text-center">
        <LoadingLottie className="w-20 h-20" label="Loading sessions..." />
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

  if (sessions.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-sm text-slate-400">
        No previous sessions found.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {sessions.map((s) => (
        <li key={s.project_id}>
          <div
            className="w-full text-left px-6 py-4 hover:bg-slate-50 transition-colors group"
            role="button"
            tabIndex={0}
            onClick={() => onResume(s.project_id, s.query)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onResume(s.project_id, s.query);
              }
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 truncate">{s.query}</p>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  <span className="font-mono text-xs text-slate-400">{s.project_id}</span>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs text-slate-500">{s.paper_count} papers</span>
                  {s.summary_count > 0 && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-emerald-600">{s.summary_count} analysed</span>
                    </>
                  )}
                  {s.has_journals && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-indigo-600">journals done</span>
                    </>
                  )}
                  {s.has_article && (
                    <>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-amber-600">article written</span>
                    </>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {new Date(s.updated_at).toLocaleString()}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={(e) => handleDelete(e, s.project_id)}
                  disabled={deleting === s.project_id}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg
                    text-slate-400 hover:text-rose-500 hover:bg-rose-50 disabled:opacity-30"
                  title="Delete session"
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
