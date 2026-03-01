"""
title_generator.py

Generates high-quality manuscript title suggestions following evidence-based
academic title writing guidelines:
  - Tullu MS (2019). "Writing the title and abstract for a research paper:
    Being concise, precise, and meticulous is the key." Saudi J Anaesth 13:S12–7.
  - Nature Index: "How to write a good research paper title."

Title quality criteria enforced:
  • Concise and precise (10–15 words optimal)
  • Descriptive (not declarative / not interrogative)
  • SPICED elements: Setting, Population, Intervention, Condition, End-point, Design
  • Keywords placed at the beginning (first 6–7 words)
  • No hype, no overclaiming ("novel," "revolutionary," "unprecedented," etc.)
  • No nonstandard abbreviations or whimsical / amusing language
  • Aligned to target journal scope and article type
"""

from __future__ import annotations

import json
import logging

from pydantic import BaseModel

from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# ── Title quality system prompt (grounded in Tullu 2019 + Nature Index) ────────

_TITLE_SYSTEM = """\
You are an expert academic editor specialising in manuscript titles for peer-reviewed journals.

TITLE QUALITY CRITERIA — apply ALL of these rigorously:

1. CONCISE & PRECISE
   • Optimal length: 10–15 words. Avoid cryptic very-short titles (miss keywords) and
     wordy titles (boring, unfocused).
   • Remove redundant words: "study of," "investigation of," "analysis of," "a report on."

2. DESCRIPTIVE (preferred over declarative or interrogative)
   • Descriptive: gives the main theme without revealing the conclusion — allows the reader
     to form an impartial impression. Most journals prefer this style.
   • Declarative (states the finding as the title): best avoided — implies bias, reduces curiosity.
   • Interrogative (question format): best avoided for original research — distracting,
     attracts downloads but fewer citations. Acceptable only occasionally for review articles.

3. KEYWORDS FIRST
   • Place the most important scientific keywords at the beginning of the title.
   • Some search engines (e.g., Google Scholar) display only the first 6–7 words;
     those words must carry the essential meaning.

4. SPICED ELEMENTS (where applicable)
   • Setting, Population, Intervention, Condition, End-point, Design.
   • Include study location ONLY if patient characteristics vary meaningfully by country.
   • Include sample size ONLY if it is unusually large and adds scientific value.

5. NO HYPE / NO OVERCLAIMING
   • Forbidden words: novel, first-ever, revolutionary, breakthrough, unprecedented,
     unique, world-first, game-changing, promising, exciting.
   • Do NOT state or imply certainty greater than the evidence warrants.
   • Do NOT use superlatives ("most," "best," "highest").

6. NO NONSTANDARD ABBREVIATIONS
   • Only universally recognised abbreviations are acceptable (HIV, DNA, COVID-19, RNA,
     RCT, ICU, BMI). Spell out everything else in full.

7. NO WHIMSICAL / AMUSING / CLEVER LANGUAGE
   • Witty or literary titles are taken less seriously and are cited less often.
   • Avoid puns, literary allusions, or jokes.

8. JOURNAL-ALIGNED
   • Match the register, terminology, and scope of the target journal.
   • Reflect the article type (systematic review, meta-analysis, original research, etc.)
     in the title when the journal requires it (e.g., via subtitle after a colon).

9. COMPOUND TITLES (with subtitle)
   • A colon-separated subtitle may add: study design, setting, sample size (if exceptional),
     or a provocative element — use only when it genuinely adds information.

OUTPUT FORMAT — return ONLY valid JSON, no prose outside the JSON:
{
  "best_title": "<string: the single strongest title>",
  "best_title_rationale": "<string: one sentence explaining why this is the best choice>",
  "alternatives": [
    {"title": "<string>", "rationale": "<string: one sentence>"},
    {"title": "<string>", "rationale": "<string: one sentence>"},
    {"title": "<string>", "rationale": "<string: one sentence>"},
    {"title": "<string>", "rationale": "<string: one sentence>"},
    {"title": "<string>", "rationale": "<string: one sentence>"}
  ],
  "quality_notes": "<string: brief notes on trade-offs, concerns, or special considerations>"
}

Rules:
• Generate exactly 1 best title and exactly 5 alternatives (no more, no fewer).
• Each of the 6 titles must be DISTINCT in structure or keyword emphasis.
  Vary: keyword ordering, compound vs. nominal construction, specificity level,
  population focus, outcome focus.
• Every title must pass ALL 9 quality criteria above.
• Do not repeat the same title across best + alternatives.
"""


# ── Pydantic models ────────────────────────────────────────────────────────────

class TitleCandidate(BaseModel):
    title: str
    rationale: str


class TitleSuggestions(BaseModel):
    best_title: str
    best_title_rationale: str
    alternatives: list[TitleCandidate]
    quality_notes: str = ""


# ── Generation function ────────────────────────────────────────────────────────

async def generate_title_suggestions(
    provider: AIProvider,
    query: str,
    article_type: str,
    journal: str,
    summaries_snapshot: str = "",
) -> TitleSuggestions:
    """
    Generate 1 best title + 5 alternatives for a manuscript.

    Parameters
    ----------
    provider          : Configured AIProvider instance.
    query             : The research topic / key idea.
    article_type      : "review" | "original_research" | "meta_analysis"
    journal           : Target journal name.
    summaries_snapshot: Short text of key takeaways from paper summaries (optional,
                        improves specificity of generated titles).
    """
    article_type_label = {
        "review": "Systematic Review",
        "original_research": "Original Research Article",
        "meta_analysis": "Meta-Analysis",
    }.get(article_type, article_type.replace("_", " ").title())

    user_msg = (
        f"Research topic / key idea: {query}\n"
        f"Article type: {article_type_label}\n"
        f"Target journal: {journal or 'not specified'}\n"
    )
    if summaries_snapshot:
        user_msg += f"\nKey takeaways from the evidence base:\n{summaries_snapshot}\n"

    user_msg += (
        "\nUsing these details and the quality criteria, generate the best manuscript "
        "title and 5 strong alternatives. Return ONLY the JSON object."
    )

    raw = await provider.complete(
        system=_TITLE_SYSTEM,
        user=user_msg,
        json_mode=True,
        temperature=0.6,
    )

    if isinstance(raw, str):
        data = json.loads(raw)
    else:
        data = raw

    alts = [
        TitleCandidate(
            title=a.get("title", "").strip(),
            rationale=a.get("rationale", "").strip(),
        )
        for a in data.get("alternatives", [])
        if a.get("title", "").strip()
    ]

    return TitleSuggestions(
        best_title=data.get("best_title", "").strip(),
        best_title_rationale=data.get("best_title_rationale", "").strip(),
        alternatives=alts[:5],
        quality_notes=data.get("quality_notes", "").strip(),
    )


def build_summaries_snapshot(summaries: list[dict], max_items: int = 15) -> str:
    """
    Build a short text snapshot of key takeaways from paper summaries.
    Used to give the title generator context about the evidence base.
    """
    lines = []
    for s in summaries[:max_items]:
        takeaway = s.get("one_line_takeaway", "")
        bib = s.get("bibliography", {})
        year = bib.get("year") or "n.d."
        authors = bib.get("authors", [])
        author = authors[0] if authors else s.get("paper_key", "")
        if takeaway:
            lines.append(f"- {author} ({year}): {takeaway}")
    return "\n".join(lines)
