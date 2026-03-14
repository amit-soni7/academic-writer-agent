/**
 * sr.ts — API client for the SR pipeline (/api/sr/*)
 */

import api from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PicoData {
  population: string;
  intervention: string;
  comparator: string;
  outcome: string;
  study_design?: string;
  setting?: string;
  time_frame?: string;
  language_restriction?: string;
  date_from?: string;
  date_to?: string;
  review_type?: string;
  health_area?: string;
  target_registries?: string[];
}

export interface SRProtocol {
  project_id: string;
  pico: PicoData | null;
  data_extraction_schema: SchemaField[];
  protocol_document: string | null;
  prospero_fields: Record<string, string>;
  prisma_p_checklist: Record<string, { description?: string; status: string; location?: string }>;
  search_strategies: Record<string, string>;
  registration_status: string;
  osf_registration_id?: string | null;
}

export interface PRISMAFlow {
  identified: number;
  duplicates_removed: number;
  screened: number;
  excluded_screening: number;
  sought_retrieval: number;
  not_retrieved: number;
  assessed_eligibility: number;
  excluded_fulltext: number;
  excluded_fulltext_reasons: Record<string, number>;
  included: number;
}

export interface ScreeningEntry {
  paper_key: string;
  ai_decision: string | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  human_decision: string | null;
  final_decision: string | null;
  is_conflict?: boolean;
  exclusion_reason_category?: string | null;
}

export interface ExtractionData {
  paper_key: string;
  ai_extracted: Record<string, { value: unknown; quote: string; confidence: number; page_section?: string }>;
  human_verified: Record<string, unknown>;
  final_data: Record<string, unknown>;
  verified_by_human: boolean;
  extraction_notes?: string;
  disagreement_flags?: string[];
}

export interface RoBAssessment {
  paper_key: string;
  tool_used: string;
  overall_risk: string | null;
  human_confirmed: boolean;
  ai_assessment: Record<string, unknown>;
  human_assessment: Record<string, unknown>;
  final_assessment: Record<string, unknown>;
}

export interface MetaAnalysisResult {
  effect_measure: string;
  model: string;
  n_studies: number;
  n_participants: number;
  pooled_estimate: number | null;
  ci_lower: number | null;
  ci_upper: number | null;
  i_squared: number | null;
  tau_squared: number | null;
  q_statistic: number | null;
  q_p_value: number | null;
  heterogeneity_interpretation: string;
  forest_plot_data: Array<{
    study_id: string;
    effect: number;
    ci_lower: number;
    ci_upper: number;
    weight_pct: number;
    n: number;
  }>;
}

// ── PRISMA-P 2015 structured data ─────────────────────────────────────────────

export interface PrismaPAuthor {
  name: string;
  affiliation?: string;
  email?: string;
  contribution?: string;
}

export interface PrismaPAdministrative {
  review_title?: string;           // 1a
  is_update?: boolean;             // 1b
  previous_review_doi?: string;
  registration_name?: string;      // 2
  registration_number?: string;
  authors?: PrismaPAuthor[];       // 3a
  contributions?: string;          // 3b
  amendment_plan?: string;         // 4
  funding_sources?: string;        // 5a
  sponsor_name?: string;           // 5b
  sponsor_role?: string;           // 5c
}

export interface PrismaPIntroduction {
  rationale?: string;              // 6
  pico?: PicoData;                 // 7
  review_question?: string;
  framework?: string;              // PICO / SPIDER / PEO / etc.
  schema_template?: string;
  alternative_phrasings?: string[];
  methodological_cautions?: string;
}

export interface PrismaPMethodsEligibility {
  inclusion_criteria?: string[];   // 8
  exclusion_criteria?: string[];
  study_design_criteria?: string;
  language_restriction?: string;
  date_restriction?: string;
  databases?: string[];            // 9
  grey_literature_sources?: string;
}

export interface PrismaPMethodsSearch {
  search_strategies?: Record<string, string>;  // 10: per-database strings
  date_from?: string;
  date_to?: string;
}

export interface PrismaPMethodsDataCollection {
  data_management_tool?: string;   // 11a
  selection_process?: string;      // 11b
  data_collection_notes?: string;  // 11c
  extraction_schema?: SchemaField[]; // 12
  outcome_prioritization?: string; // 13
}

