import { useState, useEffect, useRef } from 'react';
import type { CommentChangeSuggestion, CommentPlan, DiscussionMessage, RevisionIntakeData, RealReviewerComment, RevisionRound, ImportManuscriptResult } from '../../types/paper';
import {
  importManuscript,
  parseReviewerComments,
  parseReviewerCommentsDocx,
  suggestChanges,
  discussComment,
  finalizeComment,
  generateFromPlans,
  getRevisionRounds,
  downloadPointByPointDocx,
  downloadRevisedManuscriptDocx,
  downloadTrackChangesDocx,
} from '../../api/projects';

export type StepId = 'manuscript' | 'comments' | 'edit_comments' | 'responses' | 'download';

interface Props {
  projectId: string;
  initialData?: RevisionIntakeData;
  onOpenSettings: () => void;
  activeStep?: StepId;
  onStepChange?: (step: StepId) => void;
}

const STEPS: { id: StepId; label: string }[] = [
  { id: 'manuscript',    label: '1. Manuscript' },
  { id: 'comments',      label: '2. Comments' },
  { id: 'edit_comments', label: '3. Edit Comments' },
  { id: 'responses',     label: '4. Discuss & Finalize' },
  { id: 'download',      label: '5. Download' },
];

function _renumberComments(list: RealReviewerComment[]): RealReviewerComment[] {
  const byRev: Record<number, RealReviewerComment[]> = {};
  for (const c of list) {
    (byRev[c.reviewer_number] ??= []).push(c);
  }
  return Object.values(byRev).flatMap((group) =>
    group.map((c, i) => ({ ...c, comment_number: i + 1 }))
  );
}

