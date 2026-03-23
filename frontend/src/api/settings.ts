import api from './client';

export type Provider = 'openai' | 'gemini' | 'claude' | 'ollama' | 'llamacpp';
export type ProviderAuthMethod = 'api_key' | 'oauth';

export interface ProviderConfigEntry {
  auth_method: ProviderAuthMethod | string;
  api_key: string;
  has_api_key?: boolean;
  model?: string | null;
  base_url?: string | null;
  oauth_connected?: boolean;
}

export interface AISettings {
  provider: string;
  model: string;
  api_key: string;
  base_url?: string | null;
  has_api_key?: boolean;
  provider_configs?: Partial<Record<Provider, ProviderConfigEntry>>;
  // PDF persistence
  pdf_save_enabled?: boolean;
  pdf_save_path?: string | null;
  // Sci-Hub
  sci_hub_enabled?: boolean;
  http_proxy?: string | null;
  scihub_mirrors?: string[];
  // Track Changes
  track_changes_author?: string | null;
}

export interface ProviderModelOption {
  value: string;
  label: string;
}

export interface SettingsTestResponse {
  status: string;
  message: string;
  auth_source?: string | null;
}

export interface ProviderModelsResponsePayload {
  provider: string;
  source: string;
  auth_source?: string | null;
  models: ProviderModelOption[];
}

export const OPENAI_MODELS = [
  { value: 'gpt-5.4',      label: 'GPT-5.4  (best intelligence · agentic, coding & professional)' },
  { value: 'gpt-5.4-pro',  label: 'GPT-5.4 Pro  (smarter · more precise responses)' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini  (strongest mini · coding & subagents)' },
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano  (cheapest · simple high-volume tasks)' },
  { value: 'gpt-5-mini',   label: 'GPT-5 mini  (near-frontier · cost-sensitive & low-latency)' },
  { value: 'gpt-5-nano',   label: 'GPT-5 nano  (fastest · most cost-efficient)' },
  { value: 'gpt-5',        label: 'GPT-5  (reasoning · coding & agentic tasks)' },
  { value: 'gpt-4.1',      label: 'GPT-4.1  (smartest non-reasoning model)' },
];

export const GEMINI_MODELS = [
  { value: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash  (best price-performance · recommended)' },
  { value: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro  (most capable)' },
  { value: 'gemini-2.0-flash',       label: 'Gemini 2.0 Flash  (fast · stable)' },
  { value: 'gemini-1.5-pro',         label: 'Gemini 1.5 Pro  (long context)' },
  { value: 'gemini-1.5-flash',       label: 'Gemini 1.5 Flash  (lightweight · fast)' },
];

export const CLAUDE_MODELS = [
  { value: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6  (best quality)' },
  { value: 'claude-opus-4-6',             label: 'Claude Opus 4.6  (most capable)' },
  { value: 'claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5  (fast · cheap)' },
];

export const OLLAMA_MODELS = [
  { value: 'qwen2.5:7b',     label: 'Qwen 2.5 7B  (Alibaba)' },
  { value: 'qwen2.5:3b',     label: 'Qwen 2.5 3B  (Alibaba · fast)' },
  { value: 'llama3.2',       label: 'Llama 3.2  (Meta)' },
  { value: 'llama3.1',       label: 'Llama 3.1  (Meta)' },
  { value: 'mistral',        label: 'Mistral 7B' },
  { value: 'phi4',           label: 'Phi-4  (Microsoft)' },
  { value: 'deepseek-r1',    label: 'DeepSeek R1' },
  { value: 'gemma3',         label: 'Gemma 3  (Google)' },
];

export const LLAMACPP_MODELS = [
  { value: 'qwen2.5-3b-instruct-q4_k_m.gguf', label: 'Qwen 2.5 3B Instruct Q4_K_M  (default)' },
  { value: 'qwen2.5:3b',        label: 'Qwen 2.5 3B' },
  { value: 'qwen2.5:7b',        label: 'Qwen 2.5 7B' },
  { value: 'llama-3.2-3b',      label: 'Llama 3.2 3B  (Meta)' },
  { value: 'llama-3.1-8b',      label: 'Llama 3.1 8B  (Meta)' },
  { value: 'mistral-7b',        label: 'Mistral 7B' },
  { value: 'phi-4',             label: 'Phi-4  (Microsoft)' },
  { value: 'deepseek-r1-7b',    label: 'DeepSeek R1 7B' },
];

export const PROVIDER_MODELS: Record<Provider, { value: string; label: string }[]> = {
  openai:   OPENAI_MODELS,
  gemini:   GEMINI_MODELS,
  claude:   CLAUDE_MODELS,
  ollama:   OLLAMA_MODELS,
  llamacpp: LLAMACPP_MODELS,
};

export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  openai:   'gpt-5.4',
  gemini:   'gemini-2.5-flash',
  claude:   'claude-sonnet-4-6',
  ollama:   'qwen2.5:7b',
  llamacpp: 'qwen2.5-3b-instruct-q4_k_m.gguf',
};

export async function fetchSettings(): Promise<AISettings> {
  const { data } = await api.get<AISettings>('/api/settings');
  return data;
}

export async function saveSettings(settings: AISettings): Promise<AISettings> {
  const { data } = await api.post<AISettings>('/api/settings', settings);
  return data;
}

export async function testSettings(
  settings: AISettings,
): Promise<SettingsTestResponse> {
  const { data } = await api.post<SettingsTestResponse>('/api/settings/test', settings);
  return data;
}

export async function revealProviderApiKey(
  provider: Provider,
): Promise<{ provider: string; api_key: string }> {
  const { data } = await api.post('/api/settings/reveal-key', { provider });
  return data;
}

export async function testSciHubMirror(
  url: string,
): Promise<{ ok: boolean; latency_ms?: number; pdf_size_bytes?: number; error?: string }> {
  const { data } = await api.post('/api/settings/test-scihub-mirror', { url });
  return data;
}

export async function fetchProviderModels(
  payload: { provider: Provider; api_key?: string; base_url?: string | null; auth_method?: string },
): Promise<ProviderModelsResponsePayload> {
  const { data } = await api.post<ProviderModelsResponsePayload>('/api/settings/models', payload);
  return data;
}

export async function startGeminiOAuth(): Promise<{ auth_url: string }> {
  const { data } = await api.get<{ auth_url: string }>('/api/auth/gemini/connect');
  return data;
}

export async function disconnectGeminiOAuth(): Promise<void> {
  await api.post('/api/auth/gemini/disconnect');
}
