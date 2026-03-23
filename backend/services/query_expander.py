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
  • Framework selection: 8 frameworks — PICO / PECO / SPIDER / PEO (clinical)
    and CONCEPT_BASED / THEMATIC / METHODOLOGY_FOCUSED / INTERDISCIPLINARY (non-clinical)
  • Topic-aware selection: does NOT default to PICO for non-clinical topics
  • Facet-based construction (concept blocks → Boolean combination)
  • Three error classes avoided: Strategic / Tactical / Logical
  • High-recall imperative: omissions weaken the article foundation
  • Database-specific syntax (PubMed vs general text search)
  • AmE/BrE spelling variants, truncation, trade names, older terminology,
    theory names, school-of-thought terminology, discipline-specific jargon
  • Pearl-growing validation before output
  • Self-check for common mistakes before output

Produces:
  • framework_used   — one of 8 frameworks + justification
  • framework_elements — framework-specific decomposition (generalizes PICO)
  • facets           — structured concept blocks (mesh + freetext per facet)
  • queries          → 8-12 varied text strings for OpenAlex, Semantic Scholar, Crossref
  • pubmed_queries   → 4-5 for clinical, 0-3 for non-clinical topics
  • mesh_terms       → NLM MeSH descriptors (fewer/none for non-clinical)
  • boolean_query    → master faceted Boolean expression
  • pico             → Population / Intervention / Comparator / Outcome (clinical only)
  • study_type_filters
  • strategy_notes   → self-identified quality/completeness flags
  • question_type    → intervention / exposure / qualitative / conceptual_theoretical /
                        thematic_narrative / methodological / interdisciplinary
  • rationale
