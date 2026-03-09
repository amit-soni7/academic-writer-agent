import { useEffect, useState } from 'react';
import { getJournalStyle } from '../../api/projects';
import type { JournalStyle } from '../../types/paper';

interface Props {
  journalName: string;
  manuscriptText: string;
  projectName: string;
  onProjectNameChange: (name: string) => void;
  projectDescription: string;
  onProjectDescriptionChange: (desc: string) => void;
}

// ── Extract manuscript title (first # heading or first short non-empty line) ──

function extractManuscriptTitle(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim();
    // First non-empty line under 200 chars that doesn't end with period (not a sentence)
    if (t.length > 10 && t.length < 200 && !t.endsWith('.')) return t;
  }
  return '';
}

function buildNameSuggestions(title: string, journalName: string): string[] {
  if (!title) return journalName ? [`${journalName} – Revision`] : [];
  const short = title.length > 70 ? title.slice(0, 67) + '…' : title;
  const suggestions: string[] = [`Revision: ${short}`];
  if (journalName) suggestions.push(`${journalName} submission – ${short.slice(0, 40)}${short.length > 40 ? '…' : ''}`);
  suggestions.push(short);
  return [...new Set(suggestions)];
}

// ── Journal style card ─────────────────────────────────────────────────────────

function JournalStyleCard({ style }: { style: JournalStyle }) {
  const rows = [
    { label: 'Citation format', value: style.reference_format_name || style.citation_style },
    { label: 'In-text style', value: style.in_text_format },
    { label: 'Abstract', value: style.abstract_structure ? `${style.abstract_structure}${style.abstract_word_limit ? `, ≤${style.abstract_word_limit} words` : ''}` : style.abstract_word_limit ? `≤${style.abstract_word_limit} words` : '—' },
    { label: 'Max references', value: style.max_references != null ? String(style.max_references) : 'No limit' },
    { label: 'Source', value: style.source },
  ].filter((r) => r.value && r.value !== '—');

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-brand-800">{style.journal_name}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          style.confidence >= 0.9 ? 'bg-green-100 text-green-700' :
          style.confidence >= 0.7 ? 'bg-amber-100 text-amber-700' :
          'bg-slate-100 text-slate-600'
        }`}>
          {Math.round(style.confidence * 100)}% confidence
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {rows.map(({ label, value }) => (
          <div key={label} className="col-span-1">
            <dt className="text-xs text-brand-500 font-medium">{label}</dt>
            <dd className="text-xs text-slate-700 capitalize">{value.replace(/_/g, ' ')}</dd>
          </div>
        ))}
      </dl>
      {style.accepted_article_types.length > 0 && (
        <div>
          <p className="text-xs text-brand-500 font-medium mb-1">Accepted types</p>
          <div className="flex flex-wrap gap-1">
            {style.accepted_article_types.slice(0, 6).map((t) => (
              <span key={t} className="text-xs bg-white border border-brand-200 text-brand-700 px-2 py-0.5 rounded-full">
                {t.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function StepThreeRevision({
  journalName,
  manuscriptText,
  projectName,
  onProjectNameChange,
  projectDescription,
  onProjectDescriptionChange,
}: Props) {
  const [journalStyle, setJournalStyle] = useState<JournalStyle | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Auto-load journal style and generate name suggestions on mount
  useEffect(() => {
    const title = extractManuscriptTitle(manuscriptText);
    const names = buildNameSuggestions(title, journalName);
    setSuggestions(names);
    if (!projectName && names.length > 0) {
      onProjectNameChange(names[0]);
    }

    if (journalName.trim()) {
      setJournalLoading(true);
      setJournalError(null);
      getJournalStyle(journalName)
        .then(setJournalStyle)
        .catch((e) => setJournalError(e?.response?.data?.detail || e?.message || 'Could not load journal style'))
        .finally(() => setJournalLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">Journal Style & Project Details</h2>
        <p className="text-sm text-slate-500">
          We looked up the journal style and suggested a project name from your manuscript.
        </p>
      </div>

      {/* ── Journal style ──────────────────────────────────────────────────── */}
      {journalName && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Journal Style</p>
          {journalLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 rounded-xl p-4 border border-slate-200">
              <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              Looking up {journalName}…
            </div>
          )}
          {journalError && (
            <div className="text-sm text-amber-700 bg-amber-50 rounded-xl p-3 border border-amber-200">
              ⚠ Could not find style for "{journalName}". The revision will use default formatting.
            </div>
          )}
          {journalStyle && !journalLoading && <JournalStyleCard style={journalStyle} />}
        </div>
      )}

      {/* ── Project name ───────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Project Name</p>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onProjectNameChange(s)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                  projectName === s
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-white text-slate-600 border-slate-300 hover:border-brand-400 hover:text-brand-700'
                }`}
              >
                {s.length > 55 ? s.slice(0, 52) + '…' : s}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
          placeholder="Project name…"
          className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm text-slate-800
            placeholder-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>

      {/* ── Description ────────────────────────────────────────────────────── */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Description <span className="text-slate-400 font-normal normal-case">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={projectDescription}
          onChange={(e) => onProjectDescriptionChange(e.target.value)}
          placeholder="e.g. Major revision for PLOS ONE after first peer review cycle"
          className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
            placeholder-slate-400 resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </div>
    </div>
  );
}
