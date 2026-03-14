/**
 * SRSynthesisDashboard — SR Phase 6
 * Meta-analysis, narrative synthesis, and manuscript generation.
 */
import { useState, useRef } from 'react';
import {
  runMetaAnalysis,
  streamSynthesis,
  streamGenerateManuscript,
  type MetaAnalysisResult,
} from '../../api/sr';

interface Props {
  projectId: string;
  onGoToManuscript: () => void;
  onOpenSettings: () => void;
}

const EFFECT_MEASURES = [
  { value: 'MD',  label: 'Mean Difference (MD)' },
  { value: 'SMD', label: 'Standardised MD (SMD)' },
  { value: 'OR',  label: 'Odds Ratio (OR)' },
  { value: 'RR',  label: 'Risk Ratio (RR)' },
];

const MODELS = [
  { value: 'fixed',  label: 'Fixed Effects' },
  { value: 'random', label: 'Random Effects' },
];

// Simple SVG forest plot
function ForestPlot({ data, pooled }: { data: MetaAnalysisResult['forest_plot_data']; pooled: MetaAnalysisResult }) {
  if (!data || data.length === 0) return null;

  const allVals = data.flatMap((d) => [d.ci_lower, d.ci_upper]);
  if (pooled.ci_lower != null) allVals.push(pooled.ci_lower);
  if (pooled.ci_upper != null) allVals.push(pooled.ci_upper);
  const minVal = Math.min(...allVals);
  const maxVal = Math.max(...allVals);
  const range = maxVal - minVal || 1;

  const W = 320;
  const LABEL_W = 120;
  const PLOT_W = W - LABEL_W - 20;
  const ROW_H = 22;
  const H = (data.length + 2) * ROW_H + 30;
  const ZERO_X = LABEL_W + PLOT_W * ((0 - minVal) / range);

  function toX(v: number) {
    return LABEL_W + PLOT_W * ((v - minVal) / range);
  }

  return (
    <svg width={W} height={H} className="overflow-visible" style={{ fontFamily: 'monospace' }}>
      {/* Zero line */}
      <line x1={ZERO_X} y1={10} x2={ZERO_X} y2={H - 20} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="3,3" />

      {data.map((d, i) => {
        const y = 20 + i * ROW_H;
        const cx = toX(d.effect);
        const x1 = toX(d.ci_lower);
        const x2 = toX(d.ci_upper);
        return (
          <g key={d.study_id}>
            <text x={LABEL_W - 4} y={y + 5} textAnchor="end" fontSize={9} fill="#64748b">
              {d.study_id.length > 18 ? d.study_id.slice(0, 17) + '…' : d.study_id}
            </text>
            <line x1={x1} y1={y} x2={x2} y2={y} stroke="#94a3b8" strokeWidth={1.5} />
            <line x1={x1} y1={y - 4} x2={x1} y2={y + 4} stroke="#94a3b8" strokeWidth={1.5} />
            <line x1={x2} y1={y - 4} x2={x2} y2={y + 4} stroke="#94a3b8" strokeWidth={1.5} />
            <rect x={cx - 4} y={y - 4} width={8} height={8} fill="#f59e0b" />
          </g>
        );
      })}

      {/* Pooled diamond */}
      {pooled.pooled_estimate != null && pooled.ci_lower != null && pooled.ci_upper != null && (() => {
        const y = 20 + data.length * ROW_H + 8;
        const cx = toX(pooled.pooled_estimate);
        const x1 = toX(pooled.ci_lower);
        const x2 = toX(pooled.ci_upper);
        return (
          <g>
            <line x1={LABEL_W - 4} y1={y} x2={LABEL_W - 4} y2={y} />
            <text x={LABEL_W - 4} y={y + 4} textAnchor="end" fontSize={9} fill="#1e293b" fontWeight="bold">
              Pooled
            </text>
            <polygon
              points={`${cx},${y - 7} ${x2},${y} ${cx},${y + 7} ${x1},${y}`}
              fill="#d97706"
              stroke="#92400e"
              strokeWidth={1}
            />
          </g>
        );
      })()}

      {/* Axis */}
      <line x1={LABEL_W} y1={H - 18} x2={W - 10} y2={H - 18} stroke="#cbd5e1" strokeWidth={1} />
      <text x={LABEL_W} y={H - 6} fontSize={8} fill="#94a3b8">{minVal.toFixed(2)}</text>
      <text x={ZERO_X} y={H - 6} textAnchor="middle" fontSize={8} fill="#94a3b8">0</text>
      <text x={W - 10} y={H - 6} textAnchor="end" fontSize={8} fill="#94a3b8">{maxVal.toFixed(2)}</text>
    </svg>
  );
}