"""

import json
import logging
import re
from dataclasses import dataclass, field

from services.ai_provider import AIProvider
from services.completion_guard import CompletionConfig, OutputFormat
from services.search_guidelines import get_search_strategy_guidelines

logger = logging.getLogger(__name__)

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in",
    "into", "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "use",
    "using", "want", "we", "with", "write", "about", "review", "paper", "study", "research",
}
_TITLE_SMALL_WORDS = {
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "via",
}
_GENERIC_TITLE_PREFIXES = (
    "most research",
    "most psychological research",
    "this study",
    "the present study",
    "the current study",
    "background",
    "objective",
    "research is",
    "research on",
    "many studies",
    "little is known",
)


def _normalize_ws(text: str) -> str:
    return " ".join((text or "").strip().split())


def sanitize_project_title(text: str) -> str:
    cleaned = _normalize_ws((text or "").replace("_", " ").replace("-", " "))
    cleaned = cleaned.strip(" \t\r\n-_:;,.")
    return cleaned[:160].strip()


def _title_case(text: str) -> str:
    parts = sanitize_project_title(text).split()
    if not parts:
        return ""

    out: list[str] = []
    for i, word in enumerate(parts):
        if word.isupper() and len(word) <= 6:
            out.append(word)
            continue
        lower = word.lower()
        if 0 < i < len(parts) - 1 and lower in _TITLE_SMALL_WORDS:
            out.append(lower)
            continue
        if any(ch.isdigit() for ch in word):
            out.append(word.upper() if len(word) <= 6 else word.capitalize())
            continue
        out.append(lower.capitalize())
    return " ".join(out)


def _looks_like_query_prefix(title: str, source: str) -> bool:
    clean_title = sanitize_project_title(title).lower()
    clean_source = sanitize_project_title(source).lower()
    if not clean_title:
        return True
    if clean_title == clean_source:
        return True
    if clean_source.startswith(clean_title) and len(clean_source) > len(clean_title) + 20:
        return True

    title_words = re.findall(r"[a-z0-9]+", clean_title)
    source_words = re.findall(r"[a-z0-9]+", clean_source)
    if len(title_words) >= 4 and source_words[:len(title_words)] == title_words:
        return True
    return any(clean_title.startswith(prefix) for prefix in _GENERIC_TITLE_PREFIXES)


def looks_like_low_quality_title(title: str) -> bool:
    raw = str(title or "")
    clean = sanitize_project_title(raw)
    if not clean:
        return True
    if any(marker in raw for marker in ("*", "`", "{", "}")):
        return True

    words = re.findall(r"[A-Za-z0-9]+", clean)
    if len(words) < 4 or len(words) > 18:
        return True
    if words[0].lower() in {"and", "or", "of", "in", "on", "for", "with", "to", "from"}:
        return True
    if re.match(r"^(title|working title|tentative title|core concept|focus|topic)\b", clean, re.I):
        return True
    if any(re.fullmatch(r"(and|or|of|in|on|for|with|to)[a-z]{4,}", word.lower()) for word in words[1:]):
        return True
    if any(word.lower() in {"including", "includes"} for word in words):
        return True
    return False


def _title_prefix_candidate(text: str) -> str:
    raw = text or ""
    first_line = raw.splitlines()[0].strip() if raw.strip() else ""
    first_chunk = re.split(r"\s{2,}|[:]\s{2,}", raw, maxsplit=1)[0].strip()
    for candidate in (first_line, first_chunk):
        cleaned = sanitize_project_title(candidate)
        words = cleaned.split()
        separated_title = bool(first_line and candidate == first_line and "\n\n" in raw)
        separated_title = separated_title or bool(first_chunk and candidate == first_chunk and re.search(r"\s{2,}", raw))
        if 4 <= len(words) <= 18 and (separated_title or not _looks_like_query_prefix(cleaned, raw)):
            return _title_case(cleaned)
    return ""


def _extract_focus_phrase(text: str) -> str:
    dash_match = re.search(r"\b([A-Za-z][A-Za-z\s]{3,80}?)\s*[—-]\s*", text or "")
    if dash_match:
        candidate = _title_case(dash_match.group(1))
        if 1 < len(candidate.split()) <= 8 and not _looks_like_query_prefix(candidate, text):
            return candidate

    lowered = _normalize_ws(text).lower()
    repeated: dict[str, int] = {}
    tokens = re.findall(r"[a-z0-9]+", lowered)
    for n in (3, 2):
        for i in range(0, max(len(tokens) - n + 1, 0)):
            chunk = tokens[i:i+n]
            if any(token in _STOPWORDS for token in chunk):
                continue
            phrase = " ".join(chunk)
            repeated[phrase] = repeated.get(phrase, 0) + 1
        best = sorted(
            (
                (phrase, count)
                for phrase, count in repeated.items()
                if len(phrase.split()) == n
            ),
            key=lambda item: (-item[1], -len(item[0])),
        )
        if best and (best[0][1] > 1 or n == 2):
            return _title_case(best[0][0])
    return ""


def _infer_context_phrase(text: str) -> str:
    lowered = (text or "").lower()
    context_patterns = (
        ("psychology", "Psychology"),
        ("psychological", "Psychology"),
        ("mental health", "Mental Health"),
        ("emerging adults", "Emerging Adults"),
        ("young adults", "Young Adults"),
        ("adolescents", "Adolescents"),
        ("college students", "College Students"),
        ("university students", "University Students"),
        ("healthcare workers", "Healthcare Workers"),
        ("patients", "Patients"),
    )
    for needle, label in context_patterns:
        if needle in lowered:
            return label
    return ""


def heuristic_tentative_title(original: str, article_type: str = "") -> str:
    """Build a readable working title when AI query expansion is unavailable."""
    cleaned = re.sub(r"[^\w\s\-/:,()]+", " ", original or "")
    cleaned = _normalize_ws(cleaned)
    if not cleaned:
        return "Research Project"

    explicit_title = _title_prefix_candidate(original)
    if explicit_title:
        return explicit_title

    topic = _extract_focus_phrase(original or "")
    context = _infer_context_phrase(cleaned)

    if not topic:
        terms = _extract_terms(cleaned)
        topic = _title_case(" ".join(terms[:5]))

    if context and context.lower() not in topic.lower():
        topic = f"{topic} in {context}".strip()

    suffix_map = {
        "systematic_review": "A Systematic Review",
        "meta_analysis": "A Meta-analysis",
        "scoping_review": "A Scoping Review",
        "review": "A Narrative Review",
        "original_research": "An Evidence Review",
        "study_protocol": "A Study Protocol",
    }
    suffix = suffix_map.get((article_type or "").strip().lower(), "A Literature Review")
    topic = sanitize_project_title(topic) or "Research Project"
    if re.search(r"\b(review|analysis|protocol|trial|study)\b", topic, re.I):
        return topic
    return f"{topic}: {suffix}"


async def generate_tentative_title(
    provider: AIProvider,
    key_idea: str,
    article_type: str = "",
) -> str:
    """Generate a concise academic working title from a long idea or abstract."""
    fallback = heuristic_tentative_title(key_idea, article_type=article_type)
    prefix_title = _title_prefix_candidate(key_idea)
    if prefix_title:
        return prefix_title
    try:
        article_type_hint = article_type.replace("_", " ").strip() or "research article"
        response = await provider.guarded_complete(
            system=(
                "You generate concise academic project titles from a research idea, abstract, or protocol summary. "
                "Return exactly one line in this format: TITLE: <title>"
            ),
            user=(
                "Generate a working title for this project.\n\n"
                f"Article type: {article_type_hint}\n"
                f"Source text:\n{key_idea}\n\n"
                "Rules:\n"
                "- Use Title Case.\n"
                "- 8 to 16 words.\n"
                "- Infer the real topic; do not copy the opening words of the source text.\n"
                "- Prefer specific constructs, population, and context when available.\n"
                "- No markdown, no explanation, no trailing period.\n"
                "- Keep it suitable as a manuscript working title.\n"
            ),
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                explicit_max_tokens=80,
                max_continuations=0,
            ),
            json_mode=False,
            temperature=0.2,
        )
        if response.was_truncated:
            return fallback
        raw = response.text
        line = ""
        for candidate in (raw or "").splitlines():
            candidate = candidate.strip()
            if candidate:
                line = candidate
                break
        line = line.replace("*", "").replace("`", "").strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                line = str(data.get("tentative_title") or "").strip()
            except Exception:
                pass
        if ":" in line:
            prefix, suffix = line.split(":", 1)
            prefix_words = re.findall(r"[a-z]+", prefix.lower())
            if prefix_words and set(prefix_words).issubset({"title", "working", "tentative", "project", "core", "concept", "focus", "topic"}):
                line = suffix.strip()
        if line.upper().startswith("TITLE:"):
            line = line.split(":", 1)[1].strip()
        title = sanitize_project_title(line.strip("\"'` "))
        if not title or _looks_like_query_prefix(title, key_idea) or looks_like_low_quality_title(title):
            return fallback
        return _title_case(title)
    except Exception as exc:
        logger.warning("Tentative title generation failed (%s). Using heuristic fallback.", exc)
        return fallback


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
        study_type_filters=[],
        rationale=rationale,
        facets={},
        strategy_notes=strategy_notes,
        framework_used="Heuristic",
        framework_justification="AI provider unavailable; using keyword compression fallback.",
        tentative_title=heuristic_tentative_title(original, article_type=article_type),
        framework_elements={},
        pico=None,
        question_type=None,
        search_mode="regular_article",
        secondary_frameworks_considered=[],
    )

# ── Allowed frameworks ─────────────────────────────────────────────────────────

ALLOWED_FRAMEWORKS = {
    "PICO", "PECO", "PEO", "SPIDER",
    "CONCEPT_BASED", "THEMATIC", "METHODOLOGY_FOCUSED", "INTERDISCIPLINARY",
}

_CLINICAL_FRAMEWORKS = {"PICO", "PECO", "PEO", "SPIDER"}

# ── System prompt ──────────────────────────────────────────────────────────────

_SYSTEM = """\
You are a senior research information specialist with deep expertise across \
clinical research, social sciences, humanities, and interdisciplinary studies. \
You build rigorous, high-recall search strategies adapted to the nature of the \
research topic — whether clinical, conceptual, thematic, methodological, or \
interdisciplinary.

