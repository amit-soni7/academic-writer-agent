"""
services/manuscript_importer.py

Import an existing manuscript (pasted text or .docx bytes) and produce:
  - Section structure (Abstract, Introduction, Methods, …)
  - Reference list count
  - AI-generated manuscript summary (3–5 sentences)
"""

from __future__ import annotations

import io
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from services.ai_provider import AIProvider


# ── Section detection ──────────────────────────────────────────────────────────

# Comprehensive list of academic section/subsection names across article types.
_KNOWN_SECTIONS = (
    # Core sections
    r'abstract|introduction|background|methods?|methodology|results?|'
    r'discussion|conclusions?|references?|bibliography|'
    r'acknowledgements?|limitations?|supplementary|appendix|'
    # Methods subsections
    r'study design|study population|participants?|subjects?|'
    r'materials and methods|materials|data collection|data extraction|'
    r'data analysis|statistical analysis|statistical methods|'
    r'measures?|instruments?|procedures?|interventions?|'
    r'outcomes?|primary outcomes?|secondary outcomes?|'
    r'sample size|randomi[sz]ation|blinding|allocation|'
    r'inclusion criteria|exclusion criteria|eligibility(?: criteria)?|'
    r'search strategy|information sources|study selection|'
    r'risk of bias|quality assessment|sensitivity analysis|'
    r'subgroup analysis|data synthesis|'
    # Results subsections
    r'baseline characteristics|demographics?|study characteristics|'
    r'main findings|synthesis of results|quantitative synthesis|'
    # Discussion subsections
    r'strengths and limitations|strengths|'
    r'clinical implications|implications|recommendations|'
    r'future research|future directions|'
    # Front/back matter
    r'declarations?|author contributions?|data availability|'
    r'competing interests?|conflicts? of interest|'
    r'trial registration|ethics|ethical (?:approval|considerations|statement)|'
    r'informed consent|patient consent|compliance with ethical standards|'
    r'funding|financial support|'
    # Review-specific
    r'literature review|theoretical framework|conceptual framework|'
    r'research questions?|hypothes[ie]s|'
    r'protocol|search results|screening|data (?:charting|coding)|'
    r'meta-analysis|meta-regression|prisma|'
    # Case report
    r'case presentation|case description|patient information|'
    r'clinical findings|timeline|therapeutic intervention|follow-up|'
    # Protocol-specific
    r'trial design|study setting|recruitment|'
    r'oversight and monitoring|dissemination|trial status|'
    r'administrative information'
)

_SECTION_PATTERNS = [
    # 1. Markdown headers: # Abstract, ## Study Design, etc.
    rf'^\s*#+\s*({_KNOWN_SECTIONS})',
    # 2. Plain text followed by colon or end-of-line
    rf'^\s*({_KNOWN_SECTIONS})\s*[:\n]',
]
_SECTION_RE = re.compile('|'.join(_SECTION_PATTERNS), re.IGNORECASE | re.MULTILINE)

# ALL-CAPS pattern compiled separately (no IGNORECASE — must be genuinely uppercase)
_ALLCAPS_RE = re.compile(r'^\s*([A-Z][A-Z\s&\-]{2,})\s*$')


def detect_sections_with_ranges(text: str) -> list[dict]:
    """Detect manuscript sections and return their line ranges.

    Returns a list of dicts: [{name, start_line, end_line}] where
    start_line/end_line are 1-based line numbers.
    """
    lines = text.splitlines()
    sections: list[dict] = []
    seen_lower: set[str] = set()

    for i, line in enumerate(lines, start=1):
        m = _SECTION_RE.match(line)
        is_allcaps = False

        if not m:
            # Try ALL-CAPS pattern (separate regex, case-sensitive)
            m = _ALLCAPS_RE.match(line)
            if not m:
                continue
            is_allcaps = True

        raw = m.group(0).strip().lstrip('#').strip().rstrip(':').strip()
        name = raw.split('\n')[0].strip()

        # ALL-CAPS validation: only accept if it matches a known section name
        if is_allcaps:
            if len(name) > 80 or len(name) < 3:
                continue
            if re.search(r'\d', name):
                continue
            if not re.match(rf'^(?:{_KNOWN_SECTIONS})$', name, re.IGNORECASE):
                continue

        name = name.title()
        if not name or name.lower() in seen_lower:
            continue
        seen_lower.add(name.lower())

        # Close previous section
        if sections:
            sections[-1]["end_line"] = i - 1
        sections.append({"name": name, "start_line": i, "end_line": len(lines)})

    # Close last section
    if sections:
        sections[-1]["end_line"] = len(lines)

    return sections


def _detect_sections(text: str) -> list[str]:
    return [s["name"] for s in detect_sections_with_ranges(text)]


# ── Reference extraction ───────────────────────────────────────────────────────

# Numbered refs: [1] or (1) at start of line
_NUMBERED_REF_RE = re.compile(r'^\s*[\[\(](\d+)[\]\)]\s+\S', re.MULTILINE)
# N. Author... style (Vancouver — common with Zotero/EndNote)
_DOT_NUMBERED_RE = re.compile(r'^\s*(\d+)\.\s+[A-Z]', re.MULTILINE)
# Author-year refs at line start: "Author et al. (2020)" — APA/Harvard (Zotero/Mendeley)
_AUTHOR_YEAR_RE = re.compile(r'^\s*[A-Z][a-zA-Z\-]+[,\s].*?\(\d{4}\)', re.MULTILINE)
# DOI anywhere in text (all reference managers include DOIs when available)
_DOI_RE = re.compile(r'(?:doi|DOI|https?://doi\.org)[:/]\s*10\.\d{4,}')


