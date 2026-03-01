"""
services/article_builder.py

Pure-function helpers for building article generation prompts.
Extracted from routers/sessions.py to be testable without a FastAPI dependency.

Public API
----------
build_article_prompt(session, article_type, selected_journal, word_limit,
                     journal_style, manuscript_title, base_system)
    → (system_prompt: str, user_message: str)

build_summary_block(summaries)
    → str

ARTICLE_SECTIONS
    dict[str, list[str]] — default sections per article type
"""

from __future__ import annotations

from services.journal_style_service import JournalStyle, build_article_system_prompt
from services.writing_guidelines import get_guidelines_for_sections, get_article_type_guidelines

# ── Default sections per article type ─────────────────────────────────────────
# Journal-specific sections always take priority; these are used as fallback.
# Subsection hints are embedded in the section name so the LLM knows exactly
# what to cover without requiring separate parsing.

ARTICLE_SECTIONS: dict[str, list[str]] = {

    # ── Primary research ──────────────────────────────────────────────────────
    "original_research": [
        "Abstract",
        "Introduction",
        "Methods",
        "Results",
        "Discussion",
        "Conclusions",
        "References",
    ],

    # ── Systematic review (PRISMA 2020) ───────────────────────────────────────
    "systematic_review": [
        "Abstract (structured: Background, Objectives, Methods, Results, Conclusions)",
        "Introduction (rationale, objectives, PICO question)",
        "Methods — Protocol and Registration (PROSPERO or OSF registration)",
        "Methods — Eligibility Criteria (inclusion and exclusion, PICO framework)",
        "Methods — Information Sources and Search Strategy (databases, date range, search terms)",
        "Methods — Study Selection (screening process, number of reviewers)",
        "Methods — Data Extraction (data items collected, extraction form)",
        "Methods — Risk of Bias Assessment (tool used, e.g. RoB 2, ROBINS-I, NOS)",
        "Methods — Statistical Synthesis / Meta-analysis (if applicable: effect measure, heterogeneity, subgroup analysis)",
        "Results — Study Selection (PRISMA 2020 flow diagram narrative)",
        "Results — Characteristics of Included Studies",
        "Results — Risk of Bias Across Studies",
        "Results — Synthesis of Results (forest plot narrative, pooled estimates if meta-analysis)",
        "Discussion (summary of evidence, limitations, comparison with prior reviews)",
        "Conclusions",
        "References",
    ],

    # ── Scoping review (PRISMA-ScR) ───────────────────────────────────────────
    "scoping_review": [
        "Abstract (structured: Background, Objectives, Methods, Results, Conclusions)",
        "Introduction (rationale and objectives)",
        "Methods — Protocol (PRISMA-ScR; registration if applicable)",
        "Methods — Eligibility Criteria (concept, context, study types)",
        "Methods — Information Sources and Search Strategy",
        "Methods — Study Selection Process",
        "Methods — Data Charting (variables extracted)",
        "Results — Study Selection (PRISMA-ScR flow diagram narrative)",
        "Results — Characteristics of Included Sources",
        "Results — Summary of Evidence (organised by theme or concept)",
        "Discussion (scope of evidence, gaps, future research directions)",
        "Conclusions",
        "References",
    ],

    # ── Narrative review ─────────────────────────────────────────────────────
    "narrative_review": [
        "Abstract",
        "Introduction (background, objectives, scope of review)",
        "Methods (Literature Search Approach, Databases, Inclusion/Exclusion Criteria)",
        "Results and Discussion (organised by theme or chronology)",
        "Conclusions and Future Directions",
        "References",
    ],

    # ── Meta-analysis ─────────────────────────────────────────────────────────
    "meta_analysis": [
        "Abstract (structured: Background, Objectives, Methods, Results, Conclusions)",
        "Introduction",
        "Methods (Protocol Registration, Eligibility Criteria, Search Strategy, "
        "Data Extraction, Effect Measures, Synthesis Methods, Heterogeneity, "
        "Subgroup and Sensitivity Analyses, Risk of Bias)",
        "Results (Study Selection PRISMA Flow, Study Characteristics, "
        "Risk of Bias, Quantitative Synthesis, Subgroup Analyses)",
        "Discussion",
        "Conclusions",
        "References",
    ],

    # ── Case report (CARE guidelines) ─────────────────────────────────────────
    "case_report": [
        "Abstract (structured: Introduction, Case Presentation, Conclusions)",
        "Introduction (why this case is unusual or instructive)",
        "Case Presentation (patient demographics, timeline, clinical findings, "
        "diagnoses, interventions, outcomes — anonymised)",
        "Discussion (comparison with literature, mechanistic insights, clinical lessons)",
        "Conclusions",
        "Patient Consent Statement",
        "References",
    ],

    # ── Short communication / Brief report ────────────────────────────────────
    "short_communication": [
        "Abstract",
        "Introduction",
        "Methods",
        "Results",
        "Discussion",
        "References",
    ],
    "brief_report": [
        "Abstract",
        "Introduction",
        "Methods",
        "Results",
        "Discussion",
        "References",
    ],

    # ── Opinion / commentary ─────────────────────────────────────────────────
    "opinion": [
        "Abstract",
        "Introduction (position statement and motivation)",
        "Discussion (supporting arguments, counterarguments, evidence synthesis)",
        "Conclusions (call to action or recommendations)",
        "References",
    ],

    # ── Editorial ────────────────────────────────────────────────────────────
    "editorial": [
        "Introduction (issue addressed and its significance)",
        "Discussion (current state, challenges, perspectives)",
        "Conclusions (recommendations or forward-looking statements)",
        "References",
    ],

    # ── Letter to the editor ─────────────────────────────────────────────────
    "letter": [
        "Text (concise, structured argument: context → specific point → implication)",
        "References",
    ],

    # ── Generic review fallback ───────────────────────────────────────────────
    "review": [
        "Abstract",
        "Introduction",
        "Methods (Literature Search)",
        "Results and Discussion",
        "Conclusion",
        "References",
    ],
}


