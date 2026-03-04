// Mirrors backend models.py — all shared types

export interface Paper {
  title: string;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  year: number | null;
  journal: string | null;
  citation_count: number | null;
  oa_pdf_url: string | null;
  source: 'pubmed' | 'pmc' | 'openalex' | 'semantic_scholar' | 'crossref' | 'europe_pmc' | 'clinical_trials' | 'arxiv' | 'cited_reference';
}

export interface SearchResponse {
  papers: Paper[];
  total: number;
  sources_queried: string[];
}

export interface ProjectMeta {
  project_id: string;
  query: string;
  created_at: string;
  updated_at: string;
  paper_count: number;
  summary_count: number;
  has_journals: boolean;
  has_article: boolean;
  manuscript_title?: string | null;
  article_type?: string | null;
  project_name?: string | null;
  project_description?: string | null;
  project_folder?: string | null;
  current_phase?: string | null;
  project_type?: 'write' | 'revision' | null;
}

// ── Real peer-review revision types ────────────────────────────────────────────

export interface RevisionIntakeData {
  manuscript_text: string;
  manuscript_file: File | null;
  reviewer_comments_text: string;
  reviewer_comments_file: File | null;
  journal_name: string;
  project_name: string;
  project_description: string;
}

export interface RealReviewerComment {
  reviewer_number: number;
  comment_number: number;
  original_comment: string;
  category: 'major' | 'minor' | 'editorial';
  severity?: 'major' | 'minor' | 'editorial';
  domain?: 'writing' | 'methodology' | 'results' | 'references' | 'ethics' | 'statistics' | 'other';
  requirement_level?: 'mandatory' | 'optional' | 'unclear';
  ambiguity_flag?: boolean;
  ambiguity_question?: string;
  intent_interpretation?: string;
}

export interface ReviewCommentResponse {
  reviewer_number: number;
  comment_number: number;
  original_comment: string;
  author_response: string;
  action_taken: string;
  manuscript_diff: string;
}

export interface RevisionRound {
  round_number: number;
  journal_name: string;
  raw_comments: string;
  parsed_comments: RealReviewerComment[];
  responses: ReviewCommentResponse[];
  revised_article: string;
  point_by_point_md: string;
  created_at: string;
}

export interface ImportManuscriptResult {
  word_count: number;
  sections_found: string[];
  references_found: number;
  manuscript_summary: string;
}

// Backward-compat alias
export type SessionMeta = ProjectMeta;

// ── Per-comment discussion types ───────────────────────────────────────────────

export interface DiscussionMessage {
  role: 'ai' | 'user';
  content: string;
}

export interface CommentPlan {
  reviewer_number: number;
  comment_number: number;
  original_comment: string;
  category: string;
  discussion: DiscussionMessage[];
  current_plan: string;
  doi_references: string[];
  is_finalized: boolean;
  // Populated after finalization:
  author_response: string;
  action_taken: string;
  manuscript_changes: string;
}

export interface CommentChangeSuggestion {
  reviewer_number: number;
  comment_number: number;
  original_comment: string;
  interpretation: string;
  action_type: 'clarify' | 'add_citation' | 'add_analysis' | 'reframe_claim' | 'rewrite_text' | 'rebuttal' | 'no_change' | 'other';
  target_section: string;
  target_line_hint: string;
  copy_paste_text: string;
  citation_needed: boolean;
  citation_suggestions: string[];
  evidence_check_status: 'supported' | 'unsupported' | 'needs_external_evidence' | 'needs_new_experiment' | 'unclear';
  response_snippet: string;
  ambiguity_flag: boolean;
  ambiguity_question: string;
}

// ── Journal style ──────────────────────────────────────────────────────────────

export type CitationStyleValue =
  | 'vancouver' | 'nlm' | 'ama' | 'nature' | 'cell'
  | 'apa' | 'harvard' | 'science' | 'ieee' | 'default';

export interface JournalStyle {
  journal_name: string;
  citation_style: CitationStyleValue;
  in_text_format: string;           // "numbered" | "superscript" | "author_year"
  reference_sort_order: string;     // "order_of_appearance" | "alphabetical"
  accepted_article_types: string[];
  max_references: number | null;
  abstract_structure: string | null;
  abstract_word_limit: number | null;
  word_limits: Record<string, number | null>;
  sections_by_type: Record<string, string[]>;
  reference_format_name: string;
  source: string;                   // "curated" | "publisher_default" | "llm" | "default_fallback"
  confidence: number;               // 0.5 – 1.0
}

export interface JournalRecommendation {
  name: string;
  publisher: string | null;
  issn: string | null;
  frequency_in_results: number;
  open_access: boolean | null;
  h_index: number | null;
  avg_citations: number | null;   // 2-yr mean citedness ≈ Impact Factor proxy
  scope_match: string | null;
  openalex_url: string | null;
  website_url: string | null;
  // Enriched metadata
  indexed_pubmed: boolean | null;
  indexed_scopus: boolean | null;
  apc_usd: number | null;
  apc_note: string | null;
  onos_supported: boolean | null;
}

