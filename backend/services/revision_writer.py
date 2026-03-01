"""
Generate a revised manuscript and a point-by-point response letter from peer-review feedback.
"""

from __future__ import annotations

import json
import logging

from models import PaperSummary, PeerReviewReport, RevisionResult
from services.ai_provider import AIProvider
from services.writing_guidelines import get_discussion_guidelines

logger = logging.getLogger(__name__)

_SYSTEM = """\
You are an expert academic revision assistant.

You will receive:
1) A manuscript draft
2) A formal peer-review report
3) The extracted evidence corpus

Tasks:
- Rewrite and improve the manuscript to address reviewer concerns.
- Keep evidence-grounding and citations/tags style from the original manuscript.
- Produce a point-by-point response letter answering each reviewer concern and revision item.

Rules:
1. Do not fabricate evidence or statistics.
2. If a concern cannot be fully resolved from available evidence, say so explicitly.
3. Response letter must be respectful and specific.
4. Output ONLY valid JSON.
"""

_USER = """\
Research topic: {query}
Target journal: {journal}

Original manuscript:
--- BEGIN DRAFT ---
{article}
--- END DRAFT ---

Peer review report JSON:
{review_json}

Evidence corpus ({n} papers):
{evidence_json}

Return JSON:
{{
  "revised_article": "Full revised manuscript in Markdown",
  "point_by_point_reply": "Markdown response letter with numbered responses to each major/minor concern and required revision"
}}
"""


async def generate_revision_package(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
    article: str,
    review: PeerReviewReport,
    journal: str = "",
) -> RevisionResult:
    evidence = []
    for s in summaries[:25]:
        evidence.append({
            "paper_key": s.paper_key,
            "study_design": s.methods.study_design,
            "sample_n": s.methods.sample_n,
            "evidence_grade": s.critical_appraisal.evidence_grade,
            "results": [
                {
                    "outcome": r.outcome,
                    "finding": r.finding,
                    "effect_size": r.effect_size,
                    "ci_95": r.ci_95,
                    "p_value": r.p_value,
                    "quote": r.supporting_quote,
                    "claim_type": r.claim_type,
                }
                for r in s.results[:4]
            ],
            "limitations": s.limitations[:3],
            "missing_info": s.missing_info[:3],
        })

    # Inject discussion/conclusion writing guidelines if available
    guidelines_block = get_discussion_guidelines()
    effective_system = (
        _SYSTEM + "\n\n" + guidelines_block
        if guidelines_block
        else _SYSTEM
    )

    raw = await provider.complete(
        system=effective_system,
        user=_USER.format(
            query=query or "general academic research",
            journal=journal or "Not specified",
            article=article[:12000],
            review_json=json.dumps(review.model_dump(), indent=2),
            n=len(summaries),
            evidence_json=json.dumps(evidence, indent=2),
        ),
        json_mode=True,
        temperature=0.2,
    )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except Exception:
            logger.warning("Failed to parse revision JSON")
            data = {}

    return RevisionResult(
        revised_article=str(data.get("revised_article", "")),
        point_by_point_reply=str(data.get("point_by_point_reply", "")),
    )

