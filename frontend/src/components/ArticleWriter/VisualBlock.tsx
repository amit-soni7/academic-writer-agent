/**
 * VisualBlock — inline visual recommendation block rendered inside the manuscript draft.
 *
 * States:
 *   recommended  → suggestion card with Accept/Dismiss buttons
 *   generating   → spinner
 *   generated    → preview (image or HTML table) with Edit/Finalize/Regenerate buttons
 *   editing      → "Being edited…" indicator
 *   finalized    → locked preview with green border
 *   dismissed    → hidden (not rendered by parent)
 */
import { useState } from 'react';
import type { VisualItem } from '../../types/paper';
import { visualImageUrl, figureBuilderImageUrl } from '../../api/projects';

interface Props {
  item: VisualItem;
  projectId: string;
  onAccept: (item: VisualItem) => void;
  onDismiss: (item: VisualItem) => void;
  onEdit: (item: VisualItem) => void;
  onFinalize: (item: VisualItem) => void;
  onRegenerate: (item: VisualItem) => void;
  onSelectCandidate?: (item: VisualItem, candidateId: string) => void;
}

const PRIORITY_STYLES: Record<string, { badge: string; border: string }> = {
  essential:   { badge: 'bg-rose-100 text-rose-700 border-rose-300',   border: 'border-rose-300' },
  recommended: { badge: 'bg-blue-100 text-blue-700 border-blue-300',   border: 'border-blue-300' },
  optional:    { badge: 'bg-slate-100 text-slate-600 border-slate-300', border: 'border-slate-300' },
};

function PriorityBadge({ priority }: { priority: string }) {
  const s = PRIORITY_STYLES[priority] || PRIORITY_STYLES.optional;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border uppercase tracking-wide ${s.badge}`}>
      {priority}
    </span>
  );
}

function TypeBadge({ type, renderMode }: { type: string; renderMode: string }) {
  const isTable = type === 'table';
  const label = isTable ? '⊞ Table' : renderMode === 'ai_illustration' ? '✦ Illustration' : '◎ Figure';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${
      isTable
        ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
        : 'bg-violet-50 text-violet-700 border-violet-300'
    }`}>
      {label}
    </span>
  );
}

