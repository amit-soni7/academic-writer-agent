import api from './client';
import type { CommentChangeSuggestion, CommentPlan, DeepSynthesisResult, DeepSynthesisSSEEvent, FigureBrief, FigureBuilderGenerateResponse, FigureBuilderRequest, IllustrationCandidate, IllustrationStyleControls, ImportManuscriptResult, JournalRecommendation, JournalStyle, Paper, PaperSummary, PeerReviewReport, ProjectMeta, PromptPackage, RealReviewerComment, RevisionResult, RevisionRound, SynthesisResult, VisualRecommendations } from '../types/paper';

export async function createProject(
  query: string,
  papers: Paper[],
  articleType?: string,
  projectDescription?: string,
  tentativeTitle?: string,
  projectType?: 'write' | 'revision' | 'systematic_review',
  pico?: Record<string, unknown>,
  inclusionCriteria?: string[],
  exclusionCriteria?: string[],
  dataExtractionSchema?: unknown[],
  literatureSearchState?: LiteratureSearchState,
): Promise<ProjectMeta> {
  const { data } = await api.post<ProjectMeta>('/api/projects', {
    query,
    papers,
    ...(articleType ? { article_type: articleType } : {}),
    ...(projectDescription ? { project_description: projectDescription } : {}),
    ...(tentativeTitle ? { project_name: tentativeTitle } : {}),
    ...(projectType ? { project_type: projectType } : {}),
    ...(pico ? { pico } : {}),
    ...(inclusionCriteria ? { inclusion_criteria: inclusionCriteria } : {}),
    ...(exclusionCriteria ? { exclusion_criteria: exclusionCriteria } : {}),
    ...(dataExtractionSchema ? { data_extraction_schema: dataExtractionSchema } : {}),
    ...(literatureSearchState ? { literature_search_state: literatureSearchState } : {}),
  });
  return data;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const { data } = await api.get<ProjectMeta[]>('/api/projects');
  return data;
}

export async function loadProject(projectId: string): Promise<ProjectData> {
  const { data } = await api.get<ProjectData>(`/api/projects/${projectId}`);
  return data;
}

export async function deleteProject(projectId: string): Promise<void> {
  await api.delete(`/api/projects/${projectId}`);
}

export async function updateProjectName(
  projectId: string,
  projectName: string,
): Promise<{ project_id: string; project_name: string; project_folder: string }> {
  const { data } = await api.patch(`/api/projects/${projectId}/name`, { project_name: projectName });
  return data;
}

export async function ensureProjectTentativeTitle(
  projectId: string,
): Promise<{ project_id: string; tentative_title: string; project_slug: string }> {
  const { data } = await api.post(`/api/projects/${projectId}/ensure_tentative_title`);
  return data;
}

export async function backfillLegacyProjectTitles(): Promise<{
  updated_count: number;
  projects: Array<{ project_id: string; project_name: string; project_slug: string }>;
}> {
  const { data } = await api.post('/api/projects/backfill_legacy_titles');
  return data;
}

export interface NormalizeProjectStorageResult {
  projects_updated: number;
  pdfs_moved: number;
  pdfs_copied: number;
  bibs_rebuilt: number;
  missing_pdfs: Array<{
    project_id: string;
    project_name: string;
    paper_key: string;
    title: string;
    expected_path: string | null;
    repair_needed: boolean;
    reason: string;
  }>;
  unassigned_files: string[];
  projects: Array<{
    project_id: string;
    project_name: string;
    old_folder: string;
    target_folder: string;
    folder_updated: boolean;
    existing_files_merged: number;
    bib_path: string | null;
    bib_entries: number;
    bib_rebuilt: boolean;
    missing_pdf_count: number;
  }>;
}

export async function normalizeProjectStorage(): Promise<NormalizeProjectStorageResult> {
  const { data } = await api.post<NormalizeProjectStorageResult>('/api/projects/normalize_storage');
  return data;
}

export function projectPaperPdfUrl(projectId: string, paperKey: string): string {
  const base = String(api.defaults.baseURL || 'http://localhost:8010').replace(/\/$/, '');
  return `${base}/api/projects/${projectId}/paper_pdf?paper_key=${encodeURIComponent(paperKey)}`;
}

export async function recommendJournals(projectId: string): Promise<JournalRecommendation[]> {
  const { data } = await api.post<JournalRecommendation[]>(
    `/api/projects/${projectId}/recommend_journals`
  );
  return data;
}