# ── Abstract no-citation instruction ─────────────────────────────────────────
_ABSTRACT_NO_CITATION_RULE = """\
ABSTRACT CITATION RULE (strict):
The Abstract section must contain NO inline citations, no [CITE:key] tags, and
no author-year references (e.g. no "(Smith et al., 2023)" in the abstract).
This is a universal convention across all journals and article types — abstracts
are always citation-free.  Every other section must follow the standard
[CITE:key] tagging rules.
"""

# ── Review-type methodology note ──────────────────────────────────────────────
_REVIEW_METHODOLOGY_NOTES: dict[str, str] = {
    "systematic_review": """\
SYSTEMATIC REVIEW REQUIREMENTS:
- Follow PRISMA 2020 reporting guidelines throughout.
- The Methods must cover all 8 subsections (protocol registration, eligibility
  criteria, information sources, search strategy, study selection, data
  extraction, risk of bias, synthesis methods).
- The Results must include a PRISMA flow narrative: total records identified →
  duplicates removed → screened → assessed for eligibility → included.
- Report pooled effect estimates with 95% CI, I² heterogeneity statistic, and
  p-value for heterogeneity where meta-analysis was performed.
- Risk of bias must be reported at both study level and outcome level.
- Distinguish between reported findings [CITE:key] and synthesis inferences [INF].
""",
    "scoping_review": """\
SCOPING REVIEW REQUIREMENTS:
- Follow PRISMA-ScR (Preferred Reporting Items for Systematic reviews and
  Meta-analyses extension for Scoping Reviews) guidelines.
- Clearly state the research question using the PCC framework
  (Population, Concept, Context).
- Methods must describe the charting process and the variables extracted.
- Results should map the evidence: types of sources, geographic spread,
  key themes or concepts — without meta-analytic pooling.
- Do NOT perform or claim statistical meta-analysis in a scoping review.
""",
    "narrative_review": """\
NARRATIVE REVIEW REQUIREMENTS:
- Explicitly describe the literature search approach (databases, keywords,
  date range) even if the search was not fully systematic.
- Organise the Results and Discussion by thematic or conceptual clusters,
  not chronologically.
- Acknowledge selection bias inherent to narrative reviews in the Discussion.
""",
    "meta_analysis": """\
META-ANALYSIS REQUIREMENTS:
- Follow PRISMA 2020 reporting guidelines.
- Clearly report: effect measure (OR, RR, MD, SMD, HR), pooling model
  (fixed vs. random effects, DerSimonian-Laird or REML), heterogeneity
  (I², Cochran's Q, τ²), and publication bias assessment (Egger's test,
  funnel plot asymmetry).
- Include GRADE assessment of evidence certainty if possible.
- All pooled estimates must cite specific papers via [CITE:key].
""",
    "case_report": """\
CASE REPORT REQUIREMENTS:
- Follow CARE (CAse REport) guidelines.
- The Case Presentation must follow a clear timeline.
- Patient details must be fully anonymised or de-identified.
- Include a Patient Consent Statement section.
- The Discussion should compare with at least 3–5 published cases or series.
""",
}


