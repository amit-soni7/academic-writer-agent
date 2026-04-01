from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import TYPE_CHECKING

from models import (
    EditorialReviewResult,
    PeerReviewReport,
    ReReviewResult,
    ResponseQCResult,
    RevisionAgentExportReadiness,
    RevisionAgentLedgerItem,
    RevisionAgentQaMetrics,
    RevisionAgentStatus,
    RevisionResult,
)
from services.consistency_audit import run_consistency_audit
from services.editorial_reviewer import generate_editorial_review
from services.manuscript_citation_formatter import build_citation_map, normalize_numbered_citation_order
from services.manuscript_utils import manuscript_appears_truncated
from services.project_repo import (
    get_peer_review_result,
    get_revision_agent_state,
    load_project,
    save_article,
    save_revision_agent_state,
)
from services.re_reviewer import generate_re_review
from services.revision_action_map import generate_revision_action_map
from services.revision_writer import (
    apply_followup_revision,
    generate_final_response_letter,
    generate_revision_package,
)
from services.token_context import TokenContext

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)


def _serialize_citation_map(article_text: str, summaries: list[dict]) -> str:
    citation_map = build_citation_map(article_text, summaries)
    return json.dumps(citation_map, ensure_ascii=False) if citation_map else "{}"

_AGENT_TASKS: dict[str, asyncio.Task] = {}
_MAX_AMENDMENT_ROUNDS = 5


def _detect_truncation(text: str) -> bool:
    return manuscript_appears_truncated(text)


async def _complete_truncated_manuscript(
    provider: "AIProvider",
    truncated: str,
    original: str,
    article_type: str,
    word_limit: int,
) -> str:
    """Ask the AI to continue/complete a truncated manuscript."""
    system = (
        "You are an expert academic writer. The manuscript below was truncated "
        "(cut off mid-sentence or missing sections). Your task is to CONTINUE the "
        "manuscript from exactly where it stopped, completing all remaining sections "
        f"including Discussion and References. Target: {word_limit} words total.\n\n"
        "RULES:\n"
        "- Continue EXACTLY from where the text stopped — do not rewrite existing content.\n"
        "- Match the writing style, citation format, and structure of the existing text.\n"
        "- Preserve all [CITE:key] markers.\n"
        "- Include a complete References section at the end.\n"
        "- Return ONLY the continuation text (not the full manuscript)."
    )
    user = (
        f"TRUNCATED MANUSCRIPT ({len(truncated.split())} words, target {word_limit}):\n\n"
        f"{truncated}\n\n---\n\n"
        "CONTINUE the manuscript from where it stopped. "
        "Complete all remaining sections and end with a References section."
    )
    continuation = await provider.complete(
        system=system,
        user=user,
        json_mode=False,
        temperature=0.3,
        max_tokens=max(8192, (word_limit - len(truncated.split())) * 4),
    )
    if continuation and continuation.strip():
        # Append continuation to the truncated text
        return truncated.rstrip() + "\n\n" + continuation.strip()
    return truncated


def is_revision_agent_running(project_id: str) -> bool:
    task = _AGENT_TASKS.get(project_id)
    return bool(task and not task.done())


def _default_export_readiness() -> RevisionAgentExportReadiness:
    return RevisionAgentExportReadiness(
        manuscript_markdown_ready=False,
        manuscript_docx_ready=False,
        manuscript_pdf_ready=None,
        response_markdown_ready=False,
        response_docx_ready=False,
        all_required_ready=False,
    )


def default_revision_agent_status() -> RevisionAgentStatus:
    return RevisionAgentStatus(
        status="idle",
        stage="idle",
        current_round=0,
        blocking_issue_count=0,
        advisory_issue_count=0,
        final_response_ready=False,
        export_readiness=_default_export_readiness(),
        completed_reason="",
        ledger_entries=[],
        stop_requested=False,
        last_error="",
        last_blocking_signature="",
        repeated_blocking_rounds=0,
        action_map=None,
        revision=None,
        consistency_audit=None,
        re_review=None,
        editorial_review=None,
        baseline_article="",
        last_known_good_article="",
        qa_metrics=RevisionAgentQaMetrics(),
        user_guidance="",
    )


