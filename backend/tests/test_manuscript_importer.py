"""
Tests for manuscript_importer — section detection, reference counting, docx extraction.

All tests use synthetic text (no AI provider needed).
"""
import pytest

from services.manuscript_importer import (
    detect_sections_with_ranges,
    _count_references,
    _extract_references_section,
)


# ═══════════════════════════════════════════════════════════════════════════════
# Reference counting tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestCountReferences:
    """Test _count_references with various Zotero/EndNote/Mendeley output formats."""

    # ── Vancouver / numbered [N] style (Zotero/EndNote) ──

    def test_bracketed_numbered_refs(self):
        """[1] Author AB, ... style — common Vancouver format."""
        text = "# References\n" + "\n".join(
            f"[{i}] Author{i} AB, Title {i}. Journal. 2024;1:1-10."
            for i in range(1, 74)
        )
        assert _count_references(text) == 73

    def test_paren_numbered_refs(self):
        """(1) Author AB, ... style — parenthesized numbers."""
        text = "References\n" + "\n".join(
            f"({i}) Author{i} AB, Title {i}. Journal. 2024;1:1-10."
            for i in range(1, 26)
        )
        assert _count_references(text) == 25

    # ── N. Author style (Vancouver variant — Zotero/EndNote) ──

    def test_dot_numbered_refs(self):
        """1. Author AB, ... style — Zotero/EndNote Vancouver variant."""
        text = "References\n" + "\n".join(
            f"{i}. Author{i} AB, Title {i}. Journal. 2024;1:1-10."
            for i in range(1, 51)
        )
        assert _count_references(text) == 50

    # ── APA / author-year style (Zotero/Mendeley) ──

    def test_author_year_refs(self):
        """Author, A. B. (2024). Title. — APA style from Zotero/Mendeley."""
        text = "# References\n" + "\n".join(
            f"Smith{i}, A. B. (202{i % 10}). Title {i}. Journal, 1(1), 1-10."
            for i in range(1, 31)
        )
        assert _count_references(text) == 30

    # ── Paragraph fallback (unknown citation style from ref manager) ──

    def test_paragraph_fallback_in_references_section(self):
        """When no regex matches, count paragraphs > 30 chars in references section.

        This handles any CSL style that Zotero/EndNote/Mendeley can produce.
        """
        refs = "\n".join(
            f"Some Author Group. A really long reference title number {i}. Important Journal. 2024."
            for i in range(1, 21)
        )
        text = "# Introduction\nSome intro text.\n\n# References\n" + refs
        count = _count_references(text)
        assert count >= 18  # allow small margin for blank lines

    # ── DOI fallback ──

    def test_doi_fallback(self):
        """Count DOIs when nothing else works."""
        refs = "\n".join(
            f"Author Group {i}, Some Long Reference Title Number {i}, Important Journal, 2024. doi:10.1000/test{i}"
            for i in range(1, 16)
        )
        text = "References\n" + refs
        assert _count_references(text) >= 14

    def test_doi_url_format(self):
        """DOIs as https://doi.org/... links."""
        refs = "\n".join(
            f"Ref text {i}. https://doi.org/10.1234/abc{i}"
            for i in range(1, 11)
        )
        text = "References\n" + refs
        assert _count_references(text) >= 9

    # ── Edge cases ──

    def test_no_references_section(self):
        """Scanning full text when no references section found."""
        text = "[1] First ref.\n[2] Second ref.\n[3] Third ref.\n"
        assert _count_references(text) == 3

    def test_empty_text(self):
        assert _count_references("") == 0

    def test_non_contiguous_numbered(self):
        """Numbered refs with gaps — max should be returned."""
        text = "References\n[1] Ref one.\n[5] Ref five.\n[10] Ref ten.\n"
        assert _count_references(text) == 10

    def test_single_ref_not_counted_as_numbered(self):
        """A single numbered match should not trigger numbered counting.

        E.g. '[1]' in body text should not yield count=1.
        """
        text = "This is body text with a citation [1] somewhere.\n\nReferences\nSmith, A. (2024). Title. Journal."
        # Should not return 1 from the in-text [1] pattern
        count = _count_references(text)
        assert count <= 1

    def test_mixed_inline_and_bibliography(self):
        """In-text citations [1-5] should not inflate count; only bibliography matters."""
        body = "As shown [1-5], the results are clear.\nAnother point [6].\n"
        refs = "\n".join(
            f"[{i}] Author{i}. Title {i}. J. 2024;1:1."
            for i in range(1, 11)
        )
        text = body + "# References\n" + refs
        assert _count_references(text) == 10


# ═══════════════════════════════════════════════════════════════════════════════
# References section extraction tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestExtractReferencesSection:

    def test_finds_references_header(self):
        text = "# Introduction\nBlah\n# References\nRef 1\nRef 2"
        ref_text = _extract_references_section(text)
        assert "Ref 1" in ref_text
        assert "Introduction" not in ref_text

    def test_finds_markdown_references(self):
        text = "Body text.\n## References\n[1] First ref.\n[2] Second ref."
        ref_text = _extract_references_section(text)
        assert "[1] First ref." in ref_text

    def test_finds_bibliography_header(self):
        text = "Body text\nBibliography\nRef 1\nRef 2"
        assert "Ref 1" in _extract_references_section(text)

    def test_finds_works_cited(self):
        text = "Body text\nWorks Cited\nRef 1\nRef 2"
        assert "Ref 1" in _extract_references_section(text)

    def test_returns_empty_when_not_found(self):
        assert _extract_references_section("No refs here") == ""

    def test_plain_text_references_colon(self):
        text = "Discussion ends.\nReferences:\n1. Smith A. Title. J. 2024."
        ref_text = _extract_references_section(text)
        assert "Smith" in ref_text


