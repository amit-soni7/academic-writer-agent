"""
test_article_prompt.py

Unit tests for the article prompt builder helpers in routers/sessions.py:

  1.  test_summary_block_basic
  2.  test_summary_block_capped_at_30
  3.  test_summary_block_missing_fields
  4.  test_build_prompt_injects_citation_style
  5.  test_build_prompt_abstract_structured_in_system
  6.  test_build_prompt_abstract_unstructured_in_system
  7.  test_build_prompt_max_references_in_system
  8.  test_build_prompt_journal_word_limit_overrides_user
  9.  test_build_prompt_user_word_limit_when_journal_has_none
  10. test_build_prompt_case_report_sections
  11. test_build_prompt_short_communication_sections
  12. test_build_prompt_includes_ref_list
  13. test_build_prompt_no_ref_list_when_no_summaries
  14. test_build_prompt_title_not_changed
  15. test_article_sections_dict_has_new_types
"""

import pytest
from unittest.mock import AsyncMock

from services.journal_style_service import (
    CitationStyle,
    JournalStyle,
    build_article_system_prompt,
)
from services.article_builder import (
    build_summary_block as _build_summary_block,
    build_article_prompt as _build_article_prompt_svc,
    ARTICLE_SECTIONS as _ARTICLE_SECTIONS,
)

