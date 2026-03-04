import pytest

from services import reviewer_comment_parser as rcp


def test_fallback_parse_includes_structured_fields():
    raw = """
Reviewer 1:
1. Please justify sample size and statistical power.
2. Clarify inclusion criteria.
"""
    out = rcp._fallback_parse(raw)
    assert len(out) >= 1
    first = out[0]
    assert "severity" in first
    assert "domain" in first
    assert "requirement_level" in first
    assert "ambiguity_flag" in first
    assert "ambiguity_question" in first
    assert "intent_interpretation" in first


def test_normalize_comment_maps_invalid_values_to_defaults():
    item = {
        "reviewer_number": 2,
        "comment_number": 3,
        "original_comment": "Please provide raw data access statement.",
        "severity": "urgent",  # invalid
        "domain": "compliance",  # invalid
        "requirement_level": "must",  # invalid
    }
    norm = rcp._normalize_comment(item, 1)
    assert norm["severity"] == "major"
    assert norm["category"] == "major"
    assert norm["domain"] == "other"
    assert norm["requirement_level"] == "unclear"


@pytest.mark.asyncio
async def test_parse_reviewer_comments_without_provider_uses_fallback():
    raw = "1. Please cite recent work in this area."
    out = await rcp.parse_reviewer_comments(None, raw)
    assert len(out) == 1
    assert "Please cite" in out[0]["original_comment"]
    assert "intent_interpretation" in out[0]
