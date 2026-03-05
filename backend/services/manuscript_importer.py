"""
services/manuscript_importer.py

Import an existing manuscript (pasted text or .docx bytes) and produce:
  - Section structure (Abstract, Introduction, Methods, …)
  - Reference list count
  - AI-generated manuscript summary (3–5 sentences)
"""

from __future__ import annotations

import io
import json
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from services.ai_provider import AIProvider


# ── Section detection ──────────────────────────────────────────────────────────

_SECTION_PATTERNS = [
    r'^\s*#+\s*(abstract|introduction|background|methods?|methodology|results?|'
    r'discussion|conclusion|references?|acknowledgements?|limitations?|'
    r'supplementary|appendix|conflict[s]? of interest|funding|ethics)',
    r'^\s*(abstract|introduction|background|methods?|methodology|results?|'
    r'discussion|conclusion|references?|acknowledgements?|limitations?)\s*[\n:]',
]
_SECTION_RE = re.compile('|'.join(_SECTION_PATTERNS), re.IGNORECASE | re.MULTILINE)


def _detect_sections(text: str) -> list[str]:
    found: list[str] = []
    for m in _SECTION_RE.finditer(text):
        # Extract the actual section name from whichever group matched
        raw = m.group(0).strip().lstrip('#').strip().rstrip(':').strip()
        name = raw.split('\n')[0].strip()
        if name and name.lower() not in [s.lower() for s in found]:
            found.append(name.title())
    return found


# ── Reference extraction ───────────────────────────────────────────────────────

# Numbered refs: [1] or (1) at start of line
_NUMBERED_REF_RE = re.compile(r'^\s*[\[\(](\d+)[\]\)]\s+\S', re.MULTILINE)
# Author-year refs at line start: "Author et al. (2020)"
_AUTHOR_YEAR_RE  = re.compile(r'^\s*[A-Z][a-zA-Z\-]+[,\s].*?\(\d{4}\)', re.MULTILINE)


def _count_references(text: str) -> int:
    # Try numbered first; fall back to author-year
    numbered = _NUMBERED_REF_RE.findall(text)
    if numbered:
        try:
            return max(int(n) for n in numbered)
        except ValueError:
            return len(numbered)
    return len(_AUTHOR_YEAR_RE.findall(text))


# ── .docx extraction ───────────────────────────────────────────────────────────

def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extract plain text from .docx bytes using python-docx."""
    try:
        import docx  # type: ignore
        doc = docx.Document(io.BytesIO(file_bytes))
        return '\n'.join(p.text for p in doc.paragraphs)
    except ImportError:
        raise RuntimeError(
            "python-docx is required for .docx import. Run: pip install python-docx"
        )


# ── AI summarisation ───────────────────────────────────────────────────────────

_SYSTEM = (
    "You are a scientific editor. Your job is to write a concise 3-5 sentence summary "
    "of an academic manuscript that captures: (1) the research question/objective, "
    "(2) the study design and methods, (3) the main findings, and (4) the main conclusion. "
    "Write in the third person, past tense. Do NOT include author names or journal names."
)

_USER_TMPL = (
    "Here is the manuscript text (may be truncated for length):\n\n"
    "---\n{text}\n---\n\n"
    "Write the 3–5 sentence summary now."
)


async def import_manuscript(provider: "AIProvider", text: str) -> dict:
    """
    Parse and summarize a manuscript.

    Returns dict matching ImportManuscriptResult:
      word_count, sections_found, references_found, manuscript_summary
    """
    word_count = len(text.split())
    sections_found = _detect_sections(text)
    references_found = _count_references(text)

    # Truncate to ~6000 words for the AI summary call
    words = text.split()
    truncated = ' '.join(words[:6000]) if len(words) > 6000 else text

    summary = ""
    if provider:
        try:
            summary = await provider.complete(
                system=_SYSTEM,
                user=_USER_TMPL.format(text=truncated),
                temperature=0.15,
            )
        except Exception as exc:
            summary = f"(Summary generation failed: {exc})"

    return {
        "word_count": word_count,
        "sections_found": sections_found,
        "references_found": references_found,
        "manuscript_summary": summary.strip(),
    }
