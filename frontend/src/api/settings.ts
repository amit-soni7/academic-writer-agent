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
}

export interface ProviderModelOption {
  value: string;
  label: string;
}

export const OPENAI_MODELS = [
  { value: 'gpt-4o',         label: 'GPT-4o  (stable · recommended)' },
  { value: 'gpt-4o-mini',    label: 'GPT-4o mini  (fast · cheap)' },
  { value: 'gpt-4.1',        label: 'GPT-4.1  (smartest non-reasoning)' },
  { value: 'gpt-5',          label: 'GPT-5  (reasoning · configurable effort)' },
  { value: 'gpt-5-mini',     label: 'GPT-5 mini  (fast · cost-efficient)' },
  { value: 'gpt-5-nano',     label: 'GPT-5 nano  (fastest · cheapest)' },
  { value: 'gpt-5.2',        label: 'GPT-5.2  (best · coding & agentic tasks)' },
  { value: 'gpt-5.2-pro',    label: 'GPT-5.2 Pro  (smarter · most precise)' },
];

export const GEMINI_MODELS = [
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro  (latest · preview)' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash  (frontier performance · preview)' },
  { value: 'gemini-3-pro-preview',   label: 'Gemini 3 Pro  (preview)' },
  { value: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash  (best price-performance)' },
  { value: 'gemini-2.5-flash-live',  label: 'Gemini 2.5 Flash Live  (real-time streaming)' },
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
  openai:   'gpt-4o',
  gemini:   'gemini-3.1-pro-preview',
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
): Promise<{ status: string; message: string }> {
  const { data } = await api.post('/api/settings/test', settings);
  return data;
}

export async function revealProviderApiKey(
  provider: Provider,
): Promise<{ provider: string; api_key: string }> {
  const { data } = await api.post('/api/settings/reveal-key', { provider });
  return data;
}

export async function fetchProviderModels(
  payload: { provider: Provider; api_key?: string; base_url?: string | null },
): Promise<{ provider: string; source: string; models: ProviderModelOption[] }> {
  const { data } = await api.post('/api/settings/models', payload);
  return data;
}

export async function startGeminiOAuth(): Promise<{ auth_url: string }> {
  const { data } = await api.get<{ auth_url: string }>('/api/auth/gemini/connect');
  return data;
}

export async function disconnectGeminiOAuth(): Promise<void> {
  await api.post('/api/auth/gemini/disconnect');
}
