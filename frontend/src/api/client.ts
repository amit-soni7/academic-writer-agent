import axios from 'axios';
import type { IntentRequest, IntentResponse } from '../types/intent';

const api = axios.create({
  baseURL: (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8010',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 300_000, // 5 min — local LLMs are slow
});

export async function submitIntent(payload: IntentRequest): Promise<IntentResponse> {
  const { data } = await api.post<IntentResponse>('/api/intent', payload);
  return data;
}

export default api;
