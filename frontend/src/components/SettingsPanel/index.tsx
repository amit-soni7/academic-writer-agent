import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AISettings,
  type Provider,
  type ProviderConfigEntry,
  type ProviderModelOption,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_MODELS,
  fetchProviderModels,
  fetchSettings,
  revealProviderApiKey,
  saveSettings,
  testSettings,
} from '../../api/settings';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: AISettings) => void;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
// Navigation views: menu → ai (provider list) → ai:providerid (detail) → pdf → scihub
type View = 'menu' | 'ai' | `ai:${Provider}` | 'pdf' | 'scihub';

// ── Provider metadata ─────────────────────────────────────────────────────────

const PROVIDERS: { id: Provider; label: string; badge: string; dotColor: string; local?: boolean }[] = [
  { id: 'openai',   label: 'OpenAI',    badge: 'Cloud', dotColor: 'bg-emerald-500' },
  { id: 'gemini',   label: 'Gemini',    badge: 'Cloud', dotColor: 'bg-blue-500'    },
  { id: 'claude',   label: 'Claude',    badge: 'Cloud', dotColor: 'bg-orange-500'  },
  { id: 'ollama',   label: 'Ollama',    badge: 'Local', dotColor: 'bg-neutral-600', local: true },
  { id: 'llamacpp', label: 'llama.cpp', badge: 'Local', dotColor: 'bg-slate-700',   local: true },
];

const LOCAL_IDS = new Set<Provider>(['ollama', 'llamacpp']);

const API_KEY_PLACEHOLDERS: Record<Provider, string> = {
  openai:   'sk-...',
  gemini:   'AIza...',
  claude:   'sk-ant-...',
  ollama:   '(not required)',
  llamacpp: 'llama-local (optional — only if server requires a key)',
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
    claude:   { auth_method: 'api_key', api_key: '', has_api_key: false, model: PROVIDER_DEFAULT_MODEL.claude,   base_url: null,                    oauth_connected: false },
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function SettingsPanel({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AISettings>(normalizeSettings({
    provider: 'openai', model: PROVIDER_DEFAULT_MODEL.openai, api_key: '', base_url: null,
    has_api_key: false, provider_configs: buildDefaultConfigs(),
    pdf_save_enabled: false, pdf_save_path: null, sci_hub_enabled: false, http_proxy: null,
  }));

  const [view,          setView]          = useState<View>('menu');
  const [showKey,       setShowKey]       = useState<Partial<Record<Provider, boolean>>>({});
  const [revealingKey,  setRevealingKey]  = useState<Partial<Record<Provider, boolean>>>({});
  const [saveState,     setSaveState]     = useState<SaveState>('idle');
  const [saveError,     setSaveError]     = useState('');
  const [testState,     setTestState]     = useState<TestState>('idle');
  const [testMessage,   setTestMessage]   = useState('');
  const [modelsLoading, setModelsLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [modelSource,   setModelSource]   = useState<Partial<Record<Provider, string>>>({});
  const [dynamicModels, setDynamicModels] = useState<Partial<Record<Provider, ProviderModelOption[]>>>({});

  const panelRef = useRef<HTMLDivElement>(null);

  const providerConfigs = useMemo(() => mergeConfigs(settings.provider_configs), [settings.provider_configs]);
  const activeProvider  = settings.provider as Provider;

  // ── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setView('menu');
    setTestState('idle');
    fetchSettings()
      .then((s) => setSettings(normalizeSettings(s)))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  // Auto-fetch models when entering a provider detail view
  useEffect(() => {
    if (!view.startsWith('ai:')) return;
    const pid = view.slice(3) as Provider;
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
      const resp = await fetchProviderModels({ provider, api_key: cfg?.api_key || '', base_url: cfg?.base_url ?? null });
      if (resp.models?.length) {
        setDynamicModels((s) => ({ ...s, [provider]: resp.models }));
        setModelSource((s) => ({ ...s, [provider]: resp.source }));
        if (!cfg?.model && resp.models[0]) updateConfig(provider, { model: resp.models[0].value });
      }
    } catch {
      setModelSource((s) => ({ ...s, [provider]: 'fallback' }));
    } finally {
      setModelsLoading((s) => ({ ...s, [provider]: false }));
    }
  }

  function buildPayload(): AISettings {
    const merged = mergeConfigs(settings.provider_configs);
    const active = merged[activeProvider];
    return {
      ...settings,
      provider:    activeProvider,
      model:       active.model    || PROVIDER_DEFAULT_MODEL[activeProvider],
      api_key:     active.api_key  || '',
      base_url:    active.base_url ?? null,
      has_api_key: active.has_api_key ?? false,
      provider_configs: merged,
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
      const detail = (err as any)?.response?.data?.detail;
      const msg    = err instanceof Error ? err.message : 'Save failed.';
      setSaveError(detail || msg);
      setSaveState('error');
    }
  }

  async function handleTest() {
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await testSettings(buildPayload());
      setTestState('ok');
      setTestMessage(result.message);
      void handleSave();
    } catch (err: unknown) {
      setTestState('fail');
      const msg    = err instanceof Error ? err.message : 'Connection failed.';
      const detail = (err as any)?.response?.data?.detail;
      setTestMessage(detail || msg);
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
    const modelList = (dynamicModels[pid]?.length ? dynamicModels[pid] : PROVIDER_MODELS[pid]) ?? [];
    const currentModel = cfg?.model || PROVIDER_DEFAULT_MODEL[pid];

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

          {/* API Key */}
          {pid !== 'ollama' && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                {isLocal ? 'API Key (optional)' : 'API Key'}
              </label>
              <div className="relative">
                <input
                  type={showKey[pid] ? 'text' : 'password'}
                  value={cfg?.api_key || ''}
                  onChange={(e) => updateConfig(pid, { api_key: e.target.value, has_api_key: Boolean(e.target.value) })}
                  placeholder={API_KEY_PLACEHOLDERS[pid]}
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
                  Free API key —{' '}
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
              {pid === 'claude' && (
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
              <button type="button" onClick={() => void loadModels(pid, true)}
                disabled={Boolean(modelsLoading[pid])}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors flex items-center gap-1">
                {modelsLoading[pid] ? <><Spinner /> Fetching…</> : '↻ Fetch models'}
              </button>
            </div>

            {modelSource[pid] && (
              <p className="text-[10px] text-slate-400">
                {modelSource[pid] === 'api' ? 'Fetched live from API' : 'Using fallback list'}
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

  // ── VIEW: Sci-Hub ────────────────────────────────────────────────────────────

  function SciHubView() {
    return (
      <>
        <SubHeader title="Sci-Hub" onBack={() => setView('menu')} />
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
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
        {view === 'pdf'     && <PDFView />}
        {view === 'scihub'  && <SciHubView />}
        {detailPid          && <ProviderDetailView pid={detailPid} />}

      </div>
    </div>
  );
}