def _extract_references_section(text: str) -> str:
    """Extract text from the References/Bibliography section to end of document."""
    m = re.search(
        r'^(?:\s*#+\s*)?(?:references?|bibliography|works cited|literature cited)\s*[:\n]?\s*$',
        text, re.IGNORECASE | re.MULTILINE,
    )
    if m:
        return text[m.end():]
    return ""


def _count_references(text: str) -> int:
    """Count references using multiple strategies.

    Handles Zotero, EndNote, and Mendeley bibliography formats:
    Vancouver [N], N. Author, APA author-year, and paragraph-counting fallback.
    """
    # 1. Find the references section boundary
    ref_text = _extract_references_section(text)
    found_ref_section = bool(ref_text)
    if not ref_text:
        ref_text = text  # fallback: scan entire document

    # 2. Try numbered patterns (most reliable → least)
    for pattern in [_NUMBERED_REF_RE, _DOT_NUMBERED_RE]:
        nums = pattern.findall(ref_text)
        if len(nums) >= 2:  # need at least 2 to be confident
            try:
                return max(int(n) for n in nums)
            except ValueError:
                return len(nums)

    # 3. Try author-year (APA/Harvard — Zotero/Mendeley/EndNote)
    ay = _AUTHOR_YEAR_RE.findall(ref_text)
    if len(ay) >= 2:
        return len(ay)

    # 4. Paragraph counting — best universal fallback for Zotero/EndNote/Mendeley
    #    These tools always produce one paragraph per reference entry.
    #    Only use this within a confirmed references section (not full doc).
    if found_ref_section:
        paras = [p.strip() for p in ref_text.split('\n') if len(p.strip()) > 30]
        if paras:
            return len(paras)

    # 5. DOI count as last resort (works for any format that includes DOIs)
    scan_text = ref_text if found_ref_section else text
    dois = _DOI_RE.findall(scan_text)
    if dois:
        return len(dois)

    return 0


# ── .docx extraction ───────────────────────────────────────────────────────────

def _docx_heading_level(p_elem, qn_func) -> int:
    """Return heading level (1-6) from a paragraph's Word style, or 0."""
    pPr = p_elem.find(qn_func('w:pPr'))
    if pPr is not None:
        pStyle = pPr.find(qn_func('w:pStyle'))
        if pStyle is not None:
            val = pStyle.get(qn_func('w:val'), '')
            m = re.match(r'^Heading(\d)$', val)
            if m:
                return int(m.group(1))
    return 0


def _is_bold_short_line(p_elem, qn_func, text: str) -> bool:
    """True if all runs are bold and text is short — likely a heading."""
    if len(text) > 80 or text.rstrip().endswith('.'):
        return False
    runs = p_elem.findall(qn_func('w:r'))
    if not runs:
        return False
    for r in runs:
        # Skip runs with no visible text
        has_text = any((t.text or '').strip() for t in r.findall(qn_func('w:t')))
        if not has_text:
            continue
        rPr = r.find(qn_func('w:rPr'))
        if rPr is None or rPr.find(qn_func('w:b')) is None:
            return False
    return True


def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extract text from .docx bytes, preserving tables and heading structure.

    - Iterates the XML body in document order (paragraphs + tables interleaved)
    - Detects heading styles (Heading1, Heading2, …) → prefixes with #
    - Detects bold-only short lines → prefixes with ## (subsection heuristic)
    - Extracts table content row-by-row (pipe-delimited cells)
    """
    try:
        import docx  # type: ignore
        from docx.oxml.ns import qn
    except ImportError:
        raise RuntimeError(
            "python-docx is required for .docx import. Run: pip install python-docx"
        )

    doc = docx.Document(io.BytesIO(file_bytes))
    lines: list[str] = []

    for child in doc.element.body:
        tag = child.tag

        if tag == qn('w:p'):
            # Extract paragraph text from all w:t nodes
            text = ''.join(node.text or '' for node in child.iter(qn('w:t')))
            if not text.strip():
                lines.append('')
                continue

            # Detect heading style → prefix with #
            heading_level = _docx_heading_level(child, qn)
            if heading_level:
                text = '#' * heading_level + ' ' + text
            elif _is_bold_short_line(child, qn, text):
                text = '## ' + text  # Bold short line → treat as subsection

            lines.append(text)

        elif tag == qn('w:tbl'):
            # Extract table rows — each row becomes a pipe-delimited line
            for tr in child.iter(qn('w:tr')):
                cells: list[str] = []
                for tc in tr.findall(qn('w:tc')):
                    cell_text = ' '.join(
                        node.text or '' for node in tc.iter(qn('w:t'))
                    ).strip()
                    cells.append(cell_text)
                if any(cells):
                    lines.append(' | '.join(cells))
            lines.append('')  # blank line after table

    return '\n'.join(lines)


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
      word_count, sections_found, references_found, manuscript_summary, section_index
    """
    word_count = len(text.split())
    section_index = detect_sections_with_ranges(text)
    sections_found = [s["name"] for s in section_index]
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
        "section_index": section_index,
    }
