import { useMemo, useState } from 'react';
import { figureBuilderImageUrl, generateFigureBuilderCandidates, refineFigureBuilderCandidate } from '../../api/projects';
import type { FigureBrief, FigureBuilderRequest, IllustrationCandidate, PromptPackage } from '../../types/paper';

interface Props {
  open: boolean;
  projectId: string;
  articleType: string;
  selectedJournal: string;
  onClose: () => void;
}

const FIGURE_TYPES = [
  'Psychology visual abstract',
  'Neuroscience conceptual illustration',
  'Medical / anatomical figure',
  'Cell biology / microbiology / molecular figure',
  'Technical / methods schematic',
  'Generic scientific graphical abstract',
];

const OUTPUT_CONTEXTS = [
  { value: 'graphical_abstract', label: 'Graphical abstract' },
  { value: 'visual_abstract', label: 'Visual abstract' },
  { value: 'journal_figure', label: 'Journal figure' },
  { value: 'supplementary', label: 'Supplementary' },
  { value: 'cover_art', label: 'Cover art' },
];

function downloadImage(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_blank';
  a.rel = 'noopener';
  a.click();
}

export default function FigureBuilderModal({ open, projectId, articleType, selectedJournal, onClose }: Props) {
  const [form, setForm] = useState<FigureBuilderRequest>({
    title: '',
    article_type: articleType,
    discipline: articleType,
    figure_type: FIGURE_TYPES[0],
    purpose: '',
    target_journal_style: selectedJournal,
    audience: selectedJournal,
    key_message: '',
    panel_count: 1,
    panels: [],
    must_include: [],
    must_avoid: [],
    labels_needed: false,
    text_in_image_allowed: false,
    background: 'white',
    transparent_background: false,
    aspect_ratio: 'landscape',
    output_context: 'graphical_abstract',
    accessibility_mode: true,
    reference_images: [],
    category_override: null,
    candidate_count: 1,
    output_mode: 'full_figure',
  });
  const [brief, setBrief] = useState<FigureBrief | null>(null);
  const [promptPackage, setPromptPackage] = useState<PromptPackage | null>(null);
  const [candidates, setCandidates] = useState<IllustrationCandidate[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [refineInput, setRefineInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedCandidateId) || candidates[0] || null,
    [candidates, selectedCandidateId],
  );

  if (!open) return null;

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const result = await generateFigureBuilderCandidates(projectId, {
        ...form,
        article_type: articleType,
        target_journal_style: selectedJournal,
      });
      setBrief(result.brief);
      setPromptPackage(result.prompt_package);
      setCandidates(result.candidates);
      setSelectedCandidateId(result.candidates[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Figure generation failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRefine() {
    if (!brief || !promptPackage || !selectedCandidate || !refineInput.trim()) return;
    setRefining(true);
    setError(null);
    try {
      const result = await refineFigureBuilderCandidate(projectId, {
        brief,
        prompt_package: promptPackage,
        candidate: selectedCandidate,
        instruction: refineInput.trim(),
        image_backend: selectedCandidate.backend,
      });
      setBrief(result.brief);
      setPromptPackage(result.prompt_package);
      setCandidates(result.candidates);
      setSelectedCandidateId(result.candidates[0]?.id ?? null);
      setRefineInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refinement failed.');
    } finally {
      setRefining(false);
    }
  }

  function updateListField(field: 'must_include' | 'must_avoid', value: string) {
    setForm((prev) => ({
      ...prev,
      [field]: value.split('\n').map((entry) => entry.trim()).filter(Boolean),
    }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-7xl h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex">
        <div className="w-[360px] border-r border-slate-200 bg-slate-50/70 flex flex-col">
          <div className="px-5 py-4 border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-800">Figure Builder</h2>
                <p className="text-xs text-slate-500 mt-1">Scientific illustration and graphical abstract generation</p>
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Title</label>
              <input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-brand-500"
                placeholder="Internal figure title"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Figure type</label>
              <select
                value={form.figure_type}
                onChange={(e) => setForm((prev) => ({ ...prev, figure_type: e.target.value }))}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-brand-500"
              >
                {FIGURE_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Purpose</label>
              <textarea
                value={form.purpose}
                onChange={(e) => setForm((prev) => ({ ...prev, purpose: e.target.value }))}
                rows={3}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white resize-none focus:outline-none focus:border-brand-500"
                placeholder="What should this figure communicate?"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Key message</label>
              <textarea
                value={form.key_message}
                onChange={(e) => setForm((prev) => ({ ...prev, key_message: e.target.value }))}
                rows={3}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white resize-none focus:outline-none focus:border-brand-500"
                placeholder="One sentence take-home message"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Output context</label>
                <select
                  value={form.output_context}
                  onChange={(e) => setForm((prev) => ({ ...prev, output_context: e.target.value }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-brand-500"
                >
                  {OUTPUT_CONTEXTS.map((ctx) => <option key={ctx.value} value={ctx.value}>{ctx.label}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Candidates</label>
                <select
                  value={String(form.candidate_count ?? 1)}
                  onChange={(e) => setForm((prev) => ({ ...prev, candidate_count: Number(e.target.value) }))}
                  className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-brand-500"
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.transparent_background} onChange={(e) => setForm((prev) => ({ ...prev, transparent_background: e.target.checked }))} />
                Transparent background
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.accessibility_mode} onChange={(e) => setForm((prev) => ({ ...prev, accessibility_mode: e.target.checked }))} />
                Accessibility mode
              </label>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Must include</label>
              <textarea
                value={form.must_include.join('\n')}
                onChange={(e) => updateListField('must_include', e.target.value)}
                rows={4}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white resize-none focus:outline-none focus:border-brand-500"
                placeholder="One required subject per line"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Must avoid</label>
              <textarea
                value={form.must_avoid.join('\n')}
                onChange={(e) => updateListField('must_avoid', e.target.value)}
                rows={3}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white resize-none focus:outline-none focus:border-brand-500"
                placeholder="One avoid instruction per line"
              />
            </div>

            {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
          </div>

          <div className="px-4 py-4 border-t border-slate-200 bg-white">
            <button
              onClick={handleGenerate}
              disabled={loading || !form.title.trim() || !form.purpose.trim() || !form.key_message.trim()}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--gold)' }}
            >
              {loading ? 'Generating…' : 'Generate Concepts'}
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-5 py-4 border-b border-slate-200 bg-white">
            <h3 className="text-sm font-semibold text-slate-800">Candidates</h3>
            <p className="text-xs text-slate-500 mt-1">Prompt package, scoring, refinement, and export</p>
          </div>

          <div className="flex-1 min-h-0 flex">
            <div className="w-[48%] border-r border-slate-200 overflow-y-auto p-4 space-y-4 bg-slate-50/40">
              {candidates.length === 0 && (
                <div className="h-full flex items-center justify-center text-sm text-slate-400">
                  Generate a concept set to preview illustrations.
                </div>
              )}
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setSelectedCandidateId(candidate.id)}
                  className={`w-full rounded-2xl border text-left overflow-hidden transition-all ${selectedCandidate?.id === candidate.id ? 'border-brand-500 shadow-sm bg-white' : 'border-slate-200 bg-white hover:border-brand-300'}`}
                >
                  <img
                    src={`${figureBuilderImageUrl(projectId, candidate.id)}?t=${Date.now()}`}
                    alt={candidate.id}
                    className="w-full h-56 object-contain bg-white"
                  />
                  <div className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-800">{candidate.backend}</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${candidate.score?.rejected ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
                        {candidate.score?.overall?.toFixed?.(2) ?? candidate.score?.overall ?? 'n/a'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{candidate.model}</p>
                    {candidate.score?.notes?.length ? (
                      <p className="text-xs text-slate-500 mt-2">{candidate.score.notes[0]}</p>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {selectedCandidate ? (
                <>
                  <div className="space-y-3">
                    <img
                      src={`${figureBuilderImageUrl(projectId, selectedCandidate.id)}?t=${Date.now()}`}
                      alt={selectedCandidate.id}
                      className="w-full max-h-[360px] object-contain rounded-2xl border border-slate-200 bg-white"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => downloadImage(figureBuilderImageUrl(projectId, selectedCandidate.id), `${selectedCandidate.id}.png`)}
                        className="px-3 py-2 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Download PNG
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Score summary</p>
                      <div className="space-y-1.5 text-sm text-slate-700">
                        <div>Message clarity: {selectedCandidate.score?.message_clarity ?? 'n/a'}</div>
                        <div>Hierarchy: {selectedCandidate.score?.hierarchy ?? 'n/a'}</div>
                        <div>Plausibility: {selectedCandidate.score?.plausibility ?? 'n/a'}</div>
                        <div>Composition: {selectedCandidate.score?.composition ?? 'n/a'}</div>
                        <div>Accessibility: {selectedCandidate.score?.accessibility ?? 'n/a'}</div>
                        <div>Publication fit: {selectedCandidate.score?.publication_fit ?? 'n/a'}</div>
                        <div>Text risk: {selectedCandidate.score?.text_risk ?? 'n/a'}</div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Refine</p>
                      <textarea
                        value={refineInput}
                        onChange={(e) => setRefineInput(e.target.value)}
                        rows={5}
                        className="w-full rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm bg-white resize-none focus:outline-none focus:border-brand-500"
                        placeholder="Reduce clutter, strengthen hierarchy, make it more journal-safe, improve anatomy..."
                      />
                      <button
                        onClick={handleRefine}
                        disabled={refining || !refineInput.trim()}
                        className="mt-3 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                        style={{ background: 'var(--gold)' }}
                      >
                        {refining ? 'Refining…' : 'Refine Selected Candidate'}
                      </button>
                    </div>
                  </div>

                  {promptPackage && (
                    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prompt package</p>
                      </div>
                      <div className="p-4 space-y-3 text-sm">
                        <div>
                          <p className="font-semibold text-slate-700 mb-1">Content</p>
                          <p className="text-slate-600 whitespace-pre-wrap">{promptPackage.layer1_content}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-700 mb-1">Style</p>
                          <p className="text-slate-600 whitespace-pre-wrap">{promptPackage.layer2_style}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-700 mb-1">Composition</p>
                          <p className="text-slate-600 whitespace-pre-wrap">{promptPackage.layer3_composition}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-700 mb-1">Negative block</p>
                          <p className="text-slate-600 whitespace-pre-wrap">{promptPackage.layer4_negative}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-slate-400">
                  Select a candidate to inspect it.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