def _format_one_summary(i: int, s: dict, label_prefix: str = "") -> str:
    """Render a single paper summary as a labelled block for the article-writer LLM."""
    bib     = s.get("bibliography", {})
    methods = s.get("methods", {})
    ca      = s.get("critical_appraisal", {})
    results = s.get("results", [])

    authors = bib.get("authors", [])
    first_author = authors[0] if authors else s.get("paper_key", "Unknown")
    year     = bib.get("year") or "n.d."
    title    = bib.get("title") or s.get("paper_key", "")
    jname    = bib.get("journal") or ""
    doi      = bib.get("doi") or ""

    first_result = results[0] if results else {}
    finding   = first_result.get("finding", "not reported")
    effect    = first_result.get("effect_size", "")
    ci        = first_result.get("ci_95", "")
    pval      = first_result.get("p_value", "")
    stats_line = " | ".join(x for x in [effect, ci, pval] if x and x != "NR")

    return (
        f"\n[{label_prefix}{i}] {first_author} ({year}). {title}. {jname}. {doi}\n"
        f"  Takeaway: {s.get('one_line_takeaway', '')}\n"
        f"  Finding:  {finding}\n"
        f"  Study:    {methods.get('study_design', 'NR')} | N={methods.get('sample_n', '?')}\n"
        f"  Stats:    {stats_line or 'not reported'}\n"
        f"  Evidence: {ca.get('evidence_grade', 'not assessed')} ({ca.get('evidence_grade_justification', '')})\n"
    )


