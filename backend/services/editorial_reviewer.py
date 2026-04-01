"""
services/editorial_reviewer.py

AI acts as a senior journal editor (Nature, Science, PLOS, Lancet) reviewing
the revised manuscript and author responses before the final point-by-point reply.

Checks: completeness, quality of revisions, consistency, over/under-editing,
language, structure, references.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

from models import EditorialReviewResult, RepairTask
from services.manuscript_utils import (
    audit_revision as _audit_revision,
    build_chunk_context,
    build_manuscript_chunks,
    manuscript_appears_truncated,
    build_section_index as _build_section_index,
    build_section_index_header as _build_section_index_header,
    number_lines as _number_lines,
)

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)


_EDITORIAL_SYSTEM = """\
You are a senior handling editor at a top-tier academic journal (Nature, Science, PLOS, The Lancet).

You have received:
1. The ORIGINAL manuscript (before revision)
2. The REVISED manuscript (after author revisions)
3. The reviewer comments that prompted the revision
4. The author's point-by-point responses to each comment, if available

Your task is to provide an EDITORIAL ASSESSMENT of whether the revision is adequate.

Evaluate these dimensions:

1. COMPLETENESS — Did the authors address every reviewer concern? Any skipped or only superficially addressed?
2. QUALITY OF REVISIONS — Are the changes well-written, scientifically sound, and properly integrated?
3. CONSISTENCY — Did the revisions introduce any new contradictions or logical gaps?
4. OVER-EDITING — Did the authors change MORE than necessary? (e.g., rewrote sections the reviewer didn't flag,
   changed title/headings/figures/tables without being asked, significantly altered word count)
5. UNDER-EDITING — Did the authors make only token changes where substantive revision was needed?
6. LANGUAGE & CLARITY — Any remaining language issues in the REVISED sections only?
7. STRUCTURE — Does the revised manuscript flow logically? Any structural problems introduced?
8. REFERENCES — All citations accurate and complete? Any orphan citations or missing references?

Return ONLY valid JSON (no markdown fences):
{
  "editor_decision": "accept" | "minor_revision" | "major_revision",
  "overall_assessment": "2-3 paragraph editorial assessment summarizing your verdict",
  "suggestions": [
    {
      "category": "completeness|quality|consistency|over_edit|under_edit|language|structure|references",
      "severity": "critical|important|minor",
      "location": "Section name, approximate location",
      "finding": "What you found",
      "suggestion": "What you recommend"
    }
  ],
  "praise": ["Specific things the authors did well in their revision"],
  "remaining_concerns": ["Unresolved issues that still need attention"],
  "blocking_issues": ["major issues that should block final response generation"],
  "advisory_issues": ["minor editorial cautions that do not need to block final response generation"]
}

Rules:
- Be fair and constructive. Acknowledge good work.
- Be specific about locations (section names, paragraph numbers).
- Flag OVER-EDITING as a real issue — unnecessary changes introduce risk.
- For "accept": no critical or important issues remain.
- For "minor_revision": only minor issues, easily fixable.
- For "major_revision": critical issues remain or significant concerns unaddressed.
- Use blocking_issues only for major unresolved concerns, serious over-editing,
  structural damage, or scientific inconsistency that requires more manuscript work.
- Use advisory_issues for minor language, clarity, or polish suggestions.
- In this workflow, [CITE:key] grounding markers are valid temporary citations
  and final bibliography formatting may be normalized at export time. Do NOT
  treat placeholder [CITE:key] markers as orphan citations solely because the
  final formatted reference list is deferred to export.
- Do NOT include workflow-note reminders such as "resolve placeholders at export"
  unless you found a real citation-resolution problem that would remain even
  after normal export formatting.
- Do NOT suggest rewording or improvements to text the reviewer didn't flag.
  Your job is to assess the REVISION, not re-review the manuscript from scratch."""

_EDITORIAL_USER_TMPL = """\
Journal: {journal_name}

REVIEWER COMMENTS:
{comments_json}

AUTHOR RESPONSES (optional):
{responses_json}

WORKFLOW NOTE:
- [CITE:key] markers are valid temporary citation placeholders in this manuscript workflow.
- Final reference formatting may happen at export time rather than inside the revision draft itself.
"""


_EDITORIAL_CHUNK_USER_TMPL = """\
Journal: {journal_name}

REVIEWER COMMENTS:
{comments_json}

