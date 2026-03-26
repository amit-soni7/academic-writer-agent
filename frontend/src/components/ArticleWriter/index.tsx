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
import { AlignmentType, Document, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type { DeepSynthesisResult, DeepSynthesisSSEEvent, JournalStyle, PeerReviewReport, RevisionResult, SynthesisResult, VisualItem, VisualRecommendations } from '../../types/paper';
import {
  getSynthesisResult,
  streamDeepSynthesis,
  getDeepSynthesisResult,
  getPeerReviewResult,
  generatePeerReview,
  reviseAfterReview,
  writeArticle,
  generateTitle,
  approveTitle,
  loadProject as loadSession,
  getJournalStyle,
  getVisualRecommendations,
  planVisuals,
  acceptVisual,
  dismissVisual,
  finalizeVisual,
  selectVisualCandidate,
} from '../../api/projects';
import type { TitleSuggestions } from '../../api/projects';
import DeepSynthesisPanel from './DeepSynthesisPanel';
import LoadingLottie from '../LoadingLottie';
import IllustrationPromptModal from './IllustrationPromptModal';
import VisualBlock from './VisualBlock';
import VisualEditModal from './VisualEditModal';

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
  { value: 'systematic_review',   label: 'Systematic Review',       description: 'Structured evidence synthesis with protocol-driven methods' },
  { value: 'scoping_review',      label: 'Scoping Review',          description: 'Evidence mapping across concepts, contexts, or gaps' },
  { value: 'narrative_review',    label: 'Narrative Review',        description: 'Focused interpretive review of the literature' },
  { value: 'review',              label: 'General Review',          description: 'Comprehensive literature review' },
  { value: 'meta_analysis',       label: 'Meta-Analysis',           description: 'Statistical synthesis of studies' },
  { value: 'case_report',         label: 'Case Report',             description: 'Detailed patient/event case' },
  { value: 'brief_report',        label: 'Brief Report',            description: 'Short original findings' },
  { value: 'short_communication', label: 'Short Communication',     description: 'Concise preliminary findings' },
  { value: 'study_protocol',      label: 'Study Protocol',          description: 'Prospective protocol for a planned study or trial' },
  { value: 'opinion',             label: 'Opinion',                 description: 'Evidence-based position or perspective piece' },
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

// ── Visual inline splice ───────────────────────────────────────────────────────

interface VisualHandlers {
  onAccept: (item: VisualItem) => void;
  onDismiss: (item: VisualItem) => void;
  onEdit: (item: VisualItem) => void;
  onFinalize: (item: VisualItem) => void;
  onRegenerate: (item: VisualItem) => void;
  onSelectCandidate?: (item: VisualItem, candidateId: string) => void;
}

/**
 * spliceVisuals — post-process the ReactNode array from renderCeilsArticle
 * to inject VisualBlock components at the positions indicated by insert_after.
 *
 * Supports two formats:
 *   "after_paragraph:N"   — insert after the Nth <p> node (0-indexed)
 *   "after_heading:name"  — insert after the first heading whose text contains `name`
 */
function spliceVisuals(
  nodes: ReactNode[],
  items: VisualItem[],
  projectId: string,
  handlers: VisualHandlers,
): ReactNode[] {
  const activeItems = items.filter(i => i.status !== 'dismissed');
  if (activeItems.length === 0) return nodes;

  // Track paragraph indices in the nodes array
  let pCount = 0;
  // Map: nodeIndex → list of VisualItem to insert AFTER that node
  const insertAfterNode: Map<number, VisualItem[]> = new Map();

  for (const item of activeItems) {
    const spec = item.insert_after;
    if (!spec) continue;

    if (spec.startsWith('after_paragraph:')) {
      const targetP = parseInt(spec.replace('after_paragraph:', ''), 10);
      // Find the node index of the targetP-th paragraph
      let pIdx = 0;
      for (let ni = 0; ni < nodes.length; ni++) {
        const node = nodes[ni];
        if (node && typeof node === 'object' && 'type' in (node as object)) {
          const r = node as React.ReactElement;
          if (r.type === 'p') {
            if (pIdx === targetP) {
              const existing = insertAfterNode.get(ni) || [];
              existing.push(item);
              insertAfterNode.set(ni, existing);
              break;
            }
            pIdx++;
          }
        }
      }
    } else if (spec.startsWith('after_heading:')) {
      const headingText = spec.replace('after_heading:', '').toLowerCase().trim();
      // Find the first h2 or h3 whose text content contains headingText
      for (let ni = 0; ni < nodes.length; ni++) {
        const node = nodes[ni];
        if (node && typeof node === 'object' && 'type' in (node as object)) {
          const r = node as React.ReactElement<{ children?: ReactNode }>;
          if ((r.type === 'h2' || r.type === 'h3') && r.props?.children) {
            const text = String(r.props.children).toLowerCase();
            if (text.includes(headingText)) {
              const existing = insertAfterNode.get(ni) || [];
              existing.push(item);
              insertAfterNode.set(ni, existing);
              break;
            }
          }
        }
      }
    }
  }
  void pCount; // suppress unused warning

  if (insertAfterNode.size === 0) {
    // Fallback: append all at end
    const result = [...nodes];
    for (const item of activeItems) {
      result.push(
        <VisualBlock
          key={`visual-${item.id}`}
          item={item}
          projectId={projectId}
          {...handlers}
        />
      );
    }
    return result;
  }

  // Splice visual blocks at computed positions
  const result: ReactNode[] = [];
  for (let ni = 0; ni < nodes.length; ni++) {
    result.push(nodes[ni]);
    const toInsert = insertAfterNode.get(ni);
    if (toInsert) {
      for (const item of toInsert) {
        result.push(
          <VisualBlock
            key={`visual-${item.id}`}
            item={item}
            projectId={projectId}
            {...handlers}
          />
        );
      }
    }
  }

  // Items with no valid position fallback to end
  const placed = new Set<string>();
  insertAfterNode.forEach(items => items.forEach(i => placed.add(i.id)));
  for (const item of activeItems) {
    if (!placed.has(item.id)) {
      result.push(
        <VisualBlock
          key={`visual-${item.id}`}
          item={item}
          projectId={projectId}
          {...handlers}
        />
      );
    }
  }

  return result;
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

function sanitizeFilenameBase(value: string): string {
  const cleaned = Array.from(
    value.replace(/[<>:"/\\|?*]/g, ''),
  )
    .filter(ch => (ch.codePointAt(0) ?? 0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Manuscript';
}

// Base paragraph style: Times New Roman 12pt, 1.5 line spacing, justified
function bodyPara(text: string, opts?: { bold?: boolean; size?: number; spaceAfter?: number; spaceBefore?: number; center?: boolean }): Paragraph {
  return new Paragraph({
    alignment: opts?.center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
    spacing: { line: 360, after: opts?.spaceAfter ?? 160, before: opts?.spaceBefore ?? 0 },
    children: [new TextRun({
      text,
      font: 'Times New Roman',
      size: opts?.size ?? 24,        // half-points: 24 = 12pt
      bold: opts?.bold ?? false,
    })],
  });
}

async function fetchImageAsBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

function htmlTableToDocx(html: string, caption?: string): (Paragraph | Table)[] {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const tbl = wrapper.querySelector('table');
  if (!tbl) return [];

  const rows: TableRow[] = [];
  tbl.querySelectorAll('tr').forEach(tr => {
    const cells: TableCell[] = [];
    tr.querySelectorAll('th, td').forEach(td => {
      cells.push(new TableCell({
        children: [new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { line: 360 },
          children: [new TextRun({ text: td.textContent?.trim() ?? '', font: 'Times New Roman', size: 22, bold: td.tagName === 'TH' })],
        })],
        width: { size: 100 / Math.max(1, tr.children.length), type: WidthType.PERCENTAGE },
      }));
    });
    if (cells.length) rows.push(new TableRow({ children: cells }));
  });

  const out: (Paragraph | Table)[] = [];
  if (caption) out.push(bodyPara(caption, { bold: true, spaceAfter: 80 }));
  if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  out.push(bodyPara(''));
  return out;
}

// ── Visual inline positioning helpers ────────────────────────────────────────

type InsertSpec =
  | { kind: 'paragraph'; index: number }
  | { kind: 'heading'; name: string }
  | { kind: 'end' };

function parseInsertAfter(insertAfter?: string | null): InsertSpec {
  if (!insertAfter) return { kind: 'end' };
  if (insertAfter.startsWith('after_paragraph:')) {
    const n = parseInt(insertAfter.slice(16), 10);
    return isNaN(n) ? { kind: 'end' } : { kind: 'paragraph', index: n };
  }
  if (insertAfter.startsWith('after_heading:')) {
    return { kind: 'heading', name: insertAfter.slice(14).trim().toLowerCase() };
  }
  return { kind: 'end' };
}

async function renderVisualForDocx(
  item: VisualItem,
  projectId: string,
): Promise<(Paragraph | Table)[]> {
  const gen = item.generated;
  if (!gen) return [];
  const nodes: (Paragraph | Table)[] = [];

  if (item.type === 'table' && gen.table_html) {
    nodes.push(bodyPara(item.title, { bold: true, spaceBefore: 240, spaceAfter: 80 }));
    nodes.push(...htmlTableToDocx(gen.table_html, gen.caption ?? undefined));
  } else if (item.type === 'figure' && gen.image_url && projectId) {
    nodes.push(bodyPara(item.title, { bold: true, spaceBefore: 240, spaceAfter: 80 }));
    const imageUrl = `${gen.image_url}?cid=${gen.candidate_id ?? 'default'}`;
    const buf = await fetchImageAsBuffer(imageUrl);
    if (buf) {
      nodes.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: 360, after: 80 },
        children: [new ImageRun({ data: buf, transformation: { width: 480, height: 320 }, type: 'png' })],
      }));
    }
    if (gen.caption) nodes.push(bodyPara(gen.caption, { spaceAfter: 240 }));
  }
  return nodes;
}