export async function lookupJournal(projectId: string, journalName: string): Promise<JournalRecommendation> {
  const { data } = await api.post<JournalRecommendation>(
    `/api/projects/${projectId}/journal_lookup`,
    { journal_name: journalName },
  );
  return data;
}

export async function writeArticle(
  projectId: string,
  selectedJournal: string,
  articleType: string,
  wordLimit: number,
  maxReferences?: number,
  force = false,
): Promise<{ article: string; word_count: number; ref_count: number; ref_limit?: number | null; word_limit: number; visual_recommendations?: VisualRecommendations | null }> {
  const { data } = await api.post(`/api/projects/${projectId}/write_article_sync`, {
    session_id: projectId,
    project_id: projectId,
    selected_journal: selectedJournal,
    article_type: articleType,
    word_limit: wordLimit,
    force,
    ...(maxReferences != null ? { max_references: maxReferences } : {}),
  });
  return data;
}

export async function synthesizePapers(projectId: string): Promise<SynthesisResult> {
  const { data } = await api.post<SynthesisResult>(`/api/projects/${projectId}/synthesize`);
  return data;
}

export async function getSynthesisResult(projectId: string): Promise<SynthesisResult | null> {
  const { data } = await api.get<SynthesisResult | Record<string, never>>(`/api/projects/${projectId}/synthesis_result`);
  return data && Object.keys(data).length > 0 ? (data as SynthesisResult) : null;
}

// ── Deep Synthesis ────────────────────────────────────────────────────────────

export function streamDeepSynthesis(
  projectId: string,
  onEvent: (event: DeepSynthesisSSEEvent) => void,
  autoFetchEnabled = true,
): AbortController {
  const controller = new AbortController();
  const baseUrl = api.defaults.baseURL || '';
  const url = `${baseUrl}/api/projects/${projectId}/deep_synthesize`;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ auto_fetch_enabled: autoFetchEnabled }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as DeepSynthesisSSEEvent;
              onEvent(event);
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        console.error('Deep synthesis stream error:', err);
      }
    });

  return controller;
}

export async function getDeepSynthesisResult(
  projectId: string,
): Promise<DeepSynthesisResult | null> {
  try {
    const { data } = await api.get<DeepSynthesisResult>(
      `/api/projects/${projectId}/deep_synthesis_result`,
    );
    return data;
  } catch {
    return null;
  }
}

export async function generatePeerReview(projectId: string): Promise<PeerReviewReport> {
  const { data } = await api.post<PeerReviewReport>(`/api/projects/${projectId}/peer_review`);
  return data;
}

export async function getPeerReviewResult(projectId: string): Promise<PeerReviewReport | null> {
  const { data } = await api.get<PeerReviewReport | Record<string, never>>(`/api/projects/${projectId}/peer_review_result`);
  return data && Object.keys(data).length > 0 ? (data as PeerReviewReport) : null;
}

export async function reviseAfterReview(
  projectId: string,
  article: string,
  review: PeerReviewReport,
  selectedJournal: string,
): Promise<RevisionResult> {
  const { data } = await api.post<RevisionResult>(`/api/projects/${projectId}/revise_after_review`, {
    article,
    review,
    selected_journal: selectedJournal,
  });
  return data;
}

// ── Streaming summarize-all ────────────────────────────────────────────────────

export interface SummarizeAllEvent {
  type: 'progress' | 'step_progress' | 'summary_done' | 'paper_error' | 'complete' | 'error';
  current?: number;
  total?: number;
  title?: string;
  step?: string;         // only for step_progress
  skipped?: boolean;
  skip_reason?: string;
  skipped_count?: number;
  paper_key?: string;
  summary?: PaperSummary;
  message?: string;
  done?: number;
  errors?: number;
  project_id?: string;
  session_id?: string; // backward-compat
}

// ── Background summarisation (survives navigation) ─────────────────────────

export interface BgSummarizeStatus {
  running: boolean;
  current: number;
  total: number;
  current_title: string;
  errors: number;
  saved: number;
  started?: boolean;
  reason?: string;
}

