import api from './client';

export interface CrossRefEvent {
  type:
    | 'start'
    | 'resolving'
    | 'paper_done'
    | 'skip'
    | 'depth_complete'
    | 'complete'
    | 'warning'
    | 'error';
  depth?: number;
  total_cited?: number;
  to_process?: number;
  skipped_already_in_session?: number;
  priority_intro_hits?: number;
  priority_discussion_hits?: number;
  ref?: string;
  index?: number;
  total?: number;
  paper_key?: string;
  title?: string;
  text_source?: string;
  triage_decision?: string;
  one_line_takeaway?: string;
  focus_notes?: string[];   // intro/discussion claim snippets that drove this fetch
  success?: boolean;
  error?: string;
  reason?: string;
  fetched?: number;
  failed?: number;
  total_fetched?: number;
  by_depth?: Record<string, number>;
  message?: string;
}

export interface CrossRefStats {
  total: number;
  by_depth: Record<string, number>;
}

export function streamCrossReferences(
  sessionId: string,
  depth: 1 | 2,
  onEvent: (event: CrossRefEvent) => void,
): EventSource {
  // Use fetch-based SSE via POST (EventSource only supports GET)
  // We implement a simple fetch-based reader instead.
  // Return a fake EventSource-like object with a close() method.
  const controller = new AbortController();

  const run = async () => {
    try {
      const resp = await fetch(
        `${(api.defaults as any).baseURL}/api/projects/${sessionId}/stream_cross_references`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depth }),
          credentials: 'include',
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        onEvent({ type: 'error', message: `HTTP ${resp.status}` });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6)) as CrossRefEvent;
              onEvent(evt);
            } catch {
              /* ignore malformed */
            }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        onEvent({ type: 'error', message: String(err) });
      }
    }
  };

  run();

  // Return a handle with close() to abort the stream
  return { close: () => controller.abort() } as unknown as EventSource;
}

export async function getCrossRefStats(sessionId: string): Promise<CrossRefStats> {
  const { data } = await api.get<CrossRefStats>(
    `/api/projects/${sessionId}/cross_reference_stats`,
  );
  return data;
}
