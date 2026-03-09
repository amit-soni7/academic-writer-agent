import { useRef } from 'react';

interface Props {
  manuscriptText: string;
  onManuscriptTextChange: (text: string) => void;
  manuscriptFile: File | null;
  onManuscriptFileChange: (file: File | null) => void;
  reviewerCommentsText: string;
  onReviewerCommentsTextChange: (text: string) => void;
  reviewerCommentsFile: File | null;
  onReviewerCommentsFileChange: (file: File | null) => void;
  journalName: string;
  onJournalNameChange: (name: string) => void;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export default function StepTwoRevision({
  manuscriptText,
  onManuscriptTextChange,
  manuscriptFile,
  onManuscriptFileChange,
  reviewerCommentsText,
  onReviewerCommentsTextChange,
  reviewerCommentsFile,
  onReviewerCommentsFileChange,
  journalName,
  onJournalNameChange,
}: Props) {
  const manuscriptFileRef = useRef<HTMLInputElement>(null);
  const commentsFileRef = useRef<HTMLInputElement>(null);

  const hasManuscript = manuscriptFile !== null || manuscriptText.trim().length > 0;
  const hasComments = reviewerCommentsFile !== null || reviewerCommentsText.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 mb-1">Manuscript & Reviewer Comments</h2>
        <p className="text-sm text-slate-500">
          Provide your existing manuscript and the peer-review comments you received.
        </p>
      </div>

      {/* ── Manuscript section ────────────────────────────────────────────── */}
      <div className="rounded-xl border-2 border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Your Manuscript</h3>
          {hasManuscript && (
            <span className="text-xs text-green-600 font-medium bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
              ✓ Provided
            </span>
          )}
        </div>

        {manuscriptFile ? (
          <div className="flex items-center gap-2 text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
            <span>📄 {manuscriptFile.name}</span>
            <button
              type="button"
              onClick={() => { onManuscriptFileChange(null); }}
              className="ml-auto text-xs text-rose-500 hover:text-rose-700"
            >
              Remove
            </button>
          </div>
        ) : (
          <textarea
            rows={8}
            value={manuscriptText}
            onChange={(e) => onManuscriptTextChange(e.target.value)}
            placeholder="Paste your manuscript text here (all sections: Abstract, Introduction, Methods, Results, Discussion, References…)"
            className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
              placeholder-slate-400 resize-none transition-all focus:outline-none leading-relaxed
              focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => manuscriptFileRef.current?.click()}
            className="text-xs font-medium text-brand-500 hover:text-brand-400 underline underline-offset-2"
          >
            {manuscriptFile ? '↺ Replace .docx' : '↑ Upload .docx instead'}
          </button>
          {manuscriptText && !manuscriptFile && (
            <span className="text-xs text-slate-400">{wordCount(manuscriptText).toLocaleString()} words</span>
          )}
          <input
            ref={manuscriptFileRef}
            type="file"
            accept=".docx,.doc,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              onManuscriptFileChange(f);
              if (f) onManuscriptTextChange('');
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* ── Reviewer comments section ─────────────────────────────────────── */}
      <div className="rounded-xl border-2 border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Reviewer Comments</h3>
          {hasComments && (
            <span className="text-xs text-green-600 font-medium bg-green-50 px-2 py-0.5 rounded-full border border-green-200">
              ✓ Provided
            </span>
          )}
        </div>

        {reviewerCommentsFile ? (
          <div className="flex items-center gap-2 text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
            <span>📄 {reviewerCommentsFile.name}</span>
            <button
              type="button"
              onClick={() => onReviewerCommentsFileChange(null)}
              className="ml-auto text-xs text-rose-500 hover:text-rose-700"
            >
              Remove
            </button>
          </div>
        ) : (
          <textarea
            rows={6}
            value={reviewerCommentsText}
            onChange={(e) => onReviewerCommentsTextChange(e.target.value)}
            placeholder="Paste reviewer comments from the journal decision letter here (include all Reviewer 1, Reviewer 2 sections)…"
            className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
              placeholder-slate-400 resize-none transition-all focus:outline-none leading-relaxed
              focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => commentsFileRef.current?.click()}
            className="text-xs font-medium text-brand-500 hover:text-brand-400 underline underline-offset-2"
          >
            {reviewerCommentsFile ? '↺ Replace .docx' : '↑ Upload reviewer comment .docx'}
          </button>
          <input
            ref={commentsFileRef}
            type="file"
            accept=".docx,.doc,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              onReviewerCommentsFileChange(f);
              if (f) onReviewerCommentsTextChange('');
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* ── Journal name ──────────────────────────────────────────────────── */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          Journal name <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={journalName}
          onChange={(e) => onJournalNameChange(e.target.value)}
          placeholder="e.g. PLOS ONE, BMJ, Nature Medicine…"
          className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm text-slate-800
            placeholder-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <p className="mt-1 text-xs text-slate-400">Used in the point-by-point reply header.</p>
      </div>
    </div>
  );
}