export async function startSummarizeAllBg(
  projectId: string,
  papers: Paper[],
  query: string,
): Promise<BgSummarizeStatus> {
  const res = await fetch(`http://localhost:8010/api/projects/${projectId}/summarize_all/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ papers, query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getSummarizeStatus(projectId: string): Promise<BgSummarizeStatus> {
  const res = await fetch(`http://localhost:8010/api/projects/${projectId}/summarize_all/status`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function backfillFiles(projectId: string): Promise<{
  saved: number;
  already_existed: number;
  failed: number;
  total_summarised: number;
}> {
  const res = await fetch(`http://localhost:8010/api/projects/${projectId}/backfill_files`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resetSummaries(projectId: string): Promise<{ deleted: number }> {
  const res = await fetch(`http://localhost:8010/api/projects/${projectId}/summaries`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function* streamSummarizeAll(
  projectId: string,
  papers: Paper[],
  query: string,
): AsyncGenerator<SummarizeAllEvent> {
  const response = await fetch(
    `http://localhost:8010/api/projects/${projectId}/summarize_all`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, papers }),
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} from summarize_all`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop()!;
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6)) as SummarizeAllEvent;
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Title quality policy types ─────────────────────────────────────────────────

export interface TitleCandidate {
  title: string;
  rationale: string;
}

export interface TitleSuggestions {
  best_title: string;
  best_title_rationale: string;
  alternatives: TitleCandidate[];
  quality_notes: string;
}

export async function generateTitle(
  projectId: string,
  articleType: string,
  selectedJournal: string,
): Promise<TitleSuggestions> {
  const { data } = await api.post<TitleSuggestions>(
    `/api/projects/${projectId}/generate_title`,
    { article_type: articleType, selected_journal: selectedJournal },
  );
  return data;
}

export async function approveTitle(
  projectId: string,
  title: string,
): Promise<{ status: string; manuscript_title: string }> {
  const { data } = await api.post(
    `/api/projects/${projectId}/approve_title`,
    { title },
  );
  return data;
}

// ── Journal style lookup ──────────────────────────────────────────────────────

export async function getJournalStyle(
  name: string,
  publisher?: string,
): Promise<JournalStyle> {
  const params = new URLSearchParams({ name });
  if (publisher) params.append('publisher', publisher);
  const { data } = await api.get<JournalStyle>(`/api/journal-style?${params.toString()}`);
  return data;
}

// ── Project data type (full load) ─────────────────────────────────────────────

export interface ProjectData {
  project_id: string;
  query: string;
  created_at: string;
  updated_at: string;
  papers: Paper[];
  summaries: Record<string, PaperSummary>;
  journal_recs: JournalRecommendation[];
  selected_journal: string | null;
  article: string | null;
  manuscript_title: string | null;
  article_type: string | null;
  project_name: string | null;
  project_description: string | null;
  project_folder: string | null;
  current_phase: string | null;
  project_type: 'write' | 'revision' | null;
  base_manuscript: string | null;
  visual_recommendations?: VisualRecommendations | null;
  literature_search_state?: LiteratureSearchState | null;
}

export interface LiteratureSearchState {
  status: 'streaming' | 'done' | 'error';
  query: string;
  total_limit: number;
  warnings?: string[];
  source_progress?: Record<string, number>;
  sources_done?: string[];
  sources_error?: Record<string, string>;
  is_deduplicating?: boolean;
  ranking_info?: { candidates: number; selected: number; requested: number } | null;
  is_enriching?: boolean;
  expanded_queries?: string[];
  pubmed_queries?: string[];
  mesh_terms?: string[];
  boolean_query?: string;
  pico?: Record<string, string> | null;
  framework_elements?: Record<string, string | string[]>;
  framework_used?: string;
  framework_justification?: string;
  question_type?: string | null;
  secondary_frameworks_considered?: string[];
  study_type_filters?: string[];
  ai_rationale?: string;
  facets?: Record<string, { mesh: string[]; freetext: string[] }>;
  strategy_notes?: string[];
  tentative_title?: string;
  source_papers?: Record<string, Paper[]>;
  current_papers?: Paper[];
  error?: string;
}

// Backward-compat alias
export type SessionData = ProjectData;

// ── Real peer-review revision API ─────────────────────────────────────────────

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010';

export async function importManuscript(
  projectId: string,
  textOrFile: string | File,
): Promise<ImportManuscriptResult> {
  const form = new FormData();
  if (typeof textOrFile === 'string') {
    form.append('text', textOrFile);
  } else {
    form.append('file', textOrFile);
  }
  const resp = await fetch(`${API_BASE}/api/projects/${projectId}/import_manuscript`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function parseReviewerComments(
  projectId: string,
  req: { raw_comments: string; journal_name?: string; round_number?: number },
): Promise<RealReviewerComment[]> {
  const { data } = await api.post<RealReviewerComment[]>(
    `/api/projects/${projectId}/revision_rounds/parse`,
    req,
  );
  return data;
}

export async function parseReviewerCommentsDocx(
  projectId: string,
  file: File,
): Promise<RealReviewerComment[]> {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch(`${API_BASE}/api/projects/${projectId}/revision_rounds/parse_docx`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function generateRealRevision(
  projectId: string,
  req: { round_number: number; parsed_comments: RealReviewerComment[]; journal_name?: string },
): Promise<RevisionRound> {
  const { data } = await api.post<RevisionRound>(
    `/api/projects/${projectId}/revision_rounds`,
    req,
  );
  return data;
}

export async function suggestChanges(
  projectId: string,
  req: {
    manuscript_text?: string;
    journal_name?: string;
    parsed_comments: RealReviewerComment[];
    round_number?: number;
  },
): Promise<CommentChangeSuggestion[]> {
  const { data } = await api.post<CommentChangeSuggestion[]>(
    `/api/projects/${projectId}/revision_rounds/suggest_changes`,
    req,
  );
  return data;
}

export async function discussComment(
  projectId: string,
  req: {
    original_comment: string;
    reviewer_number: number;
    comment_number: number;
    user_message: string;
    round_number?: number;
    history?: { role: 'ai' | 'user'; content: string }[];
    current_plan?: string;
    doi_references?: string[];
    manuscript_text?: string;
    finalized_context?: {
      reviewer_number: number;
      comment_number: number;
      original_comment: string;
      action_taken?: string;
      manuscript_changes?: string;
    }[];
  },
): Promise<{ ai_response: string; updated_plan: string }> {
  const { data } = await api.post(
    `/api/projects/${projectId}/revision_rounds/discuss_comment`,
    req,
  );
  return data;
}

export async function finalizeComment(
  projectId: string,
  req: {
    original_comment: string;
    reviewer_number: number;
    comment_number: number;
    finalized_plan: string;
    round_number?: number;
    manuscript_text?: string;
  },
): Promise<{ author_response: string; action_taken: string; manuscript_changes: string }> {
  const { data } = await api.post(
    `/api/projects/${projectId}/revision_rounds/finalize_comment`,
    req,
  );
  return data;
}

export async function generateFromPlans(
  projectId: string,
  req: { round_number: number; journal_name?: string; finalized_plans: CommentPlan[] },
): Promise<RevisionRound> {
  const { data } = await api.post<RevisionRound>(
    `/api/projects/${projectId}/revision_rounds`,
    req,
  );
  return data;
}

export async function getRevisionRounds(projectId: string): Promise<RevisionRound[]> {
  const { data } = await api.get<RevisionRound[]>(`/api/projects/${projectId}/revision_rounds`);
  return data;
}

export interface RevisionWip {
  manuscript_text?: string;
  import_result?: ImportManuscriptResult | null;
  raw_comments?: string;
  journal_name?: string;
  parsed_comments?: RealReviewerComment[];
  suggestions?: CommentChangeSuggestion[];
  comment_plans?: CommentPlan[];
  step?: string;
}

export async function getRevisionWip(projectId: string): Promise<RevisionWip> {
  const { data } = await api.get<RevisionWip>(`/api/projects/${projectId}/revision_wip`);
  return data ?? {};
}

export async function saveRevisionWip(projectId: string, wip: RevisionWip): Promise<void> {
  await api.put(`/api/projects/${projectId}/revision_wip`, wip);
}

// ── Comment work (per-comment persistent storage) ─────────────────────────────

export interface CommentWorkRow {
  project_id: string;
  round_number: number;
  reviewer_number: number;
  comment_number: number;
  original_comment: string;
  category: string;
  severity?: string;
  domain?: string;
  requirement_level?: string;
  ambiguity_flag: boolean;
  ambiguity_question?: string;
  intent_interpretation?: string;
  suggestion: CommentChangeSuggestion | null;
  discussion: { role: 'ai' | 'user'; content: string }[];
  current_plan: string;
  doi_references: string[];
  is_finalized: boolean;
  author_response: string;
  action_taken: string;
  manuscript_changes: string;
}

export async function getCommentWork(
  projectId: string,
  roundNumber: number,
): Promise<CommentWorkRow[]> {
  const { data } = await api.get<CommentWorkRow[]>(
    `/api/projects/${projectId}/comment_work/${roundNumber}`,
  );
  return data;
}

export async function updateCommentWork(
  projectId: string,
  roundNumber: number,
  reviewerNumber: number,
  commentNumber: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await api.patch(
    `/api/projects/${projectId}/comment_work/${roundNumber}/${reviewerNumber}/${commentNumber}`,
    updates,
  );
}

export async function replaceComments(
  projectId: string,
  roundNumber: number,
  comments: Record<string, unknown>[],
): Promise<void> {
  await api.put(
    `/api/projects/${projectId}/comment_work/${roundNumber}`,
    { comments },
  );
}

export function downloadPointByPointDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/point_by_point_docx`;
}

export function downloadManuscriptReferencePdf(projectId: string): string {
  return `${API_BASE}/api/projects/${projectId}/manuscript_reference_pdf`;
}

export function downloadRevisedManuscriptDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/revised_manuscript_docx`;
}

export function downloadRevisedManuscriptPdf(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/revised_manuscript_pdf`;
}

export function downloadTrackChangesDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/track_changes_docx`;
}

export function downloadProjectZip(projectId: string): string {
  return `${API_BASE}/api/projects/${projectId}/download_zip`;
}

/** Fetch AI-powered track changes .docx as a blob (may take 30+ seconds). */
export async function fetchTrackChangesDocx(
  projectId: string,
  roundNumber: number,
  author: string,
): Promise<Blob> {
  const url = `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/track_changes_docx?author=${encodeURIComponent(author)}`;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => 'Unknown error');
    let detail = text;
    try { detail = JSON.parse(text).detail || text; } catch {}
    throw new Error(detail);
  }
  return resp.blob();
}

/** Generate the revision document package (track changes, clean docx, revised PDF, point-by-point). */
export async function generateAllDocs(
  projectId: string,
  req: { round_number: number; author?: string },
): Promise<{ status: string; round_number: number; revised_pdf_ready?: boolean }> {
  const { data } = await api.post<{ status: string; round_number: number; revised_pdf_ready?: boolean }>(
    `/api/projects/${projectId}/revision_rounds/generate_all_docs`,
    req,
  );
  return data;
}

// ── Screening ─────────────────────────────────────────────────────────────────

export type ScreenPapersEvent =
  | { type: 'progress'; current: number; total: number; title: string }
  | { type: 'screen_done'; paper_key: string; decision: 'include' | 'exclude' | 'uncertain'; reason: string }
  | { type: 'screen_error'; title: string; message: string }
  | { type: 'complete'; include: number; exclude: number; uncertain: number; error: number; total: number }
  | { type: 'error'; message: string };

export async function* streamScreenPapers(
  projectId: string,
  papers: Paper[],
  query: string,
): AsyncGenerator<ScreenPapersEvent> {
  const response = await fetch(
    `${API_BASE}/api/projects/${projectId}/screen_papers`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, papers }),
    }
  );

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} from screen_papers`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop()!;
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6)) as ScreenPapersEvent;
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function overrideScreening(
  projectId: string,
  paperKey: string,
  decision: string,
): Promise<void> {
  await api.patch(`/api/projects/${projectId}/screenings/${encodeURIComponent(paperKey)}`, { decision });
}