For clinical topics you draw on Cochrane Handbook Ch.6, MECIR standards, and \
Bramer et al. (2018) optimal database combination methodology. For non-clinical \
topics you apply concept-mapping, thematic decomposition, and discipline-aware \
terminology strategies.

══════════════════════════════════════════════════════════════════════════
CRITICAL ANTI-PATTERN RULE
══════════════════════════════════════════════════════════════════════════

Do NOT force conceptual, historical, thematic, or methodological topics into
Population–Intervention–Comparator–Outcome format unless the topic naturally
warrants it. Many research topics have no intervention, no comparator, and
no clinical outcome. Use the framework that fits the topic, not a default.

══════════════════════════════════════════════════════════════════════════
STEP 0 — FRAMEWORK SELECTION  (choose BEFORE decomposing concepts)
══════════════════════════════════════════════════════════════════════════

Analyze the research topic and article type, then select the most appropriate
framework from the 8 options below. Do NOT default to PICO.

─── Clinical / Evidence-Based Frameworks ───

  PICO   → clinical interventions, RCTs, drug/treatment comparisons,
            therapy development, intervention efficacy, rehabilitation
            (Population · Intervention · Comparator · Outcome)
            Example: "Develop therapy for stroke"

  PECO   → exposure/risk questions, epidemiology, environmental health,
            predictors, associations, correlates
            (Population · Exposure · Comparator · Outcome)
            Example: "Risk factors for childhood asthma"

  PEO    → non-comparative observational, broad experience + outcome,
            health services, population needs
            (Population · Exposure/Experience · Outcome)
            Example: "Patient experience after kidney transplant"

  SPIDER → qualitative or mixed-methods — phenomenology, grounded theory,
            thematic analysis, lived experience, perceptions, views
            (Sample · Phenomenon of Interest · Design · Evaluation · Research type)
            Example: "Therapist views on teletherapy"