async function downloadDocxFile(
  filename: string,
  title: string,
  content: string,
  visuals?: VisualItem[],
  projectId?: string,
) {
  // Build placement map keyed by "p:N", "h:name", or "end"
  const placements = new Map<string, VisualItem[]>();
  const activeVisuals = (visuals ?? []).filter(
    v => v.status === 'finalized' || v.status === 'generated',
  );
  for (const item of activeVisuals) {
    const spec = parseInsertAfter(item.insert_after);
    const key =
      spec.kind === 'paragraph' ? `p:${spec.index}` :
      spec.kind === 'heading'   ? `h:${spec.name}` :
      'end';
    if (!placements.has(key)) placements.set(key, []);
    placements.get(key)!.push(item);
  }
  const placed = new Set<string>();

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const children: (Paragraph | Table)[] = [];
  let paragraphIndex = 0;

  for (const line of lines) {
    const text = line.replace(/\[CK\]|\[INF\]|\[CITE:[^\]]+\]/g, '').trimEnd();

    if (!text.trim()) {
      children.push(bodyPara(''));
      continue;
    }

    if (text.startsWith('# ')) {
      children.push(bodyPara(text.slice(2), { bold: true, size: 28, spaceAfter: 200, center: true }));
      continue;
    }

    if (text.startsWith('### ')) {
      const headingText = text.slice(4);
      children.push(bodyPara(headingText, { bold: true, size: 24, spaceBefore: 160, spaceAfter: 80 }));
      const lower = headingText.toLowerCase();
      for (const [key, items] of placements) {
        if (key.startsWith('h:') && lower.includes(key.slice(2)) && !placed.has(key)) {
          placed.add(key);
          for (const item of items) children.push(...await renderVisualForDocx(item, projectId ?? ''));
        }
      }
      continue;
    }

    if (text.startsWith('## ')) {
      const headingText = text.slice(3);
      children.push(bodyPara(headingText, { bold: true, size: 26, spaceBefore: 240, spaceAfter: 120 }));
      const lower = headingText.toLowerCase();
      for (const [key, items] of placements) {
        if (key.startsWith('h:') && lower.includes(key.slice(2)) && !placed.has(key)) {
          placed.add(key);
          for (const item of items) children.push(...await renderVisualForDocx(item, projectId ?? ''));
        }
      }
      continue;
    }

    // Regular body paragraph
    children.push(bodyPara(text));
    const pKey = `p:${paragraphIndex}`;
    paragraphIndex++;
    if (placements.has(pKey) && !placed.has(pKey)) {
      placed.add(pKey);
      for (const item of placements.get(pKey)!) {
        children.push(...await renderVisualForDocx(item, projectId ?? ''));
      }
    }
  }

  // Fallback: visuals that didn't match any position go at the end
  for (const [key, items] of placements) {
    if (!placed.has(key)) {
      for (const item of items) children.push(...await renderVisualForDocx(item, projectId ?? ''));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { alignment: AlignmentType.JUSTIFIED, spacing: { line: 360 } },
        },
      },
    },
    sections: [{ children }],
  });
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
  const [projectName, setProjectName]       = useState('');
  const [titleSuggestions, setTitleSuggestions] = useState<TitleSuggestions | null>(null);
  const [titleState, setTitleState]         = useState<'idle' | 'generating' | 'approving' | 'done'>(
    initialTitle ? 'done' : 'idle'
  );
  const [titleError, setTitleError]         = useState<string | null>(null);
  const [showTitlePanel, setShowTitlePanel] = useState(false);

  // Load existing manuscript_title, article_type, and article draft from session on mount
  useEffect(() => {
    loadSession(sessionId).then(data => {
      if (data.project_name) {
        setProjectName(data.project_name);
      }
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
      // Restore persisted draft — no need to regenerate on every load
      if (data.article) {
        setArticleText(data.article);
        setWritingState('done');
      }
      if (data.visual_recommendations?.items?.length) {
        setVisualRecs(data.visual_recommendations);
      }
    }).catch(() => { /* silently ignore */ });
  }, [sessionId]);

  // Restore saved synthesis and peer review results on resume
  useEffect(() => {
    getSynthesisResult(sessionId).then(result => {
      if (result) {
        setSynthesis(result);
      }
    }).catch(() => {});

    getPeerReviewResult(sessionId).then(result => {
      if (result) {
        setReview(result);
        setReviewState('done');
      }
    }).catch(() => {});

    getDeepSynthesisResult(sessionId).then(result => {
      if (result) {
        setDeepSynthesis(result);
        setDeepSynthState('done');
      }
    }).catch(() => {});

    getVisualRecommendations(sessionId).then(recs => {
      if (recs && recs.items.length > 0) {
        setVisualRecs(recs);
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
  }, [selectedJournal]);

  // When article type changes, auto-update word limit from journal style
  useEffect(() => {
    if (!journalStyle) return;
    const jLimit = journalStyle.word_limits?.[articleType];
    if (jLimit) setWordLimit(jLimit);
  }, [articleType, journalStyle]);

  // Draft state
  const [articleText, setArticleText] = useState('');
  const [writingState, setWritingState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [writeError, setWriteError] = useState<string | null>(null);
  const [wordCount, setWordCount]   = useState(0);
  const [rawMode, setRawMode]       = useState(false);

  // Synthesis state
  const [synthesis, setSynthesis]   = useState<SynthesisResult | null>(null);

  // Peer review state
  const [review, setReview]         = useState<PeerReviewReport | null>(null);
  const [reviewState, setReviewState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Revision state
  const [revision, setRevision] = useState<RevisionResult | null>(null);
  const [revisionState, setRevisionState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Deep synthesis state
  const [deepSynthesis, setDeepSynthesis] = useState<DeepSynthesisResult | null>(null);
  const [deepSynthEvents, setDeepSynthEvents] = useState<DeepSynthesisSSEEvent[]>([]);
  const [deepSynthState, setDeepSynthState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [deepSynthError, setDeepSynthError] = useState<string | null>(null);

  // Visual recommendations state
  const [visualRecs, setVisualRecs] = useState<VisualRecommendations | null>(null);
  const [editingVisual, setEditingVisual] = useState<VisualItem | null>(null);
  const [promptEditingVisual, setPromptEditingVisual] = useState<VisualItem | null>(null);
  const [visualPlanningState, setVisualPlanningState] = useState<'idle' | 'running'>('idle');

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
      // Auto-draft only if no article exists yet (don't overwrite a persisted draft)
      if (!articleText) {
        await _draftArticle();
      }
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : 'Failed to save title.');
      setTitleState('idle');
    }
  }

  async function _draftArticle(force = false) {
    setWritingState('running');
    setWriteError(null);
    setArticleText('');
    try {
      const parsedMaxRefs = maxRefs.trim() !== '' ? parseInt(maxRefs, 10) : undefined;
      const result = await writeArticle(sessionId, selectedJournal, articleType, wordLimit, parsedMaxRefs, force);
      setArticleText(result.article ?? '');
      setWordCount(result.word_count ?? 0);
      setRefCount(result.ref_count ?? 0);
      setRefLimit(result.ref_limit ?? null);
      setRevision(null);
      if (result.visual_recommendations) {
        setVisualRecs(result.visual_recommendations);
      }
      setWritingState('done');
      changeTab('draft');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Article generation failed.';
      setWriteError(msg);
      setWritingState('error');
    }
  }

  async function handleWriteArticle() {
    if (!synthesis && !deepSynthesis) {
      setWriteError('Run Synthesis first (cross-paper or deep synthesis).');
      changeTab('synthesis');
      return;
    }
    // ── Title Quality Policy gate ──────────────────────────────────────────────
    if (!approvedTitle) {
      // No approved title: generate suggestions first
      await handleGenerateTitle();
      return;  // handleApproveTitle will trigger drafting after approval
    }
    // force=true when re-drafting an existing manuscript
    await _draftArticle(!!articleText);
  }

  function handleDeepSynthesize() {
    setDeepSynthState('running');
    setDeepSynthError(null);
    setDeepSynthEvents([]);
    setDeepSynthesis(null);
    changeTab('synthesis');

    const controller = streamDeepSynthesis(
      sessionId,
      (event) => {
        setDeepSynthEvents(prev => [...prev, event]);
        if (event.type === 'complete' && event.result) {
          setDeepSynthesis(event.result as DeepSynthesisResult);
          setDeepSynthState('done');
        }
      },
      true, // autoFetchEnabled
    );

    // Cleanup on unmount
    return () => controller.abort();
  }

  // ── Visual recommendation handlers ────────────────────────────────────────

  async function handleReplanVisuals() {
    setVisualPlanningState('running');
    try {
      const recs = await planVisuals(sessionId);
      setVisualRecs(recs);
    } catch { /* silently ignore */ }
    finally { setVisualPlanningState('idle'); }
  }

  async function handleAcceptVisual(item: VisualItem) {
    if (item.render_mode === 'ai_illustration') {
      setPromptEditingVisual(item);
      return;
    }
    // Optimistic status update
    setVisualRecs(prev => prev ? {
      ...prev,
      items: prev.items.map(i => i.id === item.id ? { ...i, status: 'generating' } : i),
    } : prev);
    try {
      const updated = await acceptVisual(sessionId, item.id);
      setVisualRecs(updated);
    } catch {
      // Revert status
      setVisualRecs(prev => prev ? {
        ...prev,
        items: prev.items.map(i => i.id === item.id ? { ...i, status: 'recommended' } : i),
      } : prev);
    }
  }

  function handleEditVisual(item: VisualItem) {
    if (item.render_mode === 'ai_illustration') {
      setPromptEditingVisual(item);
      return;
    }
    setEditingVisual(item);
  }

  async function handleDismissVisual(item: VisualItem) {
    try {
      const updated = await dismissVisual(sessionId, item.id);
      setVisualRecs(updated);
    } catch { /* silently ignore */ }
  }

  async function handleFinalizeVisual(item: VisualItem) {
    try {
      const updated = await finalizeVisual(sessionId, item.id);
      setVisualRecs(updated);
    } catch { /* silently ignore */ }
  }

  async function handleSelectCandidate(item: VisualItem, candidateId: string) {
    try {
      const updated = await selectVisualCandidate(sessionId, item.id, candidateId);
      setVisualRecs(updated);
    } catch { /* silently ignore */ }
  }

  function getDraftFilenameBase() {
    return sanitizeFilenameBase(
      approvedTitle.trim()
      || projectName.trim()
      || initialTitle?.trim()
      || 'Manuscript',
    );
  }

  function downloadArticle(mode: 'markdown' | 'plain') {
    const content = mode === 'plain'
      ? articleText.replace(/\[CK\]|\[INF\]|\[CITE:[^\]]+\]/g, '').replace(/#{1,3} /g, '')
      : articleText;
    const filenameBase = getDraftFilenameBase();
    downloadTextFile(
      `${filenameBase}.${mode === 'markdown' ? 'md' : 'txt'}`,
      content,
    );
  }

  async function downloadArticleDocx() {
    const filenameBase = getDraftFilenameBase();
    const docxTitle = approvedTitle || projectName || 'Manuscript';
    await downloadDocxFile(
      `${filenameBase}.docx`,
      docxTitle,
      articleText,
      visualRecs?.items ?? [],
      sessionId,
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

  async function handleGeneratePeerReview() {
    setReviewState('running');
    try {
      const result = await generatePeerReview(sessionId);
      setReview(result);
      setReviewState('done');
    } catch (err) {
      setReviewState('error');
      console.error('Peer review failed:', err);
    }
  }

  async function handleReviseAfterReview() {
    if (!articleText || !review) return;
    setRevisionState('running');
    try {
      const result = await reviseAfterReview(sessionId, articleText, review, selectedJournal);
      setRevision(result);
      if (result.revised_article) {
        setArticleText(result.revised_article);
        setWordCount(result.revised_article.split(/\s+/).filter(Boolean).length);
      }
      setRevisionState('done');
    } catch (err) {
      setRevisionState('error');
      console.error('Revision failed:', err);
    }
  }

  const decisionConf = review ? (DECISION_CONFIG[review.decision] ?? DECISION_CONFIG.major_revision) : null;
  const canDraft = Boolean(synthesis) || Boolean(deepSynthesis);
  const titleApproved = Boolean(approvedTitle);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base, #f8f9fa)' }}>

      {/* Top bar */}
      <header className="sticky top-0 z-10 flex justify-between items-center w-full px-8 py-3"
        style={{ background: 'var(--bg-base, #f8f9fa)' }}>
        <div className="flex items-center gap-6">
          <button onClick={onBack}
            className="p-2 rounded-lg transition-colors hover:bg-slate-200/50"
            style={{ color: 'var(--text-secondary, #64748b)' }}>
            <span className="material-symbols-outlined text-xl">arrow_back</span>
          </button>
          <div className="relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3"
              style={{ color: 'var(--text-muted, #94a3b8)' }}>
              <span className="material-symbols-outlined text-sm">search</span>
            </span>
            <input
              className="border-none rounded-full py-2 pl-10 pr-4 text-sm w-64 focus:ring-2 transition-all"
              style={{
                background: 'var(--bg-hover, #e7e8e9)',
                fontFamily: 'Manrope, sans-serif',
                color: 'var(--text-body, #1e293b)',
              }}
              placeholder="Search manuscript..."
              type="text"
            />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 mr-4 pr-4"
            style={{ borderRight: '1px solid var(--border-faint, #e5e7eb)' }}>
            <button className="p-2 transition-colors rounded-lg hover:bg-slate-200/50"
              style={{ color: 'var(--text-muted, #94a3b8)' }}>
              <span className="material-symbols-outlined">history</span>
            </button>
            <button className="p-2 transition-colors rounded-lg hover:bg-slate-200/50"
              style={{ color: 'var(--text-muted, #94a3b8)' }}>
              <span className="material-symbols-outlined">auto_awesome</span>
            </button>
            <button onClick={onOpenSettings}
              className="p-2 transition-colors rounded-lg hover:bg-slate-200/50"
              style={{ color: 'var(--text-muted, #94a3b8)' }}>
              <span className="material-symbols-outlined">settings</span>
            </button>
          </div>
          <button className="px-4 py-2 text-sm font-medium transition-colors hover:opacity-80"
            style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
            Share
          </button>
          <button
            onClick={handleWriteArticle}
            disabled={writingState === 'running' || !canDraft}
            className="px-5 py-2 rounded-lg font-semibold text-sm text-white transition-all active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              fontFamily: 'Manrope, sans-serif',
              background: 'var(--gold, #4f46e5)',
              boxShadow: '0 2px 8px rgba(79,70,229,0.15)',
            }}
            title={!canDraft ? 'Run synthesis first' : undefined}
          >
            {writingState === 'running' ? (
              <span className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                Drafting…
              </span>
            ) : articleText ? 'Re-draft' : 'Draft Manuscript'}
          </button>
        </div>
      </header>

      {/* Workspace canvas */}
      <div className="flex-grow flex flex-col items-center p-8 lg:p-12 overflow-y-auto">
        <div className="w-full max-w-4xl space-y-10">

          {/* ── Manuscript Header ── */}
          <section className="space-y-6">
            <div className="flex justify-between items-end">
              <div className="flex-grow pr-12">
                {/* Large serif title */}
                {titleApproved ? (
                  <h1 className="p-0 m-0 leading-tight"
                    style={{
                      fontFamily: 'Newsreader, Georgia, serif',
                      fontSize: '3rem',
                      fontWeight: 600,
                      color: 'var(--text-bright, #1e293b)',
                    }}>
                    {approvedTitle}
                  </h1>
                ) : (
                  <input
                    className="bg-transparent border-none p-0 focus:ring-0 w-full"
                    style={{
                      fontFamily: 'Newsreader, Georgia, serif',
                      fontSize: '3rem',
                      fontWeight: 600,
                      color: 'var(--text-bright, #1e293b)',
                    }}
                    placeholder="Enter manuscript title..."
                    readOnly
                    value=""
                  />
                )}
                <p className="text-sm mt-3 flex items-center gap-2"
                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
                  <span className="material-symbols-outlined text-sm">calendar_today</span>
                  {selectedJournal}
                  {wordCount > 0 && <> · {wordCount.toLocaleString()} words</>}
                </p>
                {titleError && (
                  <p className="text-xs text-rose-600 mt-2">{titleError}</p>
                )}
              </div>
              <button
                onClick={handleGenerateTitle}
                disabled={titleState === 'generating'}
                className="flex items-center gap-2 font-semibold text-sm whitespace-nowrap mb-1
                  hover:opacity-80 transition-opacity disabled:opacity-40"
                style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--gold, #4f46e5)' }}
              >
                <span className="material-symbols-outlined text-lg">magic_button</span>
                {titleState === 'generating' ? 'Generating…' : titleApproved ? 'Change Title' : 'Generate Title'}
              </button>
            </div>

            {/* Title approval panel */}
            {showTitlePanel && titleSuggestions && (
              <div className="rounded-xl p-4" style={{ background: 'var(--gold-faint, #ede9fe)', border: '1px solid var(--border-faint, #e5e7eb)' }}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}>
                    Title Suggestions
                  </h3>
                  <button onClick={() => setShowTitlePanel(false)}
                    className="text-xs hover:opacity-80" style={{ color: 'var(--text-muted, #94a3b8)' }}>
                    <span className="material-symbols-outlined text-sm">close</span>
                  </button>
                </div>
                <TitleApprovalPanel
                  suggestions={titleSuggestions}
                  onApprove={handleApproveTitle}
                  loading={titleState === 'approving'}
                />
              </div>
            )}

            {/* Settings Bento Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
              {/* Article Type card */}
              <div className="rounded-xl p-5 flex flex-col gap-1"
                style={{ background: 'var(--bg-hover, #f3f4f5)' }}>
                <label className="text-[10px] uppercase tracking-widest font-bold opacity-60"
                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
                  Article Type
                </label>
                <div className="flex items-center justify-between mt-1">
                  <select value={articleType} onChange={e => setArticleType(e.target.value)}
                    className="appearance-none bg-transparent border-none p-0 font-semibold text-sm focus:ring-0 cursor-pointer flex-1"
                    style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}>
                    {ARTICLE_TYPES
                      .filter(t =>
                        !journalStyle?.accepted_article_types?.length ||
                        journalStyle.accepted_article_types.includes(t.value)
                      )
                      .map(t => <option key={t.value} value={t.value}>{t.label}</option>)
                    }
                  </select>
                  <span className="material-symbols-outlined text-lg"
                    style={{ color: 'var(--text-secondary, #64748b)' }}>expand_more</span>
                </div>
              </div>

              {/* Word Limit card */}
              <div className="rounded-xl p-5 flex flex-col gap-1"
                style={{ background: 'var(--bg-hover, #f3f4f5)' }}>
                <label className="text-[10px] uppercase tracking-widest font-bold opacity-60"
                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
                  Word Limit
                </label>
                <div className="flex items-center justify-between mt-1">
                  <input
                    type="number" min={500} max={15000} step={100}
                    value={wordLimit}
                    onChange={e => {
                      const v = Math.max(500, Math.min(15000, Number(e.target.value) || 4000));
                      setWordLimit(v);
                    }}
                    className="appearance-none bg-transparent border-none p-0 font-semibold text-sm focus:ring-0 w-20"
                    style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}
                  />
                  <span className="font-semibold text-sm" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}>Words</span>
                  <span className="material-symbols-outlined text-lg ml-2"
                    style={{ color: 'var(--text-secondary, #64748b)' }}>edit</span>
                </div>
              </div>

              {/* Max References card */}
              <div className="rounded-xl p-5 flex flex-col gap-1"
                style={{ background: 'var(--bg-hover, #f3f4f5)' }}>
                <label className="text-[10px] uppercase tracking-widest font-bold opacity-60"
                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
                  Max References
                </label>
                <div className="flex items-center justify-between mt-1">
                  <input
                    type="number" min={5} max={300} step={5}
                    value={maxRefs}
                    onChange={e => setMaxRefs(e.target.value)}
                    className="appearance-none bg-transparent border-none p-0 font-semibold text-sm focus:ring-0 w-16"
                    style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}
                    placeholder="60"
                  />
                  <span className="font-semibold text-sm" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-bright, #1e293b)' }}>Citations</span>
                  <span className="material-symbols-outlined text-lg ml-2"
                    style={{ color: 'var(--text-secondary, #64748b)' }}>format_list_numbered</span>
                </div>
              </div>
            </div>

            {/* Citation style badges (compact row) */}
            {journalStyle && (
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium" style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-muted, #94a3b8)' }}>Citation:</span>
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

            {/* Word count + ref count badges (shown after drafting) */}
            {writingState === 'done' && articleText && (
              <div className="flex flex-wrap gap-2">
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
          </section>

          {/* ── Tabbed Interface ── */}
          <section className="space-y-6">

        {/* Tab bar */}
        <div className="flex items-center gap-8 border-b" style={{ borderColor: 'var(--border-faint, #e5e7eb)' }}>
          {([
            { id: 'synthesis',  label: 'Synthesis',           badge: synthesis ? `${synthesis.evidence_matrix.length} claims` : undefined },
            { id: 'draft',      label: 'Draft Manuscript',    badge: wordCount > 0 ? `${wordCount.toLocaleString()}w` : undefined },
            { id: 'peerreview', label: 'Peer Review',         badge: review ? review.decision.replace('_', ' ') : undefined },
            { id: 'revision',   label: 'Revision',            badge: revision ? 'ready' : undefined },
          ] as Array<{ id: MainTab; label: string; badge?: string }>).map(t => (
            <button
              key={t.id}
              onClick={() => changeTab(t.id)}
              className={`relative pb-4 text-sm font-semibold transition-colors ${
                tab === t.id
                  ? 'text-indigo-600'
                  : 'text-slate-400 hover:text-slate-700'
              }`}
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {t.label}
              {t.badge && (
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                  tab === t.id ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  {t.badge}
                </span>
              )}
              {tab === t.id && (
                <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full" />
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
                <LoadingLottie className="w-16 h-16 mx-auto" label="Drafting your manuscript…" />
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
                    <button
                      onClick={handleReplanVisuals}
                      disabled={visualPlanningState === 'running'}
                      title="Suggest tables and figures for this manuscript"
                      className="px-3 py-1.5 rounded-lg border border-violet-200 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 transition-colors"
                    >
                      {visualPlanningState === 'running' ? '⟳ Planning…' : '◎ Suggest Visuals'}
                    </button>
                    {visualRecs && visualRecs.items.length > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 font-semibold">
                        {visualRecs.items.filter(i => i.status !== 'dismissed').length} visuals
                      </span>
                    )}
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
                    {spliceVisuals(
                      renderCeilsArticle(articleText),
                      visualRecs?.items ?? [],
                      sessionId,
                      {
                        onAccept: handleAcceptVisual,
                        onDismiss: handleDismissVisual,
                        onEdit: handleEditVisual,
                        onFinalize: handleFinalizeVisual,
                        onRegenerate: handleEditVisual,
                        onSelectCandidate: handleSelectCandidate,
                      }
                    )}
                  </div>
                )}

                {/* ── Proceed to Peer Review CTA ── */}
                <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-100 rounded-b-2xl"
                  style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                  <span className="text-xs text-slate-400" style={{ fontFamily: 'Manrope, sans-serif' }}>
                    Draft complete · {wordCount.toLocaleString()} words
                  </span>
                  <button
                    onClick={() => onTabChange?.('peerreview')}
                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:opacity-90"
                    style={{
                      fontFamily: 'Manrope, sans-serif',
                      background: 'var(--gold, #4f46e5)',
                      boxShadow: '0 2px 8px rgba(79,70,229,0.15)',
                    }}
                  >
                    Proceed to Peer Review
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Synthesis tab ─────────────────────────────────────────────────── */}
        {tab === 'synthesis' && (
          <div className="space-y-6">
            {deepSynthError && (
              <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                {deepSynthError}
              </p>
            )}

            {/* Empty state — Deep Synthesis CTA */}
            {deepSynthState === 'idle' && !deepSynthesis && (
              <div className="rounded-2xl p-12 min-h-[400px] flex flex-col items-center justify-center text-center"
                style={{
                  background: 'var(--bg-surface, #fff)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                  border: '1px solid var(--border-faint, #f1f1f4)',
                }}>
                <div className="w-20 h-20 rounded-3xl flex items-center justify-center mb-6"
                  style={{ background: 'var(--gold-faint, #ede9fe)' }}>
                  <span className="material-symbols-outlined text-4xl"
                    style={{ color: 'var(--gold, #4f46e5)', fontVariationSettings: "'FILL' 1" }}>psychology</span>
                </div>
                <h2 className="text-2xl font-semibold mb-3"
                  style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright, #1e293b)' }}>
                  Deep Evidence Synthesis
                </h2>
                <p className="max-w-lg mx-auto mb-8 text-sm leading-relaxed"
                  style={{ fontFamily: 'Manrope, sans-serif', color: 'var(--text-secondary, #64748b)' }}>
                  Multi-stage pipeline that normalizes claims, clusters evidence, detects contradictions,
                  auto-fetches missing papers, maps theoretical frameworks, and builds manuscript-ready evidence packs.
                </p>

                {/* Pipeline stages preview */}
                <div className="flex items-center gap-1 mb-8">
                  {[
                    { icon: 'data_object', label: 'Extract' },
                    { icon: 'transform', label: 'Normalize' },
                    { icon: 'travel_explore', label: 'Auto-Fetch' },
                    { icon: 'hub', label: 'Cluster' },
                    { icon: 'psychology', label: 'Synthesize' },
                    { icon: 'school', label: 'Theories' },
                    { icon: 'inventory_2', label: 'Pack' },
                  ].map((stage, i) => (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-slate-50 text-slate-400">
                        <span className="material-symbols-outlined text-base">{stage.icon}</span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-medium">{stage.label}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleDeepSynthesize}
                  className="inline-flex items-center gap-3 px-8 py-4 rounded-xl font-bold text-white
                    transition-all hover:shadow-lg active:scale-95"
                  style={{
                    fontFamily: 'Manrope, sans-serif',
                    background: 'linear-gradient(135deg, var(--gold, #4f46e5), var(--gold-light, #6366f1))',
                    boxShadow: '0 4px 16px rgba(79,70,229,0.2)',
                  }}
                >
                  <span className="material-symbols-outlined text-xl">play_arrow</span>
                  Start Deep Synthesis
                </button>
              </div>
            )}

            {/* Deep synthesis running/results */}
            {(deepSynthState === 'running' || deepSynthesis) && (
              <DeepSynthesisPanel
                result={deepSynthesis}
                events={deepSynthEvents}
                isRunning={deepSynthState === 'running'}
              />
            )}
          </div>
        )}

        {/* ── Peer Review tab ───────────────────────────────────────────────── */}
        {tab === 'peerreview' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">

            {!review && reviewState !== 'running' && (
              <div className="py-12 flex flex-col items-center justify-center text-center gap-6">
                {!articleText ? (
                  <p className="text-slate-400 text-sm">Draft your article first, then generate a peer review.</p>
                ) : (
                  <>
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                      style={{ background: 'var(--gold-faint, #ede9fe)' }}>
                      <span className="material-symbols-outlined text-3xl"
                        style={{ color: 'var(--gold, #4f46e5)', fontVariationSettings: "'FILL' 1" }}>rate_review</span>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold mb-1"
                        style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright, #1e293b)' }}>
                        Ready for Peer Review
                      </h3>
                      <p className="text-sm text-slate-400 max-w-md">
                        Generate a rigorous reviewer report with major/minor concerns and revision recommendations.
                      </p>
                    </div>
                    <button
                      onClick={handleGeneratePeerReview}
                      disabled={reviewState === 'error'}
                      className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-white
                        transition-all hover:shadow-lg active:scale-95"
                      style={{
                        fontFamily: 'Manrope, sans-serif',
                        background: 'linear-gradient(135deg, var(--gold, #4f46e5), var(--gold-light, #6366f1))',
                        boxShadow: '0 4px 16px rgba(79,70,229,0.2)',
                      }}
                    >
                      <span className="material-symbols-outlined text-lg">play_arrow</span>
                      Generate Peer Review
                    </button>
                  </>
                )}
              </div>
            )}

            {reviewState === 'running' && (
              <div className="py-12 text-center">
                <LoadingLottie className="w-16 h-16 mx-auto" label="Generating peer review report…" />
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

                {/* Proceed to Revision CTA */}
                <div className="flex items-center justify-end pt-4 border-t border-slate-100">
                  <button
                    onClick={() => onTabChange?.('revision')}
                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:opacity-90"
                    style={{
                      fontFamily: 'Manrope, sans-serif',
                      background: 'var(--gold, #4f46e5)',
                      boxShadow: '0 2px 8px rgba(79,70,229,0.15)',
                    }}
                  >
                    Proceed to Revision
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Revision tab ─────────────────────────────────────────────────── */}
        {tab === 'revision' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
            {!revision && revisionState !== 'running' && (
              <div className="py-12 flex flex-col items-center justify-center text-center gap-6">
                {!review ? (
                  <p className="text-slate-400 text-sm">Generate peer review first, then run revision.</p>
                ) : (
                  <>
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                      style={{ background: 'var(--gold-faint, #ede9fe)' }}>
                      <span className="material-symbols-outlined text-3xl"
                        style={{ color: 'var(--gold, #4f46e5)', fontVariationSettings: "'FILL' 1" }}>edit_note</span>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold mb-1"
                        style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright, #1e293b)' }}>
                        Ready for Revision
                      </h3>
                      <p className="text-sm text-slate-400 max-w-md">
                        Revise the manuscript based on peer review feedback and generate a point-by-point response letter.
                      </p>
                    </div>
                    <button
                      onClick={handleReviseAfterReview}
                      className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-white
                        transition-all hover:shadow-lg active:scale-95"
                      style={{
                        fontFamily: 'Manrope, sans-serif',
                        background: 'linear-gradient(135deg, var(--gold, #4f46e5), var(--gold-light, #6366f1))',
                        boxShadow: '0 4px 16px rgba(79,70,229,0.2)',
                      }}
                    >
                      <span className="material-symbols-outlined text-lg">play_arrow</span>
                      Revise + Response Letter
                    </button>
                  </>
                )}
              </div>
            )}

            {revisionState === 'running' && (
              <div className="py-12 text-center">
                <LoadingLottie className="w-16 h-16 mx-auto" label="Revising manuscript and drafting response letter…" />
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

          </section>{/* end Tabbed Interface */}
        </div>{/* end max-w-4xl */}
      </div>{/* end workspace canvas */}

      {/* Visual Edit Modal */}
      {editingVisual && (
        <VisualEditModal
          item={editingVisual}
          projectId={sessionId}
          onClose={() => setEditingVisual(null)}
          onUpdated={(recs) => {
            setVisualRecs(recs);
            const updated = recs.items.find(i => i.id === editingVisual.id);
            if (updated) setEditingVisual(updated);
          }}
        />
      )}
      {promptEditingVisual && (
        <IllustrationPromptModal
          item={promptEditingVisual}
          projectId={sessionId}
          onClose={() => setPromptEditingVisual(null)}
          onUpdated={(recs) => {
            setVisualRecs(recs);
            const updated = recs.items.find(i => i.id === promptEditingVisual.id);
            if (updated) setPromptEditingVisual(updated);
          }}
        />
      )}
    </div>
  );
}
