import api from './client';

export interface UsageTotals {
  user_id: string;
  days: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  call_count: number;
}

export interface ProviderUsage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  call_count: number;
}

export interface DailyUsage {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  call_count: number;
}

export interface ProjectUsage {
  project_id: string;
  project_name: string | null;
  current_phase: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  call_count: number;
}

export interface ProjectStageCost {
  stage: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  call_count: number;
}

export async function fetchUsageTotals(days = 30): Promise<UsageTotals> {
  const { data } = await api.get<UsageTotals>('/api/usage', { params: { days } });
  return data;
}

export async function fetchProviderUsage(days = 30): Promise<ProviderUsage[]> {
  const { data } = await api.get<ProviderUsage[]>('/api/usage/providers', { params: { days } });
  return data;
}

export async function fetchDailyUsage(days = 30): Promise<DailyUsage[]> {
  const { data } = await api.get<DailyUsage[]>('/api/usage/daily', { params: { days } });
  return data;
}

export async function fetchProjectsUsage(days = 30): Promise<ProjectUsage[]> {
  const { data } = await api.get<ProjectUsage[]>('/api/usage/projects', { params: { days } });
  return data;
}

export async function fetchStagesUsage(days = 30): Promise<ProjectStageCost[]> {
  const { data } = await api.get<ProjectStageCost[]>('/api/usage/stages', { params: { days } });
  return data;
}

export async function fetchProjectStages(projectId: string): Promise<ProjectStageCost[]> {
  const { data } = await api.get<ProjectStageCost[]>(`/api/usage/projects/${projectId}/stages`);
  return data;
}
