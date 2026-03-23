/**
 * DeepSynthesisPanel — Multi-stage deep synthesis UI
 *
 * During pipeline execution shows:
 *   - Vertical stage cards with descriptions, live sub-messages, sample data
 *   - Scrolling activity feed showing AI thoughts and actions
 *   - Running stats dashboard with counters
 *
 * After completion shows:
 *   - Result tabs: Claim Clusters | Contradictions | Theory Map | Manuscript Packs
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import type {
  ClaimCluster,
  ContradictionDetail,
  DeepSynthesisResult,
  DeepSynthesisSSEEvent,
  LLMErrorResponse,
  NormalizedClaim,
  TheoryReference,
} from '../../types/paper';

interface Props {
  result: DeepSynthesisResult | null;
  events: DeepSynthesisSSEEvent[];
  isRunning: boolean;
}

const STAGES = [
  {
    key: 'extract_evidence',
    label: 'Extract Evidence',
    icon: 'data_object',
    description: 'Scanning papers for results, sentence banks, and claims',
    color: '#6366f1',
  },
  {
    key: 'normalize_claims',
    label: 'Normalize Claims',
    icon: 'transform',
    description: 'Merging duplicates into canonical claims with structured metadata',
    color: '#8b5cf6',
  },
  {
    key: 'auto_fetch',
    label: 'Auto-Fetch',
    icon: 'travel_explore',
    description: 'Searching for additional papers to strengthen thin claims',
    color: '#3b82f6',
  },
  {
    key: 'cluster_claims',
    label: 'Cluster Claims',
    icon: 'hub',
    description: 'Grouping semantically related claims into thematic clusters',
    color: '#06b6d4',
  },
  {
    key: 'synthesize_clusters',
    label: 'Synthesize',
    icon: 'psychology',
    description: 'Synthesizing evidence and decomposing contradictions',
    color: '#10b981',
  },
  {
    key: 'detect_theories',
    label: 'Theory Detection',
    icon: 'school',
    description: 'Mapping theoretical frameworks across the corpus',
    color: '#f59e0b',
  },
  {
    key: 'build_packs',
    label: 'Manuscript Packs',
    icon: 'inventory_2',
    description: 'Building section-oriented evidence packs with narrative arcs',
    color: '#ec4899',
  },
];

type ResultTab = 'clusters' | 'contradictions' | 'theories' | 'packs';

const DIRECTION_BADGE: Record<string, { label: string; cls: string }> = {
  consistent: { label: 'Consistent', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  mixed: { label: 'Mixed', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  contradictory: { label: 'Contradictory', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const EFFECT_BADGE: Record<string, { label: string; cls: string }> = {
  positive: { label: 'Positive', cls: 'text-emerald-600' },
  negative: { label: 'Negative', cls: 'text-rose-600' },
  null: { label: 'Null', cls: 'text-slate-500' },
  mixed: { label: 'Mixed', cls: 'text-amber-600' },
};

// ── Main Component ──────────────────────────────────────────────────────────

export default function DeepSynthesisPanel({ result, events, isRunning }: Props) {
  const [activeTab, setActiveTab] = useState<ResultTab>('clusters');

  const completedStages = useMemo(() => {
    const set = new Set(result?.stages_completed ?? []);
    if (isRunning) {
      for (const e of events) {
        if (e.type === 'stage_complete' && e.stage_name) {
          set.add(e.stage_name);
        }
      }
    }
    return set;
  }, [result, events, isRunning]);

  const currentStage = isRunning
    ? events.filter(e => e.type === 'stage_start').pop()?.stage_name
    : null;

  // Live stats from events
  const liveStats = useMemo(() => {
    const stats: Record<string, number | string> = {};
    for (const e of events) {
      if (e.type === 'stage_complete' || e.type === 'progress') {
        const d = e.detail ?? {};
        if (d.evidence_objects) stats.evidence = d.evidence_objects as number;
        if (d.claims_count) stats.claims = d.claims_count as number;
        if ((d as Record<string, unknown>).normalized_claims) stats.claims = (d as Record<string, unknown>).normalized_claims as number;
        if (d.clusters && typeof d.clusters === 'number') stats.clusters = d.clusters as number;
        if (d.clusters && Array.isArray(d.clusters)) stats.clusters = d.clusters.length;
        if ((d as Record<string, unknown>).theories_detected) stats.theories = (d as Record<string, unknown>).theories_detected as number;
        if ((d as Record<string, unknown>).sections_packed) stats.sections = (d as Record<string, unknown>).sections_packed as number;
        if ((d as Record<string, unknown>).total_contradictions !== undefined) stats.contradictions = (d as Record<string, unknown>).total_contradictions as number;
        if ((d as Record<string, unknown>).contradictions_found !== undefined) stats.contradictions = (d as Record<string, unknown>).contradictions_found as number;
        if ((d as Record<string, unknown>).papers_summarized) stats.autoFetched = (d as Record<string, unknown>).papers_summarized as number;
      }
    }
    return stats;
  }, [events]);

  // Show running pipeline OR completed results
  if (isRunning) {
    return (
      <PipelineRunningView
        events={events}
        completedStages={completedStages}
        currentStage={currentStage}
        liveStats={liveStats}
      />
    );
  }

  if (!result) return null;

  return (
    <div className="space-y-6">
      {/* Completion header */}
      <CompletionHeader result={result} events={events} />

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl"
        style={{ background: 'var(--bg-hover, #f1f5f9)' }}>
        {([
          { key: 'clusters' as const, label: 'Claim Clusters', icon: 'hub', count: result.claim_clusters.length },
          { key: 'contradictions' as const, label: 'Contradictions', icon: 'compare_arrows',
            count: result.claim_clusters.reduce((sum, c) => sum + c.contradiction_details.length, 0) },
          { key: 'theories' as const, label: 'Theory Map', icon: 'school', count: result.theory_map.length },
          { key: 'packs' as const, label: 'Manuscript Packs', icon: 'inventory_2',
            count: Object.keys(result.manuscript_packs?.section_packs ?? {}).length },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === tab.key
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
            {tab.label}
            {tab.count > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                activeTab === tab.key ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500'
              }`}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="rounded-xl p-5"
        style={{
          background: 'var(--bg-surface, #fff)',
          border: '1px solid var(--border-faint, #f1f1f4)',
        }}>
        {activeTab === 'clusters' && <ClustersList clusters={result.claim_clusters} />}
        {activeTab === 'contradictions' && <ContradictionsList clusters={result.claim_clusters} />}
        {activeTab === 'theories' && <TheoriesList theories={result.theory_map} />}
        {activeTab === 'packs' && <PacksList packs={result.manuscript_packs} />}
      </div>
    </div>
  );
}

// ── Pipeline Running View ───────────────────────────────────────────────────

function PipelineRunningView({
  events,
  completedStages,
  currentStage,
  liveStats,
}: {
  events: DeepSynthesisSSEEvent[];
  completedStages: Set<string>;
  currentStage: string | null | undefined;
  liveStats: Record<string, number | string>;
}) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll activity feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events]);

  // Build activity feed entries from events
  const feedEntries = useMemo(() => {
    return events
      .filter(e => e.message)
      .map((e, i) => ({
        id: i,
        type: e.type,
        stage: e.stage,
        stageName: e.stage_name,
        message: e.message!,
        detail: e.detail,
        error: e.error,
        time: new Date(),
      }));
  }, [events]);

  return (
    <div className="space-y-4">
      {/* Header with animated gradient */}
      <div className="rounded-xl p-5 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #6366f1 100%)',
        }}>
        {/* Animated background pulse */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute inset-0 animate-pulse"
            style={{
              background: 'radial-gradient(circle at 30% 50%, rgba(255,255,255,0.3) 0%, transparent 60%)',
            }}
          />
        </div>

        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-xl animate-spin"
              style={{ animationDuration: '2s' }}>
              neurology
            </span>
          </div>
          <div>
            <h3 className="text-white font-bold text-sm tracking-wide"
              style={{ fontFamily: 'Manrope, sans-serif' }}>
              Deep Synthesis Engine
            </h3>
            <p className="text-white/70 text-xs mt-0.5">
              Multi-stage evidence analysis in progress
            </p>
          </div>
        </div>

        {/* Live stats counters */}
        {Object.keys(liveStats).length > 0 && (
          <div className="relative z-10 mt-4 flex gap-3 flex-wrap">
            {liveStats.evidence && (
              <StatChip label="Evidence" value={liveStats.evidence} icon="data_object" />
            )}
            {liveStats.claims && (
              <StatChip label="Claims" value={liveStats.claims} icon="transform" />
            )}
            {liveStats.clusters && (
              <StatChip label="Clusters" value={liveStats.clusters} icon="hub" />
            )}
            {liveStats.contradictions !== undefined && Number(liveStats.contradictions) > 0 && (
              <StatChip label="Contradictions" value={liveStats.contradictions} icon="compare_arrows" />
            )}
            {liveStats.theories && (
              <StatChip label="Theories" value={liveStats.theories} icon="school" />
            )}
            {liveStats.autoFetched && Number(liveStats.autoFetched) > 0 && (
              <StatChip label="Auto-fetched" value={liveStats.autoFetched} icon="travel_explore" />
            )}
            {liveStats.sections && (
              <StatChip label="Sections" value={liveStats.sections} icon="inventory_2" />
            )}
          </div>
        )}
      </div>

      {/* Two-column layout: stages + activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* Left: Vertical stage pipeline */}
        <div className="rounded-xl p-4 space-y-1"
          style={{
            background: 'var(--bg-surface, #fff)',
            border: '1px solid var(--border-faint, #f1f1f4)',
          }}>
          <h4 className="text-[10px] font-bold uppercase tracking-widest mb-3"
            style={{ color: 'var(--text-secondary, #64748b)', fontFamily: 'Manrope, sans-serif' }}>
            Pipeline Stages
          </h4>
          {STAGES.map((stage, i) => {
            const done = completedStages.has(stage.key) || completedStages.has(stage.key + '_skipped');
            const active = currentStage === stage.key;
            const stageCompleteEvent = events.find(
              e => e.type === 'stage_complete' && e.stage_name === stage.key
            );
            const completionMsg = stageCompleteEvent?.message;
            const hasWarning = events.some(
              e => e.type === 'warning' && e.stage_name === stage.key
            );

            return (
              <div key={stage.key}>
                <StageCard
                  stage={stage}
                  done={done}
                  active={active}
                  completionMessage={completionMsg}
                  hasWarning={hasWarning}
                />
                {/* Connector line */}
                {i < STAGES.length - 1 && (
                  <div className="flex justify-center py-0.5">
                    <div className={`w-0.5 h-3 rounded-full transition-colors ${
                      done ? 'bg-emerald-300' : active ? 'bg-indigo-200' : 'bg-slate-100'
                    }`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Right: Activity feed */}
        <div className="rounded-xl flex flex-col"
          style={{
            background: 'var(--bg-surface, #fff)',
            border: '1px solid var(--border-faint, #f1f1f4)',
            maxHeight: '600px',
          }}>
          <div className="px-4 py-3 border-b flex items-center gap-2"
            style={{ borderColor: 'var(--border-faint, #f1f1f4)' }}>
            <span className="material-symbols-outlined text-sm text-indigo-500">terminal</span>
            <h4 className="text-[10px] font-bold uppercase tracking-widest"
              style={{ color: 'var(--text-secondary, #64748b)', fontFamily: 'Manrope, sans-serif' }}>
              Live Activity
            </h4>
            <div className="ml-auto flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] text-slate-400">streaming</span>
            </div>
          </div>

          <div ref={feedRef} className="flex-1 overflow-y-auto p-3 space-y-2"
            style={{ minHeight: '200px' }}>
            {feedEntries.length === 0 && (
              <div className="flex items-center justify-center h-full text-slate-300">
                <span className="material-symbols-outlined text-3xl animate-pulse">
                  hourglass_top
                </span>
              </div>
            )}
            {feedEntries.map(entry => (
              <ActivityEntry key={entry.id} entry={entry} />
            ))}
            {/* Typing indicator at bottom */}
            <div className="flex items-center gap-2 px-3 py-2">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Stage Card ──────────────────────────────────────────────────────────────

function StageCard({
  stage,
  done,
  active,
  completionMessage,
  hasWarning,
}: {
  stage: typeof STAGES[number];
  done: boolean;
  active: boolean;
  completionMessage?: string;
  hasWarning?: boolean;
}) {
  return (
    <div className={`
      rounded-lg px-3 py-2.5 transition-all
      ${active ? 'ring-2 ring-offset-1 shadow-sm' : ''}
      ${done ? 'opacity-80' : !active ? 'opacity-50' : ''}
    `}
    style={{
      background: active
        ? `${stage.color}08`
        : done && hasWarning
          ? '#fffbeb'
          : done
            ? 'var(--bg-hover, #f8fafc)'
            : 'transparent',
      ...(active ? { ringColor: stage.color } : {}),
      borderLeft: active ? `3px solid ${stage.color}` : done && hasWarning ? '3px solid #f59e0b' : done ? '3px solid #10b981' : '3px solid transparent',
    }}>
      <div className="flex items-center gap-2.5">
        <div className={`
          w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all
        `}
        style={{
          background: done && hasWarning ? '#fef3c7' : done ? '#d1fae5' : active ? `${stage.color}18` : '#f1f5f9',
          color: done && hasWarning ? '#d97706' : done ? '#059669' : active ? stage.color : '#94a3b8',
        }}>
          {done && hasWarning ? (
            <span className="material-symbols-outlined text-sm">warning</span>
          ) : done ? (
            <span className="material-symbols-outlined text-sm">check_circle</span>
          ) : active ? (
            <span className="material-symbols-outlined text-sm animate-spin"
              style={{ animationDuration: '1.5s' }}>
              progress_activity
            </span>
          ) : (
            <span className="material-symbols-outlined text-sm">{stage.icon}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold"
            style={{
              color: done ? '#059669' : active ? stage.color : '#94a3b8',
              fontFamily: 'Manrope, sans-serif',
            }}>
            {stage.label}
          </div>
          <div className="text-[10px] truncate"
            style={{
              color: done
                ? 'var(--text-secondary, #64748b)'
                : active
                  ? 'var(--text-primary, #475569)'
                  : '#cbd5e1',
            }}>
            {done && completionMessage
              ? completionMessage
              : active
                ? stage.description
                : stage.description}
          </div>
        </div>
      </div>

      {/* Active stage animated bar */}
      {active && (
        <div className="mt-2 h-1 rounded-full overflow-hidden bg-slate-100">
          <div
            className="h-full rounded-full"
            style={{
              background: `linear-gradient(90deg, ${stage.color}, ${stage.color}80)`,
              animation: 'indeterminate 1.5s infinite ease-in-out',
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Activity Feed Entry ─────────────────────────────────────────────────────

function ActivityEntry({ entry }: {
  entry: {
    id: number;
    type: string;
    stage?: number;
    stageName?: string;
    message: string;
    detail?: Record<string, unknown>;
    error?: LLMErrorResponse;
  };
}) {
  const stageInfo = STAGES.find(s => s.key === entry.stageName);
  const color = stageInfo?.color ?? '#6366f1';

  const isWarning = entry.type === 'warning';
  const isError = entry.type === 'error';

  const icon = isWarning
    ? 'warning'
    : isError
      ? 'error'
      : entry.type === 'stage_start'
        ? 'play_circle'
        : entry.type === 'stage_complete'
          ? 'check_circle'
          : entry.type === 'progress'
            ? 'neurology'
            : 'info';

  const isStageEvent = entry.type === 'stage_start' || entry.type === 'stage_complete';

  return (
    <div className={`
      rounded-lg px-3 py-2 transition-all animate-fadeIn
      ${isStageEvent || isWarning || isError ? 'border' : ''}
    `}
    style={{
      background: isError ? '#fef2f2' : isWarning ? '#fffbeb' : isStageEvent ? `${color}06` : 'transparent',
      borderColor: isError ? '#fecaca' : isWarning ? '#fde68a' : isStageEvent ? `${color}20` : 'transparent',
    }}>
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined flex-shrink-0 mt-0.5"
          style={{
            fontSize: '14px',
            color: isError ? '#dc2626' : isWarning ? '#d97706' : entry.type === 'stage_complete' ? '#059669' : color,
          }}>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs leading-relaxed"
            style={{
              color: isError ? '#991b1b' : isWarning ? '#92400e' : isStageEvent ? 'var(--text-bright, #1e293b)' : 'var(--text-primary, #475569)',
              fontWeight: isStageEvent || isWarning || isError ? 600 : 400,
              fontFamily: 'Manrope, sans-serif',
            }}>
            {entry.message}
          </p>

          {/* LLM error details */}
          {entry.error && (
            <div className={`mt-1.5 rounded-md px-2.5 py-2 text-[10px] space-y-1 ${
              isError ? 'bg-red-50 border border-red-200' : 'bg-amber-50 border border-amber-200'
            }`}>
              <div className="flex items-center gap-2 flex-wrap">
                {entry.error.status_code && (
                  <span className={`px-1.5 py-0.5 rounded font-bold ${
                    isError ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {entry.error.status_code}
                  </span>
                )}
                <span className="text-slate-500">
                  {entry.error.provider} / {entry.error.model}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                  entry.error.is_transient ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-600'
                }`}>
                  {entry.error.is_transient ? 'transient' : 'permanent'}
                </span>
              </div>
              <p className="text-slate-600 leading-relaxed break-all">
                {entry.error.message}
              </p>
            </div>
          )}

          {/* Sample data from detail */}
          {entry.detail && <DetailChips detail={entry.detail} color={color} />}
        </div>
      </div>
    </div>
  );
}

// ── Detail Chips (show sample data from progress events) ────────────────────

function DetailChips({ detail, color }: { detail: Record<string, unknown>; color: string }) {
  // Show sample claims
  const samples = detail.samples as Array<{ text?: string; direction?: string; papers?: number; grade?: string } | string> | undefined;
  // Show cluster info
  const clusters = detail.clusters as Array<{ label?: string; claims?: number; direction?: string; strength?: number; section?: string; themes?: number; citations?: number; narrative_arc?: string; synthesis?: string; contradictions?: number }> | undefined;
  // Show queries
  const queries = detail.queries as string[] | undefined;
  // Show theories
  const theories = detail.theories as Array<{ name?: string; support?: string; description?: string }> | undefined;
  // Show papers
  const papers = detail.papers as string[] | undefined;
  // Source breakdown
  const bySource = detail.by_source as Record<string, number> | undefined;
  // Direction breakdown
  const byDirection = detail.by_direction as Record<string, number> | undefined;
  // Thin claims
  const thinClaims = detail.thin_claims as number | undefined;

  const hasContent = samples || clusters || queries || theories || papers || bySource || byDirection;
  if (!hasContent) return null;

  return (
    <div className="mt-1.5 space-y-1.5">
      {/* Source breakdown badges */}
      {bySource && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(bySource).map(([src, count]) => (
            <span key={src} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 border border-slate-100">
              {src.replace('_', ' ')}: {count}
            </span>
          ))}
        </div>
      )}

      {/* Direction breakdown */}
      {byDirection && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(byDirection).map(([dir, count]) => {
            const dirColor = dir === 'positive' ? '#059669' : dir === 'negative' ? '#dc2626' : dir === 'null' ? '#64748b' : '#d97706';
            return (
              <span key={dir} className="text-[9px] px-1.5 py-0.5 rounded border"
                style={{ color: dirColor, borderColor: `${dirColor}30`, background: `${dirColor}08` }}>
                {dir}: {count}
              </span>
            );
          })}
        </div>
      )}

      {/* Sample evidence / claims */}
      {samples && samples.length > 0 && (
        <div className="space-y-1">
          {samples.slice(0, 4).map((s, i) => {
            const text = typeof s === 'string' ? s : s.text ?? '';
            const direction = typeof s === 'object' ? s.direction : undefined;
            const grade = typeof s === 'object' ? s.grade : undefined;
            const paperCount = typeof s === 'object' ? s.papers : undefined;
            return (
              <div key={i} className="flex items-start gap-1.5 text-[10px]">
                <span style={{ color }} className="mt-0.5 flex-shrink-0">&#x2022;</span>
                <span className="text-slate-600 leading-relaxed">{text}</span>
                {direction && (
                  <span className="flex-shrink-0 text-[9px] px-1 rounded"
                    style={{
                      color: direction === 'positive' ? '#059669' : direction === 'negative' ? '#dc2626' : '#d97706',
                      background: direction === 'positive' ? '#d1fae520' : direction === 'negative' ? '#fee2e220' : '#fef3c720',
                    }}>
                    {direction}
                  </span>
                )}
                {grade && (
                  <span className="flex-shrink-0 text-[9px] px-1 rounded bg-blue-50 text-blue-600">{grade}</span>
                )}
                {paperCount && (
                  <span className="flex-shrink-0 text-[9px] text-slate-400">{paperCount}p</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Paper titles */}
      {papers && papers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {papers.slice(0, 6).map((p, i) => (
            <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full border border-slate-100 text-slate-500 bg-slate-50 max-w-[200px] truncate">
              {p}
            </span>
          ))}
          {papers.length > 6 && (
            <span className="text-[9px] text-slate-400">+{papers.length - 6} more</span>
          )}
        </div>
      )}

      {/* Search queries */}
      {queries && queries.length > 0 && (
        <div className="space-y-1">
          {queries.map((q, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px]">
              <span className="material-symbols-outlined text-blue-400" style={{ fontSize: '12px' }}>search</span>
              <span className="text-slate-600 italic">{q}</span>
            </div>
          ))}
        </div>
      )}

      {/* Cluster info */}
      {clusters && clusters.length > 0 && (
        <div className="space-y-1">
          {clusters.slice(0, 5).map((cl, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] rounded-md px-2 py-1"
              style={{ background: `${color}06` }}>
              <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: '12px', color }}>
                {cl.section ? 'article' : 'hub'}
              </span>
              <span className="font-medium text-slate-700 truncate flex-1">
                {cl.label ?? cl.section ?? 'Cluster'}
              </span>
              {cl.claims !== undefined && (
                <span className="text-[9px] text-slate-400 flex-shrink-0">{cl.claims} claims</span>
              )}
              {cl.themes !== undefined && (
                <span className="text-[9px] text-slate-400 flex-shrink-0">{cl.themes} themes</span>
              )}
              {cl.direction && (
                <span className={`text-[9px] px-1 rounded flex-shrink-0 ${
                  cl.direction === 'consistent' ? 'bg-emerald-50 text-emerald-600'
                    : cl.direction === 'contradictory' ? 'bg-rose-50 text-rose-600'
                      : 'bg-amber-50 text-amber-600'
                }`}>{cl.direction}</span>
              )}
              {cl.strength !== undefined && (
                <span className="text-[9px] text-slate-400 flex-shrink-0">{Math.round(cl.strength * 100)}%</span>
              )}
              {cl.contradictions !== undefined && cl.contradictions > 0 && (
                <span className="text-[9px] text-rose-500 flex-shrink-0">{cl.contradictions} contradictions</span>
              )}
            </div>
          ))}
          {clusters.length > 5 && (
            <span className="text-[9px] text-slate-400 pl-2">+{clusters.length - 5} more</span>
          )}
        </div>
      )}

      {/* Theories */}
      {theories && theories.length > 0 && (
        <div className="space-y-1">
          {theories.map((t, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px]">
              <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: '12px', color: '#f59e0b' }}>school</span>
              <div>
                <span className="font-medium text-slate-700">{t.name}</span>
                {t.support && (
                  <span className={`ml-1.5 text-[9px] px-1 rounded ${
                    t.support === 'strong' ? 'bg-emerald-50 text-emerald-600'
                      : t.support === 'moderate' ? 'bg-blue-50 text-blue-600'
                        : 'bg-amber-50 text-amber-600'
                  }`}>{t.support}</span>
                )}
                {t.description && (
                  <p className="text-slate-500 mt-0.5 leading-relaxed">{t.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Thin claims count */}
      {thinClaims !== undefined && thinClaims > 0 && !samples && (
        <div className="text-[10px] text-amber-600 flex items-center gap-1">
          <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>warning</span>
          {thinClaims} claims need additional evidence
        </div>
      )}
    </div>
  );
}

// ── Stat Chip ───────────────────────────────────────────────────────────────

function StatChip({ label, value, icon }: { label: string; value: number | string; icon: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/15 backdrop-blur-sm">
      <span className="material-symbols-outlined text-white/70" style={{ fontSize: '14px' }}>{icon}</span>
      <span className="text-white font-bold text-sm">{value}</span>
      <span className="text-white/60 text-[10px]">{label}</span>
    </div>
  );
}

// ── Completion Header ───────────────────────────────────────────────────────

function CompletionHeader({ result, events }: { result: DeepSynthesisResult; events: DeepSynthesisSSEEvent[] }) {
  const completeEvent = events.find(e => e.type === 'complete');
  const summary = completeEvent?.summary as Record<string, unknown> | undefined;
  const warningCount = (result.warnings ?? []).length;
  const hasWarnings = warningCount > 0;

  return (
    <div className="rounded-xl p-5"
      style={{
        background: hasWarnings
          ? 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)'
          : 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
      }}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
          <span className="material-symbols-outlined text-white text-xl">
            {hasWarnings ? 'warning' : 'check_circle'}
          </span>
        </div>
        <div>
          <h3 className="text-white font-bold text-sm"
            style={{ fontFamily: 'Manrope, sans-serif' }}>
            Deep Synthesis Complete
            {hasWarnings && ` (${warningCount} warning${warningCount > 1 ? 's' : ''})`}
          </h3>
          <p className="text-white/70 text-xs mt-0.5">
            {hasWarnings
              ? 'Some stages used fallback due to AI errors — results may be less refined'
              : summary?.total_time ? `Finished in ${summary.total_time}` : 'Pipeline completed successfully'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-3 flex-wrap">
        <StatChip label="Claims" value={result.normalized_claims.length} icon="transform" />
        <StatChip label="Clusters" value={result.claim_clusters.length} icon="hub" />
        {result.claim_clusters.reduce((s, c) => s + c.contradiction_details.length, 0) > 0 && (
          <StatChip
            label="Contradictions"
            value={result.claim_clusters.reduce((s, c) => s + c.contradiction_details.length, 0)}
            icon="compare_arrows"
          />
        )}
        <StatChip label="Theories" value={result.theory_map.length} icon="school" />
        <StatChip
          label="Sections"
          value={Object.keys(result.manuscript_packs?.section_packs ?? {}).length}
          icon="inventory_2"
        />
        {result.auto_fetch_result && result.auto_fetch_result.papers_summarized > 0 && (
          <StatChip label="Auto-fetched" value={result.auto_fetch_result.papers_summarized} icon="travel_explore" />
        )}
        {hasWarnings && (
          <StatChip label="Warnings" value={warningCount} icon="warning" />
        )}
      </div>
    </div>
  );
}

// ── Result Sub-components ───────────────────────────────────────────────────

function ClustersList({ clusters }: { clusters: ClaimCluster[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!clusters.length) {
    return <p className="text-sm text-slate-500 text-center py-8">No claim clusters generated.</p>;
  }

  return (
    <div className="space-y-3">
      {clusters.map(cluster => {
        const badge = DIRECTION_BADGE[cluster.overall_direction] ?? DIRECTION_BADGE.mixed;
        const expanded = expandedId === cluster.cluster_id;
        return (
          <div key={cluster.cluster_id} className="rounded-lg border border-slate-100 overflow-hidden">
            <button
              onClick={() => setExpandedId(expanded ? null : cluster.cluster_id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
            >
              <span className="material-symbols-outlined text-base text-indigo-500">
                {expanded ? 'expand_less' : 'expand_more'}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-slate-800">{cluster.cluster_label}</span>
                <span className="ml-2 text-xs text-slate-500">
                  ({cluster.claims.length} claims)
                </span>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${badge.cls}`}>
                {badge.label}
              </span>
              <StrengthBar strength={cluster.strength} />
            </button>

            {expanded && (
              <div className="px-4 pb-4 space-y-3 border-t border-slate-50">
                {cluster.synthesis_statement && (
                  <p className="text-sm text-slate-700 bg-indigo-50/50 rounded-lg px-3 py-2 mt-3 italic">
                    {cluster.synthesis_statement}
                  </p>
                )}
                {cluster.claims.map(claim => (
                  <ClaimCard key={claim.claim_id} claim={claim} />
                ))}
                {cluster.contradiction_details.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <h5 className="text-xs font-bold uppercase tracking-wider text-rose-600">Contradictions</h5>
                    {cluster.contradiction_details.map((cd, i) => (
                      <ContradictionCard key={i} detail={cd} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClaimCard({ claim }: { claim: NormalizedClaim }) {
  const effect = EFFECT_BADGE[claim.effect_direction] ?? EFFECT_BADGE.mixed;
  return (
    <div className="pl-4 border-l-2 border-indigo-100 space-y-1">
      <p className="text-sm text-slate-800">{claim.canonical_text}</p>
      <div className="flex flex-wrap gap-2 text-[10px]">
        {claim.population && (
          <span className="px-2 py-0.5 rounded-full bg-slate-50 text-slate-600">
            Pop: {claim.population}
          </span>
        )}
        {claim.outcome && (
          <span className="px-2 py-0.5 rounded-full bg-slate-50 text-slate-600">
            Out: {claim.outcome}
          </span>
        )}
        <span className={`font-semibold ${effect.cls}`}>
          {effect.label}
        </span>
        {claim.effect_magnitude && (
          <span className="text-slate-500">{claim.effect_magnitude}</span>
        )}
        {claim.evidence_grade && (
          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">
            {claim.evidence_grade}
          </span>
        )}
        <span className="text-slate-400">
          {claim.source_paper_keys.length} paper{claim.source_paper_keys.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

function ContradictionCard({ detail }: { detail: ContradictionDetail }) {
  return (
    <div className="rounded-lg bg-rose-50/50 border border-rose-100 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-outlined text-sm text-rose-500">compare_arrows</span>
        <span className="font-semibold text-rose-700 capitalize">{detail.dimension}</span>
      </div>
      <p className="text-slate-700">{detail.description}</p>
      {detail.resolution_hypothesis && (
        <p className="mt-1 text-slate-500 italic">
          Resolution: {detail.resolution_hypothesis}
        </p>
      )}
    </div>
  );
}

function ContradictionsList({ clusters }: { clusters: ClaimCluster[] }) {
  const allContradictions = clusters.flatMap(c =>
    c.contradiction_details.map(cd => ({ ...cd, cluster_label: c.cluster_label }))
  );

  if (!allContradictions.length) {
    return <p className="text-sm text-slate-500 text-center py-8">No contradictions detected.</p>;
  }

  return (
    <div className="space-y-3">
      {allContradictions.map((cd, i) => (
        <div key={i} className="rounded-lg border border-rose-100 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-base text-rose-500">warning</span>
            <span className="text-sm font-semibold text-slate-800">{(cd as { cluster_label: string }).cluster_label}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 capitalize">
              {cd.dimension}
            </span>
          </div>
          <p className="text-sm text-slate-700">{cd.description}</p>
          <div className="flex gap-4 text-xs text-slate-500">
            <span>Group A: {cd.papers_a.join(', ')}</span>
            <span>vs</span>
            <span>Group B: {cd.papers_b.join(', ')}</span>
          </div>
          {cd.resolution_hypothesis && (
            <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
              Hypothesis: {cd.resolution_hypothesis}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function TheoriesList({ theories }: { theories: TheoryReference[] }) {
  if (!theories.length) {
    return <p className="text-sm text-slate-500 text-center py-8">No theoretical frameworks detected.</p>;
  }

  const SUPPORT_COLOR: Record<string, string> = {
    strong: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    moderate: 'bg-blue-50 text-blue-700 border-blue-200',
    weak: 'bg-amber-50 text-amber-700 border-amber-200',
    mixed: 'bg-slate-50 text-slate-700 border-slate-200',
  };

  return (
    <div className="space-y-3">
      {theories.map((t, i) => (
        <div key={i} className="rounded-lg border border-slate-100 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-base text-indigo-500">school</span>
            <span className="text-sm font-semibold text-slate-800">{t.theory_name}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
              SUPPORT_COLOR[t.support_level] ?? SUPPORT_COLOR.mixed
            }`}>
              {t.support_level}
            </span>
          </div>
          {t.description && <p className="text-sm text-slate-600">{t.description}</p>}
          <div className="flex gap-4 text-xs text-slate-500">
            {t.seminal_paper_keys.length > 0 && (
              <span>Seminal: {t.seminal_paper_keys.join(', ')}</span>
            )}
            {t.applying_paper_keys.length > 0 && (
              <span>Applied by: {t.applying_paper_keys.join(', ')}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PacksList({ packs }: { packs: DeepSynthesisResult['manuscript_packs'] }) {
  const sections = packs?.section_packs ?? {};
  const sectionKeys = Object.keys(sections);

  if (!sectionKeys.length) {
    return <p className="text-sm text-slate-500 text-center py-8">No manuscript packs generated.</p>;
  }

  return (
    <div className="space-y-4">
      {packs?.central_argument && (
        <div className="rounded-lg bg-indigo-50/50 border border-indigo-100 px-4 py-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-600 mb-1">Central Argument</h4>
          <p className="text-sm text-slate-800">{packs.central_argument}</p>
        </div>
      )}
      {packs?.evidence_strength_summary && (
        <p className="text-xs text-slate-500">{packs.evidence_strength_summary}</p>
      )}
      {sectionKeys.map(key => {
        const pack = sections[key];
        return (
          <div key={key} className="rounded-lg border border-slate-100 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-base text-indigo-500">article</span>
              <h4 className="text-sm font-bold text-slate-800 capitalize">{pack.section_name}</h4>
              <span className="text-[10px] text-slate-400">
                {pack.theme_clusters.length} themes, {pack.key_citations.length} citations
              </span>
            </div>
            {pack.narrative_arc && (
              <p className="text-xs text-indigo-600 bg-indigo-50 rounded-lg px-3 py-2 italic">
                {pack.narrative_arc}
              </p>
            )}
            {pack.theme_clusters.map((tc, i) => (
              <div key={i} className="pl-3 border-l-2 border-slate-100">
                <span className="text-xs font-semibold text-slate-700">{tc.theme_label}</span>
                <span className="text-[10px] text-slate-400 ml-2">
                  {tc.paper_keys.length} papers, {tc.sentences.length} sentences
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function StrengthBar({ strength }: { strength: number }) {
  const pct = Math.round(strength * 100);
  const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-12 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] text-slate-400">{pct}%</span>
    </div>
  );
}
