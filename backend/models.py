from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ── Journal style ───────────────────────────────────────────────────────────────

class CitationStyleEnum(str, Enum):
    vancouver = "vancouver"
    nlm       = "nlm"
    ama       = "ama"
    nature    = "nature"
    cell      = "cell"
    apa       = "apa"
    harvard   = "harvard"
    science   = "science"
    ieee      = "ieee"
    default   = "default"


class JournalStyleResponse(BaseModel):
    journal_name: str
    citation_style: str
    in_text_format: str
    reference_sort_order: str
    accepted_article_types: list[str] = []
    max_references: Optional[int] = None
    abstract_structure: Optional[str] = None
    abstract_word_limit: Optional[int] = None
    word_limits: dict[str, Optional[int]] = {}
    sections_by_type: dict[str, list[str]] = {}
    reference_format_name: str
    source: str
    confidence: float


class WritingType(str, Enum):
    original_research   = "original_research"
    systematic_review   = "systematic_review"
    narrative_review    = "narrative_review"
    scoping_review      = "scoping_review"
    review              = "review"               # generic / legacy alias
    meta_analysis       = "meta_analysis"
    case_report         = "case_report"
    short_communication = "short_communication"
    brief_report        = "brief_report"
    editorial           = "editorial"
    letter              = "letter"
    opinion             = "opinion"


class ArticleMode(str, Enum):
    novel = "novel"
    revision = "revision"


class IntentRequest(BaseModel):
    mode: ArticleMode = Field(
        ...,
        description="Whether this is a novel submission or a revision of existing work.",
    )
    writing_type: WritingType = Field(
        ...,
        description="The category of academic article being produced.",
    )
    key_idea: str = Field(
        ...,
        min_length=10,
        description="A concise statement of the central argument or research question.",
    )
    target_journal: Optional[str] = Field(
        default=None,
        description="Optional target journal name for formatting hints.",
    )


class IntentResponse(BaseModel):
    status: str
    message: str
    received: IntentRequest


# ── Literature search ──────────────────────────────────────────────────────────

class Paper(BaseModel):
    title: str
    authors: list[str] = []
    abstract: Optional[str] = None
    doi: Optional[str] = None
    pmid: Optional[str] = None
    pmcid: Optional[str] = None
    year: Optional[int] = None
    journal: Optional[str] = None
    citation_count: Optional[int] = None
    oa_pdf_url: Optional[str] = None
    source: str  # "pubmed" | "pmc" | "openalex" | "semantic_scholar" | "crossref"


# ── AI provider config ─────────────────────────────────────────────────────────

class AIProviderConfig(BaseModel):
    provider: str = Field(default="openai", description="openai | gemini | claude | ollama")
    model: str = Field(default="gpt-4o-mini")
    api_key: str = Field(default="")
    base_url: Optional[str] = Field(default=None, description="Custom base URL (Ollama only)")
    has_api_key: bool = Field(default=False, description="True when a key is stored server-side (masked in responses)")
    # ── PDF persistence settings ───────────────────────────────────────────────
    pdf_save_enabled: bool = Field(default=False, description="Save downloaded PDFs to disk")
    pdf_save_path: Optional[str] = Field(default=None, description="Directory path for saved PDFs and BibTeX")
    # ── Sci-Hub settings ───────────────────────────────────────────────────────
    sci_hub_enabled: bool = Field(default=False, description="Use Sci-Hub as last-resort full-text source")
    http_proxy: Optional[str] = Field(default=None, description="HTTP proxy URL for Sci-Hub requests (e.g. http://proxy.uni.edu:8080)")
    # ── OAuth (not persisted; populated at runtime for OAuth-connected providers) ──
    gemini_oauth_access_token: Optional[str] = Field(default=None, exclude=True, description="Runtime-only: valid OAuth access token for Gemini (not stored in DB)")


class ProviderConfigEntry(BaseModel):
    auth_method: str = Field(default="api_key", description="api_key | oauth")
    api_key: str = Field(default="")
    has_api_key: bool = Field(default=False)
    model: Optional[str] = Field(default=None)
    base_url: Optional[str] = Field(default=None)
    oauth_connected: bool = Field(default=False)


class AppSettingsResponse(AIProviderConfig):
    provider_configs: dict[str, ProviderConfigEntry] = Field(default_factory=dict)


class AppSettingsUpdateRequest(AIProviderConfig):
    provider_configs: dict[str, ProviderConfigEntry] = Field(default_factory=dict)


