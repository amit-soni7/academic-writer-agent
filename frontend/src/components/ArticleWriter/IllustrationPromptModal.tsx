import { useState } from 'react';
import { acceptVisual, visualImageUrl } from '../../api/projects';
import type { FigureBrief, IllustrationStyleControls, PromptPackage, VisualItem, VisualRecommendations } from '../../types/paper';

interface Props {
  item: VisualItem;
  projectId: string;
  onClose: () => void;
  onUpdated: (recs: VisualRecommendations) => void;
}

const VISUAL_STYLE_OPTIONS: { value: FigureBrief['category']; label: string }[] = [
  { value: 'generic',      label: 'Scientific Editorial' },
  { value: 'psychology',   label: 'Painted / Psychology' },
  { value: 'neuroscience', label: 'Watercolor / Neuroscience' },
  { value: 'medical',      label: 'Anatomical / Medical' },
  { value: 'cell_bio',     label: 'Cellular Biology' },
  { value: 'technical',    label: 'Technical Schematic' },
];

const FIGURE_STRUCTURE_OPTIONS: { value: string; label: string }[] = [
  { value: 'conceptual scientific illustration', label: 'Scientific Illustration' },
  { value: 'conceptual framework',               label: 'Conceptual Framework' },
  { value: 'comparison diagram',                 label: 'Comparison Diagram' },
  { value: 'process funnel',                     label: 'Process Funnel' },
  { value: 'branching conceptual framework',     label: 'Branching Tree' },
  { value: 'comparative process diagram',        label: 'Comparative Process' },
  { value: 'shared platform',                    label: 'Shared Platform' },
];

type BackgroundMode = 'opaque' | 'cream' | 'transparent';

function bgModeToControls(mode: BackgroundMode): Partial<IllustrationStyleControls> {
  if (mode === 'transparent') return { background: 'transparent', transparent_background: true };
  if (mode === 'cream')       return { background: 'cream',       transparent_background: false };
  return                             { background: 'opaque',      transparent_background: false };
}

function controlsToBgMode(controls: IllustrationStyleControls): BackgroundMode {
  if (controls.transparent_background || controls.background === 'transparent') return 'transparent';
  if (controls.background === 'cream') return 'cream';
  return 'opaque';
}