async def get_revision_agent_status(project_id: str) -> RevisionAgentStatus:
    raw = await get_revision_agent_state(project_id)
    if not raw:
        return default_revision_agent_status()
    try:
        status = RevisionAgentStatus.model_validate(raw)
    except Exception:
        logger.warning("Failed to parse persisted revision agent state for %s", project_id)
        return default_revision_agent_status()
    status.export_readiness = _compute_export_readiness(status.revision)
    status.final_response_ready = _final_response_ready(status.revision)
    return status


async def _save_revision_agent_status(project_id: str, status: RevisionAgentStatus) -> None:
    status.export_readiness = _compute_export_readiness(status.revision)
    status.final_response_ready = _final_response_ready(status.revision)
    await save_revision_agent_state(project_id, status.model_dump(mode="json", exclude_none=True))


def _reviewer_comments_payload(review: PeerReviewReport) -> list[dict]:
    comments: list[dict] = []
    for i, concern in enumerate(review.major_concerns, 1):
        comments.append({
            "reviewer_number": 1,
            "comment_number": i,
            "original_comment": concern.concern,
            "category": "major",
        })
    offset = len(comments)
    for i, concern in enumerate(review.minor_concerns, 1):
        comments.append({
            "reviewer_number": 1,
            "comment_number": offset + i,
            "original_comment": concern.concern,
            "category": "minor",
        })
    return comments


def _response_entries(revision: RevisionResult | None) -> list[dict]:
    if not revision or not isinstance(revision.response_data, dict):
        return []
    responses = revision.response_data.get("responses", [])
    return responses if isinstance(responses, list) else []


def _compute_export_readiness(revision: RevisionResult | None) -> RevisionAgentExportReadiness:
    has_manuscript = bool(revision and revision.revised_article.strip())
    has_response = bool(revision and revision.point_by_point_reply.strip())
    response_docx_ready = has_response and bool(
        (revision and revision.response_data and isinstance(revision.response_data, dict))
        or has_response
    )
    readiness = RevisionAgentExportReadiness(
        manuscript_markdown_ready=has_manuscript,
        manuscript_docx_ready=has_manuscript,
        manuscript_pdf_ready=None,
        response_markdown_ready=has_response,
        response_docx_ready=response_docx_ready,
        all_required_ready=has_manuscript and has_response and response_docx_ready,
    )
    return readiness


def _final_response_ready(revision: RevisionResult | None) -> bool:
    return bool(
        revision
        and revision.point_by_point_reply.strip()
        and (not revision.response_qc or not revision.response_qc.blocking_issues)
    )


def _issue_id(source: str, severity: str, message: str) -> str:
    return hashlib.sha1(f"{source}:{severity}:{message}".encode("utf-8")).hexdigest()[:12]


_STRUCTURAL_PATTERNS = (
    'deleted', 'missing section', 'truncat', 'phantom', 'contradict',
    'broken cross-ref', 'integrity problem',
    'preservation failure', 'preservation drift',
    'structurally incomplete', 'orphan', 'regression',
)


def _normalize_for_signature(msg: str) -> str:
    """Normalize a blocking message for signature comparison."""
    return re.sub(r'\s+', ' ', msg.lower().strip())[:150]


_ADVISORY_ONLY_PATTERNS = (
    # Reference/formatting — genuinely non-blocking (handled at export time)
    'formatting inconsisten', 'spacing', 'double period', 'punctuation',
    'reference formatting', 'reference list format', 'style inconsisten',
    'copyedit', 'missing space', 'html entit',
    # Wording calibration — legitimate advisory, not structural
    'operationali', 'not operationalized', 'under-operationali',
    'insufficiently operationali', 'not fully operationali',
    'too general', 'not sufficiently', 'overgeneral', 'overgenerali',
    'calibrat', 'evidentiary wording',
)


def _is_structural_issue(msg: str) -> bool:
    """Return True if the issue is structural/integrity (should block). False for wording/style."""
    lowered = msg.lower()
    # Explicitly advisory patterns override structural keywords
    if any(pat in lowered for pat in _ADVISORY_ONLY_PATTERNS):
        return False
    return any(pat in lowered for pat in _STRUCTURAL_PATTERNS)