def build_summary_block(summaries: list[dict]) -> str:
    """Build a two-tier summary block distinguishing primary papers (depth=0)
    from cross-referenced original-source papers (depth≥1).

    Cross-referenced papers are the original sources that primary papers cited in
    their Introduction/Discussion.  They carry validated, citable evidence for
    specific background facts and should be cited directly in the manuscript rather
    than through the secondary paper that mentioned them.
    """
    primary   = [s for s in summaries if s.get("depth", 0) == 0]
    crossrefs = [s for s in summaries if s.get("depth", 0) > 0]

    block = ""

    # ── Primary papers (literature search results) ────────────────────────────
    block += (
        f"=== PRIMARY PAPERS ({len(primary)} papers from literature search) ===\n"
        "These papers were retrieved by the search engine.  Use their overall findings,\n"
        "methods, and conclusions to support the research question.\n"
    )
    for i, s in enumerate(primary[:30], 1):
        block += _format_one_summary(i, s, label_prefix="")

    # ── Cross-referenced papers (original sources) ────────────────────────────
    if crossrefs:
        block += (
            f"\n=== CROSS-REFERENCED ORIGINAL SOURCE PAPERS ({len(crossrefs)} papers) ===\n"
            "These are the ORIGINAL SOURCE papers that the primary papers cited in their\n"
            "Introduction and Discussion sections.  They provide validated, first-hand\n"
            "evidence for specific factual claims.  When a primary paper says e.g.\n"
            "\"chatbots communicate via natural language (Gnewuch et al. 2017)\", the\n"
            "Gnewuch 2017 paper below IS that original source — cite it directly.\n"
            "Prefer citing these papers over secondary papers for background facts.\n"
        )
        for i, s in enumerate(crossrefs[:20], 1):
            cited_by = s.get("cited_by_keys", [])
            cited_by_str = f"  Cited by: {', '.join(cited_by[:3])}\n" if cited_by else ""
            block += _format_one_summary(i, s, label_prefix="X")
            # Append the cited-by context right after the block line
            if cited_by_str:
                # Insert after the Evidence line (last line of the block)
                block = block.rstrip("\n") + "\n" + cited_by_str

    return block


