import { useState } from 'react';
import type { ArticleMode, WritingType, IntentResponse } from '../../types/intent';
import type { RevisionIntakeData } from '../../types/paper';
import { submitIntent } from '../../api/client';
import LoadingLottie from '../LoadingLottie';
import StepIndicator from './StepIndicator';
import StepOne from './StepOne';
import StepTwo from './StepTwo';
import StepTwoRevision from './StepTwoRevision';
import StepThree from './StepThree';
import StepThreeRevision from './StepThreeRevision';

const STEP_LABELS_WRITE    = ['Mode', 'Article Type', 'Key Idea'];
const STEP_LABELS_REVISION = ['Mode', 'Manuscript & Comments', 'Journal & Project'];
const TOTAL_STEPS = 3;

type FormState = {
  mode: ArticleMode | null;
  writing_type: WritingType | null;
  key_idea: string;
  project_description: string;
  // Revision fields
  manuscript_text: string;
  manuscript_file: File | null;
  reviewer_comments_text: string;
  reviewer_comments_file: File | null;
  journal_name: string;
  project_name: string;
};

interface Props {
  onComplete: (keyIdea: string, writingType: WritingType, projectDescription?: string) => void;
  onCompleteRevision?: (data: RevisionIntakeData) => void;
}

export default function IntakeForm({ onComplete, onCompleteRevision }: Props) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>({
    mode: null,
    writing_type: null,
    key_idea: '',
    project_description: '',
    manuscript_text: '',
    manuscript_file: null,
    reviewer_comments_text: '',
    reviewer_comments_file: null,
    journal_name: '',
    project_name: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntentResponse | null>(null);

  const isRevision = form.mode === 'revision';
  const stepLabels = isRevision ? STEP_LABELS_REVISION : STEP_LABELS_WRITE;

  // ── Validation per step ──────────────────────────────────────────────────
  function canAdvance(): boolean {
    if (step === 1) return form.mode !== null;
    if (step === 2) {
      if (isRevision) {
        const hasManuscript = form.manuscript_file !== null || form.manuscript_text.trim().length > 0;
        const hasComments   = form.reviewer_comments_file !== null || form.reviewer_comments_text.trim().length > 0;
        return hasManuscript && hasComments;
      }
      return form.writing_type !== null;
    }
    if (step === 3) {
      if (isRevision) return form.project_name.trim().length > 0;
      return form.key_idea.trim().length >= 10;
    }
    return false;
  }

  function handleNext() {
    if (canAdvance() && step < TOTAL_STEPS) setStep((s) => s + 1);
  }

  function handleBack() {
    if (step > 1) setStep((s) => s - 1);
    setError(null);
  }

  // ── Submit (novel) ───────────────────────────────────────────────────────
  async function handleSubmit() {
    if (isRevision) {
      handleSubmitRevision();
      return;
    }
    if (!form.mode || !form.writing_type || form.key_idea.trim().length < 10) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await submitIntent({
        mode: form.mode,
        writing_type: form.writing_type,
        key_idea: form.key_idea.trim(),
      });
      setResult(response);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to the backend. Is the server running on port 8010?';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Submit (revision) ────────────────────────────────────────────────────
  function handleSubmitRevision() {
    if (!onCompleteRevision || !form.project_name.trim()) return;
    onCompleteRevision({
      manuscript_text: form.manuscript_text,
      manuscript_file: form.manuscript_file,
      reviewer_comments_text: form.reviewer_comments_text,
      reviewer_comments_file: form.reviewer_comments_file,
      journal_name: form.journal_name,
      project_name: form.project_name.trim(),
      project_description: form.project_description,
    });
  }

  // ── Success screen (novel only) ───────────────────────────────────────────
  if (result) {
    return (
      <div className="text-center py-6">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-slate-800 mb-2">Intent Captured</h2>
        <p className="text-slate-500 text-sm mb-6 max-w-sm mx-auto">{result.message}</p>

        <div className="text-left bg-slate-50 border border-slate-200 rounded-xl p-5 mb-6 space-y-3">
          {[
            { label: 'Mode', value: result.received.mode },
            { label: 'Type', value: result.received.writing_type.replace(/_/g, ' ') },
            { label: 'Key Idea', value: result.received.key_idea },
          ].map(({ label, value }) => (
            <div key={label}>
              <span className="block text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
              <span className="block text-sm text-slate-700 capitalize mt-0.5">{value}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => onComplete(result.received.key_idea, result.received.writing_type, form.project_description || undefined)}
          className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl
            text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 transition-all
            focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 mb-3"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          Search Literature →
        </button>

        <button
          onClick={() => {
            setResult(null);
            setStep(1);
            setForm({ mode: null, writing_type: null, key_idea: '', project_description: '',
              manuscript_text: '', manuscript_file: null, reviewer_comments_text: '',
              reviewer_comments_file: null, journal_name: '', project_name: '' });
          }}
          className="text-sm text-slate-400 hover:text-slate-600 font-medium underline underline-offset-2"
        >
          Start over
        </button>
      </div>
    );
  }

  // ── Form steps ───────────────────────────────────────────────────────────
  return (
    <div>
      <StepIndicator currentStep={step} totalSteps={TOTAL_STEPS} labels={stepLabels} />

      <div className="min-h-[340px]">
        {step === 1 && (
          <StepOne value={form.mode} onChange={(mode) => setForm((f) => ({ ...f, mode }))} />
        )}

        {step === 2 && isRevision && (
          <StepTwoRevision
            manuscriptText={form.manuscript_text}
            onManuscriptTextChange={(t) => setForm((f) => ({ ...f, manuscript_text: t }))}
            manuscriptFile={form.manuscript_file}
            onManuscriptFileChange={(file) => setForm((f) => ({ ...f, manuscript_file: file }))}
            reviewerCommentsText={form.reviewer_comments_text}
            onReviewerCommentsTextChange={(t) => setForm((f) => ({ ...f, reviewer_comments_text: t }))}
            reviewerCommentsFile={form.reviewer_comments_file}
            onReviewerCommentsFileChange={(file) => setForm((f) => ({ ...f, reviewer_comments_file: file }))}
            journalName={form.journal_name}
            onJournalNameChange={(n) => setForm((f) => ({ ...f, journal_name: n }))}
          />
        )}

        {step === 2 && !isRevision && (
          <StepTwo
            value={form.writing_type}
            onChange={(writing_type) => setForm((f) => ({ ...f, writing_type }))}
          />
        )}

        {step === 3 && isRevision && (
          <StepThreeRevision
            journalName={form.journal_name}
            manuscriptText={form.manuscript_text}
            projectName={form.project_name}
            onProjectNameChange={(n) => setForm((f) => ({ ...f, project_name: n }))}
            projectDescription={form.project_description}
            onProjectDescriptionChange={(d) => setForm((f) => ({ ...f, project_description: d }))}
          />
        )}

        {step === 3 && !isRevision && (
          <StepThree
            value={form.key_idea}
            onChange={(key_idea) => setForm((f) => ({ ...f, key_idea }))}
            description={form.project_description}
            onDescriptionChange={(project_description) => setForm((f) => ({ ...f, project_description }))}
          />
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">
          <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {/* Navigation */}
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={handleBack}
          disabled={step === 1}
          className="px-5 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:text-slate-800
            hover:bg-slate-100 disabled:opacity-0 disabled:pointer-events-none transition-all"
        >
          ← Back
        </button>

        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={handleNext}
            disabled={!canAdvance()}
            className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white bg-brand-600
              hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed
              transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Continue →
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canAdvance() || isLoading}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold
              text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed
              transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            {isLoading ? (
              <>
                <LoadingLottie className="w-5 h-5" />
                Submitting…
              </>
            ) : isRevision ? (
              'Start Revision →'
            ) : (
              'Begin Pipeline →'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
