/**
 * ArticleWriter — Phase 5
 *
 * Tabs:
 *   Synthesis | Draft | Peer Review | Revision
 *
 * Article Draft:
 *   - Renders CEILS-tagged article with colour-coded inline tags
 *     [CK] = gray   [CITE:key] = blue   [INF] = amber
 *   - Export as Markdown / Plain text
 *
 * Synthesis:
 *   - Runs cross-paper synthesis before writing
 *   - Shows EvidenceMatrix, MethodsComparison, Contradictions, Gaps, FactBank
 *
 * Peer Review:
 *   - Generates a rigorous reviewer report from extracted evidence + draft
 *   - Major / minor concerns each linked to paper_key(s) and evidence_id(s)
 *   - Decision badge: accept / minor_revision / major_revision / reject
 */
import { useState, useEffect, type ReactNode } from 'react';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import type { JournalStyle, PeerReviewReport, RevisionResult, SynthesisResult } from '../../types/paper';
import {
  synthesizePapers,
  getSynthesisResult,
  generatePeerReview,
  getPeerReviewResult,
  reviseAfterReview,
  writeArticle,
  generateTitle,
  approveTitle,
  loadProject as loadSession,
  getJournalStyle,
} from '../../api/projects';
import type { TitleSuggestions } from '../../api/projects';
import SynthesisPanel from '../LiteratureDashboard/SynthesisPanel';
import LoadingLottie from '../LoadingLottie';

interface Props {
  sessionId: string;
  selectedJournal: string;
  initialTitle?: string | null;
  initialArticleType?: string;
  onBack: () => void;
  onOpenSettings: () => void;
  activeTab?: MainTab;
  onTabChange?: (tab: MainTab) => void;
}

const ARTICLE_TYPES: { value: string; label: string; description?: string }[] = [
  { value: 'original_research',   label: 'Original Research',      description: 'Empirical study with new data' },
  { value: 'review',              label: 'Systematic Review',       description: 'Comprehensive literature review' },
  { value: 'meta_analysis',       label: 'Meta-Analysis',           description: 'Statistical synthesis of studies' },
  { value: 'case_report',         label: 'Case Report',             description: 'Detailed patient/event case' },
  { value: 'brief_report',        label: 'Brief Report',            description: 'Short original findings' },
  { value: 'short_communication', label: 'Short Communication',     description: 'Concise preliminary findings' },
  { value: 'editorial',           label: 'Editorial',               description: 'Invited expert commentary' },
  { value: 'letter',              label: 'Letter to the Editor',    description: 'Brief correspondence' },
];

