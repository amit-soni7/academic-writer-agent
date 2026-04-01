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
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { AlignmentType, Document, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import type {
  ConsistencyAuditResult,
  DeepSynthesisResult,
  DeepSynthesisSSEEvent,
  EditorialReviewResult,
  JournalStyle,
  PeerReviewReport,
  ReReviewResult,
  RevisionActionMap,
  RevisionAgentStatus,
  RevisionResult,
  SynthesisResult,
  VisualItem,
  VisualRecommendations,
} from '../../types/paper';
import {
  applyFollowupRevision,
  finalizeRevisionResponse,
  getRevisionAgentStatus,
  getSynthesisResult,
  streamDeepSynthesis,
  getDeepSynthesisResult,
  getPeerReviewResult,
  generatePeerReview,
  generateRevisionActionMap,
  reviseAfterReview,
  runConsistencyAudit,
  generateReReview,
  downloadResponseLetterDocx,
  getManuscriptExportText,
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
  generateEditorialReview,
  resumeRevisionAgent,
  runRevisionAgent,
  stopRevisionAgent,
} from '../../api/projects';
import type { TitleSuggestions } from '../../api/projects';
import type { PaperSummary } from '../../types/paper';
import DeepSynthesisPanel from './DeepSynthesisPanel';
import LoadingLottie from '../LoadingLottie';
import IllustrationPromptModal from './IllustrationPromptModal';
import RevisionAgentOverlay from './RevisionAgentOverlay';
import VisualBlock from './VisualBlock';
import VisualEditModal from './VisualEditModal';
import ReferenceSidebar from './ReferenceSidebar';

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

type InlineRenderer = (str: string, baseKey: string) => ReactNode[];

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cleaned = line.trim();
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(cleaned);
}

