"""
journal_style_service.py

4-tier citation-style lookup for any target journal:
  1. Built-in curated table (backend/data/journal_styles.json)  — confidence 1.0
  2. Publisher-based default map                                  — confidence 0.8
  3. LLM inference (user's configured AI provider)              — confidence 0.6
  4. Universal fallback (AMA/NLM numbered)                       — confidence 0.5

Usage::

    svc = JournalStyleService(engine)
    style = await svc.get_style("Nature", provider=provider, publisher=None)
    prompt = style.to_citation_instructions()
    refs   = style.format_reference_list(summaries)
    abstract_hint = style.get_abstract_instructions()
    effective_limit = style.get_effective_word_limit("original_research", user_limit=4000)
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── Data directory ─────────────────────────────────────────────────────────────

_DATA_DIR = Path(__file__).parent.parent / "data"
_JOURNAL_STYLES_PATH = _DATA_DIR / "journal_styles.json"


# ── Citation style enum ────────────────────────────────────────────────────────

class CitationStyle(str, Enum):
    vancouver = "vancouver"
    nlm       = "nlm"
    ama       = "ama"
    nature    = "nature"
    cell      = "cell"
    apa       = "apa"
    harvard   = "harvard"
    science   = "science"
    ieee      = "ieee"
    default   = "default"


# Author-year styles (in-text: "Smith et al., 2023")
_AUTHOR_YEAR_STYLES = {CitationStyle.apa, CitationStyle.harvard, CitationStyle.cell}

# Numbered styles (in-text: [1])
_NUMBERED_STYLES = {
    CitationStyle.vancouver, CitationStyle.nlm, CitationStyle.ama,
    CitationStyle.nature, CitationStyle.science, CitationStyle.ieee,
    CitationStyle.default,
}


def _is_numbered(style: CitationStyle) -> bool:
    return style in _NUMBERED_STYLES


# ── JournalStyle dataclass ─────────────────────────────────────────────────────

@dataclass
class JournalStyle:
    journal_name: str
    citation_style: CitationStyle
    in_text_format: str                        # "numbered" | "superscript" | "author_year"
    reference_sort_order: str                  # "order_of_appearance" | "alphabetical"
    accepted_article_types: list[str]          # e.g. ["original_research", "review"]
    max_references: Optional[int]
    abstract_structure: Optional[str]          # "structured" | "unstructured"
    abstract_word_limit: Optional[int]
    word_limits: dict[str, Optional[int]]
    sections_by_type: dict[str, list[str]]
    reference_format_name: str                 # human-readable: "AMA", "Vancouver", "Nature" …
    source: str                                # "curated" | "publisher_default" | "llm" | "default_fallback"
    confidence: float                          # 0.5 – 1.0
    csl_id: Optional[str] = None              # CSL style file ID (e.g. "american-medical-association")

    # ── Citation instruction block ─────────────────────────────────────────────

    def to_citation_instructions(self) -> str:
        """Returns the citation rule block to inject into the AI system prompt."""
        style = self.citation_style
        name  = self.reference_format_name

        key_rule = (
            "- CRITICAL: The [CITE:key] tag MUST use the EXACT CITE_KEY value shown "
            "in each paper's header (e.g. if the header says CITE_KEY=10.1234/abc, "
            "write [CITE:10.1234/abc]). Do NOT invent keys like 'smith2023'.\n"
        )

        if _is_numbered(style):
            if style == CitationStyle.nature:
                in_text = "superscript numbers (e.g. ^1, ^2,3)"
                example = (
                    '"CBT reduced PHQ-9 scores (d=0.52) [CITE:10.1234/abc]^1."'
                )
            elif style == CitationStyle.science:
                in_text = "superscript numbers (e.g. ^1, ^2)"
                example = (
                    '"CBT reduced PHQ-9 scores (d=0.52) [CITE:10.1234/abc]^1."'
                )
            else:
                in_text = "numbered citations in square brackets (e.g. [1], [2,3])"
                example = (
                    '"CBT reduced PHQ-9 scores (d=0.52) [CITE:10.1234/abc] [1]."'
                )
            return (
                f"CITATION STYLE — {name} ({style.value.upper()}):\n"
                f"- Use {in_text} alongside [CITE:key] grounding markers.\n"
                f"{key_rule}"
                f"- Example: {example}\n"
                f"- Number citations by first appearance in the manuscript and reuse the same number for repeat citations.\n"
                f"- Reference list: numbered, {self.reference_sort_order.replace('_', ' ')} order.\n"
                f"- Do NOT use Author-Year format.\n"
            )
        else:
            # Author-year styles
            example = '"CBT reduced PHQ-9 scores (d=0.52) [CITE:10.1234/abc] (Smith et al., 2023)."'
            return (
                f"CITATION STYLE — {name} ({style.value.upper()}):\n"
                f"- Use author-year citations (e.g. (Smith et al., 2023)) alongside [CITE:key] grounding markers.\n"
                f"{key_rule}"
                f"- Example: {example}\n"
                f"- Reference list: {self.reference_sort_order.replace('_', ' ')} order.\n"
                f"- Do NOT use numbered citation style.\n"
            )

    # ── Pre-formatted reference list ───────────────────────────────────────────

    def format_reference_list(self, summaries: list[dict]) -> str:
        """
        Build a pre-formatted reference list from paper summaries.

        Uses industry-standard CSL (Citation Style Language) rendering via
        citeproc-py when a CSL style ID is available, falling back to the
        hand-coded formatter for compatibility.

        Server-side formatting prevents LLM hallucination of reference formats.
        """
        if not summaries:
            return ""

        # ── Prefer CSL rendering (industry standard) ───────────────────────────
        from services.csl_formatter import STYLE_TO_CSL_ID, format_references_csl

        csl_id = self.csl_id or STYLE_TO_CSL_ID.get(self.citation_style.value)
        if csl_id:
            result = format_references_csl(summaries, csl_id, self.reference_sort_order)
            if result:
                return result
            # If CSL rendering returned empty (style not found / error), fall through

        # ── Hand-coded fallback ────────────────────────────────────────────────
        style = self.citation_style
        refs: list[tuple[str, dict, int]] = []

        for i, s in enumerate(summaries[:60], 1):
            bib = s.get("bibliography", {})
            sort_key = _ref_sort_key(bib, style, i)
            refs.append((sort_key, s, i))

        if self.reference_sort_order == "alphabetical":
            refs.sort(key=lambda x: x[0])
            numbered = [(i + 1, r[1]) for i, r in enumerate(refs)]
        else:
            numbered = [(r[2], r[1]) for r in refs]

        lines = [_format_one_ref(num, s, style) for num, s in numbered]
        return "\n".join(lines)

    # ── Section list ───────────────────────────────────────────────────────────

    def get_sections(self, article_type: str) -> list[str]:
        """
        Returns journal-specific sections for the given article type.
        Falls back to universal defaults when journal-specific sections are absent.
        """
        sections = self.sections_by_type.get(article_type, [])
        if not sections:
            sections = _DEFAULT_SECTIONS_BY_TYPE.get(article_type, [])
        if not sections:
            return []
        if any(section.strip().lower().startswith("abstract") for section in sections):
            return sections
        return ["Abstract", *sections]

    # ── Abstract structure instructions ────────────────────────────────────────

    def get_abstract_instructions(self, article_type: str) -> str:
        """
        Returns a natural-language instruction block for the abstract section.
        Distinguishes structured (with required subheadings) vs. unstructured.
        """
        if self.abstract_structure == "structured":
            headings = _STRUCTURED_ABSTRACT_HEADINGS.get(
                article_type,
                ["Background", "Methods", "Results", "Conclusions"],
            )
            limit_note = (
                f" Total abstract: ≤{self.abstract_word_limit} words."
                if self.abstract_word_limit
                else ""
            )
            return (
                f"ABSTRACT STRUCTURE — Write a structured abstract with these mandatory subheadings "
                f"(bold or uppercase): {', '.join(headings)}.{limit_note}"
            )
        else:
            limit_note = (
                f" Keep it ≤{self.abstract_word_limit} words."
                if self.abstract_word_limit
                else ""
            )
            return f"ABSTRACT — Write an unstructured (single-paragraph) abstract.{limit_note}"

    # ── Word limit resolution ───────────────────────────────────────────────────

    def get_effective_word_limit(self, article_type: str, user_limit: int) -> tuple[int, str]:
        """
        Returns (effective_limit, note) where:
          - effective_limit: journal word limit for the type if known, else user_limit
          - note: human-readable explanation (e.g. "per journal guidelines" vs "user-selected")

        Returns user_limit unchanged if the journal has no specific limit for this type.
        """
        journal_limit = self.word_limits.get(article_type)
        if journal_limit is not None and journal_limit > 0:
            return journal_limit, f"per {self.journal_name} guidelines for {article_type.replace('_', ' ')}"
        return user_limit, "user-selected"

    # ── Max references note ────────────────────────────────────────────────────

    def get_max_references_instruction(self) -> str:
        """Returns a constraint string for the system prompt, or empty string."""
        if self.max_references:
            return f"REFERENCES LIMIT — Cite no more than {self.max_references} references total."
        return ""

    def to_dict(self) -> dict:
        """Serialise to plain dict for JSON storage."""
        return {
            "journal_name": self.journal_name,
            "citation_style": self.citation_style.value,
            "in_text_format": self.in_text_format,
            "reference_sort_order": self.reference_sort_order,
            "accepted_article_types": self.accepted_article_types,
            "max_references": self.max_references,
            "abstract_structure": self.abstract_structure,
            "abstract_word_limit": self.abstract_word_limit,
            "word_limits": self.word_limits,
            "sections_by_type": self.sections_by_type,
            "reference_format_name": self.reference_format_name,
            "source": self.source,
            "confidence": self.confidence,
            "csl_id": self.csl_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "JournalStyle":
        return cls(
            journal_name=d["journal_name"],
            citation_style=CitationStyle(d["citation_style"]),
            in_text_format=d.get("in_text_format", "numbered"),
            reference_sort_order=d.get("reference_sort_order", "order_of_appearance"),
            accepted_article_types=d.get("accepted_article_types", []),
            max_references=d.get("max_references"),
            abstract_structure=d.get("abstract_structure"),
            abstract_word_limit=d.get("abstract_word_limit"),
            word_limits=d.get("word_limits", {}),
            sections_by_type=d.get("sections_by_type", {}),
            reference_format_name=d.get("reference_format_name", "Default"),
            source=d.get("source", "default_fallback"),
            confidence=d.get("confidence", 0.5),
            csl_id=d.get("csl_id"),
        )


# ── Reference formatting helpers ───────────────────────────────────────────────

def _ref_sort_key(bib: dict, style: CitationStyle, idx: int) -> str:
    """Sort key: last name of first author + year for alpha styles, else index."""
    authors = bib.get("authors", [])
    first = authors[0] if authors else ""
    last = first.split(",")[0].strip() if "," in first else first.split()[-1] if first else ""
    year = str(bib.get("year") or "9999")
    return f"{last.lower()}_{year}_{idx:04d}"


def _abbreviate_authors(authors: list[str], style: CitationStyle) -> str:
    """Format author list per style rules."""
    if not authors:
        return "Unknown"

    def _abbrev_one(name: str) -> str:
        """'Smith AB' or 'A. B. Smith' → 'Smith AB' (Vancouver/NLM/AMA) or 'Smith, A.B.' (APA)"""
        name = name.strip()
        if not name:
            return name
        parts = name.split()
        if len(parts) == 1:
            return name
        # Assume 'FirstName [MiddleInitial] LastName' or 'LastName, FirstName'
        if "," in name:
            # Already 'LastName, First'
            last, rest = name.split(",", 1)
            initials = "".join(p[0].upper() for p in rest.split() if p)
            if style in _AUTHOR_YEAR_STYLES:
                return f"{last.strip()}, {''.join(c + '.' for c in initials)}"
            return f"{last.strip()} {initials}"
        else:
            # 'First [Mid] Last'
            last = parts[-1]
            initials = "".join(p[0].upper() for p in parts[:-1] if p)
            if style in _AUTHOR_YEAR_STYLES:
                return f"{last}, {''.join(c + '.' for c in initials)}"
            return f"{last} {initials}"

    abbrev = [_abbrev_one(a) for a in authors]

    if style == CitationStyle.nature:
        # "Smith, A. B. & Jones, C. D."
        def _nature_one(name: str) -> str:
            name = name.strip()
            if "," in name:
                last, rest = name.split(",", 1)
                initials = " ".join(p[0].upper() + "." for p in rest.split() if p)
                return f"{last.strip()}, {initials}"
            parts = name.split()
            last = parts[-1]
            initials = " ".join(p[0].upper() + "." for p in parts[:-1] if p)
            return f"{last}, {initials}"
        nat = [_nature_one(a) for a in authors[:6]]
        if len(authors) > 6:
            return ", ".join(nat) + " et al."
        return " & ".join([", ".join(nat[:-1]), nat[-1]]) if len(nat) > 1 else nat[0]

    if style == CitationStyle.science:
        # "A. B. Smith, C. D. Jones"
        def _sci_one(name: str) -> str:
            name = name.strip()
            if "," in name:
                last, rest = name.split(",", 1)
                initials = " ".join(p[0].upper() + "." for p in rest.split() if p)
                return f"{initials} {last.strip()}"
            parts = name.split()
            last = parts[-1]
            initials = " ".join(p[0].upper() + "." for p in parts[:-1] if p)
            return f"{initials} {last}"
        sci = [_sci_one(a) for a in authors[:5]]
        if len(authors) > 5:
            return ", ".join(sci) + " et al."
        return ", ".join(sci)

    if style in _AUTHOR_YEAR_STYLES:
        # APA/Harvard/Cell: "Smith, A.B., & Jones, C.D."
        if len(abbrev) == 1:
            return abbrev[0]
        if len(abbrev) == 2:
            sep = " &" if style == CitationStyle.apa else " and"
            return f"{abbrev[0]},{sep} {abbrev[1]}"
        if len(abbrev) > 20:
            return ", ".join(abbrev[:19]) + ", ... " + abbrev[-1]
        sep = " &" if style == CitationStyle.apa else " and"
        return ", ".join(abbrev[:-1]) + f",{sep} {abbrev[-1]}"

    # Vancouver/NLM/AMA: "Smith AB, Jones CD"
    if len(abbrev) > 6:
        return ", ".join(abbrev[:6]) + ", et al."
    return ", ".join(abbrev)


def _format_one_ref(num: int, s: dict, style: CitationStyle) -> str:
    """Format a single reference line according to citation style."""
    bib = s.get("bibliography", {})
    authors_raw = bib.get("authors", [])
    year   = bib.get("year") or "n.d."
    title  = bib.get("title") or s.get("paper_key", "Unknown")
    jname  = bib.get("journal") or ""
    volume = bib.get("volume") or ""
    issue  = bib.get("issue") or ""
    pages  = bib.get("pages") or ""
    doi    = bib.get("doi") or ""
    doi_str = f"doi:{doi}" if doi else ""

    authors_str = _abbreviate_authors(authors_raw, style)
    vol_issue = f"{volume}({issue})" if volume and issue else volume or issue or ""
    pages_str = f":{pages}" if pages else ""
    vol_pages = f"{vol_issue}{pages_str}" if vol_issue or pages_str else ""

    if style in (CitationStyle.vancouver, CitationStyle.nlm):
        # 1. Smith AB, Jones CD. Title. J Abbrev. 2020;34(5):123-130.
        j_part = f" {jname}." if jname else "."
        y_part = f" {year}"
        sep = ";" if vol_pages else "."
        vp = f"{sep}{vol_pages}." if vol_pages else "."
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str}. {title}.{j_part}{y_part}{vp}{doi_part}"

    elif style == CitationStyle.ama:
        # 1. Smith AB, Jones CD. Title. *Journal*. 2020;34(5):123-130. doi:...
        j_part = f" *{jname}*." if jname else "."
        y_part = f" {year}"
        sep = ";" if vol_pages else "."
        vp = f"{sep}{vol_pages}." if vol_pages else "."
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str}. {title}.{j_part}{y_part}{vp}{doi_part}"

    elif style == CitationStyle.nature:
        # 1. Smith, A. B. & Jones, C. D. Title. *Nature* **34**, 123–130 (2020).
        j_part = f" *{jname}*" if jname else ""
        vol_part = f" **{volume}**" if volume else ""
        pg_part = f", {pages}" if pages else ""
        y_part = f" ({year})."
        doi_part = f" https://doi.org/{doi}" if doi else ""
        ref = f"{num}. {authors_str} {title}.{j_part}{vol_part}{pg_part}{y_part}{doi_part}"

    elif style == CitationStyle.science:
        # 1. A. B. Smith, C. D. Jones, Title. *Science* **368**, 123-130 (2020).
        j_part = f" *{jname}*" if jname else ""
        vol_part = f" **{volume}**" if volume else ""
        pg_part = f", {pages}" if pages else ""
        y_part = f" ({year})."
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str}, {title}.{j_part}{vol_part}{pg_part}{y_part}{doi_part}"

    elif style == CitationStyle.apa:
        # Smith, A. B., & Jones, C. D. (2020). Title. *Journal Name*, 34(5), 123-130.
        y_part = f"({year}). "
        j_part = f" *{jname}*" if jname else ""
        vp_part = f", *{vol_issue}*{pages_str}" if vol_issue else (f", {pages}" if pages else "")
        doi_part = f" https://doi.org/{doi}" if doi else ""
        ref = f"{num}. {authors_str} {y_part}{title}.{j_part}{vp_part}.{doi_part}"

    elif style == CitationStyle.harvard:
        # Smith, A.B. and Jones, C.D. (2020) 'Title', *Journal Name*, 34(5), pp.123-130.
        y_part = f"({year}) "
        j_part = f" *{jname}*" if jname else ""
        vp_part = f", {vol_issue}, pp.{pages}" if vol_issue and pages else (f", {vol_issue}" if vol_issue else "")
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str} {y_part}'{title}',{j_part}{vp_part}.{doi_part}"

    elif style == CitationStyle.cell:
        # Smith, A.B., and Jones, C.D. (2020). Title. *Cell* *34*, 123-130.
        y_part = f"({year}). "
        j_part = f" *{jname}*" if jname else ""
        vol_part = f" *{volume}*" if volume else ""
        pg_part = f", {pages}" if pages else ""
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str} {y_part}{title}.{j_part}{vol_part}{pg_part}.{doi_part}"

    else:
        # Default (AMA/NLM-like)
        j_part = f" {jname}." if jname else "."
        y_part = f" {year}"
        sep = ";" if vol_pages else "."
        vp = f"{sep}{vol_pages}." if vol_pages else "."
        doi_part = f" {doi_str}" if doi_str else ""
        ref = f"{num}. {authors_str}. {title}.{j_part}{y_part}{vp}{doi_part}"

    # ── Clean up formatting artifacts common to all styles ────────────────
    # Protect legitimate ellipses before cleanup
    ref = ref.replace('...', '\x00ELLIPSIS\x00')
    ref = re.sub(r'\.{2,}', '.', ref)        # ".." → "."
    ref = re.sub(r'\.\s+\.', '.', ref)        # ". ." → "."
    ref = re.sub(r'\s{2,}', ' ', ref)         # double spaces → single
    ref = re.sub(r',\s*\.', '.', ref)         # ",." → "."
    ref = ref.replace('\x00ELLIPSIS\x00', '...')
    return ref


# ── Default sections by article type ─────────────────────────────────────────
# Used when journal-specific sections are not available (tier 3/4 fallback)

_DEFAULT_SECTIONS_BY_TYPE: dict[str, list[str]] = {
    "original_research":   ["Abstract", "Introduction", "Methods", "Results", "Discussion", "Conclusions", "References"],
    "systematic_review":   [
        "Abstract",
        "Introduction",
        "Methods — Protocol and Registration",
        "Methods — Eligibility Criteria",
        "Methods — Information Sources and Search Strategy",
        "Methods — Study Selection",
        "Methods — Data Extraction",
        "Methods — Risk of Bias Assessment",
        "Methods — Statistical Synthesis / Meta-analysis",
        "Results — Study Selection",
        "Results — Characteristics of Included Studies",
        "Results — Risk of Bias Across Studies",
        "Results — Synthesis of Results",
        "Discussion",
        "Conclusions",
        "References",
    ],
    "scoping_review":      [
        "Abstract",
        "Introduction",
        "Methods — Protocol",
        "Methods — Eligibility Criteria",
        "Methods — Information Sources and Search Strategy",
        "Methods — Study Selection Process",
        "Methods — Data Charting",
        "Results — Study Selection",
        "Results — Characteristics of Included Sources",
        "Results — Summary of Evidence",
        "Discussion",
        "Conclusions",
        "References",
    ],
    "narrative_review":    [
        "Abstract",
        "Introduction",
        "Methods",
        "Results and Discussion",
        "Conclusions and Future Directions",
        "References",
    ],
    "review":              ["Abstract", "Introduction", "Methods (Literature Search)", "Results and Discussion", "Conclusion", "References"],
    "meta_analysis":       ["Abstract", "Introduction", "Methods", "Results", "Discussion", "Conclusions", "References"],
    "case_report":         ["Abstract", "Introduction", "Case Presentation", "Discussion", "Conclusions", "References"],
    "short_communication": ["Abstract", "Introduction", "Methods", "Results", "Discussion", "References"],
    "brief_report":        ["Abstract", "Introduction", "Methods", "Results", "Discussion", "References"],
    "editorial":           ["Abstract", "Introduction", "Discussion", "Conclusions", "References"],
    "letter":              ["Abstract", "Text", "References"],
    "opinion":             ["Abstract", "Introduction", "Discussion", "Conclusions", "References"],
    "study_protocol":      [
        "Abstract",
        "Administrative Information",
        "Introduction — Background and Rationale",
        "Introduction — Objectives",
        "Trial Design",
        "Methods — Study Setting",
        "Methods — Eligibility Criteria",
        "Methods — Interventions",
        "Methods — Outcomes",
        "Methods — Participant Timeline",
        "Methods — Sample Size",
        "Methods — Recruitment",
        "Methods — Assignment of Interventions: Allocation",
        "Methods — Blinding",
        "Methods — Data Collection and Management",
        "Methods — Statistical Methods",
        "Methods — Oversight and Monitoring",
        "Ethics and Dissemination",
        "Discussion",
        "Trial Status",
        "References",
    ],
}

# Structured abstract heading templates by article type
_STRUCTURED_ABSTRACT_HEADINGS: dict[str, list[str]] = {
    "original_research":   ["Background", "Objective", "Methods", "Results", "Conclusions"],
    "systematic_review":   ["Background", "Objectives", "Methods", "Results", "Conclusions"],
    "scoping_review":      ["Background", "Objectives", "Methods", "Results", "Conclusions"],
    "narrative_review":    ["Background", "Objective", "Sources", "Content", "Conclusions"],
    "review":              ["Background", "Purpose", "Methods", "Findings", "Conclusions"],
    "meta_analysis":       ["Background", "Purpose", "Data Sources", "Study Selection", "Data Extraction", "Results", "Conclusions"],
    "case_report":         ["Background", "Case Presentation", "Discussion", "Conclusions"],
    "short_communication": ["Background", "Methods", "Results", "Conclusions"],
    "brief_report":        ["Background", "Methods", "Results", "Conclusions"],
    "study_protocol":      ["Background", "Methods", "Discussion", "Trial Registration"],
}


# ── Fallback style ─────────────────────────────────────────────────────────────

_FALLBACK_STYLE = JournalStyle(
    journal_name="Default",
    citation_style=CitationStyle.default,
    in_text_format="numbered",
    reference_sort_order="order_of_appearance",
    accepted_article_types=[],
    max_references=None,
    abstract_structure=None,
    abstract_word_limit=None,
    word_limits={},
    sections_by_type={},
    reference_format_name="Default (AMA/NLM)",
    source="default_fallback",
    confidence=0.5,
)


# ── Curated data loader ────────────────────────────────────────────────────────

def _load_curated() -> dict:
    """Load and parse journal_styles.json once."""
    try:
        with open(_JOURNAL_STYLES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.warning("Could not load journal_styles.json — using empty curated table")
        return {"journals": [], "publisher_defaults": {}}


_CURATED: dict = {}


def _get_curated() -> dict:
    global _CURATED
    if not _CURATED:
        _CURATED = _load_curated()
    return _CURATED


def _entry_to_style(entry: dict, source: str = "curated", confidence: float = 1.0) -> JournalStyle:
    """Convert a journal_styles.json entry to a JournalStyle object."""
    from services.csl_formatter import STYLE_TO_CSL_ID
    citation_style = CitationStyle(entry["citation_style"])
    # Use explicit csl_id from JSON, or derive from citation_style mapping
    csl_id = entry.get("csl_id") or STYLE_TO_CSL_ID.get(citation_style.value)
    return JournalStyle(
        journal_name=entry["name"],
        citation_style=citation_style,
        in_text_format=entry.get("in_text_format", "numbered"),
        reference_sort_order=entry.get("reference_sort_order", "order_of_appearance"),
        accepted_article_types=entry.get("accepted_article_types", []),
        max_references=entry.get("max_references"),
        abstract_structure=entry.get("abstract_structure"),
        abstract_word_limit=entry.get("abstract_word_limit"),
        word_limits=entry.get("word_limits", {}),
        sections_by_type=entry.get("sections_by_type", {}),
        reference_format_name=entry.get("reference_format_name", "Default"),
        source=source,
        confidence=confidence,
        csl_id=csl_id,
    )


def _normalise(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


# ── Main service class ─────────────────────────────────────────────────────────

class JournalStyleService:
    """
    Resolves citation style for any journal name via a 4-tier lookup.
    Optionally caches LLM results in a DB table (journal_style_cache).
    """

    def __init__(self, engine=None):
        self._engine = engine
        self._mem_cache: dict[str, JournalStyle] = {}

    # ── Public API ─────────────────────────────────────────────────────────────

    async def get_style(
        self,
        journal_name: str,
        provider=None,
        publisher: Optional[str] = None,
    ) -> JournalStyle:
        """
        Return a JournalStyle for the given journal.  Never raises.
        Falls back to AMA/NLM default if all tiers fail.
        """
        if not journal_name or not journal_name.strip():
            return _FALLBACK_STYLE

        name_clean = journal_name.strip()
        cache_key  = _normalise(name_clean)

        # In-memory cache
        if cache_key in self._mem_cache:
            return self._mem_cache[cache_key]

        # Tier 1: exact + fuzzy curated lookup
        style = self._lookup_curated(name_clean)
        if style:
            self._mem_cache[cache_key] = style
            return style

        # Tier 2: publisher-based default
        if publisher:
            style = self._publisher_default(name_clean, publisher)
            if style:
                self._mem_cache[cache_key] = style
                return style

        # Tier 3: DB cache from previous LLM inference
        if self._engine:
            style = await self._load_from_db(cache_key)
            if style:
                self._mem_cache[cache_key] = style
                return style

        # Tier 3 continued: LLM inference
        if provider:
            style = await self._llm_infer(name_clean, provider)
            if style:
                if self._engine:
                    await self._save_to_db(cache_key, style)
                self._mem_cache[cache_key] = style
                return style

        # Tier 4: universal fallback
        from services.csl_formatter import STYLE_TO_CSL_ID
        fallback = JournalStyle(
            journal_name=name_clean,
            citation_style=CitationStyle.default,
            in_text_format="numbered",
            reference_sort_order="order_of_appearance",
            accepted_article_types=[],
            max_references=None,
            abstract_structure=None,
            abstract_word_limit=None,
            word_limits={},
            sections_by_type={},
            reference_format_name="Default (AMA/NLM)",
            source="default_fallback",
            confidence=0.5,
            csl_id=STYLE_TO_CSL_ID.get(CitationStyle.default.value),
        )
        self._mem_cache[cache_key] = fallback
        return fallback

    # ── Tier 1: curated lookup ─────────────────────────────────────────────────

    def _lookup_curated(self, journal_name: str) -> Optional[JournalStyle]:
        curated = _get_curated()
        norm = _normalise(journal_name)

        # Exact match (name or alias)
        for entry in curated.get("journals", []):
            if _normalise(entry["name"]) == norm:
                return _entry_to_style(entry, source="curated", confidence=1.0)
            for alias in entry.get("aliases", []):
                if _normalise(alias) == norm:
                    return _entry_to_style(entry, source="curated", confidence=1.0)

        # Fuzzy: all words in query must appear in journal name (or vice versa)
        query_words = set(norm.split())  # after normalise it's one word; split orig
        query_words = set(re.sub(r"[^a-z0-9]", " ", journal_name.lower()).split())
        best_entry  = None
        best_score  = 0.0

        for entry in curated.get("journals", []):
            candidates = [entry["name"]] + entry.get("aliases", [])
            for cand in candidates:
                cand_words = set(re.sub(r"[^a-z0-9]", " ", cand.lower()).split())
                # Score: ratio of query words found in candidate words
                if not query_words:
                    continue
                common = query_words & cand_words
                score  = len(common) / max(len(query_words), 1)
                # Require at least half the words to match AND min 2 common words
                if score >= 0.6 and len(common) >= min(2, len(query_words)):
                    if score > best_score:
                        best_score = score
                        best_entry = entry

        if best_entry:
            conf = 0.9 if best_score >= 0.9 else 0.8
            return _entry_to_style(best_entry, source="curated", confidence=conf)

        return None

    # ── Tier 2: publisher default ──────────────────────────────────────────────

    def _publisher_default(self, journal_name: str, publisher: str) -> Optional[JournalStyle]:
        curated = _get_curated()
        pub_defaults: dict = curated.get("publisher_defaults", {})

        # Try exact match first, then substring match
        style_val = pub_defaults.get(publisher)
        if not style_val:
            pub_norm = publisher.lower()
            for key, val in pub_defaults.items():
                if key.lower() in pub_norm or pub_norm in key.lower():
                    style_val = val
                    break

        if not style_val:
            return None

        try:
            cs = CitationStyle(style_val)
        except ValueError:
            return None

        # Build a minimal style from the publisher default
        in_text = "author_year" if cs in _AUTHOR_YEAR_STYLES else (
            "superscript" if cs in (CitationStyle.nature, CitationStyle.science) else "numbered"
        )
        sort_order = "alphabetical" if cs in _AUTHOR_YEAR_STYLES else "order_of_appearance"

        from services.csl_formatter import STYLE_TO_CSL_ID
        return JournalStyle(
            journal_name=journal_name,
            citation_style=cs,
            in_text_format=in_text,
            reference_sort_order=sort_order,
            accepted_article_types=[],
            max_references=None,
            abstract_structure=None,
            abstract_word_limit=None,
            word_limits={},
            sections_by_type={},
            reference_format_name=cs.value.upper(),
            source="publisher_default",
            confidence=0.8,
            csl_id=STYLE_TO_CSL_ID.get(cs.value),
        )

    # ── Tier 3: DB cache ───────────────────────────────────────────────────────

    async def _load_from_db(self, cache_key: str) -> Optional[JournalStyle]:
        try:
            from sqlalchemy import text as sa_text
            ttl_days = 90
            cutoff   = (datetime.utcnow() - timedelta(days=ttl_days)).isoformat()
            async with self._engine.connect() as conn:
                row = await conn.execute(
                    sa_text(
                        "SELECT style_data FROM journal_style_cache "
                        "WHERE journal_key = :k AND fetched_at > :cutoff"
                    ),
                    {"k": cache_key, "cutoff": cutoff},
                )
                result = row.fetchone()
                if result:
                    return JournalStyle.from_dict(json.loads(result[0]))
        except Exception:
            pass
        return None

    async def _save_to_db(self, cache_key: str, style: JournalStyle) -> None:
        try:
            from sqlalchemy import text as sa_text
            now = datetime.utcnow().isoformat()
            data_json = json.dumps(style.to_dict())
            async with self._engine.begin() as conn:
                # Upsert pattern (works for both SQLite and Postgres)
                try:
                    await conn.execute(
                        sa_text(
                            "INSERT INTO journal_style_cache (journal_key, style_data, source, fetched_at) "
                            "VALUES (:k, :d, :s, :t)"
                        ),
                        {"k": cache_key, "d": data_json, "s": style.source, "t": now},
                    )
                except Exception:
                    await conn.execute(
                        sa_text(
                            "UPDATE journal_style_cache SET style_data=:d, source=:s, fetched_at=:t "
                            "WHERE journal_key=:k"
                        ),
                        {"k": cache_key, "d": data_json, "s": style.source, "t": now},
                    )
        except Exception:
            pass

    # ── Tier 3 continued: LLM inference ───────────────────────────────────────

    async def _llm_infer(self, journal_name: str, provider) -> Optional[JournalStyle]:
        """
        Ask the LLM for the full journal style profile.

        Requests all metadata fields — citation style, in-text format,
        accepted article types, sections per type, word limits, abstract
        structure, abstract word limit, and max references.  Falls back
        gracefully to sensible defaults for any missing fields.
        """
        # Valid article types the LLM may return
        valid_types = [
            "original_research", "review", "meta_analysis",
            "case_report", "short_communication", "brief_report",
            "editorial", "letter",
        ]
        # Short example sections for the prompt
        example_sections = {
            "original_research": ["Abstract", "Introduction", "Methods", "Results", "Discussion", "References"],
            "review": ["Abstract", "Introduction", "Methods (Literature Search)", "Results and Discussion", "Conclusion", "References"],
            "case_report": ["Abstract", "Introduction", "Case Presentation", "Discussion", "References"],
        }
        prompt = (
            f"Provide the complete author/submission style guide for the academic journal '{journal_name}'.\n"
            "Return ONLY valid JSON (no markdown, no explanation, no trailing commas) using this schema:\n"
            '{\n'
            '  "citation_style": "<one of: vancouver|nlm|ama|nature|cell|apa|harvard|science|ieee|default>",\n'
            '  "in_text_format": "<numbered|superscript|author_year>",\n'
            '  "reference_sort_order": "<order_of_appearance|alphabetical>",\n'
            '  "reference_format_name": "<short human name: AMA | Vancouver | NLM | APA | Harvard | Nature | Science | Cell | IEEE>",\n'
            '  "csl_id": "<CSL style file ID from https://github.com/citation-style-language/styles, e.g. american-medical-association | nature | apa | cell | science | ieee | bmj | elife | frontiers | elsevier-vancouver | elsevier-harvard | harvard-cite-them-right | or null if unsure>",\n'
            f'  "accepted_article_types": ["<subset of: {", ".join(valid_types)}>"],\n'
            '  "max_references": <integer or null>,\n'
            '  "abstract_structure": "<structured|unstructured|null>",\n'
            '  "abstract_word_limit": <integer or null>,\n'
            '  "word_limits": {\n'
            '    "<article_type>": <integer or null>\n'
            '  },\n'
            '  "sections_by_type": {\n'
            '    "<article_type>": ["Section1", "Section2", ...]\n'
            '  }\n'
            '}\n\n'
            "Guidelines:\n"
            "- Only include article types actually accepted by this journal.\n"
            "- sections_by_type: list sections in the order they appear in the journal's Instructions for Authors.\n"
            f"  Example: {json.dumps(example_sections)}\n"
            "- word_limits: use null if the journal has no word limit for that type.\n"
            "- csl_id: provide the exact CSL style repository filename (without .csl) for this journal if known.\n"
            "- If you are not confident about a field, use null rather than guessing."
        )
        try:
            raw = await provider.complete(
                system="You are a precise scientific publishing expert. Output only valid JSON.",
                user=prompt,
                json_mode=True,
                temperature=0.0,
            )
            if isinstance(raw, str):
                data = json.loads(raw)
            else:
                data = raw

            # --- Safe parsing of each field --------------------------------
            cs_raw = data.get("citation_style", "default")
            try:
                cs = CitationStyle(cs_raw)
            except ValueError:
                cs = CitationStyle.default

            # Validate accepted article types
            raw_types = data.get("accepted_article_types") or []
            accepted_types = [t for t in raw_types if isinstance(t, str) and t in valid_types]

            # Validate sections_by_type
            raw_sections = data.get("sections_by_type") or {}
            sections_by_type: dict[str, list[str]] = {}
            for atype, slist in raw_sections.items():
                if isinstance(atype, str) and isinstance(slist, list):
                    sections_by_type[atype] = [s for s in slist if isinstance(s, str)]

            # Validate word_limits
            raw_limits = data.get("word_limits") or {}
            word_limits: dict[str, Optional[int]] = {}
            for atype, limit in raw_limits.items():
                if isinstance(atype, str):
                    word_limits[atype] = int(limit) if isinstance(limit, (int, float)) and limit else None

            # abstract_structure
            abs_struct_raw = data.get("abstract_structure")
            abstract_structure = abs_struct_raw if abs_struct_raw in ("structured", "unstructured") else None

            # abstract_word_limit
            awl = data.get("abstract_word_limit")
            abstract_word_limit = int(awl) if isinstance(awl, (int, float)) and awl else None

            # max_references
            mr = data.get("max_references")
            max_references = int(mr) if isinstance(mr, (int, float)) and mr else None

            # csl_id: LLM-provided or derived from citation_style mapping
            from services.csl_formatter import STYLE_TO_CSL_ID
            llm_csl_id = data.get("csl_id") or None
            csl_id = llm_csl_id or STYLE_TO_CSL_ID.get(cs.value)

            return JournalStyle(
                journal_name=journal_name,
                citation_style=cs,
                in_text_format=data.get("in_text_format", "numbered"),
                reference_sort_order=data.get("reference_sort_order", "order_of_appearance"),
                accepted_article_types=accepted_types,
                max_references=max_references,
                abstract_structure=abstract_structure,
                abstract_word_limit=abstract_word_limit,
                word_limits=word_limits,
                sections_by_type=sections_by_type,
                reference_format_name=data.get("reference_format_name", cs.value.upper()),
                source="llm",
                confidence=0.6,
                csl_id=csl_id,
            )
        except Exception as exc:
            logger.warning("LLM journal style inference failed for %r: %s", journal_name, exc)
            return None


# ── Prompt builder helpers ─────────────────────────────────────────────────────

def build_article_system_prompt(journal_style: JournalStyle, base_system: str) -> str:
    """
    Inject citation style instructions into the base system prompt.
    Replaces the hardcoded [Author, Year] example line with style-specific rules.
    """
    citation_block = journal_style.to_citation_instructions()
    # Replace the hardcoded citation format line in the base prompt
    new_prompt = re.sub(
        r"- Use \[Author, Year\] inline citation style alongside \[CITE:key\]\.\n"
        r"  - Example:.*?\n",
        citation_block + "\n",
        base_system,
        flags=re.DOTALL,
    )
    if new_prompt == base_system:
        # Fallback: append if replacement didn't work
        new_prompt = base_system + "\n\n" + citation_block
    return new_prompt
