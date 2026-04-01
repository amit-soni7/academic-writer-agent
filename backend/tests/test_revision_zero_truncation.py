import json

import pytest

from models import (
    ConsistencyAuditResult,
    EditorialReviewResult,
    PeerReviewReport,
    ReReviewResult,
    ReviewConcern,
    RevisionAction,
    RevisionActionMap,
    RevisionResult,
)
from services import revision_agent as revision_agent_module
from services.consistency_audit import run_consistency_audit
from services.manuscript_utils import validate_change_operations
from services.re_reviewer import generate_re_review
from services.revision_writer import _validate_revised_manuscript, generate_final_response_letter


def _build_long_manuscript(*, late_passage: str = "") -> str:
    intro_paragraphs = "\n\n".join(
        f"Introduction paragraph {i}. This paragraph provides context and remains complete."
        for i in range(80)
    )
    discussion_parts = []
    for i in range(120):
        discussion_parts.append(
            f"Discussion paragraph {i}. This paragraph explains the synthesis in full sentences and closes cleanly."
        )
        if late_passage and i == 105:
            discussion_parts.append(late_passage)
    discussion = "\n\n".join(discussion_parts)
    return (
        "# Sample Manuscript\n\n"
        "## Introduction\n\n"
        f"{intro_paragraphs}\n\n"
        "## Discussion\n\n"
        f"{discussion}\n\n"
        "## Conclusions\n\n"
        "The conclusions section ends with a complete sentence.\n\n"
        "## References\n\n"
        "1. Example reference.\n"
    )


def _build_review(*, quoted_passage: str = "") -> PeerReviewReport:
    return PeerReviewReport(
        decision="major_revision",
        major_concerns=[
            ReviewConcern(
                concern="Clarify the discussion section.",
                revision_request="Clarify the discussion section.",
                location="Discussion",
                quoted_passage=quoted_passage,
                satisfaction_criterion="The discussion is coherent and complete.",
            )
        ],
        minor_concerns=[],
        required_revisions=[],
    )


class _ChunkedPayloadProvider:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls: list[dict] = []

    async def complete_cached(self, **kwargs):
        self.calls.append(kwargs)
        return json.dumps(self.payload)


class _CaptureProvider:
    def __init__(self, payload: dict):
        self.payload = payload
        self.calls: list[dict] = []

    async def complete(self, **kwargs):
        self.calls.append(kwargs)
        return json.dumps(self.payload)


@pytest.mark.asyncio
async def test_chunked_audit_and_rereview_drop_false_truncation_findings():
    manuscript = _build_long_manuscript()
    review = _build_review()

    audit_provider = _ChunkedPayloadProvider(
        {
            "checks": [
                {
                    "check": "Structural completeness",
                    "passed": False,
                    "detail": "The revised manuscript is structurally incomplete in the supplied text, ending mid-sentence in the Discussion.",
                    "passage": "",
                    "recommended_edits": [],
                }
            ],
            "all_passed": False,
            "blocking_issues": [
                "The revised manuscript is structurally incomplete in the supplied text, ending mid-sentence in the Discussion."
            ],
            "summary": "False truncation warning from a chunk.",
        }
    )
    audit_result = await run_consistency_audit(
        audit_provider,
        review,
        RevisionActionMap(actions=[], total_actions=0),
        "",
        manuscript,
    )

    assert len(audit_provider.calls) > 1
    assert audit_result.checks == []
    assert audit_result.blocking_issues == []
    assert audit_result.repair_tasks == []
    assert audit_result.all_passed is True

    rereview_provider = _ChunkedPayloadProvider(
        {
            "concern_resolutions": [
                {
                    "concern_id": "major_1",
                    "original_concern": "Clarify the discussion section.",
                    "status": "unresolved",
                    "explanation": "The truncation creates an integrity problem that prevents confirming preservation of the manuscript's full structure and final argument.",
                    "response_accurate": True,
                    "overstatements": [],
                }
            ],
            "updated_recommendation": "major_revision",
            "remaining_issues": [
                "The truncation creates an integrity problem that prevents confirming preservation of the manuscript's full structure and final argument."
            ],
            "needs_another_round": True,
            "blocking_issues": [
                "The revised manuscript is structurally incomplete in the supplied text, ending mid-sentence in the Discussion."
            ],
            "summary": "False truncation warning from a chunk.",
        }
    )
    rereview_result = await generate_re_review(
        rereview_provider,
        review,
        "",
        manuscript,
    )

    assert len(rereview_provider.calls) > 1
    assert rereview_result.concern_resolutions == []
    assert rereview_result.blocking_issues == []
    assert rereview_result.remaining_issues == []
    assert rereview_result.repair_tasks == []
    assert rereview_result.updated_recommendation == "accept"
    assert rereview_result.needs_another_round is False


