"""
test_journal_style_service.py

Unit tests for JournalStyleService and JournalStyle:

  Curated lookups
  1.  test_exact_lookup_nature
  2.  test_exact_lookup_jama
  3.  test_case_insensitive_lookup
  4.  test_fuzzy_lookup_partial_name
  5.  test_alias_lookup_nejm
  6.  test_curated_case_report_types
  7.  test_curated_brief_report_sections

  Publisher-based fallbacks
  8.  test_publisher_inference_elsevier
  9.  test_publisher_inference_nature_portfolio
  10. test_publisher_inference_aha
  11. test_publisher_inference_frontiers

  Default fallback
  12. test_default_fallback_unknown

  Reference formatting
  13. test_format_ref_vancouver
  14. test_format_ref_apa
  15. test_format_ref_nature
  16. test_format_ref_cell_alphabetical_order

  Citation instructions
  17. test_to_citation_instructions_numbered
  18. test_to_citation_instructions_author_year
  19. test_to_citation_instructions_superscript_nature

  Section helpers
  20. test_get_sections_known_journal_nature
  21. test_get_sections_falls_back_to_defaults
  22. test_get_sections_case_report_default
  23. test_get_sections_short_communication_default

  Abstract instructions
  24. test_abstract_instructions_structured
  25. test_abstract_instructions_unstructured
  26. test_abstract_instructions_editorial_present
  27. test_abstract_instructions_letter_present
  28. test_abstract_instructions_structured_with_limit

  Word limit resolution
  29. test_effective_word_limit_journal_overrides
  30. test_effective_word_limit_user_fallback
  31. test_effective_word_limit_null_journal

  Max references
  32. test_max_references_instruction_present
  33. test_max_references_instruction_absent

  LLM inference
  34. test_llm_infer_full_metadata
  35. test_llm_infer_invalid_citation_style_falls_back
  36. test_llm_infer_filters_invalid_article_types

  Serialisation
  37. test_to_dict_from_dict_roundtrip
"""

import json
import re
import pytest

