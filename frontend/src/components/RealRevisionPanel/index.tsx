import { useState, useEffect, useRef, Fragment } from 'react';
import type { CommentChangeSuggestion, CommentPlan, DiscussionMessage, RevisionIntakeData, RealReviewerComment, RevisionRoundSummary, ImportManuscriptResult, EditorialReviewResult } from '../../types/paper';
import {
  importManuscript,
  parseReviewerComments,
  parseReviewerCommentsDocx,
  suggestChanges,
  discussComment,
  finalizeComment,
  generateAllDocs,
  generateEditorialReview,
  getRevisionRounds,
  getRevisionWip,
  saveRevisionWip,
  getCommentWork,
  updateCommentWork,
  replaceComments,
  downloadPointByPointDocx,
  downloadManuscriptReferencePdf,
  downloadRevisedManuscriptDocx,
  downloadRevisedManuscriptPdf,
  downloadTrackChangesDocx,
} from '../../api/projects';
import { fetchSettings } from '../../api/settings';
import LoadingLottie from '../LoadingLottie';

export type StepId = 'manuscript' | 'comments' | 'edit_comments' | 'responses' | 'editor' | 'download';

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
  { id: 'editor',        label: '5. Editor Review' },
  { id: 'download',      label: '6. Download' },
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

export default function RealRevisionPanel({ projectId, initialData, activeStep, onStepChange }: Props) {
  // ── Round management ──────────────────────────────────────────────────────
  const [rounds, setRounds] = useState<RevisionRoundSummary[]>([]);
  const [activeRound, setActiveRound] = useState(1);

  // ── Step state ────────────────────────────────────────────────────────────
  const [step, setStep] = useState<StepId>(activeStep ?? (initialData ? 'comments' : 'manuscript'));

  useEffect(() => {
    if (activeStep && activeStep !== step) setStep(activeStep);
  }, [activeStep]);

  useEffect(() => {
    setEditorialReview(null);
    setEditorialError(null);
    setDocsReadyRound(null);
  }, [activeRound]);

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
  // Guard: when restoring comment_plans from WIP, skip the "fresh init" effect
  const wipPlansLoadedRef = useRef(false);
  const wipSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Editor review step ────────────────────────────────────────────────────
  const [editorialReview, setEditorialReview] = useState<EditorialReviewResult | null>(null);
  const [editorialLoading, setEditorialLoading] = useState(false);
  const [editorialError, setEditorialError] = useState<string | null>(null);

  // ── Download step ─────────────────────────────────────────────────────────
  const [docsReadyRound, setDocsReadyRound] = useState<number | null>(null);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // ── Author dialog for document generation ──────────────────────────────
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [trackChangesAuthor, setTrackChangesAuthor] = useState('');

  // ── Auto-save slim WIP state (non-comment data only) ─────────────────────
  useEffect(() => {
    if (!manuscriptText && !rawComments && !importResult) return;
    if (wipSaveTimerRef.current) clearTimeout(wipSaveTimerRef.current);
    wipSaveTimerRef.current = setTimeout(() => {
      saveRevisionWip(projectId, {
        import_result: importResult,
        raw_comments: rawComments,
        journal_name: journalName,
        step,
      }).catch(() => {});
    }, 1500);
    return () => {
      if (wipSaveTimerRef.current) clearTimeout(wipSaveTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importResult, step, rawComments, journalName]);

  // ── Load existing rounds + WIP state + comment_work on mount ────────────
  useEffect(() => {
    getRevisionRounds(projectId).then((r) => {
      if (r.length > 0) setRounds(r);
    }).catch(() => {});

    // Restore in-progress state when resuming (no fresh initialData)
    if (!initialData) {
      getRevisionWip(projectId).then((wip) => {
        if (wip.manuscript_text) setManuscriptText(wip.manuscript_text);
        if (wip.import_result) setImportResult(wip.import_result as ImportManuscriptResult);
        if (wip.raw_comments) setRawComments(wip.raw_comments);
        if (wip.journal_name) setJournalName(wip.journal_name);
        if (wip.step) changeStep(wip.step as StepId);
      }).catch(() => {});

      // Load per-comment data from comment_work table
      getCommentWork(projectId, activeRound).then((rows) => {
        if (rows.length === 0) return;
        // Rebuild parsedComments from rows
        const parsed: RealReviewerComment[] = rows.map((r) => ({
          reviewer_number: r.reviewer_number,
          comment_number: r.comment_number,
          original_comment: r.original_comment,
          category: r.category as 'major' | 'minor' | 'editorial',
          severity: r.severity as 'major' | 'minor' | 'editorial' | undefined,
          domain: r.domain as RealReviewerComment['domain'],
          requirement_level: r.requirement_level as RealReviewerComment['requirement_level'],
          ambiguity_flag: r.ambiguity_flag,
          ambiguity_question: r.ambiguity_question,
          intent_interpretation: r.intent_interpretation,
        }));
        // Set guard BEFORE setting parsedComments to prevent fresh-init effect
        wipPlansLoadedRef.current = true;
        setParsedComments(parsed);

        // Rebuild suggestions from rows that have them
        const sugs: CommentChangeSuggestion[] = rows
          .filter((r) => r.suggestion)
          .map((r) => r.suggestion as CommentChangeSuggestion);
        if (sugs.length > 0) setSuggestions(sugs);

        // Rebuild commentPlans from rows
        const plans: CommentPlan[] = rows.map((r) => ({
          reviewer_number: r.reviewer_number,
          comment_number: r.comment_number,
          original_comment: r.original_comment,
          category: r.category,
          discussion: r.discussion ?? [],
          current_plan: r.current_plan ?? '',
          doi_references: r.doi_references ?? [],
          is_finalized: r.is_finalized,
          author_response: r.author_response ?? '',
          action_taken: r.action_taken ?? '',
          manuscript_changes: r.manuscript_changes ?? '',
        }));
        setCommentPlans(plans);
        autoInitTriggeredRef.current = new Set(
          plans.map((p) => `${p.reviewer_number}-${p.comment_number}`)
        );
      }).catch(() => {});
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Skip fresh init if plans were already restored from saved WIP state
    if (wipPlansLoadedRef.current) {
      wipPlansLoadedRef.current = false; // reset for any future re-parse
      return;
    }
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
        round_number: activeRound,
      });
      setSuggestions(out);
    } catch (e: any) {
      setSuggestError(e.message ?? 'Suggestion generation failed');
    } finally {
      setSuggestLoading(false);
    }
  }

  // ── Handlers: Discussion ──────────────────────────────────────────────────

  function getFinalizedContext(excludePlan?: CommentPlan) {
    return commentPlans
      .filter((p) => p.is_finalized)
      .filter((p) => !(excludePlan && p.reviewer_number === excludePlan.reviewer_number && p.comment_number === excludePlan.comment_number))
      .map((p) => ({
        reviewer_number: p.reviewer_number,
        comment_number: p.comment_number,
        original_comment: p.original_comment,
        action_taken: p.action_taken,
        manuscript_changes: p.manuscript_changes,
      }));
  }

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
        round_number: activeRound,
        history: [],
        current_plan: '',
        doi_references: [],
        manuscript_text: manuscriptText,
        finalized_context: getFinalizedContext(plan),
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
        round_number: activeRound,
        history: plan.discussion,
        current_plan: plan.current_plan,
        doi_references: plan.doi_references,
        manuscript_text: manuscriptText,
        finalized_context: getFinalizedContext(plan),
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
    const plan = commentPlans[activeCommentIdx];
    if (!plan || plan.doi_references.includes(doi)) return;
    const newDois = [...plan.doi_references, doi];
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx ? { ...p, doi_references: newDois } : p
    ));
    setDoiInput('');
    updateCommentWork(projectId, activeRound, plan.reviewer_number, plan.comment_number, { doi_references: newDois }).catch(() => {});
  }

  function handleRemoveDoi(doi: string) {
    const plan = commentPlans[activeCommentIdx];
    if (!plan) return;
    const newDois = plan.doi_references.filter((d) => d !== doi);
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx ? { ...p, doi_references: newDois } : p
    ));
    updateCommentWork(projectId, activeRound, plan.reviewer_number, plan.comment_number, { doi_references: newDois }).catch(() => {});
  }

  function handleUpdatePlan(value: string) {
    const plan = commentPlans[activeCommentIdx];
    setCommentPlans((prev) => prev.map((p, i) =>
      i === activeCommentIdx ? { ...p, current_plan: value } : p
    ));
    // Debounced save (user is typing)
    if (plan) {
      if (planSaveTimerRef.current) clearTimeout(planSaveTimerRef.current);
      planSaveTimerRef.current = setTimeout(() => {
        updateCommentWork(projectId, activeRound, plan.reviewer_number, plan.comment_number, { current_plan: value }).catch(() => {});
      }, 500);
    }
  }

  async function handleFinalizeComment() {
    const plan = commentPlans[activeCommentIdx];
    if (!plan || finalizeLoading) return;

    setFinalizeLoading(true);
    setDiscussError(null);
    setEditorialReview(null);
    setEditorialError(null);
    try {
      const resp = await finalizeComment(projectId, {
        original_comment: plan.original_comment,
        reviewer_number: plan.reviewer_number,
        comment_number: plan.comment_number,
        finalized_plan: plan.current_plan,
        round_number: activeRound,
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
        changeStep('editor');
      }
    } catch (e: any) {
      setDiscussError(e.message ?? 'Finalization failed');
    } finally {
      setFinalizeLoading(false);
    }
  }

  function handleUnfinalizeComment(idx: number) {
    const plan = commentPlans[idx];
    setEditorialReview(null);
    setEditorialError(null);
    setCommentPlans((prev) => prev.map((p, i) =>
      i === idx ? { ...p, is_finalized: false, author_response: '', action_taken: '', manuscript_changes: '' } : p
    ));
    setActiveCommentIdx(idx);
    changeStep('responses');
    if (plan) {
      updateCommentWork(projectId, activeRound, plan.reviewer_number, plan.comment_number, { is_finalized: false }).catch(() => {});
    }
  }

  // ── Handler: Generate documents ───────────────────────────────────────────

  function handleGenerateFromPlans() {
    if (!commentPlans.every((p) => p.is_finalized)) return;
    // Show author dialog — actual generation happens in handleGenerateAllDocs
    (async () => {
      try {
        const s = await fetchSettings();
        setTrackChangesAuthor(s.track_changes_author || 'Amit');
      } catch { setTrackChangesAuthor('Amit'); }
    })();
    setGenerateError(null);
    setShowAuthorDialog(true);
  }

  async function handleGenerateAllDocs() {
    const author = trackChangesAuthor.trim() || 'Amit';
    setShowAuthorDialog(false);
    setGenerateLoading(true);
    setGenerateError(null);
    try {
      const result = await generateAllDocs(projectId, {
        round_number: activeRound,
        author,
      });
      setDocsReadyRound(activeRound);
      const roundSummary: RevisionRoundSummary = {
        round_number: activeRound,
        journal_name: journalName,
        comment_count: parsedComments.length,
        created_at: new Date().toISOString(),
        has_revised_article: Boolean(rounds.find((r) => r.round_number === activeRound)?.has_revised_article),
        has_point_by_point_docx: true,
        has_revised_manuscript_docx: true,
        has_track_changes_docx: true,
        has_revised_pdf: Boolean(result.revised_pdf_ready),
        docs_ready: true,
      };
      setRounds((prev) => {
        const idx = prev.findIndex((r) => r.round_number === activeRound);
        if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], ...roundSummary }; return next; }
        return [...prev, roundSummary];
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
    setDocsReadyRound(null);
    autoInitTriggeredRef.current = new Set();
    changeStep('manuscript');
  }

  // ── Handlers: Edit Comments ───────────────────────────────────────────────

  function _persistComments(updated: RealReviewerComment[]) {
    replaceComments(projectId, activeRound, updated.map((c) => ({
      reviewer_number: c.reviewer_number,
      comment_number: c.comment_number,
      original_comment: c.original_comment,
      category: c.category,
      severity: c.severity,
      domain: c.domain,
      requirement_level: c.requirement_level,
      ambiguity_flag: c.ambiguity_flag,
      ambiguity_question: c.ambiguity_question,
      intent_interpretation: c.intent_interpretation,
    }))).catch(() => {});
  }

  function handleEditComment(idx: number, field: 'original_comment' | 'category', value: string) {
    setParsedComments((prev) => {
      const updated = prev.map((c, i) => (i === idx ? { ...c, [field]: value } : c));
      // Debounce edit persistence — user may be typing
      if (planSaveTimerRef.current) clearTimeout(planSaveTimerRef.current);
      planSaveTimerRef.current = setTimeout(() => _persistComments(updated), 500);
      return updated;
    });
  }

  function handleDeleteComment(idx: number) {
    setParsedComments((prev) => {
      const updated = _renumberComments(prev.filter((_, i) => i !== idx));
      _persistComments(updated);
      return updated;
    });
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
      const updated = _renumberComments(next);
      _persistComments(updated);
      return updated;
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
      const updated = _renumberComments(next);
      _persistComments(updated);
      return updated;
    });
  }

  function handleAddComment(reviewerNumber: number) {
    setParsedComments((prev) => {
      const updated = _renumberComments([
        ...prev,
        { reviewer_number: reviewerNumber, comment_number: 0, original_comment: '', category: 'major' as const },
      ]);
      _persistComments(updated);
      return updated;
    });
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const roundForDownload = docsReadyRound === activeRound
    || Boolean(rounds.find((r) => r.round_number === activeRound)?.docs_ready);
  const allFinalized = commentPlans.length > 0 && commentPlans.every((p) => p.is_finalized);
  const finalizedCount = commentPlans.filter((p) => p.is_finalized).length;
  const activePlan = commentPlans[activeCommentIdx] ?? null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 style={{
              fontFamily: "Newsreader, Georgia, serif",
              fontWeight: 600,
              fontSize: '1.9rem',
              color: 'var(--text-bright)',
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
            }}>
              Manuscript Revision
            </h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              Peer-review response workflow · Round {activeRound}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-0.5 flex-shrink-0">
            {rounds.map((r) => (
              <button
                key={r.round_number}
                onClick={() => { setActiveRound(r.round_number); setDocsReadyRound(null); changeStep('download'); }}
                className="rev-round-btn"
                style={activeRound === r.round_number ? { background: 'var(--gold)', borderColor: 'var(--gold)', color: '#fff' } : undefined}
              >
                Round {r.round_number}
              </button>
            ))}
            {rounds.length > 0 && (
              <button onClick={handleNewRound} className="rev-round-btn rev-round-btn--new">
                + New Round
              </button>
            )}
          </div>
        </div>

        {/* Auto-processing banner */}
        {(importLoading || parseLoading) && (
          <div className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm animate-in" style={{
            background: 'var(--gold-faint)',
            border: '1px solid var(--border-muted)',
            color: 'var(--gold)',
            fontWeight: 500,
          }}>
            <LoadingLottie className="w-5 h-5 flex-shrink-0" />
            Processing your manuscript and parsing reviewer comments…
          </div>
        )}

        {/* Stepper */}
        <div className="rev-step-bar animate-in delay-0">
          {STEPS.map(({ id, label }, index) => {
            const stepOrder = STEPS.findIndex(s => s.id === step);
            const isDone = index < stepOrder;
            const isActive = step === id;
            const cleanLabel = label.replace(/^\d+\. /, '');
            return (
              <Fragment key={id}>
                {index > 0 && (
                  <div className={`rev-step-connector${isDone ? ' done' : ''}`} />
                )}
                <div className="rev-step-node">
                  <button
                    onClick={() => changeStep(id)}
                    className={`rev-step-circle${isDone ? ' is-done' : isActive ? ' is-active' : ''}`}
                  >
                    {isDone ? '✓' : index + 1}
                  </button>
                  <span className={`rev-step-label${isDone ? ' is-done' : isActive ? ' is-active' : ''}`}>
                    {cleanLabel}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>

        {/* ── Step 1: Manuscript ─────────────────────────────────────────────── */}
        {step === 'manuscript' && (
          <div className="rev-card animate-in delay-75 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="rev-heading">
                  {importResult ? 'Manuscript Imported' : 'Import Your Manuscript'}
                </h2>
                <p className="rev-subheading">
                  {importResult
                    ? 'Structure extracted. Review the summary and proceed to reviewer comments.'
                    : 'Paste the full text or upload a .docx file to extract structure, sections, and references.'}
                </p>
              </div>
              {importResult && (
                <label style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 10, border: '1px solid var(--border-muted)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, fontFamily: 'Manrope', cursor: 'pointer', background: 'transparent', whiteSpace: 'nowrap' }}>
                  ↺ Replace
                  <input type="file" accept=".docx,.doc,.txt" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                </label>
              )}
            </div>

            {importLoading && (
              <div className="flex items-center gap-3 py-8 justify-center" style={{ color: 'var(--text-muted)' }}>
                <LoadingLottie className="w-8 h-8" />
                <span className="text-sm">Analysing manuscript structure…</span>
              </div>
            )}

            {importError && (
              <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(200,50,50,0.08)', border: '1px solid rgba(200,50,50,0.2)', color: '#c05050' }}>
                {importError}
              </div>
            )}

            {importResult ? (
              <div className="space-y-5">
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'WORDS',      value: importResult.word_count.toLocaleString() },
                    { label: 'SECTIONS',   value: importResult.sections_found.length },
                    { label: 'REFERENCES', value: importResult.references_found },
                  ].map(({ label, value }) => (
                    <div key={label} className="rev-stat animate-in">
                      <div className="rev-stat-value">{value}</div>
                      <div className="rev-stat-label">{label}</div>
                    </div>
                  ))}
                </div>
                {/* Summary */}
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-faint)' }}>
                  <p className="text-xs font-semibold mb-1.5 uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Manuscript Summary</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--text-body)' }}>{importResult.manuscript_summary}</p>
                </div>
                {/* Revision-ready */}
                {(importResult.prepared_docx || importResult.reference_pdf_ready || importResult.reference_pdf_warning) && (
                  <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--gold-faint)', border: '1px solid var(--border-muted)' }}>
                    <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--gold)' }}>Revision-Ready Source</p>
                    <p className="text-sm" style={{ color: 'var(--text-body)' }}>
                      {importResult.prepared_docx
                        ? 'Track changes and continuous line numbering were enabled on the uploaded .docx.'
                        : 'The manuscript was imported, but revision-ready Word settings could not be confirmed.'}
                    </p>
                    {importResult.reference_pdf_ready && (
                      <a href={downloadManuscriptReferencePdf(projectId)} download
                        className="inline-flex items-center gap-1.5 text-sm font-semibold underline underline-offset-2"
                        style={{ color: 'var(--gold)' }}>
                        ↓ Download line-numbered reference PDF
                      </a>
                    )}
                    {importResult.reference_pdf_warning && (
                      <p className="text-xs" style={{ color: 'var(--rev-accent)' }}>{importResult.reference_pdf_warning}</p>
                    )}
                  </div>
                )}
                {/* Sections */}
                {importResult.sections_found.length > 0 && (
                  <div>
                    <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Sections Detected</p>
                    <div className="flex flex-wrap gap-1.5">
                      {importResult.sections_found.map((s) => (
                        <span key={s} className="text-xs px-2.5 py-0.5 rounded-full"
                          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)', color: 'var(--text-secondary)' }}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => changeStep('comments')}
                  className="rev-btn"
                  style={{ background: 'var(--gold)', color: '#fff' }}
                >
                  Continue to Reviewer Comments →
                </button>
              </div>
            ) : !importLoading && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Paste */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Paste Text</p>
                  <textarea
                    rows={10}
                    value={manuscriptText}
                    onChange={(e) => setManuscriptText(e.target.value)}
                    placeholder="Paste your full manuscript here…"
                    className="w-full rounded-xl p-3 resize-none focus:outline-none"
                    style={{
                      background: 'var(--bg-base)',
                      border: '1.5px solid var(--border-muted)',
                      color: 'var(--text-body)',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11.5,
                      lineHeight: 1.7,
                    }}
                  />
                  <button
                    onClick={handleImportText}
                    disabled={!manuscriptText.trim()}
                    className="rev-btn"
                    style={{
                      background: manuscriptText.trim() ? 'var(--gold)' : 'var(--bg-elevated)',
                      color: manuscriptText.trim() ? '#fff' : 'var(--text-muted)',
                      opacity: manuscriptText.trim() ? 1 : 0.5,
                      cursor: manuscriptText.trim() ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Process Text
                  </button>
                </div>
                {/* Upload */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Upload File</p>
                  <label className="rev-dropzone" style={{ minHeight: 220 }}>
                    <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>📄</div>
                    <div className="text-center">
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-body)' }}>Drop your .docx here</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>or click to browse · .docx, .doc, .txt</p>
                    </div>
                    <input type="file" accept=".docx,.doc,.txt" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Reviewer Comments ──────────────────────────────────────── */}
        {step === 'comments' && (
          <div className="rev-card animate-in delay-75 space-y-5">
            <div>
              <h2 className="rev-heading">Reviewer Comments</h2>
              <p className="rev-subheading">
                Paste the full decision letter. The AI will identify and categorise each reviewer's comments.
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-widest block mb-2" style={{ color: 'var(--text-muted)' }}>
                Target Journal <span className="normal-case font-normal" style={{ color: 'var(--text-faint)' }}>(optional)</span>
              </label>
              <input
                type="text"
                value={journalName}
                onChange={(e) => setJournalName(e.target.value)}
                placeholder="e.g. PLOS ONE, BMJ, Nature Medicine…"
                className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ background: 'var(--bg-base)', border: '1.5px solid var(--border-muted)', color: 'var(--text-body)' }}
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-widest block mb-2" style={{ color: 'var(--text-muted)' }}>
                Decision Letter
              </label>
              <textarea
                rows={10}
                value={rawComments}
                onChange={(e) => setRawComments(e.target.value)}
                placeholder="Paste the full journal decision letter with reviewer comments here…"
                className="w-full rounded-xl p-3 resize-none focus:outline-none"
                style={{
                  background: 'var(--bg-base)',
                  border: '1.5px solid var(--border-muted)',
                  color: 'var(--text-body)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11.5,
                  lineHeight: 1.7,
                }}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleParseComments}
                disabled={!rawComments.trim() || parseLoading}
                className="rev-btn"
                style={{
                  background: 'var(--gold)', color: '#fff',
                  opacity: (!rawComments.trim() || parseLoading) ? 0.4 : 1,
                  cursor: (!rawComments.trim() || parseLoading) ? 'not-allowed' : 'pointer',
                }}
              >
                {parseLoading ? 'Parsing…' : 'Parse Comments'}
              </button>
              <label className="text-sm font-medium cursor-pointer" style={{ color: 'var(--gold)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                Upload .docx
                <input type="file" accept=".docx,.doc,.txt" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleParseCommentsFile(f); e.target.value = ''; }} />
              </label>
            </div>

            {parseError && (
              <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(200,50,50,0.08)', border: '1px solid rgba(200,50,50,0.2)', color: '#c05050' }}>
                {parseError}
              </div>
            )}

            {parsedComments.length > 0 && (
              <div className="space-y-3 animate-in">
                <p className="text-sm font-medium" style={{ color: 'var(--text-body)' }}>
                  <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{parsedComments.length}</span> comments parsed across {new Set(parsedComments.map(c => c.reviewer_number)).size} reviewer{new Set(parsedComments.map(c => c.reviewer_number)).size !== 1 ? 's' : ''}
                </p>
                {Array.from(new Set(parsedComments.map((c) => c.reviewer_number))).sort().map((revNum) => (
                  <div key={revNum} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-faint)' }}>
                    <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-faint)' }}>
                      <div className="w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center text-white" style={{ background: 'var(--gold)' }}>
                        {revNum}
                      </div>
                      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-body)' }}>Reviewer {revNum}</h3>
                      <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
                        {parsedComments.filter(c => c.reviewer_number === revNum).length} comments
                      </span>
                    </div>
                    <div style={{ background: 'var(--bg-surface)' }}>
                      {parsedComments.filter((c) => c.reviewer_number === revNum).map((c) => (
                        <div key={`${c.reviewer_number}-${c.comment_number}`} className="p-4 space-y-2" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>#{c.comment_number}</span>
                            <CategoryBadge category={c.severity ?? c.category} />
                            {c.domain && <MetaBadge text={c.domain} />}
                            {c.requirement_level && <MetaBadge text={c.requirement_level} />}
                          </div>
                          {c.intent_interpretation && (
                            <p className="text-xs rounded-lg px-2.5 py-1.5" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-faint)' }}>
                              <span className="font-semibold">Interpretation:</span> {c.intent_interpretation}
                            </p>
                          )}
                          {c.ambiguity_flag && (
                            <p className="text-xs rounded-lg px-2.5 py-1.5" style={{ background: 'var(--rev-accent-faint)', border: '1px solid var(--rev-accent-ring)', color: 'var(--rev-accent)' }}>
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
                            className="w-full rounded-lg p-2 resize-none focus:outline-none"
                            style={{
                              background: 'var(--bg-base)',
                              border: '1px solid var(--border-faint)',
                              color: 'var(--text-body)',
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              lineHeight: 1.6,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => changeStep('edit_comments')}
                  className="rev-btn"
                  style={{ background: 'var(--gold)', color: '#fff' }}
                >
                  Continue to Edit Comments →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Edit Comments ──────────────────────────────────────────── */}
        {step === 'edit_comments' && (
          <div className="rev-card animate-in delay-75 space-y-5">
            <div>
              <h2 className="rev-heading">Edit Comments</h2>
              <p className="rev-subheading">
                Review each parsed comment. Combine, split, delete, or add comments before the AI coach begins.
              </p>
            </div>

            {parsedComments.length === 0 ? (
              <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No comments yet. Go back to Step 2 to parse reviewer comments.
              </div>
            ) : (
              <>
                {Array.from(new Set(parsedComments.map((c) => c.reviewer_number))).sort().map((revNum) => {
                  const revComments = parsedComments
                    .map((c, globalIdx) => ({ c, globalIdx }))
                    .filter(({ c }) => c.reviewer_number === revNum);
                  return (
                    <div key={revNum} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-faint)' }}>
                      <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-faint)' }}>
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center text-white" style={{ background: 'var(--gold)' }}>
                            {revNum}
                          </div>
                          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-body)' }}>Reviewer {revNum}</h3>
                        </div>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {revComments.length} comment{revComments.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div style={{ background: 'var(--bg-surface)' }}>
                        {revComments.map(({ c, globalIdx }, revLocalIdx) => (
                          <div key={globalIdx} className="p-4 space-y-2" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)', minWidth: 68 }}>
                                #{c.comment_number}
                              </span>
                              <select
                                value={c.category}
                                onChange={(e) => handleEditComment(globalIdx, 'category', e.target.value)}
                                className="text-xs rounded-lg px-2 py-1 focus:outline-none"
                                style={{ border: '1px solid var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
                              >
                                <option value="major">major</option>
                                <option value="minor">minor</option>
                                <option value="editorial">editorial</option>
                              </select>
                              <div className="flex items-center gap-1.5 ml-auto">
                                <button
                                  onClick={() => handleSplitComment(globalIdx)}
                                  className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                                  style={{ border: '1px solid var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent' }}
                                >
                                  Split
                                </button>
                                <button
                                  onClick={() => handleDeleteComment(globalIdx)}
                                  className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                                  style={{ border: '1px solid rgba(200,80,80,0.3)', color: '#d06060', background: 'transparent' }}
                                >
                                  ✕ Delete
                                </button>
                              </div>
                            </div>
                            <textarea
                              rows={4}
                              value={c.original_comment}
                              onChange={(e) => handleEditComment(globalIdx, 'original_comment', e.target.value)}
                              className="w-full rounded-lg p-2 resize-none focus:outline-none"
                              style={{
                                background: 'var(--bg-base)',
                                border: '1px solid var(--border-faint)',
                                color: 'var(--text-body)',
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 11,
                                lineHeight: 1.6,
                              }}
                            />
                            {revLocalIdx < revComments.length - 1 && (
                              <div className="flex justify-center pt-1">
                                <button
                                  onClick={() => handleCombineComments(globalIdx)}
                                  className="text-xs px-3 py-1 rounded-full transition-colors"
                                  style={{ border: '1px solid var(--rev-accent-ring)', color: 'var(--rev-accent)', background: 'var(--rev-accent-faint)' }}
                                >
                                  Combine ↓
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="px-4 py-3" style={{ background: 'var(--bg-base)', borderTop: '1px solid var(--border-faint)' }}>
                        <button
                          onClick={() => handleAddComment(revNum)}
                          style={{ color: 'var(--gold)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 3 }}
                        >
                          + Add Comment to Reviewer {revNum}
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="space-y-3 pt-4" style={{ borderTop: '1px solid var(--border-faint)' }}>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleGenerateSuggestions}
                      disabled={parsedComments.length === 0 || suggestLoading}
                      className="rev-btn"
                      style={{
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-body)',
                        border: '1px solid var(--border-muted)',
                        opacity: (parsedComments.length === 0 || suggestLoading) ? 0.4 : 1,
                        cursor: (parsedComments.length === 0 || suggestLoading) ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {suggestLoading ? '⚙ Generating…' : '✦ Generate AI Change Suggestions'}
                    </button>
                    {suggestError && <span className="text-xs" style={{ color: '#c05050' }}>{suggestError}</span>}
                  </div>

                  {suggestions.length > 0 && (
                    <div className="rounded-xl p-3 space-y-2 max-h-72 overflow-y-auto" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-faint)' }}>
                      {suggestions.map((s) => (
                        <div key={`${s.reviewer_number}-${s.comment_number}`} className="rounded-lg p-3 space-y-1" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-faint)' }}>
                          <p className="text-xs font-semibold" style={{ color: 'var(--gold)' }}>R{s.reviewer_number} C{s.comment_number} · {s.action_type}</p>
                          {s.interpretation && <p className="text-xs" style={{ color: 'var(--text-body)' }}><span className="font-semibold">Interpretation:</span> {s.interpretation}</p>}
                          {s.copy_paste_text && <p className="text-xs" style={{ color: 'var(--text-body)' }}><span className="font-semibold">Copy-paste:</span> {s.copy_paste_text}</p>}
                          {s.response_snippet && <p className="text-xs" style={{ color: 'var(--text-body)' }}><span className="font-semibold">Response:</span> {s.response_snippet}</p>}
                          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Evidence: {s.evidence_check_status}{s.citation_needed ? ' · citation needed' : ''}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
                  <button
                    onClick={() => changeStep('comments')}
                    className="text-sm font-medium px-4 py-2 rounded-xl"
                    style={{ border: '1px solid var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent' }}
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => changeStep('responses')}
                    disabled={parsedComments.length === 0}
                    className="rev-btn"
                    style={{
                      background: 'var(--gold)', color: '#fff',
                      opacity: parsedComments.length === 0 ? 0.4 : 1,
                      cursor: parsedComments.length === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Confirm &amp; Discuss →
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step 4: Discuss & Finalize ─────────────────────────────────────── */}
        {step === 'responses' && (
          <div className="rev-card animate-in delay-75 space-y-4">
            {commentPlans.length === 0 ? (
              <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No comments to discuss. Go to Step 2 to parse reviewer comments first.
              </div>
            ) : (
              <>
                {/* Header with progress counter */}
                <div className="flex items-center gap-4 pb-3" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                  <div className="flex-1">
                    <h2 className="rev-heading" style={{ fontSize: '1.4rem' }}>Discuss &amp; Finalize</h2>
                    <p className="rev-subheading" style={{ marginTop: '0.15rem' }}>Work through each comment with the AI coach.</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div style={{ fontSize: '1.75rem', fontWeight: 700, fontFamily: 'Manrope', letterSpacing: '-0.03em', color: finalizedCount === commentPlans.length ? 'var(--rev-done)' : 'var(--text-bright)' }}>
                      {finalizedCount}<span style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--text-muted)' }}>/{commentPlans.length}</span>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Finalized</p>
                  </div>
                </div>

                {/* Comment chips */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {commentPlans.map((plan, idx) => (
                    <button
                      key={`${plan.reviewer_number}-${plan.comment_number}`}
                      onClick={() => setActiveCommentIdx(idx)}
                      className="rev-chip"
                      style={
                        plan.is_finalized
                          ? { background: 'var(--rev-done-faint)', borderColor: 'var(--rev-done)', color: 'var(--rev-done)' }
                          : idx === activeCommentIdx
                            ? { background: 'var(--gold)', borderColor: 'var(--gold)', color: '#fff' }
                            : undefined
                      }
                      title={plan.original_comment.slice(0, 80)}
                    >
                      R{plan.reviewer_number}·C{plan.comment_number}{plan.is_finalized ? ' ✓' : idx === activeCommentIdx ? ' ●' : ''}
                    </button>
                  ))}
                </div>

                {activePlan && (
                  activePlan.is_finalized ? (
                    <div className="space-y-3 animate-in">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold" style={{ color: 'var(--text-bright)' }}>
                            Reviewer {activePlan.reviewer_number}, Comment {activePlan.comment_number}
                          </span>
                          <CategoryBadge category={activePlan.category} />
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: 'var(--rev-done-faint)', color: 'var(--rev-done)', border: '1px solid var(--rev-done)' }}>
                            ✓ Finalized
                          </span>
                        </div>
                        <button
                          onClick={() => handleUnfinalizeComment(activeCommentIdx)}
                          style={{ color: 'var(--gold)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 3 }}
                        >
                          Edit
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {([
                          {
                            label: 'Reviewer Comment',
                            desc:  'Original critique',
                            icon:  '❝',
                            value: activePlan.original_comment,
                            bgCls:     'bg-slate-200',
                            borderCls: 'border-slate-300',
                            stripe:    '#64748b',
                            labelCls:  'text-slate-600',
                          },
                          {
                            label: 'Change Plan',
                            desc:  'Revision strategy',
                            icon:  '◈',
                            value: activePlan.current_plan,
                            bgCls:     'bg-amber-50',
                            borderCls: 'border-amber-200',
                            stripe:    '#d97706',
                            labelCls:  'text-amber-700',
                          },
                          {
                            label: 'Author Response',
                            desc:  'Written reply',
                            icon:  '✦',
                            value: activePlan.author_response,
                            bgCls:     'bg-blue-50',
                            borderCls: 'border-blue-200',
                            stripe:    '#4f46e5',
                            labelCls:  'text-blue-700',
                          },
                          {
                            label: 'Action Taken',
                            desc:  'Manuscript edit',
                            icon:  '✓',
                            value: activePlan.action_taken,
                            bgCls:     'bg-emerald-50',
                            borderCls: 'border-emerald-200',
                            stripe:    '#10b981',
                            labelCls:  'text-emerald-700',
                          },
                        ] as const).map(({ label, desc, icon, value, bgCls, borderCls, stripe, labelCls }) => (
                          <div key={label} className={`rounded-xl overflow-hidden border ${borderCls} ${bgCls} flex flex-col`}>
                            {/* Colored top stripe */}
                            <div style={{ height: 3, background: stripe, flexShrink: 0 }} />
                            <div className="p-3 space-y-1.5 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-sm leading-none ${labelCls}`} style={{ fontFamily: 'serif' }}>{icon}</span>
                                <p className={`text-[9.5px] font-bold uppercase tracking-widest ${labelCls}`}>{label}</p>
                              </div>
                              <p className="text-[9.5px]" style={{ color: 'var(--text-faint)', fontFamily: 'Manrope' }}>{desc}</p>
                              <p className="text-xs leading-relaxed whitespace-pre-wrap pt-0.5" style={{ color: 'var(--text-body)' }}>
                                {value || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>—</span>}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4 animate-in">
                      <div className="flex items-center gap-2 py-2" style={{ borderBottom: '1px solid var(--border-faint)' }}>
                        <span className="text-sm font-semibold" style={{ color: 'var(--text-bright)' }}>
                          Reviewer {activePlan.reviewer_number}, Comment {activePlan.comment_number}
                        </span>
                        <CategoryBadge category={activePlan.category} />
                      </div>
                      <div className="rounded-xl p-3.5" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-faint)' }}>
                        <p className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-muted)' }}>Original Comment</p>
                        <p className="leading-relaxed" style={{ color: 'var(--text-body)', fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.7 }}>
                          {activePlan.original_comment}
                        </p>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Left: Chat */}
                        <div className="space-y-3">
                          <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>AI Coach Discussion</p>
                          {discussLoading && activePlan.discussion.length === 0 && (
                            <div className="flex items-center gap-3 py-5" style={{ color: 'var(--text-muted)' }}>
                              <LoadingLottie className="w-7 h-7" />
                              <span className="text-sm">Generating initial change plan…</span>
                            </div>
                          )}
                          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                            {activePlan.discussion.map((msg: DiscussionMessage, i: number) => (
                              <div key={i} className={`flex ${msg.role === 'ai' ? 'justify-start' : 'justify-end'}`}>
                                {msg.role === 'ai' && (
                                  <div className="w-6 h-6 rounded-full text-[9px] font-bold flex items-center justify-center mr-2 mt-0.5 flex-shrink-0"
                                    style={{ background: 'var(--gold)', color: '#fff' }}>
                                    AI
                                  </div>
                                )}
                                <div className={msg.role === 'ai' ? 'rev-bubble-ai' : 'rev-bubble-user'}>
                                  <span className="text-[10px] font-semibold block mb-1" style={{ color: msg.role === 'ai' ? 'var(--gold)' : 'var(--text-muted)' }}>
                                    {msg.role === 'ai' ? 'AI Coach' : 'You'}
                                  </span>
                                  {msg.content}
                                </div>
                              </div>
                            ))}
                            {discussLoading && activePlan.discussion.length > 0 && (
                              <div className="flex items-center gap-2 py-1">
                                <LoadingLottie className="w-5 h-5" />
                                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Thinking…</span>
                              </div>
                            )}
                          </div>
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
                              className="w-full rounded-xl p-2.5 resize-none focus:outline-none"
                              style={{
                                background: 'var(--bg-base)',
                                border: '1.5px solid var(--border-muted)',
                                color: 'var(--text-body)',
                                fontSize: 13,
                                opacity: discussLoading ? 0.5 : 1,
                              }}
                            />
                            <button
                              onClick={handleSendMessage}
                              disabled={!discussInput.trim() || discussLoading}
                              className="rev-btn"
                              style={{
                                background: 'var(--gold)', color: '#fff', padding: '7px 18px', borderRadius: 8,
                                opacity: (!discussInput.trim() || discussLoading) ? 0.4 : 1,
                              }}
                            >
                              Send
                            </button>
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={doiInput}
                                onChange={(e) => setDoiInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDoi(); } }}
                                placeholder="10.xxxx/yyyy — DOI to cite"
                                className="flex-1 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                                style={{ border: '1px solid var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
                              />
                              <button
                                onClick={handleAddDoi}
                                disabled={!doiInput.trim()}
                                className="text-xs px-3 py-1.5 rounded-lg"
                                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-muted)', opacity: doiInput.trim() ? 1 : 0.4 }}
                              >
                                + DOI
                              </button>
                            </div>
                            {activePlan.doi_references.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {activePlan.doi_references.map((doi) => (
                                  <span key={doi} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                                    style={{ background: 'var(--gold-faint)', color: 'var(--gold)', border: '1px solid var(--border-muted)' }}>
                                    {doi}
                                    <button onClick={() => handleRemoveDoi(doi)} style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, marginLeft: 2 }}>×</button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          {discussError && (
                            <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(200,50,50,0.08)', color: '#c05050' }}>
                              {discussError}
                            </div>
                          )}
                        </div>

                        {/* Right: Change plan */}
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Current Change Plan</p>
                          <textarea
                            rows={16}
                            value={activePlan.current_plan}
                            onChange={(e) => handleUpdatePlan(e.target.value)}
                            placeholder="The AI will propose a change plan here after the first message…"
                            className="w-full rounded-xl p-3 resize-none focus:outline-none"
                            style={{
                              background: 'var(--gold-faint)',
                              border: '1.5px solid var(--border-muted)',
                              color: 'var(--text-body)',
                              lineHeight: 1.65,
                              fontSize: 13,
                            }}
                          />
                          <p className="text-xs" style={{ color: 'var(--text-faint)' }}>You can edit this plan directly.</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
                        <button
                          onClick={() => setActiveCommentIdx(Math.max(0, activeCommentIdx - 1))}
                          disabled={activeCommentIdx === 0}
                          className="text-sm font-medium px-4 py-2 rounded-xl"
                          style={{ border: '1px solid var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent', opacity: activeCommentIdx === 0 ? 0.3 : 1 }}
                        >
                          ← Prev
                        </button>
                        <button
                          onClick={handleFinalizeComment}
                          disabled={!activePlan.current_plan.trim() || finalizeLoading || discussLoading}
                          className="rev-btn"
                          style={{
                            background: 'var(--rev-done)', color: '#fff', padding: '10px 28px', borderRadius: 10,
                            opacity: (!activePlan.current_plan.trim() || finalizeLoading || discussLoading) ? 0.4 : 1,
                          }}
                        >
                          {finalizeLoading ? 'Finalizing…' : 'Finalize Comment ✓'}
                        </button>
                        <button
                          onClick={() => setActiveCommentIdx(Math.min(commentPlans.length - 1, activeCommentIdx + 1))}
                          disabled={activeCommentIdx === commentPlans.length - 1}
                          className="text-sm font-medium px-4 py-2 rounded-xl"
                          style={{ border: '1px solid var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent', opacity: activeCommentIdx === commentPlans.length - 1 ? 0.3 : 1 }}
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  )
                )}

                {allFinalized && (
                  <div className="rounded-xl p-4 flex items-center justify-between animate-in"
                    style={{ background: 'var(--rev-done-faint)', border: '1px solid var(--rev-done)' }}>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: 'var(--rev-done)' }}>All {commentPlans.length} comments finalized</p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Ready to generate the revision package</p>
                    </div>
                    <button
                      onClick={() => changeStep('editor')}
                      className="rev-btn"
                      style={{ background: 'var(--rev-done)', color: '#fff', padding: '9px 20px', borderRadius: 10 }}
                    >
                      Editor Review →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 5: Editor Review ──────────────────────────────────────────── */}
        {step === 'editor' && (
          <div className="rev-card animate-in delay-75 space-y-5">
            <div>
              <h2 className="rev-heading">Editor Review</h2>
              <p className="rev-subheading">AI acts as a senior journal editor assessing the quality of your revision before the final response letter.</p>
            </div>

            {!editorialReview && !editorialLoading && (
              <div className="flex items-center gap-4">
                <button
                  onClick={async () => {
                    setEditorialLoading(true);
                    setEditorialError(null);
                    try {
                      const existingRound = rounds.find((r) => r.round_number === activeRound);
                      let opts: Parameters<typeof generateEditorialReview>[1];
                      if (existingRound?.has_revised_article) {
                        opts = { round_number: activeRound, journal_name: journalName };
                      } else {
                        opts = {
                          round_number: activeRound,
                          journal_name: journalName,
                          finalized_plans: commentPlans.filter((p) => p.is_finalized),
                        };
                      }
                      const result = await generateEditorialReview(projectId, opts);
                      setEditorialReview(result);
                    } catch (err: any) {
                      setEditorialError(err?.response?.data?.detail || err?.message || 'Editorial review failed');
                    } finally {
                      setEditorialLoading(false);
                    }
                  }}
                  className="rev-btn"
                  style={{ background: 'var(--rev-accent)', color: '#fff', padding: '10px 24px', borderRadius: 10 }}
                >
                  Generate Editorial Review
                </button>
                <button
                  onClick={() => changeStep('download')}
                  className="rev-btn"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', padding: '10px 24px', borderRadius: 10, border: '1px solid var(--border)' }}
                >
                  Skip to Download →
                </button>
              </div>
            )}

            {editorialLoading && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <LoadingLottie className="w-10 h-10" />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Senior editor is reviewing your revision...</span>
              </div>
            )}

            {editorialError && (
              <div className="rounded-xl p-4" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                <p className="text-sm text-red-700">{editorialError}</p>
                <button
                  onClick={() => { setEditorialError(null); setEditorialReview(null); }}
                  className="mt-2 text-xs text-red-600 underline"
                >Retry</button>
              </div>
            )}

            {editorialReview && (
              <div className="space-y-5">
                {/* Decision badge */}
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Editor Decision:</span>
                  <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                    editorialReview.editor_decision === 'accept'
                      ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                      : editorialReview.editor_decision === 'minor_revision'
                      ? 'bg-amber-100 text-amber-700 border border-amber-200'
                      : 'bg-rose-100 text-rose-700 border border-rose-200'
                  }`}>
                    {editorialReview.editor_decision === 'accept' ? 'Accept' :
                     editorialReview.editor_decision === 'minor_revision' ? 'Minor Revision' : 'Major Revision'}
                  </span>
                </div>

                {/* Overall assessment */}
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Overall Assessment</h3>
                  <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)', lineHeight: '1.7' }}>
                    {editorialReview.overall_assessment}
                  </p>
                </div>

                {/* Praise */}
                {editorialReview.praise.length > 0 && (
                  <div className="rounded-xl p-4" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                    <h3 className="text-sm font-semibold mb-2 text-emerald-700">What You Did Well</h3>
                    <ul className="space-y-1">
                      {editorialReview.praise.map((p, i) => (
                        <li key={i} className="text-sm text-emerald-800 flex gap-2">
                          <span className="shrink-0">+</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Suggestions table */}
                {editorialReview.suggestions.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Editorial Suggestions</h3>
                    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ background: 'var(--bg-secondary)' }}>
                            <th className="text-left p-3 font-medium" style={{ color: 'var(--text-muted)', width: '12%' }}>Category</th>
                            <th className="text-left p-3 font-medium" style={{ color: 'var(--text-muted)', width: '10%' }}>Severity</th>
                            <th className="text-left p-3 font-medium" style={{ color: 'var(--text-muted)', width: '15%' }}>Location</th>
                            <th className="text-left p-3 font-medium" style={{ color: 'var(--text-muted)', width: '30%' }}>Finding</th>
                            <th className="text-left p-3 font-medium" style={{ color: 'var(--text-muted)', width: '33%' }}>Suggestion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {editorialReview.suggestions.map((s, i) => (
                            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                              <td className="p-3">
                                <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                                  {s.category.replace('_', ' ')}
                                </span>
                              </td>
                              <td className="p-3">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                                  s.severity === 'critical' ? 'bg-rose-100 text-rose-700 border-rose-200' :
                                  s.severity === 'important' ? 'bg-amber-100 text-amber-700 border-amber-200' :
                                  'bg-slate-100 text-slate-600 border-slate-200'
                                }`}>
                                  {s.severity}
                                </span>
                              </td>
                              <td className="p-3" style={{ color: 'var(--text-muted)' }}>{s.location}</td>
                              <td className="p-3" style={{ color: 'var(--text-secondary)' }}>{s.finding}</td>
                              <td className="p-3" style={{ color: 'var(--text-primary)' }}>{s.suggestion}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Remaining concerns */}
                {editorialReview.remaining_concerns.length > 0 && (
                  <div className="rounded-xl p-4" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
                    <h3 className="text-sm font-semibold mb-2 text-amber-700">Remaining Concerns</h3>
                    <ul className="space-y-1">
                      {editorialReview.remaining_concerns.map((c, i) => (
                        <li key={i} className="text-sm text-amber-800 flex gap-2">
                          <span className="shrink-0">!</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Proceed to download */}
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={() => changeStep('download')}
                    className="rev-btn"
                    style={{ background: 'var(--rev-done)', color: '#fff', padding: '10px 24px', borderRadius: 10 }}
                  >
                    Proceed to Download →
                  </button>
                  <button
                    onClick={() => { setEditorialReview(null); setEditorialError(null); }}
                    className="rev-btn"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)', padding: '10px 24px', borderRadius: 10, border: '1px solid var(--border)' }}
                  >
                    Re-run Editor Review
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 6: Download ───────────────────────────────────────────────── */}
        {step === 'download' && (
          <div className="rev-card animate-in delay-75 space-y-5">
            <div>
              <h2 className="rev-heading">Download Documents</h2>
              <p className="rev-subheading">Generate and download the complete revision package for journal submission.</p>
            </div>

            {!allFinalized && commentPlans.length > 0 && (
              <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--rev-accent-faint)', border: '1px solid var(--rev-accent-ring)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--rev-accent)' }}>
                  {commentPlans.length - finalizedCount} comment{commentPlans.length - finalizedCount !== 1 ? 's' : ''} still need to be finalized.
                </p>
                <div className="flex flex-wrap gap-2">
                  {commentPlans.filter((p) => !p.is_finalized).map((p) => {
                    const idx = commentPlans.indexOf(p);
                    return (
                      <button
                        key={`${p.reviewer_number}-${p.comment_number}`}
                        onClick={() => { setActiveCommentIdx(idx); changeStep('responses'); }}
                        style={{ color: 'var(--rev-accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', textUnderlineOffset: 3 }}
                      >
                        R{p.reviewer_number} C{p.comment_number}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {allFinalized && (
              <div className="space-y-3">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {roundForDownload
                    ? `Round ${activeRound} documents already exist. Generate again to replace with fresh documents from the current finalized changes.`
                    : `All ${commentPlans.length} comments finalized. Generate the complete revision package.`}
                </p>
                <button
                  onClick={handleGenerateFromPlans}
                  disabled={generateLoading}
                  className="rev-btn"
                  style={{ background: 'var(--gold)', color: '#fff', padding: '11px 28px', opacity: generateLoading ? 0.5 : 1 }}
                >
                  {generateLoading
                    ? '⚙ Generating…'
                    : roundForDownload
                      ? `Regenerate Documents (Round ${activeRound})`
                      : `Generate Documents — ${commentPlans.length} Change${commentPlans.length !== 1 ? 's' : ''}`}
                </button>
                {generateLoading && (
                  <div className="flex flex-col items-center py-8 gap-3" style={{ color: 'var(--text-muted)' }}>
                    <LoadingLottie className="w-12 h-12" />
                    <p className="text-sm">Applying changes and building revision package… this may take 1–2 minutes.</p>
                  </div>
                )}
                {generateError && (
                  <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(200,50,50,0.08)', border: '1px solid rgba(200,50,50,0.2)', color: '#c05050' }}>
                    {generateError}
                  </div>
                )}
              </div>
            )}

            {roundForDownload && (
              <div className="space-y-4 animate-in">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Round {activeRound} revision package ready.</p>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  <a href={downloadPointByPointDocx(projectId, activeRound)} download className="rev-dl-tile rev-dl-tile--reply">
                    <div className="rev-dl-icon" style={{ background: 'var(--gold-faint)' }}>📄</div>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>Point-by-Point Reply</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Comment + Response + Plan</p>
                      <p className="text-[10px] mt-1.5 font-semibold" style={{ color: 'var(--gold)' }}>.docx</p>
                    </div>
                  </a>
                  <a href={downloadRevisedManuscriptDocx(projectId, activeRound)} download className="rev-dl-tile rev-dl-tile--clean">
                    <div className="rev-dl-icon" style={{ background: 'var(--rev-done-faint)' }}>📝</div>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>Revised Manuscript</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Clean version</p>
                      <p className="text-[10px] mt-1.5 font-semibold" style={{ color: 'var(--rev-done)' }}>.docx</p>
                    </div>
                  </a>
                  <a href={downloadRevisedManuscriptPdf(projectId, activeRound)} download className="rev-dl-tile rev-dl-tile--pdf">
                    <div className="rev-dl-icon" style={{ background: 'rgba(14,116,144,0.08)' }}>📑</div>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>Line-Numbered PDF</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Revised manuscript</p>
                      <p className="text-[10px] mt-1.5 font-semibold" style={{ color: '#0e7490' }}>.pdf</p>
                    </div>
                  </a>
                  <a href={downloadTrackChangesDocx(projectId, activeRound)} download className="rev-dl-tile rev-dl-tile--track">
                    <div className="rev-dl-icon" style={{ background: 'rgba(109,40,217,0.08)' }}>🔍</div>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--text-bright)' }}>Track Changes</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Inline tracked changes</p>
                      <p className="text-[10px] mt-1.5 font-semibold" style={{ color: '#7c3aed' }}>.docx</p>
                    </div>
                  </a>
                </div>
                <p className="text-xs text-center" style={{ color: 'var(--text-faint)' }}>
                  Submit the point-by-point reply, clean manuscript, track-changes version, and line-numbered PDF for complete resubmission.
                </p>
              </div>
            )}

            <div className="pt-2" style={{ borderTop: '1px solid var(--border-faint)' }}>
              <button
                onClick={handleNewRound}
                className="text-sm font-medium px-5 py-2 rounded-xl"
                style={{ border: '1.5px dashed var(--border-muted)', color: 'var(--text-secondary)', background: 'transparent' }}
              >
                + Start Round {activeRound + 1}
              </button>
            </div>
          </div>
        )}

      </div>

      {/* ── Author Name Dialog ──────────────────────────────────────────────── */}
      {showAuthorDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 w-full max-w-sm mx-4 space-y-4 animate-in"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-muted)', boxShadow: '0 24px 60px rgba(0,0,0,0.35)' }}>
            <div>
              <h3 style={{ fontFamily: "Newsreader, Georgia, serif", fontWeight: 600, fontSize: '1.35rem', color: 'var(--text-bright)', letterSpacing: '-0.02em' }}>
                Author Name
              </h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                This name appears as the change author in Word's track changes.
              </p>
            </div>
            <input
              type="text"
              value={trackChangesAuthor}
              onChange={(e) => setTrackChangesAuthor(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ background: 'var(--bg-base)', border: '1.5px solid var(--border-muted)', color: 'var(--text-body)' }}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleGenerateAllDocs(); }}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowAuthorDialog(false)}
                style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateAllDocs}
                className="rev-btn"
                style={{ background: 'var(--gold)', color: '#fff', padding: '8px 20px', borderRadius: 10 }}
              >
                Generate Documents
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