export async function loadScreenings(
  projectId: string,
): Promise<Record<string, { decision: string; reason: string; overridden: boolean }>> {
  const { data } = await api.get(`/api/projects/${projectId}/screenings`);
  return data;
}

// ── Visual recommendations ────────────────────────────────────────────────────

export async function getVisualRecommendations(projectId: string): Promise<VisualRecommendations | null> {
  try {
    const { data } = await api.get<VisualRecommendations>(`/api/projects/${projectId}/visuals`);
    return data;
  } catch {
    return null;
  }
}

export async function planVisuals(projectId: string): Promise<VisualRecommendations> {
  const { data } = await api.post<VisualRecommendations>(`/api/projects/${projectId}/visuals/plan`);
  return data;
}

export async function acceptVisual(
  projectId: string,
  itemId: string,
  stylePreset = 'academic',
  options?: {
    candidate_count?: number;
    image_backend?: 'openai' | 'gemini_imagen' | string;
    figure_brief?: FigureBrief | null;
    prompt_package?: PromptPackage | null;
    editable_prompt?: string | null;
    style_controls?: Partial<IllustrationStyleControls> | null;
  },
): Promise<VisualRecommendations> {
  const { data } = await api.post<VisualRecommendations>(
    `/api/projects/${projectId}/visuals/${itemId}/accept`,
    {
      style_preset: stylePreset,
      ...(options ?? {}),
      ...(options?.style_controls ? {
        palette: options.style_controls.palette ?? null,
        image_background: options.style_controls.background ?? null,
        transparent_background: options.style_controls.transparent_background ?? null,
      } : {}),
    },
  );
  return data;
}