class RevealApiKeyRequest(BaseModel):
    provider: str


class RevealApiKeyResponse(BaseModel):
    provider: str
    api_key: str = ""


class ProviderModelsRequest(BaseModel):
    provider: str
    api_key: str = ""
    base_url: Optional[str] = None


class ModelOption(BaseModel):
    value: str
    label: str


class ProviderModelsResponse(BaseModel):
    provider: str
    source: str = "fallback"
    models: list[ModelOption] = Field(default_factory=list)


# ── Search ─────────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=3, description="Search query derived from the user's key idea.")
    max_results_per_source: int = Field(default=5, ge=1, le=20)  # legacy simple search


class StreamSearchRequest(BaseModel):
    query: str = Field(..., min_length=3)
    total_limit: int = Field(default=50, ge=10, le=10_000, description="Total papers wanted across all sources.")
    use_ai_expansion: bool = Field(default=True)
    article_type: Optional[str] = Field(default=None, description="Article type hint for framework selection (e.g. systematic_review, original_research)")


class SearchResponse(BaseModel):
    papers: list[Paper]
    total: int
    sources_queried: list[str]


# ── Critical summary ───────────────────────────────────────────────────────────

class SummaryRequest(BaseModel):
    papers: list[Paper]
    key_idea: Optional[str] = None


class CitationPoint(BaseModel):
    paper_title: str
    doi: Optional[str] = None
    relevance: str


class CriticalSummary(BaseModel):
    core_points: list[str]
    new_data_explained: list[str]
    cross_references: list[CitationPoint]


# ── Project management ─────────────────────────────────────────────────────────

class ProjectMeta(BaseModel):
    project_id: str
    query: str
    created_at: str
    updated_at: str
    paper_count: int
    summary_count: int
    has_journals: bool
    has_article: bool
    manuscript_title: Optional[str] = None
    article_type: Optional[str] = None
    project_name: Optional[str] = None
    project_description: Optional[str] = None
    project_folder: Optional[str] = None
    current_phase: Optional[str] = 'intake'
    project_type: Optional[str] = 'write'   # 'write' | 'revision'


# Backward-compat alias (used in tests and legacy code)
SessionMeta = ProjectMeta


class CreateProjectRequest(BaseModel):
    query: str
    papers: list[Paper]
    article_type: Optional[str] = None
    project_description: Optional[str] = None
    project_name: Optional[str] = None   # tentative title slug from search strategy
    project_type: Optional[str] = 'write'  # 'write' | 'revision'


# Backward-compat alias
CreateSessionRequest = CreateProjectRequest


class SummarizeAllRequest(BaseModel):
    query: str
    papers: list[Paper]
    skip_excluded: bool = True   # skip papers with screening decision=exclude


class ScreenPapersRequest(BaseModel):
    papers: list[Paper]
    query: str


class ScreeningDecision(BaseModel):
    paper_key: str
    decision: str   # include | exclude | uncertain
    reason: str


class OverrideScreeningRequest(BaseModel):
    decision: str   # include | exclude | uncertain


# ── Journal recommendation ─────────────────────────────────────────────────────

class JournalRecommendation(BaseModel):
    name: str
    publisher: Optional[str] = None
    issn: Optional[str] = None
    frequency_in_results: int = 0          # 0 = AI-suggested, not in results
    open_access: Optional[bool] = None
    h_index: Optional[int] = None
    avg_citations: Optional[float] = None  # 2-year mean citedness (OpenAlex) ≈ Impact Factor proxy
    scope_match: Optional[str] = None      # LLM-generated relevance note
    openalex_url: Optional[str] = None
    website_url: Optional[str] = None      # direct journal homepage when available
    # ── Enriched metadata ─────────────────────────────────────────────────────
    indexed_pubmed: Optional[bool] = None  # NLM catalog lookup
    indexed_scopus: Optional[bool] = None  # Scopus (requires API key; None = unknown)
    apc_usd: Optional[int] = None          # APC in USD from OpenAlex (0 = free)
    apc_note: Optional[str] = None         # e.g. "Waived via ONOS"
    onos_supported: Optional[bool] = None  # Listed in ONOS APC support programme


# ── Title quality policy ───────────────────────────────────────────────────────

class TitleCandidate(BaseModel):
    title: str
    rationale: str


class TitleSuggestions(BaseModel):
    best_title: str
    best_title_rationale: str
    alternatives: list[TitleCandidate]
    quality_notes: str = ""