export default function VisualBlock({ item, projectId, onAccept, onDismiss, onEdit, onFinalize, onRegenerate, onSelectCandidate }: Props) {
  const [candidateStripOpen, setCandidateStripOpen] = useState(false);
  const s = PRIORITY_STYLES[item.priority] || PRIORITY_STYLES.optional;
  const borderCls = item.status === 'finalized' ? 'border-emerald-300 bg-emerald-50/30' : `${s.border} bg-white`;

  // ── Recommended state ─────────────────────────────────────────────────────
  if (item.status === 'recommended') {
    return (
      <div className={`my-4 rounded-lg border-2 border-dashed ${s.border} bg-slate-50 overflow-hidden`}
           data-visual-id={item.id} data-visual-status="recommended">
        <div className="flex items-start gap-2 px-4 pt-3 pb-2">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <TypeBadge type={item.type} renderMode={item.render_mode} />
              <PriorityBadge priority={item.priority} />
              {item.image_backend && item.render_mode === 'ai_illustration' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-sky-50 text-sky-700 border-sky-300 uppercase tracking-wide">
                  {item.image_backend === 'gemini_imagen' ? 'Imagen' : 'OpenAI'}
                </span>
              )}
              {item.output_mode && item.render_mode === 'ai_illustration' && item.output_mode !== 'full_figure' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-fuchsia-50 text-fuchsia-700 border-fuchsia-300">
                  {item.output_mode.replace(/_/g, ' ')}
                </span>
              )}
              {item.reporting_guideline && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-amber-50 text-amber-700 border-amber-300">
                  {item.reporting_guideline}
                </span>
              )}
              {item.supplementary && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-100 text-slate-500 border-slate-300">
                  Supplementary
                </span>
              )}
            </div>
            <h4 className="text-sm font-semibold text-slate-800 leading-snug">{item.title}</h4>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{item.purpose}</p>
            {item.suggested_structure.length > 0 && (
              <p className="text-[11px] text-slate-400 mt-1">
                <span className="font-medium text-slate-500">
                  {item.type === 'table' ? 'Columns:' : 'Structure:'}
                </span>{' '}
                {item.suggested_structure.join(' · ')}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 pb-3 pt-1 border-t border-dashed border-slate-200 bg-slate-50/80">
          <button
            onClick={() => onAccept(item)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
          >
            {item.render_mode === 'ai_illustration' ? '✦ Open Prompt' : '✦ Accept & Generate'}
          </button>
          <button
            onClick={() => onDismiss(item)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ── Generating state ──────────────────────────────────────────────────────
  if (item.status === 'generating') {
    return (
      <div className={`my-4 rounded-lg border-2 border-dashed ${s.border} bg-slate-50 p-4`}
           data-visual-id={item.id} data-visual-status="generating">
        <div className="flex items-center gap-3 text-slate-500">
          <svg className="animate-spin h-4 w-4 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span className="text-sm">
            Generating {item.type === 'table' ? 'Table' : 'Figure'}: <em>{item.title}</em>…
          </span>
        </div>
      </div>
    );
  }

  // ── Editing state ─────────────────────────────────────────────────────────
  if (item.status === 'editing') {
    return (
      <div className={`my-4 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/40 p-4`}
           data-visual-id={item.id} data-visual-status="editing">
        <div className="flex items-center gap-3 text-amber-700">
          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span className="text-sm font-medium">Being edited: <em>{item.title}</em>…</span>
        </div>
      </div>
    );
  }

  // ── Generated / Finalized state ───────────────────────────────────────────
  if (item.status === 'generated' || item.status === 'finalized') {
    const isFinalized = item.status === 'finalized';
    const gen = item.generated;

    return (
      <div className={`my-4 rounded-lg border-2 ${borderCls} overflow-hidden`}
           data-visual-id={item.id} data-visual-status={item.status}>

        {/* Header */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5 pb-2">
          <TypeBadge type={item.type} renderMode={item.render_mode} />
          {isFinalized && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-emerald-100 text-emerald-700 border-emerald-300">
              ✓ Finalized
            </span>
          )}
          <span className="text-xs font-semibold text-slate-700 ml-0.5">{item.title}</span>
        </div>

        {/* Content */}
        <div className="px-4 pb-2">
          {/* Figure: render PNG */}
          {item.type === 'figure' && gen?.image_url && (
            <div className="my-2">
              <img
                src={`${visualImageUrl(projectId, item.id)}?cid=${gen.candidate_id ?? 'default'}`}
                alt={item.title}
                className="max-w-full rounded border border-slate-200"
                style={{ maxHeight: '420px', objectFit: 'contain' }}
              />
              {gen.caption && (
                <div className="mt-2 text-xs text-slate-600 leading-relaxed">
                  <strong>Figure caption:</strong> <em>{gen.caption}</em>
                </div>
              )}
              {gen.score && (
                <div className="mt-2 text-[11px] text-slate-500">
                  Quality score: <span className="font-semibold text-slate-700">{gen.score.overall?.toFixed?.(2) ?? gen.score.overall}</span>
                </div>
              )}

              {/* Candidate thumbnail strip — shown when multiple candidates were generated */}
              {item.render_mode === 'ai_illustration' && item.candidates && item.candidates.length > 1 && (
                <div className="mt-3">
                  <button
                    onClick={() => setCandidateStripOpen(o => !o)}
                    className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    {candidateStripOpen
                      ? '▴ Hide alternatives'
                      : `▾ View ${item.candidates.length - 1} alternative${item.candidates.length - 1 > 1 ? 's' : ''}`}
                  </button>
                  {candidateStripOpen && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.candidates.map(c => {
                        const isActive = c.id === gen.candidate_id;
                        return (
                          <button
                            key={c.id}
                            title={isActive ? 'Current selection' : 'Use this version'}
                            onClick={() => !isActive && onSelectCandidate?.(item, c.id)}
                            className={`relative rounded border-2 overflow-hidden transition-all ${
                              isActive
                                ? 'border-indigo-500 ring-2 ring-indigo-300 cursor-default'
                                : 'border-slate-200 hover:border-indigo-400 cursor-pointer'
                            }`}
                            style={{ width: 100, height: 72 }}
                          >
                            <img
                              src={figureBuilderImageUrl(projectId, c.id)}
                              alt={`Candidate ${c.id}`}
                              className="w-full h-full object-cover"
                            />
                            {isActive && (
                              <span className="absolute top-0.5 right-0.5 text-[9px] bg-indigo-500 text-white px-1 rounded">✓</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Table: render HTML */}
          {item.type === 'table' && gen?.table_html && (
            <div className="my-2 overflow-x-auto">
              {/* Caption above table (APA) */}
              {gen.caption && (
                <div className="mb-2 text-xs text-slate-700 font-semibold">
                  {gen.caption}
                </div>
              )}
              <div
                className="text-xs apa-table-wrapper"
                dangerouslySetInnerHTML={{ __html: gen.table_html }}
              />
            </div>
          )}

          {!gen && (
            <p className="text-xs text-slate-400 italic py-2">No preview available yet.</p>
          )}
        </div>

        {/* Actions */}
        {!isFinalized && (
          <div className="flex items-center gap-2 px-4 pb-3 pt-1 border-t border-slate-200 bg-slate-50/60">
            <button
              onClick={() => onEdit(item)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-700 text-xs font-medium border border-slate-200 transition-colors"
            >
              {item.render_mode === 'ai_illustration' ? '✎ Edit Prompt' : '✎ Edit'}
            </button>
            <button
              onClick={() => onFinalize(item)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium transition-colors"
            >
              ✓ Finalize
            </button>
            <button
              onClick={() => onRegenerate(item)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 transition-colors"
            >
              {item.render_mode === 'ai_illustration' ? '↺ Prompt & Regenerate' : '↺ Regenerate'}
            </button>
            <button
              onClick={() => onDismiss(item)}
              className="ml-auto flex items-center gap-1 px-2 py-1.5 rounded text-slate-400 hover:text-slate-600 text-xs transition-colors"
            >
              ✕ Remove
            </button>
          </div>
        )}

        {isFinalized && (
          <div className="flex items-center gap-2 px-4 pb-2 pt-1 border-t border-emerald-200">
            <button
              onClick={() => onEdit(item)}
              className="text-xs text-slate-500 hover:text-slate-700 underline"
            >
              Edit
            </button>
            <span className="text-slate-300">·</span>
            <button
              onClick={() => onDismiss(item)}
              className="text-xs text-slate-400 hover:text-rose-500"
            >
              Remove
            </button>
          </div>
        )}
      </div>
    );
  }

  return null;
}
