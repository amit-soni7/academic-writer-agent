/**
 * SRPICOWizard — AI-assisted PICO wizard used inside IntakeForm Step 3
 * when article type is systematic_review or meta_analysis.
 *
 * Step 0  : User states research question (or uploads protocol) → AI fills everything
 * Sub-steps 1–4: Review/edit pre-filled PICO → Criteria → Schema → Registries
 */

import { useRef, useState } from 'react';
import { parsePicoFromText, type PicoData, type SchemaField } from '../../api/sr';

export interface SRData {
  pico: PicoData;
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  extractionSchema: SchemaField[];
}

interface Props {
  onComplete: (data: SRData) => void;
  articleType?: string;
}

const STUDY_DESIGNS = [
  'RCT', 'Quasi-experimental', 'Cohort', 'Case-control',
  'Cross-sectional', 'Case series', 'Mixed methods', 'Any',
];

const DEFAULT_INCLUSION = [
  'Human participants',
  'Original research (not reviews or protocols)',
  'Peer-reviewed publications',
];
const DEFAULT_EXCLUSION = [
  'Animal studies',
  'Non-English without translation',
  'Conference abstracts without full text',
];
const DEFAULT_SCHEMA_FIELDS: SchemaField[] = [
  { field: 'study_design', type: 'text', required: true, description: 'RCT, cohort, cross-sectional, etc.', section: 'Methods' },
  { field: 'sample_size', type: 'number', required: true, description: 'Total N analysed', section: 'Participants' },
  { field: 'population_description', type: 'text', required: true, description: 'Key participant characteristics', section: 'Participants' },
  { field: 'intervention_description', type: 'text', required: true, description: 'Name, dose, delivery, duration', section: 'Interventions' },
  { field: 'comparator_description', type: 'text', required: false, description: 'Control group description', section: 'Interventions' },
  { field: 'primary_outcomes', type: 'list', required: true, description: 'List primary outcomes with measurement tools', section: 'Outcomes' },
  { field: 'effect_sizes', type: 'list', required: false, description: 'OR/RR/MD/SMD/HR with 95% CI', section: 'Results' },
  { field: 'follow_up_duration', type: 'text', required: false, description: 'Total follow-up period', section: 'Methods' },
  { field: 'country', type: 'text', required: false, description: 'Country where study was conducted', section: 'Methods' },
  { field: 'funding_source', type: 'text', required: false, description: 'Industry, government, none declared', section: 'Methods' },
];

const TEMPLATE_LABELS: Record<string, string> = {
  rct: 'Cochrane RCT template',
  observational: 'Cochrane Observational template',
  diagnostic: 'QUADAS-2 Diagnostic template',
  qualitative: 'JBI Qualitative template',
  prevalence: 'JBI Prevalence template',
  case_report: 'JBI Case Report template',
};

const REVIEW_TYPE = {
  systematic_review: 'systematic_review',
  meta_analysis: 'meta_analysis',
  scoping_review: 'scoping_review',
  narrative_review: 'narrative_review',
};