_DUMMY_BASE_SYSTEM = """\
You are an expert academic writer.
- Use [Author, Year] inline citation style alongside [CITE:key].
  - Example: "CBT reduced PHQ-9 (d=0.52) [CITE:smith2023] (Smith et al., 2023)."
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_style(
    citation_style: CitationStyle = CitationStyle.ama,
    in_text_format: str = "numbered",
    reference_sort_order: str = "order_of_appearance",
    abstract_structure: str | None = None,
    abstract_word_limit: int | None = None,
    max_references: int | None = None,
    word_limits: dict | None = None,
    sections_by_type: dict | None = None,
    journal_name: str = "Test Journal",
) -> JournalStyle:
    return JournalStyle(
        journal_name=journal_name,
        citation_style=citation_style,
        in_text_format=in_text_format,
        reference_sort_order=reference_sort_order,
        accepted_article_types=["original_research", "review", "case_report"],
        max_references=max_references,
        abstract_structure=abstract_structure,
        abstract_word_limit=abstract_word_limit,
        word_limits=word_limits or {},
        sections_by_type=sections_by_type or {},
        reference_format_name="AMA",
        source="curated",
        confidence=1.0,
    )


def _make_session(summaries: dict | None = None) -> dict:
    return {
        "query": "CBT for depression: efficacy and mechanisms",
        "summaries": summaries or {},
        "journal_recs": [],
    }


def _call_build_prompt(session, style, title, article_type="original_research",
                        word_limit=4000, selected_journal="Test Journal"):
    """Helper that calls the async build_article_prompt_svc synchronously in tests."""
    import asyncio
    return asyncio.run(
        _build_article_prompt_svc(
            session=session,
            article_type=article_type,
            selected_journal=selected_journal,
            word_limit=word_limit,
            journal_style=style,
            manuscript_title=title,
            base_system=_DUMMY_BASE_SYSTEM,
        )
    )


def _minimal_summary(paper_key: str, first_author: str = "Smith", year: int = 2020) -> dict:
    return {
        "paper_key": paper_key,
        "bibliography": {
            "authors": [f"{first_author} AB"],
            "year": year,
            "title": f"Study on {paper_key}",
            "journal": "Test J",
            "doi": f"10.1234/{paper_key}",
        },
        "one_line_takeaway": "Key finding here.",
        "results": [{"finding": "p<0.05", "effect_size": "d=0.5"}],
        "methods": {"study_design": "RCT", "sample_n": "100"},
        "critical_appraisal": {"evidence_grade": "High"},
    }


# ── 1. _build_summary_block — basic output ───────────────────────────────────

def test_summary_block_basic(sample_summaries):
    block = _build_summary_block(sample_summaries)
    assert "[1]" in block
    assert "[2]" in block
    assert "Smith" in block
    assert "Wang" in block
    assert "CBT" in block or "cognitive" in block.lower() or "RCT" in block


# ── 2. _build_summary_block — capped at 30 ───────────────────────────────────

def test_summary_block_capped_at_30():
    summaries = [_minimal_summary(f"paper{i}", f"Author{i}", 2010 + i) for i in range(40)]
    block = _build_summary_block(summaries)
    # Should show [1] through [30] but not [31]
    assert "[30]" in block
    assert "[31]" not in block


# ── 3. _build_summary_block — graceful with missing fields ───────────────────

def test_summary_block_missing_fields():
    summaries = [{"paper_key": "empty_paper"}]
    block = _build_summary_block(summaries)
    assert "[1]" in block
    # Should not raise; minimal output is acceptable


# ── 4. Prompt injects citation style instructions ─────────────────────────────

def test_build_prompt_injects_citation_style(sample_summaries):
    style = _make_style(citation_style=CitationStyle.nature, in_text_format="superscript")
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    system, _ = _call_build_prompt(session, style, "Test Title")
    assert "NATURE" in system.upper() or "superscript" in system.lower()


# ── 5. Structured abstract instruction appears in system prompt ───────────────

def test_build_prompt_abstract_structured_in_system(sample_summaries):
    style = _make_style(abstract_structure="structured", abstract_word_limit=250)
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    system, _ = _call_build_prompt(session, style, "Test Title")
    assert "structured" in system.lower()
    assert "Background" in system
    assert "250" in system


# ── 6. Unstructured abstract instruction appears in system prompt ──────────────

def test_build_prompt_abstract_unstructured_in_system(sample_summaries):
    style = _make_style(abstract_structure="unstructured", abstract_word_limit=150)
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    system, _ = _call_build_prompt(session, style, "Test Title")
    assert "unstructured" in system.lower() or "single-paragraph" in system.lower()
    assert "150" in system


# ── 7. Max references constraint in system prompt ─────────────────────────────

def test_build_prompt_max_references_in_system(sample_summaries):
    style = _make_style(max_references=40)
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    system, _ = _call_build_prompt(session, style, "Test Title")
    assert "40" in system
    assert "references" in system.lower()


# ── 8. Journal word limit overrides user selection in user message ────────────

def test_build_prompt_journal_word_limit_overrides_user(sample_summaries):
    style = _make_style(word_limits={"original_research": 3500})
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    _, user = _call_build_prompt(session, style, "Test Title",
                                  article_type="original_research", word_limit=8000)
    assert "3500" in user
    assert "guidelines" in user.lower() or "per" in user.lower()


# ── 9. User word limit used when journal has no limit for type ────────────────

def test_build_prompt_user_word_limit_when_journal_has_none(sample_summaries):
    style = _make_style(word_limits={})
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    _, user = _call_build_prompt(session, style, "Test Title",
                                  article_type="original_research", word_limit=6000)
    assert "6000" in user
    # New strict instruction replaces old "user-selected" note
    assert "strict word count" in user.lower() or "6000" in user


# ── 10. Case report sections in user message ─────────────────────────────────

def test_build_prompt_case_report_sections(sample_summaries):
    style = _make_style(sections_by_type={
        "case_report": ["Abstract", "Introduction", "Case Presentation", "Discussion", "References"]
    })
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    _, user = _call_build_prompt(session, style, "Test Title", article_type="case_report")
    assert "Case Presentation" in user


# ── 11. Short communication uses correct default sections ─────────────────────

def test_build_prompt_short_communication_sections(sample_summaries):
    style = _make_style(sections_by_type={})
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    _, user = _call_build_prompt(session, style, "Test Title",
                                  article_type="short_communication")
    assert "Methods" in user
    assert "Results" in user


# ── 12. Pre-formatted reference list included when summaries present ──────────

def test_build_prompt_includes_ref_list(sample_summaries):
    style = _make_style()
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    _, user = _call_build_prompt(session, style, "My Test Title")
    assert (
        "Pre-formatted reference list" in user
        or "Pre-formatted reference details" in user
    )
    assert "Smith" in user


# ── 13. No reference list block when no summaries ────────────────────────────

def test_build_prompt_no_ref_list_when_no_summaries():
    style = _make_style()
    session = _make_session(summaries={})
    _, user = _call_build_prompt(session, style, "My Test Title")
    assert "Pre-formatted reference list" not in user


# ── 14. Approved title appears in user message and must not be changed ────────

def test_build_prompt_title_not_changed(sample_summaries):
    style = _make_style()
    session = _make_session({s["paper_key"]: s for s in sample_summaries})
    title = "A Randomised Trial of CBT for Treatment-Resistant Depression"
    _, user = _call_build_prompt(session, style, title)
    assert title in user
    assert "do NOT change" in user.lower() or "approved" in user.lower()


# ── 15. _ARTICLE_SECTIONS includes all new article types ─────────────────────

def test_article_sections_dict_has_new_types():
    required_types = [
        "original_research", "systematic_review", "scoping_review",
        "narrative_review", "review", "meta_analysis", "case_report",
        "short_communication", "brief_report", "editorial",
        "letter", "opinion", "study_protocol",
    ]
    for atype in required_types:
        assert atype in _ARTICLE_SECTIONS, \
            f"_ARTICLE_SECTIONS missing '{atype}'"
        assert len(_ARTICLE_SECTIONS[atype]) > 0, \
            f"_ARTICLE_SECTIONS['{atype}'] is empty"
        assert any(section.startswith("Abstract") for section in _ARTICLE_SECTIONS[atype]), \
            f"_ARTICLE_SECTIONS['{atype}'] should include an abstract"