class GenerateTitleRequest(BaseModel):
    article_type: str = Field(default="review", description="review | original_research | meta_analysis")
    selected_journal: str = Field(default="")


class ApproveTitleRequest(BaseModel):
    title: str = Field(..., min_length=5, description="The approved manuscript title.")


# ── Article writer ─────────────────────────────────────────────────────────────

class WriteArticleRequest(BaseModel):
    session_id: str = Field(default="", description="Deprecated; use project_id in URL")
    project_id: str = Field(default="", description="Project ID (preferred)")
    selected_journal: str
    article_type: str = Field(default="review", description="review | original_research | meta_analysis")
    word_limit: int   = Field(default=4000, ge=500, le=15000)
    max_references: Optional[int] = Field(default=None, ge=5, le=300)


# ── Per-paper evidence extraction ─────────────────────────────────────────────

class SummarizePaperRequest(BaseModel):
    paper: Paper
    query: str = Field(default="", description="The user's research question / key idea.")
    session_id: str = Field(default="", description="Deprecated; use project_id.")
    project_id: str = Field(default="", description="Project ID for BibTeX generation.")


class EvidenceQuote(BaseModel):
    """Verbatim quote supporting an extracted claim."""
    claim_id: str = ""
    quote: str    = ""
    page: Optional[int] = None
    section: str  = ""


class Triage(BaseModel):
    """Pass 1 — quick assessment before deep extraction (5 Cs)."""
    category: str             = ""      # RCT, cohort, SR/MA, observational, qualitative …
    context: str              = ""      # field, why this question matters
    correctness_flags: list[str] = []   # methodological assumption flags
    contributions: list[str]     = []   # genuinely new contributions
    clarity_score_1_5: int    = 3
    decision: str             = "maybe" # include | exclude | maybe
    decision_reason: str      = ""


class PaperBibliography(BaseModel):
    """Pass 2 — bibliographic metadata (filled from text when richer than DB record)."""
    title: str           = ""
    authors: list[str]   = []
    year: Optional[int]  = None
    journal: Optional[str] = None
    doi: Optional[str]   = None
    pmid: Optional[str]  = None
    volume: Optional[str] = None
    issue: Optional[str]  = None
    pages: Optional[str]  = None


class ExtractionMethods(BaseModel):
    """Pass 2 — IMRAD methods block."""
    study_design: str              = ""
    setting: str                   = ""
    sample_n: str                  = ""
    inclusion_criteria: str        = ""
    exclusion_criteria: str        = ""
    variables_independent: list[str] = []
    variables_dependent: list[str]   = []
    variables_covariates: list[str]  = []
    intervention_or_exposure: str  = ""
    comparator: str                = ""
    primary_outcomes: list[str]    = []
    secondary_outcomes: list[str]  = []
    statistical_methods: list[str] = []
    funding: str                   = ""
    conflicts_of_interest: str     = ""
    preregistration: str           = ""


class ResultItem(BaseModel):
    """Pass 2 — one extracted outcome/finding with statistics."""
    outcome: str          = ""
    finding: str          = ""
    effect_size: str      = ""   # OR, HR, MD, SMD …
    ci_95: str            = ""   # 95% CI
    p_value: str          = ""
    supporting_quote: str = ""   # verbatim snippet from paper
    claim_type: str       = "reported_fact"  # reported_fact | author_interpretation | inference


class ExtractionCriticalAppraisal(BaseModel):
    """Pass 3 — bias, validity, reproducibility."""
    selection_bias: str               = ""
    measurement_bias: str             = ""
    confounding: str                  = ""
    attrition: str                    = ""
    other_internal_validity_risks: list[str] = []
    external_validity: str            = ""
    methodological_strengths: list[str]  = []
    reproducibility_signals: list[str]   = []   # preregistration, open data, open code
    evidence_grade: str               = ""      # High | Moderate | Low
    evidence_grade_justification: str = ""


class ConfidenceScore(BaseModel):
    overall: float = 0.0   # 0.0–1.0
    notes: str     = ""