export default function SRPICOWizard({ onComplete, articleType }: Props) {
  const reviewType = (REVIEW_TYPE[articleType as keyof typeof REVIEW_TYPE] ?? 'systematic_review') as string;

  // ── Step 0 state ──────────────────────────────────────────────────────────
  const [researchQuestion, setResearchQuestion] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── AI result metadata ───────────────────────────────────────────────────
  const [aiMeta, setAiMeta] = useState<{
    question_type: string;
    framework: string;
    schema_template: string;
    review_title: string;
    review_objective: string;
    review_question: string;
    alternative_phrasings: string[];
    methodological_cautions: string;
  } | null>(null);

  // ── Sub-step state (1–4) ─────────────────────────────────────────────────
  const [subStep, setSubStep] = useState(0); // 0 = AI input screen
  const [pico, setPico] = useState<PicoData>({
    population: '',
    intervention: '',
    comparator: '',
    outcome: '',
    study_design: '',
    date_from: '2000-01-01',
    date_to: '',
    language_restriction: 'No restriction',
    review_type: reviewType,
    health_area: '',
    target_registries: [],
  });
  const [inclusionCriteria, setInclusionCriteria] = useState<string[]>(DEFAULT_INCLUSION);
  const [exclusionCriteria, setExclusionCriteria] = useState<string[]>(DEFAULT_EXCLUSION);
  const [newIC, setNewIC] = useState('');
  const [newEC, setNewEC] = useState('');
  const [schemaFields, setSchemaFields] = useState(DEFAULT_SCHEMA_FIELDS);
  const [newField, setNewField] = useState<SchemaField>({ field: '', type: 'text', required: false, description: '', section: 'General' });

  const subStepLabels = ['PICO', 'Criteria', 'Schema', 'Registries'];

  // ── File upload handler ───────────────────────────────────────────────────
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setResearchQuestion(text.slice(0, 6000));
  }

  // ── AI parse ─────────────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!researchQuestion.trim()) return;
    setParsing(true);
    setParseError('');
    try {
      const result = await parsePicoFromText(researchQuestion, reviewType);
      if (result.error && !result.pico.population) {
        setParseError('AI could not parse the text. Please check your input or try rephrasing.');
        return;
      }
      setPico({ ...result.pico, review_type: reviewType });
      if (result.inclusion_criteria?.length) setInclusionCriteria(result.inclusion_criteria);
      if (result.exclusion_criteria?.length) setExclusionCriteria(result.exclusion_criteria);
      if (result.extraction_schema?.length) setSchemaFields(result.extraction_schema);
      setAiMeta({
        question_type: result.question_type || 'effectiveness',
        framework: result.framework || 'PICO',
        schema_template: result.schema_template || 'rct',
        review_title: result.review_title || '',
        review_objective: result.review_objective || '',
        review_question: result.review_question || '',
        alternative_phrasings: result.alternative_phrasings || [],
        methodological_cautions: result.methodological_cautions || '',
      });
      setSubStep(1);
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : 'Failed to contact AI. Please try again.');
    } finally {
      setParsing(false);
    }
  }

  function canAdvanceSub(): boolean {
    if (subStep === 1) return !!(pico.population && pico.intervention && pico.outcome);
    if (subStep === 2) return inclusionCriteria.length > 0;
    if (subStep === 3) return schemaFields.length > 0;
    return true;
  }

  function handleFinish() {
    onComplete({
      pico,
      inclusionCriteria,
      exclusionCriteria,
      extractionSchema: schemaFields,
    });
  }

  // ── Step 0: Research question input ──────────────────────────────────────
  if (subStep === 0) {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-xs text-slate-500 mb-1 font-mono uppercase tracking-wider">Research Question</p>
          <h3 className="text-sm font-medium text-slate-700 mb-1">
            Describe your research question or paste your protocol
          </h3>
          <p className="text-xs text-slate-400 mb-3">
            Write your key idea in plain language — AI will extract the PICO, set inclusion/exclusion criteria,
            and suggest a data extraction schema. You'll review and edit everything before launching.
          </p>
          <textarea
            rows={6}
            value={researchQuestion}
            onChange={(e) => setResearchQuestion(e.target.value)}
            placeholder={
              'e.g., "Does cognitive behavioural therapy reduce depression severity in adults with major depressive disorder compared to usual care?"\n\nOr paste a full protocol excerpt — AI will handle the rest.'
            }
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 resize-none
              focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 leading-relaxed"
            style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
            autoFocus
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-2
              transition-colors flex items-center gap-1.5"
            style={{ background: 'var(--bg-base)' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Upload protocol (.txt, .md, .docx text)
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.csv,.docx,.pdf"
            className="hidden"
            onChange={handleFileUpload}
          />
          <span className="text-xs text-slate-300">or just describe it above</span>
        </div>

        {parseError && (
          <p className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2 border border-rose-100">
            {parseError}
          </p>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!researchQuestion.trim() || parsing}
            className="btn-primary px-5 py-2.5 rounded-lg text-sm disabled:opacity-40 flex items-center gap-2"
          >
            {parsing ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating PICO…
              </>
            ) : (
              <>Generate PICO →</>
            )}
          </button>
        </div>
      </div>
    );
  }

  // ── Sub-steps 1–4 ─────────────────────────────────────────────────────────
  return (
    <div>
      {/* Sub-step indicator */}
      <div className="flex items-center gap-1 mb-5">
        <button
          type="button"
          onClick={() => setSubStep(0)}
          className="text-[10px] font-mono text-slate-400 hover:text-amber-600 transition-colors mr-2"
        >
          ← Edit question
        </button>
        {subStepLabels.map((label, i) => (
          <div key={label} className="flex items-center gap-1">
            <div
              className={`w-5 h-5 rounded-full text-[9px] font-mono flex items-center justify-center ${
                i + 1 < subStep
                  ? 'bg-emerald-500 text-white'
                  : i + 1 === subStep
                    ? 'text-white'
                    : 'bg-slate-200 text-slate-400'
              }`}
              style={i + 1 === subStep ? { background: 'var(--gold)', color: 'white' } : {}}
            >
              {i + 1 < subStep ? '✓' : i + 1}
            </div>
            <span className={`text-[10px] font-mono uppercase tracking-wider ${
              i + 1 === subStep ? 'text-slate-700' : 'text-slate-400'
            }`}>{label}</span>
            {i < subStepLabels.length - 1 && (
              <div className="w-4 h-px bg-slate-200 mx-1" />
            )}
          </div>
        ))}
      </div>

      {/* Sub-step 1: PICO */}
      {subStep === 1 && (
        <div className="space-y-4">

          {/* AI metadata card */}
          {aiMeta && (
            <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 text-xs mb-2"
              style={{ background: 'var(--bg-base)' }}>
              {/* Framework + question type row */}
              <div className="flex items-center gap-3 px-3 py-2 flex-wrap">
                <span className="font-mono uppercase tracking-wider text-slate-400 text-[10px]">Framework</span>
                <span className="px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-700 font-mono font-medium text-[11px]">
                  {aiMeta.framework}
                </span>
                <span className="font-mono uppercase tracking-wider text-slate-400 text-[10px] ml-2">Question type</span>
                <span className="px-2 py-0.5 rounded-full border border-slate-200 text-slate-600 font-mono text-[11px] capitalize">
                  {aiMeta.question_type.replace(/-/g, ' ')}
                </span>
              </div>

              {/* Generated review question */}
              {aiMeta.review_question && (
                <div className="px-3 py-2">
                  <p className="font-mono uppercase tracking-wider text-slate-400 text-[10px] mb-1">Review question</p>
                  <p className="text-slate-700 text-xs leading-relaxed italic">"{aiMeta.review_question}"</p>
                </div>
              )}

              {/* Suggested title */}
              {aiMeta.review_title && (
                <div className="px-3 py-2">
                  <p className="font-mono uppercase tracking-wider text-slate-400 text-[10px] mb-1">Suggested title</p>
                  <p className="text-slate-700 text-xs leading-relaxed">{aiMeta.review_title}</p>
                </div>
              )}

              {/* Methodological cautions */}
              {aiMeta.methodological_cautions && (
                <div className="px-3 py-2 bg-amber-50/40 rounded-b-lg">
                  <p className="font-mono uppercase tracking-wider text-amber-700 text-[10px] mb-1">Methodological cautions</p>
                  <p className="text-amber-800 text-xs leading-relaxed">{aiMeta.methodological_cautions}</p>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-slate-700">Review your {aiMeta?.framework ?? 'PICO'} elements</h3>
            <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              AI-filled — edit freely
            </span>
          </div>
          {(
            [
              { key: 'population' as const, label: 'Population / Problem', required: true,
                placeholder: 'e.g., Adults with type 2 diabetes aged 40–80' },
              { key: 'intervention' as const, label: 'Intervention / Exposure', required: true,
                placeholder: 'e.g., Metformin monotherapy' },
              { key: 'comparator' as const, label: 'Comparator / Control', required: false,
                placeholder: 'e.g., Placebo, usual care, no treatment — leave blank if not applicable' },
              { key: 'outcome' as const, label: 'Outcome(s)', required: true,
                placeholder: 'Primary: e.g., HbA1c reduction\nSecondary: e.g., cardiovascular events\nAdverse: e.g., hypoglycaemia' },
              { key: 'health_area' as const, label: 'Health / Subject Area', required: false,
                placeholder: 'e.g., Endocrinology, Cardiology' },
            ] as const
          ).map(({ key, label, required, placeholder }) => (
            <div key={key}>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">
                {label} {required && <span className="text-rose-400">*</span>}
              </label>
              <textarea
                rows={2}
                value={pico[key] || ''}
                onChange={(e) => setPico((p) => ({ ...p, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
            </div>
          ))}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">Date from</label>
              <input
                type="date"
                value={pico.date_from || ''}
                onChange={(e) => setPico((p) => ({ ...p, date_from: e.target.value }))}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">Date to (blank = present)</label>
              <input
                type="date"
                value={pico.date_to || ''}
                onChange={(e) => setPico((p) => ({ ...p, date_to: e.target.value }))}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-slate-500 mb-1">
              Study designs (select all that apply)
            </label>
            <div className="flex flex-wrap gap-2">
              {STUDY_DESIGNS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    const current = pico.study_design || '';
                    const selected = current.split(',').map((s) => s.trim()).filter(Boolean);
                    const idx = selected.indexOf(d);
                    if (idx === -1) selected.push(d);
                    else selected.splice(idx, 1);
                    setPico((p) => ({ ...p, study_design: selected.join(', ') }));
                  }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                    (pico.study_design || '').includes(d)
                      ? 'border-amber-400 text-amber-700 bg-amber-50'
                      : 'border-slate-200 text-slate-500 hover:border-slate-300'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sub-step 2: Criteria */}
      {subStep === 2 && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-slate-700">Inclusion & Exclusion Criteria</h3>
            <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              AI-suggested — edit freely
            </span>
          </div>
          <div>
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-500 mb-2">Inclusion</h4>
            <div className="space-y-2 mb-2">
              {inclusionCriteria.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex-1 text-sm border border-slate-200 rounded px-2 py-1 text-slate-700"
                    style={{ background: 'var(--bg-base)' }}>{c}</span>
                  <button
                    type="button"
                    onClick={() => setInclusionCriteria((ic) => ic.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-rose-500 transition-colors text-xs px-1"
                  >✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newIC}
                onChange={(e) => setNewIC(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newIC.trim()) {
                    setInclusionCriteria((ic) => [...ic, newIC.trim()]);
                    setNewIC('');
                  }
                }}
                placeholder="Add criterion and press Enter"
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                onClick={() => { if (newIC.trim()) { setInclusionCriteria((ic) => [...ic, newIC.trim()]); setNewIC(''); } }}
                className="btn-primary px-3 py-2 rounded-lg text-sm"
              >+ Add</button>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-500 mb-2">Exclusion</h4>
            <div className="space-y-2 mb-2">
              {exclusionCriteria.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex-1 text-sm border border-slate-200 rounded px-2 py-1 text-slate-700"
                    style={{ background: 'var(--bg-base)' }}>{c}</span>
                  <button
                    type="button"
                    onClick={() => setExclusionCriteria((ec) => ec.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-rose-500 transition-colors text-xs px-1"
                  >✕</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newEC}
                onChange={(e) => setNewEC(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newEC.trim()) {
                    setExclusionCriteria((ec) => [...ec, newEC.trim()]);
                    setNewEC('');
                  }
                }}
                placeholder="Add criterion and press Enter"
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                onClick={() => { if (newEC.trim()) { setExclusionCriteria((ec) => [...ec, newEC.trim()]); setNewEC(''); } }}
                className="btn-primary px-3 py-2 rounded-lg text-sm"
              >+ Add</button>
            </div>
          </div>
        </div>
      )}

      {/* Sub-step 3: Extraction Schema */}
      {subStep === 3 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h3 className="text-sm font-medium text-slate-700">Data Extraction Schema</h3>
            <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              AI-suggested — edit freely
            </span>
            {aiMeta?.schema_template && (
              <span className="text-[10px] font-mono text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
                {TEMPLATE_LABELS[aiMeta.schema_template] ?? aiMeta.schema_template}
              </span>
            )}
          </div>

          {/* Grouped by section */}
          <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
            {(() => {
              const sections = Array.from(new Set(schemaFields.map((f) => f.section || 'General')));
              return sections.map((section) => (
                <div key={section}>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1.5 sticky top-0 bg-white pt-0.5">
                    {section}
                  </p>
                  <div className="space-y-1.5">
                    {schemaFields.map((f, i) => f.section === section || (!f.section && section === 'General') ? (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-slate-700 text-xs">{f.field}</span>
                            <span className="text-[10px] text-slate-400 border border-slate-200 rounded px-1 py-px">{f.type}</span>
                            {f.required && <span className="text-[10px] text-rose-400 font-mono">req</span>}
                          </div>
                          {f.description && (
                            <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{f.description}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSchemaFields((sf) => sf.filter((_, j) => j !== i))}
                          className="text-slate-300 hover:text-rose-500 text-xs mt-0.5 flex-shrink-0"
                        >✕</button>
                      </div>
                    ) : null)}
                  </div>
                </div>
              ));
            })()}
          </div>

          <div className="flex gap-2 items-end border-t border-slate-100 pt-3">
            <div className="flex-1 space-y-1.5">
              <input
                value={newField.field}
                onChange={(e) => setNewField((f) => ({ ...f, field: e.target.value }))}
                placeholder="Field name (snake_case)"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
              <input
                value={(newField as SchemaField).description || ''}
                onChange={(e) => setNewField((f) => ({ ...f, description: e.target.value }))}
                placeholder="Extraction instruction (optional)"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2
                  focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
              />
              <div className="flex gap-2">
                <select
                  value={newField.type}
                  onChange={(e) => setNewField((f) => ({ ...f, type: e.target.value }))}
                  className="text-sm border border-slate-200 rounded px-2 py-1"
                  style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
                >
                  {['text', 'number', 'boolean', 'list', 'dichotomous_outcome', 'continuous_outcome'].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={newField.required}
                    onChange={(e) => setNewField((f) => ({ ...f, required: e.target.checked }))}
                  />
                  Required
                </label>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (newField.field.trim()) {
                  setSchemaFields((sf) => [...sf, { ...newField, field: newField.field.trim() }]);
                  setNewField({ field: '', type: 'text', required: false, description: '', section: 'General' });
                }
              }}
              className="btn-primary px-3 py-2 rounded-lg text-sm h-fit"
            >+ Add</button>
          </div>
        </div>
      )}

      {/* Sub-step 4: Registries */}
      {subStep === 4 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2">Protocol Registration</h3>
          <p className="text-xs text-slate-500">
            Registering your protocol before starting the review is required by most journals
            and improves transparency.
          </p>
          {[
            { id: 'prospero', label: 'PROSPERO', desc: 'International prospective register of systematic reviews. Free. ~5 day review. Most widely required.' },
            { id: 'osf', label: 'OSF (Open Science Framework)', desc: 'Immediate registration via API. First Quill can register automatically with your OSF token.' },
            { id: 'campbell', label: 'Campbell Collaboration', desc: 'For social sciences, education, and international development reviews.' },
          ].map(({ id, label, desc }) => (
            <label key={id} className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={pico.target_registries?.includes(id) ?? false}
                onChange={(e) => {
                  const regs = pico.target_registries || [];
                  setPico((p) => ({
                    ...p,
                    target_registries: e.target.checked
                      ? [...regs, id]
                      : regs.filter((r) => r !== id),
                  }));
                }}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium text-slate-700">{label}</p>
                <p className="text-xs text-slate-400 mt-0.5">{desc}</p>
                {id === 'prospero' && pico.target_registries?.includes('prospero') && (
                  <p className="text-xs text-amber-600 mt-1">
                    PROSPERO requires manual submission. First Quill will generate all required fields for copy-paste.
                  </p>
                )}
              </div>
            </label>
          ))}

          <div className="mt-4 p-3 rounded-lg border border-amber-200 bg-amber-50/50 text-xs text-amber-800">
            <strong>What happens next:</strong> First Quill will generate a full PRISMA-P 2015 compliant protocol,
            all PROSPERO fields, and database-specific search strings. You can download the protocol and
            register it before searching.
          </div>
        </div>
      )}

      {/* Sub-step navigation */}
      <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={() => setSubStep((s) => s - 1)}
          disabled={subStep <= 1}
          className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-0 transition-colors"
        >
          ← Back
        </button>
        {subStep < 4 ? (
          <button
            type="button"
            onClick={() => setSubStep((s) => s + 1)}
            disabled={!canAdvanceSub()}
            className="btn-primary px-5 py-2 rounded-lg text-sm disabled:opacity-40"
          >
            Next →
          </button>
        ) : (
          <button
            type="button"
            onClick={handleFinish}
            className="btn-primary px-5 py-2 rounded-lg text-sm"
          >
            Ready to Launch →
          </button>
        )}
      </div>
    </div>
  );
}