─── Non-Clinical / Academic Writing Frameworks ───

  CONCEPT_BASED → theoretical, conceptual, historical, debate-driven,
                   school-of-thought, philosophy-of-science, intellectual history,
                   meta-science topics with no natural clinical decomposition
            (Core concepts · Related concepts/synonyms · Key theories/frameworks ·
             Seminal authors · Schools of thought/camps · Historical roots ·
             Current debates/applications)
            Examples: "Adversarial Collaboration in psychology",
                      "Replication crisis in psychology",
                      "Psychoanalysis in India",
                      "Agency and resilience in epics"

  THEMATIC → narrative reviews, editorials, commentary, opinion, issue-mapping,
              broad overviews, position-style manuscripts
            (Main themes · Sub-themes · Contextual factors · Populations/settings ·
             Time trends · Emerging issues · Contrasting positions)
            Examples: "State of psychoanalysis in India",
                      "Ethical blind spots in psychiatry",
                      "Digital mental health in India",
                      "Burnout among clinicians: a narrative review"

  METHODOLOGY_FOCUSED → methods, measurement, statistics, design critique,
                          validity, bias, psychometrics, open science, research
                          practice topics
            (Method/approach name · Variants/related methods · Applications/use cases ·
             Limitations/bias/criticism · Competing methods · Domains of application ·
             Evaluation criteria)
            Examples: "Adversarial testing in psychology",
                      "Bias in neuropsychological assessment",
                      "Problems with self-report measurement",
                      "Ecological validity in neuropsychology"

  INTERDISCIPLINARY → topics spanning 2+ major academic disciplines with
                       different terminologies
            (Core cross-disciplinary concept · Discipline-specific terminology blocks ·
             Equivalent terms across fields · Bridge concepts ·
             Major disciplinary lenses · Applied contexts)
            Examples: "AI-assisted psychotherapy",
                      "Climate change and mental health policy",
                      "Digital phenotyping in psychiatry",
                      "Neurocognitive rehabilitation using adaptive technology"

─── Selection Rules ───

  • Treatment/therapy/intervention/efficacy/trial/comparative outcomes → PICO
  • Risk factor/exposure/predictor/correlates/epidemiology → PECO
  • Non-comparative empirical/observational → PEO
  • Explicitly qualitative/lived experience/perceptions → SPIDER
  • Theoretical/conceptual/historical/debate/school-of-thought → CONCEPT_BASED
  • Narrative review/commentary/editorial/opinion/broad thematic → THEMATIC
  • Methods/measurement/statistics/validity/bias/design → METHODOLOGY_FOCUSED
  • Spans 2+ distinct disciplines with different terminologies → INTERDISCIPLINARY

  Hard overrides by article_type:
  • "systematic_review", "meta_analysis", "scoping_review" → MUST use PICO or PECO
  • "editorial", "opinion", "letter" → prefer THEMATIC or CONCEPT_BASED
  • "qualitative" → prefer SPIDER

  If the topic does not naturally have an intervention, comparator, or clinical
  outcome, do NOT use PICO/PECO/PEO — use CONCEPT_BASED, THEMATIC,
  METHODOLOGY_FOCUSED, or INTERDISCIPLINARY instead.

Record:
  • "framework_used" — one of the 8 framework names above
  • "framework_justification" — 1-2 sentences explaining why
  • "question_type" — one of: intervention, exposure, qualitative,
    conceptual_theoretical, thematic_narrative, methodological, interdisciplinary
  • "secondary_frameworks_considered" — list of 0-2 other frameworks considered

══════════════════════════════════════════════════════════════════════════
STEP 1 — CONCEPT DECOMPOSITION  (based on chosen framework)
══════════════════════════════════════════════════════════════════════════

Decompose the research topic into concept facets based on the selected framework.
Each facet becomes a separate Boolean OR-block in the search strategy.
Do NOT add study-design filters as a main facet — apply as a separate block.

  PICO:   Population AND Intervention (AND Comparator) AND Outcome
  PECO:   Population AND Exposure AND Comparator AND Outcome
  PEO:    Population AND Exposure/Experience AND Outcome
  SPIDER: Sample AND Phenomenon of Interest AND Design AND Evaluation

  CONCEPT_BASED:
    Core concepts AND Related theories/frameworks (AND Seminal authors if applicable)
    Facet keys: core_concepts, related_concepts, key_theories, seminal_authors,
                schools_of_thought, historical_roots, current_debates

  THEMATIC:
    Main themes AND Sub-themes AND Contextual factors
    Facet keys: main_themes, sub_themes, contextual_factors, populations_settings,
                time_trends, emerging_issues, contrasting_positions

  METHODOLOGY_FOCUSED:
    Method core AND Application domains AND Comparative methods
    Facet keys: method_name, variants, applications, limitations,
                competing_methods, domains, evaluation_criteria

  INTERDISCIPLINARY:
    Field A terms AND Field B terms AND Bridge concepts
    Facet keys: core_concept, discipline_a, discipline_b, equivalences,
                bridge_concepts, disciplinary_lenses, applied_contexts

