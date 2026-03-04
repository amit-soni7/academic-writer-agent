import pytest

from services.real_revision_writer import suggest_comment_changes


@pytest.mark.asyncio
async def test_suggest_comment_changes_fallback_without_provider():
    parsed_comments = [
        {
            "reviewer_number": 1,
            "comment_number": 1,
            "original_comment": "Please clarify why this dataset was selected.",
            "ambiguity_flag": False,
            "ambiguity_question": "",
            "intent_interpretation": "Reviewer asks for rationale of dataset choice.",
        }
    ]

    out = await suggest_comment_changes(
        provider=None,
        manuscript_text="Sample manuscript text",
        parsed_comments=parsed_comments,
        journal_name="Test Journal",
    )

    assert len(out) == 1
    item = out[0]
    assert item["action_type"] == "clarify"
    assert "response_snippet" in item
    assert "copy_paste_text" in item