export default function SRSynthesisDashboard({ projectId, onGoToManuscript }: Props) {
  const [effectMeasure, setEffectMeasure] = useState('MD');
  const [model, setModel] = useState('random');
  const [metaResult, setMetaResult] = useState<MetaAnalysisResult | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState('');

  const [synthText, setSynthText] = useState('');
  const [synthRunning, setSynthRunning] = useState(false);
  const [synthError, setSynthError] = useState('');

  const [manuscript, setManuscript] = useState('');
  const [msRunning, setMsRunning] = useState(false);
  const [msError, setMsError] = useState('');

  const abortSynth = useRef<AbortController | null>(null);
  const abortMs = useRef<AbortController | null>(null);

  async function handleRunMeta() {
    setMetaLoading(true);
    setMetaError('');
    try {
      const result = await runMetaAnalysis(projectId, effectMeasure, model);
      setMetaResult(result);
    } catch (e: any) {
      setMetaError(e?.response?.data?.detail || String(e));
    } finally {
      setMetaLoading(false);
    }
  }

  function handleSynth() {
    setSynthRunning(true);
    setSynthText('');
    setSynthError('');
    abortSynth.current = streamSynthesis(
      projectId,
      (ev) => {
        const chunk = (ev.text || ev.chunk || ev.content || '') as string;
        if (chunk) setSynthText((t) => t + chunk);
      },
      () => setSynthRunning(false),
      (err) => { setSynthError(err); setSynthRunning(false); },
    );
  }

  function handleGenerateManuscript() {
    setMsRunning(true);
    setManuscript('');
    setMsError('');
    abortMs.current = streamGenerateManuscript(
      projectId,
      (ev) => {
        const chunk = (ev.text || ev.chunk || ev.content || '') as string;
        if (chunk) setManuscript((t) => t + chunk);
      },
      () => setMsRunning(false),
      (err) => { setMsError(err); setMsRunning(false); },
    );
  }

  return (
    <div className="space-y-5 pb-8">
      {/* Meta-Analysis */}
      <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 block">Meta-Analysis</span>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Effect Measure</label>
            <select
              value={effectMeasure}
              onChange={(e) => setEffectMeasure(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
            >
              {EFFECT_MEASURES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleRunMeta}
            disabled={metaLoading}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {metaLoading ? 'Running…' : 'Run Meta-Analysis'}
          </button>
        </div>

        {metaError && (
          <p className="text-xs text-rose-600">{metaError}</p>
        )}

        {metaResult && (
          <div className="space-y-4">
            {/* Results table */}
            <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-muted)' }}>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ background: 'var(--bg-base)', borderColor: 'var(--border-muted)' }}>
                    {['Studies', 'Participants', 'Pooled Estimate', '95% CI', 'I²', 'Q', 'p'].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-slate-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: 'var(--bg-surface)' }}>
                    <td className="px-3 py-2 font-mono">{metaResult.n_studies}</td>
                    <td className="px-3 py-2 font-mono">{metaResult.n_participants.toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono font-medium" style={{ color: 'var(--gold)' }}>
                      {metaResult.pooled_estimate?.toFixed(3) ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {metaResult.ci_lower != null && metaResult.ci_upper != null
                        ? `[${metaResult.ci_lower.toFixed(3)}, ${metaResult.ci_upper.toFixed(3)}]`
                        : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {metaResult.i_squared != null ? `${metaResult.i_squared.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {metaResult.q_statistic?.toFixed(2) ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {metaResult.q_p_value != null ? metaResult.q_p_value.toFixed(3) : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {metaResult.heterogeneity_interpretation && (
              <p className="text-xs text-slate-500 italic">{metaResult.heterogeneity_interpretation}</p>
            )}

            {/* Forest plot */}
            {metaResult.forest_plot_data && metaResult.forest_plot_data.length > 0 && (
              <div
                className="rounded-lg p-4 overflow-x-auto"
                style={{ background: 'var(--bg-base)' }}
              >
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-3">Forest Plot</p>
                <ForestPlot data={metaResult.forest_plot_data} pooled={metaResult} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Narrative Synthesis */}
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Narrative Synthesis</span>
          <button
            onClick={handleSynth}
            disabled={synthRunning}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {synthRunning ? 'Generating…' : synthText ? 'Regenerate' : 'Generate Synthesis'}
          </button>
        </div>
        {synthError && <p className="text-xs text-rose-600">{synthError}</p>}
        {(synthText || synthRunning) && (
          <div
            className="rounded-lg p-4 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap leading-relaxed"
            style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
          >
            {synthText}
            {synthRunning && <span className="animate-pulse text-amber-400">▌</span>}
          </div>
        )}
      </div>

      {/* Manuscript Generation */}
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Manuscript</span>
          <button
            onClick={handleGenerateManuscript}
            disabled={msRunning}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {msRunning ? 'Generating…' : manuscript ? 'Regenerate →' : 'Generate Manuscript →'}
          </button>
        </div>
        {msError && <p className="text-xs text-rose-600">{msError}</p>}
        {(manuscript || msRunning) && (
          <div
            className="rounded-lg p-4 max-h-80 overflow-y-auto text-sm whitespace-pre-wrap leading-relaxed"
            style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
          >
            {manuscript}
            {msRunning && <span className="animate-pulse text-amber-400">▌</span>}
          </div>
        )}
        {manuscript && !msRunning && (
          <div className="flex justify-end pt-1">
            <button
              onClick={onGoToManuscript}
              className="btn-primary px-4 py-2 rounded-lg text-sm"
            >
              Open in Article Writer →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