def test_validate_change_operations_rejects_partial_prefix_match():
    manuscript = "The finding was grounded in the available evidence and remained coherent."
    safe_ops, unsafe_ops = validate_change_operations(
        manuscript,
        [
            {
                "type": "replace",
                "find": "in the ava",
                "replace_with": "in the complete evidence base",
            }
        ],
    )

    assert safe_ops == []
    assert len(unsafe_ops) == 1
    assert unsafe_ops[0]["reason"] == "target is an unsafe partial-span match"


def test_validate_revised_manuscript_flags_placeholder_and_workflow_residue():
    original = _build_long_manuscript()
    revised = original.replace(
        "The conclusions section ends with a complete sentence.",
        "Complete the citation formatting later. [FUT] The conclusions section ends with a complete sentence.",
    )

    warnings = _validate_revised_manuscript(original, revised)

    assert any("placeholder" in warning.lower() for warning in warnings)
    assert any("[FUT]" in warning for warning in warnings)


@pytest.mark.asyncio
async def test_final_response_generation_uses_late_relevant_passage_without_prefix_truncation():
    late_passage = "Late anchor passage: the discussion remains coherent after the revision and appears near the manuscript end."
    manuscript = _build_long_manuscript(late_passage=late_passage)
    review = _build_review(quoted_passage=late_passage)
    action_map = RevisionActionMap(
        actions=[
            RevisionAction(
                reviewer_comment_id="major_1",
                concern_title="Clarify the discussion section.",
                quoted_passage=late_passage,
                revision_instruction="Clarify the late discussion paragraph.",
            )
        ],
        total_actions=1,
        accepted_count=1,
    )
    provider = _CaptureProvider({"responses": []})

    await generate_final_response_letter(
        provider=provider,
        review=review,
        revised_article=manuscript,
        journal="Test Journal",
        manuscript_title="Sample",
        action_map=action_map,
        change_justifications=["Clarified the late discussion paragraph."],
    )

    assert provider.calls
    prompt = provider.calls[0]["user"]
    assert late_passage in prompt
    assert "REVISED MANUSCRIPT EXCERPTS RELEVANT TO REVIEWER CONCERNS" in prompt