class PaperSummary(BaseModel):
    """
    Full 3-pass evidence extraction for one paper.
    Stored as a JSON blob in the summaries table (paper_key is the DB key).
    """
    paper_key: str
    full_text_used: bool = False
    text_source: str     = "abstract_only"   # pmc_xml | full_pdf | abstract_only | none

    # ── Three passes ──────────────────────────────────────────────────────────
    triage:           Triage                   = Field(default_factory=Triage)
    bibliography:     PaperBibliography        = Field(default_factory=PaperBibliography)
    methods:          ExtractionMethods        = Field(default_factory=ExtractionMethods)
    results:          list[ResultItem]         = []
    limitations:      list[str]               = []
    critical_appraisal: ExtractionCriticalAppraisal = Field(default_factory=ExtractionCriticalAppraisal)
    evidence_quotes:  list[EvidenceQuote]      = []
    missing_info:     list[str]               = []
    confidence:       ConfidenceScore          = Field(default_factory=ConfidenceScore)

    # ── Convenience / synthesis fields (also used by article writer) ──────────
    one_line_takeaway: str   = ""
    keywords:          list[str] = []

    # ── Introduction / Discussion extraction + reference list ─────────────────
    introduction_claims:  list[IntroductionClaim] = []
    discussion_insights:  list[DiscussionInsight] = []
    cited_references:     list[CitedReference]    = []  # paper's own reference list

    # ── Sentence bank (flat list of independently citable sentences) ─────────
    sentence_bank: list["SentenceCitation"] = []

    # ── Cross-reference metadata (depth>0 = fetched as a cited paper) ─────────
    depth: int             = 0   # 0=primary, 1=cross-ref depth-1, 2=cross-ref depth-2
    cited_by_keys: list[str] = []  # paper_keys of primary papers that cited this one


# ── Sentence bank ─────────────────────────────────────────────────────────────

class SentenceCitation(BaseModel):
    """One independently citable sentence from any section of a paper."""
    section: str        = ""   # background | methods | results | discussion | conclusion
    text: str           = ""   # paraphrased citable statement (clean, active voice)
    verbatim_quote: str = ""   # exact quote from the paper
    claim_type: str     = "reported_fact"  # reported_fact | author_interpretation | inference
    stats: str          = ""   # optional inline stats e.g. "OR=1.8 [1.2, 2.7] p=0.003"
    importance: str     = "medium"  # high | medium — high = must-cite for the research question
    use_in: str         = ""   # introduction | methods | results | discussion — target manuscript section


# ── Cross-reference & intro/discussion extraction ─────────────────────────────

class CitedReference(BaseModel):
    """One entry from a paper's reference list (JATS-parsed or LLM-extracted)."""
    ref_id: str = ""                 # e.g. "1", "ref12", "r5"
    doi: Optional[str] = None
    title: Optional[str] = None
    authors: list[str] = []
    year: Optional[int] = None
    journal: Optional[str] = None
    raw_text: str = ""               # original citation text as fallback


class IntroductionClaim(BaseModel):
    """A key factual claim extracted from the Introduction section."""
    claim: str = ""
    verbatim_quote: str = ""
    cited_ref_ids: list[str] = []   # e.g. ["1", "5"] — from inline citations [1],[5]
    claim_type: str = "reported_fact"  # reported_fact | author_assertion


class DiscussionInsight(BaseModel):
    """A key insight extracted from the Discussion section."""
    insight_type: str = ""          # comparison | limitation | implication | future_direction
    text: str = ""
    verbatim_quote: str = ""
    cited_ref_ids: list[str] = []


class CrossReferenceRequest(BaseModel):
    depth: int = Field(default=1, ge=1, le=2, description="Expansion depth: 1 or 2 hops")


# ── Cross-paper synthesis ──────────────────────────────────────────────────────

class EvidenceClaim(BaseModel):
    """One synthesised claim mapped to supporting and contradicting papers."""
    claim: str
    supporting_papers:    list[str] = []   # paper_keys
    contradicting_papers: list[str] = []
    study_designs:        list[str] = []
    strength_score: float = 0.0            # 0.0–1.0
    consistency:    str   = "unknown"      # high | moderate | low | mixed


class MethodsComparisonRow(BaseModel):
    paper_key: str
    sample_n:  str        = ""
    tools:     list[str] = []
    outcomes:  list[str] = []
    stats:     list[str] = []
    risk_of_bias: str     = ""


class Contradiction(BaseModel):
    topic:         str        = ""
    papers_a:      list[str] = []   # paper_keys taking position A
    papers_b:      list[str] = []   # paper_keys taking position B
    finding_a:     str        = ""
    finding_b:     str        = ""
    likely_reason: str        = ""


class FactBankEntry(BaseModel):
    """Citation-ready fact with direct quote backing."""
    fact:          str = ""
    paper_key:     str = ""
    verbatim_quote: str = ""
    claim_type:    str = "reported_fact"   # reported_fact | author_interpretation


