/**
 * SRSearchDashboard — SR Phase 2
 * Database selector, date range, live search progress, PRISMA flow counters.
 */
import { useState, useEffect, useRef } from 'react';
import { streamSRSearch, getSearchStatus, type PRISMAFlow } from '../../api/sr';

interface Props {
  projectId: string;
  onGoToScreening: () => void;
  onOpenSettings: () => void;
}

const ALL_DATABASES = [
  { id: 'pubmed',           label: 'PubMed' },
  { id: 'openalex',         label: 'OpenAlex' },
  { id: 'semantic_scholar', label: 'Semantic Scholar' },
  { id: 'clinicaltrials',   label: 'ClinicalTrials.gov' },
  { id: 'eric',             label: 'ERIC' },
];

const DEFAULT_SELECTED = ['pubmed', 'openalex', 'semantic_scholar', 'clinicaltrials'];

const EMPTY_FLOW: PRISMAFlow = {
  identified: 0, duplicates_removed: 0, screened: 0,
  excluded_screening: 0, sought_retrieval: 0, not_retrieved: 0,
  assessed_eligibility: 0, excluded_fulltext: 0,
  excluded_fulltext_reasons: {}, included: 0,
};

export default function SRSearchDashboard({ projectId, onGoToScreening }: Props) {
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED);
  const [dateFrom, setDateFrom] = useState('2000-01-01');
  const [dateTo, setDateTo] = useState('');
  const [searching, setSearching] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [flow, setFlow] = useState<PRISMAFlow>(EMPTY_FLOW);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSearchStatus(projectId)
      .then(({ prisma_flow }) => {
        setFlow(prisma_flow ?? EMPTY_FLOW);
        setStatusLoaded(true);
      })
      .catch(() => setStatusLoaded(true));
  }, [projectId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  function toggleDb(id: string) {
    setSelected((s) =>
      s.includes(id) ? s.filter((d) => d !== id) : [...s, id],
    );
  }

  function handleSearch() {
    if (selected.length === 0) { setError('Select at least one database.'); return; }
    setSearching(true);
    setLog([]);
    setError('');

    abortRef.current = streamSRSearch(
      projectId,
      selected,
      dateFrom,
      dateTo,
      (ev) => {
        const line = [
          ev.database ? `[${ev.database}]` : '',
          ev.message || ev.status || ev.step || '',
          ev.count != null ? `(${ev.count} records)` : '',
        ].filter(Boolean).join(' ');
        if (line.trim()) setLog((l) => [...l, line]);

        if (ev.prisma_flow) setFlow(ev.prisma_flow as PRISMAFlow);
      },
      () => {
        setSearching(false);
        getSearchStatus(projectId).then(({ prisma_flow }) => {
          if (prisma_flow) setFlow(prisma_flow);
        });
      },
      (err) => { setError(err); setSearching(false); },
    );
  }

  function handleStop() {
    abortRef.current?.abort();
    setSearching(false);
  }

  const afterDedup = Math.max(0, flow.identified - flow.duplicates_removed);

  return (
    <div className="space-y-4 pb-8">
      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg border border-rose-200">
          {error}
        </div>
      )}

      {/* PRISMA flow counters */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Identified', value: flow.identified },
          { label: 'After Dedup', value: afterDedup },
          { label: 'To Screen', value: flow.screened || afterDedup },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl border p-4 text-center"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
          >
            <p className="text-2xl font-semibold" style={{ color: 'var(--text-bright)' }}>
              {statusLoaded ? value.toLocaleString() : '—'}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Config panel */}
      <div className="rounded-xl border p-4 space-y-4" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">Databases</span>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {ALL_DATABASES.map(({ id, label }) => (
            <label key={id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={() => toggleDb(id)}
                className="accent-amber-500"
              />
              <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</span>
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2 border-t" style={{ borderColor: 'var(--border-muted)' }}>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-400 mb-1">Date To (blank = present)</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSearch}
            disabled={searching}
            className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Run Search'}
          </button>
          {searching && (
            <button
              onClick={handleStop}
              className="px-4 py-2 rounded-lg text-sm border border-slate-200 text-slate-500 hover:text-slate-700 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Live log */}
      {log.length > 0 && (
        <div
          className="rounded-xl border p-4 max-h-52 overflow-y-auto"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 block mb-2">Search Log</span>
          <div className="space-y-0.5">
            {log.map((line, i) => (
              <p key={i} className="text-xs font-mono text-slate-500">{line}</p>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Proceed */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onGoToScreening}
          disabled={flow.identified === 0}
          className="btn-primary px-5 py-2.5 rounded-lg text-sm disabled:opacity-40"
        >
          Proceed to Screening →
        </button>
      </div>
    </div>
  );
}
