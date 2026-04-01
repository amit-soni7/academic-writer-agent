"""
consistency_audit.py

Stage 3.5 of the peer review pipeline: verifies that the revised manuscript
and point-by-point response letter are internally consistent.

Checks:
  1. Every reviewer point received a response
  2. Every claimed change appears in the manuscript
  3. No major concern remains unresolved
  4. Edits did not create contradictions elsewhere
  5. Conclusion tone is appropriate (not over-weakened or inflated)
  6. Tone did not deteriorate
  7. Line references in the response letter match the revised manuscript
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from models import (
    AuditCheck,
    AuditRecommendedEdit,
    ConsistencyAuditResult,
    PeerReviewReport,
    RepairTask,
    RevisionActionMap,
)
from services.manuscript_utils import (
    build_chunk_context,
    build_manuscript_chunks,
    build_section_index,
    locate_text_span,
    manuscript_appears_truncated,
    validate_change_operations,
)

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)


_SYSTEM = """\
You are a meticulous academic manuscript auditor. Your job is to verify that a
revised manuscript and its point-by-point response letter are internally consistent
without introducing preservation drift or revision regressions.

You must check:

1. PRESERVATION: Were title, headings, figures, tables, citations, references,
   and overall structure preserved unless the revision explicitly required changes?

2. WORD-COUNT / SCOPE CONTROL: Did the revision stay within reasonable scope and
   avoid unnecessary rewriting or padding?

3. INTERNAL CONSISTENCY: Did the revision introduce contradictions, logical gaps,
   orphan citations, broken cross-references, or other integrity problems?

4. RESPONSE-LETTER ACCURACY: If a response letter is provided, verify that any
   claimed manuscript changes are actually reflected in the revised manuscript.
   If no response letter is provided, skip this check.

5. REFERENCE ACCURACY: If a response letter is provided, do section/line references in the response letter
   correspond to actual locations in the revised manuscript? If no response letter is provided, skip this check.

Output a JSON object:
{
  "checks": [
    {
      "check": "description of what was verified",
      "passed": true/false,
      "detail": "explanation of result",
      "passage": "(FAILED checks only) EXACT verbatim quote of the problematic text from the manuscript",
      "recommended_edits": [
        {
          "edit_type": "replace",
          "find": "EXACT text to find in the manuscript (copy character-for-character)",
          "replace_with": "the corrected replacement text"
        }
      ]
    }
  ],
  "all_passed": true/false,
  "unresolved_concerns": ["list of concerns that remain unresolved"],
  "new_issues": ["list of new issues introduced by the revision"],
  "blocking_issues": ["major preservation/integrity issues that should block final response"],
  "advisory_issues": ["minor cautions that do not need to block final response"],
  "summary": "2-3 sentence summary of audit results"
}

CRITICAL rules for FAILED checks:
- "passage" must be the EXACT verbatim quote from the manuscript where the problem occurs.
  Copy-paste, do NOT paraphrase or truncate. Max 300 characters.
- "recommended_edits" must contain at least one concrete edit operation to fix this specific issue.
- "find" must be copied CHARACTER-FOR-CHARACTER from the manuscript — the system will do
  exact string matching. Even a single character difference will cause the edit to fail.
- edit_type "replace": replace "find" text with "replace_with" text
- edit_type "insert_after": insert "replace_with" text after the "find" anchor text
- edit_type "delete": remove the "find" text entirely (set "replace_with" to "")
- Passed checks do NOT need "passage" or "recommended_edits" — omit them.

Be thorough but fair. Minor formatting differences are not failures.
Focus on preservation and revision integrity, not whether the reviewers were fully satisfied.
Treat structural drift, deleted figures/tables/references, contradiction introduction,
or phantom response-letter claims as BLOCKING issues.
Treat minor calibration or wording cautions as ADVISORY issues.
When the response letter is missing, audit the manuscript itself rather than penalizing the absence of the letter.
Do NOT report the workflow fact that no original manuscript or no response letter
was supplied as an issue by itself. If a check cannot be done because that input
is intentionally absent, skip that check silently instead of creating a concern.
In this workflow, [CITE:key] grounding markers are valid temporary citations and
the final bibliography may be normalized at export time. Do NOT treat [CITE:key]
placeholders as orphan citations or missing references solely because a final
formatted reference list is deferred until export.
Do NOT create advisory reminders that merely restate the workflow, such as
"ensure export resolves placeholders" or "references will be formatted later",
unless you found an actual citation-resolution mismatch in the manuscript itself.
"""


_USER_TMPL = """\
ORIGINAL REVIEW:
Decision: {decision}
Major concerns: {n_major}
Minor concerns: {n_minor}

