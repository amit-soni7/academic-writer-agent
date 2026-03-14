import api from './client';
import type { CommentChangeSuggestion, CommentPlan, ImportManuscriptResult, JournalRecommendation, JournalStyle, Paper, PaperSummary, PeerReviewReport, ProjectMeta, RealReviewerComment, RevisionResult, RevisionRound, SynthesisResult } from '../types/paper';

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

export async function recommendJournals(projectId: string): Promise<JournalRecommendation[]> {
  const { data } = await api.post<JournalRecommendation[]>(
    `/api/projects/${projectId}/recommend_journals`
  );
  return data;
}

export async function writeArticle(
  projectId: string,
  selectedJournal: string,
  articleType: string,
  wordLimit: number,
  maxReferences?: number,
): Promise<{ article: string; word_count: number; ref_count: number; ref_limit?: number | null; word_limit: number }> {
  const { data } = await api.post(`/api/projects/${projectId}/write_article_sync`, {
    session_id: projectId,
    project_id: projectId,
    selected_journal: selectedJournal,
    article_type: articleType,
    word_limit: wordLimit,
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
  paper_key?: string;
  summary?: PaperSummary;
  message?: string;
  done?: number;
  errors?: number;
  project_id?: string;
  session_id?: string; // backward-compat
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

export function downloadPointByPointDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/point_by_point_docx`;
}

export function downloadRevisedManuscriptDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/revised_manuscript_docx`;
}

export function downloadTrackChangesDocx(projectId: string, roundNumber: number): string {
  return `${API_BASE}/api/projects/${projectId}/revision_rounds/${roundNumber}/track_changes_docx`;
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

// ── Backward-compat re-exports (so existing imports from api/sessions still work) ──

export const createSession = createProject;
export const listSessions = listProjects;
export const loadSession = loadProject;
export const deleteSession = deleteProject;
