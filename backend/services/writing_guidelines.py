"""
writing_guidelines.py

Loads the pre-distilled writing guidelines from data/writing_guidelines.json
and returns section-specific guidance text to inject into AI prompts.

The JSON file is produced by scripts/extract_writing_guidelines.py.
If the file doesn't exist yet, all functions return empty strings so the
rest of the app continues to work normally.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from functools import lru_cache

logger = logging.getLogger(__name__)

_GUIDELINES_PATH = Path(__file__).parent.parent / "data" / "writing_guidelines.json"

# Map article-section display names → JSON keys
# Covers subsection names used by systematic/scoping/narrative review templates.
_SECTION_NAME_MAP: dict[str, str] = {
    "abstract":                                         "abstract",
    "introduction":                                     "introduction",
    "methods":                                          "methods",
    "methods (literature search)":                      "methods",
    "methods — protocol and registration":              "methods",
    "methods — eligibility criteria":                   "methods",
    "methods — information sources and search strategy":"methods",
    "methods — study selection":                        "methods",
    "methods — data extraction":                        "methods",
    "methods — risk of bias assessment":                "methods",
    "methods — statistical synthesis / meta-analysis":  "methods",
    "methods — protocol":                               "methods",
    "methods — data charting":                          "methods",
    "results":                                          "results",
    "results — study selection (prisma 2020 flow diagram narrative)": "results",
    "results — characteristics of included studies":    "results",
    "results — risk of bias across studies":            "results",
    "results — synthesis of results":                   "results",
    "results — study selection (prisma-scr flow diagram narrative)":  "results",
    "results — characteristics of included sources":    "results",
    "results — summary of evidence":                    "results",
    "results and discussion":                           "results",
    "discussion":                                       "discussion",
    "conclusion":                                       "conclusion",
    "conclusions":                                      "conclusion",
    "conclusions and future directions":                "conclusion",
    "title":                                            "title",
    "case presentation":                                "methods",
}

# These keys are always included regardless of which sections are requested
_ALWAYS_INCLUDE = {"general", "style"}


@lru_cache(maxsize=1)
def _load() -> dict[str, list[str]]:
    """Load and cache the guidelines JSON. Returns {} if file missing."""
    if not _GUIDELINES_PATH.exists():
        logger.info(
            "writing_guidelines.json not found at %s — "
            "run scripts/extract_writing_guidelines.py to generate it",
            _GUIDELINES_PATH,
        )
        return {}
    try:
        data = json.loads(_GUIDELINES_PATH.read_text(encoding="utf-8"))
        total = sum(len(v) for v in data.values() if isinstance(v, list))
        logger.info("Loaded %d writing guidelines from %s", total, _GUIDELINES_PATH)
        return data
    except Exception as exc:
        logger.warning("Failed to load writing_guidelines.json: %s", exc)
        return {}


def get_guidelines_for_sections(sections: list[str]) -> str:
    """
    Return a formatted block of writing guidelines relevant to the given
    section names (e.g. ["Introduction", "Methods", "Discussion"]).

    Always includes general and style guidelines.
    Returns an empty string if no guidelines file exists yet.
    """
    data = _load()
    if not data:
        return ""

    # Collect relevant keys
    wanted_keys: list[str] = []
    for key in _ALWAYS_INCLUDE:
        if key in data:
            wanted_keys.append(key)

    seen = set(wanted_keys)
    for section in sections:
        key = _SECTION_NAME_MAP.get(section.lower().strip())
        if key and key not in seen and key in data:
            wanted_keys.append(key)
            seen.add(key)

    if not wanted_keys:
        return ""

    lines: list[str] = ["## Expert Writing Guidelines (from published writing guides)"]
    for key in wanted_keys:
        items = data.get(key, [])
        if not items:
            continue
        lines.append(f"\n### {key.replace('_', ' ').title()}")
        for item in items:
            lines.append(f"- {item}")

    return "\n".join(lines)


def get_discussion_guidelines() -> str:
    """Convenience: return only discussion + style + general guidelines."""
    return get_guidelines_for_sections(["Discussion", "Conclusion"])


def guidelines_available() -> bool:
    """Return True if the guidelines file has been generated."""
    return bool(_load())


# ── Article-type-specific embedded guidelines ─────────────────────────────────
# These do not depend on the external JSON file.

_ARTICLE_TYPE_GUIDELINES: dict[str, list[str]] = {
    "systematic_review": [
        "TITLE: Use the word 'systematic review' or 'scoping review' and specify the PICO components.",
        "ABSTRACT: Structured abstract with Background, Objectives, Methods (databases, dates, eligibility), Results (PRISMA numbers), Conclusions. NO citations.",
        "INTRODUCTION: State rationale with gap analysis; end with explicit PICO objectives.",
        "METHODS — ELIGIBILITY: Define PICO/PCC explicitly. State inclusion AND exclusion criteria with justifications.",
        "METHODS — INFORMATION SOURCES: List every database searched with coverage dates. Mention grey literature (clinicaltrials.gov, WHO ICTRP, Google Scholar).",
        "METHODS — SEARCH STRATEGY: Report full search string for at least one database in an Appendix. State the date of the last search.",
        "METHODS — STUDY SELECTION: Describe dual independent screening process. State software used. Report inter-rater reliability (Cohen's kappa or percentage agreement).",
        "METHODS — DATA EXTRACTION: Describe extraction form, dual extraction, and pilot testing. State what was extracted.",
        "METHODS — RISK OF BIAS: Name the tool (RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa). State who assessed and how disagreements resolved.",
        "METHODS — SYNTHESIS: For meta-analysis, name software (R/RevMan/Stata), specify fixed vs random effects, heterogeneity statistics (I², Cochran's Q). For narrative synthesis, describe tabulation approach.",
        "RESULTS — STUDY SELECTION: Report PRISMA 2020 flow numbers at each stage. Identify the total number of excluded full-text papers with reasons.",
        "RESULTS — STUDY CHARACTERISTICS: Table of included studies with key characteristics. Do not rely on text alone.",
        "RESULTS — RISK OF BIAS: Summary table and traffic-light plot. Discuss overall concerns.",
        "RESULTS — SYNTHESIS: Report pooled estimates with 95% CI, I², tau², Q-statistic for each meta-analysis. Interpret I²: <25% low, 25-75% moderate, >75% high heterogeneity.",
        "DISCUSSION: Compare findings with prior reviews. Address heterogeneity. State GRADE certainty (high/moderate/low/very low) per outcome.",
        "PRISMA-trAIce: If AI tools were used at any stage, declare: which stages, which models, how human oversight was applied.",
        "REGISTRATION: State PROSPERO ID (e.g., CRD42024XXXXXX) or OSF DOI in both abstract and methods.",
        "SCOPING REVIEW NOTE: Do NOT pool statistics. Organize results thematically by categories/domains. Quality assessment is optional but should be noted if omitted.",
    ],
    "scoping_review": [
        "TITLE: Use the word 'systematic review' or 'scoping review' and specify the PICO components.",
        "ABSTRACT: Structured abstract with Background, Objectives, Methods (databases, dates, eligibility), Results (PRISMA numbers), Conclusions. NO citations.",
        "INTRODUCTION: State rationale with gap analysis; end with explicit PICO objectives.",
        "METHODS — ELIGIBILITY: Define PICO/PCC explicitly. State inclusion AND exclusion criteria with justifications.",
        "METHODS — INFORMATION SOURCES: List every database searched with coverage dates. Mention grey literature (clinicaltrials.gov, WHO ICTRP, Google Scholar).",
        "METHODS — SEARCH STRATEGY: Report full search string for at least one database in an Appendix. State the date of the last search.",
        "METHODS — STUDY SELECTION: Describe dual independent screening process. State software used. Report inter-rater reliability (Cohen's kappa or percentage agreement).",
        "METHODS — DATA EXTRACTION: Describe extraction form, dual extraction, and pilot testing. State what was extracted.",
        "METHODS — RISK OF BIAS: Name the tool (RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa). State who assessed and how disagreements resolved.",
        "METHODS — SYNTHESIS: For meta-analysis, name software (R/RevMan/Stata), specify fixed vs random effects, heterogeneity statistics (I², Cochran's Q). For narrative synthesis, describe tabulation approach.",
        "RESULTS — STUDY SELECTION: Report PRISMA 2020 flow numbers at each stage. Identify the total number of excluded full-text papers with reasons.",
        "RESULTS — STUDY CHARACTERISTICS: Table of included studies with key characteristics. Do not rely on text alone.",
        "RESULTS — RISK OF BIAS: Summary table and traffic-light plot. Discuss overall concerns.",
        "RESULTS — SYNTHESIS: Report pooled estimates with 95% CI, I², tau², Q-statistic for each meta-analysis. Interpret I²: <25% low, 25-75% moderate, >75% high heterogeneity.",
        "DISCUSSION: Compare findings with prior reviews. Address heterogeneity. State GRADE certainty (high/moderate/low/very low) per outcome.",
        "PRISMA-trAIce: If AI tools were used at any stage, declare: which stages, which models, how human oversight was applied.",
        "REGISTRATION: State PROSPERO ID (e.g., CRD42024XXXXXX) or OSF DOI in both abstract and methods.",
        "SCOPING REVIEW NOTE: Do NOT pool statistics. Organize results thematically by categories/domains. Quality assessment is optional but should be noted if omitted.",
    ],
    "narrative_review": [
        "Clearly define the scope and boundaries of the review in the Introduction.",
        "Even for a narrative review, provide a transparent methods section "
        "(databases, search terms, date range, language restrictions, how papers were selected).",
        "Organise content thematically, not as a paper-by-paper summary.",
        "Synthesise findings across papers for each theme before moving to the next.",
        "Acknowledge that narrative reviews are susceptible to author selection bias.",
        "The Conclusions should identify specific knowledge gaps and propose research priorities.",
    ],
    "meta_analysis": [
        "PRE-REGISTRATION: State PROSPERO ID. Describe any deviations from the registered protocol.",
        "EFFECT MEASURE: Explicitly justify choice (OR for binary, SMD for continuous, HR for time-to-event). State direction of effect.",
        "STATISTICAL MODEL: State whether fixed or random effects (DerSimonian-Laird, REML, Hartung-Knapp). For random effects, report tau² and its estimator.",
        "HETEROGENEITY: Report I² with 95% CI, Cochran's Q with df and p-value, tau². Interpret cautiously: I² reflects proportion not absolute amount.",
        "SUBGROUP ANALYSIS: Pre-specify subgroups (not post-hoc). Report between-subgroup heterogeneity (I²_between). Use interaction tests not separate analyses.",
        "SENSITIVITY ANALYSIS: Report leave-one-out, restricting to low RoB, alternate effect measure.",
        "PUBLICATION BIAS: Funnel plot (≥10 studies), Egger's test, trim-and-fill. State if too few studies.",
        "GRADE: Apply GRADE framework per outcome: start High, downgrade for study limitations, inconsistency, indirectness, imprecision, publication bias.",
        "FOREST PLOT: Include study names, sample sizes, effect sizes, 95% CIs, weights (%), and diamond. Label axes clearly.",
        "SOFTWARE: Name R package (meta, metafor), RevMan, or Stata and version.",
        "REPORTING: Follow PRISMA 2020 checklist. For continuous outcomes report MD or SMD with pooled SD. For binary outcomes report event rates in both arms.",
    ],
    "case_report": [
        "Begin the Introduction with why this specific case is clinically or scientifically "
        "unusual, rare, or instructive.",
        "The Case Presentation must follow a strict chronological timeline with dates "
        "(or relative time: 'Day 3', 'Week 2').",
        "Include all relevant investigations (labs, imaging, histology) with actual values.",
        "The Discussion must compare the case with published similar cases — minimum 3–5 references.",
        "Discuss diagnostic challenges, treatment decisions, and lessons learned.",
        "Always include a Patient Consent Statement confirming informed consent was obtained.",
        "Fully anonymise all identifying information (names, dates of birth, institution names).",
    ],
    "brief_report": [
        "A brief report presents preliminary or focused findings — do not overstate conclusions.",
        "Keep the Methods section concise but reproducible.",
        "Limit speculation in the Discussion; highlight the need for larger confirmatory studies.",
    ],
    "opinion": [
        "State the central thesis clearly in the first paragraph.",
        "Structure the Discussion as a logical argument: premise → evidence → conclusion.",
        "Acknowledge and address the strongest counterarguments.",
        "Use [CITE:key] for all empirical claims even in an opinion piece.",
        "End with a concrete, actionable recommendation.",
    ],
    "editorial": [
        "Editorials are short and high-impact — every sentence must earn its place.",
        "Do not summarise the original article being accompanied; instead interpret "
        "its significance and place it in the field context.",
        "Write for a broad readership, not just specialists.",
    ],
    "letter": [
        "A letter to the editor must be extremely concise (typically 400–600 words).",
        "Identify one specific point, limitation, or complement to a previously published work.",
        "Cite the original article in the opening sentence.",
        "Do not include a formal Abstract.",
    ],
    "original_research": [
        "Methods must be sufficiently detailed that the study can be independently replicated.",
        "Report effect sizes and confidence intervals — p-values alone are insufficient.",
        "Distinguish pre-specified primary outcomes from secondary or exploratory analyses.",
        "Discuss clinical or practical significance separately from statistical significance.",
        "Address all primary outcomes in Results even if non-significant.",
    ],
}


def get_article_type_guidelines(article_type: str) -> str:
    """
    Return embedded writing guidelines specific to the given article type.

    Returns an empty string for unknown types.
    Does NOT depend on the external writing_guidelines.json file.
    """
    items = _ARTICLE_TYPE_GUIDELINES.get(article_type, [])
    if not items:
        return ""
    lines = [f"## Article-Type Writing Requirements — {article_type.replace('_', ' ').title()}"]
    for item in items:
        lines.append(f"- {item}")
    return "\n".join(lines)