function renderResponsiveTable(
  headers: string[],
  rows: string[][],
  key: string,
  renderInline: InlineRenderer,
  caption?: string,
): ReactNode {
  const effectiveHeaders = headers.length > 0 ? headers : rows[0]?.map((_, idx) => `Column ${idx + 1}`) ?? [];
  return (
    <div key={key} className="my-5 space-y-3">
      {caption ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {caption}
        </p>
      ) : null}
      <div className="space-y-2 md:hidden">
        {rows.map((row, rowIdx) => (
          <div key={`${key}-card-${rowIdx}`} className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
            <dl className="space-y-2">
              {effectiveHeaders.map((header, colIdx) => (
                <div key={`${key}-card-${rowIdx}-${colIdx}`} className="space-y-0.5">
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{header}</dt>
                  <dd className="text-sm text-slate-700 leading-relaxed">
                    {renderInline(row[colIdx] ?? '', `${key}-card-${rowIdx}-${colIdx}`)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 md:block">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {effectiveHeaders.map((header, idx) => (
                <th key={`${key}-head-${idx}`} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((row, rowIdx) => (
              <tr key={`${key}-row-${rowIdx}`}>
                {effectiveHeaders.map((_, colIdx) => (
                  <td key={`${key}-cell-${rowIdx}-${colIdx}`} className="px-4 py-3 text-sm text-slate-700 align-top leading-relaxed">
                    {renderInline(row[colIdx] ?? '', `${key}-cell-${rowIdx}-${colIdx}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderMarkdownTableBlock(
  lines: string[],
  key: string,
  renderInline: InlineRenderer,
): ReactNode {
  const header = splitMarkdownTableRow(lines[0] ?? '');
  const rows = lines.slice(2).map(splitMarkdownTableRow).filter(row => row.some(cell => cell.length > 0));
  return renderResponsiveTable(header, rows, key, renderInline);
}

function renderHtmlTableBlock(
  html: string,
  key: string,
  renderInline: InlineRenderer,
): ReactNode | null {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const table = wrapper.querySelector('table');
  if (!table) return null;

  const caption = table.querySelector('caption')?.textContent?.trim() ?? '';
  const headers = Array.from(table.querySelectorAll('thead th')).map(cell => cell.textContent?.trim() ?? '');
  const inferredHeaders = headers.length > 0
    ? headers
    : Array.from(table.querySelectorAll('tr')).slice(0, 1).flatMap(row =>
        Array.from(row.querySelectorAll('th')).map(cell => cell.textContent?.trim() ?? ''),
      );
  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  const fallbackRows = bodyRows.length > 0
    ? bodyRows
    : Array.from(table.querySelectorAll('tr')).slice(inferredHeaders.length > 0 ? 1 : 0);
  const rows = fallbackRows.map(row =>
    Array.from(row.querySelectorAll('th, td')).map(cell => cell.textContent?.trim() ?? ''),
  ).filter(row => row.some(cell => cell.length > 0));

  return renderResponsiveTable(inferredHeaders, rows, key, renderInline, caption || undefined);
}

function renderMarkdownImageBlock(line: string, key: string): ReactNode | null {
  const match = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)$/);
  if (!match) return null;
  const [, alt, src, title] = match;
  return (
    <figure key={key} className="my-5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <img src={src} alt={alt || title || 'Illustration'} className="w-full rounded-xl border border-slate-200 bg-white object-contain" />
      {(title || alt) ? (
        <figcaption className="mt-3 text-xs text-slate-600 leading-relaxed">{title || alt}</figcaption>
      ) : null}
    </figure>
  );
}

function renderHtmlImageBlock(line: string, key: string): ReactNode | null {
  if (!/<img\b/i.test(line)) return null;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = line.trim();
  const img = wrapper.querySelector('img');
  if (!img) return null;
  const src = img.getAttribute('src') ?? '';
  if (!src) return null;
  const alt = img.getAttribute('alt') ?? '';
  const title = img.getAttribute('title') ?? '';
  return (
    <figure key={key} className="my-5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <img src={src} alt={alt || title || 'Illustration'} className="w-full rounded-xl border border-slate-200 bg-white object-contain" />
      {(title || alt) ? (
        <figcaption className="mt-3 text-xs text-slate-600 leading-relaxed">{title || alt}</figcaption>
      ) : null}
    </figure>
  );
}

function renderCeilsArticle(
  text: string,
  opts?: { onCiteClick?: (key: string) => void; highlightedPaperKey?: string | null },
): ReactNode[] {
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
        const citeKey = part.slice(6, -1);
        const isHighlighted = opts?.highlightedPaperKey && (
          citeKey.toLowerCase() === opts.highlightedPaperKey.toLowerCase()
          || citeKey.toLowerCase().includes(opts.highlightedPaperKey.toLowerCase())
          || opts.highlightedPaperKey.toLowerCase().includes(citeKey.toLowerCase())
        );
        return (
          <span key={k}
            data-cite-key={citeKey}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold
              bg-blue-100 text-blue-700 border border-blue-300 align-middle mx-0.5 font-mono cursor-pointer
              hover:bg-blue-200 transition-all ${isHighlighted ? 'ring-2 ring-blue-500 bg-blue-200 scale-105' : ''}`}
            title={`Cited from: ${citeKey}`}
            onClick={(e) => { e.stopPropagation(); opts?.onCiteClick?.(citeKey); }}>
            ↗ {citeKey}
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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('<table')) {
      flushPara(); flushList();
      const tableLines = [line];
      while (i + 1 < lines.length && !tableLines[tableLines.length - 1].includes('</table>')) {
        i += 1;
        tableLines.push(lines[i]);
      }
      const rendered = renderHtmlTableBlock(tableLines.join('\n'), nextKey(), renderInline);
      if (rendered) nodes.push(rendered);
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isMarkdownTableSeparator(lines[i + 1])) {
      flushPara(); flushList();
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i += 1;
      }
      nodes.push(renderMarkdownTableBlock(tableLines, nextKey(), renderInline));
      continue;
    }

    const markdownImage = renderMarkdownImageBlock(line, nextKey());
    if (markdownImage) {
      flushPara(); flushList();
      nodes.push(markdownImage);
      i += 1;
      continue;
    }

    const htmlImage = renderHtmlImageBlock(line, nextKey());
    if (htmlImage) {
      flushPara(); flushList();
      nodes.push(htmlImage);
      i += 1;
      continue;
    }

    if (/^# /.test(line)) {
      flushPara(); flushList();
      nodes.push(
        <h1 key={nextKey()} className="text-2xl font-bold text-slate-900 mt-2 mb-5 pb-3 border-b-2 border-slate-200 leading-tight">
          {line.slice(2)}
        </h1>
      );
      i += 1;
      continue;
    }

    if (/^## /.test(line)) {
      flushPara(); flushList();
      const heading = line.slice(3).trim();
      inAbstract = /^abstract$/i.test(heading);
      inReferences = /^references$/i.test(heading);
      if (inAbstract) {
        nodes.push(
          <h2 key={nextKey()} className="text-base font-bold mt-8 mb-3 pb-1.5 border-b-2 border-violet-300 text-violet-800">
            {heading}
          </h2>
        );
      } else if (inReferences) {
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
      i += 1;
      continue;
    }

    if (/^### /.test(line)) {
      flushPara(); flushList();
      nodes.push(
        <h3 key={nextKey()} className="text-base font-semibold text-slate-700 mt-5 mb-2">
          {line.slice(4).trim()}
        </h3>
      );
      i += 1;
      continue;
    }

    if (/^#### /.test(line)) {
      flushPara(); flushList();
      nodes.push(
        <h4 key={nextKey()} className="text-sm font-semibold text-slate-600 mt-4 mb-1">
          {line.slice(5).trim()}
        </h4>
      );
      i += 1;
      continue;
    }

    if (/^[-*] /.test(line)) {
      flushPara();
      listItems.push({ ordered: false, text: line.slice(2).trim() });
      i += 1;
      continue;
    }

    if (/^\d+\. /.test(line)) {
      flushPara();
      listItems.push({ ordered: true, text: line.replace(/^\d+\. /, '').trim() });
      i += 1;
      continue;
    }

    if (!trimmed) {
      flushPara(); flushList();
      i += 1;
      continue;
    }

    flushList();
    paraLines.push(line);
    i += 1;
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
  _title: string,
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
    const text = line.replace(/\[CK\]|\[INF\]/g, '').trimEnd();

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

const BASIS_BADGE: Record<string, { label: string; cls: string }> = {
  manuscript_only: { label: 'Manuscript', cls: 'bg-blue-50 text-blue-600 border-blue-200' },
  evidence_only:   { label: 'Evidence',   cls: 'bg-purple-50 text-purple-600 border-purple-200' },
  both:            { label: 'Both',       cls: 'bg-slate-50 text-slate-600 border-slate-200' },
};

const CONFIDENCE_BADGE: Record<string, { cls: string }> = {
  high:   { cls: 'bg-rose-50 text-rose-600' },
  medium: { cls: 'bg-amber-50 text-amber-600' },
  low:    { cls: 'bg-slate-50 text-slate-500' },
};

const RATING_CONFIG: Record<string, { label: string; cls: string; icon: string }> = {
  strong:   { label: 'Strong',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'check_circle' },
  adequate: { label: 'Adequate', cls: 'bg-blue-50 text-blue-700 border-blue-200',         icon: 'info' },
  weak:     { label: 'Weak',     cls: 'bg-amber-50 text-amber-700 border-amber-200',      icon: 'warning' },
  missing:  { label: 'Missing',  cls: 'bg-rose-50 text-rose-700 border-rose-200',         icon: 'error' },
};

function ConcernCard({ concern, index, level }: {
  concern: PeerReviewReport['major_concerns'][0];
  index: number;
  level: 'major' | 'minor';
}) {
  const [open, setOpen] = useState(false);
  const borderCls = level === 'major' ? 'border-rose-200' : 'border-amber-200';
  const bgCls     = level === 'major' ? 'bg-rose-50/30' : 'bg-amber-50/30';
  const numCls    = level === 'major' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700';
  const basis = concern.basis ? BASIS_BADGE[concern.basis] : null;
  const conf = concern.confidence ? CONFIDENCE_BADGE[concern.confidence] : null;

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
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {concern.location && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 font-medium">
                {concern.location}
              </span>
            )}
            {basis && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${basis.cls}`}>
                {basis.label}
              </span>
            )}
            {conf && concern.confidence !== 'high' && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${conf.cls}`}>
                {concern.confidence} confidence
              </span>
            )}
            {concern.paper_ids.length > 0 && concern.paper_ids.map((p, i) => (
              <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200">
                {p}
              </span>
            ))}
          </div>
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
          {concern.satisfaction_criterion && (
            <div className="bg-emerald-50/50 border border-emerald-200 rounded-lg px-3 py-2.5">
              <p className="font-semibold text-emerald-600 uppercase tracking-wide mb-1">What would resolve this</p>
              <p className="text-emerald-800 leading-relaxed">{concern.satisfaction_criterion}</p>
            </div>
          )}
          {(concern.problem_type || concern.severity) && (
            <div className="flex flex-wrap gap-1.5">
              {concern.problem_type && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-200 font-medium">
                  {concern.problem_type.replace('_', ' ')}
                </span>
              )}
              {concern.severity && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  concern.severity === 'high'
                    ? 'bg-rose-50 text-rose-600 border border-rose-200'
                    : 'bg-amber-50 text-amber-600 border border-amber-200'
                }`}>
                  {concern.severity} severity
                </span>
              )}
              {concern.resolvable === false && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200 font-medium">
                  may not be resolvable
                </span>
              )}
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

function CollapsibleSection({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded-xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-800">
        <span>{title}</span>
        <span className="text-xs font-medium text-slate-400">{meta ?? 'Expand'}</span>
      </summary>
      <div className="border-t border-slate-100 p-4">
        {children}
      </div>
    </details>
  );
}

function ResponseLetterPreview({ revision }: { revision: RevisionResult }) {
  const responseData = revision.response_data as {
    novelty_summary?: string;
    major_changes_list?: string[];
    responses?: Array<Record<string, unknown>>;
  } | undefined;

  if (responseData?.responses?.length) {
    const grouped = responseData.responses.reduce<Record<number, Array<Record<string, unknown>>>>((acc, item) => {
      const reviewer = Number(item.reviewer_number ?? 1);
      acc[reviewer] = acc[reviewer] || [];
      acc[reviewer].push(item);
      return acc;
    }, {});

    return (
      <div className="space-y-4">
        {responseData.novelty_summary && (
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Cover Note</h4>
            <p className="text-sm text-slate-700 leading-relaxed">{responseData.novelty_summary}</p>
          </div>
        )}
        {responseData.major_changes_list?.length ? (
          <div className="rounded-xl bg-emerald-50/50 border border-emerald-200 px-4 py-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700 mb-1.5">Major Changes</h4>
            <ul className="space-y-1">
              {responseData.major_changes_list.map((item, idx) => (
                <li key={idx} className="text-sm text-emerald-900 leading-relaxed">• {item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {Object.entries(grouped).sort((a, b) => Number(a[0]) - Number(b[0])).map(([reviewer, items]) => (
          <div key={reviewer} className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800">Reviewer {reviewer}</h4>
            {items.map((item, idx) => (
              <div key={`${reviewer}-${idx}`} className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 font-medium">
                    Comment {String(item.comment_number ?? idx + 1)}
                  </span>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Reviewer Comment</p>
                  <p className="text-sm text-slate-800 leading-relaxed">{String(item.reviewer_comment ?? '')}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Author Reply</p>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{String(item.author_reply ?? '')}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Changes Done</p>
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {String(item.changes_done ?? '') || 'No manuscript change required.'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
      {revision.point_by_point_reply || 'No response letter returned.'}
    </div>
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
      // Load paper summaries for reference sidebar
      if (data.summaries && typeof data.summaries === 'object') {
        setSummaries(data.summaries as Record<string, PaperSummary>);
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

  useEffect(() => {
    fetchRevisionAgentStatusSnapshot().catch(() => {});
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

  // Reference sidebar state
  const [, setSummaries] = useState<Record<string, PaperSummary>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [highlightedCiteKey, setHighlightedCiteKey] = useState<string | null>(null);
  const [highlightedPaperKey, setHighlightedPaperKey] = useState<string | null>(null);

  // Synthesis state
  const [synthesis, setSynthesis]   = useState<SynthesisResult | null>(null);

  // Peer review state
  const [review, setReview]         = useState<PeerReviewReport | null>(null);
  const [reviewState, setReviewState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Revision state
  const [revision, setRevision] = useState<RevisionResult | null>(null);
  const [revisionState, setRevisionState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [responseState, setResponseState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Action map state
  const [actionMap, setActionMap] = useState<RevisionActionMap | null>(null);
  const [actionMapState, setActionMapState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Consistency audit state
  const [consistencyAudit, setConsistencyAudit] = useState<ConsistencyAuditResult | null>(null);
  const [auditState, setAuditState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Re-review state
  const [reReview, setReReview] = useState<ReReviewResult | null>(null);
  const [reReviewState, setReReviewState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  // Editorial review state
  const [editorialReviewData, setEditorialReviewData] = useState<EditorialReviewResult | null>(null);
  const [editorialState, setEditorialState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [editorialError, setEditorialError] = useState<string | null>(null);

  // AI revision manager state
  const [revisionAgent, setRevisionAgent] = useState<RevisionAgentStatus | null>(null);
  const [revisionAgentState, setRevisionAgentState] = useState<'idle' | 'running' | 'error'>('idle');
  const [showRevisionCelebration, setShowRevisionCelebration] = useState(false);
  const previousRevisionAgentStatusRef = useRef<string | null>(null);

  // Revision sub-tab
  type RevisionSubTab = 'action_map' | 'edits' | 'response' | 'editor' | 'audit' | 'rereview';
  const [revisionSubTab, setRevisionSubTab] = useState<RevisionSubTab>('action_map');

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

  useEffect(() => {
    if (revisionAgent?.status !== 'running') return;
    const timer = window.setInterval(() => {
      fetchRevisionAgentStatusSnapshot().catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [revisionAgent?.status]);

  useEffect(() => {
    const currentStatus = revisionAgent?.status ?? null;
    const previousStatus = previousRevisionAgentStatusRef.current;
    previousRevisionAgentStatusRef.current = currentStatus;

    if (currentStatus === 'completed' && previousStatus !== 'completed') {
      setShowRevisionCelebration(true);
      const timer = window.setTimeout(() => setShowRevisionCelebration(false), 2800);
      return () => window.clearTimeout(timer);
    }

    if (currentStatus !== 'completed') {
      setShowRevisionCelebration(false);
    }
    return undefined;
  }, [revisionAgent?.status]);

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

  async function getExportReadyArticleText(sourceText: string): Promise<string> {
    const content = sourceText.trim();
    if (!content) return '';
    const result = await getManuscriptExportText(sessionId, content, selectedJournal);
    return result.article_text || content;
  }

  async function downloadArticle(mode: 'markdown' | 'plain') {
    let exportText = '';
    try {
      exportText = await getExportReadyArticleText(articleText);
    } catch (err) {
      console.error('Failed to prepare export-ready manuscript text:', err);
      window.alert('Unable to prepare manuscript export with resolved citations and references.');
      return;
    }

    const content = mode === 'plain'
      ? exportText.replace(/\[CK\]|\[INF\]/g, '').replace(/#{1,3} /g, '')
      : exportText;
    const filenameBase = getDraftFilenameBase();
    downloadTextFile(
      `${filenameBase}.${mode === 'markdown' ? 'md' : 'txt'}`,
      content,
    );
  }

  async function downloadArticleDocx() {
    const filenameBase = getDraftFilenameBase();
    const docxTitle = approvedTitle || projectName || 'Manuscript';
    let exportText = '';
    try {
      exportText = await getExportReadyArticleText(articleText);
    } catch (err) {
      console.error('Failed to prepare export-ready manuscript docx:', err);
      window.alert('Unable to prepare manuscript .docx with resolved citations and references.');
      return;
    }
    await downloadDocxFile(
      `${filenameBase}.docx`,
      docxTitle,
      exportText,
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
    // Use structured response data for proper table-format docx if available
    if (revision.response_data && (revision.response_data as Record<string, unknown>)?.responses) {
      try {
        const blob = await downloadResponseLetterDocx(
          sessionId,
          revision.response_data as Record<string, unknown>,
          selectedJournal,
          approvedTitle || '',
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `response_letter_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.docx`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      } catch (err) {
        console.warn('Structured docx generation failed, falling back to generic:', err);
      }
    }
    // Fallback to generic markdown-to-docx
    await downloadDocxFile(
      `response_letter_${selectedJournal.replace(/\s+/g, '_').slice(0, 30)}.docx`,
      `Point-by-Point Response – ${selectedJournal}`,
      revision.point_by_point_reply,
    );
  }

  async function handleGeneratePeerReview() {
    if (!articleText.trim()) return;
    setReviewState('running');
    try {
      const result = await generatePeerReview(sessionId);
      setReview(result);
      // Reset all downstream stages
      setActionMap(null); setActionMapState('idle');
      setRevision(null); setRevisionState('idle');
      setResponseState('idle');
      setConsistencyAudit(null); setAuditState('idle');
      setReReview(null); setReReviewState('idle');
      setReviewState('done');
    } catch (err) {
      setReviewState('error');
      console.error('Peer review failed:', err);
    }
  }

  async function handleGenerateActionMap() {
    if (!review) return;
    setActionMapState('running');
    try {
      const result = await generateRevisionActionMap(sessionId);
      setActionMap(result);
      setActionMapState('done');
    } catch (err) {
      setActionMapState('error');
      console.error('Action map generation failed:', err);
    }
  }

  async function handleReviseAfterReview() {
    if (!articleText || !review) return;
    setRevisionState('running');
    try {
      const result = await reviseAfterReview(sessionId, articleText, review, selectedJournal, actionMap ?? undefined, false);
      setRevision(result);
      setResponseState('idle');
      setConsistencyAudit(null); setAuditState('idle');
      setReReview(null); setReReviewState('idle');
      setEditorialReviewData(null); setEditorialState('idle');
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

  async function handleConsistencyAudit() {
    if (!revision?.revised_article) return;
    setAuditState('running');
    try {
      const result = await runConsistencyAudit(sessionId, {
        revised_article: revision.revised_article,
        action_map: actionMap ?? undefined,
      });
      setConsistencyAudit(result);
      setAuditState('done');
    } catch (err) {
      setAuditState('error');
      console.error('Consistency audit failed:', err);
    }
  }

  async function handleReReview() {
    if (!revision?.revised_article) return;
    setReReviewState('running');
    try {
      const result = await generateReReview(sessionId, {
        revised_article: revision.revised_article,
      });
      setReReview(result);
      setReReviewState('done');
    } catch (err) {
      setReReviewState('error');
      console.error('Re-review failed:', err);
    }
  }

  async function handleApplyFollowupRevision() {
    if (!revision?.revised_article || !review) return;
    setRevisionState('running');
    try {
      const result = await applyFollowupRevision(sessionId, {
        article: revision.revised_article,
        review,
        selected_journal: selectedJournal,
        action_map: actionMap ?? undefined,
        consistency_audit: consistencyAudit,
        re_review: reReview,
        editorial_review: editorialReviewData,
      });
      setRevision({
        ...result,
        change_justifications: [
          ...(revision.change_justifications ?? []),
          ...(result.change_justifications ?? []),
        ],
      });
      setResponseState('idle');
      setConsistencyAudit(null); setAuditState('idle');
      setReReview(null); setReReviewState('idle');
      setEditorialReviewData(null); setEditorialState('idle');
      if (result.revised_article) {
        setArticleText(result.revised_article);
        setWordCount(result.revised_article.split(/\s+/).filter(Boolean).length);
      }
      setRevisionSubTab('edits');
      setRevisionState('done');
    } catch (err) {
      setRevisionState('error');
      console.error('Follow-up revision failed:', err);
    }
  }

  async function handleFinalizeRevisionResponse() {
    if (!revision?.revised_article || !review) return;
    setResponseState('running');
    try {
      const result = await finalizeRevisionResponse(sessionId, {
        revised_article: revision.revised_article,
        review,
        selected_journal: selectedJournal,
        manuscript_title: approvedTitle || projectName || initialTitle || '',
        action_map: actionMap ?? undefined,
        change_justifications: revision.change_justifications ?? [],
      });
      setRevision(prev => prev ? { ...prev, ...result } : result);
      setResponseState('done');
      setRevisionSubTab('response');
    } catch (err) {
      setResponseState('error');
      console.error('Final response generation failed:', err);
    }
  }

  function applyRevisionAgentSnapshot(agent: RevisionAgentStatus | null) {
    if (!agent) return;
    setRevisionAgent(agent);
    if (agent.action_map) {
      setActionMap(agent.action_map);
      setActionMapState('done');
    }
    if (agent.revision) {
      setRevision(agent.revision);
      setRevisionState('done');
      if (agent.revision.revised_article) {
        setArticleText(agent.revision.revised_article);
        setWordCount(agent.revision.revised_article.split(/\s+/).filter(Boolean).length);
      }
      setResponseState(agent.revision.point_by_point_reply ? 'done' : 'idle');
    }
    if (agent.consistency_audit) {
      setConsistencyAudit(agent.consistency_audit);
      setAuditState('done');
    }
    if (agent.re_review) {
      setReReview(agent.re_review);
      setReReviewState('done');
    }
    if (agent.editorial_review) {
      setEditorialReviewData(agent.editorial_review);
      setEditorialState('done');
    }
  }

  async function fetchRevisionAgentStatusSnapshot() {
    try {
      const status = await getRevisionAgentStatus(sessionId);
      applyRevisionAgentSnapshot(status);
      return status;
    } catch (err) {
      console.error('Revision agent status load failed:', err);
      return null;
    }
  }

  async function handleRunRevisionAgent() {
    setRevisionAgentState('running');
    try {
      const status = await runRevisionAgent(sessionId);
      applyRevisionAgentSnapshot(status);
    } catch (err) {
      setRevisionAgentState('error');
      console.error('Revision agent run failed:', err);
      return;
    }
    setRevisionAgentState('idle');
  }

  async function handleStopRevisionAgent() {
    setRevisionAgentState('running');
    try {
      const status = await stopRevisionAgent(sessionId);
      applyRevisionAgentSnapshot(status);
    } catch (err) {
      setRevisionAgentState('error');
      console.error('Revision agent stop failed:', err);
      return;
    }
    setRevisionAgentState('idle');
  }

  const [agentGuidance, setAgentGuidance] = useState('');

  async function handleResumeRevisionAgent() {
    setRevisionAgentState('running');
    try {
      const status = await resumeRevisionAgent(sessionId, agentGuidance);
      applyRevisionAgentSnapshot(status);
      setAgentGuidance('');
    } catch (err) {
      setRevisionAgentState('error');
      console.error('Revision agent resume failed:', err);
      return;
    }
    setRevisionAgentState('idle');
  }

  const decisionConf = review ? (DECISION_CONFIG[review.decision] ?? DECISION_CONFIG.major_revision) : null;
  const canDraft = Boolean(synthesis) || Boolean(deepSynthesis);
  const titleApproved = Boolean(approvedTitle);
  // Trust the backend's blocking vs advisory classification — don't re-promote.
  // The backend already filters non-structural issues (formatting, wording) to advisory.
  const auditBlockingIssues = consistencyAudit?.blocking_issues ?? [];
  const auditAdvisoryIssues = [
    ...(consistencyAudit?.advisory_issues ?? []),
    // Show unresolved concerns and failed checks as advisory context (not blocking)
    ...(consistencyAudit && !consistencyAudit.blocking_issues?.length
      ? [
          ...(consistencyAudit.unresolved_concerns ?? []),
          ...(consistencyAudit.new_issues ?? []),
          ...consistencyAudit.checks
            .filter(check => !check.passed)
            .map(check => `${check.check}${check.detail ? `: ${check.detail}` : ''}`),
        ]
      : []),
  ];

  const reReviewBlockingIssues = reReview?.blocking_issues ?? [];
  const reReviewAdvisoryIssues = [
    ...(reReview?.advisory_issues ?? []),
    ...(reReview && !reReview.blocking_issues?.length
      ? [...(reReview.remaining_issues ?? []), ...(reReview.new_issues ?? [])]
      : []),
  ];

  const editorialBlockingIssues = editorialReviewData?.blocking_issues ?? [];
  const editorialAdvisoryIssues = [
    ...(editorialReviewData?.advisory_issues ?? []),
    ...(editorialReviewData && !editorialReviewData.blocking_issues?.length
      ? [
          ...(editorialReviewData.remaining_concerns ?? []),
          ...editorialReviewData.suggestions
            .filter(s => s.severity !== 'critical')
            .map(s => `${s.location || 'Editorial assessment'}: ${s.finding}`),
        ]
      : []),
  ];

  const responseQcBlockingIssues = revision?.response_qc?.blocking_issues ?? [];
  const responseQcAdvisoryIssues = revision?.response_qc?.advisory_issues ?? [];

  const qaStagesComplete = Boolean(revision && consistencyAudit && reReview && editorialReviewData);
  const blockingIssues = [
    ...auditBlockingIssues,
    ...reReviewBlockingIssues,
    ...editorialBlockingIssues,
    ...responseQcBlockingIssues,
  ];
  const advisoryIssues = [
    ...auditAdvisoryIssues,
    ...reReviewAdvisoryIssues,
    ...editorialAdvisoryIssues,
    ...responseQcAdvisoryIssues,
  ];
  const agentCompleted = revisionAgent?.status === 'completed';
  const canGenerateFinalResponse = Boolean(revision?.revised_article) && qaStagesComplete && blockingIssues.length === 0;
  // Enable exports when: agent completed successfully OR manual pipeline has no blockers
  const revisionDownloadsReady = agentCompleted || Boolean(
    revision?.revised_article &&
    revision?.point_by_point_reply &&
    blockingIssues.length === 0 &&
    responseQcBlockingIssues.length === 0,
  );
  const agentStageLabels: Record<string, string> = {
    idle: 'Idle',
    starting: 'Starting',
    action_map: 'Action Map',
    revise_manuscript: 'Revise Manuscript',
    preservation_audit: 'Preservation Audit',
    reviewer_recheck: 'Reviewer Re-check',
    editor_assessment: 'Editor Assessment',
    followup_revision: 'Follow-up Amendment',
    final_response: 'Final Response',
    export_generation: 'Export Readiness',
    completed: 'Completed',
    stopped: 'Stopped',
    needs_user_review: 'Needs Review',
    completing_truncated: 'Completing Truncated Text',
    failed: 'Failed',
  };
  const revisionAgentLedgerBlockingUnresolved = revisionAgent?.ledger_entries?.filter(
    item => !item.resolved && item.severity === 'blocking',
  ) ?? [];
  const revisionAgentLedgerAdvisoryUnresolved = revisionAgent?.ledger_entries?.filter(
    item => !item.resolved && item.severity !== 'blocking',
  ) ?? [];
  const revisionAgentLedgerResolved = revisionAgent?.ledger_entries?.filter(item => item.resolved) ?? [];
  const qaMetrics = revisionAgent?.qa_metrics ?? {
    invalid_qa_findings: 0,
    discarded_blockers: 0,
    merged_repair_groups: 0,
    structural_repair_invocations: 0,
  };
  const canResumeRevisionAgent = Boolean(
    revisionAgent && (revisionAgent.status === 'failed' || revisionAgent.stage === 'stopped'),
  );
  const revisionManagerTitle = revisionAgent?.status === 'completed'
    ? 'Completed'
    : revisionAgent?.status === 'running'
    ? `Running · ${agentStageLabels[revisionAgent.stage] ?? revisionAgent.stage}`
    : revisionAgent?.stage === 'stopped'
    ? 'Stopped'
    : revisionAgent?.status === 'failed'
    ? 'Retry Required'
    : revisionAgent?.status === 'needs_user_review'
    ? 'Review Required'
    : 'Ready to Run';
  const revisionManagerSummary = revisionAgent?.completed_reason
    ? revisionAgent.completed_reason
    : canResumeRevisionAgent
    ? 'The revision manager stopped after a system/provider failure or an explicit stop request. Add optional guidance and resume when you want to retry.'
    : 'Automatically runs the revision stages, applies justified follow-up amendments, generates the final response once, and stops only when blockers are cleared and exports are ready.';

  let readinessState: 'pending' | 'blocked' | 'advisory' | 'ready' = 'pending';
  if (blockingIssues.length > 0) {
    readinessState = 'blocked';
  } else if (qaStagesComplete && advisoryIssues.length > 0) {
    readinessState = 'advisory';
  } else if (qaStagesComplete) {
    readinessState = 'ready';
  }

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
        <div className="flex items-center border-b" style={{ borderColor: 'var(--border-faint, #e5e7eb)' }}>
          <div className="flex items-center gap-8 flex-1">
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

          {/* References toggle */}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className={`relative pb-4 flex items-center gap-1.5 text-sm font-semibold transition-colors ${
              sidebarOpen ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-700'
            }`}
            style={{ fontFamily: 'Manrope, sans-serif' }}
            title={sidebarOpen ? 'Close references' : 'Open references'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            References
            {sidebarOpen && (
              <span className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full" />
            )}
          </button>
        </div>

        {/* ── Draft tab ─────────────────────────────────────────────────────── */}
        {tab === 'draft' && (<>
          <div>
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
                      renderCeilsArticle(articleText, { onCiteClick: setHighlightedCiteKey, highlightedPaperKey }),
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
          </div>
          {/* Reference sidebar */}
          <ReferenceSidebar
            sessionId={sessionId}
            articleText={articleText}
            selectedJournal={selectedJournal}
            highlightedCiteKey={highlightedCiteKey}
            onCiteClick={(key) => { setHighlightedPaperKey(key); setHighlightedCiteKey(null); }}
            isOpen={sidebarOpen}
            onToggle={() => setSidebarOpen(v => !v)}
            writingState={writingState}
          />
        </>)}

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

            {reviewState === 'running' && !review && (
              <div className="py-12 text-center">
                <LoadingLottie className="w-16 h-16 mx-auto" label="Generating peer review report…" />
              </div>
            )}

            {review && (
              <div className="space-y-5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
                      Peer Review Report
                    </p>
                    <p className="text-sm text-slate-400">
                      {reviewState === 'running'
                        ? 'Generating an updated review from the latest manuscript draft...'
                        : 'Run the review again after changing the manuscript to refresh this report.'}
                    </p>
                  </div>
                  <button
                    onClick={handleGeneratePeerReview}
                    disabled={reviewState === 'running'}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    style={{ fontFamily: 'Manrope, sans-serif' }}
                  >
                    <span className="material-symbols-outlined text-base">
                      {reviewState === 'running' ? 'hourglass_top' : 'refresh'}
                    </span>
                    {reviewState === 'running' ? 'Re-reviewing...' : 'Re-review'}
                  </button>
                </div>

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

                {/* Reviewer Expertise */}
                {review.reviewer_expertise && review.reviewer_expertise.length > 0 && (
                  <div className="rounded-xl bg-violet-50/50 border border-violet-200 px-4 py-3">
                    <p className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-2">
                      Reviewer Expertise
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {review.reviewer_expertise.map((e, i) => (
                        <span key={i} className="text-[11px] px-2 py-1 rounded-lg bg-violet-100 text-violet-700 border border-violet-200 font-medium">
                          {e}
                        </span>
                      ))}
                    </div>
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

                {/* Rubric Scores */}
                {review.rubric_scores && review.rubric_scores.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-600 mb-3">
                      Review Rubric
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {review.rubric_scores.map((r, i) => {
                        const color = r.score >= 4 ? 'emerald' : r.score >= 3 ? 'blue' : r.score >= 2 ? 'amber' : 'rose';
                        return (
                          <div key={i} className={`rounded-xl border px-3 py-2.5 bg-${color}-50/50 border-${color}-200`}
                            title={r.rationale}>
                            <p className="text-[10px] font-medium text-slate-500 leading-tight mb-1">{r.dimension}</p>
                            <div className="flex items-center gap-1">
                              <span className={`text-lg font-bold text-${color}-700`}>{r.score}</span>
                              <span className="text-[10px] text-slate-400">/5</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Strengths */}
                {review.strengths && review.strengths.length > 0 && (
                  <div className="rounded-xl bg-emerald-50/50 border border-emerald-200 px-4 py-3">
                    <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-2">
                      Strengths
                    </p>
                    <ul className="space-y-1.5">
                      {review.strengths.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-emerald-800 leading-relaxed">
                          <span className="material-symbols-outlined text-emerald-500 text-sm mt-0.5"
                            style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Section Assessments */}
                {review.section_assessments && review.section_assessments.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-600 mb-3">
                      Section Assessments
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {review.section_assessments.map((sa, i) => {
                        const rc = RATING_CONFIG[sa.rating] || RATING_CONFIG.adequate;
                        return (
                          <div key={i} className={`rounded-xl border px-4 py-3 ${rc.cls}`}>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm font-semibold">{sa.section}</p>
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase">
                                <span className="material-symbols-outlined text-xs"
                                  style={{ fontVariationSettings: "'FILL' 1" }}>{rc.icon}</span>
                                {rc.label}
                              </span>
                            </div>
                            {sa.strengths.length > 0 && (
                              <ul className="text-xs opacity-80 space-y-0.5 mb-1">
                                {sa.strengths.map((s, j) => (
                                  <li key={j} className="leading-relaxed">+ {s}</li>
                                ))}
                              </ul>
                            )}
                            {sa.weaknesses.length > 0 && (
                              <ul className="text-xs opacity-80 space-y-0.5 mb-1">
                                {sa.weaknesses.map((w, j) => (
                                  <li key={j} className="leading-relaxed">- {w}</li>
                                ))}
                              </ul>
                            )}
                            {sa.suggestions.length > 0 && (
                              <ul className="text-xs opacity-70 space-y-0.5">
                                {sa.suggestions.map((s, j) => (
                                  <li key={j} className="leading-relaxed italic">{s}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
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

                {/* Claims Audit */}
                {review.claims_audit && review.claims_audit.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-orange-600 mb-3">
                      Claims Audit ({review.claims_audit.length})
                    </h3>
                    <div className="space-y-2">
                      {review.claims_audit.map((ca, i) => (
                        <div key={i} className="rounded-xl border border-orange-200 bg-orange-50/30 px-4 py-3">
                          <p className="text-sm text-slate-800 leading-snug italic">"{ca.claim}"</p>
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {ca.location && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 font-medium">
                                {ca.location}
                              </span>
                            )}
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200 font-medium">
                              {ca.problem}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium">
                              → {ca.fix}
                            </span>
                          </div>
                          {ca.explanation && (
                            <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{ca.explanation}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Revision Priorities */}
                {review.revision_priorities && review.revision_priorities.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-indigo-600 mb-3">
                      Revision Priority List
                    </h3>
                    <div className="space-y-1.5">
                      {review.revision_priorities.map((r, i) => (
                        <div key={i} className="flex gap-3 rounded-xl border border-indigo-100 bg-indigo-50/30 px-4 py-2.5">
                          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700
                            text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                          <p className="text-sm text-slate-700 leading-relaxed">{r}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Editor Note */}
                {review.editor_note && (
                  <div className="rounded-xl bg-slate-100 border border-slate-200 px-4 py-3">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                      Editor Note
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">{review.editor_note}</p>
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

        {/* ── Revision tab — sub-tab pipeline ─────────────────────────────── */}
        {tab === 'revision' && (<>
          {(revisionAgent?.status === 'running' || showRevisionCelebration) && (
            <RevisionAgentOverlay
              stage={showRevisionCelebration ? 'completed' : revisionAgent?.stage ?? 'idle'}
              currentRound={revisionAgent?.current_round ?? 0}
              status={showRevisionCelebration ? 'completed' : revisionAgent?.status ?? 'idle'}
              celebrate={showRevisionCelebration}
              completedReason={revisionAgent?.completed_reason ?? ''}
            />
          )}
          <div className="space-y-0">

            {!review ? (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                <p className="text-slate-400 text-sm text-center py-8">
                  Generate peer review first, then run the revision pipeline.
                </p>
              </div>
            ) : (<>

            <div className="bg-white border border-slate-200 shadow-sm px-6 py-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AI Revision Manager</p>
                  <h3 className="text-sm font-semibold text-slate-800">{revisionManagerTitle}</h3>
                  <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
                    {revisionManagerSummary}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {revisionAgent?.status === 'running' ? (
                    <button
                      onClick={handleStopRevisionAgent}
                      disabled={revisionAgentState === 'running'}
                      className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-sm">stop_circle</span>
                      Stop Agent
                    </button>
                  ) : canResumeRevisionAgent ? (
                    <button
                      onClick={handleResumeRevisionAgent}
                      disabled={revisionAgentState === 'running'}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-sm">play_arrow</span>
                      Resume Agent
                    </button>
                  ) : (
                    <button
                      onClick={handleRunRevisionAgent}
                      disabled={revisionAgentState === 'running'}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-sm">auto_awesome</span>
                      Run AI Revision Manager
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Current Stage</p>
                  <p className="mt-1 text-sm font-semibold text-slate-800">{agentStageLabels[revisionAgent?.stage ?? 'idle'] ?? 'Idle'}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Round</p>
                  <p className="mt-1 text-sm font-semibold text-slate-800">{revisionAgent?.current_round ?? 0}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Blocking Issues</p>
                  <p className="mt-1 text-sm font-semibold text-rose-700">{revisionAgent?.blocking_issue_count ?? 0}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Exports</p>
                  <p className="mt-1 text-sm font-semibold text-slate-800">
                    {revisionAgent?.export_readiness?.all_required_ready ? 'Ready' : 'Pending'}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Invalid QA Findings</p>
                  <p className="mt-1 text-sm font-semibold text-amber-700">{qaMetrics.invalid_qa_findings}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Discarded Blockers</p>
                  <p className="mt-1 text-sm font-semibold text-rose-700">{qaMetrics.discarded_blockers}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Repair Groups</p>
                  <p className="mt-1 text-sm font-semibold text-indigo-700">{qaMetrics.merged_repair_groups}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Structural Repairs</p>
                  <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--gold, #4f46e5)' }}>
                    {qaMetrics.structural_repair_invocations}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                <span className={`rounded-full border px-2.5 py-1 font-semibold ${
                  revisionAgent?.final_response_ready ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                  Final response {revisionAgent?.final_response_ready ? 'ready' : 'pending'}
                </span>
                <span className={`rounded-full border px-2.5 py-1 font-semibold ${
                  revisionAgent?.export_readiness?.manuscript_docx_ready ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                  Manuscript export {revisionAgent?.export_readiness?.manuscript_docx_ready ? 'ready' : 'pending'}
                </span>
                <span className={`rounded-full border px-2.5 py-1 font-semibold ${
                  revisionAgent?.export_readiness?.response_docx_ready ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                  Response export {revisionAgent?.export_readiness?.response_docx_ready ? 'ready' : 'pending'}
                </span>
              </div>
              {canResumeRevisionAgent && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full"
                      style={{ background: 'var(--gold-faint, rgba(79, 70, 229, 0.08))', color: 'var(--gold, #4f46e5)' }}
                    >
                      <span className="material-symbols-outlined text-lg">edit_note</span>
                    </div>
                    <div className="flex-1 space-y-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Manual Retry Guidance</p>
                        <p className="mt-1 text-sm text-slate-700 leading-relaxed">
                          Use this only when retrying after a true failure or a manual stop. Manuscript QA issues are handled automatically by the agent.
                        </p>
                      </div>
                      <textarea
                        value={agentGuidance}
                        onChange={event => setAgentGuidance(event.target.value)}
                        placeholder="Optional note for the next retry, for example: retry with extra caution around the Discussion section."
                        rows={3}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2"
                        style={{ boxShadow: 'none' }}
                      />
                    </div>
                  </div>
                </div>
              )}
              {(revisionAgentLedgerBlockingUnresolved.length > 0
                || revisionAgentLedgerAdvisoryUnresolved.length > 0
                || revisionAgentLedgerResolved.length > 0) && (
                <div className="mt-4 space-y-3">
                  {revisionAgentLedgerBlockingUnresolved.length > 0 && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-700 mb-2">Unresolved Ledger</p>
                      <div className="space-y-2">
                        {revisionAgentLedgerBlockingUnresolved.map(item => (
                          <div key={item.item_id} className="text-xs text-rose-900 leading-relaxed">
                            <span className="font-semibold">{item.source}</span> · round {item.round_number}: {item.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {revisionAgentLedgerAdvisoryUnresolved.length > 0 && (
                    <CollapsibleSection
                      title="Open Advisory Notes"
                      meta={`${revisionAgentLedgerAdvisoryUnresolved.length} open`}
                    >
                      <div className="space-y-2">
                        {revisionAgentLedgerAdvisoryUnresolved.map(item => (
                          <div key={item.item_id} className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-amber-900 leading-relaxed">
                            <span className="font-semibold">{item.source}</span> · round {item.round_number}: {item.message}
                          </div>
                        ))}
                      </div>
                    </CollapsibleSection>
                  )}
                  {revisionAgentLedgerResolved.length > 0 && (
                    <CollapsibleSection
                      title="Resolved Findings"
                      meta={`${revisionAgentLedgerResolved.length} resolved`}
                    >
                      <div className="space-y-2">
                        {revisionAgentLedgerResolved.map(item => (
                          <div key={item.item_id} className="rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3 text-xs text-emerald-900 leading-relaxed">
                            <p><span className="font-semibold">{item.source}</span> · round {item.round_number}: {item.message}</p>
                            {item.justification && (
                              <p className="mt-1 text-emerald-800">Justification: {item.justification}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </CollapsibleSection>
                  )}
                </div>
              )}
              {revisionAgent?.last_error && (
                <p className="mt-4 text-xs text-rose-700 leading-relaxed">Error: {revisionAgent.last_error}</p>
              )}
            </div>

            {/* ── Global download bar ─────────────────────────────────────────── */}
            <div className="bg-white rounded-t-2xl border border-slate-200 shadow-sm px-6 py-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Revision Exports</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Manuscript .md',   icon: 'description',  enabled: revisionDownloadsReady,   onClick: () => downloadArticle('markdown') },
                  { label: 'Manuscript .docx', icon: 'article',      enabled: revisionDownloadsReady,   onClick: downloadArticleDocx },
                  { label: 'Response .md',     icon: 'mail',         enabled: revisionDownloadsReady,   onClick: () => downloadRevisionReply('markdown') },
                  { label: 'Response .docx',   icon: 'draft_orders', enabled: revisionDownloadsReady,   onClick: downloadRevisionReplyDocx },
                ].map((btn, i) => (
                  <button key={i}
                    onClick={btn.onClick}
                    disabled={!btn.enabled}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                      btn.enabled
                        ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 cursor-pointer'
                        : 'border-slate-200 bg-slate-50 text-slate-300 cursor-not-allowed'
                    }`}>
                    <span className="material-symbols-outlined text-sm"
                      style={{ fontVariationSettings: btn.enabled ? "'FILL' 1" : "'FILL' 0" }}>{btn.icon}</span>
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white border-x border-slate-200 px-6 py-4">
              <div className={`rounded-2xl border px-5 py-4 ${
                readinessState === 'blocked'
                  ? 'bg-rose-50 border-rose-200'
                  : readinessState === 'advisory'
                  ? 'bg-amber-50 border-amber-200'
                  : readinessState === 'ready'
                  ? 'bg-emerald-50 border-emerald-200'
                  : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Revision Readiness</p>
                    <h3 className="text-sm font-semibold text-slate-800 mt-1">
                      {readinessState === 'blocked'
                        ? 'Blocked by Major Issues'
                        : readinessState === 'advisory'
                        ? 'Advisory Issues Remaining'
                        : readinessState === 'ready'
                        ? 'Ready for Final Response'
                        : 'Run the quality checks'}
                    </h3>
                    <p className="text-xs text-slate-600 mt-1">
                      {readinessState === 'pending'
                        ? 'Complete Preservation Audit, Reviewer Re-check, and Editor Assessment before generating the final response.'
                        : readinessState === 'blocked'
                        ? 'Resolve the blocking issues below with justified follow-up edits before generating the final response.'
                        : readinessState === 'advisory'
                        ? 'You can proceed, but the remaining cautions should be reviewed before download.'
                        : 'All quality gates are complete. You can generate the final response.'}
                    </p>
                  </div>
                  <div className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                    readinessState === 'blocked'
                      ? 'bg-rose-100 text-rose-700 border-rose-200'
                      : readinessState === 'advisory'
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : readinessState === 'ready'
                      ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}>
                    {blockingIssues.length > 0
                      ? `${blockingIssues.length} blocking`
                      : advisoryIssues.length > 0
                      ? `${advisoryIssues.length} advisory`
                      : qaStagesComplete
                      ? 'All checks complete'
                      : 'Checks pending'}
                  </div>
                </div>
                {blockingIssues.length > 0 && (
                  <div className="mt-4 space-y-1">
                    {blockingIssues.map((issue, idx) => (
                      <p key={idx} className="text-xs text-rose-800 leading-relaxed">• {issue}</p>
                    ))}
                  </div>
                )}
                {blockingIssues.length === 0 && advisoryIssues.length > 0 && (
                  <div className="mt-4 space-y-1">
                    {advisoryIssues.map((issue, idx) => (
                      <p key={idx} className="text-xs text-amber-800 leading-relaxed">• {issue}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Sub-tab navigation ──────────────────────────────────────────── */}
            <div className="bg-white border-x border-slate-200 px-4 py-0">
              <div className="flex flex-wrap gap-0">
                {([
                  { key: 'action_map' as RevisionSubTab, icon: 'route',       label: 'Action Map',  done: !!actionMap,           active: actionMapState === 'running' },
                  { key: 'edits'      as RevisionSubTab, icon: 'edit_note',    label: 'Revise Manuscript',  done: !!revision,            active: revisionState === 'running' },
                  { key: 'audit'      as RevisionSubTab, icon: 'fact_check',   label: 'Preservation Audit', done: !!consistencyAudit,    active: auditState === 'running' },
                  { key: 'rereview'   as RevisionSubTab, icon: 'verified',     label: 'Reviewer Re-check',  done: !!reReview,            active: reReviewState === 'running' },
                  { key: 'editor'     as RevisionSubTab, icon: 'rate_review',  label: 'Editor Assessment', done: !!editorialReviewData, active: editorialState === 'running' },
                  { key: 'response'   as RevisionSubTab, icon: 'mail',         label: 'Final Response',    done: !!revision?.point_by_point_reply, active: responseState === 'running' },
                ]).map((st) => {
                  const isCurrent = revisionSubTab === st.key;
                  return (
                    <button key={st.key}
                      onClick={() => setRevisionSubTab(st.key)}
                      className={`relative flex items-center gap-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-colors ${
                        isCurrent
                          ? 'text-indigo-700'
                          : st.done
                          ? 'text-emerald-600 hover:text-emerald-700'
                          : 'text-slate-400 hover:text-slate-600'
                      }`}>
                      <span className={`material-symbols-outlined text-base ${st.active ? 'animate-spin' : ''}`}
                        style={{ fontVariationSettings: (isCurrent || st.done) ? "'FILL' 1" : "'FILL' 0" }}>
                        {st.active ? 'progress_activity' : st.done ? 'check_circle' : st.icon}
                      </span>
                      {st.label}
                      {isCurrent && (
                        <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-indigo-600" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Sub-tab content area ────────────────────────────────────────── */}
            <div className="bg-white rounded-b-2xl border-x border-b border-slate-200 shadow-sm p-6 space-y-4">

              {/* ── Action Map sub-tab ──────────────────────────────────────── */}
              {revisionSubTab === 'action_map' && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xl text-violet-600" style={{ fontVariationSettings: "'FILL' 1" }}>route</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Action Map</h3>
                        <p className="text-xs text-slate-500">Review the justified plan for each requested change before revising the manuscript.</p>
                      </div>
                    </div>
                    {!actionMap && actionMapState !== 'running' && (
                      <button onClick={handleGenerateActionMap}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 2px 8px rgba(79,70,229,0.2)' }}>
                        <span className="material-symbols-outlined text-base">play_arrow</span>
                        Generate Action Map
                      </button>
                    )}
                  </div>

                  {actionMapState === 'running' && (
                    <div className="py-8">
                      <LoadingLottie className="w-14 h-14 mx-auto" label="Generating revision action map…" />
                    </div>
                  )}

                  {actionMap && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                          {actionMap.accepted_count} accepted
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                          {actionMap.partially_accepted} partial
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 border border-slate-200 font-medium">
                          {actionMap.declined_count} declined
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 font-medium">
                          {actionMap.total_actions} total
                        </span>
                      </div>
                      <div className="space-y-2">
                        {actionMap.actions.map((a, i) => (
                          <CollapsibleSection
                            key={i}
                            title={`${a.reviewer_comment_id} · ${a.concern_title}`}
                            meta={a.target_section || a.action_type.replace(/_/g, ' ')}
                            defaultOpen={i < 2}
                          >
                            <div className="space-y-3">
                              <div className="flex flex-wrap gap-1.5">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  a.disposition === 'decline' || a.action_type === 'no_change_rebut'
                                    ? 'bg-slate-100 text-slate-600 border-slate-200'
                                    : a.disposition === 'partially_accept'
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                }`}>
                                  {a.disposition === 'decline' || a.action_type === 'no_change_rebut'
                                    ? 'Decline'
                                    : a.disposition === 'partially_accept'
                                    ? 'Partial'
                                    : 'Accept'}
                                </span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-200 font-medium">
                                  {a.action_type.replace(/_/g, ' ')}
                                </span>
                                {a.target_section && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 font-medium">
                                    {a.target_section}
                                  </span>
                                )}
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 font-medium">
                                  ~{a.estimated_edit_size}
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                                  a.estimated_edit_size === 'multi_paragraph'
                                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                                    : 'bg-sky-50 text-sky-700 border-sky-200'
                                }`}>
                                  {a.action_type === 'no_change_rebut' ? 'Rebuttal only' : 'Planned edit'}
                                </span>
                              </div>
                              <p className="text-sm text-slate-700 leading-relaxed">{a.revision_instruction}</p>
                              {a.manuscript_location && (
                                <p className="text-xs text-slate-500 leading-relaxed">
                                  Target location: {a.manuscript_location}
                                </p>
                              )}
                              {a.verification_criterion && (
                                <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 px-3 py-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Justification / success check</p>
                                  <p className="text-xs text-emerald-900 leading-relaxed">{a.verification_criterion}</p>
                                </div>
                              )}
                            </div>
                          </CollapsibleSection>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── Manuscript Edits sub-tab ────────────────────────────────── */}
              {revisionSubTab === 'edits' && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xl text-blue-600" style={{ fontVariationSettings: "'FILL' 1" }}>edit_note</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Revise Manuscript</h3>
                        <p className="text-xs text-slate-500">Apply surgical manuscript edits only where the review and action map justify them.</p>
                      </div>
                    </div>
                    {!revision && revisionState !== 'running' && (
                      <button onClick={handleReviseAfterReview}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 2px 8px rgba(79,70,229,0.2)' }}>
                        <span className="material-symbols-outlined text-base">play_arrow</span>
                        Apply Initial Edits
                      </button>
                    )}
                  </div>

                  {revisionState === 'running' && (
                    <div className="py-8">
                      <LoadingLottie className="w-14 h-14 mx-auto" label="Applying edits to manuscript…" />
                    </div>
                  )}

                  {revision && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        {revision.applied_changes != null && (
                          <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                            {revision.applied_changes} edits applied
                          </span>
                        )}
                        {revision.failed_changes != null && revision.failed_changes > 0 && (
                          <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                            {revision.failed_changes} unresolved
                          </span>
                        )}
                        {revision.audit?.passed && (
                          <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                            Quality audit passed
                          </span>
                        )}
                      </div>
                      {revision.audit && revision.audit.warnings.length > 0 && (
                        <div className="rounded-xl bg-amber-50/50 border border-amber-200 px-4 py-3">
                          <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1.5">Quality Warnings</p>
                          <ul className="space-y-1">
                            {revision.audit.warnings.map((w, i) => (
                              <li key={i} className="text-xs text-amber-800 leading-relaxed flex items-start gap-1.5">
                                <span className="material-symbols-outlined text-xs text-amber-500 mt-0.5">warning</span>
                                {w}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {revision.change_justifications && revision.change_justifications.length > 0 && (
                        <div className="rounded-xl bg-indigo-50/50 border border-indigo-200 px-4 py-3">
                          <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-1.5">Justified Changes</p>
                          <ul className="space-y-1">
                            {revision.change_justifications.map((j, i) => (
                              <li key={i} className="text-xs text-indigo-800 leading-relaxed">• {j}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <CollapsibleSection
                        title="Revised Manuscript"
                        meta={`${wordCount.toLocaleString()} words`}
                        defaultOpen
                      >
                        <div className="prose prose-slate max-w-none text-sm leading-relaxed">
                          {revision.revised_article
                            ? spliceVisuals(
                                renderCeilsArticle(revision.revised_article, { onCiteClick: setHighlightedCiteKey, highlightedPaperKey }),
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
                              )
                            : <p className="text-slate-400">No revised manuscript returned.</p>}
                        </div>
                      </CollapsibleSection>
                    </div>
                  )}
                </>
              )}

              {/* ── Point-by-Point Response sub-tab ─────────────────────────── */}
              {revisionSubTab === 'response' && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center">
                      <span className="material-symbols-outlined text-xl text-teal-600" style={{ fontVariationSettings: "'FILL' 1" }}>mail</span>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Final Response</h3>
                      <p className="text-xs text-slate-500">Generate the point-by-point reply once, from the finalized manuscript state.</p>
                    </div>
                  </div>

                  {!revision?.point_by_point_reply ? (
                    <div className="py-8 text-center">
                      {!revision ? (
                        <p className="text-slate-400 text-sm">Apply manuscript edits first.</p>
                      ) : !qaStagesComplete ? (
                        <p className="text-slate-400 text-sm">Complete Preservation Audit, Reviewer Re-check, and Editor Assessment first.</p>
                      ) : blockingIssues.length > 0 ? (
                        <div className="space-y-3">
                          <p className="text-rose-600 text-sm font-medium">Blocking issues remain. Resolve them before generating the final response.</p>
                          <div className="space-y-1">
                            {blockingIssues.map((issue, idx) => (
                              <p key={idx} className="text-xs text-rose-700 leading-relaxed">• {issue}</p>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <p className="text-slate-500 text-sm">The manuscript is ready for one final point-by-point reply generation.</p>
                          {advisoryIssues.length > 0 && (
                            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-left">
                              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Advisory Notes</p>
                              {advisoryIssues.map((issue, idx) => (
                                <p key={idx} className="text-xs text-amber-800 leading-relaxed">• {issue}</p>
                              ))}
                            </div>
                          )}
                          <button onClick={handleFinalizeRevisionResponse}
                            disabled={responseState === 'running' || !canGenerateFinalResponse}
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                            style={{ background: 'linear-gradient(135deg, #0f766e, #14b8a6)', boxShadow: '0 2px 8px rgba(20,184,166,0.2)' }}>
                            <span className={`material-symbols-outlined text-base ${responseState === 'running' ? 'animate-spin' : ''}`}>
                              {responseState === 'running' ? 'progress_activity' : 'mail'}
                            </span>
                            {responseState === 'running' ? 'Generating Final Response…' : 'Generate Final Response'}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {revision.response_qc && (
                        <div className={`rounded-xl border px-4 py-3 ${
                          responseQcBlockingIssues.length > 0
                            ? 'bg-rose-50 border-rose-200'
                            : responseQcAdvisoryIssues.length > 0
                            ? 'bg-amber-50 border-amber-200'
                            : 'bg-emerald-50 border-emerald-200'
                        }`}>
                          <p className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-slate-600">Final Response QA</p>
                          <p className="text-sm text-slate-700 leading-relaxed">{revision.response_qc.summary}</p>
                          {responseQcBlockingIssues.map((issue, idx) => (
                            <p key={idx} className="text-xs text-rose-700 mt-1 leading-relaxed">• {issue}</p>
                          ))}
                          {responseQcAdvisoryIssues.map((issue, idx) => (
                            <p key={idx} className="text-xs text-amber-700 mt-1 leading-relaxed">• {issue}</p>
                          ))}
                        </div>
                      )}
                      <CollapsibleSection
                        title="Response Letter Preview"
                        meta={revision.response_data ? 'Structured preview' : 'Fallback preview'}
                        defaultOpen
                      >
                        <ResponseLetterPreview revision={revision} />
                      </CollapsibleSection>
                    </div>
                  )}
                </>
              )}

              {/* ── Editor Review sub-tab ──────────────────────────────────── */}
              {revisionSubTab === 'editor' && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xl text-purple-600" style={{ fontVariationSettings: "'FILL' 1" }}>rate_review</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Editor Assessment</h3>
                        <p className="text-xs text-slate-500">Senior journal editor assesses revision quality, over-editing, under-editing, and manuscript readiness.</p>
                      </div>
                    </div>
                    {!editorialReviewData && editorialState !== 'running' && revision && (
                      <button onClick={async () => {
                        setEditorialState('running');
                        setEditorialError(null);
                        try {
                          const result = await generateEditorialReview(sessionId, {
                            revised_manuscript: revision.revised_article,
                            reviewer_comments: [
                              ...(review?.major_concerns || []).map((c, i) => ({
                                reviewer_number: 1, comment_number: i + 1,
                                original_comment: c.concern, category: 'major' as const,
                              })),
                              ...(review?.minor_concerns || []).map((c, i) => ({
                                reviewer_number: 1, comment_number: (review?.major_concerns?.length || 0) + i + 1,
                                original_comment: c.concern, category: 'minor' as const,
                              })),
                            ],
                            author_responses: revision.response_data
                              ? ((revision.response_data as any)?.responses || [])
                              : [],
                            journal_name: selectedJournal,
                          });
                          setEditorialReviewData(result);
                          setEditorialState('done');
                        } catch (err: any) {
                          setEditorialError(err?.response?.data?.detail || err?.message || 'Editorial review failed');
                          setEditorialState('error');
                        }
                      }}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #7c3aed, #8b5cf6)', boxShadow: '0 2px 8px rgba(124,58,237,0.2)' }}>
                        <span className="material-symbols-outlined text-base">rate_review</span>
                        Run Editor Assessment
                      </button>
                    )}
                  </div>

                  {!revision && (
                    <div className="py-8 text-center">
                      <p className="text-slate-400 text-sm">Apply manuscript edits first to run the editor review.</p>
                    </div>
                  )}

                  {editorialState === 'running' && (
                    <div className="py-8 text-center">
                      <LoadingLottie className="w-14 h-14 mx-auto" label="Senior editor reviewing your revision…" />
                    </div>
                  )}

                  {editorialError && (
                    <div className="rounded-xl p-4 bg-red-50 border border-red-200">
                      <p className="text-sm text-red-700">{editorialError}</p>
                      <button onClick={() => { setEditorialError(null); setEditorialState('idle'); setEditorialReviewData(null); }}
                        className="mt-2 text-xs text-red-600 underline">Retry</button>
                    </div>
                  )}

                  {editorialReviewData && (
                    <div className="space-y-4">
                      {/* Decision badge */}
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-medium text-slate-500">Editor Decision:</span>
                        <span className={`text-xs font-bold px-3 py-1 rounded-full border ${
                          editorialReviewData.editor_decision === 'accept'
                            ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                            : editorialReviewData.editor_decision === 'minor_revision'
                            ? 'bg-amber-100 text-amber-700 border-amber-200'
                            : 'bg-rose-100 text-rose-700 border-rose-200'
                        }`}>
                          {editorialReviewData.editor_decision === 'accept' ? 'Accept' :
                           editorialReviewData.editor_decision === 'minor_revision' ? 'Minor Revision' : 'Major Revision'}
                        </span>
                      </div>

                      {(editorialReviewData.blocking_issues?.length ?? 0) > 0 && (
                        <div className="rounded-xl p-4 bg-rose-50 border border-rose-200">
                          <h4 className="text-xs font-semibold text-rose-700 mb-2">Blocking Issues</h4>
                          <ul className="space-y-1">
                            {(editorialReviewData.blocking_issues ?? []).map((issue, i) => (
                              <li key={i} className="text-sm text-rose-800">• {issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {(editorialReviewData.advisory_issues?.length ?? 0) > 0 && (
                        <div className="rounded-xl p-4 bg-amber-50 border border-amber-200">
                          <h4 className="text-xs font-semibold text-amber-700 mb-2">Advisory Notes</h4>
                          <ul className="space-y-1">
                            {(editorialReviewData.advisory_issues ?? []).map((issue, i) => (
                              <li key={i} className="text-sm text-amber-800">• {issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Overall assessment */}
                      <div className="rounded-xl p-4 bg-slate-50 border border-slate-200">
                        <h4 className="text-xs font-semibold text-slate-700 mb-2">Overall Assessment</h4>
                        <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{editorialReviewData.overall_assessment}</p>
                      </div>

                      {/* Praise */}
                      {editorialReviewData.praise.length > 0 && (
                        <div className="rounded-xl p-4 bg-emerald-50 border border-emerald-200">
                          <h4 className="text-xs font-semibold text-emerald-700 mb-2">What You Did Well</h4>
                          <ul className="space-y-1">
                            {editorialReviewData.praise.map((p, i) => (
                              <li key={i} className="text-sm text-emerald-800 flex gap-2">
                                <span className="shrink-0 text-emerald-500">+</span><span>{p}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Suggestions cards */}
                      {editorialReviewData.suggestions.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-700 mb-2">Editorial Suggestions ({editorialReviewData.suggestions.length})</h4>
                          <div className="space-y-3">
                            {editorialReviewData.suggestions.map((s, i) => (
                              <CollapsibleSection
                                key={i}
                                title={s.location || `Suggestion ${i + 1}`}
                                meta={`${s.category.replace(/_/g, ' ')} · ${s.severity}`}
                                defaultOpen={i < 2}
                              >
                                <div className="space-y-3">
                                  <div className="flex flex-wrap gap-2">
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                                      {s.category.replace(/_/g, ' ')}
                                    </span>
                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
                                      s.severity === 'critical' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                                      s.severity === 'important' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                      'bg-slate-50 text-slate-600 border-slate-200'
                                    }`}>{s.severity}</span>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Finding</p>
                                    <p className="text-sm text-slate-700 leading-relaxed">{s.finding}</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Recommendation</p>
                                    <p className="text-sm text-slate-800 leading-relaxed">{s.suggestion}</p>
                                  </div>
                                </div>
                              </CollapsibleSection>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Remaining concerns */}
                      {editorialReviewData.remaining_concerns.length > 0 && (
                        <div className="rounded-xl p-4 bg-amber-50 border border-amber-200">
                          <h4 className="text-xs font-semibold text-amber-700 mb-2">Remaining Concerns</h4>
                          <ul className="space-y-1">
                            {editorialReviewData.remaining_concerns.map((c, i) => (
                              <li key={i} className="text-sm text-amber-800 flex gap-2">
                                <span className="shrink-0 text-amber-500">!</span><span>{c}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {((editorialReviewData.blocking_issues?.length ?? 0) > 0 || (editorialReviewData.advisory_issues?.length ?? 0) > 0) && (
                        <button onClick={handleApplyFollowupRevision}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white"
                          style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}>
                          <span className="material-symbols-outlined text-sm">auto_fix_high</span>
                          Apply Justified Follow-up Edits
                        </button>
                      )}

                      {/* Re-run button */}
                      <button onClick={() => { setEditorialReviewData(null); setEditorialState('idle'); }}
                        className="text-xs text-purple-600 underline">Re-run Editor Assessment</button>
                    </div>
                  )}
                </>
              )}

              {/* ── Consistency Audit sub-tab ───────────────────────────────── */}
              {revisionSubTab === 'audit' && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xl text-amber-600" style={{ fontVariationSettings: "'FILL' 1" }}>fact_check</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Preservation Audit</h3>
                        <p className="text-xs text-slate-500">Check that the revision preserved structure, references, figures, tables, and overall manuscript integrity.</p>
                      </div>
                    </div>
                    {!consistencyAudit && auditState !== 'running' && revision && (
                      <button onClick={handleConsistencyAudit}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 2px 8px rgba(79,70,229,0.2)' }}>
                        <span className="material-symbols-outlined text-base">fact_check</span>
                        Run Preservation Audit
                      </button>
                    )}
                  </div>

                  {!revision && (
                    <div className="py-8 text-center">
                      <p className="text-slate-400 text-sm">Apply manuscript edits first to run the consistency audit.</p>
                    </div>
                  )}

                  {auditState === 'running' && (
                    <div className="py-8">
                      <LoadingLottie className="w-14 h-14 mx-auto" label="Running preservation audit…" />
                    </div>
                  )}

                  {consistencyAudit && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          consistencyAudit.all_passed
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}>
                          {consistencyAudit.all_passed ? '✓ All checks passed' : '✗ Issues found'}
                        </span>
                      </div>
                      {consistencyAudit.summary && (
                        <p className="text-sm text-slate-700 leading-relaxed">{consistencyAudit.summary}</p>
                      )}
                      <div className="space-y-1.5">
                        {consistencyAudit.checks.map((c, i) => (
                          <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                            c.passed ? 'bg-emerald-50/50 border border-emerald-100' : 'bg-rose-50/50 border border-rose-100'
                          }`}>
                            <span className={`material-symbols-outlined text-sm mt-0.5 ${c.passed ? 'text-emerald-500' : 'text-rose-500'}`}
                              style={{ fontVariationSettings: "'FILL' 1" }}>
                              {c.passed ? 'check_circle' : 'cancel'}
                            </span>
                            <div>
                              <p className="font-medium text-slate-700">{c.check}</p>
                              {c.detail && <p className="text-slate-500 mt-0.5 leading-relaxed">{c.detail}</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                      {consistencyAudit.unresolved_concerns.length > 0 && (
                        <div className="rounded-xl bg-rose-50/50 border border-rose-200 px-4 py-3">
                          <p className="text-xs font-semibold text-rose-600 uppercase mb-1.5">Unresolved Concerns</p>
                          <ul className="space-y-1">
                            {consistencyAudit.unresolved_concerns.map((u, i) => (
                              <li key={i} className="text-xs text-rose-800">• {u}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {consistencyAudit.new_issues.length > 0 && (
                        <div className="rounded-xl bg-amber-50/50 border border-amber-200 px-4 py-3">
                          <p className="text-xs font-semibold text-amber-600 uppercase mb-1.5">New Issues</p>
                          <ul className="space-y-1">
                            {consistencyAudit.new_issues.map((n, i) => (
                              <li key={i} className="text-xs text-amber-800">• {n}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(auditBlockingIssues.length > 0 || auditAdvisoryIssues.length > 0) && (
                        <button onClick={handleApplyFollowupRevision}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white"
                          style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}>
                          <span className="material-symbols-outlined text-sm">auto_fix_high</span>
                          Apply Justified Follow-up Edits
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── Re-review sub-tab ──────────────────────────────────────── */}
              {revisionSubTab === 'rereview' && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xl text-emerald-600" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-800">Reviewer Re-check</h3>
                        <p className="text-xs text-slate-500">Verify the original reviewer concerns were actually resolved, without starting a fresh review.</p>
                      </div>
                    </div>
                    {!reReview && reReviewState !== 'running' && revision && (
                      <button onClick={handleReReview}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm text-white transition-all active:scale-95 hover:shadow-lg"
                        style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)', boxShadow: '0 2px 8px rgba(79,70,229,0.2)' }}>
                        <span className="material-symbols-outlined text-base">verified</span>
                        Run Reviewer Re-check
                      </button>
                    )}
                  </div>

                  {!revision && (
                    <div className="py-8 text-center">
                      <p className="text-slate-400 text-sm">Apply manuscript edits first to run the re-review.</p>
                    </div>
                  )}

                  {reReviewState === 'running' && (
                    <div className="py-8">
                      <LoadingLottie className="w-14 h-14 mx-auto" label="Running reviewer re-check…" />
                    </div>
                  )}

                  {reReview && (
                    <div className="space-y-4">
                      {(() => {
                        const rc = DECISION_CONFIG[reReview.updated_recommendation] ?? DECISION_CONFIG.major_revision;
                        return (
                          <div className={`rounded-2xl border-2 ${rc.cls} px-6 py-4`}>
                            <p className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-1">Updated Recommendation</p>
                            <p className="text-xl font-bold">{rc.label}</p>
                            {reReview.needs_another_round && (
                              <p className="text-sm mt-1 text-amber-700">Another revision round is recommended.</p>
                            )}
                          </div>
                        );
                      })()}
                      {reReview.summary && (
                        <p className="text-sm text-slate-700 leading-relaxed">{reReview.summary}</p>
                      )}
                      <div className="space-y-2">
                        {reReview.concern_resolutions.map((cr, i) => {
                          const statusCls = cr.status === 'resolved'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : cr.status === 'partially_resolved'
                            ? 'bg-amber-50 border-amber-200 text-amber-700'
                            : 'bg-rose-50 border-rose-200 text-rose-700';
                          const statusLabel = cr.status === 'resolved' ? '✓ Resolved'
                            : cr.status === 'partially_resolved' ? '◐ Partial'
                            : '✗ Unresolved';
                          return (
                            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3">
                              <div className="flex items-start justify-between gap-2 mb-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 font-medium">
                                    {cr.concern_id}
                                  </span>
                                  <span className="text-sm font-medium text-slate-800">{cr.original_concern}</span>
                                </div>
                                <span className={`text-[10px] px-2 py-0.5 rounded-lg border font-semibold whitespace-nowrap ${statusCls}`}>
                                  {statusLabel}
                                </span>
                              </div>
                              <p className="text-xs text-slate-600 leading-relaxed">{cr.explanation}</p>
                              {!cr.response_accurate && (
                                <p className="text-[10px] text-rose-600 mt-1 font-medium">
                                  ⚠ Response does not accurately represent the revision
                                </p>
                              )}
                              {cr.overstatements.length > 0 && (
                                <div className="mt-1.5">
                                  <p className="text-[10px] text-rose-500 font-medium">Overstatements:</p>
                                  {cr.overstatements.map((o, j) => (
                                    <p key={j} className="text-[10px] text-rose-600 ml-2">• {o}</p>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {reReview.remaining_issues.length > 0 && (
                        <div className="rounded-xl bg-amber-50/50 border border-amber-200 px-4 py-3">
                          <p className="text-xs font-semibold text-amber-600 uppercase mb-1.5">Remaining Issues</p>
                          <ul className="space-y-1">
                            {reReview.remaining_issues.map((r, i) => (
                              <li key={i} className="text-xs text-amber-800">• {r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {reReview.new_issues.length > 0 && (
                        <div className="rounded-xl bg-rose-50/50 border border-rose-200 px-4 py-3">
                          <p className="text-xs font-semibold text-rose-600 uppercase mb-1.5">New Issues from Revision</p>
                          <ul className="space-y-1">
                            {reReview.new_issues.map((n, i) => (
                              <li key={i} className="text-xs text-rose-800">• {n}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {reReview.concern_resolutions.length > 0 && (
                        <div className="flex flex-wrap gap-2 text-xs pt-2 border-t border-slate-100">
                          <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                            {reReview.concern_resolutions.filter(cr => cr.status === 'resolved').length} resolved
                          </span>
                          <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                            {reReview.concern_resolutions.filter(cr => cr.status === 'partially_resolved').length} partial
                          </span>
                          <span className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 font-medium">
                            {reReview.concern_resolutions.filter(cr => cr.status === 'unresolved').length} unresolved
                          </span>
                        </div>
                      )}
                      {((reReviewBlockingIssues.length > 0 || reReviewAdvisoryIssues.length > 0) || (editorialBlockingIssues.length + editorialAdvisoryIssues.length) > 0) && (
                        <button onClick={handleApplyFollowupRevision}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white"
                          style={{ background: 'linear-gradient(135deg, #4f46e5, #6366f1)' }}>
                          <span className="material-symbols-outlined text-sm">auto_fix_high</span>
                          Apply Justified Follow-up Edits
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

            </div>{/* end sub-tab content */}
            </>)}
          </div>
          {/* Reference sidebar for revision tab */}
          <ReferenceSidebar
            sessionId={sessionId}
            articleText={revision?.revised_article || articleText}
            selectedJournal={selectedJournal}
            highlightedCiteKey={highlightedCiteKey}
            onCiteClick={(key) => { setHighlightedPaperKey(key); setHighlightedCiteKey(null); }}
            isOpen={sidebarOpen}
            onToggle={() => setSidebarOpen(v => !v)}
            writingState={revisionState}
          />
        </>)}

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