══════════════════════════════════════════════════════════════════════════
STEP 2 — SYSTEMATIC SYNONYM COLLECTION  (for every facet)
══════════════════════════════════════════════════════════════════════════

For EVERY concept collect ALL applicable layers:

  A. CONTROLLED VOCABULARY (for clinical/biomedical topics)
     • Preferred MeSH descriptor (exploded) + relevant subheadings
     • Emtree equivalents where different from MeSH
     • Broader MeSH terms when the exact concept may not be indexed
     NOTE: For non-clinical topics (CONCEPT_BASED, THEMATIC, METHODOLOGY_FOCUSED,
     INTERDISCIPLINARY), MeSH terms may be sparse or absent — that is expected.

  B. FREE-TEXT SYNONYMS
     • Preferred/current term
     • Historical/older terminology
     • Trade names AND generic names (clinical topics)
     • Abbreviations AND spelled-out forms
     • AmE AND BrE spelling variants where applicable
     • Plural/singular when truncation doesn't capture both
     • Truncated stems with * where root covers ≥2 relevant forms
       — avoid stems shorter than 4 characters (too much noise)

  C. ACADEMIC / DISCIPLINE-SPECIFIC TERMINOLOGY
     • Theory names and their variants
       (e.g. "adversarial collaboration" vs "structured academic adversary")
     • School-of-thought terminology
       (e.g. "psychoanalytic" vs "psychodynamic")
     • Discipline-specific jargon that may differ across fields
       (e.g. "ecological validity" in neuropsych vs "external validity" in general)
     • Seminal author names where relevant to the concept
     • Methodological terminology variants

  D. ADJACENT / BROADER CONCEPT TERMS
     • Broader synonyms that would appear in review article titles
     • Related topics, conditions, or debates that are frequently co-studied
     • Mechanism/pathophysiology terms (clinical) OR theoretical-mechanism terms (non-clinical)

══════════════════════════════════════════════════════════════════════════
STEP 3 — BOOLEAN COMBINATION
══════════════════════════════════════════════════════════════════════════

  Within a facet → connect ALL synonyms with OR (maximise recall)
  Between facets  → connect with AND (define scope)
  Phrase multi-word terms in double quotes: "type 2 diabetes"
  Truncate word stems: diabet* · therap* · cardiovascular*
  Avoid AND NOT except for well-defined, unambiguous exclusions.

══════════════════════════════════════════════════════════════════════════
STEP 4 — PubMed QUERY CONSTRUCTION
══════════════════════════════════════════════════════════════════════════

For CLINICAL topics (PICO, PECO, PEO, SPIDER): Generate 4-5 PubMed-specific
query strings covering complementary angles:
  1. MeSH-only strategy — maximum precision
  2. MeSH + free-text combination — balanced recall/precision
  3. Free-text only — catches recent/unindexed papers (MeSH lags 6-12 months)
  4. Study design filter variant — add RCT/review filter block
  5. Outcome/mechanism-specific angle (optional)

For NON-CLINICAL topics (CONCEPT_BASED, THEMATIC, METHODOLOGY_FOCUSED,
INTERDISCIPLINARY): Generate 0-3 PubMed queries ONLY if the topic has
health/psychology/biomedical relevance. Otherwise return an empty list.
Non-clinical topics often have their primary literature outside PubMed.

  Rules:
  • Always use [MeSH Terms] NOT [mh]
  • Use [tiab] for title/abstract free-text
  • Use [pt] for publication type
  • ALL brackets must be balanced — check this explicitly
  • Do NOT invent MeSH descriptors — only use verified NLM terms

══════════════════════════════════════════════════════════════════════════
STEP 5 — GENERAL QUERY STRINGS  (8-12 strategies)
══════════════════════════════════════════════════════════════════════════

