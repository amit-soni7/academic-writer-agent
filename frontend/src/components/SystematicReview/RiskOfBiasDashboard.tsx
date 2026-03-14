/**
 * RiskOfBiasDashboard — SR Phase 5
 * AI-assisted risk of bias assessment with mandatory human confirmation.
 */
import { useState, useEffect, useRef } from 'react';
import {
  getRoBSummary,
  streamRoBAssess,
  confirmRoB,
  type RoBAssessment,
} from '../../api/sr';

interface Props {
  projectId: string;
  onGoToSynthesis: () => void;
  onOpenSettings: () => void;
}

const RISK_COLORS: Record<string, string> = {
  Low:              'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Some concerns':  'bg-amber-100 text-amber-700 border-amber-200',
  High:             'bg-rose-100 text-rose-600 border-rose-200',
  'No information': 'bg-slate-100 text-slate-500 border-slate-200',
};

const JUDGMENT_OPTIONS = ['Low', 'Some concerns', 'High', 'No information'];

function RiskBadge({ risk }: { risk: string }) {
  const cls = RISK_COLORS[risk] ?? 'bg-slate-100 text-slate-500 border-slate-200';
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>{risk}</span>;
}

export default function RiskOfBiasDashboard({ projectId, onGoToSynthesis }: Props) {
  const [papers, setPapers] = useState<RoBAssessment[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [confirmed, setConfirmed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [assessing, setAssessing] = useState<string | null>(null);
  const [selectedPaper, setSelectedPaper] = useState<string | null>(null);
  const [domainEdits, setDomainEdits] = useState<Record<string, string>>({});
  const [overallRisk, setOverallRisk] = useState('');
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function loadSummary() {
    getRoBSummary(projectId)
      .then(({ papers: p, counts: c, total: t, confirmed: conf }) => {
        setPapers(p);
        setCounts(c);
        setTotal(t);
        setConfirmed(conf);
      })
      .catch(() => setError('Failed to load RoB summary.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSummary();
  }, [projectId]);

  const selectedAssessment = papers.find((p) => p.paper_key === selectedPaper);

  useEffect(() => {
    if (!selectedAssessment) return;
    const final = selectedAssessment.final_assessment as Record<string, unknown>;
    const domains = (final?.domain_judgments || selectedAssessment.ai_assessment?.domain_judgments || {}) as Record<string, string>;
    setDomainEdits({ ...domains });
    setOverallRisk(
      (final?.overall_risk as string) ||
      selectedAssessment.overall_risk ||
      '',
    );
  }, [selectedPaper]);

  function handleAssess(paperKey: string) {
    setAssessing(paperKey);
    abortRef.current = streamRoBAssess(
      projectId,
      paperKey,
      (ev) => {
        if (ev.paper_key === paperKey && ev.assessment) {
          setPapers((ps) =>
            ps.map((p) =>
              p.paper_key === paperKey
                ? { ...p, ai_assessment: ev.assessment as Record<string, unknown> }
                : p,
            ),
          );
        }
      },
      () => {
        setAssessing(null);
        loadSummary();
        if (selectedPaper === paperKey) {
          // Re-trigger effect for selected paper
          setSelectedPaper((k) => k);
        }
      },
      (err) => { setError(err); setAssessing(null); },
    );
  }

  async function handleConfirm() {
    if (!selectedPaper) return;
    setSaving(true);
    const humanAssessment = { domain_judgments: domainEdits, overall_risk: overallRisk };
    const finalAssessment = { domain_judgments: domainEdits, overall_risk: overallRisk };
    try {
      await confirmRoB(projectId, selectedPaper, humanAssessment, finalAssessment);
      setPapers((ps) =>
        ps.map((p) =>
          p.paper_key === selectedPaper
            ? { ...p, human_confirmed: true, overall_risk: overallRisk, final_assessment: finalAssessment }
            : p,
        ),
      );
      setConfirmed((c) => c + 1);
    } catch {
      setError('Failed to confirm assessment.');
    } finally {
      setSaving(false);
    }
  }

  const allConfirmed = total > 0 && confirmed >= total;

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-sm text-slate-400">Loading assessments…</div>;
  }

  return (
    <div className="space-y-4 pb-8">
      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg border border-rose-200">{error}</div>
      )}

      {/* Summary counts */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Low Risk', key: 'Low', color: 'text-emerald-600' },
          { label: 'Some Concerns', key: 'Some concerns', color: 'text-amber-600' },
          { label: 'High Risk', key: 'High', color: 'text-rose-600' },
          { label: 'Unassessed', key: 'Unassessed', color: 'text-slate-400' },
        ].map(({ label, key, color }) => (
          <div
            key={key}
            className="rounded-xl border p-3 text-center"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
          >
            <p className={`text-xl font-semibold ${color}`}>{counts[key] ?? 0}</p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Progress */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{confirmed} of {total} papers confirmed</span>
        <div className="flex-1 mx-4 rounded-full overflow-hidden h-1.5" style={{ background: 'var(--bg-surface)' }}>
          <div
            className="h-full transition-all duration-300 bg-emerald-400"
            style={{ width: `${total > 0 ? Math.round((confirmed / total) * 100) : 0}%` }}
          />
        </div>
        <span>{total > 0 ? Math.round((confirmed / total) * 100) : 0}%</span>
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-5 gap-4" style={{ minHeight: '460px' }}>
        {/* Left: paper list */}
        <div
          className="col-span-2 rounded-xl border overflow-hidden flex flex-col"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div className="px-3 py-2 border-b text-[10px] font-mono uppercase tracking-wider text-slate-400" style={{ borderColor: 'var(--border-muted)' }}>
            Papers
          </div>
          <div className="flex-1 overflow-y-auto">
            {papers.map((p) => {
              const riskCls = RISK_COLORS[p.overall_risk ?? ''] ?? 'bg-slate-100 text-slate-400 border-slate-200';
              return (
                <button
                  key={p.paper_key}
                  onClick={() => setSelectedPaper(p.paper_key)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-b text-xs transition-colors hover:bg-amber-50/30 ${
                    selectedPaper === p.paper_key ? 'bg-amber-50/60' : ''
                  }`}
                  style={{ borderColor: 'var(--border-muted)' }}
                >
                  <span className="text-base leading-none" title={p.human_confirmed ? 'Confirmed' : 'Unconfirmed'}>
                    {p.human_confirmed ? '🔒' : '○'}
                  </span>
                  <span className="flex-1 font-mono text-slate-600 truncate">{p.paper_key}</span>
                  {p.overall_risk && (
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${riskCls}`}>
                      {p.overall_risk.slice(0, 4)}
                    </span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleAssess(p.paper_key); }}
                    disabled={assessing === p.paper_key}
                    className="ml-1 text-[10px] px-2 py-0.5 rounded border border-slate-200 text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors"
                  >
                    {assessing === p.paper_key ? '…' : 'Assess'}
                  </button>
                </button>
              );
            })}
            {papers.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8">No papers loaded.</p>
            )}
          </div>
        </div>

        {/* Right: confirmation form */}
        <div
          className="col-span-3 rounded-xl border p-4 flex flex-col gap-4 overflow-y-auto"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          {!selectedAssessment ? (
            <p className="text-sm text-slate-400 text-center py-12">Select a paper to review its assessment.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-xs text-slate-500">{selectedAssessment.paper_key}</p>
                  {selectedAssessment.tool_used && (
                    <p className="text-[10px] text-slate-400 mt-0.5">Tool: {selectedAssessment.tool_used}</p>
                  )}
                </div>
                {selectedAssessment.human_confirmed && (
                  <span className="text-xs font-mono px-2 py-1 rounded bg-emerald-100 text-emerald-700">Confirmed</span>
                )}
              </div>

              {Object.keys(domainEdits).length > 0 && (
                <div className="space-y-2">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Domain Judgments</p>
                  {Object.entries(domainEdits).map(([domain, judgment]) => (
                    <div key={domain} className="flex items-center gap-3">
                      <span className="text-xs text-slate-600 w-40 shrink-0 truncate" title={domain}>{domain}</span>
                      <select
                        value={judgment}
                        onChange={(e) => setDomainEdits((d) => ({ ...d, [domain]: e.target.value }))}
                        className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
                        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                      >
                        {JUDGMENT_OPTIONS.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                      <RiskBadge risk={judgment} />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Overall Risk</p>
                <select
                  value={overallRisk}
                  onChange={(e) => setOverallRisk(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2"
                  style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                >
                  <option value="">— Select —</option>
                  {JUDGMENT_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>

              <button
                onClick={handleConfirm}
                disabled={!overallRisk || saving || selectedAssessment.human_confirmed}
                className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-40 self-start"
              >
                {saving ? 'Saving…' : selectedAssessment.human_confirmed ? 'Already Confirmed' : 'Confirm Assessment'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Proceed */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onGoToSynthesis}
          disabled={!allConfirmed}
          title={!allConfirmed ? `${confirmed}/${total} confirmed` : ''}
          className="btn-primary px-5 py-2.5 rounded-lg text-sm disabled:opacity-40"
        >
          {allConfirmed ? 'Proceed to Synthesis →' : `Confirm all papers to proceed (${confirmed}/${total})`}
        </button>
      </div>
    </div>
  );
}
