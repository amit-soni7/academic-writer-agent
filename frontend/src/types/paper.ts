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
  project_type?: 'write' | 'revision' | 'systematic_review' | null;
  sr_current_stage?: string | null;
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

export interface RevisionRoundSummary {
  round_number: number;
  journal_name: string;
  comment_count: number;
  created_at: string;
  has_revised_article: boolean;
  has_point_by_point_docx: boolean;
  has_revised_manuscript_docx: boolean;
  has_track_changes_docx: boolean;
  has_revised_pdf: boolean;
  docs_ready: boolean;
}

export interface ImportManuscriptResult {
  word_count: number;
  sections_found: string[];
  references_found: number;
  manuscript_summary: string;
  prepared_docx?: boolean;
  reference_pdf_ready?: boolean;
  reference_pdf_warning?: string;
}

// ── Editorial review types ────────────────────────────────────────────────────

export interface EditorialSuggestion {
  category: string;   // completeness | quality | consistency | over_edit | under_edit | language | structure | references
  severity: string;   // critical | important | minor
  location: string;
  finding: string;
  suggestion: string;
}

export interface EditorialReviewResult {
  editor_decision: string;   // accept | minor_revision | major_revision
  overall_assessment: string;
  suggestions: EditorialSuggestion[];
  praise: string[];
  remaining_concerns: string[];
  blocking_issues: string[];
  advisory_issues: string[];
}

export interface EditorialReviewRequest {
  round_number?: number;
  journal_name?: string;
  revised_manuscript?: string;
  reviewer_comments?: RealReviewerComment[];
  author_responses?: ReviewCommentResponse[];
  finalized_plans?: CommentPlan[];
}

export interface RevisionAgentLedgerItem {
  item_id: string;
  source: string;
  severity: string;
  message: string;
  round_number: number;
  resolved: boolean;
  justification: string;
}

export interface RevisionAgentExportReadiness {
  manuscript_markdown_ready: boolean;
  manuscript_docx_ready: boolean;
  manuscript_pdf_ready?: boolean | null;
  response_markdown_ready: boolean;
  response_docx_ready: boolean;
  all_required_ready: boolean;
}

export interface RevisionAgentQaMetrics {
  invalid_qa_findings: number;
  discarded_blockers: number;
  merged_repair_groups: number;
  structural_repair_invocations: number;
}

export interface RevisionRepairTelemetry {
  invalid_qa_findings: number;
  discarded_blockers: number;
  merged_repair_groups: number;
  structural_repair_invocations: number;
}

export interface RevisionAgentStatus {
  status: string;
  stage: string;
  current_round: number;
  blocking_issue_count: number;
  advisory_issue_count: number;
  final_response_ready: boolean;
  export_readiness: RevisionAgentExportReadiness;
  completed_reason: string;
  ledger_entries: RevisionAgentLedgerItem[];
  stop_requested: boolean;
  last_error: string;
  action_map?: RevisionActionMap | null;
  revision?: RevisionResult | null;
  consistency_audit?: ConsistencyAuditResult | null;
  re_review?: ReReviewResult | null;
  editorial_review?: EditorialReviewResult | null;
  baseline_article?: string;
  last_known_good_article?: string;
  qa_metrics: RevisionAgentQaMetrics;
  user_guidance?: string;
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
  evidence_grade: 'High' | 'Moderate' | 'Low' | 'Very Low' | 'NR';
  evidence_grade_justification: string;
}

export interface ConfidenceScore {
  overall: number;
  notes: string;
}

