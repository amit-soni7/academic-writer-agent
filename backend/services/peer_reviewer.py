"""
peer_reviewer.py

Generates a rigorous peer-review report from extracted evidence and a draft article.

Follows standard journal peer-review conventions:
  - Summary of manuscript claim
  - Major concerns (method validity, stats, interpretation, overclaiming)
  - Minor concerns (clarity, references, reporting standards)
  - Required revisions (numbered, actionable)
  - Decision recommendation with rationale

Each concern is mapped to evidence_ids and paper_ids from the extraction corpus.
"""

import json
import logging

from models import (
    PeerReviewReport,
    PaperSummary,
    ReviewConcern,
)
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

_SYSTEM = """\
You are an expert academic peer reviewer with deep methodological expertise.
Your review must be evidence-based — every concern must cite specific paper_key(s)
and/or evidence from the provided extraction corpus.

RULES:
1. Base all concerns on the extracted evidence, not general assumptions.
2. Every major concern must include an exact, actionable revision request.
3. Do not fabricate statistics, quotes, or data not present in the summaries.
4. Be rigorous but fair — acknowledge strengths alongside concerns.
5. The decision must follow from your concerns and the evidence quality.
6. Output ONLY valid JSON. No markdown fences, no prose outside the JSON.
"""

_USER_TMPL = """\
Research topic / manuscript claim: {query}

Article draft to review:
--- BEGIN DRAFT ---
{article}
--- END DRAFT ---

Evidence extraction corpus ({n} papers):
--- BEGIN EVIDENCE ---
{evidence_json}
--- END EVIDENCE ---

Generate a rigorous peer-review report. Return a SINGLE JSON object:

{{
  "manuscript_summary": "2-3 sentence summary of the manuscript's central claim and approach",

  "major_concerns": [
    {{
      "concern": "Specific methodological or scientific concern",
      "evidence_ids": ["result_0", "result_1"],
      "paper_ids": ["paper_key_1", "paper_key_2"],
      "scientific_importance": "Why this matters scientifically — consequences of not addressing it",
      "revision_request": "Exact actionable revision: what the authors must do to address this"
    }}
  ],

  "minor_concerns": [
    {{
      "concern": "Minor concern about clarity, reporting, or formatting",
      "evidence_ids": [],
      "paper_ids": ["paper_key_1"],
      "scientific_importance": "Why even minor issues matter for reproducibility or clarity",
      "revision_request": "Specific minor revision requested"
    }}
  ],

  "required_revisions": [
    "1. [Numbered actionable revision — from major concerns]",
    "2. [Numbered actionable revision — from major concerns]"
  ],

  "decision": "accept | minor_revision | major_revision | reject",

  "decision_rationale": "2-3 sentences explaining the decision based on the evidence quality, major concerns, and the manuscript's contribution relative to existing evidence."
}}

Generate 3-6 major concerns and 2-4 minor concerns. Be specific and evidence-grounded.
"""


def _parse_concerns(raw: list) -> list[ReviewConcern]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        out.append(ReviewConcern(
            concern=str(item.get("concern", "")),
            evidence_ids=[str(x) for x in item.get("evidence_ids", [])],
            paper_ids=[str(x) for x in item.get("paper_ids", [])],
            scientific_importance=str(item.get("scientific_importance", "")),
            revision_request=str(item.get("revision_request", "")),
        ))
    return out


async def generate_peer_review(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
    article: str,
) -> PeerReviewReport:
    """
    Generate a peer-review report from extracted summaries and the article draft.
    """
    # Compact evidence repr for the prompt
    evidence = []
    for s in summaries[:25]:   # cap at 25 to stay within token limit
        evidence.append({
            "paper_key": s.paper_key,
            "study_design": s.methods.study_design,
            "sample_n": s.methods.sample_n,
            "evidence_grade": s.critical_appraisal.evidence_grade,
            "selection_bias": s.critical_appraisal.selection_bias,
            "results": [
                {
                    "id": f"result_{i}",
                    "outcome": r.outcome,
                    "effect_size": r.effect_size,
                    "ci_95": r.ci_95,
                    "p_value": r.p_value,
                    "claim_type": r.claim_type,
                    "quote": r.supporting_quote,
                }
                for i, r in enumerate(s.results[:4])
            ],
            "limitations": s.limitations[:3],
            "missing_info": s.missing_info[:3],
        })

    user_prompt = _USER_TMPL.format(
        query=query or "general academic research",
        article=article[:6000] if article else "(No draft provided — review the evidence corpus only)",
        n=len(summaries),
        evidence_json=json.dumps(evidence, indent=2),
    )

    raw = await provider.complete(
        system=_SYSTEM,
        user=user_prompt,
        json_mode=True,
        temperature=0.15,
    )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse peer review JSON")
            data = {}

    decision = str(data.get("decision", "major_revision")).lower()
    if decision not in ("accept", "minor_revision", "major_revision", "reject"):
        decision = "major_revision"

    revisions = data.get("required_revisions", [])
    if not isinstance(revisions, list):
        revisions = []

    return PeerReviewReport(
        manuscript_summary=str(data.get("manuscript_summary", "")),
        major_concerns=_parse_concerns(data.get("major_concerns", [])),
        minor_concerns=_parse_concerns(data.get("minor_concerns", [])),
        required_revisions=[str(r) for r in revisions],
        decision=decision,
        decision_rationale=str(data.get("decision_rationale", "")),
    )