class SynthesisResult(BaseModel):
    evidence_matrix:    list[EvidenceClaim]        = []
    methods_comparison: list[MethodsComparisonRow] = []
    contradictions:     list[Contradiction]        = []
    gaps:               list[str]                  = []
    fact_bank:          list[FactBankEntry]        = []


# ── Peer review ────────────────────────────────────────────────────────────────

class ReviewConcern(BaseModel):
    concern:              str        = ""
    evidence_ids:         list[str] = []   # evidence_quote claim_ids
    paper_ids:            list[str] = []   # paper_keys
    scientific_importance: str       = ""
    revision_request:     str        = ""


class PeerReviewReport(BaseModel):
    manuscript_summary:  str                 = ""
    major_concerns:      list[ReviewConcern] = []
    minor_concerns:      list[ReviewConcern] = []
    required_revisions:  list[str]           = []
    decision:            str                 = "major_revision"
    decision_rationale:  str                 = ""


class ReviseAfterReviewRequest(BaseModel):
    article: str
    review: PeerReviewReport
    selected_journal: Optional[str] = None


class RevisionResult(BaseModel):
    revised_article: str = ""
    point_by_point_reply: str = ""


# ── Real peer-review revision system ──────────────────────────────────────────

class RealReviewerComment(BaseModel):
    reviewer_number: int        # 1, 2, 3 …
    comment_number: int         # sequential within reviewer
    original_comment: str
    category: str = "major"     # backward-compat alias: major | minor | editorial
    severity: str = "major"     # major | minor | editorial
    domain: str = "other"       # writing | methodology | results | references | ethics | statistics | other
    requirement_level: str = "unclear"  # mandatory | optional | unclear
    ambiguity_flag: bool = False
    ambiguity_question: str = ""
    intent_interpretation: str = ""


class ReviewCommentResponse(BaseModel):
    reviewer_number: int
    comment_number: int
    original_comment: str
    author_response: str        # AI-drafted reply grounded in manuscript content
    action_taken: str           # "Introduction, paragraph 3, Lines 45–52 of revised manuscript"
    manuscript_diff: str = ""   # JSON {"deleted": "...", "added": "..."}


class RevisionRound(BaseModel):
    round_number: int
    journal_name: str = ""
    raw_comments: str = ""
    parsed_comments: list[RealReviewerComment] = []
    responses: list[ReviewCommentResponse] = []
    revised_article: str = ""
    point_by_point_md: str = ""
    created_at: str = ""


class ImportManuscriptResult(BaseModel):
    word_count: int
    sections_found: list[str]
    references_found: int
    manuscript_summary: str


class ParseCommentsRequest(BaseModel):
    raw_comments: str
    journal_name: str = ""
    round_number: int = 1


class GenerateRealRevisionRequest(BaseModel):
    round_number: int
    parsed_comments: list[RealReviewerComment]
    journal_name: str = ""


class DiscussCommentRequest(BaseModel):
    original_comment: str
    reviewer_number: int
    comment_number: int
    user_message: str
    history: list[dict] = []        # [{role: "ai"|"user", content: str}]
    current_plan: str = ""
    doi_references: list[str] = []  # raw DOI strings; backend fetches metadata
    manuscript_text: str = ""       # numbered manuscript for context
    finalized_context: list[dict] = []  # finalized prior comments to avoid redundant edits


class FinalizeCommentRequest(BaseModel):
    original_comment: str
    reviewer_number: int
    comment_number: int
    finalized_plan: str
    manuscript_text: str = ""


class GenerateFromPlansRequest(BaseModel):
    round_number: int
    journal_name: str = ""
    finalized_plans: list[dict]     # list of serialized CommentPlan objects


class SuggestChangesRequest(BaseModel):
    manuscript_text: str = ""
    journal_name: str = ""
    parsed_comments: list[RealReviewerComment] = []


class CommentChangeSuggestion(BaseModel):
    reviewer_number: int
    comment_number: int
    original_comment: str
    interpretation: str = ""
    action_type: str = "other"  # clarify|add_citation|add_analysis|reframe_claim|rewrite_text|rebuttal|no_change|other
    target_section: str = ""
    target_line_hint: str = ""
    copy_paste_text: str = ""
    citation_needed: bool = False
    citation_suggestions: list[str] = []
    evidence_check_status: str = "unclear"  # supported|unsupported|needs_external_evidence|needs_new_experiment|unclear
    response_snippet: str = ""
    ambiguity_flag: bool = False
    ambiguity_question: str = ""
