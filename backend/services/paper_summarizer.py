"""
paper_summarizer.py

3-pass evidence extraction engine for academic papers.

Pass 1 – Triage (5 Cs): Category, Context, Correctness flags, Contributions, Clarity
Pass 2 – Structured extraction: IMRAD methods + Results with statistics + Bibliography
Pass 3 – Critical appraisal: Bias, validity, reproducibility, evidence grade

Non-negotiable rules enforced via system prompt:
  1. Never fabricate data, citations, effect sizes, or conclusions.
  2. For every extracted claim, include verbatim supporting quote.
  3. Distinguish: reported_fact | author_interpretation | inference
  4. Missing info → "NR" (not reported), never guessed.
"""

import json
import logging
from typing import Awaitable, Callable, Optional

from models import (
    CitedReference,
    ConfidenceScore,
    DiscussionInsight,
    EvidenceQuote,
    ExtractionCriticalAppraisal,
    ExtractionMethods,
    IntroductionClaim,
    Paper,
    PaperBibliography,
    PaperSummary,
    ResultItem,
    SentenceCitation,
    Triage,
)
from services.ai_provider import AIProvider
from services.doi_metadata_fetcher import fetch_doi_metadata
from services.paper_fetcher import FetchSettings, fetch_full_text

logger = logging.getLogger(__name__)

SOURCE_LABEL = {
    "pmc_xml":       "PMC full-text XML",
    "full_pdf":      "open-access PDF",
    "full_html":     "open-access HTML full text",
    "abstract_only": "abstract only",
    "none":          "no text available",
}

