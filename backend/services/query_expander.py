"""
query_expander.py

Uses an LLM to turn a free-text research key idea into a comprehensive,
multi-database search strategy following evidence-based IR methodology.

Grounded in:
  • Bramer et al. (2018) "Optimal Database Combinations for Literature Searches
    in Systematic Reviews: A Prospective Exploratory Study"
    (Systematic Reviews, 7:40)
  • MacFarlane, Russell-Rose & Shokraneh (2022) "Search strategy formulation
    for systematic reviews: Issues, challenges and opportunities"
    (Intelligent Systems with Applications, 15, 200091)
  • Cochrane Handbook Ch. 6 — Searching for studies
  • MECIR Reporting Standards
  • AUT Library Systematic Reviews Guide — developing a search strategy

Key principles applied:
  • Framework selection: PICO / PECO / SPIDER / PEO based on article type
  • Facet-based construction (concept blocks → Boolean combination)
  • Three error classes avoided: Strategic / Tactical / Logical
  • High-recall imperative: omissions invalidate reviews
  • Database-specific syntax (PubMed vs general text search)
  • AmE/BrE spelling variants, truncation, trade names, older terminology
  • Pearl-growing validation before output
  • Self-check for common mistakes before output

Produces:
  • framework_used   — PICO / PECO / SPIDER / PEO + justification
  • facets           — structured concept blocks (mesh + freetext per facet)
  • queries          → 8-12 varied text strings for OpenAlex, Semantic Scholar, Crossref
  • pubmed_queries   → 4-5 field-tagged strings for PubMed/PMC
  • mesh_terms       → NLM MeSH descriptors with subheadings
  • boolean_query    → master faceted Boolean expression
  • pico             → Population / Intervention / Comparator / Outcome narrative
  • study_type_filters
  • strategy_notes   → self-identified quality/completeness flags
  • rationale
"""

import json
import logging
import re
from dataclasses import dataclass, field

from services.ai_provider import AIProvider
from services.search_guidelines import get_search_strategy_guidelines

logger = logging.getLogger(__name__)

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in",
    "into", "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "use",
    "using", "want", "we", "with", "write", "about", "review", "paper", "study", "research",
}


def _normalize_ws(text: str) -> str:
    return " ".join((text or "").strip().split())


def _extract_terms(text: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]{1,}", text)
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        key = t.lower()
        if key in _STOPWORDS:
            continue
        # Remove numeric-only tokens and very short fragments
        if key.isdigit() or len(key) < 3:
            continue
        if key not in seen:
            seen.add(key)
            out.append(t)
    return out


def _extract_phrases(text: str) -> list[str]:
    t = text.lower()
    patterns = [
        "type 1 diabetes",
        "type 2 diabetes",
        "intermittent fasting",
        "time restricted eating",
        "time-restricted eating",
        "insulin resistance",
        "weight loss",
        "glycemic control",
        "blood glucose",
        "hba1c",
        "meta analysis",
        "systematic review",
        "randomized controlled trial",
    ]
    found: list[str] = []
    for p in patterns:
        if p in t and p not in found:
            found.append(p)
    return found