export interface WritingEvidenceMeta {
  selected_count: number;
  max_count: number;
  dominant_sections: string[];
  limiting_factors: string[];
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

export type CitationPurpose =
  | 'background'
  | 'theory'
  | 'identify_gap'
  | 'justify_study'
  | 'methodology'
  | 'original_source'
  | 'compare_findings'
  | 'empirical_support'
  | 'prevalence_epidemiology'
  | 'support_claim'
  | 'limitation_acknowledged'
  | 'definition_terminology'
  | 'clinical_guideline'
  | 'population_context'
  | 'measurement_validation'
  | 'future_direction';

export interface SentenceCitation {
  section: 'background' | 'methods' | 'results' | 'discussion' | 'conclusion';
  text: string;
  verbatim_quote: string;
  claim_type: 'reported_fact' | 'author_interpretation' | 'inference';
  stats: string;
  importance: 'high' | 'medium';
  use_in: 'introduction' | 'methods' | 'results' | 'discussion';
  source_kind: 'paper_text' | 'cited_reference_claim';
  cited_ref_ids: string[];
  // Citation purpose fields
  primary_purpose?: CitationPurpose | '';
  secondary_purposes?: CitationPurpose[];
  compare_sentiment?: 'consistent' | 'contradicts' | null;
  evidence_type?: string | null;
  is_seminal?: boolean;
  recency_score?: number | null;
  relevance_score?: number | null;
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
  manuscript_packs?: ManuscriptPack | null;
}

// ── Manuscript Packs ──────────────────────────────────────────────────────────

export interface ThemeCluster {
  theme_label: string;
  paper_keys: string[];
  sentences: Record<string, unknown>[];
  evidence_claims: Record<string, unknown>[];
  contradictions: Record<string, unknown>[];
  gaps: string[];
}

export interface SectionPack {
  section_name: string;
  theme_clusters: ThemeCluster[];
  narrative_arc: string;
  key_citations: string[];
}

export interface ManuscriptPack {
  section_packs: Record<string, SectionPack>;
  central_argument: string;
  evidence_strength_summary: string;
}

// ── Deep Synthesis Types ──────────────────────────────────────────────────────

export interface NormalizedClaim {
  claim_id: string;
  canonical_text: string;
  source_paper_keys: string[];
  population: string;
  outcome: string;
  effect_direction: 'positive' | 'negative' | 'null' | 'mixed';
  effect_magnitude: string;
  evidence_grade: string;
  verbatim_quotes: string[];
}

export interface ContradictionDetail {
  dimension: 'population' | 'method' | 'measurement' | 'timeframe' | 'context';
  description: string;
  papers_a: string[];
  papers_b: string[];
  resolution_hypothesis: string;
}

export interface ClaimCluster {
  cluster_id: string;
  cluster_label: string;
  claims: NormalizedClaim[];
  synthesis_statement: string;
  overall_direction: 'consistent' | 'mixed' | 'contradictory';
  strength: number;
  contradiction_details: ContradictionDetail[];
}

export interface TheoryReference {
  theory_name: string;
  seminal_paper_keys: string[];
  applying_paper_keys: string[];
  support_level: 'strong' | 'moderate' | 'weak' | 'mixed';
  description: string;
}

export interface AutoFetchResult {
  thin_claims_detected: number;
  queries_generated: string[];
  papers_found: number;
  papers_summarized: number;
  new_paper_keys: string[];
  skipped_duplicate: number;
}

export interface DeepSynthesisResult {
  normalized_claims: NormalizedClaim[];
  claim_clusters: ClaimCluster[];
  theory_map: TheoryReference[];
  manuscript_packs: ManuscriptPack;
  auto_fetch_result?: AutoFetchResult | null;
  pipeline_version: string;
  stages_completed: string[];
  warnings?: { stage: string; error_type: string; message: string }[];
}

export interface LLMErrorResponse {
  error_type: 'rate_limit' | 'quota_exhausted' | 'auth' | 'billing' | 'server' | 'connection' | 'bad_request' | 'unknown';
  message: string;
  provider: string;
  model: string;
  status_code?: number | null;
  is_transient: boolean;
  retry_after?: number | null;
}

export interface DeepSynthesisSSEEvent {
  type: 'stage_start' | 'stage_complete' | 'complete' | 'progress' | 'warning' | 'error' | 'auto_fetch_start' | 'auto_fetch_searching' | 'auto_fetch_complete';
  stage?: number;
  stage_name?: string;
  message?: string;
  detail?: Record<string, unknown>;
  error?: LLMErrorResponse;
  result?: DeepSynthesisResult;
  summary?: Record<string, unknown>;
  stages_completed?: string[];
}

// ── Peer Review Types ──────────────────────────────────────────────────────────

export interface ReviewConcern {
  concern: string;
  basis?: 'manuscript_only' | 'evidence_only' | 'both';
  location?: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence_ids: string[];
  paper_ids: string[];
  scientific_importance: string;
  revision_request: string;
  severity?: 'high' | 'medium';
  problem_type?: 'conceptual' | 'evidentiary' | 'methodological' | 'structural' | 'rhetorical' | 'journal_fit';
  resolvable?: boolean;
  satisfaction_criterion?: string;
}

export interface SectionAssessment {
  section: string;
  rating: 'strong' | 'adequate' | 'weak' | 'missing';
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  revision_advice?: string;
}

export interface RubricScore {
  dimension: string;
  score: number; // 1-5
  rationale: string;
}

export interface ClaimAuditItem {
  claim: string;
  location: string;
  problem: 'overgeneralized' | 'under-supported' | 'imprecise' | 'historically under-specified' | 'overclaimed';
  fix: 'supported' | 'narrowed' | 'rephrased' | 'defined' | 'removed';
  explanation: string;
}

export interface PeerReviewReport {
  manuscript_summary: string;
  reviewer_expertise?: string[];
  strengths?: string[];
  section_assessments?: SectionAssessment[];
  major_concerns: ReviewConcern[];
  minor_concerns: ReviewConcern[];
  claims_audit?: ClaimAuditItem[];
  rubric_scores?: RubricScore[];
  revision_priorities?: string[];
  required_revisions: string[];
  decision: 'accept' | 'minor_revision' | 'major_revision' | 'reject';
  decision_rationale: string;
  editor_note?: string;
}

// ── Revision Action Map ─────────────────────────────────────────────────────

export interface RevisionAction {
  reviewer_comment_id: string;
  disposition: 'accept' | 'partially_accept' | 'decline' | 'already_addressed' | 'editorial_optional' | string;
  concern_title: string;
  severity: 'high' | 'medium' | 'low';
  manuscript_location: string;
  action_type: string;
  revision_instruction: string;
  target_section: string;
  estimated_edit_size: 'sentence' | 'paragraph' | 'multi_paragraph';
  has_dependency: boolean;
  verification_criterion: string;
}

export interface RevisionActionMap {
  actions: RevisionAction[];
  total_actions: number;
  accepted_count: number;
  declined_count: number;
  partially_accepted: number;
}

export interface RevisionResult {
  revised_article: string;
  point_by_point_reply: string;
  response_data?: Record<string, unknown>;  // structured per-comment response data for docx generation
  action_map?: RevisionActionMap;
  audit?: {
    warnings: string[];
    stats: Record<string, unknown>;
    passed: boolean;
  };
  applied_changes?: number;
  failed_changes?: number;
  change_justifications?: string[];
  response_qc?: ResponseQCResult;
  repair_telemetry?: RevisionRepairTelemetry;
}

// ── Consistency Audit ───────────────────────────────────────────────────────

export interface AuditCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface ConsistencyAuditResult {
  checks: AuditCheck[];
  all_passed: boolean;
  unresolved_concerns: string[];
  new_issues: string[];
  blocking_issues: string[];
  advisory_issues: string[];
  summary: string;
}

// ── Re-review ───────────────────────────────────────────────────────────────

export interface ConcernResolution {
  concern_id: string;
  original_concern: string;
  status: 'resolved' | 'partially_resolved' | 'unresolved';
  explanation: string;
  response_accurate: boolean;
  overstatements: string[];
}

export interface ReReviewResult {
  concern_resolutions: ConcernResolution[];
  new_issues: string[];
  updated_recommendation: 'accept' | 'minor_revision' | 'major_revision' | 'reject';
  remaining_issues: string[];
  needs_another_round: boolean;
  blocking_issues: string[];
  advisory_issues: string[];
  summary: string;
}

export interface ResponseQCResult {
  checked: boolean;
  blocking_issues: string[];
  advisory_issues: string[];
  summary: string;
}

export interface PaperSummary {
  paper_key: string;
  full_text_used: boolean;
  text_source: 'pmc_xml' | 'full_pdf' | 'full_html' | 'abstract_only' | 'none';

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