_SYSTEM = """\
You are an evidence extraction and synthesis engine for academic research.

NON-NEGOTIABLE RULES — violating any of these is a critical failure:
1. NEVER fabricate data, citations, effect sizes, p-values, or conclusions.
2. For every factual claim in the results array, include a verbatim supporting_quote from the paper text.
3. Distinguish claim_type strictly:
   - "reported_fact"         → directly stated verbatim in the text
   - "author_interpretation" → the authors' own conclusions or inferences
   - "inference"             → your reading / synthesis across statements
4. If information is absent from the text, output "NR" (not reported) — never guess or extrapolate.
5. Follow a 3-pass workflow internally:
   Pass 1: Triage  — quick categorisation and quality gate
   Pass 2: Structured extraction — IMRAD + bibliography + results with quotes
   Pass 3: Critical appraisal — bias, validity, reproducibility, evidence grade
6. Output ONLY valid JSON matching the exact schema below. No markdown fences, no prose outside JSON.

RESULTS EXTRACTION — always produce at least one entry:
- Even when working from an abstract only, extract the primary outcome reported.
- For systematic reviews / meta-analyses: report the primary pooled estimate
  (e.g. SMD, OR, RR) with its CI and heterogeneity (I²) as a single result entry.
- For review articles without pooled statistics: create one entry summarising the
  main conclusion with a direct quote from the abstract as supporting_quote.
- An empty results array is never acceptable when ANY finding is stated in the text.

INTRODUCTION / DISCUSSION EXTRACTION (Pass 2b — only when full text is available):

CITATION STYLE DETECTION — determine which style this paper uses before extracting:
  • Numbered style: inline citations are "[1]", "[1,2]", "(1)", superscript numbers.
    → cited_ref_ids should be the numbers as strings: ["1"], ["3","5"]
    → ref_id in cited_references should be the same numbers: "1", "3", "5"
  • Author-year style (APA, Harvard, Vancouver author-year): inline citations are
    "(Gnewuch et al. 2017)", "(Smith & Jones, 2019)", "Pavlikova et al. (2003)".
    → cited_ref_ids must use the EXACT inline key: ["Gnewuch et al. 2017"]
    → ref_id in cited_references must use the SAME author-year key so they match:
      ref_id = "Gnewuch et al. 2017"  ← not "Gnewuch2017" or "gnewuch_2017"

CRITICAL: cited_ref_ids inside introduction_claims and discussion_insights must use
the identical format as ref_id in cited_references so the pipeline can link them.

- introduction_claims: Extract 5–15 key factual claims from the Introduction section.
  For each claim include:
    • The verbatim_quote (exact sentence(s) containing the citation, with inline markers)
    • cited_ref_ids: list of citation keys for every reference used in that sentence
  Focus on background facts, prevalence figures, mechanism statements that the paper
  is using to justify its own work — these are cross-referenceable claims.
  Example: "chatbots communicate with users via natural language (Gnewuch et al. 2017)"
    → claim: "Chatbots communicate with human users via natural language"
    → verbatim_quote: "chatbots, which are systems designed to communicate with human users by means of natural language (e.g., Gnewuch et al. 2017; Pavlikova et al. 2003)"
    → cited_ref_ids: ["Gnewuch et al. 2017", "Pavlikova et al. 2003"]

- discussion_insights: Extract 3–10 key insights from the Discussion/Conclusion sections,
  typed as: comparison (vs other work) | limitation (of this study) |
  implication (clinical/policy) | future_direction. Include verbatim quote and cited_ref_ids.

- cited_references: Extract the paper's COMPLETE reference list. For EVERY entry:
    • ref_id: the citation key that appears inline (number "1" OR author-year "Gnewuch et al. 2017")
    • doi: DOI if present in the reference text (strip "https://doi.org/" prefix)
    • title: full paper title
    • authors: list of author strings (e.g. ["Gnewuch U", "Morana S", "Maedche A"])
    • year: publication year as integer
    • journal: journal name or conference name (e.g. "ICIS 2017", "J Med Internet Res")
    • raw_text: the complete citation string exactly as printed, verbatim
  Always populate raw_text — it is the fallback used to search for papers without DOIs.
  IMPORTANT: even for conference proceedings without a DOI, extract title/authors/year/venue
  from the raw_text — these fields enable the system to search Semantic Scholar for the paper.

- When text_source is "abstract_only" or "none": output empty arrays [] for all three fields.

SENTENCE BANK — research-question-driven selective extraction:
- sentence_bank: Extract 5–12 HIGH-VALUE sentences that would directly be cited when writing
  an academic article about the research question above.
  Quality over quantity — a paper with 10 relevant sentences is better than 25 generic ones.

  For each sentence include:
    • section: where in the SOURCE PAPER it came from:
      "background" | "methods" | "results" | "discussion" | "conclusion"
    • text: clean, concise paraphrased statement in active voice — self-contained and citable
    • verbatim_quote: exact sentence(s) from the paper (required for results; optional for others)
    • claim_type: "reported_fact" | "author_interpretation" | "inference"
    • stats: extracted numeric statistics if present (e.g. "OR=1.8 [1.2, 2.7] p=0.003"), else ""
    • importance: "high" if this sentence is a must-cite for the research question,
                  "medium" if useful but secondary
    • use_in: which section of the TARGET MANUSCRIPT this sentence belongs in:
              "introduction" | "methods" | "results" | "discussion"

  SELECTION CRITERIA — only include a sentence if it passes ALL of these:
  1. RELEVANT to the research question — skip sentences about unrelated topics
  2. SPECIFIC and CITABLE — contains a concrete claim, number, mechanism, or finding
  3. NOT BOILERPLATE — skip: ethics approvals, funding statements, consent forms,
     generic study registration, "future research is needed", "we conducted a study"
  4. NOT REDUNDANT — do not include near-duplicate statements

  PRIORITY RULES (what to include and mark "high"):
  - Primary outcomes with effect sizes, CIs, p-values → always include, mark "high"
  - Background facts that directly justify the research question (prevalence, mechanism,
    burden of disease, gap in evidence) → include if specific and citable, mark "high"
  - Study design + sample size (1 sentence max) → "medium"
  - Comparison with other work that contradicts or confirms this paper → "high"
  - Major clinical/policy implications directly related to the research question → "high"
  - Secondary outcomes, subgroup analyses → "medium" only if relevant to research question
  - Limitations that affect interpretation → "medium" (1–2 max)

  LIMITS:
  - Maximum 3 background sentences per paper
  - Maximum 1 methods sentence per paper (design + N in one sentence)
  - Maximum 5 results sentences per paper (primary outcome first, then secondary)
  - Maximum 3 discussion/conclusion sentences per paper
  - When text_source is "abstract_only": 2–5 sentences (results + conclusion only)
"""

