import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type AISettings,
  type ImageBackend,
  type ImageProviderConfigEntry,
  type Provider,
  type ProviderConfigEntry,
  type ProviderModelOption,
  CLAUDE_SETUP_TOKEN_MODELS,
  IMAGE_BACKEND_DEFAULT_MODEL,
  IMAGE_BACKEND_MODELS,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_MODELS,
  fetchProviderModels,
  fetchSettings,
  revealProviderApiKey,
  saveSettings,
  startGeminiOAuth,
  testSettings,
  testSciHubMirror,
  disconnectGeminiOAuth,
} from '../../api/settings';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: AISettings) => void;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
// Navigation views: menu → ai (provider list) → ai:providerid (detail) → pdf → scihub
type View = 'menu' | 'ai' | `ai:${Provider}` | 'pdf' | 'scihub' | 'trackchanges' | 'images';

// ── Provider metadata ─────────────────────────────────────────────────────────

const PROVIDERS: { id: Provider; label: string; badge: string; dotColor: string; local?: boolean }[] = [
  { id: 'openai',   label: 'OpenAI',    badge: 'Cloud', dotColor: 'bg-emerald-500' },
  { id: 'gemini',   label: 'Gemini',    badge: 'Cloud', dotColor: 'bg-blue-500'    },
  { id: 'claude',   label: 'Claude',    badge: 'Cloud', dotColor: 'bg-orange-500'  },
  { id: 'ollama',   label: 'Ollama',    badge: 'Local', dotColor: 'bg-neutral-600', local: true },
  { id: 'llamacpp', label: 'llama.cpp', badge: 'Local', dotColor: 'bg-slate-700',   local: true },
];

const LOCAL_IDS = new Set<Provider>(['ollama', 'llamacpp']);
const IMAGE_BACKENDS: { id: ImageBackend; label: string; subtitle: string }[] = [
  { id: 'openai', label: 'OpenAI Images', subtitle: 'GPT Image 1' },
  { id: 'gemini_imagen', label: 'Gemini Imagen', subtitle: 'Imagen 3' },
];

const API_KEY_PLACEHOLDERS: Record<Provider, string> = {
  openai:   'sk-...',
  gemini:   'AIza...',
  claude:   'sk-ant-oat01-...',
  ollama:   '(not required)',
  llamacpp: 'llama-local (optional — only if server requires a key)',
};

const API_KEY_PLACEHOLDERS_FALLBACK: Partial<Record<Provider, string>> = {
  claude: 'sk-ant-api03-...',
};

function defaultBaseUrl(p: Provider): string | null {
  if (p === 'ollama')   return 'http://localhost:11434';
  if (p === 'llamacpp') return 'http://localhost:8080';
  return null;
}

// ── Provider config helpers ────────────────────────────────────────────────────

function buildDefaultConfigs(): Record<Provider, ProviderConfigEntry> {
  return {
    openai:   { auth_method: 'api_key', api_key: '', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.openai,   base_url: null,                    oauth_connected: false },
    gemini:   { auth_method: 'api_key', api_key: '', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.gemini,   base_url: null,                    oauth_connected: false },
    claude:   { auth_method: 'setup_token', api_key: '', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.claude,   base_url: null,                    oauth_connected: false },
    ollama:   { auth_method: 'api_key', api_key: '', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.ollama,   base_url: 'http://localhost:11434', oauth_connected: false },
    llamacpp: { auth_method: 'api_key', api_key: 'llama-local', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.llamacpp, base_url: 'http://localhost:8080', oauth_connected: false },
  };
}

function mergeConfigs(incoming?: Partial<Record<Provider, ProviderConfigEntry>>): Record<Provider, ProviderConfigEntry> {
  const base = buildDefaultConfigs();
  for (const id of Object.keys(base) as Provider[]) {
    const raw = incoming?.[id];
    if (!raw) continue;
    base[id] = {
      ...base[id], ...raw,
      api_key:     raw.api_key     ?? '',
      has_api_key: raw.has_api_key ?? base[id].has_api_key ?? false,
      model:       raw.model       ?? base[id].model,
      base_url:    raw.base_url    ?? base[id].base_url,
      auth_method: (raw.auth_method as string) || base[id].auth_method,
    };
  }
  return base;
}

function normalizeSettings(input: AISettings): AISettings {
  const provider = (input.provider as Provider) || 'openai';
  const configs  = mergeConfigs(input.provider_configs);
  const active   = configs[provider];
  const imageBackend = (input.image_backend as ImageBackend) || 'openai';
  const imageProviderConfigs: Partial<Record<ImageBackend, ImageProviderConfigEntry>> = {
    openai: { model: input.image_provider_configs?.openai?.model || IMAGE_BACKEND_DEFAULT_MODEL.openai, enabled: input.image_provider_configs?.openai?.enabled ?? true },
    gemini_imagen: { model: input.image_provider_configs?.gemini_imagen?.model || IMAGE_BACKEND_DEFAULT_MODEL.gemini_imagen, enabled: input.image_provider_configs?.gemini_imagen?.enabled ?? true },
  };
  const activeImageProfile = imageProviderConfigs[imageBackend];
  return {
    provider,
    model:            active?.model      || input.model || PROVIDER_DEFAULT_MODEL[provider],
    api_key:          '',
    base_url:         active?.base_url   ?? input.base_url ?? null,
    has_api_key:      input.has_api_key  ?? active?.has_api_key ?? false,
    provider_configs: configs,
    pdf_save_enabled: Boolean(input.pdf_save_enabled),
    pdf_save_path:    input.pdf_save_path  ?? null,
    sci_hub_enabled:  Boolean(input.sci_hub_enabled),
    http_proxy:       input.http_proxy     ?? null,
    scihub_mirrors:   input.scihub_mirrors ?? ['https://sci-hub.su', 'https://www.sci-hub.ren'],
    track_changes_author: input.track_changes_author ?? null,
    image_backend: imageBackend,
    image_model: input.image_model || activeImageProfile?.model || IMAGE_BACKEND_DEFAULT_MODEL[imageBackend],
    image_background: input.image_background || 'opaque',
    image_quality: input.image_quality || 'high',
    image_candidate_count: Math.max(1, Math.min(4, input.image_candidate_count || 1)),
    image_asset_mode: input.image_asset_mode || 'full_figure',
    image_provider_configs: imageProviderConfigs,
  };
}