export async function dismissVisual(
  projectId: string,
  itemId: string,
): Promise<VisualRecommendations> {
  const { data } = await api.post<VisualRecommendations>(
    `/api/projects/${projectId}/visuals/${itemId}/dismiss`,
  );
  return data;
}

export async function selectVisualCandidate(
  projectId: string,
  itemId: string,
  candidateId: string,
): Promise<VisualRecommendations> {
  const { data } = await api.post<VisualRecommendations>(
    `/api/projects/${projectId}/visuals/${itemId}/select_candidate`,
    { candidate_id: candidateId },
  );
  return data;
}

export async function finalizeVisual(
  projectId: string,
  itemId: string,
  caption?: string,
  candidateId?: string,
): Promise<VisualRecommendations> {
  const { data } = await api.post<VisualRecommendations>(
    `/api/projects/${projectId}/visuals/${itemId}/finalize`,
    { caption: caption ?? null, candidate_id: candidateId ?? null },
  );
  return data;
}

export async function editVisual(
  projectId: string,
  itemId: string,
  message: string,
  context: Array<{ role: string; content: string }>,
  currentCode?: string,
  candidateId?: string,
  options?: {
    figure_brief?: FigureBrief | null;
    prompt_package?: PromptPackage | null;
    editable_prompt?: string | null;
    style_controls?: Partial<IllustrationStyleControls> | null;
  },
): Promise<{ recs: VisualRecommendations; explanation: string }> {
  const { data } = await api.post<{ recs: VisualRecommendations; explanation: string }>(
    `/api/projects/${projectId}/visuals/${itemId}/edit`,
    {
      message,
      context,
      current_code: currentCode ?? null,
      candidate_id: candidateId ?? null,
      figure_brief: options?.figure_brief ?? null,
      prompt_package: options?.prompt_package ?? null,
      editable_prompt: options?.editable_prompt ?? null,
      palette: options?.style_controls?.palette ?? null,
      image_background: options?.style_controls?.background ?? null,
      transparent_background: options?.style_controls?.transparent_background ?? null,
    },
  );
  return data;
}

