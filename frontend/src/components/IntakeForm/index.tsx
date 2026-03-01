import { useState } from 'react';
import type { ArticleMode, WritingType, IntentResponse } from '../../types/intent';
import { submitIntent } from '../../api/client';
import LoadingLottie from '../LoadingLottie';
import StepIndicator from './StepIndicator';
import StepOne from './StepOne';
import StepTwo from './StepTwo';
import StepThree from './StepThree';

const STEP_LABELS = ['Mode', 'Article Type', 'Key Idea'];
const TOTAL_STEPS = 3;

type FormState = {
  mode: ArticleMode | null;
  writing_type: WritingType | null;
  key_idea: string;
  project_description: string;
};

interface Props {
  onComplete: (keyIdea: string, writingType: WritingType, projectDescription?: string) => void;
}

export default function IntakeForm({ onComplete }: Props) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>({
    mode: null,
    writing_type: null,
    key_idea: '',
    project_description: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntentResponse | null>(null);

  // ── Validation per step ──────────────────────────────────────────────────
  function canAdvance(): boolean {
    if (step === 1) return form.mode !== null;
    if (step === 2) return form.writing_type !== null;
    if (step === 3) return form.key_idea.trim().length >= 10;
    return false;
  }

  function handleNext() {
    if (canAdvance() && step < TOTAL_STEPS) setStep((s) => s + 1);
  }

  function handleBack() {
    if (step > 1) setStep((s) => s - 1);
    setError(null);
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  async function handleSubmit() {
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

  // ── Success screen ───────────────────────────────────────────────────────
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

        {/* Primary CTA — transition to Phase 2 */}
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
            setForm({ mode: null, writing_type: null, key_idea: '', project_description: '' });
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
      <StepIndicator currentStep={step} totalSteps={TOTAL_STEPS} labels={STEP_LABELS} />

      <div className="min-h-[340px]">
        {step === 1 && (
          <StepOne value={form.mode} onChange={(mode) => setForm((f) => ({ ...f, mode }))} />
        )}
        {step === 2 && (
          <StepTwo
            value={form.writing_type}
            onChange={(writing_type) => setForm((f) => ({ ...f, writing_type }))}
          />
        )}
        {step === 3 && (
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
            ) : (
              'Begin Pipeline →'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
