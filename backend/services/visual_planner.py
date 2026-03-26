"""
services/visual_planner.py

AI-powered visual planning service that runs after article generation.
Suggests tables and figures to strengthen the manuscript, with exact
insertion points so they can be rendered inline in the draft view.

Public API
----------
plan_visuals(provider, article_text, article_type, query) -> VisualRecommendations
    Calls the AI in JSON mode and returns structured recommendations.

renumber_visuals(recs) -> VisualRecommendations
    Reassigns T1/T2/F1/F2 ids by order of appearance; updates citation_text.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Optional

from models import GeneratedVisual, VisualItem, VisualRecommendations
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# ── Visual guidance system prompt block ───────────────────────────────────────

_VISUAL_GUIDANCE = """
You are a scientific manuscript visual-planning assistant. Given a drafted
manuscript, its article type, and target research query, you recommend tables
and figures that would strengthen the manuscript.

RULES:
1. Soft density target: ~1 visual per 1,000 words. This is a ceiling.
   Zero recommendations is valid when no visual adds value.
2. Every item must add information the reader cannot grasp as quickly from
   the surrounding text. Never restate prose in visual form.
3. Tables: use for exact values, demographics, model outputs, study
   summaries, criteria lists, schedules.
   Figures: use for trends, distributions, relationships, mechanisms,
   workflows, timelines, conceptual models, reporting-guideline diagrams.
4. When the same data could be either format, choose the better fit and
   note the alternative_format field.
5. Each item must be self-explanatory with title + caption + footnotes.
6. Quality: no 3D effects, no pie charts unless parts-of-whole ≤5 slices,
   colorblind-safe, readable at publication size, minimal clutter, logical
   flow (left to right, top to bottom).
7. Use article-type defaults as priors but deviate when content warrants.
8. Assign priority: "essential" (reporting guidelines / core finding),
   "recommended" (materially improves comprehension), "optional" (nice-to-have).
9. render_mode field:
   - "matplotlib" → data-driven figures with axes/numbers/statistics
     (bar charts, scatter plots, forest plots, KM survival curves,
      PRISMA/CONSORT flowcharts that include participant counts)
   - "ai_illustration" → conceptual/schematic figures with NO data values
     (study design diagrams, biological pathway schematics, mechanism
      illustrations, workflow overviews, framework diagrams)
   - "table"      → ALL tables (never use matplotlib/imagen for tables)
10. For each item determine PLACEMENT:
    - insert_after: use format "after_paragraph:N" (0-indexed paragraph
      count in the full article text, counting only non-heading paragraphs)
      OR "after_heading:section name in lowercase" for section-level placement.
      Place as close as possible AFTER the first substantive mention of the data.
    - citation_text: APA 7th in-text reference, e.g. "(see Figure 1)" or
      "(Table 2)" or "as shown in Figure 1".
    - insert_citation_after: a sentence fragment (8–15 words, exact text
      match from the manuscript) after which the citation is inserted.
11. For each item provide all fields in the schema.
12. If zero items are justified, return empty items array with a clear empty_reason.
13. Do NOT generate actual data content — recommend placement and structure only.

ARTICLE-TYPE DEFAULTS:
- original_research / brief_report: participant demographics table; primary outcome figure; optional workflow
- systematic_review: PRISMA 2020 flow diagram (essential); characteristics table; evidence-summary table; risk-of-bias summary
- meta_analysis: all SR items + forest plot (essential); optional funnel plot
- review / narrative_review: synthesis table; conceptual figure; optional timeline
- scoping_review: PRISMA-ScR flow diagram; characteristics table; themes summary
- study_protocol: SPIRIT schedule table; workflow diagram; outcomes table
- case_report: timeline figure; diagnostic/lab table
- editorial / opinion / perspective: zero is baseline — only recommend if a table or figure materially clarifies
- letter / commentary / short_communication: almost always zero

Respond ONLY with valid JSON matching this schema (no markdown fences, no preamble):
{
  "summary": "...",
  "empty_reason": null,
  "items": [
    {
      "id": "T1",
      "type": "table",
      "title": "...",
      "target_section": "...",
      "insert_after": "after_paragraph:5",
      "purpose": "...",
      "data_to_include": ["..."],
      "suggested_structure": ["..."],
      "priority": "recommended",
      "supplementary": false,
      "alternative_format": null,
      "reporting_guideline": null,
      "render_mode": "table",
      "image_backend": null,
      "output_mode": "full_figure",
      "category": "generic",
      "status": "recommended",
      "citation_text": "(Table 1)",
      "insert_citation_after": "..."
    }
  ]
}
""".strip()


# ── Article-type heuristics for the user prompt ───────────────────────────────

_ARTICLE_TYPE_NOTES: dict[str, str] = {
    "systematic_review": "This is a systematic review — include a PRISMA 2020 flow diagram as essential.",
    "scoping_review": "This is a scoping review — include a PRISMA-ScR flow diagram and characteristics table.",
    "meta_analysis": "This is a meta-analysis — include a forest plot (essential) and funnel plot (recommended).",
    "original_research": "This is original research — include a participant demographics table and primary outcome figure.",
    "brief_report": "This is a brief report — keep visuals minimal (1–2 max). Participant table or primary outcome figure.",
    "case_report": "This is a case report — include a clinical timeline and diagnostic/lab results table.",
    "study_protocol": "This is a study protocol — include SPIRIT schedule, workflow diagram, and outcomes table.",
    "review": "This is a narrative review — include a synthesis table and conceptual figure if they add value.",
    "narrative_review": "This is a narrative review — include a synthesis table and conceptual figure if they add value.",
    "editorial": "This is an editorial — zero visuals is the baseline. Only recommend if clearly valuable.",
    "opinion": "This is an opinion piece — zero visuals is the baseline. Only recommend if clearly valuable.",
    "letter": "This is a letter — almost always zero visuals.",
    "short_communication": "This is a short communication — 1 visual maximum.",
}


def _count_words(text: str) -> int:
    return len(text.split())


def _parse_visual_json(raw: str) -> dict:
    """Strip markdown fences and parse JSON."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[^\n]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return json.loads(raw)