Generate 8-12 varied natural-language strings for OpenAlex, Semantic Scholar,
and Crossref (no field tags). Adapt the query angles to the chosen framework:

  For ALL frameworks:
  • Broad search lane — primary concept
  • Precise search lane — specific terminology
  • Synonym / alternate terminology lane
  • Recent developments lane (if applicable)

  Additional angles by framework type:

  PICO/PECO/PEO/SPIDER (clinical):
  • Population-specific angle
  • Intervention/exposure-specific angle
  • Outcome-focused angle
  • Mechanistic/pathophysiological angle
  • Older terminology variant (pre-2010)
  • Trade name / alternative name variant

  CONCEPT_BASED:
  • Theory-name queries
  • Foundational-author queries (e.g. "Kahneman Mellers adversarial collaboration")
  • School-of-thought queries
  • Debate / controversy queries
  • Current application queries
  • Historical roots queries

  THEMATIC:
  • Theme-based queries
  • Sub-theme queries
  • Context-specific queries
  • Trend / emerging issue queries
  • Contrasting position queries

  METHODOLOGY_FOCUSED:
  • Exact method name queries
  • Related method / variant queries
  • Criticism / limitation queries
  • Application-domain queries
  • Methods comparison queries

  INTERDISCIPLINARY:
  • Discipline A-specific queries
  • Discipline B-specific queries
  • Bridge concept queries
  • Hybrid queries combining terminology from both fields
  • Equivalent terminology variants across fields

  Rules:
  • 3-10 words per query; plain language; NO field tags
  • Each query must be meaningfully different
  • Prioritise variety over repetition

══════════════════════════════════════════════════════════════════════════
STEP 6 — STUDY DESIGN FILTER
══════════════════════════════════════════════════════════════════════════

For clinical topics: Apply as a SEPARATE block (do not embed in concept facets).
Use validated Cochrane Highly Sensitive Search Strategy filters for RCTs.
Adjust study design filters based on article_type provided.

For non-clinical topics: Use broad study type filters like
"review", "journal article", "commentary", or omit if not applicable.

══════════════════════════════════════════════════════════════════════════
STEP 7 — SELF-CHECK  (90% of published strategies have ≥1 error)
══════════════════════════════════════════════════════════════════════════

Check all three error classes (Sampson & McGowan 2006):
  ★ STRATEGIC: No overlapping/redundant facets. Operators correct.
               PubMed syntax valid (brackets balanced, field tags correct).
  ★ TACTICAL:  All major synonyms present (including trade names, older terms,
               AmE+BrE variants, abbreviations, theory names, school-of-thought
               terminology where applicable).
               MeSH terms are real NLM descriptors (not invented).
               Truncation wildcards are correct (not too short: ≥4 char stems).
  ★ LOGICAL:   OR within facets, AND between facets.
               NOT only if essential and unambiguous.
               Framework selection matches the topic (not forced PICO).

══════════════════════════════════════════════════════════════════════════
STEP 8 — PEARL GROWING VALIDATION
══════════════════════════════════════════════════════════════════════════

The "pearl growing" technique (Spence 2018, Bramer 2018):
  • Mentally identify 2-3 landmark papers in this field
  • Check: would this strategy retrieve those papers?
  • If not, identify which synonyms, author names, or concepts are missing
  • Add any missing terms, or note them in strategy_notes
  • Also check: would this strategy retrieve papers from BOTH
    indexed sources AND recent unindexed preprints?

══════════════════════════════════════════════════════════════════════════
HIGH-RECALL IMPERATIVE
══════════════════════════════════════════════════════════════════════════

Omitting a relevant study can weaken the article's foundation.
  • Prefer SENSITIVITY over PRECISION — retrieve broadly, screen later
  • Never restrict by language or date in the strategy itself
  • Search BOTH controlled vocabulary AND free-text synonyms for every concept
    (where controlled vocabulary exists)
  • MeSH indexing lags 6-12 months — free-text catches new publications

══════════════════════════════════════════════════════════════════════════
OUTPUT — Return ONLY valid JSON, no markdown, no text outside the object
══════════════════════════════════════════════════════════════════════════

The output structure MUST match the chosen framework. Here are two examples:

── Example A: Clinical topic (PICO) ──
{
  "framework_used": "PICO",
  "framework_justification": "The topic involves a clinical intervention and treatment comparison.",
  "question_type": "intervention",
  "secondary_frameworks_considered": ["PECO"],

  "framework_elements": {
    "population": "Stroke patients aged 18+",
    "intervention": "Novel rehabilitation therapy",
    "comparator": "Standard physical therapy",
    "outcome": "Motor function recovery, quality of life"
  },

  "facets": {
    "population": {
      "mesh": ["Stroke/rehabilitation", "Cerebrovascular Disorders"],
      "freetext": ["stroke patient*", "cerebrovascular accident", "CVA", "post-stroke"]
    },
    "intervention": {
      "mesh": ["Rehabilitation"],
      "freetext": ["rehabilitation therap*", "motor recovery", "physical therap*"]
    },
    "outcome": {
      "mesh": ["Recovery of Function", "Quality of Life"],
      "freetext": ["motor function", "functional recovery", "quality of life", "QoL"]
    }
  },

  "queries": ["8-12 varied queries..."],
  "pubmed_queries": ["4-5 PubMed-specific queries..."],
  "mesh_terms": ["4-10 real NLM MeSH descriptors..."],
  "boolean_query": "faceted Boolean expression",
  "pico": {
    "population": "Stroke patients aged 18+",
    "intervention": "Novel rehabilitation therapy",
    "comparator": "Standard physical therapy",
    "outcome": "Motor function recovery, quality of life"
  },
  "study_type_filters": ["randomized controlled trial", "systematic review"],
  "strategy_notes": ["self-assessment notes..."],
  "rationale": "4-5 sentence rationale...",
  "tentative_title": "10-15 word working title"
}