function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    major:    'bg-rose-100 text-rose-700 border-rose-200',
    minor:    'bg-amber-100 text-amber-700 border-amber-200',
    editorial:'bg-slate-100 text-slate-600 border-slate-200',
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${colors[category] ?? colors.major}`}>
      {category}
    </span>
  );
}

function MetaBadge({ text }: { text: string }) {
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
      {text}
    </span>
  );
}

function CommentChip({
  plan,
  isActive,
  onClick,
}: {
  plan: CommentPlan;
  isActive: boolean;
  onClick: () => void;
}) {
  const label = `R${plan.reviewer_number} C${plan.comment_number}`;
  let cls = 'text-xs font-medium px-2.5 py-1 rounded-full border cursor-pointer transition-colors ';
  if (plan.is_finalized) {
    cls += 'bg-emerald-100 text-emerald-700 border-emerald-200';
  } else if (isActive) {
    cls += 'bg-brand-600 text-white border-brand-600';
  } else {
    cls += 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50';
  }
  return (
    <button onClick={onClick} className={cls} title={plan.original_comment.slice(0, 80)}>
      {label} {plan.is_finalized ? '✓' : isActive ? '●' : '○'}
    </button>
  );
}

export default function RealRevisionPanel({ projectId, initialData, onOpenSettings: _onOpenSettings, activeStep, onStepChange }: Props) {
  // ── Round management ──────────────────────────────────────────────────────
  const [rounds, setRounds] = useState<RevisionRound[]>([]);
  const [activeRound, setActiveRound] = useState(1);

  // ── Step state ────────────────────────────────────────────────────────────
  const [step, setStep] = useState<StepId>(activeStep ?? (initialData ? 'comments' : 'manuscript'));

  useEffect(() => {
    if (activeStep && activeStep !== step) setStep(activeStep);
  }, [activeStep]);

  function changeStep(s: StepId) { setStep(s); onStepChange?.(s); }

  // ── Manuscript step ───────────────────────────────────────────────────────
  const [manuscriptText, setManuscriptText] = useState(initialData?.manuscript_text ?? '');
  const [importResult, setImportResult] = useState<ImportManuscriptResult | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Comments step ─────────────────────────────────────────────────────────
  const [rawComments, setRawComments] = useState(initialData?.reviewer_comments_text ?? '');
  const [journalName, setJournalName] = useState(initialData?.journal_name ?? '');
  const [parsedComments, setParsedComments] = useState<RealReviewerComment[]>([]);
  const [parseLoading, setParseLoading] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CommentChangeSuggestion[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // ── Per-comment discussion step ───────────────────────────────────────────
  const [commentPlans, setCommentPlans] = useState<CommentPlan[]>([]);
  const [activeCommentIdx, setActiveCommentIdx] = useState(0);
  const [discussInput, setDiscussInput] = useState('');
  const [doiInput, setDoiInput] = useState('');
  const [discussLoading, setDiscussLoading] = useState(false);
  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const autoInitTriggeredRef = useRef<Set<string>>(new Set());

  // ── Download step ─────────────────────────────────────────────────────────
  const [currentRound, setCurrentRound] = useState<RevisionRound | null>(null);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // ── Load existing rounds on mount ─────────────────────────────────────────
  useEffect(() => {
    getRevisionRounds(projectId).then((r) => {
      if (r.length > 0) setRounds(r as RevisionRound[]);
    }).catch(() => {});
  }, [projectId]);

  // ── Auto-process manuscript + comments when initialData present ───────────
  useEffect(() => {
    if (!initialData) return;

    const autoImport = async () => {
      setImportLoading(true);
      setImportError(null);
      try {
        const src = initialData.manuscript_file ?? initialData.manuscript_text;
        const result = await importManuscript(projectId, src);
        setImportResult(result);
        setManuscriptText(initialData.manuscript_text);
      } catch (e: any) {
        setImportError(e.message ?? 'Import failed');
      } finally {
        setImportLoading(false);
      }
    };

    const autoParse = async () => {
      const raw = initialData.reviewer_comments_text;
      const file = initialData.reviewer_comments_file;
      if (!raw && !file) return;
      setParseLoading(true);
      setParseError(null);
      try {
        const comments = file
          ? await parseReviewerCommentsDocx(projectId, file)
          : await parseReviewerComments(projectId, {
              raw_comments: raw,
              journal_name: initialData.journal_name,
              round_number: activeRound,
            });
        setParsedComments(comments);
        setRawComments(raw);
        setJournalName(initialData.journal_name);
      } catch (e: any) {
        setParseError(e.message ?? 'Parse failed');
      } finally {
        setParseLoading(false);
      }
    };

    autoImport();
    autoParse();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initialize comment plans when parsedComments changes ──────────────────
  useEffect(() => {
    if (parsedComments.length === 0) return;
    setCommentPlans(parsedComments.map((c) => ({
      ...c,
      discussion: [],
      current_plan: '',
      doi_references: [],
      is_finalized: false,
      author_response: '',
      action_taken: '',
      manuscript_changes: '',
    })));
    setActiveCommentIdx(0);
    autoInitTriggeredRef.current = new Set();
  }, [parsedComments]);

  // ── Auto-trigger initial plan for active comment when entering Step 3 ─────
  useEffect(() => {
    if (step !== 'responses' || commentPlans.length === 0 || discussLoading) return;
    const plan = commentPlans[activeCommentIdx];
    if (!plan || plan.discussion.length > 0 || plan.is_finalized) return;
    const key = `${plan.reviewer_number}-${plan.comment_number}`;
    if (autoInitTriggeredRef.current.has(key)) return;
    autoInitTriggeredRef.current.add(key);
    triggerInitialPlan(plan);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, activeCommentIdx, commentPlans.length]);

  // ── Handlers: Manuscript ──────────────────────────────────────────────────

  async function handleImportText() {
    if (!manuscriptText.trim()) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const result = await importManuscript(projectId, manuscriptText);
      setImportResult(result);
    } catch (e: any) {
      setImportError(e.message ?? 'Import failed');
    } finally {
      setImportLoading(false);
    }
  }

  async function handleImportFile(file: File) {
    setImportLoading(true);
    setImportError(null);
    try {
      const result = await importManuscript(projectId, file);
      setImportResult(result);
    } catch (e: any) {
      setImportError(e.message ?? 'Import failed');
    } finally {
      setImportLoading(false);
    }
  }

  // ── Handlers: Comments ────────────────────────────────────────────────────

  async function handleParseComments() {
    if (!rawComments.trim()) return;
    setParseLoading(true);
    setParseError(null);
    try {
      const comments = await parseReviewerComments(projectId, {
        raw_comments: rawComments,
        journal_name: journalName,
        round_number: activeRound,
      });
      setParsedComments(comments);
    } catch (e: any) {
      setParseError(e.message ?? 'Parse failed');
    } finally {
      setParseLoading(false);
    }
  }

  async function handleParseCommentsFile(file: File) {
    setParseLoading(true);
    setParseError(null);
    try {
      const comments = await parseReviewerCommentsDocx(projectId, file);
      setParsedComments(comments);
    } catch (e: any) {
      setParseError(e.message ?? 'Parse failed');
    } finally {
      setParseLoading(false);
    }
  }

  async function handleGenerateSuggestions() {
    if (parsedComments.length === 0) return;
    setSuggestLoading(true);
    setSuggestError(null);
    try {
      const out = await suggestChanges(projectId, {
        manuscript_text: manuscriptText,
        journal_name: journalName,
        parsed_comments: parsedComments,
      });
      setSuggestions(out);
    } catch (e: any) {
      setSuggestError(e.message ?? 'Suggestion generation failed');
    } finally {
      setSuggestLoading(false);
    }
  }

  // ── Handlers: Discussion ──────────────────────────────────────────────────

  async function triggerInitialPlan(plan: CommentPlan) {
    const initMessage = 'Please analyze this reviewer comment and propose a detailed change plan — what to modify, where in the manuscript (section, paragraph, approximate line numbers), and how.';
    setDiscussLoading(true);
    setDiscussError(null);
    try {
      const resp = await discussComment(projectId, {
        original_comment: plan.original_comment,
        reviewer_number: plan.reviewer_number,
        comment_number: plan.comment_number,
        user_message: initMessage,
        history: [],
        current_plan: '',
        doi_references: [],
        manuscript_text: manuscriptText,
      });
      setCommentPlans((prev) => prev.map((p) =>
        p.reviewer_number === plan.reviewer_number && p.comment_number === plan.comment_number
          ? {
              ...p,
              discussion: [
                { role: 'user' as const, content: initMessage },
                { role: 'ai' as const, content: resp.ai_response },
              ],
              current_plan: resp.updated_plan,
            }
          : p
      ));
    } catch (e: any) {
      setDiscussError(e.message ?? 'Failed to generate initial plan');
    } finally {
      setDiscussLoading(false);
    }
  }

  async function handleSendMessage() {
    const message = discussInput.trim();
    if (!message || discussLoading) return;
    const plan = commentPlans[activeCommentIdx];
    if (!plan) return;

    setDiscussInput('');
    setDiscussLoading(true);
    setDiscussError(null);

    // Optimistically add user message
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx
        ? { ...p, discussion: [...p.discussion, { role: 'user' as const, content: message }] }
        : p
    ));

    try {
      const resp = await discussComment(projectId, {
        original_comment: plan.original_comment,
        reviewer_number: plan.reviewer_number,
        comment_number: plan.comment_number,
        user_message: message,
        history: plan.discussion,
        current_plan: plan.current_plan,
        doi_references: plan.doi_references,
        manuscript_text: manuscriptText,
      });
      setCommentPlans((prev) => prev.map((p, i) =>
        i === activeCommentIdx
          ? {
              ...p,
              discussion: [...p.discussion, { role: 'ai' as const, content: resp.ai_response }],
              current_plan: resp.updated_plan,
            }
          : p
      ));
    } catch (e: any) {
      setDiscussError(e.message ?? 'Failed to send message');
    } finally {
      setDiscussLoading(false);
    }
  }

  function handleAddDoi() {
    const doi = doiInput.trim();
    if (!doi) return;
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx && !p.doi_references.includes(doi)
        ? { ...p, doi_references: [...p.doi_references, doi] }
        : p
    ));
    setDoiInput('');
  }

  function handleRemoveDoi(doi: string) {
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx
        ? { ...p, doi_references: p.doi_references.filter((d) => d !== doi) }
        : p
    ));
  }

  function handleUpdatePlan(value: string) {
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx ? { ...p, current_plan: value } : p
    ));
  }

  async function handleFinalizeComment() {
    const plan = commentPlans[activeCommentIdx];
    if (!plan || finalizeLoading) return;

    setFinalizeLoading(true);
    setDiscussError(null);
    try {
      const resp = await finalizeComment(projectId, {
        original_comment: plan.original_comment,
        reviewer_number: plan.reviewer_number,
        comment_number: plan.comment_number,
        finalized_plan: plan.current_plan,
        manuscript_text: manuscriptText,
      });

      const updatedPlans = commentPlans.map((p, i) =>
        i === activeCommentIdx
          ? {
              ...p,
              is_finalized: true,
              author_response: resp.author_response,
              action_taken: resp.action_taken,
              manuscript_changes: resp.manuscript_changes,
            }
          : p
      );
      setCommentPlans(updatedPlans);

      // Auto-advance to next unfinalised comment
      const nextIdx = updatedPlans.findIndex((p, i) => i > activeCommentIdx && !p.is_finalized);
      if (nextIdx >= 0) {
        setActiveCommentIdx(nextIdx);
      } else if (updatedPlans.every((p) => p.is_finalized)) {
        changeStep('download');
      }
    } catch (e: any) {
      setDiscussError(e.message ?? 'Finalization failed');
    } finally {
      setFinalizeLoading(false);
    }
  }

  function handleUnfinalizeComment(idx: number) {
    setCommentPlans((prev) => prev.map((p, i) =>
      i === idx ? { ...p, is_finalized: false, author_response: '', action_taken: '', manuscript_changes: '' } : p
    ));
    setActiveCommentIdx(idx);
    changeStep('responses');
  }

  // ── Handler: Generate documents ───────────────────────────────────────────

  async function handleGenerateFromPlans() {
    if (!commentPlans.every((p) => p.is_finalized)) return;
    setGenerateLoading(true);
    setGenerateError(null);
    try {
      const round = await generateFromPlans(projectId, {
        round_number: activeRound,
        journal_name: journalName,
        finalized_plans: commentPlans,
      });
      setCurrentRound(round);
      setRounds((prev) => {
        const idx = prev.findIndex((r) => r.round_number === round.round_number);
        if (idx >= 0) { const next = [...prev]; next[idx] = round; return next; }
        return [...prev, round];
      });
    } catch (e: any) {
      setGenerateError(e.message ?? 'Generation failed');
    } finally {
      setGenerateLoading(false);
    }
  }

  function handleNewRound() {
    const nextRound = rounds.length + 1;
    setActiveRound(nextRound);
    setParsedComments([]);
    setCommentPlans([]);
    setRawComments('');
    setCurrentRound(null);
    autoInitTriggeredRef.current = new Set();
    changeStep('manuscript');
  }

  // ── Handlers: Edit Comments ───────────────────────────────────────────────

  function handleEditComment(idx: number, field: 'original_comment' | 'category', value: string) {
    setParsedComments((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
  }

  function handleDeleteComment(idx: number) {
    setParsedComments((prev) => _renumberComments(prev.filter((_, i) => i !== idx)));
  }

  function handleCombineComments(idx: number) {
    setParsedComments((prev) => {
      if (idx + 1 >= prev.length) return prev;
      const next = [...prev];
      const combined = {
        ...next[idx],
        original_comment: next[idx].original_comment + '\n\n' + next[idx + 1].original_comment,
      };
      next.splice(idx, 2, combined);
      return _renumberComments(next);
    });
  }

  function handleSplitComment(idx: number) {
    setParsedComments((prev) => {
      const next = [...prev];
      const c = next[idx];
      const splitIdx = c.original_comment.indexOf('\n\n');
      const mid = Math.floor(c.original_comment.length / 2);
      const [first, second] =
        splitIdx >= 0
          ? [c.original_comment.slice(0, splitIdx).trim(), c.original_comment.slice(splitIdx + 2).trim()]
          : [c.original_comment.slice(0, mid).trim(), c.original_comment.slice(mid).trim()];
      next.splice(idx, 1, { ...c, original_comment: first }, { ...c, original_comment: second });
      return _renumberComments(next);
    });
  }

  function handleAddComment(reviewerNumber: number) {
    setParsedComments((prev) =>
      _renumberComments([
        ...prev,
        { reviewer_number: reviewerNumber, comment_number: 0, original_comment: '', category: 'major' as const },
      ])
    );
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const roundForDownload = currentRound ?? rounds.find((r) => r.round_number === activeRound);
  const allFinalized = commentPlans.length > 0 && commentPlans.every((p) => p.is_finalized);
  const finalizedCount = commentPlans.filter((p) => p.is_finalized).length;
  const activePlan = commentPlans[activeCommentIdx] ?? null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Manuscript Revision</h1>
            <p className="text-sm text-slate-500 mt-1">Real peer-review response workflow</p>
          </div>
          {/* Round selector */}
          <div className="flex items-center gap-2">
            {rounds.map((r) => (
              <button
                key={r.round_number}
                onClick={() => { setActiveRound(r.round_number); setCurrentRound(r); changeStep('download'); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  activeRound === r.round_number
                    ? 'bg-brand-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                Round {r.round_number}
              </button>
            ))}
            {rounds.length > 0 && (
              <button
                onClick={handleNewRound}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                + New Round
              </button>
            )}
          </div>
        </div>

        {/* Auto-processing banner */}
        {(importLoading || parseLoading) && (
          <div className="flex items-center gap-2 text-sm text-brand-700 bg-brand-50 border border-brand-200 rounded-xl px-4 py-2.5">
            <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            Processing your manuscript and parsing reviewer comments…
          </div>
        )}

        {/* Step nav */}
        <div className="flex gap-1 bg-white border border-slate-200 rounded-xl p-1.5">
          {STEPS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => changeStep(id)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                step === id
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Step 1: Manuscript ─────────────────────────────────────────────── */}
        {step === 'manuscript' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">Manuscript</h2>
              {importResult && (
                <label className="cursor-pointer text-sm text-brand-600 hover:text-brand-800 underline underline-offset-2 font-medium">
                  ↺ Replace manuscript
                  <input type="file" accept=".docx,.doc,.txt" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                </label>
              )}
            </div>

            {importLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 rounded-xl p-4 border border-slate-200">
                <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                Processing manuscript…
              </div>
            )}

            {importError && (
              <p className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{importError}</p>
            )}

            {importResult ? (
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Word count', value: importResult.word_count.toLocaleString() },
                  { label: 'Sections found', value: importResult.sections_found.length },
                  { label: 'References', value: importResult.references_found },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-slate-50 rounded-xl p-3 text-center">
                    <div className="text-xl font-bold text-slate-800">{value}</div>
                    <div className="text-xs text-slate-500 mt-1">{label}</div>
                  </div>
                ))}
                <div className="col-span-3 bg-blue-50 border border-blue-100 rounded-xl p-4">
                  <p className="text-xs font-semibold text-blue-700 mb-1 uppercase tracking-wide">Manuscript Summary</p>
                  <p className="text-sm text-slate-700">{importResult.manuscript_summary}</p>
                </div>
                {importResult.sections_found.length > 0 && (
                  <div className="col-span-3">
                    <p className="text-xs text-slate-500 mb-2">Sections detected:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {importResult.sections_found.map((s) => (
                        <span key={s} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{s}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="col-span-3">
                  <button
                    onClick={() => changeStep('comments')}
                    className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700"
                  >
                    Next: Reviewer Comments →
                  </button>
                </div>
              </div>
            ) : (
              !importLoading && (
                <>
                  <p className="text-sm text-slate-500">
                    Paste or upload your manuscript. We'll extract its structure, references, and generate a summary.
                  </p>
                  <textarea
                    rows={12}
                    value={manuscriptText}
                    onChange={(e) => setManuscriptText(e.target.value)}
                    placeholder="Paste your full manuscript here…"
                    className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
                      placeholder-slate-400 resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleImportText}
                      disabled={!manuscriptText.trim()}
                      className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-brand-600
                        hover:bg-brand-700 disabled:opacity-40 transition-colors"
                    >
                      Process Manuscript
                    </button>
                    <label className="cursor-pointer text-sm text-brand-600 hover:text-brand-800 underline underline-offset-2">
                      Upload .docx
                      <input type="file" accept=".docx,.doc,.txt" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                    </label>
                  </div>
                </>
              )
            )}
          </div>
        )}

        {/* ── Step 2: Reviewer Comments ──────────────────────────────────────── */}
        {step === 'comments' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-slate-800">Reviewer Comments</h2>
            <p className="text-sm text-slate-500">
              Paste the full reviewer decision letter. The AI will parse individual comments grouped by reviewer.
            </p>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Journal name <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={journalName}
                onChange={(e) => setJournalName(e.target.value)}
                placeholder="e.g. PLOS ONE, BMJ…"
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </div>

            <textarea
              rows={12}
              value={rawComments}
              onChange={(e) => setRawComments(e.target.value)}
              placeholder="Paste journal decision letter with reviewer comments here…"
              className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
                placeholder-slate-400 resize-none focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />

            <div className="flex items-center gap-3">
              <button
                onClick={handleParseComments}
                disabled={!rawComments.trim() || parseLoading}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-brand-600
                  hover:bg-brand-700 disabled:opacity-40 transition-colors"
              >
                {parseLoading ? 'Parsing…' : 'Parse Comments'}
              </button>
              <label className="cursor-pointer text-sm text-brand-600 hover:text-brand-800 underline underline-offset-2">
                Upload .docx
                <input type="file" accept=".docx,.doc,.txt" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleParseCommentsFile(f); e.target.value = ''; }} />
              </label>
            </div>

            {parseError && (
              <p className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{parseError}</p>
            )}

            {parsedComments.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-700">{parsedComments.length} comments parsed:</p>
                {Array.from(new Set(parsedComments.map((c) => c.reviewer_number))).sort().map((revNum) => (
                  <div key={revNum} className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                      <h3 className="text-sm font-semibold text-slate-700">Reviewer #{revNum}</h3>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {parsedComments
                        .filter((c) => c.reviewer_number === revNum)
                        .map((c) => (
                          <div key={`${c.reviewer_number}-${c.comment_number}`} className="p-4 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-slate-500">Comment {c.comment_number}</span>
                              <CategoryBadge category={c.severity ?? c.category} />
                              {c.domain && <MetaBadge text={c.domain} />}
                              {c.requirement_level && <MetaBadge text={c.requirement_level} />}
                            </div>
                            {c.intent_interpretation && (
                              <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-2 py-1">
                                <span className="font-semibold">Interpretation:</span> {c.intent_interpretation}
                              </p>
                            )}
                            {c.ambiguity_flag && (
                              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                                <span className="font-semibold">Needs clarification:</span> {c.ambiguity_question || 'Please clarify this reviewer request before drafting changes.'}
                              </p>
                            )}
                            <textarea
                              rows={3}
                              defaultValue={c.original_comment}
                              onChange={(e) => {
                                setParsedComments((prev) =>
                                  prev.map((p) =>
                                    p.reviewer_number === c.reviewer_number && p.comment_number === c.comment_number
                                      ? { ...p, original_comment: e.target.value }
                                      : p
                                  )
                                );
                              }}
                              className="w-full text-sm text-slate-700 border border-slate-200 rounded-lg p-2
                                resize-none focus:outline-none focus:border-brand-400"
                            />
                          </div>
                        ))}
                    </div>
                  </div>
                ))}

                <button
                  onClick={() => changeStep('edit_comments')}
                  className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700"
                >
                  Next: Edit Comments →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Edit Comments ──────────────────────────────────────────── */}
        {step === 'edit_comments' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Edit Comments</h2>
              <p className="text-sm text-slate-500 mt-1">
                Review the parsed comments. Combine merged items, split oversized ones, delete noise, or add missing comments before the AI coach begins.
              </p>
            </div>

            {parsedComments.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                No comments yet. Go back to Step 2 to parse reviewer comments.
              </div>
            ) : (
              <>
                {Array.from(new Set(parsedComments.map((c) => c.reviewer_number))).sort().map((revNum) => {
                  const revComments = parsedComments
                    .map((c, globalIdx) => ({ c, globalIdx }))
                    .filter(({ c }) => c.reviewer_number === revNum);
                  return (
                    <div key={revNum} className="rounded-xl border border-slate-200 overflow-hidden">
                      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-slate-700">Reviewer #{revNum}</h3>
                        <span className="text-xs text-slate-400">{revComments.length} comment{revComments.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {revComments.map(({ c, globalIdx }, revLocalIdx) => (
                          <div key={globalIdx} className="p-4 space-y-2">
                            {/* Header row */}
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-500 w-20 flex-shrink-0">
                                Comment {c.comment_number}
                              </span>
                              <select
                                value={c.category}
                                onChange={(e) => handleEditComment(globalIdx, 'category', e.target.value)}
                                className="text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-brand-400 bg-white"
                              >
                                <option value="major">major</option>
                                <option value="minor">minor</option>
                                <option value="editorial">editorial</option>
                              </select>
                              <div className="flex items-center gap-1.5 ml-auto">
                                <button
                                  onClick={() => handleSplitComment(globalIdx)}
                                  title="Split at first blank line (or midpoint)"
                                  className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                                >
                                  Split
                                </button>
                                <button
                                  onClick={() => handleDeleteComment(globalIdx)}
                                  title="Delete this comment"
                                  className="text-xs px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 transition-colors"
                                >
                                  ✕ Delete
                                </button>
                              </div>
                            </div>

                            {/* Editable text */}
                            <textarea
                              rows={4}
                              value={c.original_comment}
                              onChange={(e) => handleEditComment(globalIdx, 'original_comment', e.target.value)}
                              className="w-full text-sm text-slate-700 border border-slate-200 rounded-lg p-2
                                resize-none focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-100"
                            />

                            {/* Combine button between consecutive same-reviewer comments */}
                            {revLocalIdx < revComments.length - 1 && (
                              <div className="flex justify-center pt-1">
                                <button
                                  onClick={() => handleCombineComments(globalIdx)}
                                  title="Merge this comment with the next one"
                                  className="text-xs px-3 py-1 rounded-full border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
                                >
                                  Combine ↓
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Add comment per reviewer */}
                      <div className="px-4 py-3 bg-slate-50 border-t border-slate-100">
                        <button
                          onClick={() => handleAddComment(revNum)}
                          className="text-xs text-brand-600 hover:text-brand-800 underline underline-offset-2 font-medium"
                        >
                          + Add Comment to Reviewer #{revNum}
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="space-y-3 pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleGenerateSuggestions}
                      disabled={parsedComments.length === 0 || suggestLoading}
                      className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                    >
                      {suggestLoading ? 'Generating Suggestions…' : 'Generate AI Change Suggestions'}
                    </button>
                    {suggestError && <span className="text-xs text-rose-600">{suggestError}</span>}
                  </div>

                  {suggestions.length > 0 && (
                    <div className="space-y-2 max-h-72 overflow-y-auto rounded-xl border border-indigo-100 bg-indigo-50 p-3">
                      {suggestions.map((s) => (
                        <div key={`${s.reviewer_number}-${s.comment_number}`} className="rounded-lg border border-indigo-200 bg-white p-3 space-y-1">
                          <p className="text-xs font-semibold text-indigo-700">R{s.reviewer_number} C{s.comment_number} · {s.action_type}</p>
                          {s.interpretation && <p className="text-xs text-slate-700"><span className="font-semibold">Interpretation:</span> {s.interpretation}</p>}
                          {s.copy_paste_text && <p className="text-xs text-slate-700"><span className="font-semibold">Copy-paste text:</span> {s.copy_paste_text}</p>}
                          {s.response_snippet && <p className="text-xs text-slate-700"><span className="font-semibold">Response snippet:</span> {s.response_snippet}</p>}
                          <p className="text-[11px] text-slate-500">Evidence: {s.evidence_check_status}{s.citation_needed ? ' · citation needed' : ''}</p>
                          {s.ambiguity_flag && <p className="text-[11px] text-amber-700">Ambiguity: {s.ambiguity_question || 'Please clarify before editing.'}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button
                    onClick={() => changeStep('comments')}
                    className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => changeStep('responses')}
                    disabled={parsedComments.length === 0}
                    className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 transition-colors"
                  >
                    Confirm Comments →
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step 4: Per-comment Discussion ─────────────────────────────────── */}
        {step === 'responses' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">

            {commentPlans.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                No comments to discuss. Go to Step 2 to parse reviewer comments first.
              </div>
            ) : (
              <>
                {/* Progress chips */}
                <div className="flex items-center gap-2 flex-wrap">
                  {commentPlans.map((plan, idx) => (
                    <CommentChip
                      key={`${plan.reviewer_number}-${plan.comment_number}`}
                      plan={plan}
                      isActive={idx === activeCommentIdx}
                      onClick={() => setActiveCommentIdx(idx)}
                    />
                  ))}
                  <span className="text-xs text-slate-500 ml-auto">
                    {finalizedCount} / {commentPlans.length} finalized
                  </span>
                </div>

                {activePlan && (
                  activePlan.is_finalized ? (
                    /* Finalized view — 4-column read-only card */
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-700">
                            Reviewer {activePlan.reviewer_number}, Comment {activePlan.comment_number}
                          </span>
                          <CategoryBadge category={activePlan.category} />
                          <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">
                            ✓ Finalized
                          </span>
                        </div>
                        <button
                          onClick={() => handleUnfinalizeComment(activeCommentIdx)}
                          className="text-xs text-brand-600 hover:text-brand-800 underline underline-offset-2"
                        >
                          Edit
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {[
                          { label: 'Reviewer Comment', value: activePlan.original_comment, color: 'slate' },
                          { label: 'Change Plan', value: activePlan.current_plan, color: 'blue' },
                          { label: 'Author Response', value: activePlan.author_response, color: 'brand' },
                          { label: 'Action Taken', value: activePlan.action_taken, color: 'emerald' },
                        ].map(({ label, value, color }) => (
                          <div key={label} className={`rounded-xl border border-${color}-200 bg-${color}-50 p-3 space-y-1`}>
                            <p className={`text-xs font-semibold text-${color}-700 uppercase tracking-wide`}>{label}</p>
                            <p className={`text-sm text-${color}-900 leading-relaxed whitespace-pre-wrap`}>{value || '—'}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* Discussion view */
                    <div className="space-y-4">
                      {/* Active comment header */}
                      <div className="flex items-center gap-2 py-2 border-b border-slate-100">
                        <span className="text-sm font-semibold text-slate-700">
                          Reviewer {activePlan.reviewer_number}, Comment {activePlan.comment_number}
                        </span>
                        <CategoryBadge category={activePlan.category} />
                      </div>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                        <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Original Comment</p>
                        <p className="text-sm text-slate-700 leading-relaxed">{activePlan.original_comment}</p>
                      </div>

                      {/* Two-panel body */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                        {/* Left: Discussion chat */}
                        <div className="space-y-3">
                          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Discussion</p>

                          {discussLoading && activePlan.discussion.length === 0 && (
                            <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                              <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                              Generating initial change plan…
                            </div>
                          )}

                          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                            {activePlan.discussion.map((msg: DiscussionMessage, i: number) => (
                              <div
                                key={i}
                                className={`rounded-xl p-3 text-sm leading-relaxed whitespace-pre-wrap ${
                                  msg.role === 'ai'
                                    ? 'bg-brand-50 text-brand-900 border border-brand-100'
                                    : 'bg-slate-100 text-slate-800'
                                }`}
                              >
                                <span className={`text-xs font-semibold block mb-1 ${msg.role === 'ai' ? 'text-brand-600' : 'text-slate-500'}`}>
                                  {msg.role === 'ai' ? 'AI Coach' : 'You'}
                                </span>
                                {msg.content}
                              </div>
                            ))}
                            {discussLoading && activePlan.discussion.length > 0 && (
                              <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
                                <div className="w-3 h-3 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
                                Thinking…
                              </div>
                            )}
                          </div>

                          {/* Message input */}
                          <div className="space-y-2">
                            <textarea
                              rows={3}
                              value={discussInput}
                              onChange={(e) => setDiscussInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                  e.preventDefault();
                                  handleSendMessage();
                                }
                              }}
                              placeholder="Ask a question or refine the plan… (Cmd+Enter to send)"
                              disabled={discussLoading}
                              className="w-full rounded-xl border-2 border-slate-200 p-2.5 text-sm
                                placeholder-slate-400 resize-none focus:outline-none focus:border-brand-500
                                focus:ring-2 focus:ring-brand-100 disabled:opacity-50"
                            />
                            <button
                              onClick={handleSendMessage}
                              disabled={!discussInput.trim() || discussLoading}
                              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-brand-600
                                hover:bg-brand-700 disabled:opacity-40 transition-colors"
                            >
                              Send
                            </button>
                          </div>

                          {/* DOI input row */}
                          <div className="space-y-1.5">
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={doiInput}
                                onChange={(e) => setDoiInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDoi(); } }}
                                placeholder="10.xxxx/yyyy — DOI to cite"
                                className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs
                                  focus:outline-none focus:border-brand-400"
                              />
                              <button
                                onClick={handleAddDoi}
                                disabled={!doiInput.trim()}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100
                                  hover:bg-slate-200 text-slate-700 disabled:opacity-40 transition-colors"
                              >
                                + Add DOI ref
                              </button>
                            </div>
                            {activePlan.doi_references.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {activePlan.doi_references.map((doi) => (
                                  <span key={doi} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
                                    {doi}
                                    <button onClick={() => handleRemoveDoi(doi)} className="text-blue-400 hover:text-blue-600 ml-0.5">×</button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>

                          {discussError && (
                            <p className="text-xs text-rose-600 bg-rose-50 rounded-lg p-2">{discussError}</p>
                          )}
                        </div>

                        {/* Right: Current change plan */}
                        <div className="space-y-2">
                          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Current Change Plan</p>
                          <textarea
                            rows={16}
                            value={activePlan.current_plan}
                            onChange={(e) => handleUpdatePlan(e.target.value)}
                            placeholder="The AI will propose a change plan here after the first message…"
                            className="w-full rounded-xl border-2 border-blue-200 bg-blue-50 p-3 text-sm text-blue-900
                              placeholder-slate-400 resize-none focus:outline-none focus:border-blue-400
                              focus:ring-2 focus:ring-blue-100"
                          />
                          <p className="text-xs text-slate-400">You can also edit this plan directly.</p>
                        </div>
                      </div>

                      {/* Bottom action row */}
                      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                        <button
                          onClick={() => setActiveCommentIdx(Math.max(0, activeCommentIdx - 1))}
                          disabled={activeCommentIdx === 0}
                          className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200
                            text-slate-700 hover:bg-slate-50 disabled:opacity-30 transition-colors"
                        >
                          ← Prev Comment
                        </button>

                        <button
                          onClick={handleFinalizeComment}
                          disabled={!activePlan.current_plan.trim() || finalizeLoading || discussLoading}
                          className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-emerald-600
                            hover:bg-emerald-700 disabled:opacity-40 transition-colors"
                        >
                          {finalizeLoading ? 'Finalizing…' : 'Finalize This Comment →'}
                        </button>

                        <button
                          onClick={() => setActiveCommentIdx(Math.min(commentPlans.length - 1, activeCommentIdx + 1))}
                          disabled={activeCommentIdx === commentPlans.length - 1}
                          className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200
                            text-slate-700 hover:bg-slate-50 disabled:opacity-30 transition-colors"
                        >
                          Next Comment →
                        </button>
                      </div>
                    </div>
                  )
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 4: Download ───────────────────────────────────────────────── */}
        {step === 'download' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-slate-800">Download Documents</h2>

            {/* Gate: not all finalized */}
            {!allFinalized && commentPlans.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
                <p className="text-sm font-semibold text-amber-800">
                  {commentPlans.length - finalizedCount} comment{commentPlans.length - finalizedCount !== 1 ? 's' : ''} still need to be finalized before generating documents.
                </p>
                <div className="flex flex-wrap gap-2">
                  {commentPlans.filter((p) => !p.is_finalized).map((p, _i) => {
                    const idx = commentPlans.indexOf(p);
                    return (
                      <button
                        key={`${p.reviewer_number}-${p.comment_number}`}
                        onClick={() => { setActiveCommentIdx(idx); changeStep('responses'); }}
                        className="text-xs text-amber-700 underline underline-offset-2 hover:text-amber-900"
                      >
                        R{p.reviewer_number} C{p.comment_number}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Generate button (only shown when all finalized but no round yet) */}
            {allFinalized && !roundForDownload && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">
                  All {commentPlans.length} comments finalized. Click to generate the revised manuscript and download documents.
                </p>
                <button
                  onClick={handleGenerateFromPlans}
                  disabled={generateLoading}
                  className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand-600
                    hover:bg-brand-700 disabled:opacity-40 transition-colors"
                >
                  {generateLoading
                    ? 'Generating…'
                    : `Generate Documents (applies ${commentPlans.length} finalized change${commentPlans.length !== 1 ? 's' : ''})`}
                </button>
                {generateLoading && (
                  <div className="text-center py-6 text-slate-500 text-sm">
                    <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                    Applying changes and generating revised manuscript… this may take 1–2 minutes.
                  </div>
                )}
                {generateError && (
                  <p className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{generateError}</p>
                )}
              </div>
            )}

            {/* Download card */}
            {roundForDownload && (
              <>
                <p className="text-sm text-slate-500">
                  Round {activeRound} complete. Download your point-by-point reply document below.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <a
                    href={downloadPointByPointDocx(projectId, activeRound)}
                    download
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-brand-200 bg-brand-50 hover:bg-brand-100 hover:border-brand-500 transition-colors text-center shadow-sm"
                  >
                    <span className="text-4xl">📄</span>
                    <p className="text-sm font-bold text-brand-900">Point-by-Point Reply</p>
                    <p className="text-xs text-brand-700">Comment/Response/Change plan</p>
                  </a>

                  <a
                    href={downloadRevisedManuscriptDocx(projectId, activeRound)}
                    download
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-emerald-200 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-500 transition-colors text-center shadow-sm"
                  >
                    <span className="text-4xl">📝</span>
                    <p className="text-sm font-bold text-emerald-900">Revised Manuscript</p>
                    <p className="text-xs text-emerald-700">Clean version (.docx)</p>
                  </a>

                  <a
                    href={downloadTrackChangesDocx(projectId, activeRound)}
                    download
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-violet-200 bg-violet-50 hover:bg-violet-100 hover:border-violet-500 transition-colors text-center shadow-sm"
                  >
                    <span className="text-4xl">🔍</span>
                    <p className="text-sm font-bold text-violet-900">Track Changes</p>
                    <p className="text-xs text-violet-700">Word tracked changes (.docx)</p>
                  </a>
                </div>
                <p className="text-xs text-slate-400 text-center">
                  Apply the changes in the last column directly to your manuscript, then submit both files to the journal.
                </p>
              </>
            )}

            <div className="pt-2">
              <button
                onClick={handleNewRound}
                className="px-5 py-2 rounded-lg text-sm font-medium border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                + Start Round {activeRound + 1}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