export interface PrismaPMethodsSynthesis {
  rob_tool?: string;               // 14
  rob_level?: string;              // 'study' | 'outcome' | 'both'
  synthesis_type?: string;         // 15a: 'quantitative' | 'narrative' | 'both'
  effect_measure?: string;         // 15b
  i2_threshold?: string;
  subgroup_analyses?: string[];    // 15c
  qualitative_synthesis?: string;  // 15d
  publication_bias_plan?: string;  // 16
  grade_plan?: string;             // 17
}

export interface PrismaPData {
  administrative?: PrismaPAdministrative;
  introduction?: PrismaPIntroduction;
  methods_eligibility?: PrismaPMethodsEligibility;
  methods_search?: PrismaPMethodsSearch;
  methods_data_collection?: PrismaPMethodsDataCollection;
  methods_synthesis?: PrismaPMethodsSynthesis;
}

export interface PrismaPScore {
  completed: number;
  total: number;
  required_complete: boolean;
  missing_required: string[];
  completed_items: string[];
}

export async function getPrismaP(projectId: string): Promise<{ project_id: string; prisma_p: PrismaPData; query: string }> {
  const { data } = await api.get(`/api/sr/${projectId}/prisma_p`);
  return data;
}

export async function savePrismaP(
  projectId: string,
  section: keyof PrismaPData,
  sectionData: Partial<PrismaPData[typeof section]>,
): Promise<void> {
  await api.put(`/api/sr/${projectId}/prisma_p`, { section, data: sectionData });
}

export async function getPrismaPScore(projectId: string): Promise<PrismaPScore> {
  const { data } = await api.get<PrismaPScore>(`/api/sr/${projectId}/prisma_p/score`);
  return data;
}

// ── AI PICO parsing ───────────────────────────────────────────────────────────

export interface SchemaField {
  field: string;
  type: string;
  required: boolean;
  description?: string;
  section?: string;
}

export interface ParsedPico {
  question_type: string;
  framework: string;
  schema_template: string;
  review_title: string;
  review_objective: string;
  review_question: string;
  alternative_phrasings: string[];
  methodological_cautions: string;
  pico: PicoData;
  inclusion_criteria: string[];
  exclusion_criteria: string[];
  extraction_schema: SchemaField[];
  error?: string;
}

export async function parsePicoFromText(
  text: string,
  reviewType: string = 'systematic_review',
  framework: string = '',
): Promise<ParsedPico> {
  const { data } = await api.post<ParsedPico>('/api/sr/parse_pico', {
    text,
    review_type: reviewType,
    framework,
  });
  return data;
}

// ── New AI-first Protocol Builder APIs ───────────────────────────────────────

export type PhaseId =
  | 'review_setup' | 'objectives' | 'research_question' | 'outcomes'
  | 'eligibility' | 'search_sources' | 'search_strategy' | 'records_management'
  | 'screening' | 'data_collection' | 'data_items'
  | 'rob_assessment' | 'synthesis_plan' | 'effect_measures'
  | 'subgroup_sensitivity' | 'reporting_certainty' | 'admin'
  | 'background' | 'rationale';

export interface EvidencePackPaper {
  id: string;
  title: string;
  authors: string | string[];
  year: number | null;
  doi?: string | null;
  journal?: string | null;
  abstract?: string;
}

export interface EvidencePack {
  search_terms: string[];
  databases_searched: string[];
  search_date: string;
  retrieved_count: number;
  deduplicated_count: number;
  ranked_papers: EvidencePackPaper[];
  cited_ids: string[];
  background_draft: string;
  rationale_draft: string;
  references_md: string;
  references_json: Record<string, unknown>[];
  bibtex: string;
}

export interface BackgroundDraft {
  draft: string;
  summary: string;
}

export async function researchBackground(
  query: string,
  section: 'background' | 'rationale' = 'background',
  reviewType: string = 'systematic_review',
): Promise<BackgroundDraft> {
  const { data } = await api.post<BackgroundDraft>('/api/sr/research_background', {
    query,
    section,
    review_type: reviewType,
  });
  return data;
}

