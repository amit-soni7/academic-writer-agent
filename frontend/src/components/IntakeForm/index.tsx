import { useRef, useState } from 'react';
import type { ArticleMode, WritingType } from '../../types/intent';
import type { RevisionIntakeData } from '../../types/paper';
import { submitIntent } from '../../api/client';
import LoadingLottie from '../LoadingLottie';
import StepIndicator from './StepIndicator';
import StepOne from './StepOne';
import StepTwoRevision from './StepTwoRevision';

// SR article types (routed to SR pipeline instead of novel)
const SR_TYPES: WritingType[] = ['systematic_review', 'meta_analysis', 'scoping_review'];

// ── Article type groups (Stage 2) ─────────────────────────────────────────────

const TYPE_GROUPS: { group: string; types: { value: WritingType; label: string; hint: string }[] }[] = [
  {
    group: 'Primary Research',
    types: [
      { value: 'original_research', label: 'Original Research',    hint: 'IMRAD structure • novel data' },
      { value: 'case_report',       label: 'Case Report',          hint: 'CARE guidelines' },
      { value: 'brief_report',      label: 'Brief / Short Report', hint: 'Focused findings' },
    ],
  },
  {
    group: 'Reviews',
    types: [
      { value: 'narrative_review',  label: 'Narrative Review',     hint: 'Thematic synthesis' },
      { value: 'systematic_review', label: 'Systematic Review',    hint: 'PRISMA 2020 • PICO' },
      { value: 'scoping_review',    label: 'Scoping Review',       hint: 'PRISMA-ScR • PCC' },
      { value: 'meta_analysis',     label: 'Meta-Analysis',        hint: 'Statistical pooling' },
    ],
  },
  {
    group: 'Commentary',
    types: [
      { value: 'opinion',   label: 'Opinion / Commentary', hint: 'Expert perspective' },
      { value: 'editorial', label: 'Editorial',             hint: 'Field-level commentary' },
      { value: 'letter',    label: 'Letter to Editor',      hint: '400–600 words' },
    ],
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SRIntakeCompleteData {
  keyIdea: string;
  writingType: WritingType;
  projectDescription?: string;
}

interface Props {
  onComplete: (keyIdea: string, writingType: WritingType, projectDescription?: string) => void;
  onCompleteRevision?: (data: RevisionIntakeData) => void;
  onCompleteSR?: (data: SRIntakeCompleteData) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IntakeForm({ onComplete, onCompleteRevision, onCompleteSR }: Props) {
  const [step, setStep] = useState(1);

  // Stage 1
  const [mode, setMode] = useState<ArticleMode | null>(null);
  // Stage 2
  const [writingType, setWritingType] = useState<WritingType | null>(null);
  // Stage 3 — novel/SR content
  const [keyIdea, setKeyIdea] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const keyIdeaFileRef = useRef<HTMLInputElement>(null);
  const [keyIdeaFileName, setKeyIdeaFileName] = useState('');
  const refFileRef = useRef<HTMLInputElement>(null);
  const [refFiles, setRefFiles] = useState<File[]>([]);
  // Stage 3 — revision
  const [manuscriptText, setManuscriptText] = useState('');
  const [manuscriptFile, setManuscriptFile] = useState<File | null>(null);
  const [reviewerCommentsText, setReviewerCommentsText] = useState('');
  const [reviewerCommentsFile, setReviewerCommentsFile] = useState<File | null>(null);
  const [journalName, setJournalName] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRevision = mode === 'revision';
  const isSR = !isRevision && writingType !== null && SR_TYPES.includes(writingType);

  // Step labels — same structure for both modes
  const stepLabels = ['What are you working on?', 'Article type', isRevision ? 'Manuscript & Comments' : 'Key idea'];

  // ── Validation ───────────────────────────────────────────────────────────
  function canAdvance(): boolean {
    if (step === 1) return mode !== null;
    if (step === 2) return writingType !== null; // both modes require article type
    if (step === 3) {
      if (isRevision) {
        return (
          (manuscriptFile !== null || manuscriptText.trim().length > 0) &&
          (reviewerCommentsFile !== null || reviewerCommentsText.trim().length > 0)
        );
      }
      return keyIdea.trim().length >= 10 || keyIdeaFileName !== '';
    }
    return false;
  }

  function handleNext() {
    if (!canAdvance()) return;
    setStep((s) => s + 1);
  }

  function handleBack() {
    if (step > 1) {
      setStep((s) => s - 1);
      setError(null);
    }
  }

  function handleStepClick(s: number) {
    if (s < step) {
      setStep(s);
      setError(null);
    }
  }

  // ── File handlers ────────────────────────────────────────────────────────
  async function handleKeyIdeaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setKeyIdeaFileName(file.name);
    let text = '';
    if (file.name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      text = result.value;
    } else {
      text = await file.text();
    }
    setKeyIdea(text.slice(0, 8000));
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!canAdvance()) return;

    if (isRevision) {
      if (!onCompleteRevision) return;
      onCompleteRevision({
        manuscript_text: manuscriptText,
        manuscript_file: manuscriptFile,
        reviewer_comments_text: reviewerCommentsText,
        reviewer_comments_file: reviewerCommentsFile,
        journal_name: journalName,
        project_name: '',
        project_description: additionalContext,
      });
      return;
    }

    if (isSR) {
      if (!onCompleteSR || !writingType) return;
      onCompleteSR({
        keyIdea: keyIdea.trim(),
        writingType,
        projectDescription: additionalContext || undefined,
      });
      return;
    }

    if (!writingType) return;
    setIsLoading(true);
    setError(null);
    try {
      await submitIntent({ mode: 'novel', writing_type: writingType, key_idea: keyIdea.trim() });
      onComplete(keyIdea.trim(), writingType, additionalContext || undefined);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to connect to the backend. Is the server running on port 8010?');
    } finally {
      setIsLoading(false);
    }
  }

  function handleModeSelect(m: ArticleMode) {
    setMode(m);
    setWritingType(null); // reset type when mode changes
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div>
      <StepIndicator
        currentStep={step}
        totalSteps={3}
        labels={stepLabels}
        onStepClick={handleStepClick}
      />

      <div className="min-h-[340px]">

        {/* Stage 1: Mode */}
        {step === 1 && (
          <StepOne mode={mode} onSelect={handleModeSelect} />
        )}

        {/* Stage 2: Article type — same for both novel and revision */}
        {step === 2 && (
          <ArticleTypeStep writingType={writingType} onSelect={setWritingType} />
        )}

        {/* Stage 3: Revision — Manuscript & Comments */}
        {step === 3 && isRevision && (
          <StepTwoRevision
            manuscriptText={manuscriptText}
            onManuscriptTextChange={setManuscriptText}
            manuscriptFile={manuscriptFile}
            onManuscriptFileChange={setManuscriptFile}
            reviewerCommentsText={reviewerCommentsText}
            onReviewerCommentsTextChange={setReviewerCommentsText}
            reviewerCommentsFile={reviewerCommentsFile}
            onReviewerCommentsFileChange={setReviewerCommentsFile}
            journalName={journalName}
            onJournalNameChange={setJournalName}
          />
        )}

        {/* Stage 3: Novel / SR — Key idea + references */}
        {step === 3 && !isRevision && (
          <ContentStep
            writingType={writingType}
            isSR={isSR}
            keyIdea={keyIdea}
            onKeyIdeaChange={setKeyIdea}
            keyIdeaFileName={keyIdeaFileName}
            keyIdeaFileRef={keyIdeaFileRef}
            onKeyIdeaFile={handleKeyIdeaFile}
            additionalContext={additionalContext}
            onAdditionalContextChange={setAdditionalContext}
            refFiles={refFiles}
            refFileRef={refFileRef}
            onRefFiles={setRefFiles}
          />
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border p-4 text-sm fade-in"
          style={{ background: 'rgba(214,84,84,0.1)', borderColor: 'rgba(214,84,84,0.35)', color: '#e88080' }}>
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={handleBack}
          disabled={step === 1}
          className="px-5 py-2.5 rounded-lg text-sm font-medium text-slate-500 hover:text-slate-700
            hover:bg-slate-200 disabled:opacity-0 disabled:pointer-events-none transition-all"
        >
          ← Back
        </button>

        {/* Final step */}
        {step === 3 ? (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canAdvance() || isLoading}
            className="btn-primary inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm
              focus:outline-none disabled:opacity-40"
          >
            {isLoading ? (
              <><LoadingLottie className="w-5 h-5" /> Submitting…</>
            ) : isRevision ? (
              'Start Revision →'
            ) : isSR ? (
              'Begin Review →'
            ) : (
              'Begin Pipeline →'
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleNext}
            disabled={!canAdvance()}
            className="btn-primary px-6 py-2.5 rounded-lg text-sm focus:outline-none disabled:opacity-40"
          >
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}

// ── Stage 2: Article type picker ─────────────────────────────────────────────

function ArticleTypeStep({
  writingType,
  onSelect,
}: {
  writingType: WritingType | null;
  onSelect: (wt: WritingType) => void;
}) {
  return (
    <div>
      <h2
        className="text-2xl font-light mb-1 leading-snug"
        style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--text-bright)' }}
      >
        What type of article?
      </h2>
      <p className="text-sm text-slate-500 mb-6 leading-relaxed">
        Choose the article type to tailor the structure and guidelines.
      </p>

      <div className="space-y-4">
        {TYPE_GROUPS.map(({ group, types }) => (
          <div key={group}>
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-2">{group}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {types.map((t) => {
                const isSel = writingType === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => onSelect(t.value)}
                    className={`text-left px-3 py-2.5 rounded-lg border text-xs transition-all focus:outline-none ${
                      isSel
                        ? 'border-amber-400/70 bg-amber-50/40 font-semibold'
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                    style={isSel
                      ? { color: 'var(--gold-light)', boxShadow: '0 0 0 1px var(--gold)' }
                      : { color: 'var(--text-body)' }}
                  >
                    <span className="block">{t.label}</span>
                    <span className="block text-[10px] text-slate-400 font-normal mt-0.5">{t.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stage 3: Content step (novel + SR) ───────────────────────────────────────

const SR_TYPE_LABELS: Record<string, string> = {
  systematic_review: 'Systematic Review',
  scoping_review: 'Scoping Review',
  meta_analysis: 'Meta-Analysis',
};

function ContentStep({
  writingType, isSR,
  keyIdea, onKeyIdeaChange,
  keyIdeaFileName, keyIdeaFileRef, onKeyIdeaFile,
  additionalContext, onAdditionalContextChange,
  refFiles, refFileRef, onRefFiles,
}: {
  writingType: WritingType | null;
  isSR: boolean;
  keyIdea: string;
  onKeyIdeaChange: (v: string) => void;
  keyIdeaFileName: string;
  keyIdeaFileRef: React.RefObject<HTMLInputElement | null>;
  onKeyIdeaFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  additionalContext: string;
  onAdditionalContextChange: (v: string) => void;
  refFiles: File[];
  refFileRef: React.RefObject<HTMLInputElement | null>;
  onRefFiles: (files: File[]) => void;
}) {
  const mainLabel = isSR
    ? `Describe your ${writingType ? (SR_TYPE_LABELS[writingType] ?? 'review') : 'review'} question`
    : 'Describe your key idea';

  const mainPlaceholder = isSR
    ? (writingType === 'scoping_review'
      ? 'e.g. "What interventions have been used for anxiety in adolescents?" — or paste a protocol excerpt'
      : writingType === 'meta_analysis'
      ? 'e.g. "Does metformin reduce HbA1c in type 2 diabetes vs placebo?" — or paste a protocol excerpt'
      : 'e.g. "What is the effect of mindfulness on anxiety in adults with chronic illness?" — or paste a protocol excerpt')
    : 'e.g. The effect of intermittent fasting on metabolic markers in overweight adults with pre-diabetes…';

  const mainHint = isSR
    ? 'A sentence or two is enough. You will refine PICO, eligibility criteria, and extraction schema in the Protocol Builder.'
    : 'State your central research question or argument. The AI will use this to guide literature search and manuscript structure.';

  return (
    <div className="space-y-5">
      <h2
        className="text-2xl font-light mb-1 leading-snug"
        style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--text-bright)' }}
      >
        {mainLabel}
      </h2>
      <p className="text-sm text-slate-500 leading-relaxed">{mainHint}</p>

      {writingType && (
        <div
          className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full"
          style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}
        >
          {SR_TYPE_LABELS[writingType] ?? writingType.replace(/_/g, ' ')}
        </div>
      )}

      {/* Main textarea */}
      <div>
        <textarea
          rows={isSR ? 5 : 4}
          value={keyIdea}
          onChange={(e) => onKeyIdeaChange(e.target.value)}
          placeholder={mainPlaceholder}
          className="w-full text-sm border rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-amber-400/40"
          style={{
            borderColor: 'var(--border-muted)',
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            minHeight: '110px',
          }}
          autoFocus
        />

        {/* Upload docx */}
        <div className="flex items-center gap-3 mt-2">
          <button
            type="button"
            onClick={() => keyIdeaFileRef.current?.click()}
            className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5
              transition-colors flex items-center gap-1.5"
            style={{ background: 'var(--bg-base)' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {keyIdeaFileName ? keyIdeaFileName : 'Upload .txt / .docx'}
          </button>
          <input ref={keyIdeaFileRef} type="file" accept=".txt,.md,.docx,.pdf"
            className="hidden" onChange={onKeyIdeaFile} />
          {keyIdeaFileName && (
            <span className="text-[10px] text-emerald-600 font-mono">✓ file loaded into text above</span>
          )}
        </div>
      </div>

      {/* Reference papers */}
      <div>
        <label className="block text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">
          Reference Papers {isSR ? <span className="text-amber-600 font-normal normal-case tracking-normal">(important for reviews — these will be included by default)</span> : '(optional)'}
        </label>
        <p className="text-[10px] text-slate-400 mb-2 leading-relaxed">
          {isSR
            ? 'Upload key papers you know should be included. These seed the protocol, search strategy, and extraction schema.'
            : 'Upload papers relevant to your article — they will be used to inform the literature search.'}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => refFileRef.current?.click()}
            className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1.5
              transition-colors flex items-center gap-1.5"
            style={{ background: 'var(--bg-base)' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 4v16m8-8H4" />
            </svg>
            Add papers (.pdf, .docx, .txt)
          </button>
          <input ref={refFileRef} type="file" accept=".pdf,.docx,.txt" multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              onRefFiles([...refFiles, ...files]);
            }}
          />
          {refFiles.length > 0 && (
            <span className="text-[10px] text-slate-500 font-mono">{refFiles.length} file{refFiles.length > 1 ? 's' : ''} added</span>
          )}
        </div>
        {refFiles.length > 0 && (
          <div className="mt-2 space-y-1">
            {refFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                <span className="text-[10px] font-mono text-slate-300">PDF</span>
                <span className="flex-1 truncate">{f.name}</span>
                <button type="button" onClick={() => onRefFiles(refFiles.filter((_, j) => j !== i))}
                  className="text-slate-300 hover:text-rose-500 transition-colors">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Additional context */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">Additional context (optional)</label>
        <textarea
          rows={2}
          value={additionalContext}
          onChange={(e) => onAdditionalContextChange(e.target.value)}
          placeholder="Target journal, specific angle, constraints, or any other information for the AI…"
          className="w-full text-sm border rounded-xl px-4 py-2 resize-none focus:outline-none"
          style={{
            borderColor: 'var(--border-muted)',
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
          }}
        />
      </div>
    </div>
  );
}
