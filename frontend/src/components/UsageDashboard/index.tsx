import { useEffect, useState } from 'react';
import logo from '../../assets/firstquill-logo.png';
import LoadingLottie from '../LoadingLottie';
import {
  fetchUsageTotals,
  fetchProviderUsage,
  fetchDailyUsage,
  fetchProjectsUsage,
  fetchProjectStages,
  fetchStagesUsage,
  type UsageTotals,
  type ProviderUsage,
  type DailyUsage,
  type ProjectUsage,
  type ProjectStageCost,
} from '../../api/usage';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

const STAGE_LABELS: Record<string, string> = {
  summarize_paper: 'Paper Summarization', query_expansion: 'Query Expansion',
  cross_paper_synthesis: 'Cross-Paper Synthesis', deep_synthesis: 'Deep Synthesis',
  write_article: 'Article Writing', generate_title: 'Title Generation',
  peer_review: 'Peer Review', revision: 'Revision',
  import_manuscript: 'Manuscript Import', parse_comments: 'Comment Parsing',
  revision_suggestions: 'Revision Suggestions', revision_discussion: 'Revision Discussion',
  revision_finalize: 'Revision Finalize', revision_round: 'Revision Round',
  journal_recommendation: 'Journal Recommendation', citation_audit: 'Citation Audit',
  cross_reference: 'Cross-Reference', search_summarize: 'Search Summary',
  sr_protocol: 'SR Protocol', sr_screening: 'SR Screening',
  sr_extraction: 'SR Extraction', sr_rob: 'SR Risk of Bias', sr_synthesis: 'SR Synthesis',
};

const PHASE_LABEL: Record<string, string> = {
  intake: 'Intake', literature: 'Literature', cross_reference: 'Synthesis',
  journals: 'Journals', article: 'Article', revision: 'Revision',
};

// ── Component ──────────────────────────────────────────────────────────────────

interface Props { onBack?: () => void }

