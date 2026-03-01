import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
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
type SectionKey = 'ai' | 'pdf' | 'scihub';

// ── Provider metadata ─────────────────────────────────────────────────────────

const PROVIDERS: { id: Provider; label: string; badge: string; dotColor: string; local?: boolean }[] = [
  { id: 'openai',   label: 'OpenAI',    badge: 'Cloud', dotColor: 'bg-emerald-500' },
  { id: 'gemini',   label: 'Gemini',    badge: 'Cloud', dotColor: 'bg-blue-500'    },
  { id: 'claude',   label: 'Claude',    badge: 'Cloud', dotColor: 'bg-orange-500'  },
  { id: 'ollama',   label: 'Ollama',    badge: 'Local', dotColor: 'bg-neutral-600', local: true },
  { id: 'llamacpp', label: 'llama.cpp', badge: 'Local', dotColor: 'bg-slate-700',   local: true },
];

const CLOUD_PROVIDERS = PROVIDERS.filter((p) => !p.local);
const LOCAL_PROVIDERS_LIST = PROVIDERS.filter((p) => p.local);
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

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

function Section({ title, subtitle, open, onToggle, children }: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>}
        </div>
        <Chevron open={open} />
      </button>
      <div className={`grid transition-[grid-template-rows] duration-300 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-4 pb-5 pt-2 border-t border-slate-100">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SettingsPanel({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AISettings>(normalizeSettings({
    provider: 'openai', model: PROVIDER_DEFAULT_MODEL.openai, api_key: '', base_url: null,
    has_api_key: false, provider_configs: buildDefaultConfigs(),
    pdf_save_enabled: false, pdf_save_path: null, sci_hub_enabled: false, http_proxy: null,
  }));

  const [sections,         setSections]         = useState<Record<SectionKey, boolean>>({ ai: true, pdf: false, scihub: false });
  const [cardExpanded,     setCardExpanded]     = useState<Partial<Record<Provider, boolean>>>({ openai: true });
  const [showKey,          setShowKey]          = useState<Partial<Record<Provider, boolean>>>({});
  const [revealingKey,     setRevealingKey]     = useState<Partial<Record<Provider, boolean>>>({});
  const [saveState,        setSaveState]        = useState<SaveState>('idle');
  const [saveError,        setSaveError]        = useState('');
  const [testState,        setTestState]        = useState<TestState>('idle');
  const [testMessage,      setTestMessage]      = useState('');
  const [modelsLoading,    setModelsLoading]    = useState<Partial<Record<Provider, boolean>>>({});
  const [modelSource,      setModelSource]      = useState<Partial<Record<Provider, string>>>({});
  const [dynamicModels,    setDynamicModels]    = useState<Partial<Record<Provider, ProviderModelOption[]>>>({});

  const panelRef = useRef<HTMLDivElement>(null);

  const providerConfigs = useMemo(() => mergeConfigs(settings.provider_configs), [settings.provider_configs]);
  const activeProvider  = settings.provider as Provider;

  // ── Effects ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    fetchSettings()
      .then((s) => {
        const norm = normalizeSettings(s);
        setSettings(norm);
        setCardExpanded({ [norm.provider as Provider]: true });
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function toggleSection(key: SectionKey) {
    setSections((p) => ({ ...p, [key]: !p[key] }));
  }

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
    setCardExpanded((p) => ({ ...p, [provider]: true }));
    setTestState('idle');
  }

  function toggleCard(provider: Provider) {
    const willOpen = !cardExpanded[provider];
    setCardExpanded((p) => ({ ...p, [provider]: willOpen }));
    if (willOpen) void loadModels(provider, false);
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
      // Auto-save on successful test so the provider is always persisted to DB.
      void handleSave();
    } catch (err: unknown) {
      setTestState('fail');
      const msg    = err instanceof Error ? err.message : 'Connection failed.';
      const detail = (err as any)?.response?.data?.detail;
      setTestMessage(detail || msg);
    }
  }

  // ── Per-provider card ────────────────────────────────────────────────────────

  function ProviderCard({ p }: { p: typeof PROVIDERS[0] }) {
    const cfg      = providerConfigs[p.id];
    const isActive = activeProvider === p.id;
    const isLocal  = LOCAL_IDS.has(p.id);
    const hasKey   = cfg?.has_api_key || Boolean(cfg?.api_key);
    const expanded = Boolean(cardExpanded[p.id]);
    const modelList = (dynamicModels[p.id]?.length ? dynamicModels[p.id] : PROVIDER_MODELS[p.id]) ?? [];
    const currentModel = cfg?.model || PROVIDER_DEFAULT_MODEL[p.id];

    return (
      <div className={`rounded-xl border overflow-hidden transition-shadow ${
        isActive ? 'border-brand-400 shadow-sm' : 'border-slate-200'
      }`}>

        {/* Card header */}
        <button type="button" onClick={() => toggleCard(p.id)}
          className={`w-full px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors ${
            expanded ? 'bg-slate-50' : 'bg-white hover:bg-slate-50'
          }`}>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.dotColor}`} />
          <span className="text-sm font-medium text-slate-800 flex-1">{p.label}</span>

          {/* Badges */}
          <div className="flex items-center gap-1.5">
            {isActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 font-semibold">
                Active
              </span>
            )}
            {!isLocal && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                hasKey ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
              }`}>
                {hasKey ? '✓ Key saved' : 'No key'}
              </span>
            )}
            {isLocal && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium">
                Local
              </span>
            )}
            <span className="text-[11px] text-slate-400 max-w-[80px] truncate hidden sm:block">
              {currentModel}
            </span>
          </div>
          <Chevron open={expanded} />
        </button>

        {/* Expanded body */}
        <div className={`grid transition-[grid-template-rows] duration-200 ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="border-t border-slate-100 bg-white px-3 pb-3 pt-3 space-y-3">

              {/* Set as active */}
              {!isActive && (
                <button type="button" onClick={() => switchActiveProvider(p.id)}
                  className="w-full text-xs px-3 py-1.5 rounded-lg bg-brand-50 border border-brand-200 text-brand-700 font-medium hover:bg-brand-100 transition-colors">
                  Use {p.label} as active provider
                </button>
              )}

              {/* API Key — cloud always; llama.cpp optional; ollama not shown */}
              {p.id !== 'ollama' && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {isLocal ? 'API Key (optional)' : 'API Key'}
                  </label>
                  <div className="relative">
                    <input
                      type={showKey[p.id] ? 'text' : 'password'}
                      value={cfg?.api_key || ''}
                      onChange={(e) => updateConfig(p.id, { api_key: e.target.value, has_api_key: Boolean(e.target.value) })}
                      placeholder={API_KEY_PLACEHOLDERS[p.id]}
                      className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 pr-14 text-sm font-mono bg-white focus:outline-none focus:border-brand-500"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      {revealingKey[p.id] && <Spinner />}
                      <button type="button" onClick={() => void handleRevealKey(p.id)}
                        title={showKey[p.id] ? 'Hide key' : hasKey ? 'Load saved key' : 'Show / hide'}
                        className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                        <EyeIcon visible={Boolean(showKey[p.id])} />
                      </button>
                    </div>
                  </div>
                  {!cfg?.api_key && cfg?.has_api_key && (
                    <p className="text-[11px] text-emerald-600 mt-1 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                      Key saved in database — click the eye icon to load it into this field.
                    </p>
                  )}
                  {p.id === 'gemini' && (
                    <p className="text-[11px] text-slate-500 mt-1.5">
                      Free API key —{' '}
                      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline">
                        get one at aistudio.google.com
                      </a>
                    </p>
                  )}
                  {p.id === 'openai' && (
                    <p className="text-[11px] text-slate-500 mt-1.5">
                      API key required —{' '}
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline">
                        get one at platform.openai.com
                      </a>
                    </p>
                  )}
                </div>
              )}

              {/* Host URL for local providers */}
              {isLocal && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {p.id === 'ollama' ? 'Ollama Host URL' : 'llama.cpp Server URL'}
                  </label>
                  <input
                    type="text"
                    value={cfg?.base_url ?? defaultBaseUrl(p.id) ?? ''}
                    onChange={(e) => updateConfig(p.id, { base_url: e.target.value || null })}
                    placeholder={defaultBaseUrl(p.id) ?? 'http://localhost:11434'}
                    className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:border-brand-500"
                  />
                </div>
              )}

              {/* Model selector */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Model</label>
                  <div className="flex items-center gap-1.5">
                    {modelSource[p.id] && (
                      <span className="text-[10px] text-slate-400">
                        {modelSource[p.id] === 'api' ? 'Loaded from API' : 'Fallback list'}
                      </span>
                    )}
                    <button type="button" onClick={() => void loadModels(p.id, true)}
                      disabled={Boolean(modelsLoading[p.id])}
                      className="text-[11px] px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition-colors flex items-center gap-1">
                      {modelsLoading[p.id] ? <><Spinner /> Loading…</> : '↻ Refresh'}
                    </button>
                  </div>
                </div>

                <select
                  value={currentModel}
                  onChange={(e) => updateConfig(p.id, { model: e.target.value })}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm bg-white focus:outline-none focus:border-brand-500">
                  {modelList.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>

                {/* Manual model entry for local providers */}
                {isLocal && (
                  <input
                    type="text"
                    value={currentModel}
                    onChange={(e) => updateConfig(p.id, { model: e.target.value })}
                    placeholder="Or type model name (e.g. qwen2.5:7b, llama3.2)"
                    className="mt-2 w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm font-mono bg-white focus:outline-none focus:border-brand-500"
                  />
                )}
              </div>

            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Summary strings for section headers ──────────────────────────────────────

  const aiSummary  = `${activeProvider.toUpperCase()} · ${providerConfigs[activeProvider]?.model || PROVIDER_DEFAULT_MODEL[activeProvider]}`;
  const pdfSummary = settings.pdf_save_enabled ? (settings.pdf_save_path || 'Enabled (path not set)') : 'Disabled';
  const sciSummary = settings.sci_hub_enabled  ? (settings.http_proxy ? 'Enabled + proxy' : 'Enabled') : 'Disabled';

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm">
      <div ref={panelRef} className="w-full max-w-2xl bg-slate-50 h-full shadow-2xl flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-slate-800">Settings</h2>
              <p className="text-xs text-slate-500">AI provider · PDF storage · Sci-Hub</p>
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Section 1: AI Provider ─────────────────────────────────────── */}
          <Section title="AI Provider" subtitle={aiSummary}
            open={sections.ai} onToggle={() => toggleSection('ai')}>
            <div className="space-y-5 pt-1">

              {/* Active provider pill row */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Active provider for AI generation
                </p>
                <div className="flex flex-wrap gap-2">
                  {PROVIDERS.map((p) => (
                    <button key={p.id} type="button" onClick={() => switchActiveProvider(p.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium transition-all ${
                        activeProvider === p.id
                          ? 'border-brand-500 bg-brand-600 text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}>
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        activeProvider === p.id ? 'bg-white' : p.dotColor
                      }`} />
                      {p.label}
                      <span className={`text-[10px] ${activeProvider === p.id ? 'text-brand-200' : 'text-slate-400'}`}>
                        {p.badge}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Cloud providers */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Cloud Providers — set API keys &amp; models
                </p>
                <div className="space-y-2">
                  {CLOUD_PROVIDERS.map((p) => <ProviderCard key={p.id} p={p} />)}
                </div>
              </div>

              {/* Local providers */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Local Models
                </p>
                <div className="space-y-2">
                  {LOCAL_PROVIDERS_LIST.map((p) => <ProviderCard key={p.id} p={p} />)}
                </div>
              </div>

            </div>
          </Section>

          {/* ── Section 2: PDF Folder Path ──────────────────────────────────── */}
          <Section title="PDF Folder Path" subtitle={pdfSummary}
            open={sections.pdf} onToggle={() => toggleSection('pdf')}>
            <div className="space-y-4 pt-1">
              <div className="flex items-start gap-3">
                <Toggle
                  checked={Boolean(settings.pdf_save_enabled)}
                  onChange={() => setSettings((s) => ({ ...s, pdf_save_enabled: !s.pdf_save_enabled }))}
                />
                <div>
                  <p className="text-sm font-medium text-slate-700">Save downloaded PDFs to disk</p>
                  <p className="text-xs text-slate-500 mt-0.5">Store PDFs and generated BibTeX in your chosen folder.</p>
                </div>
              </div>
              {settings.pdf_save_enabled && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    Folder path
                  </label>
                  <input
                    type="text"
                    value={settings.pdf_save_path ?? ''}
                    onChange={(e) => setSettings((s) => ({ ...s, pdf_save_path: e.target.value || null }))}
                    placeholder="/Users/you/Research/Papers"
                    className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-white focus:outline-none focus:border-brand-500"
                  />
                </div>
              )}
            </div>
          </Section>

          {/* ── Section 3: Sci-Hub ──────────────────────────────────────────── */}
          <Section title="Sci-Hub" subtitle={sciSummary}
            open={sections.scihub} onToggle={() => toggleSection('scihub')}>
            <div className="space-y-4 pt-1">
              <div className="flex items-start gap-3">
                <Toggle
                  checked={Boolean(settings.sci_hub_enabled)}
                  onChange={() => setSettings((s) => ({ ...s, sci_hub_enabled: !s.sci_hub_enabled }))}
                />
                <div>
                  <p className="text-sm font-medium text-slate-700">Use Sci-Hub for paywalled papers</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Use responsibly and in accordance with your institution's policies.
                  </p>
                </div>
              </div>
              {settings.sci_hub_enabled && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    HTTP Proxy (optional)
                  </label>
                  <input
                    type="text"
                    value={settings.http_proxy ?? ''}
                    onChange={(e) => setSettings((s) => ({ ...s, http_proxy: e.target.value || null }))}
                    placeholder="http://proxy.university.edu:8080"
                    className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-mono bg-white focus:outline-none focus:border-brand-500"
                  />
                  <p className="mt-1.5 text-xs text-slate-500">
                    Optional — for networks with restricted outbound access.
                  </p>
                </div>
              )}
            </div>
          </Section>

          {/* Test result banner */}
          {testState !== 'idle' && (
            <div className={`rounded-xl border px-4 py-3 text-sm ${
              testState === 'ok'
                ? 'bg-green-50 border-green-200 text-green-700'
                : testState === 'fail'
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-slate-50 border-slate-200 text-slate-500'
            }`}>
              {testState === 'testing' ? (
                <span className="flex items-center gap-2"><Spinner /> Testing connection…</span>
              ) : testMessage}
            </div>
          )}

        </div>

        {/* Save-error banner */}
        {saveState === 'error' && saveError && (
          <div className="mx-6 mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Save failed: {saveError}
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-white flex gap-3 flex-shrink-0">
          <button type="button" onClick={() => void handleTest()} disabled={testState === 'testing'}
            className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors">
            {testState === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={saveState === 'saving'}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-40 transition-colors">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? 'Retry Save' : 'Save Settings'}
          </button>
        </div>

      </div>
    </div>
  );
}