def _audit_issue_lists(result) -> tuple[list[str], list[str]]:
    if not result:
        return [], []

    # Even when the audit explicitly classifies blocking vs advisory,
    # post-filter to demote non-structural issues that the AI wrongly
    # classified as blocking (e.g., reference formatting, wording style)
    if result.blocking_issues or result.advisory_issues:
        real_blocking = [m for m in result.blocking_issues if _is_structural_issue(m)]
        demoted = [m for m in result.blocking_issues if not _is_structural_issue(m)]
        advisory = list(result.advisory_issues) + demoted
        return real_blocking, list(dict.fromkeys(advisory))

    # Otherwise, classify each issue: structural → blocking, wording/style → advisory
    all_issues = [
        *result.unresolved_concerns,
        *result.new_issues,
        *[
            (
                f"{check.check}{f': {check.detail}' if check.detail else ''}"
                + (f' [at: "{check.passage[:80]}..."]' if getattr(check, "passage", "") else "")
            )
            for check in result.checks
            if not check.passed
        ],
    ]
    blocking = [msg for msg in all_issues if _is_structural_issue(msg)]
    advisory_raw = list(result.advisory_issues) + [msg for msg in all_issues if not _is_structural_issue(msg)]
    advisory = list(dict.fromkeys(advisory_raw))  # deduplicate, preserve order
    return blocking, advisory


def _rereview_issue_lists(result: ReReviewResult | None) -> tuple[list[str], list[str]]:
    if not result:
        return [], []
    blocking = (
        list(result.blocking_issues)
        if result.blocking_issues
        else (
            [*result.remaining_issues, *result.new_issues]
            if result.needs_another_round or result.updated_recommendation in {"major_revision", "reject"}
            else []
        )
    )
    advisory = (
        list(result.advisory_issues)
        if result.advisory_issues
        else (list(result.remaining_issues) if result.updated_recommendation == "minor_revision" else [])
    )
    return blocking, advisory


def _editor_issue_lists(result: EditorialReviewResult | None) -> tuple[list[str], list[str]]:
    if not result:
        return [], []
    blocking = (
        list(result.blocking_issues)
        if result.blocking_issues
        else (
            [
                *result.remaining_concerns,
                *[
                    f"{s.location or 'Editorial assessment'}: {s.finding}"
                    for s in result.suggestions
                    if s.severity == "critical"
                ],
            ]
            if result.editor_decision == "major_revision"
            else []
        )
    )
    advisory = (
        list(result.advisory_issues)
        if result.advisory_issues
        else [
            *result.remaining_concerns,
            *[
                f"{s.location or 'Editorial assessment'}: {s.finding}"
                for s in result.suggestions
                if s.severity != "critical"
            ],
        ]
    )
    return blocking, advisory


def _response_qc_issue_lists(result: ResponseQCResult | None) -> tuple[list[str], list[str]]:
    if not result:
        return [], []
    return list(result.blocking_issues), list(result.advisory_issues)


def _current_ledger_entries(status: RevisionAgentStatus, round_number: int) -> tuple[list[RevisionAgentLedgerItem], list[str]]:
    current_entries: list[RevisionAgentLedgerItem] = []
    current_blocking_messages: list[str] = []

    issue_groups = [
        ("audit", *_audit_issue_lists(status.consistency_audit)),
        ("rereview", *_rereview_issue_lists(status.re_review)),
        ("editor", *_editor_issue_lists(status.editorial_review)),
        ("response_qc", *_response_qc_issue_lists(status.revision.response_qc if status.revision else None)),
    ]

    for source, blocking_list, advisory_list in issue_groups:
        for severity, messages in (("blocking", blocking_list), ("advisory", advisory_list)):
            for message in messages:
                clean = str(message).strip()
                if not clean:
                    continue
                item = RevisionAgentLedgerItem(
                    item_id=_issue_id(source, severity, clean),
                    source=source,
                    severity=severity,
                    message=clean,
                    round_number=round_number,
                    resolved=False,
                    justification="",
                )
                current_entries.append(item)
                if severity == "blocking":
                    current_blocking_messages.append(clean)

    return current_entries, current_blocking_messages


def _merge_ledger(
    existing: list[RevisionAgentLedgerItem],
    current: list[RevisionAgentLedgerItem],
    resolution_justification: str = "",
) -> list[RevisionAgentLedgerItem]:
    current_by_id = {item.item_id: item for item in current}
    merged: dict[str, RevisionAgentLedgerItem] = {item.item_id: item for item in existing}

    for item_id, current_item in current_by_id.items():
        prior = merged.get(item_id)
        if prior:
            prior.source = current_item.source
            prior.severity = current_item.severity
            prior.message = current_item.message
            prior.resolved = False
            if not prior.round_number:
                prior.round_number = current_item.round_number
        else:
            merged[item_id] = current_item

    for item_id, prior in list(merged.items()):
        if item_id not in current_by_id and not prior.resolved:
            prior.resolved = True
            if resolution_justification and not prior.justification:
                prior.justification = resolution_justification

    return sorted(merged.values(), key=lambda item: (item.resolved, item.round_number, item.source, item.message))