── Example B: Non-clinical topic (CONCEPT_BASED) ──
{
  "framework_used": "CONCEPT_BASED",
  "framework_justification": "The topic is theoretical and debate-oriented with no natural clinical decomposition.",
  "question_type": "conceptual_theoretical",
  "secondary_frameworks_considered": ["THEMATIC"],

  "framework_elements": {
    "core_concepts": ["adversarial collaboration"],
    "related_concepts": ["scientific disagreement", "theory testing", "replication reform"],
    "key_theories": ["philosophy of science", "open science"],
    "seminal_authors": ["Daniel Kahneman", "Barbara Mellers"],
    "schools_of_thought": ["open science reform", "theory criticism"],
    "historical_roots": ["replication crisis", "Meehl critique"],
    "current_debates": ["effectiveness of adversarial designs", "generalizability"]
  },

  "facets": {
    "core_concepts": {
      "mesh": [],
      "freetext": ["adversarial collaboration", "scientific disagreement", "theory testing"]
    },
    "related_concepts": {
      "mesh": [],
      "freetext": ["replication crisis", "open science", "replication reform"]
    },
    "seminal_authors": {
      "mesh": [],
      "freetext": ["Kahneman", "Mellers", "adversarial collaboration"]
    }
  },

  "queries": [
    "adversarial collaboration psychology",
    "adversarial collaboration behavioral science",
    "scientific disagreement psychology theory testing",
    "Kahneman Mellers adversarial collaboration",
    "replication crisis adversarial collaboration",
    "open science theory disagreement psychology",
    "adversarial collaboration outcomes methodology",
    "structured scientific debate psychology"
  ],
  "pubmed_queries": [
    "\\"adversarial collaboration\\" AND psychology",
    "(scientific disagreement OR theory testing) AND psychology"
  ],
  "mesh_terms": [],
  "boolean_query": "(\\"adversarial collaboration\\" OR \\"scientific disagreement\\") AND (psychology OR behavioral science)",
  "pico": null,
  "study_type_filters": ["review", "journal article"],
  "strategy_notes": ["Concept-centered search; not intervention-based.", "Prioritize seminal authors and debates."],
  "rationale": "This strategy captures conceptual foundations, adjacent debates, and major contributors...",
  "tentative_title": "Adversarial Collaboration in Psychology Foundations Debates and Applications"
}

══════════════════════════════════════════════════════════════════════════
FIELD RULES (applied after self-check and pearl growing)
══════════════════════════════════════════════════════════════════════════

• framework_used    — one of: PICO, PECO, SPIDER, PEO, CONCEPT_BASED,
                      THEMATIC, METHODOLOGY_FOCUSED, INTERDISCIPLINARY
• framework_justification — 1-2 sentences
• question_type     — one of: intervention, exposure, qualitative,
                      conceptual_theoretical, thematic_narrative,
                      methodological, interdisciplinary
• secondary_frameworks_considered — 0-2 other framework names
• framework_elements — keys depend on the framework (see STEP 1);
                       values are strings or lists of strings
• pico              — populate ONLY for PICO/PECO/PEO/SPIDER frameworks;
                      set to null for non-clinical frameworks
• facets            — concept blocks with mesh + freetext arrays;
                      keys match the framework decomposition (NOT always P/I/C/O);
                      freetext SHOULD include synonyms, older terms, abbreviations,
                      theory names, and truncated stems where applicable
• queries           — 8-12 strings; NO field tags; each covers a different angle
• pubmed_queries    — 4-5 for clinical topics; 0-3 for non-clinical topics;
                      [MeSH Terms] not [mh]; [tiab] for free-text;
                      ALL brackets balanced; no invented MeSH terms;
                      may be empty list for non-clinical topics
• mesh_terms        — 4-10 for clinical topics; 0-5 for non-clinical topics;
                      REAL NLM MeSH descriptors only
