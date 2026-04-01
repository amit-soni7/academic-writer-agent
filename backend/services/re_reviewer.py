"""
re_reviewer.py

Stage 4 of the peer review pipeline: concern-resolution based re-review.

Instead of reviewing from scratch, this verifies whether each original concern
was actually resolved, checks the response letter for accuracy, and identifies
any new problems introduced during revision.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from models import (
    ConcernResolution,
    PeerReviewReport,
    RepairTask,
    ReReviewResult,
)
from services.manuscript_utils import (
    build_chunk_context,
    build_manuscript_chunks,
    build_section_index,
    locate_text_span,
    manuscript_appears_truncated,
)

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)


_SYSTEM = """\
You are re-reviewing a revised manuscript together with:
1. the original reviewer report,
2. the revised manuscript,
3. the point-by-point response letter, if available.

Your task is NOT to review from scratch. Your primary task is to evaluate whether
the original concerns were adequately addressed.

For each original major and minor concern:
- Mark as "resolved", "partially_resolved", or "unresolved"
- Explain why
- If a response letter is provided, check whether it accurately represents the revision.
- If a response letter is provided, identify any overstatements in the author response
  (claims of changes that are not actually reflected in the manuscript, or exaggerated
  descriptions of what was changed).
- If no response letter is provided, focus only on concern resolution and new issues.
- Note any new problems introduced during revision

Evaluation criteria:
- A concern is "resolved" if the satisfaction_criterion (if provided) is met,
  OR if the manuscript now adequately addresses the issue.
- A concern is "partially_resolved" if some but not all aspects were addressed.
- A concern is "unresolved" if the manuscript still has the same problem.
- Do not mark something as unresolved just because the approach differs from
  what you would have suggested — judge by outcomes, not methods.

Then provide:
- updated_recommendation: accept | minor_revision | major_revision | reject
- remaining_issues: list of issues that still need work
- new_issues: list of problems introduced by the revision
- needs_another_round: whether another major revision round is needed
- blocking_issues: issues serious enough to block final response generation
- advisory_issues: minor cautions that do not need to block final response generation
- summary: 2-3 sentence overall assessment

Output a JSON object:
{
  "concern_resolutions": [
    {
      "concern_id": "major_1",
      "original_concern": "brief restatement",
      "status": "resolved | partially_resolved | unresolved",
      "explanation": "why this status",
      "response_accurate": true/false,
      "overstatements": ["any claims in the response that overstate what was done"]
    }
  ],
  "new_issues": ["any new problems introduced by the revision"],
  "updated_recommendation": "accept | minor_revision | major_revision | reject",
  "remaining_issues": ["issues that still need work"],
  "needs_another_round": true/false,
  "blocking_issues": ["major unresolved reviewer concerns"],
  "advisory_issues": ["minor partial resolutions or cautions"],
  "summary": "2-3 sentence assessment"
}

Use blocking_issues only for problems that genuinely require another manuscript revision round.
Use advisory_issues for minor or polish-level concerns that can remain non-blocking.
Do NOT list the absence of a response letter as an issue when no response letter
is provided in this workflow.
In this workflow, [CITE:key] grounding markers are valid temporary citation
placeholders before export normalization. Do NOT treat placeholder citations by
themselves as remaining issues unless you found an actual citation/content problem.
Avoid meta-level workflow reminders in remaining_issues or advisory_issues. Only
report action-worthy manuscript concerns.
"""


_USER_TMPL = """\
ORIGINAL REVIEW:
Decision: {original_decision}
Rationale: {original_rationale}

ORIGINAL CONCERNS:
{original_concerns}

SATISFACTION CRITERIA:
{satisfaction_criteria}

POINT-BY-POINT RESPONSE LETTER (optional):
{response_letter}

REVISED MANUSCRIPT:
{revised_manuscript}

WORKFLOW NOTE:
- [CITE:key] markers are valid temporary citation placeholders in this manuscript workflow.
- Final reference formatting may happen at export time rather than inside the revision draft itself.
"""


_CHUNK_USER_TMPL = """\
VISIBLE REVISED MANUSCRIPT CHUNK:
{chunk_context}

Evaluate ONLY the visible chunk above.
- Report concern resolutions only when this chunk contains concrete evidence for that concern.
- Report issues only when they can be anchored to visible chunk text.
- Do NOT infer that the manuscript ends here; this is one coverage chunk.