export function visualImageUrl(projectId: string, itemId: string): string {
  return `/api/projects/${projectId}/visuals/${itemId}/image`;
}

export async function generateFigureBuilderCandidates(
  projectId: string,
  payload: FigureBuilderRequest,
): Promise<FigureBuilderGenerateResponse> {
  const { data } = await api.post<FigureBuilderGenerateResponse>(
    `/api/projects/${projectId}/figure_builder/generate`,
    payload,
  );
  return data;
}

export async function refineFigureBuilderCandidate(
  projectId: string,
  payload: {
    brief: FigureBrief;
    prompt_package: PromptPackage;
    candidate: IllustrationCandidate;
    instruction: string;
    image_backend?: 'openai' | 'gemini_imagen' | string;
  },
): Promise<FigureBuilderGenerateResponse> {
  const { data } = await api.post<FigureBuilderGenerateResponse>(
    `/api/projects/${projectId}/figure_builder/refine`,
    payload,
  );
  return data;
}

export function figureBuilderImageUrl(projectId: string, candidateId: string): string {
  return `/api/projects/${projectId}/figure_builder/candidates/${candidateId}/image`;
}

// ── Backward-compat re-exports (so existing imports from api/sessions still work) ──

export const createSession = createProject;
export const listSessions = listProjects;
export const loadSession = loadProject;
export const deleteSession = deleteProject;