# ═══════════════════════════════════════════════════════════════════════════════
# Section detection tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestSectionDetection:

    def test_markdown_headers(self):
        text = (
            "# Abstract\nSome text\n"
            "## Introduction\nMore text\n"
            "## Methods\nText\n"
            "## Results\nText\n"
            "## Discussion\nText"
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Abstract" in names
        assert "Introduction" in names
        assert "Methods" in names
        assert "Results" in names
        assert "Discussion" in names
        assert len(sections) >= 5

    def test_expanded_section_names(self):
        """Subsections like 'Study Design', 'Statistical Analysis' should be detected."""
        text = (
            "# Methods\nText\n"
            "## Study Design\nText\n"
            "## Participants\nText\n"
            "## Statistical Analysis\nText\n"
            "## Data Collection\nText"
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Study Design" in names
        assert "Participants" in names
        assert "Statistical Analysis" in names
        assert "Data Collection" in names

    def test_protocol_sections(self):
        """Study protocol sections should be detected."""
        text = (
            "# Trial Design\nText\n"
            "## Eligibility Criteria\nText\n"
            "## Sample Size\nText\n"
            "## Randomization\nText\n"
            "## Blinding\nText\n"
            "## Recruitment\nText"
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Trial Design" in names
        assert "Eligibility Criteria" in names
        assert "Sample Size" in names
        assert "Randomization" in names

    def test_review_sections(self):
        """Review/meta-analysis sections should be detected."""
        text = (
            "# Search Strategy\nText\n"
            "## Study Selection\nText\n"
            "## Risk Of Bias\nText\n"
            "## Data Synthesis\nText\n"
            "## Meta-Analysis\nText"
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Search Strategy" in names
        assert "Study Selection" in names
        assert "Data Synthesis" in names

    def test_back_matter_sections(self):
        """Front/back matter sections should be detected."""
        text = (
            "# Author Contributions\nText\n"
            "## Data Availability\nText\n"
            "## Competing Interests\nText\n"
            "## Funding\nText"
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Author Contributions" in names
        assert "Data Availability" in names
        assert "Funding" in names

    def test_plain_text_headers_with_colon(self):
        text = "Abstract:\nSome text\nMethods:\nMore text\nResults:\nText"
        sections = detect_sections_with_ranges(text)
        assert len(sections) >= 3

    def test_allcaps_headers(self):
        """ALL-CAPS section names common in .docx extraction."""
        text = "ABSTRACT\nSome text\nINTRODUCTION\nMore text\nMETHODS\nText"
        sections = detect_sections_with_ranges(text)
        assert len(sections) >= 3
        # Names should be title-cased
        names = [s["name"] for s in sections]
        assert "Abstract" in names
        assert "Introduction" in names
        assert "Methods" in names

    def test_allcaps_long_line_skipped(self):
        """Long ALL-CAPS lines (> 80 chars) should be skipped (not headings)."""
        long_caps = "A" * 100
        text = f"ABSTRACT\nSome text\n{long_caps}\nMore text\nMETHODS\nText"
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        # Only Abstract and Methods should be detected, not the long line
        assert len(sections) == 2

    def test_line_ranges_correct(self):
        text = "# Abstract\nLine 2\nLine 3\n# Methods\nLine 5\nLine 6"
        sections = detect_sections_with_ranges(text)
        assert sections[0]["start_line"] == 1
        assert sections[0]["end_line"] == 3
        assert sections[1]["start_line"] == 4
        assert sections[1]["end_line"] == 6

    def test_deduplication(self):
        """Same section name appearing twice should only be counted once."""
        text = "# Methods\nFirst methods\n# Methods\nDuplicate"
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert names.count("Methods") == 1

    def test_empty_text(self):
        assert detect_sections_with_ranges("") == []

    def test_no_sections(self):
        text = "This is just a paragraph of text with no headings."
        assert detect_sections_with_ranges(text) == []

    def test_materials_and_methods(self):
        """Compound section name 'Materials and Methods'."""
        text = "# Introduction\nText\n## Materials And Methods\nText\n## Results\nText"
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert "Materials And Methods" in names


# ═══════════════════════════════════════════════════════════════════════════════
# Integration-style tests (combined section + reference detection)
# ═══════════════════════════════════════════════════════════════════════════════

class TestIntegration:

    def test_full_manuscript_structure(self):
        """Simulate a realistic manuscript with sections and references."""
        text = (
            "# Title of the Paper\n\n"
            "## Abstract\n"
            "Background: This study aims to...\n"
            "Methods: We conducted a...\n\n"
            "## Introduction\n"
            "Previous research has shown...\n\n"
            "## Methods\n"
            "### Study Design\n"
            "This was a randomized controlled trial.\n\n"
            "### Participants\n"
            "We recruited 200 participants.\n\n"
            "### Statistical Analysis\n"
            "Data were analyzed using...\n\n"
            "## Results\n"
            "### Baseline Characteristics\n"
            "Table 1 shows demographics.\n\n"
            "## Discussion\n"
            "Our findings indicate...\n\n"
            "### Strengths And Limitations\n"
            "The study has several strengths...\n\n"
            "## Conclusions\n"
            "In summary...\n\n"
            "## References\n"
            + "\n".join(
                f"[{i}] Author{i} AB. Title {i}. J Med. 2024;1(1):1-{i}."
                for i in range(1, 46)
            )
        )
        sections = detect_sections_with_ranges(text)
        names = [s["name"] for s in sections]
        assert len(sections) >= 8  # at least 8 sections/subsections
        assert "Abstract" in names
        assert "Study Design" in names
        assert "Statistical Analysis" in names
        assert "Baseline Characteristics" in names
        assert "References" in names

        ref_count = _count_references(text)
        assert ref_count == 45