Return ONLY the JSON object."""


def _load_rereview_payload(raw: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        try:
            return json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse re-review JSON")
            return {}


def _merge_unique_str(items: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for item in items:
        clean = str(item).strip()
        if clean and clean not in seen:
            seen.add(clean)
            merged.append(clean)
    return merged


def _should_drop_issue(message: str, manuscript_text: str) -> bool:
    lowered = message.lower()
    if any(term in lowered for term in ("truncat", "structurally incomplete", "cut off", "mid-sentence", "integrity problem")):
        return not manuscript_appears_truncated(manuscript_text)
    if "placeholder" in lowered:
        manuscript_lower = manuscript_text.lower()
        return all(
            token not in manuscript_lower
            for token in ("[fut]", "complete the citation", "editorial placeholder", "placeholder")
        )
    return False


def _status_rank(status: str) -> int:
    normalized = (status or "").strip().lower()
    if normalized == "unresolved":
        return 3
    if normalized == "partially_resolved":
        return 2
    if normalized == "resolved":
        return 1
    return 0


def _issue_type_for_text(*parts: str) -> str:
    text = " ".join(p for p in parts if p).lower()
    if "placeholder" in text:
        return "placeholder"
    if any(term in text for term in ("truncat", "incomplete", "structural", "cut off")):
        return "structural"
    if any(term in text for term in ("corrupt", "duplicat", "artifact")):
        return "corruption"
    if "citation" in text:
        return "citation"
    return "other"


def _rewrite_scope_for_issue(issue_type: str) -> str:
    if issue_type in {"placeholder", "structural", "corruption"}:
        return "paragraph"
    if issue_type == "citation":
        return "sentence"
    return "paragraph"


def _review_concern_by_id(review: PeerReviewReport, concern_id: str):
    prefix, _, raw_index = concern_id.partition("_")
    if not raw_index.isdigit():
        return None
    idx = int(raw_index) - 1
    if prefix == "major" and 0 <= idx < len(review.major_concerns):
        return review.major_concerns[idx]
    if prefix == "minor" and 0 <= idx < len(review.minor_concerns):
        return review.minor_concerns[idx]
    return None


def _build_repair_tasks(
    review: PeerReviewReport,
    resolutions: list[ConcernResolution],
    blocking: list[str],
    advisory: list[str],
    manuscript_text: str,
) -> list[RepairTask]:
    tasks: list[RepairTask] = []
    for resolution in resolutions:
        if resolution.status == "resolved":
            continue
        source_concern = _review_concern_by_id(review, resolution.concern_id)
        passage = getattr(source_concern, "quoted_passage", "") if source_concern else ""
        span = locate_text_span(manuscript_text, passage) if passage else None
        issue_type = _issue_type_for_text(resolution.original_concern, resolution.explanation)
        severity = "blocking" if resolution.status == "unresolved" else "advisory"
        tasks.append(RepairTask(
            source="rereview",
            severity=severity,
            section=(span or {}).get("section", getattr(source_concern, "location", "")),
            line_span=[(span or {}).get("start_line", 0), (span or {}).get("end_line", 0)] if span else [],
            quoted_passage=(span or {}).get("text", passage),
            issue_type=issue_type,
            expected_outcome=resolution.explanation or resolution.original_concern,
            safe_edit_ops=[],
            rewrite_scope=_rewrite_scope_for_issue(issue_type),
        ))
    for message in blocking + advisory:
        issue_type = _issue_type_for_text(message)
        if any(task.expected_outcome == message for task in tasks):
            continue
        tasks.append(RepairTask(
            source="rereview",
            severity="blocking" if message in blocking else "advisory",
            section="",
            line_span=[],
            quoted_passage="",
            issue_type=issue_type,
            expected_outcome=message,
            safe_edit_ops=[],
            rewrite_scope=_rewrite_scope_for_issue(issue_type),
        ))
    return tasks


def _format_original_concerns(review: PeerReviewReport) -> str:
    lines = []
    for i, c in enumerate(review.major_concerns, 1):
        lines.append(f"[major_{i}] {c.concern}")
        if c.location:
            lines.append(f"  Location: {c.location}")
        if c.problem_type:
            lines.append(f"  Type: {c.problem_type}")
        lines.append(f"  Revision request: {c.revision_request}")
    for i, c in enumerate(review.minor_concerns, 1):
        lines.append(f"[minor_{i}] {c.concern}")
        if c.location:
            lines.append(f"  Location: {c.location}")
        lines.append(f"  Revision request: {c.revision_request}")
    return "\n".join(lines) or "(none)"


def _format_satisfaction_criteria(review: PeerReviewReport) -> str:
    lines = []
    for i, c in enumerate(review.major_concerns, 1):
        if c.satisfaction_criterion:
            lines.append(f"[major_{i}]: {c.satisfaction_criterion}")
    for i, c in enumerate(review.minor_concerns, 1):
        if c.satisfaction_criterion:
            lines.append(f"[minor_{i}]: {c.satisfaction_criterion}")
    return "\n".join(lines) or "(none specified)"


async def generate_re_review(
    provider: "AIProvider",
    review: PeerReviewReport,
    response_letter: str,
    revised_manuscript: str,
) -> ReReviewResult:
    """
    Re-review a revised manuscript by checking whether each original concern
    was resolved, rather than reviewing from scratch.
    """
    review_context = _USER_TMPL.format(
        original_decision=review.decision,
        original_rationale=review.decision_rationale,
        original_concerns=_format_original_concerns(review),
        satisfaction_criteria=_format_satisfaction_criteria(review),
        response_letter=response_letter or "(No response letter provided)",
        revised_manuscript="Coverage is supplied chunk-by-chunk below. Do not infer that the manuscript ends at any single chunk boundary.",
    )
    chunks = build_manuscript_chunks(
        revised_manuscript or "(No manuscript)",
        section_index=build_section_index(revised_manuscript or "(No manuscript)"),
        max_chars=12000,
        overlap_paragraphs=1,
    )

    resolution_map: dict[str, ConcernResolution] = {}
    new_issues: list[str] = []
    remaining: list[str] = []
    blocking: list[str] = []
    advisory: list[str] = []
    summaries: list[str] = []
    recommendation_scores: list[str] = []
    needs_another_round = False

    for chunk in chunks or [{
        "section": "Manuscript",
        "start_line": 1,
        "end_line": max(1, len((revised_manuscript or "").splitlines())),
        "paragraph_start": 1,
        "paragraph_end": 1,
        "start_char": 0,
        "end_char": len(revised_manuscript or ""),
        "text": revised_manuscript or "(No manuscript)",
    }]:
        raw = await provider.complete_cached(
            cacheable_context=review_context,
            system=_SYSTEM,
            user=_CHUNK_USER_TMPL.format(chunk_context=build_chunk_context(chunk)),
            json_mode=True,
            temperature=0.15,
            max_tokens=4096,
        )
        data = _load_rereview_payload(raw)
        for item in data.get("concern_resolutions", []):
            if not isinstance(item, dict):
                continue
            overstatements = item.get("overstatements", [])
            if not isinstance(overstatements, list):
                overstatements = []
            concern = ConcernResolution(
                concern_id=str(item.get("concern_id", "")),
                original_concern=str(item.get("original_concern", "")),
                status=str(item.get("status", "unresolved")),
                explanation=str(item.get("explanation", "")),
                response_accurate=bool(item.get("response_accurate", True)),
                overstatements=[str(o) for o in overstatements],
            )
            if not concern.concern_id:
                continue
            prior = resolution_map.get(concern.concern_id)
            if not prior or _status_rank(concern.status) > _status_rank(prior.status):
                resolution_map[concern.concern_id] = concern
        new_issues.extend(data.get("new_issues", []) if isinstance(data.get("new_issues", []), list) else [])
        remaining.extend(data.get("remaining_issues", []) if isinstance(data.get("remaining_issues", []), list) else [])
        blocking.extend(data.get("blocking_issues", []) if isinstance(data.get("blocking_issues", []), list) else [])
        advisory.extend(data.get("advisory_issues", []) if isinstance(data.get("advisory_issues", []), list) else [])
        summary = str(data.get("summary", "")).strip()
        if summary:
            summaries.append(summary)
        recommendation = str(data.get("updated_recommendation", "")).strip().lower()
        if recommendation:
            recommendation_scores.append(recommendation)
        needs_another_round = needs_another_round or bool(data.get("needs_another_round", False))

    resolutions = [
        resolution
        for resolution in resolution_map.values()
        if not (
            resolution.status != "resolved"
            and _should_drop_issue(resolution.explanation or resolution.original_concern, revised_manuscript)
        )
    ]
    new_issues = _merge_unique_str(new_issues)
    remaining = _merge_unique_str(remaining)
    blocking = _merge_unique_str(blocking)
    advisory = _merge_unique_str(advisory)
    new_issues = [item for item in new_issues if not _should_drop_issue(item, revised_manuscript)]
    remaining = [item for item in remaining if not _should_drop_issue(item, revised_manuscript)]
    blocking = [item for item in blocking if not _should_drop_issue(item, revised_manuscript)]
    advisory = [item for item in advisory if not _should_drop_issue(item, revised_manuscript)]
    unresolved_resolutions = [resolution for resolution in resolutions if resolution.status != "resolved"]
    severity_order = {"reject": 4, "major_revision": 3, "minor_revision": 2, "accept": 1}
    updated_rec = "accept"
    if recommendation_scores:
        updated_rec = max(recommendation_scores, key=lambda value: severity_order.get(value, 0))
    if updated_rec not in ("accept", "minor_revision", "major_revision", "reject"):
        updated_rec = "minor_revision"
    if not blocking and not remaining and not new_issues and not unresolved_resolutions:
        updated_rec = "accept"
        needs_another_round = False
    elif not blocking and updated_rec in {"major_revision", "reject"}:
        updated_rec = "minor_revision" if (advisory or remaining or unresolved_resolutions or needs_another_round) else "accept"
    repair_tasks = _build_repair_tasks(review, resolutions, blocking, advisory, revised_manuscript)

    return ReReviewResult(
        concern_resolutions=resolutions,
        new_issues=[str(n) for n in new_issues],
        updated_recommendation=updated_rec,
        remaining_issues=[str(r) for r in remaining],
        needs_another_round=needs_another_round or bool(blocking),
        blocking_issues=[str(b) for b in blocking],
        advisory_issues=[str(a) for a in advisory],
        repair_tasks=repair_tasks,
        summary=" ".join(_merge_unique_str(summaries)),
    )
