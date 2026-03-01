import api from './client';
import type { JournalRecommendation, JournalStyle, Paper, PaperSummary, PeerReviewReport, ProjectMeta, RevisionResult, SynthesisResult } from '../types/paper';

export async function createProject(
  query: string,
  papers: Paper[],
  articleType?: string,
  projectDescription?: string,
  tentativeTitle?: string,
): Promise<ProjectMeta> {
  const { data } = await api.post<ProjectMeta>('/api/projects', {
    query,
    papers,
    ...(articleType ? { article_type: articleType } : {}),
    ...(projectDescription ? { project_description: projectDescription } : {}),
    ...(tentativeTitle ? { project_name: tentativeTitle } : {}),
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

export async function generatePeerReview(projectId: string): Promise<PeerReviewReport> {
  const { data } = await api.post<PeerReviewReport>(`/api/projects/${projectId}/peer_review`);
  return data;
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
  type: 'progress' | 'summary_done' | 'paper_error' | 'complete' | 'error';
  current?: number;
  total?: number;
  title?: string;
  skipped?: boolean;
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
}

// Backward-compat alias
export type SessionData = ProjectData;

// ── Backward-compat re-exports (so existing imports from api/sessions still work) ──

export const createSession = createProject;
export const listSessions = listProjects;
export const loadSession = loadProject;
export const deleteSession = deleteProject;