_USER_TMPL = """\
Research question / key idea: {query}

Paper metadata (supplementary — not authoritative, verify against text):
  Title   : {title}
  Authors : {authors}
  Journal : {journal}
  Year    : {year}
  DOI     : {doi}
  PMID    : {pmid}
  Text source: {text_source_label}

--- BEGIN PAPER TEXT ---
{text}
--- END PAPER TEXT ---

Perform a 3-pass extraction and return a SINGLE JSON object with EXACTLY this structure.
Use "NR" for any field where information is not present in the text.

{{
  "triage": {{
    "category": "One of: RCT | cohort | case-control | cross-sectional | SR/MA | qualitative | instrument_development | computational | case_series | editorial_opinion | other",
    "context": "2-3 sentences: the field, the clinical/research problem, why this question matters",
    "correctness_flags": ["Any methodological assumption or integrity concern worth flagging"],
    "contributions": ["Genuinely new contribution not previously established in literature"],
    "clarity_score_1_5": 4,
    "decision": "include | exclude | maybe",
    "decision_reason": "One sentence explaining the include/exclude/maybe decision"
  }},

  "bibliography": {{
    "title": "Full title from the paper text (may differ from metadata)",
    "authors": ["Surname FM", "Surname2 AB"],
    "year": 2023,
    "journal": "Full journal name",
    "doi": "10.xxxx/...",
    "pmid": "NR",
    "volume": "12",
    "issue": "3",
    "pages": "123-145"
  }},

  "methods": {{
    "study_design": "e.g. Double-blind RCT, prospective cohort, SR with meta-analysis",
    "setting": "Country, site type (hospital/community/online), recruitment period",
    "sample_n": "Total N; subgroups if relevant (e.g. N=245; intervention=123, control=122)",
    "inclusion_criteria": "As stated verbatim in text",
    "exclusion_criteria": "As stated verbatim in text",
    "variables_independent": ["IV1", "IV2"],
    "variables_dependent": ["DV1"],
    "variables_covariates": ["covariate1", "covariate2"],
    "intervention_or_exposure": "Name, dose, duration, fidelity check; or exposure/variable definition if observational",
    "comparator": "Control/comparator description, or NR",
    "primary_outcomes": ["Primary outcome with measurement instrument and timepoint"],
    "secondary_outcomes": ["Secondary outcome 1"],
    "statistical_methods": ["ANCOVA", "intention-to-treat analysis", "multiple imputation"],
    "funding": "Funding source(s) as stated in text",
    "conflicts_of_interest": "COI statement as stated, or NR",
    "preregistration": "Registry and number (e.g. ClinicalTrials.gov NCT12345678) or NR"
  }},

  "results": [
    {{
      "outcome": "Name of the outcome measure",
      "finding": "Direction and magnitude of result in plain language",
      "effect_size": "e.g. d=0.42 | OR=1.8 | HR=0.73 | RR=0.61 | β=0.31 | NR",
      "ci_95": "95% CI in brackets e.g. [0.31, 0.57] | NR",
      "p_value": "e.g. p=0.003 | p<0.001 | ns | NR",
      "supporting_quote": "Verbatim sentence(s) from the text that directly report this finding",
      "claim_type": "reported_fact | author_interpretation | inference"
    }}
  ],

  "limitations": [
    "Author-stated limitation 1",
    "Reviewer-identified methodological limitation (prefix with [Reviewer])"
  ],

  "critical_appraisal": {{
    "selection_bias": "Description of selection/sampling bias risk, or NR",
    "measurement_bias": "Blinding, recall, observer bias etc., or NR",
    "confounding": "Uncontrolled confounders or adjustment adequacy, or NR",
    "attrition": "Drop-out rate and how handled (ITT/PP/LOCF), or NR",
    "other_internal_validity_risks": ["Specific risk 1", "Specific risk 2"],
    "external_validity": "Generalisability concerns (population, setting, era)",
    "methodological_strengths": ["Preregistration", "Large sample", "Active comparator"],
    "reproducibility_signals": ["Preregistered at ClinicalTrials.gov", "Open data at OSF", "Code on GitHub"],
    "evidence_grade": "High | Moderate | Low | Very Low",
    "evidence_grade_justification": "1-2 sentences on GRADE-informed reasoning (risk of bias, consistency, directness, precision)"
  }},

  "evidence_quotes": [
    {{
      "claim_id": "result_0",
      "quote": "Verbatim quote from the paper supporting this claim",
      "page": null,
      "section": "Results"
    }}
  ],

  "missing_info": [
    "Information sought but absent: e.g. no ITT analysis reported",
    "Full-text unavailable — extraction from abstract only"
  ],

  "confidence": {{
    "overall": 0.75,
    "notes": "1-2 sentences on extraction confidence and key uncertainties (e.g. abstract-only, ambiguous reporting)"
  }},

  "one_line_takeaway": "In [population], [X] [leads to/is associated with] [Y] ([effect size]; [CI]; [p]); evidence certainty [High/Moderate/Low/Very Low].",

  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],

  "sentence_bank": [
    {{
      "section": "background | methods | results | discussion | conclusion",
      "text": "Clean paraphrased citable statement in active voice",
      "verbatim_quote": "Exact sentence(s) from the paper — required for results, optional for others",
      "claim_type": "reported_fact | author_interpretation | inference",
      "stats": "OR=1.8 [1.2, 2.7] p=0.003 — or empty string if no stats",
      "importance": "high | medium",
      "use_in": "introduction | methods | results | discussion"
    }}
  ],

  "introduction_claims": [
    {{
      "claim": "A key factual statement from the Introduction, ideally with numbers or established findings",
      "verbatim_quote": "Exact sentence(s) from the Introduction supporting this claim",
      "cited_ref_ids": ["1", "5"],
      "claim_type": "reported_fact | author_assertion"
    }}
  ],

  "discussion_insights": [
    {{
      "insight_type": "comparison | limitation | implication | future_direction",
      "text": "Concise paraphrase of the insight",
      "verbatim_quote": "Exact sentence(s) from the Discussion/Conclusion",
      "cited_ref_ids": ["3"]
    }}
  ],

  "cited_references": [
    {{
      "ref_id": "1",
      "doi": "10.xxxx/... or null",
      "title": "Title of the cited paper or null",
      "authors": ["Surname FM", "Surname2 AB"],
      "year": 2020,
      "journal": "Journal name or null",
      "raw_text": "Full formatted citation as it appears in the reference list"
    }}
  ]
}}
"""