def heuristic_expand_query(key_idea: str, article_type: str = "") -> "ExpandedQuery":
    """
    Non-AI fallback query strategy for when no provider is configured or expansion fails.
    Converts long free-text prompts into a handful of concise keyword queries.
    """
    original = _normalize_ws(key_idea)
    terms = _extract_terms(original)
    phrases = _extract_phrases(original)

    # Prefer compact keyword blocks to avoid API 400s on long narrative prompts.
    core_terms = terms[:8]
    keyword_query = " ".join(core_terms[:6]) if core_terms else original[:120]

    query_variants: list[str] = []
    for q in [
        " ".join(phrases[:2]) if phrases else "",
        keyword_query,
        " ".join(core_terms[:4]),
        " ".join(core_terms[2:6]),
        " ".join([*phrases[:1], *core_terms[:3]]).strip(),
        original if len(original) <= 140 else "",
    ]:
        qn = _normalize_ws(q)
        if qn and qn not in query_variants:
            query_variants.append(qn)

    if not query_variants:
        query_variants = [original[:120] or "research query"]

    # PubMed/PMC tolerate boolean + [tiab] much better than long narrative text.
    tiab_terms = [p for p in phrases[:2]]
    tiab_terms.extend(core_terms[:4])
    tiab_terms = [t for t in tiab_terms if t]
    pubmed_parts = []
    for t in tiab_terms[:6]:
        if " " in t:
            pubmed_parts.append(f"\"{t}\"[tiab]")
        else:
            pubmed_parts.append(f"{t}[tiab]")
    pubmed_query = " AND ".join(pubmed_parts[:4]) if pubmed_parts else (f"\"{original[:80]}\"[tiab]" if original else "")

    pubmed_queries = [pubmed_query] if pubmed_query else []
    if len(tiab_terms) >= 2:
        broad = " OR ".join(
            [f"\"{t}\"[tiab]" if " " in t else f"{t}[tiab]" for t in tiab_terms[:6]]
        )
        if broad and broad not in pubmed_queries:
            pubmed_queries.append(broad)

    strategy_notes = [
        "Heuristic fallback strategy used because AI query expansion is unavailable.",
        "Long narrative query compressed into shorter keyword queries to improve database compatibility.",
    ]
    if article_type:
        strategy_notes.append(f"Article type hint received: {article_type}")

    rationale = (
        "AI expansion was unavailable, so a heuristic keyword strategy was generated from the "
        "user's key idea. The fallback prefers short phrase + keyword variants to avoid long-query "
        "API failures and improve recall across PubMed, OpenAlex, and Semantic Scholar."
    )

    return ExpandedQuery(
        queries=query_variants,
        pubmed_queries=pubmed_queries,
        mesh_terms=[],
        boolean_query=" AND ".join([f"({p})" for p in phrases[:2]]) if phrases else keyword_query,
        pico={},
        study_type_filters=[],
        rationale=rationale,
        facets={},
        strategy_notes=strategy_notes,
        framework_used="Heuristic",
        framework_justification="AI provider unavailable; using keyword compression fallback.",
    )

# ── System prompt ──────────────────────────────────────────────────────────────