def _latest_resolution_context(revision: RevisionResult | None, previous_justification_count: int) -> str:
    if not revision:
        return ""
    justifications = revision.change_justifications or []
    new_items = justifications[previous_justification_count:]
    return " | ".join(new_items[-3:]).strip()


def _accumulate_qa_metrics(status: RevisionAgentStatus, revision: RevisionResult | None) -> None:
    telemetry = getattr(revision, "repair_telemetry", None) if revision else None
    if not telemetry:
        return
    status.qa_metrics.invalid_qa_findings += int(getattr(telemetry, "invalid_qa_findings", 0) or 0)
    status.qa_metrics.discarded_blockers += int(getattr(telemetry, "discarded_blockers", 0) or 0)
    status.qa_metrics.merged_repair_groups += int(getattr(telemetry, "merged_repair_groups", 0) or 0)
    status.qa_metrics.structural_repair_invocations += int(getattr(telemetry, "structural_repair_invocations", 0) or 0)


async def request_revision_agent_stop(project_id: str) -> RevisionAgentStatus:
    status = await get_revision_agent_status(project_id)
    status.stop_requested = True
    if status.status == "idle":
        status.status = "needs_user_review"
        status.completed_reason = "Stopped by user before execution started."
    await _save_revision_agent_status(project_id, status)
    return status


async def launch_revision_agent(
    project_id: str,
    user_id: str,
    provider: "AIProvider",
    journal_style: object | None = None,
    user_guidance: str = "",
) -> RevisionAgentStatus:
    if is_revision_agent_running(project_id):
        return await get_revision_agent_status(project_id)

    status = await get_revision_agent_status(project_id)
    status.status = "running"
    status.stage = "starting"
    status.stop_requested = False
    status.last_error = ""
    status.completed_reason = ""
    if status.current_round == 0:
        status.qa_metrics = RevisionAgentQaMetrics()
    if user_guidance:
        status.user_guidance = user_guidance
    await _save_revision_agent_status(project_id, status)

    task = asyncio.create_task(
        _run_revision_agent(project_id=project_id, user_id=user_id, provider=provider, journal_style=journal_style)
    )
    _AGENT_TASKS[project_id] = task

    def _cleanup(done_task: asyncio.Task) -> None:
        _AGENT_TASKS.pop(project_id, None)
        try:
            done_task.result()
        except Exception:
            logger.exception("Revision agent task failed for %s", project_id)

    task.add_done_callback(_cleanup)
    return status