# ── helpers ────────────────────────────────────────────────────────────────────

def _paper_key(paper: Paper) -> str:
    return (paper.doi or paper.title[:60]).lower().strip()


def _str_field(data: dict, key: str, fallback: str = "NR") -> str:
    v = data.get(key)
    s = str(v).strip() if v is not None else ""
    return s if s else fallback


def _list_field(data: dict, key: str) -> list[str]:
    v = data.get(key)
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [v.strip()]
    return []


def _opt_int(data: dict, key: str) -> Optional[int]:
    v = data.get(key)
    try:
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _opt_str(data: dict, key: str) -> Optional[str]:
    v = data.get(key)
    if isinstance(v, str) and v.strip() and v.strip().upper() not in ("NR", "N/A", ""):
        return v.strip()
    return None


# ── parsers for each section ──────────────────────────────────────────────────

def _parse_triage(raw: dict) -> Triage:
    d = raw if isinstance(raw, dict) else {}
    clarity = d.get("clarity_score_1_5", 3)
    try:
        clarity = max(1, min(5, int(clarity)))
    except (ValueError, TypeError):
        clarity = 3
    decision = _str_field(d, "decision", "maybe").lower()
    if decision not in ("include", "exclude", "maybe"):
        decision = "maybe"
    return Triage(
        category=_str_field(d, "category"),
        context=_str_field(d, "context"),
        correctness_flags=_list_field(d, "correctness_flags"),
        contributions=_list_field(d, "contributions"),
        clarity_score_1_5=clarity,
        decision=decision,
        decision_reason=_str_field(d, "decision_reason"),
    )


def _parse_bibliography(raw: dict, paper: Paper) -> PaperBibliography:
    d = raw if isinstance(raw, dict) else {}
    authors = d.get("authors")
    if not isinstance(authors, list) or not authors:
        authors = paper.authors
    return PaperBibliography(
        title=_str_field(d, "title") if _str_field(d, "title") != "NR" else paper.title,
        authors=[str(a).strip() for a in authors if str(a).strip()],
        year=_opt_int(d, "year") or paper.year,
        journal=_opt_str(d, "journal") or paper.journal,
        doi=_opt_str(d, "doi") or paper.doi,
        pmid=_opt_str(d, "pmid") or paper.pmid,
        volume=_opt_str(d, "volume"),
        issue=_opt_str(d, "issue"),
        pages=_opt_str(d, "pages"),
    )