_SYSTEM = """\
You are a senior systematic-review medical librarian and information retrieval \
specialist. You build rigorous, high-recall search strategies for evidence \
synthesis following Cochrane Handbook Ch.6, MECIR standards, and Bramer et al. \
(2018) optimal database combination methodology.

══════════════════════════════════════════════════════════════════════════
STEP 0 — FRAMEWORK SELECTION  (choose BEFORE decomposing concepts)
══════════════════════════════════════════════════════════════════════════

Choose the most appropriate framework for the research question:

  PICO   → clinical interventions, RCTs, drug/treatment comparisons
            (Population · Intervention · Comparator · Outcome)

  PECO   → exposure/risk questions — epidemiology, environmental health,
            occupational health, diet/lifestyle
            (Population · Exposure · Comparator · Outcome)

  SPIDER → qualitative or mixed-methods research — phenomenology, grounded
            theory, thematic analysis, patient experience
            (Sample · Phenomenon of Interest · Design · Evaluation · Research type)

  PEO    → population needs, health services, no explicit intervention or
            comparator (Population · Exposure/Issue · Outcome)

  If the article_type is "systematic_review", "meta_analysis", or "scoping_review"
  → prefer PICO/PECO (whichever fits the topic).
  If it is "qualitative" or exploratory → prefer SPIDER.
  If it is "original_research" without a comparator → PEO or PICO are both fine.
  Default: PICO.

Record the chosen framework in the "framework_used" field.

══════════════════════════════════════════════════════════════════════════
STEP 1 — CONCEPT DECOMPOSITION  (based on chosen framework)
══════════════════════════════════════════════════════════════════════════

Decompose the research question into 2–4 concept facets.
Each facet becomes a separate Boolean OR-block.
Typically: Population AND Intervention (AND Outcome for precision).
Do NOT add study-design filters as a main facet — apply as a separate block.

══════════════════════════════════════════════════════════════════════════
STEP 2 — SYSTEMATIC SYNONYM COLLECTION  (for every facet)
══════════════════════════════════════════════════════════════════════════

For EVERY concept collect ALL of the following layers:

  A. CONTROLLED VOCABULARY
     • Preferred MeSH descriptor (exploded) + relevant subheadings
     • Emtree equivalents where different from MeSH
     • Broader MeSH terms when the exact concept may not be indexed

  B. FREE-TEXT SYNONYMS
     • Preferred/current clinical term
     • Historical/older terminology (pre-2010 literature used different terms —
       e.g. "juvenile diabetes" instead of "type 1 diabetes")
     • Trade names AND generic drug names (both are searched)
     • Abbreviations AND spelled-out forms (e.g. "MI" AND "myocardial infarction")
     • AmE AND BrE spelling variants:
       randomize/randomise · tumor/tumour · pediatric/paediatric ·
       anemia/anaemia · leukemia/leukaemia · hemoglobin/haemoglobin
     • Plural/singular when truncation doesn't capture both
     • Lay/patient language variants (for population searches)
     • Truncated stems with * where root covers ≥2 relevant forms
       (e.g. "therap*" → therapy, therapies, therapeutic, therapeutics)
       — avoid stems shorter than 4 characters (too much noise)

  C. ADJACENT / BROADER CONCEPT TERMS
     • Broader synonyms that would appear in review article titles
     • Related conditions that are frequently co-studied
     • Mechanism/pathophysiology terms (catches aetiological papers)

══════════════════════════════════════════════════════════════════════════
STEP 3 — BOOLEAN COMBINATION
══════════════════════════════════════════════════════════════════════════

  Within a facet → connect ALL synonyms with OR (maximise recall)
  Between facets  → connect with AND (define scope)
  Phrase multi-word terms in double quotes: "type 2 diabetes"
  Truncate word stems: diabet* · therap* · cardiovascular*
  Avoid AND NOT except for well-defined, unambiguous exclusions.

══════════════════════════════════════════════════════════════════════════
STEP 4 — PubMed QUERY CONSTRUCTION  (4-5 strategies)
══════════════════════════════════════════════════════════════════════════

Generate 4-5 PubMed-specific query strings covering these complementary angles:

  1. MeSH-only strategy — maximum precision
     Uses [MeSH Terms] with subheadings and /explode where appropriate
     Example: ("Diabetes Mellitus, Type 2"[MeSH Terms]) AND ("Metformin"[MeSH Terms])

  2. MeSH + free-text combination — balanced recall/precision
     Combines MeSH descriptors with [tiab] free-text synonyms
     Example: ("Diabetes Mellitus, Type 2"[MeSH Terms] OR "type 2 diabetes"[tiab] OR "T2DM"[tiab])

  3. Free-text only — catches recent/unindexed papers (MeSH lags 6-12 months)
     Uses [tiab] for all terms; broadest recall
     Include older terminology variants here

  4. Study design filter variant — add RCT/review filter block
     For clinical questions: add (randomized controlled trial[pt] OR
     controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR trial[tiab])
     For reviews: add (systematic review[pt] OR meta-analysis[pt] OR "systematic review"[tiab])

  5. Outcome/mechanism-specific angle (optional but recommended)
     Focuses on the outcome or mechanism facet with high specificity

  Rules:
  • Always use [MeSH Terms] NOT [mh]
  • Use [tiab] for title/abstract free-text
  • Use [pt] for publication type
  • Use MeSH subheadings with /
  • ALL brackets must be balanced — check this explicitly
  • Do NOT invent MeSH descriptors — only use verified NLM terms

══════════════════════════════════════════════════════════════════════════
STEP 5 — GENERAL QUERY STRINGS  (8-12 strategies)
══════════════════════════════════════════════════════════════════════════

Generate 8-12 varied natural-language strings for OpenAlex, Semantic Scholar,
and Crossref (no field tags). Each query should cover a DISTINCT angle:

  1.  Direct concept — plain language primary query
  2.  Abbreviation/acronym variant
  3.  Population-specific angle
  4.  Intervention/exposure-specific angle
  5.  Outcome-focused angle
  6.  Mechanistic/pathophysiological angle
  7.  Broader concept (captures review and overview articles)
  8.  Older terminology variant (catches pre-2010 literature)
  9.  Trade name / alternative name variant (if applicable)
  10. Related comorbidity / co-occurring condition angle
  11. Methodological angle (study design + topic)
  12. Synonym combination variant

  Rules:
  • 3-10 words per query; plain language; NO field tags
  • Each query must be meaningfully different (vary terminology, angle, specificity)
  • Prioritise variety over repetition — different queries should surface different papers

══════════════════════════════════════════════════════════════════════════
STEP 6 — STUDY DESIGN FILTER
══════════════════════════════════════════════════════════════════════════

Apply as a SEPARATE block (do not embed in concept facets).
Use validated Cochrane Highly Sensitive Search Strategy filters for RCTs.
Adjust study design filters based on article_type provided.

══════════════════════════════════════════════════════════════════════════
STEP 7 — SELF-CHECK  (90% of published strategies have ≥1 error)
══════════════════════════════════════════════════════════════════════════

Check all three error classes (Sampson & McGowan 2006):
  ★ STRATEGIC: No overlapping/redundant facets. Operators correct.
               PubMed syntax valid (brackets balanced, field tags correct).
  ★ TACTICAL:  All major synonyms present (including trade names, older terms,
               AmE+BrE variants, abbreviations).
               MeSH terms are real NLM descriptors (not invented).
               Truncation wildcards are correct (not too short: ≥4 char stems).
  ★ LOGICAL:   OR within facets, AND between facets.
               NOT only if essential and unambiguous.

══════════════════════════════════════════════════════════════════════════
STEP 8 — PEARL GROWING VALIDATION
══════════════════════════════════════════════════════════════════════════

The "pearl growing" technique (Spence 2018, Bramer 2018):
  • Mentally identify 2-3 landmark papers in this field
  • Check: would this strategy retrieve those papers?
  • If not, identify which synonyms or MeSH terms are missing
  • Add any missing terms, or note them in strategy_notes
  • Also check: would this strategy retrieve papers from BOTH
    MeSH-indexed sources AND pre-2024 unindexed preprints?

══════════════════════════════════════════════════════════════════════════
HIGH-RECALL IMPERATIVE
══════════════════════════════════════════════════════════════════════════

Omitting a relevant study can invalidate the entire review outcome.
  • Prefer SENSITIVITY over PRECISION — retrieve broadly, screen later
  • Never restrict by language or date in the strategy itself
  • Search BOTH controlled vocabulary AND free-text synonyms for every concept
  • MeSH indexing lags 6-12 months — free-text catches new publications
  • Bramer et al. (2018): MEDLINE + Embase + Cochrane CENTRAL covers 85-95%
    of RCTs; always recommend all three for clinical questions

══════════════════════════════════════════════════════════════════════════
OUTPUT — Return ONLY valid JSON, no markdown, no text outside the object
══════════════════════════════════════════════════════════════════════════
{
  "framework_used": "PICO",
  "framework_justification": "1 sentence explaining why this framework was chosen",

  "facets": {
    "population": {
      "mesh":     ["MeSH descriptor 1", "MeSH descriptor 2/subheading"],
      "freetext": ["preferred term", "synonym", "abbreviation", "older term", "BrE variant", "stem*"]
    },
    "intervention": {
      "mesh":     ["MeSH descriptor"],
      "freetext": ["generic name", "trade name 1", "trade name 2", "synonym", "abbrev*", "BrE variant"]
    },
    "comparator": {
      "mesh":     [],
      "freetext": ["control", "placebo", "standard care", "usual care"]
    },
    "outcome": {
      "mesh":     ["MeSH outcome descriptor"],
      "freetext": ["outcome term", "synonym", "measure*", "assessment*"]
    }
  },

  "queries": [
    "direct concept query — 3-10 words, plain language",
    "abbreviation or acronym variant",
    "population-specific angle",
    "intervention or exposure angle",
    "outcome-focused query",
    "mechanistic or pathophysiology angle",
    "broader concept to capture review articles",
    "older terminology variant (pre-2010 terms)",
    "trade name or alternative name (if applicable)",
    "related comorbidity or co-occurring condition",
    "methodological angle (study design + topic)",
    "synonym combination variant"
  ],

  "pubmed_queries": [
    "(\"MeSH Descriptor A\"[MeSH Terms]) AND (\"MeSH Descriptor B\"[MeSH Terms])",
    "(\"MeSH A\"[MeSH Terms] OR \"free text synonym\"[tiab] OR \"abbreviation\"[tiab]) AND (\"MeSH B\"[MeSH Terms] OR \"synonym B\"[tiab])",
    "(\"free text term\"[tiab] OR \"older term\"[tiab] OR \"synonym\"[tiab]) AND (\"intervention\"[tiab] OR \"trade name\"[tiab])",
    "(population[tiab] OR synonym[tiab]) AND (intervention[tiab] OR synonym[tiab]) AND (randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR trial[tiab])",
    "(\"MeSH outcome\"[MeSH Terms] OR \"outcome term\"[tiab]) AND (\"population MeSH\"[MeSH Terms] OR \"intervention MeSH\"[MeSH Terms])"
  ],

  "mesh_terms": [
    "Full Official MeSH Descriptor Name",
    "Descriptor/Subheading",
    "Another Real NLM Descriptor"
  ],

  "boolean_query": "(population_term OR population_synonym OR \"population phrase\" OR mesh_population[mh]) AND (intervention_term OR intervention_synonym OR intervent*) AND (outcome1 OR outcome_synonym OR measure*)",

  "pico": {
    "population":    "Precise description of who/what is studied",
    "intervention":  "What intervention, exposure, or phenomenon is examined",
    "comparator":    "Comparison or control — write 'Not applicable' if absent",
    "outcome":       "Primary outcomes or endpoints of interest"
  },

  "study_type_filters": ["randomized controlled trial", "systematic review"],

  "strategy_notes": [
    "Pearl growing: strategy tested against landmark papers in this field",
    "Any missing synonyms, scope limitations, or debatable operator choices",
    "e.g. 'Trade name X added — generic name Y is the indexed MeSH term'",
    "e.g. 'Outcome facet omitted from PubMed queries to maximise recall'"
  ],

  "rationale": "4-5 sentences: (1) framework chosen and why, (2) which MeSH terms were selected and why, (3) which trade names / older terms / abbreviations were included and why, (4) scope decisions — inclusions and exclusions, (5) pearl growing result and any gaps identified."
}

══════════════════════════════════════════════════════════════════════════
FIELD RULES (applied after self-check and pearl growing)
══════════════════════════════════════════════════════════════════════════

• framework_used    — one of: PICO, PECO, SPIDER, PEO
• facets            — complete concept blocks; freetext MUST include trade names,
                      older terminology, AmE+BrE variants, abbreviations, and
                      at least one truncated wildcard stem per facet
• queries           — 8-12 strings; NO field tags; each must cover a different
                      angle (direct, abbreviation, population, intervention,
                      outcome, mechanism, broader, older term, trade name, etc.)
• pubmed_queries    — exactly 4-5 valid PubMed strings; [MeSH Terms] not [mh];
                      [tiab] for free-text; [pt] for publication type;
                      ALL brackets balanced; no invented MeSH terms
• mesh_terms        — 4-10 REAL NLM MeSH descriptors only; include subheadings
• boolean_query     — faceted display query; phrase multi-word terms; use *
• study_type_filters — 2-4 values from the allowed list
• strategy_notes    — honest self-assessment including pearl growing result
• rationale         — 4-5 sentences covering all five required points
• tentative_title   — a concise, informative working title for this research
                      project (10-15 words); must follow academic title conventions:
                      specific population + intervention/exposure + outcome + study
                      design hint (e.g. "Effect of X on Y in Z: A Systematic Review").
                      This will be used as the project folder name — no punctuation
                      other than hyphens, no colons, no special characters.
"""


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class ExpandedQuery:
    queries: list[str]
    pubmed_queries: list[str]        = field(default_factory=list)
    mesh_terms: list[str]            = field(default_factory=list)
    boolean_query: str               = ""
    pico: dict                       = field(default_factory=dict)
    study_type_filters: list[str]    = field(default_factory=list)
    rationale: str                   = ""
    facets: dict                     = field(default_factory=dict)
    strategy_notes: list[str]        = field(default_factory=list)
    framework_used: str              = ""
    framework_justification: str     = ""
    tentative_title: str             = ""