const DECISION_CONFIG: Record<string, { label: string; cls: string }> = {
  accept:          { label: 'Accept',           cls: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
  minor_revision:  { label: 'Minor Revision',   cls: 'bg-blue-50 text-blue-700 border-blue-300' },
  major_revision:  { label: 'Major Revision',   cls: 'bg-amber-50 text-amber-700 border-amber-300' },
  reject:          { label: 'Reject',           cls: 'bg-rose-50 text-rose-700 border-rose-300' },
};

export type MainTab = 'synthesis' | 'draft' | 'peerreview' | 'revision';

// ── CEILS article renderer (full markdown) ───────────────────────────────────

function renderCeilsArticle(text: string): ReactNode[] {
  const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[CK\]|\[CITE:[^\]]+\]|\[INF\])/g;

  function renderInline(str: string, baseKey: string): ReactNode[] {
    const parts = str.split(INLINE_RE);
    return parts.map((part, i) => {
      const k = `${baseKey}-${i}`;
      if (part === '[CK]') {
        return (
          <span key={k} className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-semibold
            bg-slate-100 text-slate-500 border border-slate-200 align-middle mx-0.5">
            CK
          </span>
        );
      }
      if (part === '[INF]') {
        return (
          <span key={k} className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-semibold
            bg-amber-100 text-amber-700 border border-amber-200 align-middle mx-0.5">
            INF
          </span>
        );
      }
      if (part.startsWith('[CITE:') && part.endsWith(']')) {
        const key = part.slice(6, -1);
        return (
          <span key={k} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold
            bg-blue-100 text-blue-700 border border-blue-300 align-middle mx-0.5 font-mono cursor-default"
            title={`Cited from: ${key}`}>
            ↗ {key}
          </span>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={k}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={k}>{part.slice(1, -1)}</em>;
      }
      return part || null;
    }).filter(Boolean) as React.ReactNode[];
  }

  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let paraLines: string[] = [];
  let listItems: { ordered: boolean; text: string }[] = [];
  let inAbstract = false;
  let inReferences = false;
  let nodeIdx = 0;

  function nextKey() { return `n${nodeIdx++}`; }

  function flushPara() {
    if (paraLines.length === 0) return;
    const content = paraLines.join(' ').trim();
    if (!content) { paraLines = []; return; }
    const k = nextKey();
    nodes.push(
      <p key={k} className={`mb-3 leading-relaxed text-sm text-slate-700${inAbstract ? ' pl-4 border-l-2 border-violet-200' : ''}${inReferences ? ' text-xs font-mono' : ''}`}>
        {renderInline(content, k)}
      </p>
    );
    paraLines = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    const k = nextKey();
    const isOrdered = listItems[0].ordered;
    const Tag = isOrdered ? 'ol' : 'ul';
    nodes.push(
      <Tag key={k} className={`mb-3 ml-5 text-sm text-slate-700 space-y-0.5 ${isOrdered ? 'list-decimal' : 'list-disc'}`}>
        {listItems.map((item, i) => {
          const lk = `${k}-li${i}`;
          return <li key={lk}>{renderInline(item.text, lk)}</li>;
        })}
      </Tag>
    );
    listItems = [];
  }

  for (const line of lines) {
    // H1
    if (/^# /.test(line)) {
      flushPara(); flushList();
      const title = line.slice(2);
      nodes.push(
        <h1 key={nextKey()} className="text-2xl font-bold text-slate-900 mt-2 mb-5 pb-3 border-b-2 border-slate-200 leading-tight">
          {title}
        </h1>
      );
      continue;
    }
    // H2
    if (/^## /.test(line)) {
      flushPara(); flushList();
      const heading = line.slice(3).trim();
      const isAbstract = /^abstract$/i.test(heading);
      const isRefs = /^references$/i.test(heading);
      inAbstract = isAbstract;
      inReferences = isRefs;
      if (isAbstract) {
        nodes.push(
          <h2 key={nextKey()} className="text-base font-bold mt-8 mb-3 pb-1.5 border-b-2 border-violet-300 text-violet-800">
            {heading}
          </h2>
        );
      } else if (isRefs) {
        nodes.push(
          <h2 key={nextKey()} className="text-xs font-bold mt-8 mb-3 pb-1.5 border-b border-slate-300 text-slate-500 uppercase tracking-wide">
            {heading}
          </h2>
        );
      } else {
        nodes.push(
          <h2 key={nextKey()} className="text-lg font-bold text-slate-800 mt-8 mb-3 pb-2 border-b border-slate-200">
            {heading}
          </h2>
        );
      }
      continue;
    }
    // H3
    if (/^### /.test(line)) {
      flushPara(); flushList();
      const heading = line.slice(4).trim();
      nodes.push(
        <h3 key={nextKey()} className="text-base font-semibold text-slate-700 mt-5 mb-2">
          {heading}
        </h3>
      );
      continue;
    }
    // H4
    if (/^#### /.test(line)) {
      flushPara(); flushList();
      const heading = line.slice(5).trim();
      nodes.push(
        <h4 key={nextKey()} className="text-sm font-semibold text-slate-600 mt-4 mb-1">
          {heading}
        </h4>
      );
      continue;
    }
    // Unordered list item
    if (/^[-*] /.test(line)) {
      flushPara();
      listItems.push({ ordered: false, text: line.slice(2).trim() });
      continue;
    }
    // Ordered list item
    if (/^\d+\. /.test(line)) {
      flushPara();
      listItems.push({ ordered: true, text: line.replace(/^\d+\. /, '').trim() });
      continue;
    }
    // Blank line → flush paragraph/list
    if (line.trim() === '') {
      flushPara(); flushList();
      continue;
    }
    // Normal text line
    flushList();
    paraLines.push(line);
  }

  flushPara();
  flushList();

  return nodes;
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadDocxFile(filename: string, title: string, content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 28 })],
      spacing: { after: 240 },
    }),
  ];

  for (const line of lines) {
    const text = line.replace(/\[CK\]|\[INF\]|\[CITE:[^\]]+\]/g, '').trimEnd();
    if (!text.trim()) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    if (text.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: text.slice(3), bold: true, size: 24 })],
        spacing: { before: 200, after: 120 },
      }));
      continue;
    }
    if (text.startsWith('# ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: text.slice(2), bold: true, size: 28 })],
        spacing: { before: 240, after: 160 },
      }));
      continue;
    }
    children.push(new Paragraph({ text }));
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Title Approval Panel ──────────────────────────────────────────────────────