from services.journal_style_service import (
    CitationStyle,
    JournalStyle,
    JournalStyleService,
    _DEFAULT_SECTIONS_BY_TYPE,
    _FALLBACK_STYLE,
    _format_one_ref,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def svc():
    return JournalStyleService(engine=None)


def _make_style(**overrides) -> JournalStyle:
    """Build a minimal JournalStyle for unit tests."""
    defaults = dict(
        journal_name="Test Journal",
        citation_style=CitationStyle.ama,
        in_text_format="numbered",
        reference_sort_order="order_of_appearance",
        accepted_article_types=["original_research", "review"],
        max_references=None,
        abstract_structure=None,
        abstract_word_limit=None,
        word_limits={},
        sections_by_type={},
        reference_format_name="AMA",
        source="curated",
        confidence=1.0,
    )
    defaults.update(overrides)
    return JournalStyle(**defaults)


# ── 1. Exact lookup — Nature ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_exact_lookup_nature(svc):
    style = await svc.get_style("Nature")
    assert style.citation_style == CitationStyle.nature
    assert "original_research" in style.accepted_article_types
    assert "review" in style.accepted_article_types
    assert style.confidence == 1.0
    assert style.source == "curated"
    assert style.in_text_format == "superscript"


# ── 2. Exact lookup — JAMA ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_exact_lookup_jama(svc):
    style = await svc.get_style("JAMA")
    assert style.citation_style == CitationStyle.ama
    assert style.confidence == 1.0
    assert style.source == "curated"
    assert style.abstract_structure == "structured"


# ── 3. Case-insensitive lookup ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_case_insensitive_lookup(svc):
    style_lower = await svc.get_style("plos one")
    style_upper = await svc.get_style("PLOS ONE")
    assert style_lower.citation_style == CitationStyle.apa
    assert style_upper.citation_style == CitationStyle.apa


# ── 4. Fuzzy partial-name lookup ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fuzzy_lookup_partial_name(svc):
    style = await svc.get_style("New England Journal")
    assert style.citation_style == CitationStyle.nlm
    assert style.source == "curated"


# ── 5. Alias lookup — NEJM ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_alias_lookup_nejm(svc):
    for alias in ("N Engl J Med", "NEJM"):
        style = await svc.get_style(alias)
        assert style.citation_style == CitationStyle.nlm, f"Failed for alias {alias}"
        assert "case_report" in style.accepted_article_types


# ── 6. Curated journals include case_report ───────────────────────────────────

@pytest.mark.asyncio
async def test_curated_case_report_types(svc):
    """Several curated journals should now have case_report in accepted types."""
    for journal in ("JAMA", "BMJ", "The Lancet", "JACC"):
        style = await svc.get_style(journal)
        assert "case_report" in style.accepted_article_types or \
               "short_communication" in style.accepted_article_types, \
               f"{journal} should have case_report or short_communication"


# ── 7. Curated journals have brief_report sections ────────────────────────────

@pytest.mark.asyncio
async def test_curated_brief_report_sections(svc):
    """Journals with brief_report should have sections for it."""
    style = await svc.get_style("JAMA Psychiatry")
    assert "brief_report" in style.accepted_article_types
    secs = style.get_sections("brief_report")
    assert len(secs) > 0
    assert "Abstract" in secs


# ── 8. Publisher inference — Elsevier ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_publisher_inference_elsevier(svc):
    style = await svc.get_style(
        "Some Unknown Elsevier Journal XYZ",
        publisher="Elsevier",
    )
    assert style.citation_style == CitationStyle.vancouver
    assert style.source == "publisher_default"
    assert style.confidence == 0.8


# ── 9. Publisher inference — Nature Portfolio ─────────────────────────────────

@pytest.mark.asyncio
async def test_publisher_inference_nature_portfolio(svc):
    style = await svc.get_style(
        "Nature Unprecedented New Journal 2025",
        publisher="Nature Portfolio",
    )
    assert style.citation_style == CitationStyle.nature
    assert style.source == "publisher_default"


# ── 10. Publisher inference — American Heart Association ──────────────────────

@pytest.mark.asyncio
async def test_publisher_inference_aha(svc):
    style = await svc.get_style(
        "Arteriosclerosis Thrombosis and Vascular Biology",
        publisher="American Heart Association",
    )
    assert style.citation_style == CitationStyle.ama
    assert style.source == "publisher_default"


# ── 11. Publisher inference — Frontiers Media ────────────────────────────────

@pytest.mark.asyncio
async def test_publisher_inference_frontiers(svc):
    # Use a Frontiers journal not in the curated table; fuzzy-matching curated
    # Frontiers journals is also acceptable (same publisher, same style).
    style = await svc.get_style(
        "Frontiers in Oncology",
        publisher="Frontiers Media",
    )
    assert style.citation_style == CitationStyle.apa
    assert style.source in ("publisher_default", "curated")


# ── 12. Default fallback ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_default_fallback_unknown(svc):
    style = await svc.get_style("Completely Unknown Journal XYZ Fake 99999")
    assert style.source == "default_fallback"
    assert style.citation_style == CitationStyle.default
    assert style.confidence == 0.5


# ── 13. Vancouver reference format ────────────────────────────────────────────

def test_format_ref_vancouver(sample_summaries):
    style = _make_style(citation_style=CitationStyle.vancouver,
                        in_text_format="numbered",
                        reference_sort_order="order_of_appearance",
                        reference_format_name="Vancouver")
    ref_list = style.format_reference_list(sample_summaries)
    lines = [l for l in ref_list.splitlines() if l.strip()]
    assert len(lines) == 2
    # CSL elsevier-vancouver uses [1] numbering; hand-coded fallback uses "1."
    assert re.match(r"^[\[1\]1]", lines[0])
    assert "Smith" in lines[0]
    assert "2020" in lines[0]
    assert "Wang" in lines[1]


# ── 14. APA reference format (alphabetical) ───────────────────────────────────

def test_format_ref_apa(sample_summaries):
    style = _make_style(citation_style=CitationStyle.apa,
                        in_text_format="author_year",
                        reference_sort_order="alphabetical",
                        reference_format_name="APA")
    ref_list = style.format_reference_list(sample_summaries)
    lines = [l for l in ref_list.splitlines() if l.strip()]
    assert len(lines) == 2
    # APA alphabetical → Smith before Wang
    assert "Smith" in lines[0]
    assert "Wang" in lines[1]
    assert "2020" in lines[0] or "(2020)" in lines[0]


# ── 15. Nature reference format ───────────────────────────────────────────────

def test_format_ref_nature(sample_summaries):
    style = _make_style(citation_style=CitationStyle.nature,
                        in_text_format="superscript",
                        reference_sort_order="order_of_appearance",
                        reference_format_name="Nature")
    ref_list = style.format_reference_list(sample_summaries)
    lines = [l for l in ref_list.splitlines() if l.strip()]
    assert len(lines) == 2
    # Nature format uses '&' between authors
    assert "&" in lines[0]
    # Year in parentheses at end: (2020)
    assert "(2020)" in lines[0]


# ── 16. Cell alphabetical order ───────────────────────────────────────────────

def test_format_ref_cell_alphabetical_order(sample_summaries):
    style = _make_style(citation_style=CitationStyle.cell,
                        in_text_format="author_year",
                        reference_sort_order="alphabetical",
                        reference_format_name="Cell")
    ref_list = style.format_reference_list(sample_summaries)
    lines = [l for l in ref_list.splitlines() if l.strip()]
    # Alphabetical: Smith before Wang
    assert "Smith" in lines[0]
    assert "Wang" in lines[1]


# ── 17. Citation instructions — numbered ─────────────────────────────────────

def test_to_citation_instructions_numbered():
    style = _make_style(citation_style=CitationStyle.vancouver,
                        in_text_format="numbered")
    instructions = style.to_citation_instructions()
    assert "[1]" in instructions
    # Must not instruct author-year
    assert "Do NOT use Author-Year" in instructions


# ── 18. Citation instructions — author-year ───────────────────────────────────

def test_to_citation_instructions_author_year():
    style = _make_style(citation_style=CitationStyle.apa,
                        in_text_format="author_year")
    instructions = style.to_citation_instructions()
    assert "author-year" in instructions.lower()
    assert "Do NOT use numbered" in instructions


# ── 19. Citation instructions — Nature superscript ───────────────────────────

def test_to_citation_instructions_superscript_nature():
    style = _make_style(citation_style=CitationStyle.nature,
                        in_text_format="superscript")
    instructions = style.to_citation_instructions()
    assert "superscript" in instructions.lower()
    assert "^1" in instructions


# ── 20. get_sections — Nature original_research ───────────────────────────────

@pytest.mark.asyncio
async def test_get_sections_known_journal_nature(svc):
    style = await svc.get_style("Nature")
    sections = style.get_sections("original_research")
    assert len(sections) > 0
    section_names = [s.lower() for s in sections]
    assert any("abstract" in s for s in section_names)
    assert any("introduction" in s for s in section_names)
    assert any("methods" in s for s in section_names)
    # Nature puts Results before Discussion before Methods
    idx_r = next((i for i, s in enumerate(section_names) if "results" in s), None)
    idx_d = next((i for i, s in enumerate(section_names) if "discussion" in s), None)
    idx_m = next((i for i, s in enumerate(section_names) if "methods" in s), None)
    if idx_r is not None and idx_d is not None:
        assert idx_r < idx_d
    if idx_d is not None and idx_m is not None:
        assert idx_d < idx_m


# ── 21. get_sections — unknown journal falls back to defaults ─────────────────

def test_get_sections_falls_back_to_defaults():
    style = _make_style(sections_by_type={})
    for atype in ("original_research", "review", "meta_analysis"):
        secs = style.get_sections(atype)
        assert secs, f"Expected non-empty default sections for {atype}"
        assert "Abstract" in secs
        assert "References" in secs


# ── 22. get_sections — case_report defaults ───────────────────────────────────

def test_get_sections_case_report_default():
    style = _make_style(sections_by_type={})
    secs = style.get_sections("case_report")
    assert "Abstract" in secs
    # Must have a Case Presentation section
    assert any("case" in s.lower() for s in secs), \
        f"Case report sections should include 'Case Presentation', got {secs}"
    assert "References" in secs


# ── 23. get_sections — short_communication defaults ──────────────────────────

def test_get_sections_short_communication_default():
    style = _make_style(sections_by_type={})
    secs = style.get_sections("short_communication")
    assert "Abstract" in secs
    assert "Methods" in secs
    assert "Results" in secs
    assert "References" in secs


# ── 24. Abstract instructions — structured ────────────────────────────────────

def test_abstract_instructions_structured():
    style = _make_style(abstract_structure="structured", abstract_word_limit=250)
    hint = style.get_abstract_instructions("original_research")
    assert "structured" in hint.lower()
    assert "Background" in hint
    assert "250" in hint


# ── 25. Abstract instructions — unstructured ─────────────────────────────────

def test_abstract_instructions_unstructured():
    style = _make_style(abstract_structure="unstructured", abstract_word_limit=150)
    hint = style.get_abstract_instructions("original_research")
    assert "unstructured" in hint.lower() or "single-paragraph" in hint.lower()
    assert "150" in hint


# ── 26. Abstract instructions — editorial includes abstract guidance ─────────

def test_abstract_instructions_editorial_present():
    style = _make_style(abstract_structure="structured")
    hint = style.get_abstract_instructions("editorial")
    assert "abstract" in hint.lower()
    assert "background" in hint.lower()


# ── 27. Abstract instructions — letter includes abstract guidance ────────────

def test_abstract_instructions_letter_present():
    style = _make_style(abstract_structure="unstructured")
    hint = style.get_abstract_instructions("letter")
    assert "abstract" in hint.lower()
    assert "unstructured" in hint.lower() or "single-paragraph" in hint.lower()


# ── 28. Abstract instructions — structured with word limit ───────────────────

def test_abstract_instructions_structured_with_limit():
    style = _make_style(abstract_structure="structured", abstract_word_limit=200)
    hint = style.get_abstract_instructions("review")
    assert "200" in hint
    assert any(h in hint for h in ("Background", "Purpose", "Methods", "Findings"))


# ── 28b. get_sections — journal-specific sections still get abstract ─────────

def test_get_sections_prepends_abstract_when_missing_from_specific_sections():
    style = _make_style(sections_by_type={"editorial": ["Introduction", "Discussion", "References"]})
    secs = style.get_sections("editorial")
    assert secs[0] == "Abstract"
    assert "References" in secs


# ── 29. get_effective_word_limit — journal overrides user ────────────────────

def test_effective_word_limit_journal_overrides():
    style = _make_style(word_limits={"original_research": 3000, "review": 5000})
    limit, note = style.get_effective_word_limit("original_research", user_limit=8000)
    assert limit == 3000
    assert "journal" in note.lower() or "guidelines" in note.lower()


# ── 30. get_effective_word_limit — user fallback when journal has no limit ────

def test_effective_word_limit_user_fallback():
    style = _make_style(word_limits={})
    limit, note = style.get_effective_word_limit("original_research", user_limit=4000)
    assert limit == 4000
    assert "user" in note.lower()


# ── 31. get_effective_word_limit — null journal limit uses user limit ─────────

def test_effective_word_limit_null_journal():
    style = _make_style(word_limits={"original_research": None})
    limit, note = style.get_effective_word_limit("original_research", user_limit=6000)
    assert limit == 6000
    assert "user" in note.lower()


# ── 32. Max references instruction — present ──────────────────────────────────

def test_max_references_instruction_present():
    style = _make_style(max_references=40)
    instruction = style.get_max_references_instruction()
    assert "40" in instruction
    assert "references" in instruction.lower()


# ── 33. Max references instruction — absent ───────────────────────────────────

def test_max_references_instruction_absent():
    style = _make_style(max_references=None)
    instruction = style.get_max_references_instruction()
    assert instruction == ""


# ── 34. LLM inference — full metadata ────────────────────────────────────────

@pytest.mark.asyncio
async def test_llm_infer_full_metadata(mock_provider_full):
    svc = JournalStyleService(engine=None)
    style = await svc._llm_infer("Test Novel Journal", mock_provider_full)
    assert style is not None
    assert style.citation_style == CitationStyle.ama
    assert style.abstract_structure == "structured"
    assert style.abstract_word_limit == 250
    assert style.max_references == 40
    assert "original_research" in style.accepted_article_types
    assert "case_report" in style.accepted_article_types
    # Check sections were parsed
    secs = style.sections_by_type.get("original_research", [])
    assert "Abstract" in secs
    # Check word limits were parsed
    assert style.word_limits.get("original_research") == 4000
    assert style.source == "llm"
    assert style.confidence == 0.6


# ── 35. LLM inference — invalid citation style falls back to default ──────────

@pytest.mark.asyncio
async def test_llm_infer_invalid_citation_style_falls_back():
    from tests.conftest import _MockProvider
    provider = _MockProvider({
        "citation_style": "INVALID_STYLE_XYZ",
        "in_text_format": "numbered",
        "reference_sort_order": "order_of_appearance",
        "accepted_article_types": ["original_research"],
        "reference_format_name": "Custom",
        "max_references": None,
        "abstract_structure": None,
        "abstract_word_limit": None,
        "word_limits": {},
        "sections_by_type": {},
    })
    svc = JournalStyleService(engine=None)
    style = await svc._llm_infer("Some Journal", provider)
    assert style is not None
    assert style.citation_style == CitationStyle.default


# ── 36. LLM inference — invalid article types are filtered ───────────────────

@pytest.mark.asyncio
async def test_llm_infer_filters_invalid_article_types():
    from tests.conftest import _MockProvider
    provider = _MockProvider({
        "citation_style": "apa",
        "in_text_format": "author_year",
        "reference_sort_order": "alphabetical",
        "accepted_article_types": ["original_research", "INVALID_TYPE", "review"],
        "reference_format_name": "APA",
        "max_references": None,
        "abstract_structure": "unstructured",
        "abstract_word_limit": None,
        "word_limits": {},
        "sections_by_type": {},
    })
    svc = JournalStyleService(engine=None)
    style = await svc._llm_infer("Some Journal", provider)
    assert style is not None
    assert "INVALID_TYPE" not in style.accepted_article_types
    assert "original_research" in style.accepted_article_types
    assert "review" in style.accepted_article_types


# ── 37. Serialisation roundtrip ───────────────────────────────────────────────

def test_to_dict_from_dict_roundtrip():
    original = _make_style(
        citation_style=CitationStyle.nature,
        in_text_format="superscript",
        reference_sort_order="order_of_appearance",
        accepted_article_types=["original_research", "review", "brief_report"],
        max_references=50,
        abstract_structure="unstructured",
        abstract_word_limit=150,
        word_limits={"original_research": 3000, "review": 5000},
        sections_by_type={
            "original_research": ["Abstract", "Introduction", "Results", "Discussion", "Methods", "References"],
        },
        reference_format_name="Nature",
    )
    d = original.to_dict()
    restored = JournalStyle.from_dict(d)
    assert restored.citation_style == original.citation_style
    assert restored.accepted_article_types == original.accepted_article_types
    assert restored.max_references == original.max_references
    assert restored.abstract_structure == original.abstract_structure
    assert restored.abstract_word_limit == original.abstract_word_limit
    assert restored.word_limits == original.word_limits
    assert restored.sections_by_type == original.sections_by_type
    assert restored.reference_format_name == original.reference_format_name
