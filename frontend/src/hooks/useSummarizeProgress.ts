/**
 * useSummarizeProgress
 *
 * Polls the backend background summarisation task every 2 seconds.
 * Works from any component — navigation won't interrupt the backend task.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BgSummarizeStatus } from '../api/projects';
import { getSummarizeStatus, startSummarizeAllBg } from '../api/projects';
import type { Paper } from '../types/paper';

const POLL_INTERVAL_MS = 2000;

export interface UseSummarizeProgressResult {
  status: BgSummarizeStatus | null;
  isRunning: boolean;
  start: (projectId: string, papers: Paper[], query: string) => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
}

export function useSummarizeProgress(projectId: string | null): UseSummarizeProgressResult {
  const [status, setStatus] = useState<BgSummarizeStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeProjectId = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async (pid: string) => {
    try {
      const s = await getSummarizeStatus(pid);
      setStatus(s);
      if (!s.running) stopPolling();
    } catch {
      // silently ignore transient network errors
    }
  }, [stopPolling]);

  const startPolling = useCallback((pid: string) => {
    stopPolling();
    activeProjectId.current = pid;
    pollRef.current = setInterval(() => poll(pid), POLL_INTERVAL_MS);
    // immediate first fetch
    poll(pid);
  }, [poll, stopPolling]);

  // Auto-start polling when projectId changes and a task may be running
  useEffect(() => {
    if (!projectId) return;
    // Check once on mount/change — if running, keep polling
    getSummarizeStatus(projectId)
      .then((s) => {
        setStatus(s);
        if (s.running) startPolling(projectId);
      })
      .catch(() => {});
    return stopPolling;
  }, [projectId, startPolling, stopPolling]);

  const start = useCallback(async (pid: string, papers: Paper[], query: string) => {
    const s = await startSummarizeAllBg(pid, papers, query);
    setStatus(s);
    startPolling(pid);
  }, [startPolling]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    await poll(projectId);
  }, [projectId, poll]);

  return {
    status,
    isRunning: status?.running ?? false,
    start,
    stop: stopPolling,
    refresh,
  };
}