export interface CitationPoint {
  paper_title: string;
  doi: string | null;
  relevance: string;
}

export interface CriticalSummary {
  core_points: string[];
  new_data_explained: string[];
  cross_references: CitationPoint[];
}

// ── 3-Pass Evidence Extraction Types ──────────────────────────────────────────

export interface EvidenceQuote {
  claim_id: string;
  quote: string;
  page: number | null;
  section: string;
}

export interface Triage {
  category: string;
  context: string;
  correctness_flags: string[];
  contributions: string[];
  clarity_score_1_5: number;
  decision: 'include' | 'exclude' | 'maybe';
  decision_reason: string;
}

export interface PaperBibliography {
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  doi: string | null;
  pmid: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
}

export interface ExtractionMethods {
  study_design: string;
  setting: string;
  sample_n: string;
  inclusion_criteria: string;
  exclusion_criteria: string;
  variables_independent: string[];
  variables_dependent: string[];
  variables_covariates: string[];
  intervention_or_exposure: string;
  comparator: string;
  primary_outcomes: string[];
  secondary_outcomes: string[];
  statistical_methods: string[];
  funding: string;
  conflicts_of_interest: string;
  preregistration: string;
}

export interface ResultItem {
  outcome: string;
  finding: string;
  effect_size: string;
  ci_95: string;
  p_value: string;
  supporting_quote: string;
  claim_type: 'reported_fact' | 'author_interpretation' | 'inference';
}

export interface ExtractionCriticalAppraisal {
  selection_bias: string;
  measurement_bias: string;
  confounding: string;
  attrition: string;
  other_internal_validity_risks: string[];
  external_validity: string;
  methodological_strengths: string[];
  reproducibility_signals: string[];
  evidence_grade: 'High' | 'Moderate' | 'Low' | 'Very Low';
  evidence_grade_justification: string;
}

export interface ConfidenceScore {
  overall: number;
  notes: string;
}

// ── Cross-Reference Extraction Types ──────────────────────────────────────────

export interface CitedReference {
  ref_id: string;
  doi: string | null;
  title: string | null;
  authors: string[];
  year: number | null;
  journal: string | null;
  raw_text: string;
}

export interface IntroductionClaim {
  claim: string;
  verbatim_quote: string;
  cited_ref_ids: string[];
  claim_type: 'reported_fact' | 'author_assertion';
}

export interface DiscussionInsight {
  insight_type: 'comparison' | 'limitation' | 'implication' | 'future_direction';
  text: string;
  verbatim_quote: string;
  cited_ref_ids: string[];
}

// ── Cross-paper Synthesis Types ────────────────────────────────────────────────

export interface EvidenceClaim {
  claim: string;
  supporting_papers: string[];
  contradicting_papers: string[];
  study_designs: string[];
  strength_score: number;
  consistency: 'high' | 'moderate' | 'low' | 'mixed' | 'unknown';
}

export interface MethodsComparisonRow {
  paper_key: string;
  sample_n: string;
  tools: string[];
  outcomes: string[];
  stats: string[];
  risk_of_bias: string;
}

export interface Contradiction {
  topic: string;
  papers_a: string[];
  papers_b: string[];
  finding_a: string;
  finding_b: string;
  likely_reason: string;
}

export interface FactBankEntry {
  fact: string;
  paper_key: string;
  verbatim_quote: string;
  claim_type: 'reported_fact' | 'author_interpretation';
}

export interface SynthesisResult {
  evidence_matrix: EvidenceClaim[];
  methods_comparison: MethodsComparisonRow[];
  contradictions: Contradiction[];
  gaps: string[];
  fact_bank: FactBankEntry[];
}

// ── Peer Review Types ──────────────────────────────────────────────────────────

export interface ReviewConcern {
  concern: string;
  evidence_ids: string[];
  paper_ids: string[];
  scientific_importance: string;
  revision_request: string;
}

export interface PeerReviewReport {
  manuscript_summary: string;
  major_concerns: ReviewConcern[];
  minor_concerns: ReviewConcern[];
  required_revisions: string[];
  decision: 'accept' | 'minor_revision' | 'major_revision' | 'reject';
  decision_rationale: string;
}

export interface RevisionResult {
  revised_article: string;
  point_by_point_reply: string;
}

export interface PaperSummary {
  paper_key: string;
  full_text_used: boolean;
  text_source: 'pmc_xml' | 'full_pdf' | 'abstract_only' | 'none';

  // 3-pass extraction
  triage: Triage;
  bibliography: PaperBibliography;
  methods: ExtractionMethods;
  results: ResultItem[];
  limitations: string[];
  critical_appraisal: ExtractionCriticalAppraisal;
  evidence_quotes: EvidenceQuote[];
  missing_info: string[];
  confidence: ConfidenceScore;

  // Convenience / synthesis fields
  one_line_takeaway: string;
  keywords: string[];

  // Cross-reference depth tracking
  depth?: number;
  cited_by_keys?: string[];

  // Intro/Discussion extraction (populated when full_text_used=true)
  introduction_claims?: IntroductionClaim[];
  discussion_insights?: DiscussionInsight[];
  cited_references?: CitedReference[];
}