async def _run_revision_agent(
    project_id: str,
    user_id: str,
    provider: "AIProvider",
    journal_style: object | None = None,
) -> None:
    status = await get_revision_agent_status(project_id)

    try:
        project = await load_project(user_id, project_id)
        if not project:
            raise RuntimeError("Project not found.")

        review_data = await get_peer_review_result(project_id)
        if not review_data:
            raise RuntimeError("Peer review report not found. Generate peer review first.")
        review = PeerReviewReport(**review_data)

        from models import PaperSummary as _PaperSummary

        summaries = [
            _PaperSummary(**v)
            for v in (project.get("summaries") or {}).values()
            if isinstance(v, dict)
        ]
        query = project.get("query", "") or ""
        article_type = project.get("article_type") or "review"
        selected_journal = project.get("selected_journal") or ""
        manuscript_title = project.get("manuscript_title") or ""
        base_article = project.get("article", "") or ""

        if not base_article.strip():
            raise RuntimeError("No manuscript draft found. Draft the manuscript before running the revision agent.")

        if not status.baseline_article.strip():
            status.baseline_article = base_article
        baseline_article = status.baseline_article or base_article
        if not status.last_known_good_article.strip():
            status.last_known_good_article = baseline_article

        previous_justification_count = len(status.revision.change_justifications) if status.revision else 0

        if status.stop_requested:
            status.status = "needs_user_review"
            status.completed_reason = "Stopped by user."
            status.stage = "stopped"
            await _save_revision_agent_status(project_id, status)
            return

        if not status.action_map:
            status.stage = "action_map"
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="revision_action_map"):
                status.action_map = await generate_revision_action_map(provider, baseline_article, review)
            await _save_revision_agent_status(project_id, status)

        if not status.revision or not status.revision.revised_article.strip():
            status.stage = "revise_manuscript"
            status.current_round = max(status.current_round, 1)
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="revision"):
                revision_result = await generate_revision_package(
                    provider=provider,
                    summaries=summaries,
                    query=query,
                    article=baseline_article,
                    review=review,
                    journal=selected_journal,
                    article_type=article_type,
                    journal_style=journal_style,
                    manuscript_packs=project.get("manuscript_packs"),
                    word_limit=project.get("word_limit") or 4000,
                    manuscript_title=manuscript_title,
                    action_map=status.action_map,
                    generate_response_letter=False,
                )
            revised_article = revision_result.revised_article
            if revised_article.strip() and journal_style:
                revised_article = normalize_numbered_citation_order(
                    revised_article,
                    journal_style,
                    list((project.get("summaries") or {}).values()),
                )
                revision_result.revised_article = revised_article

            # ── Truncation detection: if manuscript is cut off, expand it ────
            if _detect_truncation(revised_article):
                logger.warning("Revision agent detected truncated manuscript for %s — attempting completion", project_id)
                status.stage = "completing_truncated"
                await _save_revision_agent_status(project_id, status)
                async with TokenContext(project_id=project_id, user_id=user_id, stage="complete_truncation"):
                    completed = await _complete_truncated_manuscript(
                        provider, revised_article, baseline_article, article_type,
                        project.get("word_limit") or 4000,
                    )
                if completed and len(completed) > len(revised_article):
                    revised_article = completed
                    if journal_style:
                        revised_article = normalize_numbered_citation_order(
                            revised_article, journal_style,
                            list((project.get("summaries") or {}).values()),
                        )
                    revision_result.revised_article = revised_article

            if revised_article.strip():
                await save_article(
                    project_id,
                    revised_article,
                    selected_journal,
                    citation_map=_serialize_citation_map(revised_article, list((project.get("summaries") or {}).values())),
                )
            status.revision = revision_result
            status.consistency_audit = None
            status.re_review = None
            status.editorial_review = None
            await _save_revision_agent_status(project_id, status)

            # ── Immediate retry if edits failed in initial revision ──────
            if (revision_result.failed_changes or 0) > 0:
                total_ops = (revision_result.applied_changes or 0) + revision_result.failed_changes
                logger.warning(
                    "Initial revision: %d/%d edits failed — running immediate retry for project %s",
                    revision_result.failed_changes, total_ops, project_id,
                )
                status.stage = "retry_failed_edits"
                await _save_revision_agent_status(project_id, status)
                async with TokenContext(project_id=project_id, user_id=user_id, stage="retry_failed_edits"):
                    retry_result = await apply_followup_revision(
                        provider=provider,
                        article=revised_article,
                        review=review,
                        journal=selected_journal,
                        article_type=article_type,
                        journal_style=journal_style,
                        action_map=status.action_map,
                        aggressive=True,  # Use aggressive mode for retry
                    )
                if retry_result.revised_article.strip() and retry_result.revised_article != revised_article:
                    revised_article = retry_result.revised_article
                    revision_result.revised_article = revised_article
                    revision_result.applied_changes = (revision_result.applied_changes or 0) + (retry_result.applied_changes or 0)
                    revision_result.failed_changes = retry_result.failed_changes
                    status.revision = revision_result
                    if revised_article.strip():
                        await save_article(
                            project_id, revised_article, selected_journal,
                            citation_map=_serialize_citation_map(revised_article, list((project.get("summaries") or {}).values())),
                        )
                    await _save_revision_agent_status(project_id, status)
                    logger.info("Retry applied %d additional edits", retry_result.applied_changes or 0)

        while True:
            if status.stop_requested:
                status.status = "needs_user_review"
                status.stage = "stopped"
                status.completed_reason = "Stopped by user."
                await _save_revision_agent_status(project_id, status)
                return

            current_article = status.revision.revised_article if status.revision else ""
            if not current_article.strip():
                raise RuntimeError("Revision agent lost the revised manuscript state.")

            # Strip any leaked drafting annotations before QA checks see them
            from services.manuscript_citation_formatter import strip_evidence_purpose_tags
            current_article = strip_evidence_purpose_tags(current_article)
            if status.revision:
                status.revision.revised_article = current_article

            status.stage = "preservation_audit"
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="consistency_audit"):
                status.consistency_audit = await run_consistency_audit(
                    provider,
                    review,
                    status.action_map,
                    "",
                    current_article,
                )

            status.stage = "reviewer_recheck"
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="re_review"):
                status.re_review = await generate_re_review(
                    provider,
                    review,
                    "",
                    current_article,
                )

            status.stage = "editor_assessment"
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="editorial_review"):
                status.editorial_review = await generate_editorial_review(
                    provider=provider,
                    original_manuscript=baseline_article,
                    revised_manuscript=current_article,
                    reviewer_comments=_reviewer_comments_payload(review),
                    author_responses=_response_entries(status.revision),
                    journal_name=selected_journal,
                )

            current_entries, blocking_messages = _current_ledger_entries(status, status.current_round or 1)
            status.ledger_entries = _merge_ledger(
                status.ledger_entries,
                current_entries,
                resolution_justification=_latest_resolution_context(status.revision, previous_justification_count),
            )
            status.blocking_issue_count = len(blocking_messages)
            status.advisory_issue_count = len([item for item in current_entries if item.severity == "advisory"])

            normalized_msgs = sorted(set(_normalize_for_signature(m) for m in blocking_messages))
            blocking_signature = "||".join(normalized_msgs)
            if blocking_signature and blocking_signature == status.last_blocking_signature:
                status.repeated_blocking_rounds += 1
            else:
                status.repeated_blocking_rounds = 0
                status.last_blocking_signature = blocking_signature

            await _save_revision_agent_status(project_id, status)

            if not blocking_messages:
                status.last_known_good_article = current_article
                break

            # ── Decide whether to keep trying or fail autonomously ───────
            if status.repeated_blocking_rounds >= 3 or status.current_round >= _MAX_AMENDMENT_ROUNDS:
                reason = (
                    f"Autonomous revision stopped after {status.current_round} round"
                    f"{'s' if status.current_round != 1 else ''}; "
                    f"{len(blocking_messages)} blocking issue"
                    f"{'s remain' if len(blocking_messages) != 1 else ' remains'}: "
                    + "; ".join(blocking_messages)
                )
                status.status = "failed"
                status.stage = "failed"
                status.last_error = reason
                status.completed_reason = reason
                await _save_revision_agent_status(project_id, status)
                return

            # ── Use aggressive rewrite mode when surgical edits keep failing ──
            use_aggressive = status.repeated_blocking_rounds >= 1
            if use_aggressive:
                logger.info(
                    "Revision agent switching to aggressive rewrite mode for project %s (round %d, repeated %d)",
                    project_id, status.current_round, status.repeated_blocking_rounds,
                )

            status.stage = "followup_revision"
            await _save_revision_agent_status(project_id, status)
            previous_justification_count = len(status.revision.change_justifications) if status.revision else 0
            async with TokenContext(project_id=project_id, user_id=user_id, stage="followup_revision"):
                followup_result = await apply_followup_revision(
                    provider=provider,
                    article=current_article,
                    review=review,
                    journal=selected_journal,
                    article_type=article_type,
                    journal_style=journal_style,
                    action_map=status.action_map,
                    consistency_audit=status.consistency_audit.model_dump() if status.consistency_audit else None,
                    re_review=status.re_review.model_dump() if status.re_review else None,
                    editorial_review=status.editorial_review.model_dump() if status.editorial_review else None,
                    aggressive=use_aggressive,
                    user_guidance=status.user_guidance or "",
                    last_known_good_article=status.last_known_good_article or baseline_article,
                )
            next_article = followup_result.revised_article

            # ── Truncation detection after followup ──────────────────────
            if _detect_truncation(next_article):
                logger.warning("Followup revision produced truncated text for %s — attempting completion", project_id)
                status.stage = "completing_truncated"
                await _save_revision_agent_status(project_id, status)
                async with TokenContext(project_id=project_id, user_id=user_id, stage="complete_truncation"):
                    completed = await _complete_truncated_manuscript(
                        provider, next_article, baseline_article, article_type,
                        project.get("word_limit") or 4000,
                    )
                if completed and len(completed) > len(next_article):
                    next_article = completed

            # NOTE: Do NOT call normalize_numbered_citation_order() here —
            # it rebuilds the References section and can reintroduce formatting bugs
            # that the followup revision just fixed. Normalization runs ONCE after
            # the loop exits (before the final response letter).
            followup_result.revised_article = next_article
            if next_article.strip():
                await save_article(
                    project_id,
                    next_article,
                    selected_journal,
                    citation_map=_serialize_citation_map(next_article, list((project.get("summaries") or {}).values())),
                )
                status.last_known_good_article = next_article

            merged_justifications = [
                *(status.revision.change_justifications if status.revision else []),
                *(followup_result.change_justifications or []),
            ]
            _accumulate_qa_metrics(status, followup_result)
            status.revision = RevisionResult(
                revised_article=followup_result.revised_article,
                point_by_point_reply="",
                response_data=None,
                action_map=status.action_map,
                audit=followup_result.audit,
                applied_changes=followup_result.applied_changes,
                failed_changes=followup_result.failed_changes,
                change_justifications=merged_justifications,
                response_qc=None,
                repair_telemetry=followup_result.repair_telemetry,
            )
            status.current_round += 1
            status.consistency_audit = None
            status.re_review = None
            status.editorial_review = None
            await _save_revision_agent_status(project_id, status)

        if status.stop_requested:
            status.status = "needs_user_review"
            status.stage = "stopped"
            status.completed_reason = "Stopped by user."
            await _save_revision_agent_status(project_id, status)
            return

        # ── Final reference normalization (ONCE, after all revision rounds) ──
        if status.revision and status.revision.revised_article.strip() and journal_style:
            final_article = normalize_numbered_citation_order(
                status.revision.revised_article,
                journal_style,
                list((project.get("summaries") or {}).values()),
            )
            status.revision.revised_article = final_article
            await save_article(
                project_id,
                final_article,
                selected_journal,
                citation_map=_serialize_citation_map(final_article, list((project.get("summaries") or {}).values())),
            )

        if not status.revision or not status.revision.point_by_point_reply.strip():
            status.stage = "final_response"
            await _save_revision_agent_status(project_id, status)
            async with TokenContext(project_id=project_id, user_id=user_id, stage="finalize_revision_response"):
                point_by_point, response_data, response_qc = await generate_final_response_letter(
                    provider=provider,
                    review=review,
                    revised_article=status.revision.revised_article,
                    journal=selected_journal,
                    manuscript_title=manuscript_title,
                    action_map=status.action_map,
                    change_justifications=status.revision.change_justifications if status.revision else [],
                )
            status.revision = RevisionResult(
                revised_article=status.revision.revised_article,
                point_by_point_reply=point_by_point,
                response_data=response_data if response_data else None,
                action_map=status.action_map,
                audit=status.revision.audit if status.revision else None,
                applied_changes=status.revision.applied_changes if status.revision else None,
                failed_changes=status.revision.failed_changes if status.revision else None,
                change_justifications=status.revision.change_justifications if status.revision else [],
                response_qc=response_qc,
            )

        current_entries, blocking_messages = _current_ledger_entries(status, status.current_round or 1)
        status.ledger_entries = _merge_ledger(
            status.ledger_entries,
            current_entries,
            resolution_justification=_latest_resolution_context(status.revision, previous_justification_count),
        )
        status.blocking_issue_count = len(blocking_messages)
        status.advisory_issue_count = len([item for item in current_entries if item.severity == "advisory"])
        await _save_revision_agent_status(project_id, status)

        if blocking_messages:
            status.status = "needs_user_review"
            status.stage = "needs_user_review"
            status.completed_reason = "Final response QA reported blocking issues. Review the response before exporting."
            await _save_revision_agent_status(project_id, status)
            return

        status.stage = "export_generation"
        status.export_readiness = _compute_export_readiness(status.revision)
        status.final_response_ready = _final_response_ready(status.revision)
        await _save_revision_agent_status(project_id, status)

        if not status.export_readiness.all_required_ready:
            status.status = "needs_user_review"
            status.completed_reason = "Manuscript and response are complete, but one or more exports are not ready."
            await _save_revision_agent_status(project_id, status)
            return

        status.status = "completed"
        status.stage = "completed"
        status.completed_reason = "All blocking issues were resolved and exports are ready."
        status.stop_requested = False
        await _save_revision_agent_status(project_id, status)
    except Exception as exc:
        logger.exception("Revision agent failed for %s", project_id)
        status.status = "failed"
        status.stage = "failed"
        status.last_error = str(exc)
        status.completed_reason = "Revision agent failed before completion."
        status.stop_requested = False
        await _save_revision_agent_status(project_id, status)