def _parse_methods(raw: dict) -> ExtractionMethods:
    d = raw if isinstance(raw, dict) else {}
    return ExtractionMethods(
        study_design=_str_field(d, "study_design"),
        setting=_str_field(d, "setting"),
        sample_n=_str_field(d, "sample_n"),
        inclusion_criteria=_str_field(d, "inclusion_criteria"),
        exclusion_criteria=_str_field(d, "exclusion_criteria"),
        variables_independent=_list_field(d, "variables_independent"),
        variables_dependent=_list_field(d, "variables_dependent"),
        variables_covariates=_list_field(d, "variables_covariates"),
        intervention_or_exposure=_str_field(d, "intervention_or_exposure"),
        comparator=_str_field(d, "comparator"),
        primary_outcomes=_list_field(d, "primary_outcomes"),
        secondary_outcomes=_list_field(d, "secondary_outcomes"),
        statistical_methods=_list_field(d, "statistical_methods"),
        funding=_str_field(d, "funding"),
        conflicts_of_interest=_str_field(d, "conflicts_of_interest"),
        preregistration=_str_field(d, "preregistration"),
    )


def _parse_results(raw: list) -> list[ResultItem]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        claim_type = _str_field(item, "claim_type", "reported_fact")
        if claim_type not in ("reported_fact", "author_interpretation", "inference"):
            claim_type = "reported_fact"
        out.append(ResultItem(
            outcome=_str_field(item, "outcome"),
            finding=_str_field(item, "finding"),
            effect_size=_str_field(item, "effect_size"),
            ci_95=_str_field(item, "ci_95"),
            p_value=_str_field(item, "p_value"),
            supporting_quote=_str_field(item, "supporting_quote"),
            claim_type=claim_type,
        ))
    return out


def _parse_critical_appraisal(raw: dict) -> ExtractionCriticalAppraisal:
    d = raw if isinstance(raw, dict) else {}
    grade = _str_field(d, "evidence_grade", "Low")
    if grade not in ("High", "Moderate", "Low", "Very Low"):
        grade = "Low"
    return ExtractionCriticalAppraisal(
        selection_bias=_str_field(d, "selection_bias"),
        measurement_bias=_str_field(d, "measurement_bias"),
        confounding=_str_field(d, "confounding"),
        attrition=_str_field(d, "attrition"),
        other_internal_validity_risks=_list_field(d, "other_internal_validity_risks"),
        external_validity=_str_field(d, "external_validity"),
        methodological_strengths=_list_field(d, "methodological_strengths"),
        reproducibility_signals=_list_field(d, "reproducibility_signals"),
        evidence_grade=grade,
        evidence_grade_justification=_str_field(d, "evidence_grade_justification"),
    )


def _parse_quotes(raw: list) -> list[EvidenceQuote]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        page = item.get("page")
        try:
            page = int(page) if page is not None else None
        except (ValueError, TypeError):
            page = None
        out.append(EvidenceQuote(
            claim_id=_str_field(item, "claim_id"),
            quote=_str_field(item, "quote"),
            page=page,
            section=_str_field(item, "section"),
        ))
    return out


def _parse_intro_claims(raw: list) -> list[IntroductionClaim]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        claim_type = _str_field(item, "claim_type", "reported_fact")
        if claim_type not in ("reported_fact", "author_assertion"):
            claim_type = "reported_fact"
        ref_ids = item.get("cited_ref_ids")
        if isinstance(ref_ids, list):
            ref_ids = [str(r).strip() for r in ref_ids if str(r).strip()]
        else:
            ref_ids = []
        out.append(IntroductionClaim(
            claim=_str_field(item, "claim"),
            verbatim_quote=_str_field(item, "verbatim_quote"),
            cited_ref_ids=ref_ids,
            claim_type=claim_type,
        ))
    return out


def _parse_discussion_insights(raw: list) -> list[DiscussionInsight]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        insight_type = _str_field(item, "insight_type", "implication")
        if insight_type not in ("comparison", "limitation", "implication", "future_direction"):
            insight_type = "implication"
        ref_ids = item.get("cited_ref_ids")
        if isinstance(ref_ids, list):
            ref_ids = [str(r).strip() for r in ref_ids if str(r).strip()]
        else:
            ref_ids = []
        out.append(DiscussionInsight(
            insight_type=insight_type,
            text=_str_field(item, "text"),
            verbatim_quote=_str_field(item, "verbatim_quote"),
            cited_ref_ids=ref_ids,
        ))
    return out


