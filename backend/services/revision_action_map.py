"""
revision_action_map.py

Stage 2 of the peer review pipeline: converts a PeerReviewReport into a
machine-actionable RevisionActionMap.

Each reviewer concern is triaged (accept / partially_accept / decline) and
decomposed into a concrete edit plan with:
  - action_type: define_term, soften_claim, add_citation, add_historical_framing,
    add_paragraph, restructure_section, clarify_distinction, add_limitation,
    revise_conclusion, no_change_rebut, etc.
  - target_section + manuscript_location
  - estimated edit size
  - verification_criterion: what must be true after the edit
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from models import (
    PeerReviewReport,
    RevisionAction,
    RevisionActionMap,
)
from services.manuscript_utils import (
    build_full_manuscript_context,
    build_section_index,
)

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)


_SYSTEM = """\
You are an expert academic revision strategist. You have received a peer-review report
and the original manuscript. Your job is to convert every reviewer concern into a
concrete, executable revision plan.

For each reviewer concern (major, minor, and required revision), you must:

1. TRIAGE: Classify the response as one of:
   - "accept" — the concern is valid; change the manuscript
   - "partially_accept" — the concern has merit but the full suggestion is not appropriate
   - "decline" — the concern is not valid; rebut respectfully
   - "already_addressed" — the manuscript already handles this
   - "editorial_optional" — a stylistic preference, not required

   2. PLAN: For each accepted or partially accepted concern, produce a structured action:
     - reviewer_comment_id: "major_1", "minor_3", "required_4", etc.
     - disposition: accept | partially_accept | decline | already_addressed | editorial_optional
     - concern_title: short descriptive title
   - severity: high | medium | low
   - manuscript_location: section + paragraph reference (e.g., "Introduction, paragraph 2")
   - quoted_passage: copy 50-150 chars of the EXACT target text verbatim from the manuscript (for precise edit matching)
   - action_type: one of:
     define_term, soften_claim, add_citation, add_historical_framing,
     add_paragraph, restructure_section, clarify_distinction, add_limitation,
     revise_conclusion, no_change_rebut, strengthen_argument, add_methodology_detail,
     add_counterargument, rewrite_text, delete_text, move_text, other
   - revision_instruction: precise description of what to write/change
   - target_section: which manuscript section to edit
   - estimated_edit_size: "sentence" | "paragraph" | "multi_paragraph"
   - has_dependency: whether this edit depends on another edit being done first
   - verification_criterion: what must be true in the revised manuscript for this
     concern to be considered resolved (be specific and testable)

For declined concerns, still produce an action with action_type "no_change_rebut"
and a revision_instruction explaining the rebuttal rationale.

Output a JSON object:
{
  "actions": [...],
  "total_actions": <int>,
  "accepted_count": <int>,
  "declined_count": <int>,
  "partially_accepted": <int>
}

CRITICAL:
- Every concern must produce exactly one action entry.
- verification_criterion must be specific and testable, not vague.
- Do not merge multiple concerns into one action unless they are truly the same issue.
- Do not fabricate manuscript locations or quoted passages. Copy text character-for-character from the manuscript.
- The quoted_passage field is critical — it will be used for exact string matching during revision.
"""


_USER_TMPL = """\
{manuscript_context}

PEER REVIEW REPORT:

Decision: {decision}
Rationale: {decision_rationale}

REVIEWER EXPERTISE: {reviewer_expertise}

MAJOR CONCERNS:
{major_concerns}

MINOR CONCERNS:
{minor_concerns}

REQUIRED REVISIONS:
{required_revisions}

CLAIMS AUDIT:
{claims_audit}

REVISION PRIORITIES:
{revision_priorities}

Convert every concern above into a structured revision action. Return ONLY the JSON object."""


def _format_concerns(concerns: list, prefix: str) -> str:
    if not concerns:
        return "(none)"
    lines = []
    for i, c in enumerate(concerns, 1):
        cid = f"{prefix}_{i}"
        lines.append(f"  [{cid}] {c.concern}")
        if c.location:
            lines.append(f"    Location: {c.location}")
        if getattr(c, 'quoted_passage', ''):
            lines.append(f'    Target text: "{c.quoted_passage}"')
        if c.problem_type:
            lines.append(f"    Type: {c.problem_type}")
        if c.severity:
            lines.append(f"    Severity: {c.severity}")
        lines.append(f"    Revision request: {c.revision_request}")
        if c.satisfaction_criterion:
            lines.append(f"    Satisfaction criterion: {c.satisfaction_criterion}")
    return "\n".join(lines)


async def generate_revision_action_map(
    provider: "AIProvider",
    article: str,
    review: PeerReviewReport,
) -> RevisionActionMap:
    """
    Convert a PeerReviewReport into a structured RevisionActionMap.

    Each concern is triaged and decomposed into an executable edit plan
    with verification criteria.
    """
    section_index = build_section_index(article) if article else []
    manuscript_context = build_full_manuscript_context(
        manuscript_text=article or "(No manuscript provided)",
        section_index=section_index,
    )

    # Format claims audit
    claims_lines = []
    for i, ca in enumerate(review.claims_audit, 1):
        claims_lines.append(f"  {i}. \"{ca.claim}\" at {ca.location} — {ca.problem} → {ca.fix}")
    claims_text = "\n".join(claims_lines) if claims_lines else "(none)"

    user_prompt = _USER_TMPL.format(
        manuscript_context=manuscript_context,
        decision=review.decision,
        decision_rationale=review.decision_rationale,
        reviewer_expertise=", ".join(review.reviewer_expertise) if review.reviewer_expertise else "general",
        major_concerns=_format_concerns(review.major_concerns, "major"),
        minor_concerns=_format_concerns(review.minor_concerns, "minor"),
        required_revisions="\n".join(f"  {r}" for r in review.required_revisions) or "(none)",
        claims_audit=claims_text,
        revision_priorities="\n".join(f"  {r}" for r in review.revision_priorities) or "(none)",
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
        end = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse revision action map JSON")
            data = {}

    actions = []
    for item in data.get("actions", []):
        if not isinstance(item, dict):
            continue
        actions.append(RevisionAction(
            reviewer_comment_id=str(item.get("reviewer_comment_id", "")),
            disposition=str(item.get("disposition", "")),
            concern_title=str(item.get("concern_title", "")),
            severity=str(item.get("severity", "medium")),
            manuscript_location=str(item.get("manuscript_location", "")),
            quoted_passage=str(item.get("quoted_passage", item.get("target_text", ""))),
            action_type=str(item.get("action_type", "")),
            revision_instruction=str(item.get("revision_instruction", "")),
            target_section=str(item.get("target_section", "")),
            estimated_edit_size=str(item.get("estimated_edit_size", "paragraph")),
            has_dependency=bool(item.get("has_dependency", False)),
            verification_criterion=str(item.get("verification_criterion", "")),
        ))

    return RevisionActionMap(
        actions=actions,
        total_actions=int(data.get("total_actions", len(actions))),
        accepted_count=int(data.get("accepted_count", 0)),
        declined_count=int(data.get("declined_count", 0)),
        partially_accepted=int(data.get("partially_accepted", 0)),
    )