export default function IllustrationPromptModal({ item, projectId, onClose, onUpdated }: Props) {
  const [figureBrief, setFigureBrief] = useState<FigureBrief | null>(item.figure_brief ?? null);
  const [promptPackage] = useState<PromptPackage | null>(item.prompt_package ?? null);
  const [editablePrompt, setEditablePrompt] = useState(item.editable_prompt ?? item.prompt_package?.final_prompt ?? '');
  const [styleControls, setStyleControls] = useState<IllustrationStyleControls>({
    palette: item.style_controls?.palette ?? 'muted academic palette with restrained contrast',
    background: item.style_controls?.background ?? 'opaque',
    transparent_background: item.style_controls?.transparent_background ?? false,
  });
  const [bgMode, setBgMode] = useState<BackgroundMode>(controlsToBgMode(styleControls));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullPromptOpen, setFullPromptOpen] = useState(false);

  function updateBrief<K extends keyof FigureBrief>(key: K, value: FigureBrief[K]) {
    setFigureBrief((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  function handleBgMode(mode: BackgroundMode) {
    setBgMode(mode);
    setStyleControls((prev) => ({ ...prev, ...bgModeToControls(mode) }));
  }

  async function handleGenerate() {
    if (!figureBrief) return;
    setLoading(true);
    setError(null);
    try {
      const recs = await acceptVisual(projectId, item.id, 'academic', {
        candidate_count: 2,
        figure_brief: figureBrief,
        editable_prompt: editablePrompt,
        style_controls: styleControls,
      });
      onUpdated(recs);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Illustration generation failed.');
    } finally {
      setLoading(false);
    }
  }

  if (!figureBrief) return null;

  const generatedImage = item.generated?.image_url
    ? `${visualImageUrl(projectId, item.id)}?cid=${item.generated.candidate_id ?? 'default'}`
    : null;
  const isRegenerate = Boolean(item.generated?.image_url);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[84vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              {isRegenerate ? 'Edit Illustration' : 'Generate Illustration'}
              <span className="font-normal text-slate-500"> — {item.title}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">Adjust style and prompt, then generate.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>

        <div className="flex flex-1 min-h-0">

          {/* Left sidebar — style controls */}
          <div className="w-[280px] flex-shrink-0 min-h-0 overflow-y-auto p-4 space-y-4 border-r border-slate-200 bg-slate-50/40">

            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Generation Settings</p>

              {/* Visual Style */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600">Visual Style</label>
                <select
                  value={figureBrief.category}
                  onChange={(e) => updateBrief('category', e.target.value as FigureBrief['category'])}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-2 text-xs bg-white"
                >
                  {VISUAL_STYLE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Figure Structure */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600">Figure Structure</label>
                <select
                  value={figureBrief.figure_type}
                  onChange={(e) => updateBrief('figure_type', e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-2 text-xs bg-white"
                >
                  {FIGURE_STRUCTURE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Background / Opacity */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600">Background / Opacity</label>
                <select
                  value={bgMode}
                  onChange={(e) => handleBgMode(e.target.value as BackgroundMode)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-2 text-xs bg-white"
                >
                  <option value="opaque">Opaque White</option>
                  <option value="cream">Cream / Off-white</option>
                  <option value="transparent">Transparent</option>
                </select>
              </div>

              {/* Color Palette */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600">Color Palette</label>
                <textarea
                  value={styleControls.palette ?? ''}
                  onChange={(e) => setStyleControls((prev) => ({ ...prev, palette: e.target.value }))}
                  rows={3}
                  placeholder="e.g. muted earth tones, warm beige, cool slate"
                  className="w-full rounded-md border border-slate-200 px-2.5 py-2 text-xs resize-none placeholder:text-slate-300"
                />
              </div>
            </div>
          </div>

          {/* Right panel — prompt + preview */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {generatedImage && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Current Preview</p>
                <img
                  src={generatedImage}
                  alt={item.title}
                  className="max-w-full rounded border border-slate-200 bg-white"
                  style={{ maxHeight: '220px', objectFit: 'contain' }}
                />
              </div>
            )}

            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Generation Prompt</p>
              <textarea
                value={editablePrompt}
                onChange={(e) => setEditablePrompt(e.target.value)}
                rows={generatedImage ? 14 : 20}
                placeholder="Leave blank for AI to craft a panel-by-panel illustration brief from the manuscript context, or type your own prompt here."
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-xs leading-relaxed font-mono resize-none placeholder:text-slate-300 placeholder:font-sans"
              />
              <p className="text-[11px] text-slate-400">
                {editablePrompt.trim()
                  ? 'Style, composition, and negative-space rules are added by the backend on top of this prompt.'
                  : 'No prompt entered — the AI will generate a detailed panel-by-panel brief from your manuscript automatically.'}
              </p>
            </div>

            {promptPackage?.final_prompt && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
                <button
                  onClick={() => setFullPromptOpen(o => !o)}
                  className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 hover:text-slate-700"
                >
                  {fullPromptOpen ? '▴' : '▾'} View full assembled prompt (all 5 layers)
                </button>
                {fullPromptOpen && (
                  <pre className="text-[10px] text-slate-500 leading-relaxed whitespace-pre-wrap font-mono bg-slate-50 rounded-md p-3 max-h-64 overflow-y-auto">
                    {promptPackage.final_prompt}
                  </pre>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
          >
            {loading ? 'Generating…' : isRegenerate ? 'Regenerate Illustration' : 'Generate Illustration'}
          </button>
        </div>
      </div>
    </div>
  );
}