export async function buildEvidencePack(
  projectId: string,
  params: {
    query: string;
    nArticles?: number;
    picoContext?: Record<string, string>;
    reviewType?: string;
  },
): Promise<{ pack: EvidencePack; warnings: string[]; summary: string }> {
  const { data } = await api.post(`/api/sr/${projectId}/protocol/build_evidence_pack`, {
    query: params.query,
    n_articles: params.nArticles ?? 20,
    pico_context: params.picoContext ?? {},
    review_type: params.reviewType ?? 'systematic_review',
  });
  return data;
}

export async function writeRationale(
  projectId: string,
  params: { query: string; reviewType?: string },
): Promise<{ pack: EvidencePack; warnings: string[]; summary: string }> {
  const { data } = await api.post(`/api/sr/${projectId}/protocol/write_rationale`, {
    query: params.query,
    review_type: params.reviewType ?? 'systematic_review',
  });
  return data;
}

export interface GeneratedReviewQuestion {
  review_question: string;
  alternative_phrasings: string[];
  methodological_cautions: string;
  error?: string;
}

export async function generateReviewQuestion(params: {
  framework: string;
  elements: Record<string, string>;
  feedback?: string;
  reviewType?: string;
}): Promise<GeneratedReviewQuestion> {
  const { data } = await api.post<GeneratedReviewQuestion>('/api/sr/generate_review_question', {
    framework: params.framework,
    elements: params.elements,
    feedback: params.feedback ?? '',
    review_type: params.reviewType ?? 'systematic_review',
  });
  return data;
}

export interface ChatMessage {
  role: 'ai' | 'user';
  text: string;
}

export interface PhaseChatResult {
  reply: string;
  content: Record<string, unknown>;
}

export async function phaseChat(
  projectId: string,
  params: {
    phase: string;
    messages: ChatMessage[];
    currentContent?: Record<string, unknown>;
    picoContext?: Partial<PicoData>;
    contextData?: Record<string, unknown>;
    reviewType?: string;
    mode?: 'direct' | 'plan';
  },
): Promise<PhaseChatResult> {
  const { data } = await api.post<PhaseChatResult>(
    `/api/sr/${projectId}/protocol/phase_chat`,
    {
      phase: params.phase,
      messages: params.messages,
      current_content: params.currentContent ?? {},
      pico_context: params.picoContext ?? {},
      context_data: params.contextData ?? {},
      review_type: params.reviewType ?? 'systematic_review',
      mode: params.mode ?? 'direct',
    },
  );
  return data;
}

// ── Protocol ──────────────────────────────────────────────────────────────────

export async function savePico(
  projectId: string,
  pico: PicoData,
  inclusionCriteria: string[],
  exclusionCriteria: string[],
  dataExtractionSchema: SchemaField[],
): Promise<void> {
  await api.post(`/api/sr/${projectId}/pico`, {
    pico,
    inclusion_criteria: inclusionCriteria,
    exclusion_criteria: exclusionCriteria,
    data_extraction_schema: dataExtractionSchema,
  });
}

export async function getProtocol(projectId: string): Promise<SRProtocol> {
  const { data } = await api.get<SRProtocol>(`/api/sr/${projectId}/protocol`);
  return data;
}

export function streamGenerateProtocol(projectId: string): EventSource {
  return new EventSource(
    `${(import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010'}/api/sr/${projectId}/protocol/generate`,
    { withCredentials: true }
  );
}

export async function registerOSF(projectId: string, osfToken: string): Promise<Record<string, string>> {
  const { data } = await api.post(`/api/sr/${projectId}/protocol/register_osf`, { osf_token: osfToken });
  return data;
}

export async function getSearchStrings(projectId: string): Promise<Record<string, string>> {
  const { data } = await api.get<{ search_strategies: Record<string, string> }>(`/api/sr/${projectId}/search_strings`);
  return data.search_strategies;
}

export function streamGenerateProtocolFetch(
  projectId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/protocol/generate`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

// ── Search ────────────────────────────────────────────────────────────────────

export function streamSRSearch(
  projectId: string,
  databases: string[],
  dateFrom: string,
  dateTo: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/search`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ databases, date_from: dateFrom, date_to: dateTo }),
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export async function getSearchStatus(projectId: string): Promise<{ status?: string; prisma_flow: PRISMAFlow }> {
  const { data } = await api.get(`/api/sr/${projectId}/search/status`);
  return data;
}