def _parse_cited_references(raw: list) -> list[CitedReference]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        authors = item.get("authors")
        if not isinstance(authors, list):
            authors = []
        authors = [str(a).strip() for a in authors if str(a).strip()]
        doi = _opt_str(item, "doi")
        # Normalise DOI — strip leading URL prefix if present
        if doi and doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/"):]
        elif doi and doi.startswith("http://doi.org/"):
            doi = doi[len("http://doi.org/"):]
        out.append(CitedReference(
            ref_id=_str_field(item, "ref_id"),
            doi=doi,
            title=_opt_str(item, "title"),
            authors=authors,
            year=_opt_int(item, "year"),
            journal=_opt_str(item, "journal"),
            raw_text=_str_field(item, "raw_text"),
        ))
    return out


def _parse_confidence(raw: dict) -> ConfidenceScore:
    d = raw if isinstance(raw, dict) else {}
    overall = d.get("overall", 0.5)
    try:
        overall = max(0.0, min(1.0, float(overall)))
    except (ValueError, TypeError):
        overall = 0.5
    return ConfidenceScore(
        overall=overall,
        notes=_str_field(d, "notes"),
    )


def _parse_sentence_bank(raw: list) -> list[SentenceCitation]:
    valid_sections    = {"background", "methods", "results", "discussion", "conclusion"}
    valid_claim_types = {"reported_fact", "author_interpretation", "inference"}
    valid_importance  = {"high", "medium"}
    valid_use_in      = {"introduction", "methods", "results", "discussion"}
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        section = _str_field(item, "section", "").lower()
        if section not in valid_sections:
            section = "results"
        claim_type = _str_field(item, "claim_type", "reported_fact")
        if claim_type not in valid_claim_types:
            claim_type = "reported_fact"
        importance = _str_field(item, "importance", "medium").lower()
        if importance not in valid_importance:
            importance = "medium"
        use_in = _str_field(item, "use_in", "").lower()
        if use_in not in valid_use_in:
            # Infer from section if missing
            use_in = {
                "background": "introduction",
                "methods":    "methods",
                "results":    "results",
                "discussion": "discussion",
                "conclusion": "discussion",
            }.get(section, "discussion")
        text = _str_field(item, "text", "")
        if not text:
            continue
        out.append(SentenceCitation(
            section=section,
            text=text,
            verbatim_quote=_str_field(item, "verbatim_quote", ""),
            claim_type=claim_type,
            stats=_str_field(item, "stats", ""),
            importance=importance,
            use_in=use_in,
        ))
    # Ensure high-importance sentences come first
    out.sort(key=lambda s: (0 if s.importance == "high" else 1))
    return out


# ── main entry point ──────────────────────────────────────────────────────────