{review_concerns}

ACTION MAP SUMMARY:
Accepted: {accepted} | Partially accepted: {partial} | Declined: {declined}

POINT-BY-POINT RESPONSE LETTER:
{response_letter}

WORKFLOW NOTE:
- [CITE:key] markers are valid temporary citation placeholders in this manuscript workflow.
- Final reference formatting may happen at export time rather than inside the revision draft itself.
"""


_CHUNK_USER_TMPL = """\
VISIBLE REVISED MANUSCRIPT CHUNK:
{chunk_context}

Audit ONLY the visible chunk above.
- Report issues only when the quoted passage appears verbatim in this chunk.
- Do NOT infer that the full manuscript ends here; this is one coverage chunk.
- If a problem cannot be anchored to visible chunk text, omit it.

Return ONLY the JSON object."""


def _load_audit_payload(raw: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        try:
            return json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse consistency audit JSON")
            return {}


def _issue_type_for_text(*parts: str) -> str:
    text = " ".join(p for p in parts if p).lower()
    if any(term in text for term in ("placeholder", "production-note", "editorial instruction")):
        return "placeholder"
    if any(term in text for term in ("truncat", "structurally incomplete", "cut off", "mid-sentence")):
        return "structural"
    if any(term in text for term in ("corrupt", "duplicat", "artifact", "single-version")):
        return "corruption"
    if any(term in text for term in ("citation", "reference", "cross-reference")):
        return "citation"
    return "other"


def _rewrite_scope_for_issue(issue_type: str) -> str:
    if issue_type in {"placeholder", "structural", "corruption"}:
        return "paragraph"
    if issue_type == "citation":
        return "sentence"
    return "paragraph"


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
    # Drop truncation claims when the manuscript is NOT actually truncated
    if any(term in lowered for term in ("truncat", "structurally incomplete", "cut off", "mid-sentence")):
        return not manuscript_appears_truncated(manuscript_text)
    # Drop placeholder claims when no placeholders exist
    if "placeholder" in lowered:
        manuscript_lower = manuscript_text.lower()
        return all(
            token not in manuscript_lower
            for token in ("[fut]", "complete the citation", "editorial placeholder", "placeholder")
        )
    # Drop chunk-visibility artifacts — these are caused by chunking, not real issues
    if any(term in lowered for term in (
        "cannot be verified in this chunk",
        "not visible in this chunk",
        "cannot yet be verified in this chunk",
        "passages are not visible",
        "this chunk does not itself",
        "visible chunk does not",
    )):
        return True
    return False


def _build_repair_tasks(checks: list[AuditCheck], blocking: list[str], advisory: list[str], manuscript_text: str) -> list[RepairTask]:
    tasks: list[RepairTask] = []
    blocking_text = " ".join(blocking).lower()
    advisory_text = " ".join(advisory).lower()
    for check in checks:
        if check.passed:
            continue
        issue_type = _issue_type_for_text(check.check, check.detail)
        severity = "blocking"
        if check.check.lower() not in blocking_text and check.detail.lower() not in blocking_text and advisory_text:
            severity = "advisory"

        span = locate_text_span(manuscript_text, check.passage) if check.passage else None
        safe_ops, _unsafe_ops = validate_change_operations(
            manuscript_text,
            [
                {
                    "type": edit.edit_type,
                    "find": edit.find,
                    "anchor": edit.find if edit.edit_type == "insert_after" else "",
                    "replace_with": edit.replace_with,
                    "text": edit.replace_with,
                }
                for edit in check.recommended_edits
            ],
        ) if check.recommended_edits else ([], [])
        tasks.append(RepairTask(
            source="audit",
            severity=severity,
            section=(span or {}).get("section", ""),
            line_span=[(span or {}).get("start_line", 0), (span or {}).get("end_line", 0)] if span else [],
            quoted_passage=(span or {}).get("text", check.passage),
            issue_type=issue_type,
            expected_outcome=check.detail or check.check,
            safe_edit_ops=[
                AuditRecommendedEdit(
                    edit_type=str(op.get("type", "replace")),
                    find=str(op.get("find", "") or op.get("anchor", "")),
                    replace_with=str(op.get("replace_with", "") or op.get("text", "")),
                )
                for op in safe_ops
            ],
            rewrite_scope=_rewrite_scope_for_issue(issue_type),
        ))
    deduped: list[RepairTask] = []
    seen: set[tuple[str, str, str]] = set()
    for task in tasks:
        key = (task.source, task.quoted_passage, task.expected_outcome)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(task)
    return deduped


async def run_consistency_audit(
    provider: "AIProvider",
    review: PeerReviewReport,
    action_map: RevisionActionMap | None,
    response_letter: str,
    revised_manuscript: str,
) -> ConsistencyAuditResult:
    """
    Verify that the revised manuscript and response letter are internally
    consistent and that all reviewer concerns have been properly addressed.
    """
    # Format review concerns for the audit
    concern_lines = []
    for i, c in enumerate(review.major_concerns, 1):
        concern_lines.append(f"  MAJOR {i}: {c.concern}")
        if getattr(c, 'quoted_passage', ''):
            concern_lines.append(f'    Target text: "{c.quoted_passage}"')
        if c.satisfaction_criterion:
            concern_lines.append(f"    Satisfaction criterion: {c.satisfaction_criterion}")
    for i, c in enumerate(review.minor_concerns, 1):
        concern_lines.append(f"  MINOR {i}: {c.concern}")
        if getattr(c, 'quoted_passage', ''):
            concern_lines.append(f'    Target text: "{c.quoted_passage}"')

    review_context = _USER_TMPL.format(
        decision=review.decision,
        n_major=len(review.major_concerns),
        n_minor=len(review.minor_concerns),
        review_concerns="\n".join(concern_lines) or "(none)",
        accepted=action_map.accepted_count if action_map else "N/A",
        partial=action_map.partially_accepted if action_map else "N/A",
        declined=action_map.declined_count if action_map else "N/A",
        response_letter=response_letter or "(No response letter provided)",
    )
    chunks = build_manuscript_chunks(
        revised_manuscript or "(No manuscript)",
        section_index=build_section_index(revised_manuscript or "(No manuscript)"),
        max_chars=12000,
        overlap_paragraphs=1,
    )

    aggregated_checks: dict[tuple[str, str, str, bool], AuditCheck] = {}
    unresolved: list[str] = []
    new_issues: list[str] = []
    blocking: list[str] = []
    advisory: list[str] = []
    summaries: list[str] = []

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
            temperature=0.1,
            max_tokens=4096,
        )
        data = _load_audit_payload(raw)
        for item in data.get("checks", []):
            if not isinstance(item, dict):
                continue
            rec_edits = []
            for e in (item.get("recommended_edits") or []):
                if isinstance(e, dict) and e.get("find"):
                    rec_edits.append(AuditRecommendedEdit(
                        find=str(e["find"]),
                        replace_with=str(e.get("replace_with", "")),
                        edit_type=str(e.get("edit_type", "replace")),
                    ))
            check = AuditCheck(
                check=str(item.get("check", "")),
                passed=bool(item.get("passed", True)),
                detail=str(item.get("detail", "")),
                passage=str(item.get("passage", "")),
                recommended_edits=rec_edits,
            )
            if check.passage and not locate_text_span(revised_manuscript, check.passage):
                continue
            key = (check.check, check.detail, check.passage, check.passed)
            aggregated_checks[key] = check
        unresolved.extend(data.get("unresolved_concerns", []) if isinstance(data.get("unresolved_concerns", []), list) else [])
        new_issues.extend(data.get("new_issues", []) if isinstance(data.get("new_issues", []), list) else [])
        blocking.extend(data.get("blocking_issues", []) if isinstance(data.get("blocking_issues", []), list) else [])
        advisory.extend(data.get("advisory_issues", []) if isinstance(data.get("advisory_issues", []), list) else [])
        summary = str(data.get("summary", "")).strip()
        if summary:
            summaries.append(summary)

    checks = [
        check
        for check in aggregated_checks.values()
        if not (not check.passed and _should_drop_issue(f"{check.check} {check.detail}", revised_manuscript))
    ]
    unresolved = _merge_unique_str(unresolved)
    new_issues = _merge_unique_str(new_issues)
    blocking = _merge_unique_str(blocking)
    advisory = _merge_unique_str(advisory)
    unresolved = [item for item in unresolved if not _should_drop_issue(item, revised_manuscript)]
    new_issues = [item for item in new_issues if not _should_drop_issue(item, revised_manuscript)]
    blocking = [item for item in blocking if not _should_drop_issue(item, revised_manuscript)]
    advisory = [item for item in advisory if not _should_drop_issue(item, revised_manuscript)]
    repair_tasks = _build_repair_tasks(checks, blocking, advisory, revised_manuscript)

    return ConsistencyAuditResult(
        checks=checks,
        all_passed=not blocking and all(c.passed for c in checks),
        unresolved_concerns=[str(u) for u in unresolved],
        new_issues=[str(n) for n in new_issues],
        blocking_issues=[str(b) for b in blocking],
        advisory_issues=[str(a) for a in advisory],
        repair_tasks=repair_tasks,
        summary=" ".join(_merge_unique_str(summaries)),
    )
