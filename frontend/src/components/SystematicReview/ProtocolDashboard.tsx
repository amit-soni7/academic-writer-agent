/**
 * ProtocolDashboard — 19-Phase PRISMA-P 2015 Compliant Protocol Builder
 *
 * Layout: 52px icon nav | content area (left ~400px) | document preview (right)
 * New in this version:
 *   - Phase 0: Review Type & Framework (gates downstream phases)
 *   - Background (phase 17) + Rationale (phase 18) moved to end; use Evidence Pack
 *   - Evidence Pack: real literature search → citation-validated background
 *   - PRISMA-P 2015 Completeness Tracker tab (26 items)
 *   - Gemini-style chat UI (✦ avatar, markdown, document change chips)
 *   - Plan Mode (Shift+Tab): AI presents options before applying changes
 *   - Admin phase: authors, funding, registration (structured form)
 *   - Conditional phases: effect_measures hidden for qualitative/scoping reviews
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getPrismaP, savePrismaP,
  generateReviewQuestion, phaseChat, parsePicoFromText,
  buildEvidencePack, writeRationale,
  type ChatMessage, type PrismaPData, type SchemaField, type EvidencePack,
} from '../../api/sr';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  onGoToSearch: () => void;
}

type PhaseId =
  | 'review_setup' | 'objectives' | 'research_question' | 'outcomes'
  | 'eligibility' | 'search_sources' | 'search_strategy' | 'records_management'
  | 'screening' | 'data_collection' | 'data_items'
  | 'rob_assessment' | 'synthesis_plan' | 'effect_measures'
  | 'subgroup_sensitivity' | 'reporting_certainty' | 'admin'
  | 'background' | 'rationale';

interface PhaseState {
  status: 'pending' | 'generating' | 'draft' | 'completed';
  messages: ChatMessage[];
  content: Record<string, unknown>;
  loading: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PHASES: { id: PhaseId; num: number; label: string; noAutoGen?: boolean; conditional?: string }[] = [
  { id: 'review_setup',         num: 0,  label: 'Review Setup',               noAutoGen: true },
  { id: 'objectives',           num: 1,  label: 'Objectives' },
  { id: 'research_question',    num: 2,  label: 'Research Question',           noAutoGen: true },
  { id: 'outcomes',             num: 3,  label: 'Outcomes & Prioritization' },
  { id: 'eligibility',          num: 4,  label: 'Eligibility Criteria' },
  { id: 'search_sources',       num: 5,  label: 'Information Sources' },
  { id: 'search_strategy',      num: 6,  label: 'Search Strategy' },
  { id: 'records_management',   num: 7,  label: 'Records Management' },
  { id: 'screening',            num: 8,  label: 'Screening & Selection' },
  { id: 'data_collection',      num: 9,  label: 'Data Collection Process' },
  { id: 'data_items',           num: 10, label: 'Data Items' },
  { id: 'rob_assessment',       num: 11, label: 'Risk of Bias Assessment' },
  { id: 'synthesis_plan',       num: 12, label: 'Synthesis Plan' },
  { id: 'effect_measures',      num: 13, label: 'Effect Measures',             conditional: 'quantitative' },
  { id: 'subgroup_sensitivity', num: 14, label: 'Subgroup & Sensitivity' },
  { id: 'reporting_certainty',  num: 15, label: 'Reporting Bias & Certainty' },
  { id: 'admin',                num: 16, label: 'Registration & Admin',        noAutoGen: true },
  { id: 'background',           num: 17, label: 'Background',                  noAutoGen: true },
  { id: 'rationale',            num: 18, label: 'Rationale & Gap',             noAutoGen: true },
];

interface FrameworkDef {
  id: string; label: string;
  elements: string[]; elementLabels: Record<string, string>;
  desc: string; discipline: string;
}

const FRAMEWORKS: FrameworkDef[] = [
  { id: 'PICO', label: 'PICO', elements: ['population','intervention','comparator','outcome'], elementLabels: { population:'Population', intervention:'Intervention', comparator:'Comparator', outcome:'Outcome' }, desc: 'Population · Intervention · Comparator · Outcome', discipline: 'Clinical / Epidemiology' },
  { id: 'PICOS', label: 'PICOS', elements: ['population','intervention','comparator','outcome','study_design'], elementLabels: { population:'Population', intervention:'Intervention', comparator:'Comparator', outcome:'Outcome', study_design:'Study Design' }, desc: 'Population · Intervention · Comparator · Outcome · Study Design', discipline: 'Clinical' },
  { id: 'PCC', label: 'PCC', elements: ['population','concept','context'], elementLabels: { population:'Population', concept:'Concept', context:'Context' }, desc: 'Population · Concept · Context', discipline: 'Scoping Reviews (JBI)' },
  { id: 'SPIDER', label: 'SPIDER', elements: ['sample','phenomenon_of_interest','design','evaluation','research_type'], elementLabels: { sample:'Sample', phenomenon_of_interest:'Phenomenon', design:'Design', evaluation:'Evaluation', research_type:'Research Type' }, desc: 'Sample · Phenomenon · Design · Evaluation · Research Type', discipline: 'Qualitative / Mixed Methods' },
  { id: 'PEO', label: 'PEO', elements: ['population','exposure','outcome'], elementLabels: { population:'Population', exposure:'Exposure', outcome:'Outcome' }, desc: 'Population · Exposure · Outcome', discipline: 'Qualitative / Exposure' },
  { id: 'ECLIPSE', label: 'ECLIPSE', elements: ['expectation','client_group','location','impact','professionals','service'], elementLabels: { expectation:'Expectation', client_group:'Client Group', location:'Location', impact:'Impact', professionals:'Professionals', service:'Service' }, desc: 'Expectation · Client · Location · Impact · Professionals · Service', discipline: 'Policy / Management' },
  { id: 'SPICE', label: 'SPICE', elements: ['setting','perspective','interest','comparison','evaluation'], elementLabels: { setting:'Setting', perspective:'Perspective', interest:'Interest', comparison:'Comparison', evaluation:'Evaluation' }, desc: 'Setting · Perspective · Interest · Comparison · Evaluation', discipline: 'Service Evaluation' },
];

const REVIEW_FAMILIES = [
  { id: 'intervention', label: 'Intervention', desc: 'RCTs, quasi-experimental' },
  { id: 'diagnostic', label: 'Diagnostic', desc: 'Test accuracy' },
  { id: 'prevalence', label: 'Prevalence', desc: 'Epidemiology' },
  { id: 'prognosis', label: 'Prognosis', desc: 'Cohort studies' },
  { id: 'qualitative', label: 'Qualitative', desc: 'Experiences & perceptions' },
  { id: 'scoping', label: 'Scoping', desc: 'Evidence mapping' },
  { id: 'mixed_methods', label: 'Mixed Methods', desc: 'Combined designs' },
];

// PRISMA-P 2015 checklist — 26 items mapped to phases
const PRISMA_P_ITEMS: { id: string; section: string; desc: string; phaseId: PhaseId; field?: string }[] = [
  { id: '1a', section: 'TITLE', desc: 'Identified as systematic review / protocol', phaseId: 'admin', field: 'review_title' },
  { id: '1b', section: 'TITLE', desc: 'Identifies if updating a prior review', phaseId: 'admin', field: 'is_update' },
  { id: '2',  section: 'INTRODUCTION', desc: 'Rationale for the review', phaseId: 'rationale' },
  { id: '3',  section: 'INTRODUCTION', desc: 'Explicit objectives using PICO', phaseId: 'objectives' },
  { id: '4',  section: 'METHODS', desc: 'Eligibility criteria (PICO + design + dates)', phaseId: 'eligibility', field: 'inclusion' },
  { id: '5a', section: 'METHODS', desc: 'Information sources (databases)', phaseId: 'search_sources', field: 'databases' },
  { id: '5b', section: 'METHODS', desc: 'Full search strategy for ≥1 database', phaseId: 'search_strategy', field: 'primary_search_string' },
  { id: '5c', section: 'METHODS', desc: 'Date limits', phaseId: 'search_strategy', field: 'date_limits' },
  { id: '5d', section: 'METHODS', desc: 'Grey literature strategy', phaseId: 'search_sources', field: 'grey_literature' },
  { id: '6a', section: 'METHODS', desc: 'Selection process (screening)', phaseId: 'screening', field: 'selection_process' },
  { id: '6b', section: 'METHODS', desc: 'Data management / deduplication', phaseId: 'records_management', field: 'deduplication_tool' },
  { id: '7a', section: 'METHODS', desc: 'Data collection process', phaseId: 'data_collection', field: 'extraction_method' },
  { id: '7b', section: 'METHODS', desc: 'Data items collected', phaseId: 'data_items', field: 'study_characteristics' },
  { id: '8',  section: 'METHODS', desc: 'Risk of bias assessment', phaseId: 'rob_assessment', field: 'primary_tool' },
  { id: '9',  section: 'METHODS', desc: 'Outcomes and prioritization', phaseId: 'outcomes', field: 'primary' },
  { id: '10a', section: 'METHODS', desc: 'Data synthesis criteria', phaseId: 'synthesis_plan', field: 'synthesis_type' },
  { id: '10b', section: 'METHODS', desc: 'Heterogeneity assessment', phaseId: 'synthesis_plan', field: 'heterogeneity_assessment' },
  { id: '10c', section: 'METHODS', desc: 'Subgroup analyses', phaseId: 'subgroup_sensitivity', field: 'subgroup_analyses' },
  { id: '10d', section: 'METHODS', desc: 'Sensitivity analyses', phaseId: 'subgroup_sensitivity', field: 'sensitivity_analyses' },
  { id: '10e', section: 'METHODS', desc: 'Reporting bias (funnel plots etc.)', phaseId: 'reporting_certainty', field: 'reporting_bias_methods' },
  { id: '10f', section: 'METHODS', desc: 'Certainty of evidence (GRADE)', phaseId: 'reporting_certainty', field: 'certainty_tool' },
  { id: '13',  section: 'ADMIN', desc: 'Registration number and registry', phaseId: 'admin', field: 'registry_recommendation' },
  { id: '14',  section: 'ADMIN', desc: 'Protocol access / deposit', phaseId: 'admin', field: 'protocol_deposit' },
  { id: '15a', section: 'ADMIN', desc: 'Funding sources', phaseId: 'admin', field: 'funding_note' },
  { id: '15b', section: 'ADMIN', desc: 'Sponsor / funder role', phaseId: 'admin', field: 'sponsor_role' },
  { id: '16',  section: 'ADMIN', desc: 'Author contributions', phaseId: 'admin', field: 'author_contributions' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function initPhases(): Record<PhaseId, PhaseState> {
  const init: Partial<Record<PhaseId, PhaseState>> = {};
  for (const p of PHASES) {
    init[p.id] = { status: 'pending', messages: [], content: {}, loading: false };
  }
  (init as Record<PhaseId, PhaseState>).review_setup.status = 'draft';
  return init as Record<PhaseId, PhaseState>;
}

function getField(content: Record<string, unknown>, field: string): unknown {
  const parts = field.split('.');
  let cur: unknown = content;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function isNonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function computePrismaStatus(phases: Record<PhaseId, PhaseState>): { completed: number; total: number; items: { id: string; section: string; desc: string; phaseId: PhaseId; done: boolean }[] } {
  const items = PRISMA_P_ITEMS.map(item => {
    const ph = phases[item.phaseId];
    let done = ph.status === 'completed';
    if (done && item.field) {
      done = isNonEmpty(getField(ph.content, item.field));
    }
    return { ...item, done };
  });
  return { completed: items.filter(i => i.done).length, total: items.length, items };
}

function buildProtocolDoc(
  phases: Record<PhaseId, PhaseState>,
  p2: { framework: string; elements: Record<string, string>; rq: string },
  reviewTitle: string,
  evidencePack: EvidencePack | null,
): string {
  const lines: string[] = [];
  const title = reviewTitle || 'Systematic Review Protocol';
  lines.push(`# ${title} — Protocol\n`);

  const bgContent = phases.background.content;
  const bgText = (bgContent.text as string) || (bgContent.draft as string) || '';
  if (bgText) {
    lines.push('## Introduction\n');
    lines.push(bgText);
    lines.push('');
  }

  const ratText = (phases.rationale.content.text as string) || (phases.rationale.content.draft as string) || '';
  if (ratText) {
    lines.push('### Rationale\n');
    lines.push(ratText);
    lines.push('');
  }

  const objContent = phases.objectives.content;
  if (isNonEmpty(objContent.objectives)) {
    lines.push(`### Objectives\n\n${objContent.objectives as string}\n`);
  }

  if (p2.rq) {
    const fw = FRAMEWORKS.find(f => f.id === p2.framework);
    const elemLines = fw
      ? fw.elements.map(el => `**${fw.elementLabels[el]}:** ${p2.elements[el] || ''}`).join('\n\n')
      : Object.entries(p2.elements).map(([k,v]) => `**${k}:** ${v}`).join('\n\n');
    lines.push(`## Research Question\n\n**Framework:** ${p2.framework}\n\n${elemLines}\n\n**Research Question:** ${p2.rq}\n`);
  }

  lines.push('## Methods\n');

  // 3.1 Eligibility
  const ec = phases.eligibility.content;
  if (phases.eligibility.status === 'completed') {
    const inc = (ec.inclusion as string[] || []).map(x => `- ${x}`).join('\n');
    const exc = (ec.exclusion as string[] || []).map(x => `- ${x}`).join('\n');
    lines.push(`### 3.1 Eligibility Criteria\n\n**Inclusion:**\n${inc || '- Not defined'}\n\n**Exclusion:**\n${exc || '- Not defined'}\n`);
  }

  // 3.2 Information Sources
  const sc = phases.search_sources.content;
  if (phases.search_sources.status === 'completed') {
    const dbs = (sc.databases as string[] || []).join(', ');
    lines.push(`### 3.2 Information Sources\n\n**Databases:** ${dbs}\n\nGrey literature: ${sc.grey_literature || 'Not specified'}\n`);
  }

  // 3.3 Search Strategy
  const ss = phases.search_strategy.content;
  if (phases.search_strategy.status === 'completed') {
    lines.push(`### 3.3 Search Strategy\n\n**Database:** ${ss.primary_database || 'PubMed/MEDLINE'}\n\n**Date limits:** ${ss.date_limits || 'Not specified'}\n\n**Language restrictions:** ${ss.language_restrictions || 'Not specified'}\n\n\`\`\`\n${ss.primary_search_string || ''}\n\`\`\`\n`);
  }

  // 3.4 Records Management
  const rm = phases.records_management.content;
  if (phases.records_management.status === 'completed') {
    lines.push(`### 3.4 Records Management\n\nDeduplication: ${rm.deduplication_tool || ''} — ${rm.deduplication_method || ''}\n`);
  }

  // 3.5 Selection Process
  const scr = phases.screening.content;
  if (phases.screening.status === 'completed') {
    lines.push(`### 3.5 Selection Process\n\n${scr.selection_process || ''}\n\nTool: ${scr.data_management_tool || ''}\n`);
  }

  // 3.6 Data Collection Process
  const dc = phases.data_collection.content;
  if (phases.data_collection.status === 'completed') {
    lines.push(`### 3.6 Data Collection Process\n\n${dc.extraction_method || ''}\n`);
  }

  // 3.7 Data Items
  const di = phases.data_items.content;
  if (phases.data_items.status === 'completed') {
    const studs = (di.study_characteristics as string[] || []).map(x => `- ${x}`).join('\n');
    lines.push(`### 3.7 Data Items\n\n${studs || '- Not defined'}\n`);
  }

  // 3.8 Outcomes
  const oc = phases.outcomes.content;
  if (phases.outcomes.status === 'completed') {
    const pri = (oc.primary as string[] || []).map(x => `- ${x}`).join('\n');
    const sec = (oc.secondary as string[] || []).map(x => `- ${x}`).join('\n');
    lines.push(`### 3.8 Outcomes and Prioritization\n\n**Primary:**\n${pri || '- Not defined'}\n\n**Secondary:**\n${sec || '- Not defined'}\n`);
  }

  // 3.9 Risk of Bias
  const rob = phases.rob_assessment.content;
  if (phases.rob_assessment.status === 'completed') {
    lines.push(`### 3.9 Risk of Bias Assessment\n\nTool: **${rob.primary_tool || ''}**\n\n${rob.primary_tool_rationale || ''}\n`);
  }

  // 3.10 Synthesis Methods
  const syn = phases.synthesis_plan.content;
  if (phases.synthesis_plan.status === 'completed') {
    lines.push(`### 3.10 Synthesis Methods\n\nType: ${syn.synthesis_type || ''}\n\n${syn.synthesis_rationale || syn.narrative_method || ''}\n\nHeterogeneity: ${syn.heterogeneity_assessment || ''}\n`);
  }

  // 3.11 Effect Measures
  const em = phases.effect_measures.content;
  if (phases.effect_measures.status === 'completed') {
    lines.push(`### 3.11 Effect Measures\n\nPrimary: **${em.primary_effect_measure || ''}**\n\n${em.rationale || ''}\n`);
  }

  // 3.12 Subgroup & Sensitivity
  const subg = phases.subgroup_sensitivity.content;
  if (phases.subgroup_sensitivity.status === 'completed') {
    const subs = (subg.subgroup_analyses as string[] || []).map(x => `- ${x}`).join('\n');
    const sens = (subg.sensitivity_analyses as string[] || []).map(x => `- ${x}`).join('\n');
    lines.push(`### 3.12 Subgroup and Sensitivity Analyses\n\n**Subgroup analyses:**\n${subs || '- Not specified'}\n\n**Sensitivity analyses:**\n${sens || '- Not specified'}\n`);
  }

  // 3.13 Reporting Bias & Certainty
  const rc = phases.reporting_certainty.content;
  if (phases.reporting_certainty.status === 'completed') {
    const methods = (rc.reporting_bias_methods as string[] || []).join(', ');
    lines.push(`### 3.13 Reporting Bias Assessment\n\n${methods}\n\n### 3.14 Certainty of Evidence\n\nTool: ${rc.certainty_tool || 'GRADE'} (${rc.certainty_software || 'GRADEpro GDT'})\n`);
  }

  // Admin
  const adm = phases.admin.content;
  if (phases.admin.status === 'completed') {
    lines.push(`## Registration\n\nRegistry: **${adm.registry_recommendation || 'PROSPERO'}**\n\n${adm.registry_rationale || ''}\n\nTiming: ${adm.registration_timing || ''}\n`);
  }

  // References from Evidence Pack
  if (evidencePack?.references_md) {
    lines.push('');
    lines.push(evidencePack.references_md);
  }

  return lines.join('\n');
}

// ── Inline markdown renderer ──────────────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      nodes.push(<h2 key={i} style={{ fontFamily: 'Georgia, serif', fontSize: 16, fontWeight: 600, color: 'var(--text-heading)', margin: '16px 0 6px' }}>{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      nodes.push(<h3 key={i} style={{ fontFamily: 'Georgia, serif', fontSize: 14, fontWeight: 600, color: 'var(--text-heading)', margin: '12px 0 4px' }}>{line.slice(4)}</h3>);
    } else if (line.startsWith('# ')) {
      nodes.push(<h1 key={i} style={{ fontFamily: 'Georgia, serif', fontSize: 20, fontWeight: 700, color: 'var(--text-heading)', margin: '0 0 12px' }}>{line.slice(2)}</h1>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      nodes.push(<p key={i} style={{ margin: '2px 0', paddingLeft: 16, color: 'var(--text-body)', fontSize: 13 }}>{line.slice(2)}</p>);
    } else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      nodes.push(<pre key={i} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)', borderRadius: 6, padding: '10px 12px', fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap', margin: '8px 0' }}>{codeLines.join('\n')}</pre>);
    } else if (line.trim() === '---') {
      nodes.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-muted)', margin: '12px 0' }} />);
    } else if (line.trim()) {
      // Inline bold
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const rendered = parts.map((p, j) => p.startsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p);
      nodes.push(<p key={i} style={{ margin: '4px 0', color: 'var(--text-body)', fontSize: 13, lineHeight: 1.6 }}>{rendered}</p>);
    } else {
      nodes.push(<div key={i} style={{ height: 6 }} />);
    }
    i++;
  }
  return nodes;
}

// ── Chat message renderer (Gemini-style) ──────────────────────────────────────

function ChatBubble({ msg, isLast }: { msg: ChatMessage; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
        <div style={{ background: 'var(--bg-elevated)', borderRadius: '14px 14px 2px 14px', padding: '8px 14px', maxWidth: '80%', fontSize: 13, color: 'var(--text-body)', border: '1px solid var(--border-muted)' }}>
          <span>{expanded ? msg.text : (msg.text.length > 120 ? msg.text.slice(0, 120) + '…' : msg.text)}</span>
          {msg.text.length > 120 && (
            <button onClick={() => setExpanded(e => !e)} style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11, cursor: 'pointer', marginLeft: 6 }}>
              {expanded ? '▲' : '▼'}
            </button>
          )}
        </div>
      </div>
    );
  }
  // AI message
  return (
    <div style={{ display: 'flex', gap: 10, margin: '8px 0', alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontSize: 16, marginTop: 2 }}>✦</div>
      <div style={{ flex: 1 }}>
        {isLast && !expanded && msg.text.length > 600 ? (
          <>
            <div style={{ color: 'var(--text-body)', fontSize: 13, lineHeight: 1.6 }}>{renderMarkdown(msg.text.slice(0, 600))}</div>
            <button onClick={() => setExpanded(true)} style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 12, cursor: 'pointer', marginTop: 4, padding: 0 }}>Show more ▼</button>
          </>
        ) : (
          <div style={{ color: 'var(--text-body)', fontSize: 13, lineHeight: 1.6 }}>{renderMarkdown(msg.text)}</div>
        )}
      </div>
    </div>
  );
}

// ── Phase icon numbers ────────────────────────────────────────────────────────

function PhaseIcon({ num, status, active }: { num: number; status: string; active: boolean }) {
  const bg = active ? 'var(--gold)' : status === 'completed' ? 'var(--gold-faint)' : 'transparent';
  const color = active ? '#fff' : status === 'completed' ? 'var(--gold)' : 'var(--text-muted)';
  const border = active ? '2px solid var(--gold)' : status === 'completed' ? '2px solid var(--gold)' : '2px solid var(--border-muted)';
  return (
    <div style={{ width: 26, height: 26, borderRadius: '50%', background: bg, border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color, flexShrink: 0 }}>
      {status === 'completed' && !active ? '✓' : num}
    </div>
  );
}

// ── Admin phase form ───────────────────────────────────────────────────────────

function AdminPhaseEditor({ content, onChange }: { content: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  const upd = (k: string, v: unknown) => onChange({ ...content, [k]: v });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Review Title</label>
        <input value={(content.review_title as string) || ''} onChange={e => upd('review_title', e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', boxSizing: 'border-box' }} placeholder="e.g. Effects of X on Y in Z: a systematic review and meta-analysis" />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Registry</label>
          <select value={(content.registry_recommendation as string) || 'PROSPERO'} onChange={e => upd('registry_recommendation', e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)' }}>
            <option value="PROSPERO">PROSPERO (York)</option>
            <option value="Campbell">Campbell Open Library</option>
            <option value="OSF">OSF Registries</option>
            <option value="INPLASY">INPLASY</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Registration ID (if known)</label>
          <input value={(content.registration_id as string) || ''} onChange={e => upd('registration_id', e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', boxSizing: 'border-box' }} placeholder="CRD42024..." />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Funding / Support</label>
        <input value={(content.funding_note as string) || ''} onChange={e => upd('funding_note', e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', boxSizing: 'border-box' }} placeholder="This review received no specific funding." />
      </div>
      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Competing Interests</label>
        <input value={(content.competing_interests as string) || ''} onChange={e => upd('competing_interests', e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', boxSizing: 'border-box' }} placeholder="None declared." />
      </div>
      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Author Contributions</label>
        <textarea value={(content.author_contributions as string) || ''} onChange={e => upd('author_contributions', e.target.value)} rows={3} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', resize: 'vertical', boxSizing: 'border-box' }} placeholder="Author A: conceptualisation, methodology. Author B: writing – original draft." />
      </div>
      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Amendments Policy</label>
        <textarea value={(content.amendments_policy as string) || ''} onChange={e => upd('amendments_policy', e.target.value)} rows={2} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', resize: 'vertical', boxSizing: 'border-box' }} placeholder="Any deviations from this registered protocol will be documented with date, rationale, and impact." />
      </div>
    </div>
  );
}

// ── PRISMA-P Tracker drawer ────────────────────────────────────────────────────

function PrismaTracker({ phases, open, onClose, onNavigate }: { phases: Record<PhaseId, PhaseState>; open: boolean; onClose: () => void; onNavigate: (id: PhaseId) => void }) {
  const { completed, total, items } = computePrismaStatus(phases);
  const sections = ['TITLE', 'INTRODUCTION', 'METHODS', 'ADMIN'];
  return (
    <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: open ? 340 : 0, background: 'var(--bg-base)', borderLeft: '1px solid var(--border-muted)', overflow: 'hidden', transition: 'width 0.2s ease', zIndex: 20, display: 'flex', flexDirection: 'column' }}>
      {open && (
        <>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>PRISMA-P 2015 Checklist</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{completed} / {total} items complete</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ height: 4, background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-muted)' }}>
            <div style={{ height: '100%', background: 'var(--gold)', width: `${(completed/total)*100}%`, transition: 'width 0.3s ease' }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
            {sections.map(sec => {
              const secItems = items.filter(i => i.section === sec);
              return (
                <div key={sec} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{sec}</div>
                  {secItems.map(item => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border-muted)' }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', background: item.done ? 'var(--gold)' : 'transparent', border: `2px solid ${item.done ? 'var(--gold)' : 'var(--border-muted)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#fff', flexShrink: 0 }}>
                        {item.done ? '✓' : ''}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 24, flexShrink: 0 }}>{item.id}</span>
                      <span style={{ fontSize: 12, color: item.done ? 'var(--text-body)' : 'var(--text-muted)', flex: 1, lineHeight: 1.3 }}>{item.desc}</span>
                      {!item.done && (
                        <button onClick={() => onNavigate(item.phaseId)} style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', padding: '2px 4px' }}>
                          Go →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProtocolDashboard({ projectId, onGoToSearch }: Props) {
  const [phases, setPhases] = useState<Record<PhaseId, PhaseState>>(initPhases);
  const [activePhase, setActivePhase] = useState<PhaseId>('review_setup');
  const [chatInput, setChatInput] = useState('');
  const [query, setQuery] = useState('');
  const [reviewType, setReviewType] = useState('systematic_review');
  const [reviewFamily, setReviewFamily] = useState('intervention');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prismaP, setPrismaP] = useState<PrismaPData>({});

  // Research Question (phase 2) state
  const [p2Sub, setP2Sub] = useState<'framework' | 'elements' | 'rq'>('framework');
  const [selectedFramework, setSelectedFramework] = useState('PICO');
  const [frameworkElements, setFrameworkElements] = useState<Record<string, string>>({});
  const [generatedRQ, setGeneratedRQ] = useState<{ review_question: string; alternative_phrasings: string[]; methodological_cautions: string } | null>(null);
  const [chosenRQ, setChosenRQ] = useState('');
  const [rqLoading, setRqLoading] = useState(false);
  const [p2Loading, setP2Loading] = useState(false);

  // Evidence Pack state
  const [evidencePack, setEvidencePack] = useState<EvidencePack | null>(null);
  const [bgNArticles, setBgNArticles] = useState(20);
  const [bgProgress, setBgProgress] = useState<'idle' | 'searching' | 'drafting' | 'done'>('idle');
  const [bgWarnings, setBgWarnings] = useState<string[]>([]);

  // Chat mode (Shift+Tab toggle)
  const [chatMode, setChatMode] = useState<'direct' | 'plan'>('direct');
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  // PRISMA-P tracker
  const [prismaOpen, setPrismaOpen] = useState(false);

  // Doc-level chat
  const [docChatOpen, setDocChatOpen] = useState(false);
  const [docChatMessages, setDocChatMessages] = useState<ChatMessage[]>([]);
  const [docChatInput, setDocChatInput] = useState('');
  const [docChatLoading, setDocChatLoading] = useState(false);

  // Changed section highlight
  const [changedSection, setChangedSection] = useState<PhaseId | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const autoGenTriggered = useRef<Set<PhaseId>>(new Set());

  // ── Shift+Tab → toggle chat mode ──────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        setChatMode(m => m === 'direct' ? 'plan' : 'direct');
        setPendingPlan(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Load saved state on mount ───────────────────────────────────────────────

  useEffect(() => {
    getPrismaP(projectId).then(({ prisma_p, query: q }) => {
      setQuery(q || '');
      setPrismaP(prisma_p);
      const intro = prisma_p.introduction as Record<string, unknown> | undefined;
      if (intro?.pico) {
        const rt = (intro.pico as Record<string, unknown>)?.review_type as string;
        if (rt) setReviewType(rt);
      }
      setPhases(prev => {
        const updated = { ...prev };
        if ((intro as any)?.background_text) {
          updated.background = { ...updated.background, status: 'completed', content: { text: (intro as any).background_text } };
        }
        if (intro?.rationale) {
          updated.rationale = { ...updated.rationale, status: 'completed', content: { text: intro.rationale as string } };
        }
        if ((intro as any)?.review_objective) {
          updated.objectives = { ...updated.objectives, status: 'completed', content: { objectives: (intro as any).review_objective } };
        }
        if (intro?.review_question) {
          const fw = intro.framework as string || 'PICO';
          const els = (intro.pico as Record<string, string>) || {};
          updated.research_question = { ...updated.research_question, status: 'completed', content: { framework: fw, elements: els, rq: intro.review_question as string } };
          setSelectedFramework(fw);
          setFrameworkElements(els);
          setChosenRQ(intro.review_question as string);
        }
        const me = prisma_p.methods_eligibility;
        if (me?.inclusion_criteria?.length) {
          updated.eligibility = { ...updated.eligibility, status: 'completed', content: { inclusion: me.inclusion_criteria, exclusion: me.exclusion_criteria || [] } };
        }
        if (me?.databases?.length) {
          updated.search_sources = { ...updated.search_sources, status: 'completed', content: { databases: me.databases, grey_literature: me.grey_literature_sources || '' } };
        }
        const ms = prisma_p.methods_search;
        if (ms?.search_strategies && Object.keys(ms.search_strategies).length) {
          const [db, str] = Object.entries(ms.search_strategies)[0];
          updated.search_strategy = { ...updated.search_strategy, status: 'completed', content: { primary_database: db, primary_search_string: str } };
        }
        const mdc = prisma_p.methods_data_collection as Record<string, unknown> | undefined;
        if (mdc?.selection_process) {
          updated.screening = { ...updated.screening, status: 'completed', content: { selection_process: mdc.selection_process, data_management_tool: mdc.data_management_tool || '' } };
        }
        const msy = prisma_p.methods_synthesis;
        if (msy?.rob_tool) {
          updated.rob_assessment = { ...updated.rob_assessment, status: 'completed', content: { primary_tool: msy.rob_tool, primary_tool_rationale: '' } };
        }
        if (msy?.synthesis_type) {
          updated.synthesis_plan = { ...updated.synthesis_plan, status: 'completed', content: { synthesis_type: msy.synthesis_type } };
        }
        const adm = prisma_p.administrative;
        if (adm?.review_title) {
          updated.admin = { ...updated.admin, status: 'completed', content: { review_title: adm.review_title, registry_recommendation: adm.registration_name || 'PROSPERO' } };
        }
        // Mark review_setup as completed if we have framework context
        if (intro?.framework) {
          updated.review_setup = { ...updated.review_setup, status: 'completed' };
        }
        return updated;
      });
    }).catch(() => {});
  }, [projectId]);

  // ── Scroll chat to bottom ──────────────────────────────────────────────────

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [phases[activePhase]?.messages.length]);

  // ── Highlight changed section ──────────────────────────────────────────────

  useEffect(() => {
    if (changedSection) {
      const t = setTimeout(() => setChangedSection(null), 2500);
      return () => clearTimeout(t);
    }
  }, [changedSection]);

  // ── Context builders ───────────────────────────────────────────────────────

  const getPicoContext = useCallback(() => ({
    ...frameworkElements,
    framework: selectedFramework,
    review_type: reviewType,
  }), [frameworkElements, selectedFramework, reviewType]);

  const getContextData = useCallback(() => ({
    review_question: chosenRQ,
    framework: selectedFramework,
    review_family: reviewFamily,
    background: (phases.background.content.text as string) || '',
  }), [chosenRQ, selectedFramework, reviewFamily, phases]);

  // ── Visible phases (conditional logic) ────────────────────────────────────

  const visiblePhases = PHASES.filter(p => {
    if (p.conditional === 'quantitative') {
      return reviewFamily !== 'qualitative' && reviewFamily !== 'scoping';
    }
    return true;
  });

  // ── Auto-generate on phase activation ─────────────────────────────────────

  const triggerAutoGenerate = useCallback(async (phaseId: PhaseId) => {
    if (autoGenTriggered.current.has(phaseId)) return;
    autoGenTriggered.current.add(phaseId);

    setPhases(prev => ({ ...prev, [phaseId]: { ...prev[phaseId], loading: true, status: 'generating' } }));

    try {
      const result = await phaseChat(projectId, {
        phase: phaseId,
        messages: [],
        picoContext: getPicoContext(),
        contextData: getContextData(),
        reviewType,
        mode: 'direct',
      });
      const content = phaseId === 'objectives'
        ? { objectives: (result.content as Record<string, unknown>)?.objectives ?? result.content }
        : result.content;
      setPhases(prev => ({
        ...prev,
        [phaseId]: { ...prev[phaseId], messages: [{ role: 'ai', text: result.reply }], content: content as Record<string, unknown>, loading: false, status: 'draft' },
      }));
    } catch (e) {
      const errText = `Could not auto-generate content: ${String(e)}. Reply in chat to try again.`;
      setPhases(prev => ({
        ...prev,
        [phaseId]: { ...prev[phaseId], messages: [{ role: 'ai', text: errText }], loading: false, status: 'draft' },
      }));
    }
  }, [projectId, getPicoContext, getContextData, reviewType]);

  useEffect(() => {
    const ph = phases[activePhase];
    const phaseDef = PHASES.find(p => p.id === activePhase);
    if (!ph || ph.loading || ph.messages.length > 0 || ph.status === 'completed') return;
    if (phaseDef?.noAutoGen) return;
    if (activePhase === 'research_question') return;
    triggerAutoGenerate(activePhase);
  }, [activePhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Background Evidence Pack flow ──────────────────────────────────────────

  const handleBuildBackground = useCallback(async () => {
    setBgProgress('searching');
    setBgWarnings([]);
    setPhases(prev => ({ ...prev, background: { ...prev.background, loading: true, status: 'generating' } }));
    try {
      setBgProgress('drafting');
      const result = await buildEvidencePack(projectId, {
        query: query || 'systematic review topic',
        nArticles: bgNArticles,
        picoContext: frameworkElements as Record<string, string>,
        reviewType,
      });
      setEvidencePack(result.pack);
      setBgWarnings(result.warnings || []);
      const draft = result.pack.background_draft;
      setPhases(prev => ({
        ...prev,
        background: {
          ...prev.background,
          messages: [{ role: 'ai', text: result.summary || `Background drafted using ${result.pack.deduplicated_count} papers. ${result.pack.cited_ids.length} papers cited.` }],
          content: { text: draft, references_md: result.pack.references_md, sources_used: result.pack.cited_ids.length, retrieved: result.pack.deduplicated_count },
          loading: false,
          status: 'draft',
        },
      }));
      setBgProgress('done');
    } catch (e) {
      setBgProgress('idle');
      setPhases(prev => ({ ...prev, background: { ...prev.background, loading: false, status: 'draft', messages: [{ role: 'ai', text: `Error: ${String(e)}` }] } }));
    }
  }, [projectId, query, bgNArticles, frameworkElements, reviewType]);

  const handleBuildRationale = useCallback(async () => {
    setPhases(prev => ({ ...prev, rationale: { ...prev.rationale, loading: true, status: 'generating' } }));
    try {
      const result = await writeRationale(projectId, { query: query || 'systematic review topic', reviewType });
      if (result.pack) setEvidencePack(result.pack);
      setPhases(prev => ({
        ...prev,
        rationale: {
          ...prev.rationale,
          messages: [{ role: 'ai', text: result.summary || 'Rationale drafted from the evidence pack.' }],
          content: { text: result.pack.rationale_draft },
          loading: false,
          status: 'draft',
        },
      }));
    } catch (e) {
      setPhases(prev => ({ ...prev, rationale: { ...prev.rationale, loading: false, status: 'draft', messages: [{ role: 'ai', text: `Error: ${String(e)}. Make sure Background is generated first.` }] } }));
    }
  }, [projectId, query, reviewType]);

  // ── Chat send ──────────────────────────────────────────────────────────────

  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text) return;

    const ph = phases[activePhase];
    const userMsg: ChatMessage = { role: 'user', text };
    const updatedMessages = [...ph.messages, userMsg];
    setChatInput('');
    setPendingPlan(null);

    setPhases(prev => ({
      ...prev,
      [activePhase]: { ...prev[activePhase], messages: updatedMessages, loading: true },
    }));

    const isTextPhase = activePhase === 'background' || activePhase === 'rationale';
    const currentText = isTextPhase ? (ph.content.text as string) || '' : '';

    try {
      // In plan mode: send with mode='plan' first round
      const sendMode = pendingPlan ? 'direct' : chatMode;

      const result = await phaseChat(projectId, {
        phase: activePhase,
        messages: updatedMessages,
        picoContext: getPicoContext(),
        contextData: {
          ...getContextData(),
          current_draft: currentText,
          pending_plan: pendingPlan || '',
        },
        reviewType,
        mode: sendMode,
      });

      const aiMsg: ChatMessage = { role: 'ai', text: result.reply };
      let newContent = ph.content;

      if (sendMode === 'direct' && Object.keys(result.content).length > 0) {
        if (isTextPhase) {
          const newText = (result.content as Record<string, unknown>)?.text as string;
          if (newText) newContent = { ...ph.content, text: newText };
        } else if (activePhase === 'objectives') {
          newContent = { objectives: (result.content as Record<string, unknown>)?.objectives ?? ph.content.objectives };
        } else if (activePhase === 'research_question') {
          // Apply AI-suggested framework elements without overwriting user edits
          const suggested = (result.content as Record<string, unknown>)?.suggested_elements as Record<string, string> | undefined;
          if (suggested && Object.keys(suggested).length > 0) {
            setFrameworkElements(prev => ({ ...prev, ...suggested }));
          }
          // Also update phase content if any content keys returned
          const contentKeys = Object.keys(result.content).filter(k => k !== 'suggested_elements');
          if (contentKeys.length > 0) {
            newContent = { ...ph.content, ...Object.fromEntries(contentKeys.map(k => [k, (result.content as Record<string, unknown>)[k]])) };
          }
        } else {
          newContent = { ...ph.content, ...result.content };
        }
        setChangedSection(activePhase);
      } else if (chatMode === 'plan' && !pendingPlan) {
        // Store the plan reply for confirmation
        setPendingPlan(result.reply);
      }

      setPhases(prev => ({
        ...prev,
        [activePhase]: { ...prev[activePhase], messages: [...updatedMessages, aiMsg], content: newContent, loading: false },
      }));
    } catch (e) {
      const errMsg: ChatMessage = { role: 'ai', text: `Error: ${String(e)}. Please try again.` };
      setPhases(prev => ({
        ...prev,
        [activePhase]: { ...prev[activePhase], messages: [...updatedMessages, errMsg], loading: false },
      }));
    }
  }, [chatInput, activePhase, phases, projectId, getPicoContext, getContextData, reviewType, chatMode, pendingPlan]);

  // ── Finalize phase ─────────────────────────────────────────────────────────

  const handleFinalize = useCallback(async () => {
    setSaving(true);
    const content = phases[activePhase].content;
    try {
      switch (activePhase) {
        case 'review_setup':
          break;
        case 'background':
          await savePrismaP(projectId, 'introduction', { background_text: content.text } as any);
          break;
        case 'rationale':
          await savePrismaP(projectId, 'introduction', { rationale: content.text as string });
          break;
        case 'objectives':
          await savePrismaP(projectId, 'introduction', { review_objective: content.objectives } as any);
          break;
        case 'outcomes':
          await savePrismaP(projectId, 'methods_data_collection', { outcome_prioritization: (content.primary as string[] || []).join('; ') } as any);
          break;
        case 'eligibility':
          await savePrismaP(projectId, 'methods_eligibility', { inclusion_criteria: content.inclusion as string[] || [], exclusion_criteria: content.exclusion as string[] || [] });
          break;
        case 'search_sources':
          await savePrismaP(projectId, 'methods_eligibility', { databases: content.databases as string[] || [], grey_literature_sources: content.grey_literature as string || '' });
          break;
        case 'search_strategy':
          await savePrismaP(projectId, 'methods_search', { search_strategies: { [content.primary_database as string || 'Primary']: content.primary_search_string as string || '' } });
          break;
        case 'screening':
          await savePrismaP(projectId, 'methods_data_collection', { selection_process: content.selection_process as string || '', data_management_tool: content.data_management_tool as string || '' });
          break;
        case 'rob_assessment':
          await savePrismaP(projectId, 'methods_synthesis', { rob_tool: content.primary_tool as string || '' } as any);
          break;
        case 'synthesis_plan':
          await savePrismaP(projectId, 'methods_synthesis', { synthesis_type: content.synthesis_type as string || '' } as any);
          break;
        case 'admin':
          await savePrismaP(projectId, 'administrative', { review_title: content.review_title as string || '', registration_name: content.registry_recommendation as string || 'PROSPERO' });
          break;
      }

      const visIdx = visiblePhases.findIndex(p => p.id === activePhase);
      const next = visiblePhases[visIdx + 1];
      setPhases(prev => {
        const updated = { ...prev };
        updated[activePhase] = { ...updated[activePhase], status: 'completed' };
        if (next) updated[next.id] = { ...updated[next.id], status: updated[next.id].status === 'pending' ? 'draft' : updated[next.id].status };
        return updated;
      });
      if (next) setActivePhase(next.id);
    } catch (e) {
      console.error('Failed to save phase:', e);
    }
    setSaving(false);
  }, [activePhase, phases, projectId, visiblePhases]);

  // ── Research question handlers ─────────────────────────────────────────────

  const handleFillElements = useCallback(async () => {
    setP2Loading(true);
    try {
      const fw = FRAMEWORKS.find(f => f.id === selectedFramework)!;
      const init: Record<string, string> = {};
      if (query) {
        const parsed = await parsePicoFromText(query, reviewType, selectedFramework);
        const src = parsed.pico as Record<string, string>;
        for (const el of fw.elements) init[el] = src[el] || '';
      }
      setFrameworkElements(init);
      setP2Sub('elements');
    } catch {
      setP2Sub('elements');
    }
    setP2Loading(false);
  }, [selectedFramework, query, reviewType]);

  const handleGenerateRQ = useCallback(async () => {
    setRqLoading(true);
    try {
      const result = await generateReviewQuestion({ framework: selectedFramework, elements: frameworkElements, reviewType });
      setGeneratedRQ(result);
      setChosenRQ(result.review_question);
      setP2Sub('rq');
    } catch (e) {
      console.error('RQ generation failed:', e);
    }
    setRqLoading(false);
  }, [selectedFramework, frameworkElements, reviewType]);

  const handleFinalizeRQ = useCallback(async () => {
    setSaving(true);
    try {
      await savePrismaP(projectId, 'introduction', {
        framework: selectedFramework,
        pico: frameworkElements as any,
        review_question: chosenRQ,
        alternative_phrasings: generatedRQ?.alternative_phrasings || [],
        methodological_cautions: generatedRQ?.methodological_cautions || '',
      });
      const visIdx = visiblePhases.findIndex(p => p.id === 'research_question');
      const next = visiblePhases[visIdx + 1];
      setPhases(prev => {
        const updated = { ...prev };
        updated.research_question = { ...updated.research_question, status: 'completed', content: { framework: selectedFramework, elements: frameworkElements, rq: chosenRQ } };
        if (next) updated[next.id] = { ...updated[next.id], status: 'draft' };
        return updated;
      });
      if (next) { setActivePhase(next.id); setP2Sub('framework'); }
    } catch (e) {
      console.error('Failed to save RQ:', e);
    }
    setSaving(false);
  }, [projectId, selectedFramework, frameworkElements, chosenRQ, generatedRQ, visiblePhases]);

  // ── Doc-level chat ─────────────────────────────────────────────────────────

  const handleDocChatSend = useCallback(async () => {
    const text = docChatInput.trim();
    if (!text) return;
    const userMsg: ChatMessage = { role: 'user', text };
    const updated = [...docChatMessages, userMsg];
    setDocChatMessages(updated);
    setDocChatInput('');
    setDocChatLoading(true);
    try {
      const adminContent = phases.admin.content;
      const currentDoc = buildProtocolDoc(phases, { framework: selectedFramework, elements: frameworkElements, rq: chosenRQ }, (adminContent.review_title as string) || '', evidencePack);
      const result = await phaseChat(projectId, {
        phase: 'protocol_chat',
        messages: updated,
        picoContext: getPicoContext(),
        contextData: { ...getContextData(), protocol_document: currentDoc },
        reviewType,
      });
      setDocChatMessages(prev => [...prev, { role: 'ai', text: result.reply }]);
    } catch (e) {
      setDocChatMessages(prev => [...prev, { role: 'ai', text: `Error: ${String(e)}` }]);
    }
    setDocChatLoading(false);
  }, [docChatInput, docChatMessages, projectId, getPicoContext, getContextData, reviewType, phases, selectedFramework, frameworkElements, chosenRQ, evidencePack]);

  // ── Copy ───────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    const adminContent = phases.admin.content;
    const doc = buildProtocolDoc(phases, { framework: selectedFramework, elements: frameworkElements, rq: chosenRQ }, (adminContent.review_title as string) || '', evidencePack);
    navigator.clipboard.writeText(doc).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [phases, selectedFramework, frameworkElements, chosenRQ, evidencePack]);

  // ── Phase navigation ───────────────────────────────────────────────────────

  const handlePhaseClick = useCallback((phaseId: PhaseId) => {
    setActivePhase(phaseId);
    setPendingPlan(null);
  }, []);

  // ── Render: active phase editing area ─────────────────────────────────────

  const ph = phases[activePhase];
  const phaseDef = PHASES.find(p => p.id === activePhase)!;
  const isLoading = ph.loading;

  const { completed: prismaCompleted, total: prismaTotal } = computePrismaStatus(phases);

  function renderPhaseContent() {
    // Review Setup (Phase 0)
    if (activePhase === 'review_setup') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Review Family</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {REVIEW_FAMILIES.map(rf => (
                <button key={rf.id} onClick={() => setReviewFamily(rf.id)} style={{ padding: '6px 12px', borderRadius: 20, border: `2px solid ${reviewFamily === rf.id ? 'var(--gold)' : 'var(--border-muted)'}`, background: reviewFamily === rf.id ? 'var(--gold-faint)' : 'var(--bg-elevated)', color: reviewFamily === rf.id ? 'var(--gold)' : 'var(--text-body)', fontSize: 12, cursor: 'pointer', fontWeight: reviewFamily === rf.id ? 600 : 400 }}>
                  {rf.label}
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{rf.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Question Framework</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FRAMEWORKS.map(fw => (
                <button key={fw.id} onClick={() => setSelectedFramework(fw.id)} style={{ padding: '6px 12px', borderRadius: 6, border: `2px solid ${selectedFramework === fw.id ? 'var(--gold)' : 'var(--border-muted)'}`, background: selectedFramework === fw.id ? 'var(--gold-faint)' : 'var(--bg-elevated)', color: selectedFramework === fw.id ? 'var(--gold)' : 'var(--text-body)', fontSize: 12, cursor: 'pointer', fontWeight: selectedFramework === fw.id ? 600 : 400 }}>
                  <span>{fw.label}</span>
                  <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{fw.discipline}</span>
                </button>
              ))}
            </div>
          </div>
          {reviewFamily === 'qualitative' && (
            <div style={{ padding: '8px 12px', background: 'rgba(var(--gold-rgb),0.08)', borderRadius: 6, border: '1px solid var(--gold)', fontSize: 12, color: 'var(--text-body)' }}>
              ℹ Qualitative review: Effect Measures phase will be hidden. Certainty will use CERQual instead of GRADE.
            </div>
          )}
          {reviewFamily === 'scoping' && (
            <div style={{ padding: '8px 12px', background: 'rgba(var(--gold-rgb),0.08)', borderRadius: 6, border: '1px solid var(--gold)', fontSize: 12, color: 'var(--text-body)' }}>
              ℹ Scoping review: Effect Measures and Certainty phases hidden. PRISMA-ScR applies.
            </div>
          )}
        </div>
      );
    }

    // Background (Phase 17) — explicit trigger
    if (activePhase === 'background') {
      const bgText = (ph.content.text as string) || '';
      if (!bgText && bgProgress === 'idle') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border-muted)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text-body)' }}>Scoping Literature Search</strong><br/>
              This searches the literature to write your Background section with real in-text citations.
              It is separate from the formal review search in phase 6.
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Articles to retrieve</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {[10, 20, 50, 100, 200].map(n => (
                  <button key={n} onClick={() => setBgNArticles(n)} style={{ padding: '5px 12px', borderRadius: 16, border: `2px solid ${bgNArticles === n ? 'var(--gold)' : 'var(--border-muted)'}`, background: bgNArticles === n ? 'var(--gold-faint)' : 'var(--bg-elevated)', color: bgNArticles === n ? 'var(--gold)' : 'var(--text-body)', fontSize: 12, cursor: 'pointer', fontWeight: bgNArticles === n ? 600 : 400 }}>
                    {n}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {bgNArticles === 10 ? '~15s' : bgNArticles === 20 ? '~30s' : bgNArticles === 50 ? '~1m' : bgNArticles === 100 ? '~2m' : '~4m'}
                </span>
              </div>
            </div>
            <button onClick={handleBuildBackground} style={{ padding: '10px 18px', background: 'var(--gold)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' }}>
              Search & Draft Background →
            </button>
          </div>
        );
      }

      if (bgProgress === 'searching' || bgProgress === 'drafting' || isLoading) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '20px 0' }}>
            {['Generating search queries...', 'Searching databases...', bgProgress === 'drafting' ? 'Deduplicating and ranking...' : ''].filter(Boolean).map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-body)' }}>
                <span style={{ color: 'var(--gold)' }}>✓</span> {step}
              </div>
            ))}
            {bgProgress === 'drafting' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-muted)' }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span> Drafting background with citations...
              </div>
            )}
          </div>
        );
      }

      // Background has content
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {evidencePack && (
            <div style={{ padding: '6px 12px', background: 'var(--gold-faint)', borderRadius: 6, border: '1px solid var(--gold)', fontSize: 11, color: 'var(--gold)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>✦ Based on {(ph.content.sources_used as number) || 0} cited papers · {(ph.content.retrieved as number) || 0} retrieved · {evidencePack.search_date}</span>
              <button onClick={() => { setBgProgress('idle'); setPhases(prev => ({ ...prev, background: { ...prev.background, content: {}, messages: [] } })); autoGenTriggered.current.delete('background'); }} style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11, cursor: 'pointer' }}>Re-search</button>
            </div>
          )}
          {bgWarnings.length > 0 && (
            <div style={{ padding: '6px 10px', background: 'rgba(255,160,50,0.1)', borderRadius: 6, border: '1px solid orange', fontSize: 11, color: 'var(--text-muted)' }}>
              ⚠ {bgWarnings.length} citation(s) could not be resolved
            </div>
          )}
          <textarea
            value={bgText}
            onChange={e => setPhases(prev => ({ ...prev, background: { ...prev.background, content: { ...prev.background.content, text: e.target.value } } }))}
            rows={14}
            style={{ width: '100%', padding: '10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 8, color: 'var(--text-body)', resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box' }}
          />
          {evidencePack?.references_md && (
            <details style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <summary style={{ fontWeight: 600, color: 'var(--text-body)' }}>References ({evidencePack.cited_ids.length})</summary>
              <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: 6, whiteSpace: 'pre-line', fontSize: 11, lineHeight: 1.5 }}>
                {evidencePack.references_md}
              </div>
            </details>
          )}
        </div>
      );
    }

    // Rationale (Phase 18) — reuses Evidence Pack
    if (activePhase === 'rationale') {
      const ratText = (ph.content.text as string) || '';
      if (!ratText && !isLoading) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {evidencePack ? (
              <div style={{ padding: '8px 12px', background: 'var(--gold-faint)', borderRadius: 6, border: '1px solid var(--gold)', fontSize: 12, color: 'var(--text-body)' }}>
                Reusing evidence pack: {evidencePack.deduplicated_count} papers · {evidencePack.search_date}
              </div>
            ) : (
              <div style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                ⚠ No evidence pack found. Complete Background phase first.
              </div>
            )}
            <button onClick={handleBuildRationale} disabled={!evidencePack} style={{ padding: '10px 18px', background: evidencePack ? 'var(--gold)' : 'var(--border-muted)', border: 'none', borderRadius: 8, color: evidencePack ? '#fff' : 'var(--text-muted)', fontSize: 13, fontWeight: 600, cursor: evidencePack ? 'pointer' : 'not-allowed', alignSelf: 'flex-start' }}>
              Draft Rationale & Gap →
            </button>
          </div>
        );
      }
      if (isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>⟳ Drafting rationale from evidence pack…</div>;
      return (
        <textarea
          value={ratText}
          onChange={e => setPhases(prev => ({ ...prev, rationale: { ...prev.rationale, content: { ...prev.rationale.content, text: e.target.value } } }))}
          rows={12}
          style={{ width: '100%', padding: '10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 8, color: 'var(--text-body)', resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box' }}
        />
      );
    }

    // Research Question (Phase 2) — 3 sub-screens
    if (activePhase === 'research_question') {
      if (p2Sub === 'framework') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Select the question framework that best fits your review:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {FRAMEWORKS.map(fw => (
                <div key={fw.id} onClick={() => setSelectedFramework(fw.id)} style={{ padding: '10px 14px', borderRadius: 8, border: `2px solid ${selectedFramework === fw.id ? 'var(--gold)' : 'var(--border-muted)'}`, background: selectedFramework === fw.id ? 'var(--gold-faint)' : 'var(--bg-elevated)', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: selectedFramework === fw.id ? 'var(--gold)' : 'var(--text-heading)' }}>{fw.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{fw.desc}</div>
                  <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 2 }}>{fw.discipline}</div>
                </div>
              ))}
            </div>
            <button onClick={handleFillElements} disabled={p2Loading} style={{ padding: '10px 18px', background: 'var(--gold)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {p2Loading ? 'Filling elements…' : `Use ${selectedFramework} →`}
            </button>
          </div>
        );
      }
      if (p2Sub === 'elements') {
        const fw = FRAMEWORKS.find(f => f.id === selectedFramework)!;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI pre-filled from your research topic. Edit as needed:</div>
            {fw.elements.map(el => (
              <div key={el}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{fw.elementLabels[el]}</label>
                <textarea value={frameworkElements[el] || ''} onChange={e => setFrameworkElements(prev => ({ ...prev, [el]: e.target.value }))} rows={2} style={{ width: '100%', marginTop: 4, padding: '6px 10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-body)', resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setP2Sub('framework')} style={{ padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>← Back</button>
              <button onClick={handleGenerateRQ} disabled={rqLoading} style={{ flex: 1, padding: '8px 14px', background: 'var(--gold)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {rqLoading ? 'Generating…' : 'Generate Research Question →'}
              </button>
            </div>
          </div>
        );
      }
      // p2Sub === 'rq'
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ padding: '12px 14px', background: 'var(--bg-elevated)', borderRadius: 8, border: '2px solid var(--gold)' }}>
            <div style={{ fontSize: 11, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Primary Research Question</div>
            <div style={{ fontSize: 14, color: 'var(--text-heading)', lineHeight: 1.5 }}>{chosenRQ}</div>
          </div>
          {generatedRQ?.alternative_phrasings?.length ? (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Alternatives</div>
              {generatedRQ.alternative_phrasings.map((rq, i) => (
                <div key={i} onClick={() => setChosenRQ(rq)} style={{ padding: '8px 12px', marginBottom: 6, borderRadius: 6, border: `1px solid ${chosenRQ === rq ? 'var(--gold)' : 'var(--border-muted)'}`, background: chosenRQ === rq ? 'var(--gold-faint)' : 'var(--bg-elevated)', cursor: 'pointer', fontSize: 12, color: 'var(--text-body)' }}>
                  {rq}
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setP2Sub('elements')} style={{ padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>← Back</button>
            <button onClick={handleFinalizeRQ} disabled={saving || !chosenRQ} style={{ flex: 1, padding: '8px 14px', background: 'var(--gold)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {saving ? 'Saving…' : 'Finalize Research Question →'}
            </button>
          </div>
        </div>
      );
    }

    // Admin phase (structured form)
    if (activePhase === 'admin') {
      return (
        <AdminPhaseEditor
          content={ph.content}
          onChange={content => setPhases(prev => ({ ...prev, admin: { ...prev.admin, content } }))}
        />
      );
    }

    // Objectives (plain text)
    if (activePhase === 'objectives') {
      const text = (ph.content.objectives as string) || '';
      return (
        <textarea
          value={text}
          onChange={e => setPhases(prev => ({ ...prev, objectives: { ...prev.objectives, content: { objectives: e.target.value } } }))}
          rows={6}
          style={{ width: '100%', padding: '10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 8, color: 'var(--text-body)', resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box' }}
          placeholder="This systematic review will collate and synthesise evidence on…"
        />
      );
    }

    // Generic editor for all other phases
    const content = ph.content;
    const isTextContent = typeof content.text === 'string';
    if (isTextContent) {
      return (
        <textarea value={content.text as string} onChange={e => setPhases(prev => ({ ...prev, [activePhase]: { ...prev[activePhase], content: { ...prev[activePhase].content, text: e.target.value } } }))} rows={10} style={{ width: '100%', padding: '10px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 8, color: 'var(--text-body)', resize: 'vertical', lineHeight: 1.6, boxSizing: 'border-box' }} />
      );
    }
    // Structured content display
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Object.entries(content).filter(([k]) => k !== '__type').map(([k, v]) => (
          <div key={k}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.8 }}>{k.replace(/_/g, ' ')}</label>
            {Array.isArray(v) ? (
              <div style={{ marginTop: 4 }}>
                {(v as string[]).map((item, i) => (
                  <div key={i} style={{ padding: '4px 10px', marginBottom: 4, background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 12, color: 'var(--text-body)', border: '1px solid var(--border-muted)' }}>• {item}</div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 4, padding: '6px 10px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 12, color: 'var(--text-body)', border: '1px solid var(--border-muted)', whiteSpace: 'pre-wrap' }}>{String(v || '—')}</div>
            )}
          </div>
        ))}
        {isLoading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Generating…</div>}
        {!isLoading && Object.keys(content).length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Chat below to generate content for this section.</div>
        )}
      </div>
    );
  }

  // ── Build protocol doc for preview ────────────────────────────────────────

  const adminContent = phases.admin.content;
  const protocolDoc = buildProtocolDoc(phases, { framework: selectedFramework, elements: frameworkElements, rq: chosenRQ }, (adminContent.review_title as string) || '', evidencePack);

  // ── Render ────────────────────────────────────────────────────────────────

  const showChatForPhase = activePhase !== 'review_setup' && activePhase !== 'admin';
  const canFinalize = ph.status !== 'completed' && (activePhase === 'admin' || activePhase === 'review_setup' || ph.messages.length > 0 || Object.keys(ph.content).length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'row' as const, height: '100%', overflow: 'hidden', background: 'var(--bg-base)' }}>
      {/* ── Left panel ─────────────────────────────────────────────────────────── */}
      <div style={{ width: 400, flexShrink: 0, display: 'flex', flexDirection: 'row' as const, borderRight: '1px solid var(--border-muted)', overflow: 'hidden' }}>
        {/* Icon nav (52px) */}
        <div style={{ width: 52, flexShrink: 0, borderRight: '1px solid var(--border-muted)', overflowY: 'auto', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', paddingTop: 8, gap: 2, background: 'var(--bg-elevated)' }}>
          {visiblePhases.map(p => (
            <button
              key={p.id}
              title={p.label}
              onClick={() => handlePhaseClick(p.id)}
              style={{ width: 36, height: 36, borderRadius: 8, border: activePhase === p.id ? '2px solid var(--gold)' : '2px solid transparent', background: activePhase === p.id ? 'var(--gold-faint)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
            >
              <PhaseIcon num={p.num} status={phases[p.id].status} active={activePhase === p.id} />
            </button>
          ))}
        </div>

        {/* Content area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
          {/* Phase header */}
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-muted)', flexShrink: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Phase {phaseDef.num}</div>
            <div style={{ fontSize: 16, fontFamily: 'Georgia, serif', fontWeight: 600, color: 'var(--text-heading)', marginTop: 2 }}>{phaseDef.label}</div>
          </div>

          {/* Phase content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
            {isLoading && activePhase !== 'background' && activePhase !== 'rationale' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>
                <span style={{ color: 'var(--gold)' }}>✦</span> Generating…
              </div>
            ) : renderPhaseContent()}
          </div>

          {/* Chat thread */}
          {showChatForPhase && ph.messages.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: 'auto', padding: '8px 16px', borderTop: '1px solid var(--border-muted)', flexShrink: 0, background: 'var(--bg-base)' }}>
              {ph.messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} isLast={i === ph.messages.length - 1} />
              ))}
              {ph.loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13, padding: '6px 0' }}>
                  <span style={{ color: 'var(--gold)' }}>✦</span> <span style={{ opacity: 0.6 }}>•••</span>
                </div>
              )}
              {changedSection === activePhase && (
                <div style={{ fontSize: 11, color: 'var(--gold)', padding: '4px 0 0 32px' }}>✦ Updated in document →</div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Plan mode pending plan UI */}
          {pendingPlan && (
            <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-muted)', background: 'var(--gold-faint)', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--gold)', marginBottom: 6, fontWeight: 600 }}>Plan ready — apply changes?</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => { setChatInput('Yes, apply these changes'); setPendingPlan(null); setTimeout(() => handleSendChat(), 100); }} style={{ flex: 1, padding: '6px', background: 'var(--gold)', border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, cursor: 'pointer' }}>Yes, apply</button>
                <button onClick={() => setPendingPlan(null)} style={{ padding: '6px 10px', background: 'transparent', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Chat input */}
          {showChatForPhase && (
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-muted)', flexShrink: 0, background: 'var(--bg-elevated)' }}>
              {/* Chat mode toggle */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                <button onClick={() => { setChatMode('direct'); setPendingPlan(null); }} style={{ padding: '3px 10px', borderRadius: 12, border: `1px solid ${chatMode === 'direct' ? 'var(--gold)' : 'var(--border-muted)'}`, background: chatMode === 'direct' ? 'var(--gold-faint)' : 'transparent', color: chatMode === 'direct' ? 'var(--gold)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontWeight: chatMode === 'direct' ? 600 : 400 }}>⚡ Direct</button>
                <button onClick={() => { setChatMode('plan'); setPendingPlan(null); }} style={{ padding: '3px 10px', borderRadius: 12, border: `1px solid ${chatMode === 'plan' ? 'var(--gold)' : 'var(--border-muted)'}`, background: chatMode === 'plan' ? 'var(--gold-faint)' : 'transparent', color: chatMode === 'plan' ? 'var(--gold)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontWeight: chatMode === 'plan' ? 600 : 400 }}>◆ Plan</button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>Shift+Tab to toggle</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                  placeholder={chatMode === 'plan' ? 'Describe what you want… AI will suggest options first' : 'Tell me what to change…'}
                  rows={2}
                  style={{ flex: 1, padding: '8px 12px', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-muted)', borderRadius: 12, color: 'var(--text-body)', resize: 'none', lineHeight: 1.4 }}
                />
                <button onClick={handleSendChat} disabled={!chatInput.trim() || ph.loading} style={{ width: 32, height: 32, borderRadius: '50%', background: chatInput.trim() ? 'var(--gold)' : 'var(--border-muted)', border: 'none', color: '#fff', fontSize: 16, cursor: chatInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>↑</button>
              </div>
            </div>
          )}

          {/* Finalize / Back buttons */}
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-muted)', display: 'flex', gap: 8, flexShrink: 0, background: 'var(--bg-elevated)' }}>
            {visiblePhases.findIndex(p => p.id === activePhase) > 0 && (
              <button onClick={() => { const idx = visiblePhases.findIndex(p => p.id === activePhase); if (idx > 0) setActivePhase(visiblePhases[idx - 1].id); }} style={{ padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-muted)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>← Back</button>
            )}
            {activePhase !== 'research_question' && (
              <button onClick={handleFinalize} disabled={saving || !canFinalize} style={{ flex: 1, padding: '8px 14px', background: canFinalize ? 'var(--gold)' : 'var(--border-muted)', border: 'none', borderRadius: 6, color: canFinalize ? '#fff' : 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: canFinalize ? 'pointer' : 'default' }}>
                {saving ? 'Saving…' : phases[activePhase].status === 'completed' ? '✓ Completed' : 'Finalize →'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Right panel: document preview ──────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', position: 'relative' as const }}>
        {/* Toolbar */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-muted)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, background: 'var(--bg-base)' }}>
          <button onClick={() => setDocChatOpen(o => !o)} style={{ fontFamily: 'Georgia, serif', fontSize: 15, fontWeight: 600, color: docChatOpen ? 'var(--gold)' : 'var(--text-heading)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            Protocol Document <span style={{ fontSize: 12 }}>💬</span>
          </button>
          <div style={{ flex: 1 }} />
          {/* PRISMA-P tracker pill */}
          <button onClick={() => setPrismaOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 16, border: `1px solid ${prismaCompleted === prismaTotal ? 'var(--gold)' : 'var(--border-muted)'}`, background: prismaOpen ? 'var(--gold-faint)' : 'var(--bg-elevated)', color: prismaCompleted === prismaTotal ? 'var(--gold)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
            PRISMA-P {prismaCompleted}/{prismaTotal}
            <span style={{ display: 'flex', gap: 2 }}>
              {Array.from({ length: Math.min(12, prismaTotal) }, (_, i) => (
                <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: i < Math.round((prismaCompleted/prismaTotal)*12) ? 'var(--gold)' : 'var(--border-muted)', display: 'inline-block' }} />
              ))}
            </span>
          </button>
          <button onClick={handleCopy} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-muted)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
            {copied ? '✓ Copied' : 'Copy MD'}
          </button>
        </div>

        {/* Document content */}
        <div ref={rightPanelRef} style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', maxWidth: 780, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
          {renderMarkdown(protocolDoc)}
        </div>

        {/* Doc-level chat drawer */}
        {docChatOpen && (
          <div style={{ position: 'absolute' as const, bottom: 0, left: 0, right: 0, height: '50%', background: 'var(--bg-base)', borderTop: '2px solid var(--gold)', display: 'flex', flexDirection: 'column' as const, zIndex: 10 }}>
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ color: 'var(--gold)' }}>✦</span> Protocol Chat</span>
              <button onClick={() => setDocChatOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
              {docChatMessages.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 20 }}>Ask me anything about this protocol…</div>
              )}
              {docChatMessages.map((msg, i) => <ChatBubble key={i} msg={msg} isLast={i === docChatMessages.length - 1} />)}
              {docChatLoading && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  <span style={{ color: 'var(--gold)' }}>✦</span> <span>•••</span>
                </div>
              )}
              <div ref={docChatEndRef} />
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-muted)', display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
              <textarea value={docChatInput} onChange={e => setDocChatInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleDocChatSend(); } }} placeholder="Ask about this protocol…" rows={2} style={{ flex: 1, padding: '8px 12px', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-muted)', borderRadius: 12, color: 'var(--text-body)', resize: 'none' }} />
              <button onClick={handleDocChatSend} disabled={!docChatInput.trim() || docChatLoading} style={{ width: 32, height: 32, borderRadius: '50%', background: docChatInput.trim() ? 'var(--gold)' : 'var(--border-muted)', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>↑</button>
            </div>
          </div>
        )}

        {/* PRISMA-P tracker drawer */}
        <PrismaTracker phases={phases} open={prismaOpen} onClose={() => setPrismaOpen(false)} onNavigate={id => { handlePhaseClick(id); setPrismaOpen(false); }} />
      </div>
    </div>
  );
}