function TitleApprovalPanel({
  suggestions,
  onApprove,
  loading,
}: {
  suggestions: TitleSuggestions;
  onApprove: (title: string) => void;
  loading: boolean;
}) {
  const [selected, setSelected] = useState<string>(suggestions.best_title);
  const [custom, setCustom] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const all = [
    { title: suggestions.best_title, rationale: suggestions.best_title_rationale, isBest: true },
    ...suggestions.alternatives.map(a => ({ ...a, isBest: false })),
  ];

  const finalTitle = useCustom ? custom.trim() : selected;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-800 mb-1">Choose or edit your manuscript title</h3>
        <p className="text-xs text-slate-500 leading-relaxed">
          Titles follow the quality policy (Tullu 2019 · Nature Index): concise (10–15 words),
          descriptive, keyword-first, no hype, no nonstandard abbreviations.
        </p>
      </div>

      <div className="space-y-2">
        {all.map((item, i) => (
          <button
            key={i}
            onClick={() => { setSelected(item.title); setUseCustom(false); }}
            className={`w-full text-left rounded-xl border px-4 py-3 transition-all ${
              !useCustom && selected === item.title
                ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-400'
                : 'border-slate-200 hover:border-slate-300 bg-white'
            }`}
          >
            <div className="flex items-start gap-2">
              <span className={`flex-shrink-0 mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                !useCustom && selected === item.title
                  ? 'border-brand-500 bg-brand-500'
                  : 'border-slate-300'
              }`}>
                {!useCustom && selected === item.title && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white block" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium leading-snug ${
                  !useCustom && selected === item.title ? 'text-brand-800' : 'text-slate-800'
                }`}>
                  {item.title}
                  {item.isBest && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 font-semibold">
                      Recommended
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{item.rationale}</p>
              </div>
            </div>
          </button>
        ))}

        {/* Custom title option */}
        <div className={`rounded-xl border px-4 py-3 transition-all ${
          useCustom ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-400' : 'border-slate-200 bg-white'
        }`}>
          <button
            onClick={() => setUseCustom(true)}
            className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2"
          >
            <span className={`flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
              useCustom ? 'border-brand-500 bg-brand-500' : 'border-slate-300'
            }`}>
              {useCustom && <span className="w-1.5 h-1.5 rounded-full bg-white block" />}
            </span>
            Custom title
          </button>
          {useCustom && (
            <input
              autoFocus
              type="text"
              value={custom}
              onChange={e => setCustom(e.target.value)}
              placeholder="Type your custom title (10–15 words recommended)…"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-brand-400"
            />
          )}
        </div>
      </div>

      {suggestions.quality_notes && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-xs font-semibold text-amber-700 mb-1">Quality notes</p>
          <p className="text-xs text-amber-800 leading-relaxed">{suggestions.quality_notes}</p>
        </div>
      )}

      <button
        onClick={() => finalTitle && onApprove(finalTitle)}
        disabled={loading || !finalTitle}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
          text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700
          disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {loading ? (
          <><LoadingLottie className="w-5 h-5" />Saving…</>
        ) : (
          <>Approve Title &amp; Draft Manuscript</>
        )}
      </button>
    </div>
  );
}

// ── Concern card ─────────────────────────────────────────────────────────────

function ConcernCard({ concern, index, level }: {
  concern: PeerReviewReport['major_concerns'][0];
  index: number;
  level: 'major' | 'minor';
}) {
  const [open, setOpen] = useState(false);
  const borderCls = level === 'major' ? 'border-rose-200' : 'border-amber-200';
  const bgCls     = level === 'major' ? 'bg-rose-50/30' : 'bg-amber-50/30';
  const numCls    = level === 'major' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700';

  return (
    <div className={`rounded-xl border ${borderCls} ${bgCls} p-4`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-3 text-left"
      >
        <span className={`flex-shrink-0 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${numCls}`}>
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 leading-snug">{concern.concern}</p>
          {concern.paper_ids.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {concern.paper_ids.map((p, i) => (
                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
        <svg className={`w-4 h-4 flex-shrink-0 text-slate-400 transition-transform mt-0.5 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 ml-9 space-y-2.5 text-xs">
          {concern.scientific_importance && (
            <div>
              <p className="font-semibold text-slate-500 uppercase tracking-wide mb-1">Why it matters</p>
              <p className="text-slate-700 leading-relaxed">{concern.scientific_importance}</p>
            </div>
          )}
          {concern.revision_request && (
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5">
              <p className="font-semibold text-slate-600 uppercase tracking-wide mb-1">Revision required</p>
              <p className="text-slate-800 leading-relaxed">{concern.revision_request}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

// ── Citation style badge (small, inline) ─────────────────────────────────────

function CitationStyleBadge({ style }: { style: JournalStyle }) {
  const label = `${style.reference_format_name} · ${
    style.in_text_format === 'superscript' ? 'Superscript' :
    style.in_text_format === 'author_year' ? 'Author-Year' : 'Numbered'
  }`;
  const low = style.confidence < 0.7;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium
      ${low ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-sky-50 text-sky-700 border-sky-200'}`}
      title={low ? 'Citation style inferred — may vary by specific journal instructions' : undefined}>
      {label}
      {low && ' (inferred)'}
    </span>
  );
}

export default function ArticleWriter({ sessionId, selectedJournal, initialTitle, initialArticleType, onBack, onOpenSettings, activeTab, onTabChange }: Props) {
  const [tab, setTab]               = useState<MainTab>(activeTab ?? 'synthesis');

  useEffect(() => {
    if (activeTab && activeTab !== tab) setTab(activeTab);
  }, [activeTab]);

  function changeTab(t: MainTab) { setTab(t); onTabChange?.(t); }
  const [articleType, setArticleType] = useState(initialArticleType || 'review');
  const [wordLimit, setWordLimit]   = useState(4000);
  const [maxRefs, setMaxRefs]       = useState<string>('');
  const [refCount, setRefCount]     = useState(0);
  const [refLimit, setRefLimit]     = useState<number | null>(null);

  // ── Journal style state ────────────────────────────────────────────────────
  const [journalStyle, setJournalStyle] = useState<JournalStyle | null>(null);

  // ── Title Quality Policy state ─────────────────────────────────────────────
  const [approvedTitle, setApprovedTitle]   = useState<string>(initialTitle ?? '');
  const [titleSuggestions, setTitleSuggestions] = useState<TitleSuggestions | null>(null);
  const [titleState, setTitleState]         = useState<'idle' | 'generating' | 'approving' | 'done'>(
    initialTitle ? 'done' : 'idle'
  );
  const [titleError, setTitleError]         = useState<string | null>(null);
  const [showTitlePanel, setShowTitlePanel] = useState(false);

  // Load existing manuscript_title and article_type from session on mount (for resumed sessions)
  useEffect(() => {
    loadSession(sessionId).then(data => {
      if (!initialTitle) {
        const t = data.manuscript_title;
        if (t) {
          setApprovedTitle(t);
          setTitleState('done');
        }
      }
      // Load persisted article type for resumed sessions (only if not provided by parent)
      if (!initialArticleType && data.article_type) {
        setArticleType(data.article_type);
      }
    }).catch(() => { /* silently ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Restore saved synthesis and peer review results on resume
  useEffect(() => {
    getSynthesisResult(sessionId).then(result => {
      if (result) {
        setSynthesis(result);
        setSynthState('done');
      }
    }).catch(() => {});

    getPeerReviewResult(sessionId).then(result => {
      if (result) {
        setReview(result);
        setReviewState('done');
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Load journal style on mount
  useEffect(() => {
    if (!selectedJournal) return;
    getJournalStyle(selectedJournal).then(style => {
      setJournalStyle(style);
      // Auto-select first accepted type if current type is not in accepted list
      if (style.accepted_article_types.length > 0 &&
          !style.accepted_article_types.includes(articleType)) {
        const firstType = style.accepted_article_types[0];
        setArticleType(firstType);
        // Also auto-set word limit for the newly selected type
        const jLimit = style.word_limits?.[firstType];
        if (jLimit) setWordLimit(jLimit);
      } else {
        // Auto-set word limit for current article type if journal specifies one
        const jLimit = style.word_limits?.[articleType];
        if (jLimit) setWordLimit(jLimit);
      }
    }).catch(() => { /* silently ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJournal]);

  // When article type changes, auto-update word limit from journal style
  useEffect(() => {
    if (!journalStyle) return;
    const jLimit = journalStyle.word_limits?.[articleType];
    if (jLimit) setWordLimit(jLimit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleType, journalStyle]);

  // Draft state
  const [articleText, setArticleText] = useState('');
  const [writingState, setWritingState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [writeError, setWriteError] = useState<string | null>(null);
  const [wordCount, setWordCount]   = useState(0);
  const [rawMode, setRawMode]       = useState(false);

  // Synthesis state
  const [synthesis, setSynthesis]   = useState<SynthesisResult | null>(null);
  const [synthState, setSynthState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [synthError, setSynthError] = useState<string | null>(null);

  // Peer review state
  const [review, setReview]         = useState<PeerReviewReport | null>(null);
  const [reviewState, setReviewState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Revision state
  const [revision, setRevision] = useState<RevisionResult | null>(null);
  const [revisionState, setRevisionState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [revisionError, setRevisionError] = useState<string | null>(null);

  async function handleGenerateTitle() {
    setTitleState('generating');
    setTitleError(null);
    try {
      const suggestions = await generateTitle(sessionId, articleType, selectedJournal);
      setTitleSuggestions(suggestions);
      setShowTitlePanel(true);
      setTitleState('idle');
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : 'Title generation failed.');
      setTitleState('idle');
    }
  }

  async function handleApproveTitle(title: string) {
    setTitleState('approving');
    try {
      await approveTitle(sessionId, title);
      setApprovedTitle(title);
      setShowTitlePanel(false);
      setTitleState('done');
      // Auto-proceed to drafting after approval
      await _draftArticle();
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : 'Failed to save title.');
      setTitleState('idle');
    }
  }

  async function _draftArticle() {
    setWritingState('running');
    setWriteError(null);
    setArticleText('');
    try {
      const parsedMaxRefs = maxRefs.trim() !== '' ? parseInt(maxRefs, 10) : undefined;
      const result = await writeArticle(sessionId, selectedJournal, articleType, wordLimit, parsedMaxRefs);
      setArticleText(result.article ?? '');
      setWordCount(result.word_count ?? 0);
      setRefCount(result.ref_count ?? 0);
      setRefLimit(result.ref_limit ?? null);
      setRevision(null);
      setRevisionState('idle');
      setRevisionError(null);
      setWritingState('done');
      changeTab('draft');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Article generation failed.';
      setWriteError(msg);
      setWritingState('error');
    }
  }

  async function handleWriteArticle() {
    if (!synthesis) {
      setWriteError('Run Cross-paper Evidence Synthesis first.');
      changeTab('synthesis');
      return;
    }
    // ── Title Quality Policy gate ──────────────────────────────────────────────
    if (!approvedTitle) {
      // No approved title: generate suggestions first
      await handleGenerateTitle();
      return;  // handleApproveTitle will trigger drafting after approval
    }
    await _draftArticle();
  }

  async function handleSynthesize() {
    setSynthState('running');
    setSynthError(null);
    changeTab('synthesis');
    try {
      const result = await synthesizePapers(sessionId);
      setSynthesis(result);
      setSynthState('done');
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : 'Synthesis failed.');
      setSynthState('error');
    }
  }

  async function handlePeerReview() {
    if (!articleText) {
      setReviewError('Draft the manuscript first.');
      changeTab('draft');
      return;
    }
    setReviewState('running');
    setReviewError(null);
    changeTab('peerreview');
    try {
      const report = await generatePeerReview(sessionId);
      setReview(report);
      setRevision(null);
      setRevisionState('idle');
      setRevisionError(null);
      setReviewState('done');
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Peer review generation failed.');
      setReviewState('error');
    }
  }

  async function handleReviseAfterReview() {
    if (!articleText || !review) {
      setRevisionError('Draft and peer review are required before revision.');
      changeTab(!articleText ? 'draft' : 'peerreview');
      return;
    }
    setRevisionState('running');
    setRevisionError(null);
    changeTab('revision');
    try {
      const result = await reviseAfterReview(sessionId, articleText, review, selectedJournal);
      setRevision(result);
      if (result.revised_article) {
        setArticleText(result.revised_article);
        setWordCount(result.revised_article.split(/\s+/).filter(Boolean).length);
      }
      setRevisionState('done');
    } catch (err) {
      setRevisionError(err instanceof Error ? err.message : 'Revision failed.');
      setRevisionState('error');
    }
  }

  function downloadArticle(mode: 'markdown' | 'plain') {
    const content = mode === 'plain'
      ? articleText.replace(/\[CK\]|\[INF\]|\[CITE:[^\]]+\]/g, '').replace(/#{1,3} /g, '')
      : articleText;
    downloadTextFile(
      `article_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.${mode === 'markdown' ? 'md' : 'txt'}`,
      content,
    );
  }

  async function downloadArticleDocx() {
    const docxTitle = approvedTitle || `Manuscript – ${selectedJournal}`;
    await downloadDocxFile(
      `article_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.docx`,
      docxTitle,
      articleText,
    );
  }

  function downloadRevisionReply(mode: 'markdown' | 'plain') {
    if (!revision?.point_by_point_reply) return;
    const content = mode === 'plain'
      ? revision.point_by_point_reply.replace(/#{1,6}\s/g, '')
      : revision.point_by_point_reply;
    downloadTextFile(
      `response_letter_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.${mode === 'markdown' ? 'md' : 'txt'}`,
      content,
    );
  }

  async function downloadRevisionReplyDocx() {
    if (!revision?.point_by_point_reply) return;
    await downloadDocxFile(
      `response_letter_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.docx`,
      `Point-by-Point Response – ${selectedJournal}`,
      revision.point_by_point_reply,
    );
  }

  const decisionConf = review ? (DECISION_CONFIG[review.decision] ?? DECISION_CONFIG.major_revision) : null;
  const canDraft = Boolean(synthesis);
  const canPeerReview = Boolean(articleText);
  const canRevise = Boolean(articleText && review);
  const titleApproved = Boolean(approvedTitle);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Journals
            </button>
            <span className="text-slate-300">/</span>
            <span className="font-semibold text-slate-800">Write Article</span>
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
              {selectedJournal}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">3 · Summarise</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">4 · Journals</span>
              <span className="text-slate-300">→</span>
              <span className="px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">5 · Write</span>
            </div>
            <button onClick={onOpenSettings}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8 space-y-6">

        {/* Controls card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">

          {/* ── Title Quality Policy section ── */}
          <div className={`rounded-xl border mb-5 p-4 ${
            titleApproved
              ? 'bg-emerald-50 border-emerald-200'
              : 'bg-amber-50 border-amber-200'
          }`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${
                  titleApproved ? 'text-emerald-600' : 'text-amber-600'
                }`}>
                  {titleApproved ? 'Approved Manuscript Title' : 'Manuscript Title Required'}
                </p>
                {titleApproved ? (
                  <p className="text-sm font-medium text-emerald-900 leading-snug">{approvedTitle}</p>
                ) : (
                  <p className="text-xs text-amber-700 leading-relaxed">
                    A high-quality title must be approved before drafting. Click "Generate Title" to get
                    AI suggestions, or enter one manually.
                  </p>
                )}
                {titleError && (
                  <p className="text-xs text-rose-600 mt-1">{titleError}</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {titleApproved && (
                  <button
                    onClick={handleGenerateTitle}
                    disabled={titleState === 'generating'}
                    className="px-3 py-1.5 rounded-lg border border-emerald-300 text-xs font-medium
                      text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 transition-colors"
                  >
                    {titleState === 'generating' ? 'Generating…' : '↻ Change Title'}
                  </button>
                )}
                {!titleApproved && (
                  <button
                    onClick={handleGenerateTitle}
                    disabled={titleState === 'generating'}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold
                      hover:bg-amber-700 disabled:opacity-40 transition-colors"
                  >
                    {titleState === 'generating' ? (
                      <span className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                        </svg>Generating…
                      </span>
                    ) : 'Generate Title'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Title approval panel (shown when suggestions are ready) */}
          {showTitlePanel && titleSuggestions && (
            <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 mb-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-brand-800">Title Suggestions</h3>
                <button
                  onClick={() => setShowTitlePanel(false)}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  ✕ Close
                </button>
              </div>
              <TitleApprovalPanel
                suggestions={titleSuggestions}
                onApprove={handleApproveTitle}
                loading={titleState === 'approving'}
              />
            </div>
          )}

          {/* Citation style + journal constraints */}
          {journalStyle && (
            <div className="flex items-start gap-3 mb-4 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Citation:</span>
                <CitationStyleBadge style={journalStyle} />
              </div>
              {journalStyle.abstract_structure && (
                <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium
                  ${journalStyle.abstract_structure === 'structured'
                    ? 'bg-violet-50 text-violet-700 border-violet-200'
                    : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                  Abstract: {journalStyle.abstract_structure}
                  {journalStyle.abstract_word_limit ? ` ≤${journalStyle.abstract_word_limit}w` : ''}
                </span>
              )}
              {journalStyle.max_references && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium bg-rose-50 text-rose-600 border-rose-200">
                  Max {journalStyle.max_references} refs
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
                Article Type
              </label>
              <select value={articleType} onChange={e => setArticleType(e.target.value)}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 bg-white">
                {ARTICLE_TYPES
                  .filter(t =>
                    !journalStyle?.accepted_article_types?.length ||
                    journalStyle.accepted_article_types.includes(t.value)
                  )
                  .map(t => <option key={t.value} value={t.value}>{t.label}</option>)
                }
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
                Word Limit
                {journalStyle?.word_limits?.[articleType] && (
                  <span className="ml-1.5 font-normal text-violet-600 normal-case tracking-normal">
                    (journal: ~{journalStyle.word_limits[articleType]?.toLocaleString()}w)
                  </span>
                )}
              </label>
              <input
                type="number"
                min={500} max={15000} step={100}
                value={wordLimit}
                onChange={e => {
                  const v = Math.max(500, Math.min(15000, Number(e.target.value) || 4000));
                  setWordLimit(v);
                }}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm
                  focus:outline-none focus:border-brand-500 bg-white"
                placeholder="e.g. 4000"
              />
              <p className="text-[10px] text-slate-400 mt-1">500 – 15,000 words</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
                Max References
                {journalStyle?.max_references && (
                  <span className="ml-1.5 font-normal text-rose-600 normal-case tracking-normal">
                    (journal: ≤{journalStyle.max_references})
                  </span>
                )}
              </label>
              <input
                type="number"
                min={5} max={300} step={5}
                value={maxRefs}
                onChange={e => setMaxRefs(e.target.value)}
                className="w-full rounded-xl border-2 border-slate-200 px-3 py-2 text-sm
                  focus:outline-none focus:border-brand-500 bg-white"
                placeholder="Unlimited"
              />
              <p className="text-[10px] text-slate-400 mt-1">Leave blank = unlimited</p>
            </div>
            <div className="flex flex-col justify-end">
              <button
                onClick={handleWriteArticle}
                disabled={writingState === 'running' || !canDraft}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
                  text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700
                  disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                title={!canDraft ? 'Run Cross-paper Evidence Synthesis first' : undefined}
              >
                {writingState === 'running' ? (
                  <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                  </svg>Drafting…</>
                ) : titleState === 'generating' ? (
                  <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                  </svg>Generating title…</>
                ) : articleText ? (
                  '↻ Re-draft Article'
                ) : (
                  <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>Draft Manuscript</>
                )}
              </button>
            </div>
          </div>

          {/* Word count + ref count badges (shown after drafting) */}
          {writingState === 'done' && articleText && (
            <div className="flex flex-wrap gap-2 mt-2 mb-3 pt-3 border-t border-slate-100">
              {(() => {
                const pct = Math.round((wordCount / wordLimit) * 100);
                const ok  = pct >= 85 && pct <= 115;
                return (
                  <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border
                    ${ok
                      ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                    {wordCount.toLocaleString()} words
                    <span className="opacity-60">/ target {wordLimit.toLocaleString()}</span>
                    {!ok && <span className="font-semibold">({pct}% — outside ±15%)</span>}
                  </span>
                );
              })()}
              {refCount > 0 && (
                <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border
                  ${refLimit && refCount > refLimit
                    ? 'bg-rose-50 text-rose-600 border-rose-200'
                    : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                  {refCount} references
                  {refLimit && <span className="opacity-60">/ limit {refLimit}</span>}
                  {refLimit && refCount > refLimit && (
                    <span className="font-semibold"> ⚠ {refCount - refLimit} over</span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Tag legend */}
          <div className="flex flex-wrap gap-3 text-xs text-slate-500 pt-3 border-t border-slate-100">
            <span className="font-medium text-slate-600">Tag legend:</span>
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 font-semibold text-[10px]">CK</span>
              Common knowledge
            </span>
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-300 font-semibold font-mono text-[10px]">↗ key</span>
              Cited from paper
            </span>
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 font-semibold text-[10px]">INF</span>
              Inference / synthesis
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleSynthesize}
            disabled={synthState === 'running'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200
              text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
          >
            {synthState === 'running' ? (
              <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
              </svg>Synthesising…</>
            ) : (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>{synthesis ? '↻ Re-synthesise' : 'Cross-paper Synthesis'}</>
            )}
          </button>
          <button
            onClick={handleWriteArticle}
            disabled={writingState === 'running' || !canDraft}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200
              text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
            title={!canDraft ? 'Run synthesis first' : undefined}
          >
            {writingState === 'running' ? (
              <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
              </svg>Drafting…</>
            ) : (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>{articleText ? '↻ Re-draft Manuscript' : 'Draft Manuscript'}</>
            )}
          </button>
          <button
            onClick={handlePeerReview}
            disabled={reviewState === 'running' || !canPeerReview}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200
              text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
            title={!canPeerReview ? 'Draft the manuscript first' : undefined}
          >
            {reviewState === 'running' ? (
              <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
              </svg>Reviewing…</>
            ) : (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>{review ? '↻ Re-review' : 'Generate Peer Review'}</>
            )}
          </button>
          <button
            onClick={handleReviseAfterReview}
            disabled={revisionState === 'running' || !canRevise}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200
              text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors"
            title={!canRevise ? 'Generate peer review first' : undefined}
          >
            {revisionState === 'running' ? (
              <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
              </svg>Revising…</>
            ) : (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h10M4 17h16" />
              </svg>{revision ? '↻ Re-run Revision' : 'Revise + Response Letter'}</>
            )}
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-slate-200">
          {([
            { id: 'synthesis',  label: 'Synthesis',           badge: synthesis ? `${synthesis.evidence_matrix.length} claims` : undefined },
            { id: 'draft',      label: 'Draft Manuscript',    badge: wordCount > 0 ? `${wordCount.toLocaleString()}w` : undefined },
            { id: 'peerreview', label: 'Peer Review',         badge: review ? review.decision.replace('_', ' ') : undefined },
            { id: 'revision',   label: 'Revision',            badge: revision ? 'ready' : undefined },
          ] as Array<{ id: MainTab; label: string; badge?: string }>).map(t => (
            <button
              key={t.id}
              onClick={() => changeTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand-500 text-brand-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
              {t.badge && (
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                  tab === t.id ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Draft tab ─────────────────────────────────────────────────────── */}
        {tab === 'draft' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
            {writeError && (
              <div className="px-6 py-4 bg-rose-50 border-b border-rose-200 text-sm text-rose-700 rounded-t-2xl">
                {writeError}
              </div>
            )}

            {!articleText && writingState !== 'running' && (
              <div className="py-16 text-center text-slate-400 text-sm">
                Click "Draft Article" to generate your manuscript using CEILS format.
              </div>
            )}

            {writingState === 'running' && (
              <div className="py-16 text-center space-y-3">
                <svg className="w-8 h-8 animate-spin text-brand-500 mx-auto" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
                <p className="text-sm text-slate-500">Drafting your manuscript…</p>
                <p className="text-xs text-slate-400">This may take 1–3 minutes depending on your AI provider.</p>
              </div>
            )}

            {articleText && (
              <>
                {/* Toolbar */}
                <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-slate-100 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setRawMode(v => !v)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        rawMode ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {rawMode ? 'Rendered View' : 'Raw Markdown'}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{wordCount.toLocaleString()} words</span>
                    <button onClick={() => downloadArticle('markdown')}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                      ↓ Markdown
                    </button>
                    <button onClick={downloadArticleDocx}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                      ↓ DOCX
                    </button>
                    <button onClick={() => downloadArticle('plain')}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                      ↓ Plain text
                    </button>
                  </div>
                </div>

                {/* Article content */}
                {rawMode ? (
                  <pre className="p-6 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed overflow-x-auto">
                    {articleText}
                  </pre>
                ) : (
                  <div className="p-6 sm:p-8 prose prose-slate max-w-none text-sm leading-relaxed">
                    {renderCeilsArticle(articleText)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Synthesis tab ─────────────────────────────────────────────────── */}
        {tab === 'synthesis' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-800">Cross-paper Evidence Synthesis</h2>
              {synthState === 'idle' && !synthesis && (
                <p className="text-xs text-slate-400">Click "Cross-paper Synthesis" above to generate.</p>
              )}
            </div>

            {synthError && (
              <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 mb-4">
                {synthError}
              </p>
            )}

            {synthState === 'running' && (
              <div className="py-12 text-center space-y-3">
                <svg className="w-8 h-8 animate-spin text-brand-500 mx-auto" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
                <p className="text-sm text-slate-500">Synthesising evidence across papers…</p>
              </div>
            )}

            {synthesis && synthState !== 'running' && (
              <SynthesisPanel result={synthesis} />
            )}
          </div>
        )}

        {/* ── Peer Review tab ───────────────────────────────────────────────── */}
        {tab === 'peerreview' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">

            {reviewError && (
              <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                {reviewError}
              </p>
            )}

            {!review && reviewState !== 'running' && (
              <div className="py-12 text-center text-slate-400 text-sm">
                {!articleText
                  ? 'Draft your article first, then click "Generate Peer Review".'
                  : 'Click "Generate Peer Review" to get reviewer-grade feedback.'}
              </div>
            )}

            {reviewState === 'running' && (
              <div className="py-12 text-center space-y-3">
                <svg className="w-8 h-8 animate-spin text-brand-500 mx-auto" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
                <p className="text-sm text-slate-500">Generating peer review report…</p>
              </div>
            )}

            {review && (
              <div className="space-y-5">
                {/* Decision banner */}
                {decisionConf && (
                  <div className={`rounded-2xl border-2 ${decisionConf.cls} px-6 py-4`}>
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-1">
                      Reviewer Recommendation
                    </p>
                    <p className="text-xl font-bold">{decisionConf.label}</p>
                    {review.decision_rationale && (
                      <p className="text-sm mt-2 leading-relaxed opacity-90">{review.decision_rationale}</p>
                    )}
                  </div>
                )}

                {/* Manuscript summary */}
                {review.manuscript_summary && (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                      Manuscript Summary
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">{review.manuscript_summary}</p>
                  </div>
                )}

                {/* Major concerns */}
                {review.major_concerns.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-rose-600 mb-3">
                      Major Concerns ({review.major_concerns.length})
                    </h3>
                    <div className="space-y-2">
                      {review.major_concerns.map((c, i) => (
                        <ConcernCard key={i} concern={c} index={i} level="major" />
                      ))}
                    </div>
                  </div>
                )}

                {/* Minor concerns */}
                {review.minor_concerns.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-amber-600 mb-3">
                      Minor Concerns ({review.minor_concerns.length})
                    </h3>
                    <div className="space-y-2">
                      {review.minor_concerns.map((c, i) => (
                        <ConcernCard key={i} concern={c} index={i} level="minor" />
                      ))}
                    </div>
                  </div>
                )}

                {/* Required revisions */}
                {review.required_revisions.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-600 mb-3">
                      Required Revisions
                    </h3>
                    <div className="space-y-2">
                      {review.required_revisions.map((r, i) => (
                        <div key={i} className="flex gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-100 text-slate-600
                            text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                          <p className="text-sm text-slate-700 leading-relaxed">{r}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Revision tab ─────────────────────────────────────────────────── */}
        {tab === 'revision' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
            {revisionError && (
              <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                {revisionError}
              </p>
            )}

            {!revision && revisionState !== 'running' && (
              <div className="py-12 text-center text-slate-400 text-sm">
                {!review
                  ? 'Generate peer review first, then run revision.'
                  : 'Click "Revise + Response Letter" to rewrite the manuscript and create a point-by-point response.'}
              </div>
            )}

            {revisionState === 'running' && (
              <div className="py-12 text-center space-y-3">
                <svg className="w-8 h-8 animate-spin text-brand-500 mx-auto" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
                <p className="text-sm text-slate-500">Revising manuscript and drafting response letter…</p>
              </div>
            )}

            {revision && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-2 justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-800">Revision Package</h2>
                    <p className="text-xs text-slate-500">Updated manuscript + point-by-point reviewer response.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => downloadArticle('markdown')}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Manuscript .md
                    </button>
                    <button
                      onClick={downloadArticleDocx}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Manuscript .docx
                    </button>
                    <button
                      onClick={() => downloadRevisionReply('markdown')}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Response .md
                    </button>
                    <button
                      onClick={downloadRevisionReplyDocx}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Response .docx
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-6">
                  <section className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Revised Manuscript</h3>
                      <span className="text-[11px] text-slate-400">{wordCount.toLocaleString()} words</span>
                    </div>
                    <div className="p-5 prose prose-slate max-w-none text-sm leading-relaxed">
                      {revision.revised_article
                        ? renderCeilsArticle(revision.revised_article)
                        : <p className="text-slate-400">No revised manuscript returned.</p>}
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Point-by-Point Response</h3>
                    </div>
                    <pre className="p-5 text-xs whitespace-pre-wrap leading-relaxed text-slate-700 bg-white overflow-x-auto">
                      {revision.point_by_point_reply || 'No response letter returned.'}
                    </pre>
                  </section>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