// ── Screening ─────────────────────────────────────────────────────────────────

export function streamAIScreen(
  projectId: string,
  stage: 'title_abstract' | 'full_text',
  paperKeys: string[] | undefined,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/screening/ai_screen`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, ...(paperKeys ? { paper_keys: paperKeys } : {}) }),
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export async function getScreeningQueue(
  projectId: string,
  stage: string,
  status: string = 'all',
): Promise<{ papers: ScreeningEntry[]; total: number }> {
  const { data } = await api.get(`/api/sr/${projectId}/screening/queue`, {
    params: { stage, status },
  });
  return data;
}

export async function saveHumanScreening(
  projectId: string,
  paperKey: string,
  stage: string,
  decision: string,
  reason: string,
  exclusionCategory?: string,
): Promise<void> {
  await api.post(`/api/sr/${projectId}/screening/${paperKey}`, {
    stage,
    decision,
    reason,
    exclusion_reason_category: exclusionCategory || '',
  });
}

export async function getPrismaFlow(projectId: string): Promise<PRISMAFlow> {
  const { data } = await api.get<PRISMAFlow>(`/api/sr/${projectId}/screening/prisma_flow`);
  return data;
}

// ── Extraction ────────────────────────────────────────────────────────────────

export async function saveExtractionSchema(
  projectId: string,
  fields: Array<{ field: string; type: string; required: boolean; description?: string }>,
): Promise<void> {
  await api.post(`/api/sr/${projectId}/extraction/schema`, { fields });
}

export function streamExtractPaper(
  projectId: string,
  paperKey: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/extraction/extract/${paperKey}`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export function streamExtractAll(
  projectId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/extraction/extract_all`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export async function getExtraction(projectId: string, paperKey: string): Promise<ExtractionData> {
  const { data } = await api.get<ExtractionData>(`/api/sr/${projectId}/extraction/${paperKey}`);
  return data;
}

export async function saveHumanVerification(
  projectId: string,
  paperKey: string,
  humanVerified: Record<string, unknown>,
  extractionNotes?: string,
): Promise<void> {
  await api.put(`/api/sr/${projectId}/extraction/${paperKey}`, {
    human_verified: humanVerified,
    extraction_notes: extractionNotes || '',
  });
}

// ── Risk of Bias ──────────────────────────────────────────────────────────────

export function streamRoBAssess(
  projectId: string,
  paperKey: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/rob/${paperKey}/assess`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export async function confirmRoB(
  projectId: string,
  paperKey: string,
  humanAssessment: Record<string, unknown>,
  finalAssessment: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data } = await api.post(`/api/sr/${projectId}/rob/${paperKey}/confirm`, {
    human_assessment: humanAssessment,
    final_assessment: finalAssessment,
  });
  return data;
}

export async function getRoBSummary(projectId: string): Promise<{
  papers: RoBAssessment[];
  counts: Record<string, number>;
  total: number;
  confirmed: number;
  pending_confirmation: number;
}> {
  const { data } = await api.get(`/api/sr/${projectId}/rob/summary`);
  return data;
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

export async function runMetaAnalysis(
  projectId: string,
  effectMeasure: string,
  model: string,
  subgroups?: string[],
): Promise<MetaAnalysisResult> {
  const { data } = await api.post<MetaAnalysisResult>(`/api/sr/${projectId}/meta_analysis`, {
    effect_measure: effectMeasure,
    model,
    subgroups: subgroups || [],
  });
  return data;
}

export function streamSynthesis(
  projectId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/synthesis`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      onError(text);
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

export function streamGenerateManuscript(
  projectId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

  fetch(`${baseUrl}/api/sr/${projectId}/manuscript/generate`, {
    method: 'POST',
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) { onError(`HTTP ${res.status}`); return; }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      }
    }
    onDone();
  }).catch((e) => { if (e.name !== 'AbortError') onError(String(e)); });

  return ctrl;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export async function getAuditLog(projectId: string): Promise<{ entries: unknown[]; total: number }> {
  const { data } = await api.get(`/api/sr/${projectId}/audit_log`);
  return data;
}