• boolean_query     — faceted display query; phrase multi-word terms; use *
• study_type_filters — 2-4 values
• strategy_notes    — honest self-assessment including pearl growing result
• rationale         — 3-5 sentences covering framework choice, terminology
                      decisions, scope, and pearl growing result
• tentative_title   — a concise, informative working title for this research
                      project (10-15 words); must follow academic title conventions.
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
    study_type_filters: list[str]    = field(default_factory=list)
    framework_used: str              = ""
    framework_justification: str     = ""
    strategy_notes: list[str]        = field(default_factory=list)
    rationale: str                   = ""
    tentative_title: str             = ""
    facets: dict                     = field(default_factory=dict)
    # Generalized framework decomposition (replaces PICO-only)
    framework_elements: dict         = field(default_factory=dict)
    # Backward compat — populated for PICO/PECO/PEO/SPIDER, None otherwise
    pico: dict | None                = None
    # New fields
    question_type: str | None        = None
    search_mode: str                 = "regular_article"
    secondary_frameworks_considered: list[str] = field(default_factory=list)


# ── Query expansion ───────────────────────────────────────────────────────────

async def expand_query(
    provider: AIProvider,
    key_idea: str,
    article_type: str = "",
) -> ExpandedQuery:
    """
    Call the LLM to expand key_idea into a full multi-database search strategy.

    Supports 8 frameworks: PICO, PECO, PEO, SPIDER (clinical) and
    CONCEPT_BASED, THEMATIC, METHODOLOGY_FOCUSED, INTERDISCIPLINARY (non-clinical).
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
                "methodology above. Select the most appropriate framework from "
                "PICO, PECO, PEO, SPIDER, CONCEPT_BASED, THEMATIC, "
                "METHODOLOGY_FOCUSED, or INTERDISCIPLINARY. Do NOT default to "
                "PICO — choose the framework that truly fits this topic. "
                "Generate 8-12 general queries and framework-appropriate PubMed "
                "queries (4-5 for clinical, 0-3 for non-clinical topics). "
                "Include synonyms, alternate terminology, and discipline-specific "
                "variants. Apply the pearl-growing validation and self-check "
                "before outputting."
            ),
            json_mode=True,
            temperature=0.2,
        )
        data = json.loads(raw)

        # Validate framework_used against allowed list
        raw_framework = data.get("framework_used") or "PICO"
        if raw_framework not in ALLOWED_FRAMEWORKS:
            logger.warning(
                "LLM returned unknown framework '%s'; falling back.", raw_framework
            )
            data.setdefault("strategy_notes", []).append(
                f"Framework '{raw_framework}' was not recognised; defaulted to CONCEPT_BASED."
            )
            raw_framework = "CONCEPT_BASED"

        # Enforce hard overrides: systematic review types must use clinical frameworks
        if article_type in ("systematic_review", "meta_analysis", "scoping_review"):
            if raw_framework not in {"PICO", "PECO"}:
                logger.warning(
                    "Article type '%s' requires PICO/PECO, got '%s'; overriding to PICO.",
                    article_type, raw_framework,
                )
                data.setdefault("strategy_notes", []).append(
                    f"Framework overridden to PICO: article type '{article_type}' requires PICO or PECO."
                )
                raw_framework = "PICO"

        # framework_elements is the primary decomposition field
        framework_elements = data.get("framework_elements") or {}

        # pico: populate for clinical frameworks, None for non-clinical
        raw_pico = data.get("pico")
        if raw_framework in _CLINICAL_FRAMEWORKS:
            pico = raw_pico if isinstance(raw_pico, dict) else framework_elements
        else:
            pico = None

        return ExpandedQuery(
            queries               = data.get("queries")               or [key_idea],
            pubmed_queries        = data.get("pubmed_queries")        or [],
            mesh_terms            = data.get("mesh_terms")            or [],
            boolean_query         = data.get("boolean_query")         or key_idea,
            study_type_filters    = data.get("study_type_filters")    or [],
            rationale             = data.get("rationale")             or "",
            facets                = data.get("facets")                or {},
            strategy_notes        = data.get("strategy_notes")        or [],
            framework_used        = raw_framework,
            framework_justification = data.get("framework_justification") or "",
            tentative_title       = data.get("tentative_title")       or "",
            framework_elements    = framework_elements,
            pico                  = pico,
            question_type         = data.get("question_type"),
            search_mode           = "regular_article",
            secondary_frameworks_considered = data.get("secondary_frameworks_considered") or [],
        )

    except Exception as exc:
        logger.warning("Query expansion failed (%s). Using heuristic fallback.", exc)
        return heuristic_expand_query(key_idea, article_type=article_type)