async def summarize_paper(
    provider: AIProvider,
    paper: Paper,
    query: str,
    fetch_settings: Optional[FetchSettings] = None,
    session_id: str = "",
    progress_cb: Optional[Callable[[str], Awaitable[None]]] = None,
) -> PaperSummary:
    """
    3-pass evidence extraction (+ intro/discussion) for a single paper.
    Fetches best available text (PMC XML > OA PDF > DOI/institutional > Sci-Hub > abstract)
    then runs the structured extraction prompt.
    """
    if progress_cb:
        await progress_cb("Fetching full text…")
    text, text_source = await fetch_full_text(paper, fetch_settings=fetch_settings)

    authors_str = "; ".join(paper.authors[:6]) or "Unknown"
    if len(paper.authors) > 6:
        authors_str += " et al."

    no_text_note = (
        "(No text available — extract from title and metadata only; "
        "mark all fields NR unless clearly evident from the title or abstract.)"
    )

    user_prompt = _USER_TMPL.format(
        query=query or "general academic research",
        title=paper.title,
        authors=authors_str,
        journal=paper.journal or "NR",
        year=paper.year or "NR",
        doi=paper.doi or "NR",
        pmid=paper.pmid or "NR",
        text_source_label=SOURCE_LABEL.get(text_source, text_source),
        text=text if text else no_text_note,
    )

    if progress_cb:
        await progress_cb("Running AI extraction…")
    raw = await provider.complete(
        system=_SYSTEM,
        user=user_prompt,
        json_mode=True,
        temperature=0.05,  # near-deterministic for evidence extraction
    )

    # Robust JSON extraction
    if progress_cb:
        await progress_cb("Parsing results…")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse JSON for paper %r", paper.title[:40])
            data = {}

    # ── Parse LLM output ──────────────────────────────────────────────────────
    bibliography = _parse_bibliography(data.get("bibliography", {}), paper)

    # ── CrossRef enrichment (Zotero-style) ───────────────────────────────────
    if progress_cb:
        await progress_cb("Enriching metadata…")
    # Fetch authoritative bibliographic metadata from CrossRef so that author
    # names, journal title, volume, issue, and pages are always correct —
    # regardless of what the LLM extracted from the paper text.
    doi_for_lookup = bibliography.doi or paper.doi
    if doi_for_lookup:
        try:
            crossref = await fetch_doi_metadata(doi_for_lookup)
            if crossref:
                updates: dict = {}

                # Authors — CrossRef gives family + given separately, fully reliable
                if crossref.get("author"):
                    formatted = []
                    for a in crossref["author"]:
                        if a.get("family") and a.get("given"):
                            formatted.append(f"{a['family']}, {a['given']}")
                        elif a.get("family"):
                            formatted.append(a["family"])
                        elif a.get("literal"):
                            formatted.append(a["literal"])
                    if formatted:
                        updates["authors"] = formatted

                # Journal name
                if crossref.get("container-title"):
                    updates["journal"] = crossref["container-title"]

                # Publication year
                if crossref.get("issued", {}).get("date-parts"):
                    parts = crossref["issued"]["date-parts"][0]
                    if parts:
                        updates["year"] = parts[0]

                # Volume / issue / pages
                if crossref.get("volume"):
                    updates["volume"] = str(crossref["volume"])
                if crossref.get("issue"):
                    updates["issue"] = str(crossref["issue"])
                if crossref.get("page"):
                    updates["pages"] = str(crossref["page"])

                if updates:
                    bibliography = bibliography.model_copy(update=updates)
                    logger.debug(
                        "CrossRef enriched bibliography for %s: %s",
                        doi_for_lookup,
                        list(updates.keys()),
                    )
        except Exception as exc:
            logger.debug("CrossRef enrichment failed for %s: %s", doi_for_lookup, exc)

    full_text_used = text_source in ("pmc_xml", "full_pdf", "full_html")

    # Sentence bank — extracted for all text sources (fewer sentences for abstract-only)
    sentence_bank = _parse_sentence_bank(data.get("sentence_bank", []))

    # Only parse intro/discussion fields when full text was available
    intro_claims:    list[IntroductionClaim] = []
    disc_insights:   list[DiscussionInsight] = []
    cited_refs:      list[CitedReference]    = []
    if full_text_used:
        intro_claims  = _parse_intro_claims(data.get("introduction_claims", []))
        disc_insights = _parse_discussion_insights(data.get("discussion_insights", []))
        cited_refs    = _parse_cited_references(data.get("cited_references", []))

    summary = PaperSummary(
        paper_key=_paper_key(paper),
        full_text_used=full_text_used,
        text_source=text_source,
        triage=_parse_triage(data.get("triage", {})),
        bibliography=bibliography,
        methods=_parse_methods(data.get("methods", {})),
        results=_parse_results(data.get("results", [])),
        limitations=_list_field(data, "limitations"),
        critical_appraisal=_parse_critical_appraisal(data.get("critical_appraisal", {})),
        evidence_quotes=_parse_quotes(data.get("evidence_quotes", [])),
        missing_info=_list_field(data, "missing_info"),
        confidence=_parse_confidence(data.get("confidence", {})),
        one_line_takeaway=_str_field(data, "one_line_takeaway"),
        keywords=_list_field(data, "keywords"),
        sentence_bank=sentence_bank,
        introduction_claims=intro_claims,
        discussion_insights=disc_insights,
        cited_references=cited_refs,
    )

    # Write BibTeX entry to the project .bib file whenever a save folder is configured.
    if fetch_settings:
        from services.paper_fetcher import _effective_save_path
        _bib_folder = _effective_save_path(fetch_settings)
        if _bib_folder and session_id:
            try:
                from services.bibtex_generator import append_to_project_bib
                append_to_project_bib(session_id, _bib_folder, summary)
            except Exception as exc:
                logger.debug("BibTeX write failed for %s: %s", paper.title[:40], exc)

    return summary