AUTHOR RESPONSES (optional):
{responses_json}

VISIBLE REVISED MANUSCRIPT CHUNK:
{chunk_context}

WORKFLOW NOTE:
- [CITE:key] markers are valid temporary citation placeholders in this manuscript workflow.
- Final reference formatting may happen at export time rather than inside the revision draft itself.

Assess ONLY the visible chunk above.
- Report suggestions only when they are grounded in visible chunk text.
- Do NOT infer that the manuscript ends here; this is one coverage chunk.

Return JSON only."""


def _fallback_result(reason: str) -> EditorialReviewResult:
    return EditorialReviewResult(
        editor_decision="minor_revision",
        overall_assessment=(
            "Editorial review could not be completed automatically. "
            f"Reason: {reason}"
        ),
        suggestions=[],
        praise=[],
        remaining_concerns=["Automatic editorial review was unavailable for this request."],
        blocking_issues=[],
        advisory_issues=["Automatic editorial review was unavailable for this request."],
    )


def _merge_unique_str(items: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for item in items:
        clean = str(item).strip()
        if clean and clean not in seen:
            seen.add(clean)
            merged.append(clean)
    return merged


def _issue_type_for_text(*parts: str) -> str:
    text = " ".join(p for p in parts if p).lower()
    if "placeholder" in text:
        return "placeholder"
    if any(term in text for term in ("truncat", "incomplete", "structur", "coherence")):
        return "structural"
    if any(term in text for term in ("corrupt", "duplicat", "artifact")):
        return "corruption"
    if "citation" in text or "reference" in text:
        return "citation"
    return "other"


def _rewrite_scope_for_issue(issue_type: str) -> str:
    if issue_type in {"placeholder", "structural", "corruption"}:
        return "paragraph"
    if issue_type == "citation":
        return "sentence"
    return "paragraph"


def _build_editor_repair_tasks(result: EditorialReviewResult) -> list[RepairTask]:
    tasks: list[RepairTask] = []
    for suggestion in result.suggestions:
        issue_type = _issue_type_for_text(suggestion.finding, suggestion.suggestion)
        tasks.append(RepairTask(
            source="editor",
            severity="blocking" if suggestion.severity == "critical" else "advisory",
            section=suggestion.location,
            line_span=[],
            quoted_passage="",
            issue_type=issue_type,
            expected_outcome=suggestion.suggestion or suggestion.finding,
            safe_edit_ops=[],
            rewrite_scope=_rewrite_scope_for_issue(issue_type),
        ))
    for message in result.blocking_issues + result.advisory_issues:
        if any(task.expected_outcome == message for task in tasks):
            continue
        issue_type = _issue_type_for_text(message)
        tasks.append(RepairTask(
            source="editor",
            severity="blocking" if message in result.blocking_issues else "advisory",
            section="",
            line_span=[],
            quoted_passage="",
            issue_type=issue_type,
            expected_outcome=message,
            safe_edit_ops=[],
            rewrite_scope=_rewrite_scope_for_issue(issue_type),
        ))
    return tasks


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


async def generate_editorial_review(
    provider: "AIProvider",
    original_manuscript: str,
    revised_manuscript: str,
    reviewer_comments: list[dict],
    author_responses: list[dict],
    journal_name: str = "",
) -> EditorialReviewResult:
    """
    Generate an editorial review of the revised manuscript.

    Returns a dict with: editor_decision, overall_assessment, suggestions,
    praise, remaining_concerns.
    """
    original_structure = _build_section_index_header(_build_section_index(original_manuscript))
    revised_structure = _build_section_index_header(_build_section_index(revised_manuscript))
    audit_json = json.dumps(_audit_revision(original_manuscript, revised_manuscript), indent=2, ensure_ascii=False)

    comments_json = json.dumps(reviewer_comments, indent=2, ensure_ascii=False)
    responses_json = json.dumps(author_responses, indent=2, ensure_ascii=False)

    cacheable_context = "\n\n".join([
        f"ORIGINAL MANUSCRIPT STRUCTURE:\n{original_structure or '(not available)'}",
        f"REVISED MANUSCRIPT STRUCTURE:\n{revised_structure or '(not available)'}",
        f"PRESERVATION AUDIT:\n{audit_json}",
    ])

    chunks = build_manuscript_chunks(
        revised_manuscript or "(No manuscript)",
        section_index=_build_section_index(revised_manuscript or "(No manuscript)"),
        max_chars=12000,
        overlap_paragraphs=1,
    )

    merged_suggestions: dict[tuple[str, str, str, str], dict] = {}
    praise: list[str] = []
    remaining: list[str] = []
    blocking: list[str] = []
    advisory: list[str] = []
    assessments: list[str] = []
    decision_order = {"accept": 1, "minor_revision": 2, "major_revision": 3}
    decision = "accept"

    try:
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
                cacheable_context=cacheable_context,
                system=_EDITORIAL_SYSTEM,
                user=_EDITORIAL_CHUNK_USER_TMPL.format(
                    journal_name=journal_name or "the journal",
                    comments_json=comments_json,
                    responses_json=responses_json,
                    chunk_context=build_chunk_context(chunk),
                ),
                json_mode=True,
                temperature=0.15,
                max_tokens=4096,
            )
            raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
            raw = re.sub(r'\s*```$', '', raw.strip())
            result = json.loads(raw)
            for s in (result.get("suggestions") or []):
                if not isinstance(s, dict):
                    continue
                suggestion = {
                    "category": str(s.get("category", "quality")).strip(),
                    "severity": str(s.get("severity", "minor")).strip(),
                    "location": str(s.get("location", "")).strip(),
                    "finding": str(s.get("finding", "")).strip(),
                    "suggestion": str(s.get("suggestion", "")).strip(),
                }
                key = (
                    suggestion["category"],
                    suggestion["location"],
                    suggestion["finding"],
                    suggestion["suggestion"],
                )
                merged_suggestions[key] = suggestion
            praise.extend(result.get("praise", []) if isinstance(result.get("praise", []), list) else [])
            remaining.extend(result.get("remaining_concerns", []) if isinstance(result.get("remaining_concerns", []), list) else [])
            blocking.extend(result.get("blocking_issues", []) if isinstance(result.get("blocking_issues", []), list) else [])
            advisory.extend(result.get("advisory_issues", []) if isinstance(result.get("advisory_issues", []), list) else [])
            assessment = str(result.get("overall_assessment", "")).strip()
            if assessment:
                assessments.append(assessment)
            returned_decision = str(result.get("editor_decision", "minor_revision")).strip()
            if decision_order.get(returned_decision, 0) > decision_order.get(decision, 0):
                decision = returned_decision
    except Exception as exc:
        logger.exception("Editorial review generation failed")
        return _fallback_result(str(exc))

    merged = EditorialReviewResult(
        editor_decision="major_revision" if blocking else ("minor_revision" if advisory or remaining else decision),
        overall_assessment=" ".join(_merge_unique_str(assessments)),
        suggestions=list(merged_suggestions.values()),
        praise=[str(p) for p in _merge_unique_str(praise)],
        remaining_concerns=[str(c) for c in _merge_unique_str(remaining)],
        blocking_issues=[str(b) for b in _merge_unique_str(blocking)],
        advisory_issues=[str(a) for a in _merge_unique_str(advisory)],
    )
    merged.suggestions = [
        suggestion
        for suggestion in merged.suggestions
        if not _should_drop_issue(f"{suggestion.finding} {suggestion.suggestion}", revised_manuscript)
    ]
    merged.remaining_concerns = [
        item for item in merged.remaining_concerns if not _should_drop_issue(item, revised_manuscript)
    ]
    merged.blocking_issues = [
        item for item in merged.blocking_issues if not _should_drop_issue(item, revised_manuscript)
    ]
    merged.advisory_issues = [
        item for item in merged.advisory_issues if not _should_drop_issue(item, revised_manuscript)
    ]
    if merged.blocking_issues:
        merged.editor_decision = "major_revision"
    elif merged.advisory_issues or merged.remaining_concerns:
        merged.editor_decision = "minor_revision"
    elif decision:
        merged.editor_decision = decision
    merged.repair_tasks = _build_editor_repair_tasks(merged)
    if not merged.overall_assessment:
        if merged.blocking_issues:
            merged.overall_assessment = "Editorial review found blocking manuscript issues that still require repair before the revision can be treated as complete."
        elif merged.advisory_issues:
            merged.overall_assessment = "Editorial review found non-blocking manuscript issues that should be polished before export."
        else:
            merged.overall_assessment = "Editorial review found no substantive remaining issues in the covered manuscript text."
    return merged