async def plan_visuals(
    provider: AIProvider,
    article_text: str,
    article_type: str,
    query: str,
) -> VisualRecommendations:
    """
    Run the visual planning AI call and return structured recommendations.

    Fails gracefully — any exception returns an empty VisualRecommendations
    rather than propagating (callers should log the exception).
    """
    word_count = _count_words(article_text)
    type_note = _ARTICLE_TYPE_NOTES.get(article_type, "")

    user_msg = (
        f"Article type: {article_type}\n"
        f"Research query: {query}\n"
        f"Word count: {word_count}\n"
        f"{type_note}\n\n"
        f"---MANUSCRIPT START---\n{article_text[:12000]}\n---MANUSCRIPT END---\n\n"
        f"Plan the tables and figures for this manuscript. "
        f"Return only valid JSON matching the schema above."
    )

    raw = await provider.complete(
        system=_VISUAL_GUIDANCE,
        user=user_msg,
        json_mode=True,
        temperature=0.3,
        max_tokens=4096,
    )

    data = _parse_visual_json(raw)

    # Coerce items into VisualItem objects, assign initial statuses
    items: list[VisualItem] = []
    table_counter = 0
    figure_counter = 0

    _CONCEPTUAL_KEYWORDS = (
        "schematic", "diagram", "pathway", "mechanism", "illustration",
        "conceptual", "workflow", "overview", "framework", "design",
        "model", "architecture", "flowchart",
    )

    for raw_item in data.get("items", []):
            # Auto-assign render_mode based on type and purpose if not provided by AI
        item_type = raw_item.get("type", "figure")
        if item_type == "table":
            render_mode = "table"
            image_backend = None
            output_mode = "full_figure"
        else:
            ai_mode = raw_item.get("render_mode", raw_item.get("renderer", ""))
            if ai_mode in ("matplotlib", "ai_illustration"):
                render_mode = ai_mode
            else:
                # Keyword-based fallback: conceptual diagrams → ai_illustration, data plots → matplotlib
                purpose_lower = (raw_item.get("purpose") or "").lower()
                title_lower = (raw_item.get("title") or "").lower()
                is_conceptual = any(
                    k in purpose_lower or k in title_lower
                    for k in _CONCEPTUAL_KEYWORDS
                )
                render_mode = "ai_illustration" if is_conceptual else "matplotlib"
            image_backend = "openai" if render_mode == "ai_illustration" else None
            output_mode = "composition_reference" if any(
                token in ((raw_item.get("title") or "") + " " + (raw_item.get("purpose") or "")).lower()
                for token in ("prisma", "consort", "flowchart", "workflow")
            ) else "full_figure"
        raw_item["render_mode"] = render_mode
        raw_item["image_backend"] = raw_item.get("image_backend") or image_backend
        raw_item["output_mode"] = raw_item.get("output_mode") or output_mode
        raw_item["category"] = raw_item.get("category") or "generic"
        raw_item["status"] = "recommended"
        raw_item["generated"] = None

        # Ensure IDs are correct type prefix
        if item_type == "table":
            table_counter += 1
            raw_item["id"] = f"T{table_counter}"
            if not raw_item.get("citation_text"):
                raw_item["citation_text"] = f"(Table {table_counter})"
        else:
            figure_counter += 1
            raw_item["id"] = f"F{figure_counter}"
            if not raw_item.get("citation_text"):
                raw_item["citation_text"] = f"(Figure {figure_counter})"

        try:
            items.append(VisualItem(**raw_item))
        except Exception as e:
            logger.warning("Skipping malformed visual item: %s — %s", raw_item, e)

    return VisualRecommendations(
        summary=data.get("summary", ""),
        empty_reason=data.get("empty_reason"),
        items=items,
    )


def renumber_visuals(recs: dict) -> dict:
    """
    Reassign T1/T2/F1/F2 ids by order of appearance (top to bottom),
    update citation_text in each item to match the new number.
    Returns a mutated copy of the recs dict.
    """
    import copy
    recs = copy.deepcopy(recs)
    items = recs.get("items", [])
    table_n = 0
    figure_n = 0
    id_map: dict[str, str] = {}  # old_id -> new_id

    for item in items:
        if item.get("status") == "dismissed":
            continue
        old_id = item.get("id", "")
        if item.get("type") == "table":
            table_n += 1
            new_id = f"T{table_n}"
            new_label = f"Table {table_n}"
        else:
            figure_n += 1
            new_id = f"F{figure_n}"
            new_label = f"Figure {figure_n}"
        id_map[old_id] = new_id
        item["id"] = new_id
        # Update citation_text to use the new number
        old_citation = item.get("citation_text", "")
        if old_citation:
            # Replace "Table N" or "Figure N" with new label
            item["citation_text"] = re.sub(
                r"(Table|Figure)\s+\d+", new_label, old_citation
            )

    recs["items"] = items
    return recs