# ── Query expansion ───────────────────────────────────────────────────────────

async def expand_query(
    provider: AIProvider,
    key_idea: str,
    article_type: str = "",
) -> ExpandedQuery:
    """
    Call the LLM to expand key_idea into a full multi-database search strategy.

    article_type hints guide framework selection (PICO/PECO/SPIDER/PEO).
    Falls back to a minimal single-query result on any error.
    """
    try:
        search_guidelines = get_search_strategy_guidelines()
        effective_system = (
            _SYSTEM + "\n\n" + search_guidelines
            if search_guidelines
            else _SYSTEM
        )

        article_type_hint = (
            f"\nArticle type context: {article_type}"
            if article_type
            else ""
        )

        raw = await provider.complete(
            system=effective_system,
            user=(
                f"Research key idea: {key_idea}{article_type_hint}\n\n"
                "Build a comprehensive, high-recall search strategy following the "
                "methodology above. Select the appropriate framework (PICO/PECO/"
                "SPIDER/PEO), generate 8-12 general queries and 4-5 PubMed queries, "
                "include trade names, older terminology, and AmE/BrE variants. "
                "Apply the pearl-growing validation and self-check before outputting."
            ),
            json_mode=True,
            temperature=0.2,
        )
        data = json.loads(raw)

        return ExpandedQuery(
            queries               = data.get("queries")               or [key_idea],
            pubmed_queries        = data.get("pubmed_queries")        or [],
            mesh_terms            = data.get("mesh_terms")            or [],
            boolean_query         = data.get("boolean_query")         or key_idea,
            pico                  = data.get("pico")                  or {},
            study_type_filters    = data.get("study_type_filters")    or [],
            rationale             = data.get("rationale")             or "",
            facets                = data.get("facets")                or {},
            strategy_notes        = data.get("strategy_notes")        or [],
            framework_used        = data.get("framework_used")        or "PICO",
            framework_justification = data.get("framework_justification") or "",
            tentative_title       = data.get("tentative_title")       or "",
        )

    except Exception as exc:
        logger.warning("Query expansion failed (%s). Using heuristic fallback.", exc)
        return heuristic_expand_query(key_idea, article_type=article_type)