export default function UsageDashboard({ onBack }: Props) {
  const [days, setDays]             = useState(30);
  const [totals, setTotals]         = useState<UsageTotals | null>(null);
  const [providers, setProviders]   = useState<ProviderUsage[]>([]);
  const [daily, setDaily]           = useState<DailyUsage[]>([]);
  const [projects, setProjects]     = useState<ProjectUsage[]>([]);
  const [stages, setStages]         = useState<ProjectStageCost[]>([]);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [stagesMap, setStagesMap]   = useState<Record<string, ProjectStageCost[]>>({});
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([
      fetchUsageTotals(days),
      fetchProviderUsage(days),
      fetchDailyUsage(days),
      fetchProjectsUsage(days),
      fetchStagesUsage(days),
    ])
      .then(([t, p, d, proj, st]) => {
        setTotals(t); setProviders(p); setDaily(d); setProjects(proj); setStages(st);
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message || 'Failed to load usage data'))
      .finally(() => setLoading(false));
  }, [days]);

  async function toggleProject(projectId: string) {
    if (expandedProject === projectId) { setExpandedProject(null); return; }
    setExpandedProject(projectId);
    if (!stagesMap[projectId]) {
      try {
        const s = await fetchProjectStages(projectId);
        setStagesMap(prev => ({ ...prev, [projectId]: s }));
      } catch { setStagesMap(prev => ({ ...prev, [projectId]: [] })); }
    }
  }

  const totalIn    = totals?.total_input_tokens ?? 0;
  const totalOut   = totals?.total_output_tokens ?? 0;
  const totalTok   = totalIn + totalOut;
  const callCount  = totals?.call_count ?? 0;
  const topProv    = providers[0];
  const stageMax   = Math.max(...stages.map(s => s.input_tokens + s.output_tokens), 1);
  const maxDailyIn  = Math.max(...daily.map(d => d.input_tokens), 1);
  const maxDailyOut = Math.max(...daily.map(d => d.output_tokens), 1);
  const maxDailyVal = Math.max(maxDailyIn, maxDailyOut, 1);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#f3f4f5' }}>
      <LoadingLottie className="w-20 h-20" label="Loading usage data" textClassName="text-[11px] uppercase tracking-widest text-slate-400" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-2">
        <p className="text-red-600 text-sm font-semibold">Failed to load usage data</p>
        <p className="text-slate-400 text-xs">{error}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen" style={{ background: '#f3f4f5', fontFamily: 'Manrope, sans-serif' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 h-16 px-8 flex items-center justify-between border-b border-slate-200/60"
        style={{ background: 'rgba(248,249,250,0.85)', backdropFilter: 'blur(14px)' }}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 hover:bg-white transition-all mr-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <img src={logo} alt="First Quill" className="h-8 w-8 rounded-lg object-contain flex-shrink-0" />
          <div className="min-w-0 overflow-hidden">
            <h2 className="text-xl font-semibold leading-tight"
              style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright, #0f172a)' }}>
              First <span className="italic">Quill</span>
            </h2>
          </div>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="text-[11px] font-semibold border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-300">
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </header>

      <main className="max-w-6xl mx-auto px-8 py-10 space-y-10">

        {/* ── Page heading ─────────────────────────────────────────────────── */}
        <div>
          <h3 className="text-4xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>Token Analysis</h3>
          <p className="text-sm text-slate-500 mt-1.5">Real-time resource allocation and intelligence efficiency metrics.</p>
        </div>

        {/* ── Top grid: In/Out cards + trend + sidebar ──────────────────────── */}
        <div className="grid grid-cols-12 gap-6">

          {/* Left 8 cols: In/Out + chart */}
          <div className="col-span-12 lg:col-span-8 flex flex-col gap-6">

            {/* In + Out cards */}
            <div className="grid grid-cols-2 gap-4">
              {/* Input card */}
              <div className="bg-white rounded-xl p-8 relative overflow-hidden flex flex-col justify-between min-h-[200px]">
                <div className="absolute top-0 right-0 p-3 pointer-events-none select-none">
                  <span className="material-symbols-outlined select-none"
                    style={{ fontSize: '90px', color: 'rgba(79,70,229,0.07)', fontVariationSettings: "'FILL' 1" }}>
                    input
                  </span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-widest font-bold text-slate-400">Total Input (In)</span>
                  <div className="mt-3 flex items-end gap-1">
                    <span className="text-5xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                      {totalIn >= 1_000_000
                        ? (totalIn / 1_000_000).toFixed(2)
                        : totalIn >= 1_000
                          ? (totalIn / 1_000).toFixed(1)
                          : String(totalIn)}
                    </span>
                    <span className="text-2xl text-slate-400 pb-1">
                      {totalIn >= 1_000_000 ? 'M' : totalIn >= 1_000 ? 'k' : ''}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-sm text-brand-600 mt-6">
                  <span className="material-symbols-outlined text-sm">trending_up</span>
                  <span>{fmtN(totalIn)} tokens sent</span>
                </div>
              </div>

              {/* Output card */}
              <div className="bg-white rounded-xl p-8 relative overflow-hidden flex flex-col justify-between min-h-[200px] border-l-4 border-brand-600">
                <div className="absolute top-0 right-0 p-3 pointer-events-none select-none">
                  <span className="material-symbols-outlined select-none"
                    style={{ fontSize: '90px', color: 'rgba(79,70,229,0.07)', fontVariationSettings: "'FILL' 1" }}>
                    output
                  </span>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-widest font-bold text-slate-400">Total Output (Out)</span>
                  <div className="mt-3 flex items-end gap-1">
                    <span className="text-5xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                      {totalOut >= 1_000_000
                        ? (totalOut / 1_000_000).toFixed(2)
                        : totalOut >= 1_000
                          ? (totalOut / 1_000).toFixed(1)
                          : String(totalOut)}
                    </span>
                    <span className="text-2xl text-slate-400 pb-1">
                      {totalOut >= 1_000_000 ? 'M' : totalOut >= 1_000 ? 'k' : ''}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-sm text-brand-600 mt-6">
                  <span className="material-symbols-outlined text-sm">trending_up</span>
                  <span>{fmtN(totalOut)} tokens generated</span>
                </div>
              </div>
            </div>

            {/* Token Consumption Trend */}
            <div className="bg-white rounded-xl p-8 flex-1">
              <div className="flex items-end justify-between mb-6">
                <div>
                  <h5 className="text-2xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                    Token Consumption Trend
                  </h5>
                  <p className="text-xs text-slate-400 mt-1">
                    Daily volume of tokens sent vs received (Last {days} days)
                  </p>
                </div>
                <div className="flex items-center gap-5">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-brand-600 inline-block" />
                    <span className="text-xs text-slate-500">Output</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-slate-200 inline-block" />
                    <span className="text-xs text-slate-500">Input</span>
                  </div>
                </div>
              </div>

              {daily.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-slate-300 text-sm">No activity yet</div>
              ) : (
                <div className="relative h-52">
                  {/* Grid lines */}
                  <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
                    {[0, 1, 2, 3].map(i => (
                      <div key={i} className="border-b border-slate-100 w-full" />
                    ))}
                  </div>
                  {/* Bars */}
                  <div className="flex items-end justify-between h-full gap-1 pt-2 pb-0 relative">
                    {daily.map((d, i) => {
                      const inH  = Math.max((d.input_tokens  / maxDailyVal) * 100, 2);
                      const outH = Math.max((d.output_tokens / maxDailyVal) * 100, 2);
                      return (
                        <div key={i} className="flex-1 flex items-end justify-center gap-[2px] group relative" style={{ minWidth: 0 }}>
                          {/* Input bar (lighter) */}
                          <div className="flex-1 bg-slate-200 rounded-t-sm group-hover:bg-slate-300 transition-colors"
                            style={{ height: `${inH}%`, minHeight: '3px' }} />
                          {/* Output bar (darker) */}
                          <div className="flex-1 bg-brand-600 rounded-t-sm group-hover:bg-brand-700 transition-colors"
                            style={{ height: `${outH}%`, minHeight: '3px' }} />
                          {/* Tooltip */}
                          <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[9px] px-2 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20 leading-relaxed">
                            <div className="font-bold">{d.date}</div>
                            <div className="text-slate-300">In: {fmtN(d.input_tokens)}</div>
                            <div className="text-brand-300">Out: {fmtN(d.output_tokens)}</div>
                            <div className="text-slate-400">{fmtCost(d.cost_usd)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right 4 cols: Insights + Provider */}
          <div className="col-span-12 lg:col-span-4 flex flex-col gap-5">

            {/* Efficiency Insights */}
            <div className="bg-white rounded-xl p-8 relative overflow-hidden flex-1 border-l-4 border-brand-600/60">
              <div className="flex items-center gap-3 mb-6">
                <span className="material-symbols-outlined text-brand-600"
                  style={{ fontVariationSettings: "'FILL' 1" }}>lightbulb</span>
                <h5 className="text-xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                  Efficiency Insights
                </h5>
              </div>
              <div className="space-y-5">
                {stages.length > 0 && (() => {
                  const top = stages[0];
                  return (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-brand-600 font-bold mb-2">Top Usage Stage</p>
                      <p className="text-base text-slate-800 leading-snug" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                        <span className="font-semibold italic">{STAGE_LABELS[top.stage] || top.stage}</span> uses
                        the most tokens — {fmtN(top.input_tokens + top.output_tokens)} total.
                      </p>
                    </div>
                  );
                })()}
                <div className="border-t border-slate-100 pt-5">
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-2">Token Ratio</p>
                  <p className="text-base text-slate-800 leading-snug" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                    {totalTok > 0
                      ? `${Math.round((totalIn / totalTok) * 100)}% input · ${Math.round((totalOut / totalTok) * 100)}% output across ${callCount.toLocaleString()} calls.`
                      : 'No token data yet for this period.'}
                  </p>
                </div>
                {providers.length > 0 && (
                  <div className="border-t border-slate-100 pt-5">
                    <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-2">Top Provider</p>
                    <p className="text-base text-slate-800 leading-snug" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                      <span className="font-semibold italic capitalize">{topProv.provider}</span> handled{' '}
                      {fmtN(topProv.input_tokens + topProv.output_tokens)} tokens at {fmtCost(topProv.cost_usd)}.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Provider / Active Model card */}
            <div className="bg-slate-100/70 rounded-xl p-6">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-slate-500">Active Provider</span>
                {topProv && (
                  <span className="bg-brand-100 text-brand-700 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tight">
                    {topProv.provider}
                  </span>
                )}
              </div>
              {topProv ? (
                <>
                  <p className="text-lg italic text-slate-800" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                    {topProv.model.length > 30 ? topProv.model.slice(0, 30) + '…' : topProv.model}
                  </p>
                  <div className="mt-4 h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-600 rounded-full transition-all"
                      style={{ width: `${totalTok > 0 ? Math.round(((topProv.input_tokens + topProv.output_tokens) / totalTok) * 100) : 0}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] text-slate-400 uppercase tracking-widest">
                    <span>Token Share</span>
                    <span>{totalTok > 0 ? Math.round(((topProv.input_tokens + topProv.output_tokens) / totalTok) * 100) : 0}%</span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-400 mt-2">No provider data yet</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Step-Wise Distribution ─────────────────────────────────────────── */}
        <div className="bg-white rounded-xl p-8">
          <div className="mb-8">
            <h5 className="text-2xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
              Step-Wise Distribution
            </h5>
            <p className="text-xs text-slate-400 mt-1">Token volume across the core research workflow</p>
          </div>

          {stages.length === 0 ? (
            <div className="py-12 text-center text-slate-300 text-sm">No stage data yet — run pipeline steps to see distribution</div>
          ) : (
            <div className="flex flex-col gap-6">
              {stages.slice(0, 10).map((s, i) => {
                const total  = s.input_tokens + s.output_tokens;
                const inW    = (s.input_tokens  / stageMax) * 100;
                const outW   = (s.output_tokens / stageMax) * 100;
                return (
                  <div key={i} className="flex items-center gap-4">
                    <div className="w-44 text-sm text-slate-500 flex-shrink-0 truncate">
                      {STAGE_LABELS[s.stage] || s.stage}
                    </div>
                    <div className="flex-1 flex h-10 gap-[3px]">
                      {inW > 0 && (
                        <div
                          className="h-full rounded-l-md flex items-center px-3 overflow-hidden transition-all"
                          style={{
                            width: `${inW}%`,
                            minWidth: inW > 0 ? '48px' : '0',
                            background: 'rgba(79,70,229,0.15)',
                          }}
                        >
                          <span className="text-[10px] font-bold text-brand-700 uppercase tracking-tight whitespace-nowrap">
                            In: {fmtN(s.input_tokens)}
                          </span>
                        </div>
                      )}
                      {outW > 0 && (
                        <div
                          className="h-full rounded-r-md flex items-center px-3 overflow-hidden transition-all"
                          style={{
                            width: `${outW}%`,
                            minWidth: outW > 0 ? '48px' : '0',
                            background: '#3b35b0',
                          }}
                        >
                          <span className="text-[10px] font-bold text-white uppercase tracking-tight whitespace-nowrap">
                            Out: {fmtN(s.output_tokens)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="w-20 text-right text-sm font-semibold text-slate-700 flex-shrink-0">
                      {fmtN(total)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Project Token Distribution ─────────────────────────────────────── */}
        <div className="bg-white rounded-xl overflow-hidden">
          <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h5 className="text-2xl text-slate-900" style={{ fontFamily: 'Newsreader, Georgia, serif' }}>
                Project Token Distribution
              </h5>
              <p className="text-xs text-slate-400 mt-1">Resource allocation by research objective</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-brand-600 font-semibold px-3 py-2 rounded-lg hover:bg-brand-50 cursor-default transition-colors">
              <span className="material-symbols-outlined text-sm">analytics</span>
              {projects.length} projects
            </div>
          </div>

          {projects.length === 0 ? (
            <div className="py-16 text-center text-slate-300 text-sm">No project usage in this period</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left" style={{ fontFamily: 'Manrope, sans-serif' }}>
                <thead className="bg-slate-50/60 text-[10px] uppercase tracking-widest text-slate-400 font-bold">
                  <tr>
                    <th className="px-8 py-4">Research Project</th>
                    <th className="px-6 py-4">Phase</th>
                    <th className="px-6 py-4">In (Tokens)</th>
                    <th className="px-6 py-4">Out (Tokens)</th>
                    <th className="px-6 py-4">Out Ratio</th>
                    <th className="px-8 py-4 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {projects.map((p) => {
                    const pTotal   = p.input_tokens + p.output_tokens;
                    const outRatio = pTotal > 0 ? Math.round((p.output_tokens / pTotal) * 100) : 0;
                    const ratioColor = outRatio >= 40 ? 'bg-emerald-500' : outRatio >= 20 ? 'bg-brand-500' : 'bg-orange-400';
                    const ratioText  = outRatio >= 40 ? 'text-emerald-600' : outRatio >= 20 ? 'text-brand-600' : 'text-orange-500';
                    const phase    = p.current_phase;
                    const projStages = stagesMap[p.project_id];
                    return (
                      <>
                        <tr
                          key={p.project_id}
                          onClick={() => toggleProject(p.project_id)}
                          className="hover:bg-slate-50/60 transition-colors cursor-pointer group"
                        >
                          <td className="px-8 py-5">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                                <span className="material-symbols-outlined text-brand-600 text-[18px]">
                                  history_edu
                                </span>
                              </div>
                              <span className="font-semibold text-sm text-slate-800 truncate max-w-[180px]">
                                {p.project_name || p.project_id.slice(0, 8)}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            {phase ? (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-tight">
                                {PHASE_LABEL[phase] || phase}
                              </span>
                            ) : (
                              <span className="text-slate-300 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-6 py-5 text-sm text-slate-700">
                            {p.input_tokens.toLocaleString()}
                          </td>
                          <td className="px-6 py-5 text-sm text-slate-700">
                            {p.output_tokens.toLocaleString()}
                          </td>
                          <td className="px-6 py-5">
                            <div className="flex items-center gap-2.5">
                              <div className="h-1 w-16 bg-slate-100 rounded-full overflow-hidden flex-shrink-0">
                                <div className={`h-full ${ratioColor} rounded-full transition-all`}
                                  style={{ width: `${outRatio}%` }} />
                              </div>
                              <span className={`text-xs font-bold ${ratioText}`}>{outRatio}%</span>
                            </div>
                          </td>
                          <td className="px-8 py-5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-bold text-slate-800 text-sm">{fmtCost(p.cost_usd)}</span>
                              <span className="material-symbols-outlined text-base text-slate-300 group-hover:text-slate-500 transition-colors">
                                {expandedProject === p.project_id ? 'expand_less' : 'expand_more'}
                              </span>
                            </div>
                          </td>
                        </tr>

                        {/* Expanded stage breakdown */}
                        {expandedProject === p.project_id && (
                          <tr key={`${p.project_id}-exp`}>
                            <td colSpan={6} className="bg-slate-50/70 border-b border-slate-100">
                              {!projStages ? (
                                <div className="px-8 py-4 flex items-center gap-2 text-slate-400 text-xs">
                                  <div className="w-3 h-3 border border-slate-300 border-t-brand-500 rounded-full animate-spin" />
                                  Loading stages…
                                </div>
                              ) : projStages.length === 0 ? (
                                <p className="px-8 py-4 text-xs text-slate-400 italic">No stage data.</p>
                              ) : (
                                <div className="px-8 py-5">
                                  <div className="flex flex-col gap-3">
                                    {projStages.map((s, si) => {
                                      const st = s.input_tokens + s.output_tokens;
                                      const stMax = Math.max(...projStages.map(x => x.input_tokens + x.output_tokens), 1);
                                      const siW = (s.input_tokens  / stMax) * 100;
                                      const soW = (s.output_tokens / stMax) * 100;
                                      return (
                                        <div key={si} className="flex items-center gap-4">
                                          <div className="w-40 text-xs text-slate-500 flex-shrink-0 truncate">
                                            {STAGE_LABELS[s.stage] || s.stage}
                                          </div>
                                          <div className="flex-1 flex h-7 gap-[2px]">
                                            {siW > 0 && (
                                              <div className="h-full rounded-l-sm flex items-center px-2"
                                                style={{ width: `${siW}%`, minWidth: '36px', background: 'rgba(79,70,229,0.12)' }}>
                                                <span className="text-[9px] font-bold text-brand-700 whitespace-nowrap">
                                                  {fmtN(s.input_tokens)}
                                                </span>
                                              </div>
                                            )}
                                            {soW > 0 && (
                                              <div className="h-full rounded-r-sm flex items-center px-2"
                                                style={{ width: `${soW}%`, minWidth: '36px', background: '#3b35b0' }}>
                                                <span className="text-[9px] font-bold text-white whitespace-nowrap">
                                                  {fmtN(s.output_tokens)}
                                                </span>
                                              </div>
                                            )}
                                          </div>
                                          <div className="w-16 text-right text-xs font-semibold text-slate-600 flex-shrink-0">
                                            {fmtN(st)}
                                          </div>
                                          <div className="w-14 text-right text-xs text-slate-400 flex-shrink-0">
                                            {fmtCost(s.cost_usd)}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Empty state */}
        {callCount === 0 && (
          <div className="text-center py-20 text-slate-400">
            <span className="material-symbols-outlined text-6xl text-slate-200 block mb-4">analytics</span>
            <p className="text-base font-semibold text-slate-500">No AI usage recorded yet</p>
            <p className="text-sm mt-1">Run a search, summarize papers, or generate an article to see data here.</p>
          </div>
        )}
      </main>
    </div>
  );
}
