import api from './client';
import type { CriticalSummary, Paper, PaperSummary, SearchResponse } from '../types/paper';

// ── SSE streaming search ───────────────────────────────────────────────────────

export interface SSEEvent {
  type:
    | 'ai_queries'
    | 'papers'
    | 'source_error'
    | 'source_done'
    | 'deduplicating'
    | 'ranking'
    | 'enriching'
    | 'complete'
    | 'warning'
    | 'error';
  source?: string;
  count?: number;
  papers?: Paper[];
  data?: {
    queries: string[];
    pubmed_queries: string[];
    mesh_terms: string[];
    boolean_query: string;
    pico: { population: string; intervention: string; comparator: string; outcome: string };
    study_type_filters: string[];
    rationale: string;
    facets: Record<string, { mesh: string[]; freetext: string[] }>;
    strategy_notes: string[];
    framework_used?: string;
    framework_justification?: string;
  };
  before?: number;
  after?: number;
  total?: number;
  message?: string;
  // ranking event
  candidates?: number;
  selected?: number;
  requested?: number;
}

/**
 * Async generator that POSTs to /api/search_stream and yields parsed SSE events.
 * Uses fetch + ReadableStream because EventSource only supports GET.
 */
export async function* streamSearch(
  query: string,
  totalLimit: number,
  useAiExpansion = true,
  articleType?: string,
): AsyncGenerator<SSEEvent> {
  const response = await fetch('http://localhost:8010/api/search_stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      query,
      total_limit: totalLimit,
      use_ai_expansion: useAiExpansion,
      ...(articleType ? { article_type: articleType } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} from search_stream`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by double newlines
      const frames = buffer.split('\n\n');
      buffer = frames.pop()!; // incomplete trailing frame stays in buffer

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6)) as SSEEvent;
        } catch {
          // skip malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function searchLiterature(
  query: string,
  maxPerSource = 5,
): Promise<SearchResponse> {
  const { data } = await api.post<SearchResponse>('/api/search_literature', {
    query,
    max_results_per_source: maxPerSource,
  });
  return data;
}

export async function generateSummary(
  papers: Paper[],
  keyIdea?: string,
): Promise<CriticalSummary> {
  const { data } = await api.post<CriticalSummary>('/api/generate_summary', {
    papers,
    key_idea: keyIdea,
  });
  return data;
}

export async function summarizePaper(
  paper: Paper,
  query: string,
  sessionId = '',
): Promise<PaperSummary> {
  const { data } = await api.post<PaperSummary>('/api/summarize_paper', {
    paper,
    query,
    session_id: sessionId,
  });
  return data;
}