async def build_article_prompt(
    session: dict,
    article_type: str,
    selected_journal: str,
    word_limit: int,
    journal_style: JournalStyle,
    manuscript_title: str,
    base_system: str,
    max_references: int | None = None,
) -> tuple[str, str]:
    """
    Build (system_prompt, user_message) for article generation.

    Injects:
      - Journal-specific citation style
      - Pre-formatted reference list (prevents hallucination; DOI-enriched)
      - Abstract structure instructions (structured vs. unstructured)
      - Abstract no-citation rule
      - Max references constraint
      - Article-type-specific methodology requirements
      - Section-specific writing guidelines
    """
    from services.doi_metadata_fetcher import enrich_summaries_with_doi

    query     = session.get("query", "")
    summaries_raw = list(session.get("summaries", {}).values())

    # ── DOI enrichment (Zotero-style) ────────────────────────────────────────
    # Fetch authoritative author names + bibliographic details from CrossRef
    # before building the reference list or summary block.
    summaries = await enrich_summaries_with_doi(summaries_raw)

    # Sections: journal-specific → global default
    sections = (
        journal_style.get_sections(article_type)
        or ARTICLE_SECTIONS.get(article_type, ARTICLE_SECTIONS["original_research"])
    )

    # Effective word limit: journal guideline overrides user's slider
    effective_word_limit, word_limit_note = journal_style.get_effective_word_limit(
        article_type, word_limit
    )

    # Build two-tier summary block (primary papers + cross-referenced original sources)
    summary_block = build_summary_block(summaries)

    # Count tiers for the user message
    n_primary   = sum(1 for s in summaries if s.get("depth", 0) == 0)
    n_crossrefs = sum(1 for s in summaries if s.get("depth", 0) > 0)
    tier_note = f"{n_primary} primary"
    if n_crossrefs:
        tier_note += f" + {n_crossrefs} cross-referenced original source"

    # Pre-formatted reference list (prevents LLM hallucination of refs)
    ref_list = journal_style.format_reference_list(summaries)

    # ── Strict word-count instruction ─────────────────────────────────────────
    tol_low  = max(500, round(effective_word_limit * 0.90))
    tol_high = round(effective_word_limit * 1.10)
    word_strict = (
        f"STRICT WORD COUNT ({tol_low}–{tol_high} words, target {effective_word_limit}): "
        "This is a mandatory journal submission requirement — papers outside this range are desk-rejected. "
        "Adjust section depth to stay within the band; do NOT truncate any section mid-way."
    )

    # ── User message ─────────────────────────────────────────────────────────
    user_msg = (
        f"Manuscript title (approved, do NOT change): {manuscript_title}\n"
        f"Research topic: {query}\n"
        f"Target journal: {selected_journal}\n"
        f"Article type: {article_type.replace('_', ' ').title()}\n"
        f"{word_strict}\n"
        f"Required sections: {', '.join(sections)}\n\n"
        f"Paper summaries ({tier_note} papers):\n{summary_block}\n\n"
    )
    if ref_list:
        user_msg += (
            "Pre-formatted reference list — copy this VERBATIM into your References section "
            "(do NOT alter author names, journal names, or any bibliographic detail):\n"
            f"{ref_list}\n\n"
        )
    user_msg += (
        "Write the complete article now, section by section, in Markdown. "
        "Begin with the approved manuscript title as a level-1 Markdown heading (# Title)."
    )

    # ── System prompt ────────────────────────────────────────────────────────
    # 1. Base system + journal-specific citation style
    effective_system = build_article_system_prompt(journal_style, base_system)

    # 2. Abstract citation-free rule (universal)
    effective_system += f"\n\n{_ABSTRACT_NO_CITATION_RULE}"

    # 3. Abstract structure instructions (structured vs. unstructured)
    abstract_hint = journal_style.get_abstract_instructions(article_type)
    if abstract_hint:
        effective_system += f"\n\n{abstract_hint}"

    # 4. Article-type-specific methodology requirements
    type_note = _REVIEW_METHODOLOGY_NOTES.get(article_type, "")
    if type_note:
        effective_system += f"\n\n{type_note}"

    # 5. (Max references constraint handled in item 9 with user + journal combined cap)

    # 6. Section-specific writing guidelines (from JSON file if present)
    guidelines_block = get_guidelines_for_sections(sections)
    if guidelines_block:
        effective_system += f"\n\n{guidelines_block}"

    # 7. Article-type-specific writing guidelines (embedded)
    type_guidelines = get_article_type_guidelines(article_type)
    if type_guidelines:
        effective_system += f"\n\n{type_guidelines}"

    # 8. Strict word count in system prompt (reinforces user message)
    effective_system += f"\n\n{word_strict}"

    # 9. Reference cap (user cap + journal cap combined)
    effective_ref_cap: int | None = None
    if max_references is not None:
        effective_ref_cap = max_references
    if journal_style.max_references:
        effective_ref_cap = (
            min(effective_ref_cap, journal_style.max_references)
            if effective_ref_cap is not None else journal_style.max_references
        )
    if effective_ref_cap:
        ref_cap_text = (
            f"STRICT REFERENCE LIMIT — \u2264{effective_ref_cap} references total: "
            "Count every [CITE:key] — the References section must contain "
            f"\u2264{effective_ref_cap} unique entries. Drop weaker citations to stay within the limit."
        )
        effective_system += f"\n\n{ref_cap_text}"

    # 10. Two-tier citation instruction (injected whenever cross-refs are present)
    crossref_count = sum(
        1 for s in summaries if (s if isinstance(s, dict) else {}).get("depth", 0) > 0
    )
    if crossref_count > 0:
        effective_system += f"""

CITATION TIER RULES — NON-NEGOTIABLE:
You have two tiers of papers:
  Tier 1 — PRIMARY papers [1], [2], … : retrieved by the literature search engine.
  Tier 2 — CROSS-REFERENCED papers [X1], [X2], … : original source papers that
            primary papers cited in their Introduction/Discussion.

Rules for citing:
1. For SPECIFIC BACKGROUND FACTS (prevalence figures, mechanism statements, established
   definitions) — always cite the Tier-2 cross-referenced paper directly.
   Example: if [X3] (Gnewuch et al. 2017) defines chatbots, cite [X3], not the
   primary paper that mentioned it.
2. For FINDINGS ABOUT THE RESEARCH QUESTION — cite Tier-1 primary papers.
3. Never cite a secondary paper for a fact when the original source paper is available
   in Tier-2.  This is the standard academic practice of citing primary sources.
4. Both tiers belong in the References section — all [X...] references must appear
   in the reference list with their full bibliographic details."""

    return effective_system, user_msg
