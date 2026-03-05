"""
paper_screener.py

Lightweight abstract-only screening for systematic reviews.

A single AI call per paper (title + abstract only) classifies each paper as:
  include  — clearly addresses the research question
  exclude  — clearly irrelevant
  uncertain — ambiguous or insufficient abstract

This is roughly 20-50x cheaper than full summarization and lets researchers
filter out obvious mismatches before committing to full extraction.
"""

import json
import logging
from typing import Optional

from models import Paper
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

_SCREEN_SYSTEM = """\
You are a systematic review screener. Given a research question and a paper's
title and abstract, decide if the paper is relevant for inclusion in the review.

Be strict on clear mismatches; be generous with uncertainty.
Return ONLY valid JSON — no prose, no markdown fences."""

_SCREEN_USER = """\
Research question: {query}

Paper: {title} ({year})
Abstract: {abstract}

Return JSON only:
{{"decision": "include" | "exclude" | "uncertain", "reason": "<1 sentence>"}}

Decision criteria:
- include   : clearly addresses the research question (right topic, right study type if specified, right population)
- exclude   : clearly irrelevant (wrong topic, wrong population, wrong study type when specified)
- uncertain : abstract is ambiguous, insufficient, or the paper might be relevant but you cannot tell from the abstract alone"""


def _paper_key(paper: Paper) -> str:
    return (paper.doi or paper.title[:60]).lower().strip()


async def screen_paper(
    provider: AIProvider,
    paper: Paper,
    query: str,
) -> dict:
    """
    Screen a single paper and return:
      {"paper_key": str, "decision": str, "reason": str}
    """
    abstract = (paper.abstract or "").strip()
    if not abstract:
        abstract = "Abstract not available."

    user_prompt = _SCREEN_USER.format(
        query=query,
        title=paper.title,
        year=paper.year or "n.d.",
        abstract=abstract[:2000],
    )

    raw = await provider.complete(
        system=_SCREEN_SYSTEM,
        user=user_prompt,
        json_mode=True,
        temperature=0.1,
    )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Screen JSON parse failed for %r", paper.title[:40])
            data = {}

    decision = data.get("decision", "uncertain")
    if decision not in ("include", "exclude", "uncertain"):
        decision = "uncertain"

    return {
        "paper_key": _paper_key(paper),
        "decision": decision,
        "reason": data.get("reason", ""),
    }