@pytest.mark.asyncio
async def test_revision_agent_fails_without_entering_needs_clarification(monkeypatch):
    manuscript = _build_long_manuscript()
    review = _build_review()
    stored_state: dict = {}

    async def _fake_get_revision_agent_state(_project_id: str):
        return stored_state.get("state")

    async def _fake_save_revision_agent_state(_project_id: str, state: dict):
        stored_state["state"] = state

    async def _fake_load_project(_user_id: str, _project_id: str):
        return {
            "article": manuscript,
            "article_type": "review",
            "selected_journal": "Test Journal",
            "manuscript_title": "Sample",
            "query": "",
            "summaries": {},
        }

    async def _fake_get_peer_review_result(_project_id: str):
        return review.model_dump()

    async def _fake_generate_revision_action_map(_provider, article, _review):
        assert article == manuscript
        return RevisionActionMap(actions=[], total_actions=0)

    async def _fake_generate_revision_package(**kwargs):
        assert kwargs["article"] == manuscript
        return RevisionResult(
            revised_article=kwargs["article"],
            point_by_point_reply="",
            response_data=None,
            action_map=kwargs["action_map"],
            audit={},
            applied_changes=0,
            failed_changes=0,
            change_justifications=[],
        )

    async def _fake_run_consistency_audit(*_args, **_kwargs):
        return ConsistencyAuditResult(
            all_passed=False,
            blocking_issues=[
                "The Discussion requires reconstruction for coherence before the revision can be evaluated as complete."
            ],
            advisory_issues=[],
            repair_tasks=[],
            summary="Blocking structural issue remains.",
        )

    async def _fake_generate_re_review(*_args, **_kwargs):
        return ReReviewResult(
            concern_resolutions=[],
            new_issues=[],
            updated_recommendation="accept",
            remaining_issues=[],
            needs_another_round=False,
            blocking_issues=[],
            advisory_issues=[],
            repair_tasks=[],
            summary="",
        )

    async def _fake_generate_editorial_review(**kwargs):
        assert kwargs["original_manuscript"] == manuscript
        return EditorialReviewResult(
            editor_decision="accept",
            overall_assessment="",
            suggestions=[],
            praise=[],
            remaining_concerns=[],
            blocking_issues=[],
            advisory_issues=[],
            repair_tasks=[],
        )

    async def _fake_apply_followup_revision(**kwargs):
        assert kwargs["last_known_good_article"] == manuscript
        return RevisionResult(
            revised_article=kwargs["article"],
            point_by_point_reply="",
            response_data=None,
            action_map=kwargs["action_map"],
            audit={},
            applied_changes=0,
            failed_changes=0,
            change_justifications=[],
        )

    async def _fake_save_article(*_args, **_kwargs):
        return None

    class _DummyTokenContext:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(revision_agent_module, "get_revision_agent_state", _fake_get_revision_agent_state)
    monkeypatch.setattr(revision_agent_module, "save_revision_agent_state", _fake_save_revision_agent_state)
    monkeypatch.setattr(revision_agent_module, "load_project", _fake_load_project)
    monkeypatch.setattr(revision_agent_module, "get_peer_review_result", _fake_get_peer_review_result)
    monkeypatch.setattr(revision_agent_module, "generate_revision_action_map", _fake_generate_revision_action_map)
    monkeypatch.setattr(revision_agent_module, "generate_revision_package", _fake_generate_revision_package)
    monkeypatch.setattr(revision_agent_module, "run_consistency_audit", _fake_run_consistency_audit)
    monkeypatch.setattr(revision_agent_module, "generate_re_review", _fake_generate_re_review)
    monkeypatch.setattr(revision_agent_module, "generate_editorial_review", _fake_generate_editorial_review)
    monkeypatch.setattr(revision_agent_module, "apply_followup_revision", _fake_apply_followup_revision)
    monkeypatch.setattr(revision_agent_module, "save_article", _fake_save_article)
    monkeypatch.setattr(revision_agent_module, "TokenContext", lambda **_kwargs: _DummyTokenContext())

    async def _unexpected_final_response(**_kwargs):
        raise AssertionError("Final response generation should not run when blockers remain.")

    monkeypatch.setattr(revision_agent_module, "generate_final_response_letter", _unexpected_final_response)

    await revision_agent_module._run_revision_agent(
        project_id="project-1",
        user_id="user-1",
        provider=object(),
        journal_style=None,
    )

    final_status = await revision_agent_module.get_revision_agent_status("project-1")
    assert final_status.status == "failed"
    assert final_status.stage == "failed"
    assert final_status.baseline_article == manuscript
    assert final_status.last_known_good_article == manuscript
    assert not hasattr(final_status, "clarification_items")
    assert not hasattr(final_status, "clarification_request")
    assert final_status.qa_metrics.invalid_qa_findings == 0
    assert final_status.qa_metrics.discarded_blockers == 0
    assert "needs_clarification" not in final_status.completed_reason