// ── Small UI helpers ───────────────────────────────────────────────────────────

function EyeIcon({ visible }: { visible: boolean }) {
  if (visible) return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
    </svg>
  );
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer ${checked ? 'bg-brand-600' : 'bg-slate-200'}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
    </svg>
  );
}

function readErrorDetail(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const response = (err as { response?: { data?: { detail?: unknown } } }).response;
  const detail = response?.data?.detail;
  return typeof detail === 'string' ? detail : undefined;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SettingsPanel({ open, onClose, onSaved }: Props) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<AISettings>(normalizeSettings({
    provider: 'openai', model: PROVIDER_DEFAULT_MODEL.openai, api_key: '', base_url: null,
    has_api_key: false, provider_configs: buildDefaultConfigs(),
    pdf_save_enabled: false, pdf_save_path: null, sci_hub_enabled: false, http_proxy: null,
    scihub_mirrors: ['https://sci-hub.su', 'https://www.sci-hub.ren'],
    image_backend: 'openai',
    image_model: IMAGE_BACKEND_DEFAULT_MODEL.openai,
    image_background: 'opaque',
    image_quality: 'high',
    image_candidate_count: 1,
    image_asset_mode: 'full_figure',
    image_provider_configs: {
      openai: { model: IMAGE_BACKEND_DEFAULT_MODEL.openai, enabled: true },
      gemini_imagen: { model: IMAGE_BACKEND_DEFAULT_MODEL.gemini_imagen, enabled: true },
    },
  }));

  const [view,          setView]          = useState<View>('menu');
  const [showKey,       setShowKey]       = useState<Partial<Record<Provider, boolean>>>({});
  const [revealingKey,  setRevealingKey]  = useState<Partial<Record<Provider, boolean>>>({});
  const [saveState,     setSaveState]     = useState<SaveState>('idle');
  const [saveError,     setSaveError]     = useState('');
  const [testState,     setTestState]     = useState<TestState>('idle');
  const [testMessage,   setTestMessage]   = useState('');
  const [testAuthSource, setTestAuthSource] = useState('');
  const [modelsLoading, setModelsLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [modelSource,   setModelSource]   = useState<Partial<Record<Provider, string>>>({});
  const [modelAuthSource, setModelAuthSource] = useState<Partial<Record<Provider, string>>>({});
  const [dynamicModels, setDynamicModels] = useState<Partial<Record<Provider, ProviderModelOption[]>>>({});
  const [geminiAuthBusy, setGeminiAuthBusy] = useState<'idle' | 'connecting' | 'disconnecting'>('idle');

  const panelRef = useRef<HTMLDivElement>(null);

  const providerConfigs = useMemo(() => mergeConfigs(settings.provider_configs), [settings.provider_configs]);
  const activeProvider  = settings.provider as Provider;

  // ── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setView('menu');
    setTestState('idle');
    setTestAuthSource('');
    fetchSettings()
      .then((s) => setSettings(normalizeSettings(s)))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const url = new URL(window.location.href);
    const oauthStatus = url.searchParams.get('gemini_oauth');
    if (!oauthStatus) return;

    setView('ai:gemini');
    if (oauthStatus === 'success') {
      setTestState('ok');
      setTestAuthSource('oauth');
      setTestMessage('Gemini OAuth connected.');
      fetchSettings()
        .then((s) => setSettings(normalizeSettings(s)))
        .catch(() => {});
    } else {
      const raw = url.searchParams.get('msg') || 'unknown_error';
      setTestState('fail');
      setTestAuthSource('');
      setTestMessage(`Gemini OAuth failed: ${raw.replace(/_/g, ' ')}`);
    }

    url.searchParams.delete('gemini_oauth');
    url.searchParams.delete('msg');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  // Auto-fetch models only for local providers (ollama/llamacpp) — cloud providers use curated static list
  useEffect(() => {
    if (!view.startsWith('ai:')) return;
    const pid = view.slice(3) as Provider;
    if (!LOCAL_IDS.has(pid)) return;
    void loadModels(pid, false);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function updateConfig(provider: Provider, patch: Partial<ProviderConfigEntry>) {
    setSettings((prev) => {
      const merged = mergeConfigs(prev.provider_configs);
      const next   = { ...merged[provider], ...patch };
      if (patch.api_key !== undefined) next.has_api_key = Boolean(patch.api_key) || merged[provider].has_api_key;
      merged[provider] = next;
      const s: AISettings = { ...prev, provider_configs: merged };
      if (prev.provider === provider) {
        s.model       = next.model    || prev.model;
        s.base_url    = next.base_url ?? null;
        s.has_api_key = next.has_api_key ?? false;
        s.api_key     = next.api_key   ?? '';
      }
      return s;
    });
    setTestState('idle');
    setTestAuthSource('');
  }

  function switchActiveProvider(provider: Provider) {
    const cfg = providerConfigs[provider] ?? buildDefaultConfigs()[provider];
    setSettings((prev) => ({
      ...prev, provider,
      model:    cfg.model    || PROVIDER_DEFAULT_MODEL[provider],
      base_url: cfg.base_url ?? defaultBaseUrl(provider),
      api_key:  cfg.api_key  || '',
      has_api_key: cfg.has_api_key ?? false,
      provider_configs: { ...providerConfigs, [provider]: { ...cfg, base_url: cfg.base_url ?? defaultBaseUrl(provider) } },
    }));
    setTestState('idle');
    setTestAuthSource('');
  }

  async function handleRevealKey(provider: Provider) {
    const nextShow = !showKey[provider];
    const cfg = providerConfigs[provider];
    if (nextShow && !(cfg?.api_key || '') && cfg?.has_api_key) {
      setRevealingKey((s) => ({ ...s, [provider]: true }));
      try {
        const data = await revealProviderApiKey(provider);
        updateConfig(provider, { api_key: data.api_key || '', has_api_key: Boolean(data.api_key) });
      } finally {
        setRevealingKey((s) => ({ ...s, [provider]: false }));
      }
    }
    setShowKey((p) => ({ ...p, [provider]: nextShow }));
  }

  async function loadModels(provider: Provider, force = true) {
    if (!force && dynamicModels[provider]?.length) return;
    const cfg = providerConfigs[provider];
    setModelsLoading((s) => ({ ...s, [provider]: true }));
    try {
      const resp = await fetchProviderModels({
        provider,
        api_key: cfg?.api_key || '',
        base_url: cfg?.base_url ?? null,
        auth_method: cfg?.auth_method || 'api_key',
      });
      if (resp.models?.length) {
        setDynamicModels((s) => ({ ...s, [provider]: resp.models }));
        setModelSource((s) => ({ ...s, [provider]: resp.source }));
        setModelAuthSource((s) => ({ ...s, [provider]: resp.auth_source || '' }));
        if (!cfg?.model && resp.models[0]) updateConfig(provider, { model: resp.models[0].value });
      }
    } catch {
      setModelSource((s) => ({ ...s, [provider]: 'fallback' }));
      setModelAuthSource((s) => ({ ...s, [provider]: '' }));
    } finally {
      setModelsLoading((s) => ({ ...s, [provider]: false }));
    }
  }

  function buildPayload(): AISettings {
    const merged = mergeConfigs(settings.provider_configs);
    const active = merged[activeProvider];
    const imageBackend = (settings.image_backend as ImageBackend) || 'openai';
    const imageProviderConfigs = settings.image_provider_configs || {};
    const activeImageProfile = imageProviderConfigs[imageBackend];
    return {
      ...settings,
      provider:    activeProvider,
      model:       active.model    || PROVIDER_DEFAULT_MODEL[activeProvider],
      api_key:     active.api_key  || '',
      base_url:    active.base_url ?? null,
      has_api_key: active.has_api_key ?? false,
      provider_configs: merged,
      image_backend: imageBackend,
      image_model: activeImageProfile?.model || settings.image_model || IMAGE_BACKEND_DEFAULT_MODEL[imageBackend],
      image_provider_configs: imageProviderConfigs,
    };
  }

  async function handleSave() {
    setSaveState('saving');
    setSaveError('');
    try {
      const saved = await saveSettings(buildPayload());
      setSettings(normalizeSettings(saved));
      onSaved(saved);
      setSaveState('saved');
      setTimeout(() => { onClose(); setSaveState('idle'); }, 900);
    } catch (err: unknown) {
      const detail = readErrorDetail(err);
      const msg    = err instanceof Error ? err.message : 'Save failed.';
      setSaveError(detail || msg);
      setSaveState('error');
    }
  }

  async function handleTest() {
    setTestState('testing');
    setTestMessage('');
    setTestAuthSource('');
    try {
      const result = await testSettings(buildPayload());
      setTestState('ok');
      setTestMessage(result.message);
      setTestAuthSource(result.auth_source || '');
      void handleSave();
    } catch (err: unknown) {
      setTestState('fail');
      setTestAuthSource('');
      const msg    = err instanceof Error ? err.message : 'Connection failed.';
      const detail = readErrorDetail(err);
      setTestMessage(detail || msg);
    }
  }

  async function handleGeminiConnect() {
    setGeminiAuthBusy('connecting');
    setTestState('idle');
    setTestMessage('');
    setTestAuthSource('');
    try {
      const data = await startGeminiOAuth();
      window.location.href = data.auth_url;
    } catch (err: unknown) {
      setGeminiAuthBusy('idle');
      setTestState('fail');
      const msg = err instanceof Error ? err.message : 'Unable to start Gemini OAuth.';
      const detail = readErrorDetail(err);
      setTestMessage(detail || msg);
    }
  }

  async function handleGeminiDisconnect() {
    setGeminiAuthBusy('disconnecting');
    try {
      await disconnectGeminiOAuth();
      const fresh = await fetchSettings();
      const normalized = normalizeSettings(fresh);
      setSettings(normalized);
      onSaved(normalized);
      setTestState('idle');
      setTestMessage('');
      setTestAuthSource('');
    } catch (err: unknown) {
      setTestState('fail');
      const msg = err instanceof Error ? err.message : 'Unable to disconnect Gemini OAuth.';
      const detail = readErrorDetail(err);
      setTestMessage(detail || msg);
    } finally {
      setGeminiAuthBusy('idle');
    }
  }

  // ── Back-button header ───────────────────────────────────────────────────────

  function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 bg-white flex-shrink-0">
        <button type="button" onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 transition-colors flex-shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      </div>
    );
  }

  // ── VIEW: Menu (root) ────────────────────────────────────────────────────────

  const activeP     = PROVIDERS.find((p) => p.id === activeProvider)!;
  const pdfSummary  = settings.pdf_save_enabled ? (settings.pdf_save_path || 'Enabled') : 'Disabled';
  const sciSummary  = settings.sci_hub_enabled  ? 'Enabled' : 'Disabled';
  const activeImageBackend = (settings.image_backend as ImageBackend) || 'openai';
  const imageSummary = `${IMAGE_BACKENDS.find((b) => b.id === activeImageBackend)?.label || 'OpenAI Images'} · ${settings.image_model || IMAGE_BACKEND_DEFAULT_MODEL[activeImageBackend]}`;

  const MENU_ITEMS = [
    {
      key: 'ai' as const,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
      label: 'AI Provider',
      subtitle: `${activeP.label} · ${providerConfigs[activeProvider]?.model || PROVIDER_DEFAULT_MODEL[activeProvider]}`,
      badge: 'Active',
    },
    {
      key: 'images' as const,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2 1.586-1.586a2 2 0 012.828 0L20 14m-8-9h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
      label: 'Image Generation',
      subtitle: imageSummary,
      badge: 'New',
    },
    {
      key: 'pdf' as const,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      ),
      label: 'PDF Folder Path',
      subtitle: pdfSummary,
      badge: null,
    },
    {
      key: 'scihub' as const,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      ),
      label: 'Sci-Hub',
      subtitle: sciSummary,
      badge: null,
    },
    {
      key: 'trackchanges' as const,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      ),
      label: 'Track Changes',
      subtitle: settings.track_changes_author || 'Amit',
      badge: null,
    },
  ] as const;

  function MenuView() {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-5 space-y-2">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setView(item.key as View)}
              className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl border border-slate-200 bg-white hover:border-brand-300 hover:shadow-sm transition-all text-left group"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
                style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
                {item.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800">{item.label}</p>
                <p className="text-xs text-slate-500 mt-0.5 truncate">{item.subtitle}</p>
              </div>
              <svg className="w-4 h-4 text-slate-400 group-hover:text-slate-600 flex-shrink-0 transition-colors"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}

          {/* AI Usage & Costs */}
          <button
            type="button"
            onClick={() => { onClose(); navigate('/usage'); }}
            className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl border border-slate-200 bg-white hover:border-brand-300 hover:shadow-sm transition-all text-left group"
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
              style={{ background: 'var(--gold-faint)', color: 'var(--gold)' }}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800">AI Usage & Costs</p>
              <p className="text-xs text-slate-500 mt-0.5">Token consumption, costs by project and stage</p>
            </div>
            <svg className="w-4 h-4 text-slate-400 group-hover:text-slate-600 flex-shrink-0 transition-colors"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ── VIEW: AI Provider list ───────────────────────────────────────────────────

  function AIListView() {
    return (
      <>
        <SubHeader title="AI Provider" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-2">
          {PROVIDERS.map((p) => {
            const cfg      = providerConfigs[p.id];
            const isActive = activeProvider === p.id;
            const hasKey   = cfg?.has_api_key || Boolean(cfg?.api_key);
            const model    = cfg?.model || PROVIDER_DEFAULT_MODEL[p.id];

            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setView(`ai:${p.id}` as View)}
                className={`w-full flex items-center gap-4 px-4 py-4 rounded-2xl border transition-all text-left group ${
                  isActive
                    ? 'border-brand-400 bg-brand-50'
                    : 'border-slate-200 bg-white hover:border-brand-300 hover:shadow-sm'
                }`}
              >
                {/* Color dot */}
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  isActive ? 'bg-brand-600' : 'bg-slate-100'
                }`}>
                  <span className={`w-3 h-3 rounded-full ${isActive ? 'bg-white' : p.dotColor}`} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${isActive ? 'text-brand-800' : 'text-slate-800'}`}>
                      {p.label}
                    </span>
                    {isActive && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                        style={{ background: 'var(--gold)', color: '#fff' }}>
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-slate-500 truncate">{model}</span>
                    {!p.local && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${
                        hasKey ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
                      }`}>
                        {hasKey ? '✓ Key saved' : 'No key'}
                      </span>
                    )}
                    {p.local && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 font-medium flex-shrink-0">
                        Local
                      </span>
                    )}
                  </div>
                </div>

                <svg className={`w-4 h-4 flex-shrink-0 transition-colors ${
                  isActive ? 'text-brand-400' : 'text-slate-400 group-hover:text-slate-600'
                }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  // ── VIEW: Provider detail ────────────────────────────────────────────────────

  function ProviderDetailView({ pid }: { pid: Provider }) {
    const p        = PROVIDERS.find((x) => x.id === pid)!;
    const cfg      = providerConfigs[pid];
    const isActive = activeProvider === pid;
    const isLocal  = LOCAL_IDS.has(pid);
    const hasKey   = cfg?.has_api_key || Boolean(cfg?.api_key);
    const authMethod = (cfg?.auth_method || 'api_key') as string;
    const isGemini = pid === 'gemini';
    const isClaude = pid === 'claude';
    // Cloud providers (openai/gemini/claude) always use curated static list — ignore API-fetched list
    // Setup tokens are Haiku-only; show restricted list when that auth method is selected.
    const modelList = (isClaude && authMethod === 'setup_token')
      ? CLAUDE_SETUP_TOKEN_MODELS
      : (isLocal && dynamicModels[pid]?.length ? dynamicModels[pid] : PROVIDER_MODELS[pid]) ?? [];
    const currentModel = cfg?.model || PROVIDER_DEFAULT_MODEL[pid];
    const geminiUsingFallback = isGemini && testState === 'ok' && testAuthSource === 'api_key_fallback';
    const geminiUsingOAuth = isGemini && authMethod === 'oauth' && testAuthSource === 'oauth';
    const apiKeyLabel = isGemini && authMethod === 'oauth'
      ? 'Gemini API Key Fallback'
      : isClaude && authMethod === 'setup_token'
        ? 'Setup Token'
        : isLocal ? 'API Key (optional)' : 'API Key';

    return (
      <>
        <SubHeader title={p.label} onBack={() => setView('ai')} />

        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">

          {/* Active status card */}
          <div className={`rounded-2xl p-4 border flex items-center gap-3 ${
            isActive
              ? 'border-brand-300 bg-brand-50'
              : 'border-slate-200 bg-white'
          }`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isActive ? 'bg-brand-600' : 'bg-slate-100'
            }`}>
              <span className={`w-3 h-3 rounded-full ${isActive ? 'bg-white' : p.dotColor}`} />
            </div>
            <div className="flex-1">
              <p className={`text-sm font-semibold ${isActive ? 'text-brand-800' : 'text-slate-700'}`}>
                {isActive ? `${p.label} is your active provider` : `Switch to ${p.label}`}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {isActive ? 'All AI generation uses this provider.' : 'Save settings to switch.'}
              </p>
            </div>
            {!isActive && (
              <button type="button"
                onClick={() => switchActiveProvider(pid)}
                className="text-xs px-3 py-1.5 rounded-xl font-semibold transition-colors flex-shrink-0"
                style={{ background: 'var(--gold)', color: '#fff' }}>
                Set Active
              </button>
            )}
          </div>

          {isGemini && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Authentication
                </label>
                <p className="text-[11px] text-slate-500 mt-1">
                  OAuth is primary. If OAuth fails and a Gemini API key is saved, the backend retries once with the API key.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateConfig('gemini', { auth_method: 'oauth' })}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    authMethod === 'oauth'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white'
                  }`}
                >
                  Google OAuth
                </button>
                <button
                  type="button"
                  onClick={() => updateConfig('gemini', { auth_method: 'api_key' })}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    authMethod === 'api_key'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white'
                  }`}
                >
                  API Key
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {cfg?.oauth_connected && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                    OAuth connected
                  </span>
                )}
                {hasKey && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-sky-100 text-sky-700 font-medium">
                    API key fallback saved
                  </span>
                )}
                {authMethod === 'oauth' && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">
                    OAuth active
                  </span>
                )}
                {geminiUsingFallback && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-orange-100 text-orange-700 font-medium">
                    Using API key fallback
                  </span>
                )}
                {geminiUsingOAuth && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-violet-100 text-violet-700 font-medium">
                    Using OAuth
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleGeminiConnect()}
                  disabled={geminiAuthBusy !== 'idle'}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-40 transition-colors"
                  style={{ background: 'var(--gold)' }}
                >
                  {geminiAuthBusy === 'connecting'
                    ? 'Connecting...'
                    : cfg?.oauth_connected ? 'Reconnect Google' : 'Connect Google'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleGeminiDisconnect()}
                  disabled={geminiAuthBusy !== 'idle' || !cfg?.oauth_connected}
                  className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-white disabled:opacity-40 transition-colors"
                >
                  {geminiAuthBusy === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
                </button>
              </div>
            </div>
          )}

          {isClaude && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Authentication
                </label>
                <p className="text-[11px] text-slate-500 mt-1">
                  Setup Token (Haiku only) uses your Claude subscription. API Key from console.anthropic.com for Sonnet/Opus.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateConfig('claude', { auth_method: 'setup_token', model: 'claude-haiku-4-5-20251001' })}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    authMethod === 'setup_token'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white'
                  }`}
                >
                  Setup Token
                </button>
                <button
                  type="button"
                  onClick={() => updateConfig('claude', { auth_method: 'api_key' })}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    authMethod === 'api_key'
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white'
                  }`}
                >
                  API Key
                </button>
              </div>
            </div>
          )}

          {/* API Key */}
          {pid !== 'ollama' && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                {apiKeyLabel}
              </label>
              <div className="relative">
                <input
                  type={showKey[pid] ? 'text' : 'password'}
                  value={cfg?.api_key || ''}
                  onChange={(e) => updateConfig(pid, { api_key: e.target.value, has_api_key: Boolean(e.target.value) })}
                  placeholder={isClaude && authMethod === 'api_key' ? (API_KEY_PLACEHOLDERS_FALLBACK[pid] ?? API_KEY_PLACEHOLDERS[pid]) : API_KEY_PLACEHOLDERS[pid]}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 pr-12 text-sm font-mono bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {revealingKey[pid] && <Spinner />}
                  <button type="button" onClick={() => void handleRevealKey(pid)}
                    title={showKey[pid] ? 'Hide key' : hasKey ? 'Load saved key' : 'Show / hide'}
                    className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                    <EyeIcon visible={Boolean(showKey[pid])} />
                  </button>
                </div>
              </div>
              {!cfg?.api_key && cfg?.has_api_key && (
                <p className="text-[11px] text-emerald-600 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                  Key saved — click the eye icon to load it.
                </p>
              )}
              {pid === 'gemini' && (
                <p className="text-[11px] text-slate-500">
                  {authMethod === 'oauth' ? 'Saved key is used as fallback when OAuth fails. ' : 'Free API key — '}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                    className="underline" style={{ color: 'var(--gold)' }}>
                    get one at aistudio.google.com
                  </a>
                </p>
              )}
              {pid === 'openai' && (
                <p className="text-[11px] text-slate-500">
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
                    className="underline" style={{ color: 'var(--gold)' }}>
                    platform.openai.com/api-keys
                  </a>
                </p>
              )}
              {pid === 'claude' && authMethod === 'setup_token' && (
                <p className="text-[11px] text-slate-500">
                  Run <code className="bg-slate-100 px-1 rounded">claude setup-token</code> in your terminal to generate a token (starts with <code className="bg-slate-100 px-1 rounded">sk-ant-oat01-</code>).
                </p>
              )}
              {pid === 'claude' && authMethod !== 'setup_token' && (
                <p className="text-[11px] text-slate-500">
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
                    className="underline" style={{ color: 'var(--gold)' }}>
                    console.anthropic.com
                  </a>
                </p>
              )}
            </div>
          )}

          {/* Host URL for local providers */}
          {isLocal && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                {pid === 'ollama' ? 'Ollama Host URL' : 'llama.cpp Server URL'}
              </label>
              <input
                type="text"
                value={cfg?.base_url ?? defaultBaseUrl(pid) ?? ''}
                onChange={(e) => updateConfig(pid, { base_url: e.target.value || null })}
                placeholder={defaultBaseUrl(pid) ?? 'http://localhost:11434'}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
              />
            </div>
          )}

          {/* Model selector */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Model</label>
              {isLocal && (
                <button type="button" onClick={() => void loadModels(pid, true)}
                  disabled={Boolean(modelsLoading[pid])}
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors flex items-center gap-1">
                  {modelsLoading[pid] ? <><Spinner /> Fetching…</> : '↻ Fetch models'}
                </button>
              )}
            </div>

            {modelSource[pid] && (
              <p className="text-[10px] text-slate-400">
                {modelSource[pid] === 'api' ? 'Fetched live from API' : 'Using fallback list'}
              </p>
            )}
            {pid === 'gemini' && modelAuthSource[pid] && modelSource[pid] === 'api' && (
              <p className="text-[10px] text-slate-400">
                {modelAuthSource[pid] === 'oauth'
                  ? 'Gemini models fetched with OAuth'
                  : modelAuthSource[pid] === 'api_key_fallback'
                    ? 'Gemini models fetched with API key fallback'
                    : 'Gemini models fetched with API key'}
              </p>
            )}

            <select
              value={currentModel}
              onChange={(e) => updateConfig(pid, { model: e.target.value })}
              className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors">
              {modelList.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>

            {isLocal && (
              <>
                <p className="text-[10px] text-slate-400 -mt-1">Or type a model name manually:</p>
                <input
                  type="text"
                  value={currentModel}
                  onChange={(e) => updateConfig(pid, { model: e.target.value })}
                  placeholder="e.g. qwen2.5:7b, llama3.2"
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                />
              </>
            )}
          </div>

          {/* Test result */}
          {testState !== 'idle' && (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${
              testState === 'ok'   ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : testState === 'fail' ? 'bg-rose-50 border-rose-200 text-rose-700'
              : 'bg-slate-50 border-slate-200 text-slate-500'
            }`}>
              {testState === 'testing'
                ? <span className="flex items-center gap-2"><Spinner /> Testing connection…</span>
                : testMessage}
            </div>
          )}
        </div>

        {/* Footer: test + save */}
        {saveState === 'error' && saveError && (
          <div className="mx-4 mb-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Save failed: {saveError}
          </div>
        )}
        <div className="px-4 py-4 border-t border-slate-200 bg-white flex gap-3 flex-shrink-0">
          <button type="button" onClick={() => void handleTest()} disabled={testState === 'testing'}
            className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors">
            {testState === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ background: 'var(--gold)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? 'Retry' : 'Save'}
          </button>
        </div>
      </>
    );
  }

  // ── VIEW: PDF ────────────────────────────────────────────────────────────────

  function PDFView() {
    return (
      <>
        <SubHeader title="PDF Folder Path" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="flex items-start gap-3">
              <Toggle
                checked={Boolean(settings.pdf_save_enabled)}
                onChange={() => setSettings((s) => ({ ...s, pdf_save_enabled: !s.pdf_save_enabled }))}
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">Save downloaded PDFs to disk</p>
                <p className="text-xs text-slate-500 mt-0.5">Store PDFs and BibTeX in a local folder.</p>
              </div>
            </div>
            {settings.pdf_save_enabled && (
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Folder path
                </label>
                <input
                  type="text"
                  value={settings.pdf_save_path ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, pdf_save_path: e.target.value || null }))}
                  placeholder="/Users/you/Research/Papers"
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                />
              </div>
            )}
          </div>
        </div>
        <div className="px-4 py-4 border-t border-slate-200 bg-white flex-shrink-0">
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ background: 'var(--gold)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </>
    );
  }

  function updateImageProfile(backend: ImageBackend, patch: Partial<ImageProviderConfigEntry>) {
    setSettings((prev) => ({
      ...prev,
      image_provider_configs: {
        ...(prev.image_provider_configs || {}),
        [backend]: {
          ...(prev.image_provider_configs?.[backend] || { model: IMAGE_BACKEND_DEFAULT_MODEL[backend], enabled: true }),
          ...patch,
        },
      },
      ...(prev.image_backend === backend && patch.model ? { image_model: patch.model } : {}),
    }));
  }

  function ImageGenerationView() {
    const imageBackend = (settings.image_backend as ImageBackend) || 'openai';
    const imageProfile = settings.image_provider_configs?.[imageBackend];
    const imageModels = IMAGE_BACKEND_MODELS[imageBackend] || [];
    return (
      <>
        <SubHeader title="Image Generation" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Default image backend</label>
              <p className="text-xs text-slate-500 mt-1">Used for scientific illustrations and graphical abstracts. OpenAI is the default.</p>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {IMAGE_BACKENDS.map((backend) => (
                <button
                  key={backend.id}
                  type="button"
                  onClick={() => setSettings((prev) => ({
                    ...prev,
                    image_backend: backend.id,
                    image_model: prev.image_provider_configs?.[backend.id]?.model || IMAGE_BACKEND_DEFAULT_MODEL[backend.id],
                  }))}
                  className={`rounded-xl border px-3 py-3 text-left transition-colors ${imageBackend === backend.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50 hover:bg-white'}`}
                >
                  <div className="text-sm font-semibold text-slate-800">{backend.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{backend.subtitle}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Default model</label>
            <select
              value={imageProfile?.model || settings.image_model || IMAGE_BACKEND_DEFAULT_MODEL[imageBackend]}
              onChange={(e) => updateImageProfile(imageBackend, { model: e.target.value })}
              className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
            >
              {imageModels.map((model) => (
                <option key={model.value} value={model.value}>{model.label}</option>
              ))}
            </select>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Background</label>
                <select
                  value={settings.image_background || 'opaque'}
                  onChange={(e) => setSettings((prev) => ({ ...prev, image_background: e.target.value }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                >
                  <option value="opaque">Opaque</option>
                  <option value="transparent">Transparent</option>
                  <option value="auto">Auto</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Quality</label>
                <select
                  value={settings.image_quality || 'high'}
                  onChange={(e) => setSettings((prev) => ({ ...prev, image_quality: e.target.value }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="auto">Auto</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Candidate count</label>
                <select
                  value={String(settings.image_candidate_count || 1)}
                  onChange={(e) => setSettings((prev) => ({ ...prev, image_candidate_count: Number(e.target.value) }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Default mode</label>
                <select
                  value={settings.image_asset_mode || 'full_figure'}
                  onChange={(e) => setSettings((prev) => ({ ...prev, image_asset_mode: e.target.value }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                >
                  <option value="full_figure">Full figure</option>
                  <option value="asset_pack">Asset pack</option>
                  <option value="composition_reference">Composition reference</option>
                  <option value="transparent_asset">Transparent asset</option>
                </select>
              </div>
            </div>
          </div>
        </div>
        <div className="px-4 py-4 border-t border-slate-200 bg-white flex-shrink-0">
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ background: 'var(--gold)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </>
    );
  }

  // ── VIEW: Sci-Hub ────────────────────────────────────────────────────────────

  function SciHubView() {
    const [newMirror, setNewMirror]   = useState('');
    const [testing,   setTesting]     = useState<Record<string, 'idle' | 'testing' | 'ok' | 'fail'>>({});
    const [testInfo,  setTestInfo]    = useState<Record<string, string>>({});

    const mirrors: string[] = settings.scihub_mirrors ?? ['https://sci-hub.su', 'https://www.sci-hub.ren'];

    async function handleTestAndAdd() {
      const url = newMirror.trim().replace(/\/$/, '');
      if (!url) return;
      setTesting((t) => ({ ...t, [url]: 'testing' }));
      try {
        const res = await testSciHubMirror(url);
        if (res.ok) {
          setTesting((t) => ({ ...t, [url]: 'ok' }));
          const kb = res.pdf_size_bytes ? ` · ${Math.round(res.pdf_size_bytes / 1024)} KB PDF` : '';
          setTestInfo((t) => ({ ...t, [url]: `✓ ${res.latency_ms}ms${kb}` }));
          if (!mirrors.includes(url)) {
            setSettings((s) => ({ ...s, scihub_mirrors: [...(s.scihub_mirrors ?? []), url] }));
          }
          setNewMirror('');
        } else {
          setTesting((t) => ({ ...t, [url]: 'fail' }));
          setTestInfo((t) => ({ ...t, [url]: res.error ?? 'Failed' }));
        }
      } catch {
        setTesting((t) => ({ ...t, [url]: 'fail' }));
        setTestInfo((t) => ({ ...t, [url]: 'Network error' }));
      }
    }

    async function handleTestExisting(url: string) {
      setTesting((t) => ({ ...t, [url]: 'testing' }));
      try {
        const res = await testSciHubMirror(url);
        if (res.ok) {
          setTesting((t) => ({ ...t, [url]: 'ok' }));
          const kb = res.pdf_size_bytes ? ` · ${Math.round(res.pdf_size_bytes / 1024)} KB` : '';
          setTestInfo((t) => ({ ...t, [url]: `${res.latency_ms}ms${kb}` }));
        } else {
          setTesting((t) => ({ ...t, [url]: 'fail' }));
          setTestInfo((t) => ({ ...t, [url]: res.error ?? 'Failed' }));
        }
      } catch {
        setTesting((t) => ({ ...t, [url]: 'fail' }));
        setTestInfo((t) => ({ ...t, [url]: 'Network error' }));
      }
    }

    function removeMirror(url: string) {
      setSettings((s) => ({ ...s, scihub_mirrors: (s.scihub_mirrors ?? []).filter((m) => m !== url) }));
    }

    return (
      <>
        <SubHeader title="Sci-Hub" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">

          {/* Enable toggle */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="flex items-start gap-3">
              <Toggle
                checked={Boolean(settings.sci_hub_enabled)}
                onChange={() => setSettings((s) => ({ ...s, sci_hub_enabled: !s.sci_hub_enabled }))}
              />
              <div>
                <p className="text-sm font-semibold text-slate-800">Use Sci-Hub for paywalled papers</p>
                <p className="text-xs mt-0.5" style={{ color: '#b45309' }}>
                  Use responsibly and in accordance with your institution's policies.
                </p>
              </div>
            </div>
            {settings.sci_hub_enabled && (
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  HTTP Proxy (optional)
                </label>
                <input
                  type="text"
                  value={settings.http_proxy ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, http_proxy: e.target.value || null }))}
                  placeholder="http://proxy.university.edu:8080"
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
                />
                <p className="text-xs text-slate-500">For networks with restricted outbound access.</p>
              </div>
            )}
          </div>

          {/* Mirror manager */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-800">Mirror URLs</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Tried in order — first responding mirror wins. Each URL is tested against a known open-access paper before being saved.
              </p>
            </div>

            {/* Existing mirrors list */}
            <div className="space-y-2">
              {mirrors.map((url) => {
                const state = testing[url] ?? 'idle';
                const info  = testInfo[url];
                return (
                  <div key={url} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 bg-slate-50">
                    <span className="flex-1 text-xs font-mono text-slate-700 truncate" title={url}>{url}</span>
                    {state === 'testing' && (
                      <span className="text-xs text-slate-400 animate-pulse">Testing…</span>
                    )}
                    {state === 'ok' && info && (
                      <span className="text-xs text-emerald-600 font-medium">{info}</span>
                    )}
                    {state === 'fail' && info && (
                      <span className="text-xs text-red-500 font-medium truncate max-w-[120px]" title={info}>{info}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleTestExisting(url)}
                      disabled={state === 'testing'}
                      className="text-xs px-2 py-0.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-white transition-colors disabled:opacity-40"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      onClick={() => removeMirror(url)}
                      className="text-slate-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>
                );
              })}
              {mirrors.length === 0 && (
                <p className="text-xs text-slate-400 italic">No mirrors configured — add one below.</p>
              )}
            </div>

            {/* Add new mirror */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Add mirror URL
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMirror}
                  onChange={(e) => setNewMirror(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleTestAndAdd()}
                  placeholder="https://sci-hub.example.com"
                  className="flex-1 rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-mono bg-slate-50 focus:outline-none focus:border-amber-400 focus:bg-white transition-colors"
                />
                <button
                  type="button"
                  onClick={() => void handleTestAndAdd()}
                  disabled={!newMirror.trim() || testing[newMirror.trim()] === 'testing'}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-40 transition-colors whitespace-nowrap"
                  style={{ background: 'var(--gold)' }}
                >
                  {testing[newMirror.trim()] === 'testing' ? 'Testing…' : 'Test & Add'}
                </button>
              </div>
              {testing[newMirror.trim()] === 'fail' && testInfo[newMirror.trim()] && (
                <p className="text-xs text-red-500">{testInfo[newMirror.trim()]}</p>
              )}
              <p className="text-xs text-slate-400">
                Mirror is tested against a real paper — only added if it responds with a PDF.
              </p>
            </div>
          </div>
        </div>
        <div className="px-4 py-4 border-t border-slate-200 bg-white flex-shrink-0">
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ background: 'var(--gold)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </>
    );
  }

  // ── VIEW: Track Changes ─────────────────────────────────────────────────────

  function TrackChangesView() {
    return (
      <>
        <SubHeader title="Track Changes" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Author Name
              </label>
              <input
                type="text"
                value={settings.track_changes_author ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, track_changes_author: e.target.value || null }))}
                placeholder="Amit"
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-slate-50 focus:outline-none focus:border-brand-500 focus:bg-white transition-colors"
              />
              <p className="text-xs text-slate-500">
                Default author name shown in Word track changes. You can override it at export time.
              </p>
            </div>
          </div>
        </div>
        <div className="px-4 py-4 border-t border-slate-200 bg-white flex-shrink-0">
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-colors"
            style={{ background: 'var(--gold)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const isProviderDetail = view.startsWith('ai:');
  const detailPid = isProviderDetail ? (view.slice(3) as Provider) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm">
      <div ref={panelRef} className="w-full max-w-sm bg-slate-50 h-full shadow-2xl flex flex-col">

        {/* Top header — always shown */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--gold-faint)' }}>
              <svg className="w-4 h-4" style={{ color: 'var(--gold)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h2 className="font-semibold text-slate-800 text-sm">Settings</h2>
          </div>
          <button type="button" onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* View content */}
        {view === 'menu'    && <MenuView />}
        {view === 'ai'      && <AIListView />}
        {view === 'images'  && <ImageGenerationView />}
        {view === 'pdf'     && <PDFView />}
        {view === 'scihub'  && <SciHubView />}
        {view === 'trackchanges' && <TrackChangesView />}
        {detailPid          && <ProviderDetailView pid={detailPid} />}

      </div>
    </div>
  );
}