  // Citation purpose profile
  purpose_profile?: Record<string, number>;
  recommended_sections?: string[];
  is_seminal?: boolean;
  evidence_type?: string | null;
  study_design?: string | null;
  evidence_weight?: 'strong' | 'moderate' | 'weak' | 'unknown' | null;
  recency_score?: number | null;

  // Intro/Discussion extraction (populated when full_text_used=true)
  introduction_claims?: IntroductionClaim[];
  discussion_insights?: DiscussionInsight[];
  cited_references?: CitedReference[];
  sentence_bank?: SentenceCitation[];
  writing_evidence_meta?: WritingEvidenceMeta;
}

// ── Visual recommendations ──────────────────────────────────────────────────

export interface GeneratedVisual {
  image_url: string | null;
  pdf_url: string | null;
  table_html: string | null;
  table_data: { headers: string[]; rows: string[][]; footnotes: string[] } | null;
  caption: string;
  source_code: string;
  style_preset: string;
  candidate_id?: string | null;
  score?: CandidateScore | null;
}

export interface IllustrationStyleControls {
  palette?: string | null;
  background: string;
  transparent_background: boolean;
}

export type VisualStatus =
  | 'recommended'
  | 'generating'
  | 'generated'
  | 'editing'
  | 'finalized'
  | 'dismissed';

export type VisualPriority = 'essential' | 'recommended' | 'optional';

export interface VisualItem {
  id: string;                          // "T1", "T2", "F1", "F2"
  type: 'table' | 'figure';
  title: string;
  target_section: string;
  insert_after: string;                // "after_paragraph:12" | "after_heading:results"
  purpose: string;
  data_to_include: string[];
  suggested_structure: string[];
  priority: VisualPriority;
  supplementary: boolean;
  alternative_format: 'table' | 'figure' | null;
  reporting_guideline: string | null;
  render_mode: 'table' | 'matplotlib' | 'ai_illustration';
  image_backend?: 'openai' | 'gemini_imagen' | null;
  output_mode?: 'full_figure' | 'asset_pack' | 'composition_reference' | 'transparent_asset';
  category?: 'psychology' | 'neuroscience' | 'medical' | 'cell_bio' | 'technical' | 'generic' | null;
  status: VisualStatus;
  citation_text: string;
  insert_citation_after: string;
  generated: GeneratedVisual | null;
  figure_brief?: FigureBrief | null;
  prompt_package?: PromptPackage | null;
  editable_prompt?: string | null;
  style_controls?: IllustrationStyleControls | null;
  candidates?: IllustrationCandidate[];
}

export interface VisualRecommendations {
  summary: string;
  empty_reason: string | null;
  items: VisualItem[];
}

export interface VisualEditMessage {
  role: 'user' | 'assistant';
  content: string;
  rendered_output?: {
    image_url?: string;
    table_html?: string;
  } | null;
  timestamp: string;
}

export interface PanelPlan {
  id: string;
  title?: string | null;
  goal: string;
  main_subjects: string[];
  secondary_subjects?: string[];
  arrows?: Array<Record<string, unknown>>;
  inset?: Record<string, unknown> | null;
  layout_notes: string[];
  draw_instructions?: string[];
}

export interface FigureBrief {
  title: string;
  figure_type: string;
  category: 'psychology' | 'neuroscience' | 'medical' | 'cell_bio' | 'technical' | 'generic';
  purpose: string;
  key_message: string;
  panel_count: number;
  panel_plan: PanelPlan[];
  must_include: string[];
  must_avoid: string[];
  output_context: 'graphical_abstract' | 'visual_abstract' | 'journal_figure' | 'cover_art' | 'supplementary' | string;
  labels_needed: boolean;
  text_in_image_allowed: boolean;
  accessibility_mode: boolean;
  transparent_background: boolean;
  discipline: string;
  audience: string;
  output_mode: 'full_figure' | 'asset_pack' | 'composition_reference' | 'transparent_asset' | string;
  aspect_ratio: string;
  target_journal_style: string;
  reference_images: string[];
  category_override?: string | null;
}

export interface PromptPackage {
  system_intent: string;
  layer1_content: string;
  layer2_style: string;
  layer3_composition: string;
  layer4_negative: string;
  layer5_output_purpose: string;
  final_prompt: string;
}

export interface CandidateScore {
  message_clarity: 1 | 2 | 3 | 4 | 5;
  hierarchy: 1 | 2 | 3 | 4 | 5;
  plausibility: 1 | 2 | 3 | 4 | 5;
  composition: 1 | 2 | 3 | 4 | 5;
  accessibility: 1 | 2 | 3 | 4 | 5;
  publication_fit: 1 | 2 | 3 | 4 | 5;
  text_risk: 1 | 2 | 3 | 4 | 5;
  category_style_fit: 1 | 2 | 3 | 4 | 5;
  overall: number;
  notes: string[];
  rejected: boolean;
}

export interface IllustrationCandidate {
  id: string;
  image_url: string | null;
  file_path?: string | null;
  prompt: string;
  backend: 'openai' | 'gemini_imagen' | string;
  model: string;
  output_format: string;
  background: string;
  quality: string;
  output_mode: string;
  prompt_package?: PromptPackage | null;
  score?: CandidateScore | null;
  notes?: string[];
}

export interface FigureBuilderRequest {
  title: string;
  article_type?: string;
  discipline: string;
  figure_type: string;
  purpose: string;
  target_journal_style?: string;
  audience?: string;
  key_message: string;
  panel_count: number;
  panels: Array<Record<string, unknown>>;
  must_include: string[];
  must_avoid: string[];
  labels_needed: boolean;
  text_in_image_allowed: boolean;
  background: string;
  transparent_background: boolean;
  aspect_ratio: string;
  output_context: string;
  accessibility_mode: boolean;
  reference_images: string[];
  category_override?: string | null;
  image_backend?: 'openai' | 'gemini_imagen' | string;
  candidate_count?: number;
  output_mode?: string;
}

export interface FigureBuilderGenerateResponse {
  brief: FigureBrief;
  prompt_package: PromptPackage;
  candidates: IllustrationCandidate[];
}

// ── Citation status (reference sidebar) ─────────────────────────────────────

export interface CitationEntry {
  cited_key: string;
  resolved_key: string | null;
  ref_number: number | null;
  status: 'resolved' | 'fuzzy_matched' | 'unresolved';
  match_method: string | null;
  occurrences: number;
  first_section: string;
  bibliography: PaperBibliography | null;
}

export interface CitationStatusSummary {
  total: number;
  resolved: number;
  fuzzy_matched: number;
  unresolved: number;
  uncited_count: number;
  uncited_keys: string[];
}

export interface CitationStatusResponse {
  citations: CitationEntry[];
  summary: CitationStatusSummary;
}
