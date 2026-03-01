"""
pdf_extractor.py

Downloads a document from a URL and extracts plain text.
Handles both:
  - PDF  → pdfplumber
  - HTML → built-in html.parser (no extra dependencies)

Used to feed full-paper content into the LLM summariser.
"""

import io
import logging
import re
from html.parser import HTMLParser
from typing import Optional

import httpx
import pdfplumber

logger = logging.getLogger(__name__)

_TIMEOUT          = httpx.Timeout(45.0, connect=10.0)
_HEADERS          = {"User-Agent": "AcademicWriterAgent/0.2 (academic-writer-agent@localhost.dev)"}
_MAX_PAGES_DEFAULT = 30
_MAX_HTML_CHARS    = 80_000   # ~20 000 words — cap HTML extraction before sending to LLM


# ── HTML → plain text ─────────────────────────────────────────────────────────

class _TextExtractor(HTMLParser):
    """
    Minimal, dependency-free HTML → plain text converter.

    Skips script/style/nav/header/footer content entirely.
    Adds newlines around block-level elements so paragraphs stay readable.
    """

    _SKIP_TAGS  = {"script", "style", "nav", "header", "footer",
                   "noscript", "aside", "figure", "figcaption"}
    _BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
                   "li", "br", "tr", "td", "th", "section", "article",
                   "blockquote", "pre"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth: int  = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            if self._skip_depth > 0:
                self._skip_depth -= 1
        elif tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth == 0:
            stripped = data.strip()
            if stripped:
                self._parts.append(stripped + " ")

    def get_text(self) -> str:
        text = "".join(self._parts)
        # Collapse runs of blank lines
        return re.sub(r"\n{3,}", "\n\n", text).strip()


def _html_to_text(html_bytes: bytes) -> Optional[str]:
    """Convert HTML bytes to plain text. Returns None if result is too short to be useful."""
    try:
        try:
            html_str = html_bytes.decode("utf-8")
        except UnicodeDecodeError:
            html_str = html_bytes.decode("latin-1", errors="replace")

        parser = _TextExtractor()
        parser.feed(html_str)
        text = parser.get_text()
        # Must be at least 200 chars to be considered real content
        return text[:_MAX_HTML_CHARS] if len(text) >= 200 else None
    except Exception as exc:
        logger.warning("HTML text extraction error: %s", exc)
        return None


# ── PDF → plain text ──────────────────────────────────────────────────────────

def _bytes_to_text(pdf_bytes: bytes, max_pages: int) -> Optional[str]:
    try:
        buf = io.BytesIO(pdf_bytes)
        parts: list[str] = []
        with pdfplumber.open(buf) as pdf:
            for page in pdf.pages[:max_pages]:
                text = page.extract_text(x_tolerance=2, y_tolerance=2)
                if text and text.strip():
                    parts.append(text.strip())
        return "\n\n".join(parts) if parts else None
    except Exception as exc:
        logger.warning("pdfplumber error: %s", exc)
        return None


# ── Main public function ──────────────────────────────────────────────────────

async def extract_text_from_url(
    url: str,
    max_pages: int = _MAX_PAGES_DEFAULT,
) -> Optional[str]:
    """
    Fetch a document from *url* and return its plain text.

    Supports:
      • PDF  (application/pdf or magic bytes %PDF) → pdfplumber
      • HTML (text/html)                           → _TextExtractor

    Returns None if download or text extraction fails.
    """
    try:
        async with httpx.AsyncClient(
            headers=_HEADERS,
            timeout=_TIMEOUT,
            follow_redirects=True,
        ) as client:
            r = await client.get(url)
            r.raise_for_status()

            content_type = r.headers.get("content-type", "").lower()

            # ── HTML full text ────────────────────────────────────────────────
            if "html" in content_type:
                text = _html_to_text(r.content)
                if text:
                    logger.debug("Extracted HTML text (%d chars) from %s", len(text), url)
                    return text
                logger.debug("HTML extraction produced no useful text for %s", url)
                return None

            # ── PDF ───────────────────────────────────────────────────────────
            # Accept both declared PDFs and files whose magic bytes start with %PDF
            is_pdf = (
                "pdf" in content_type
                or url.lower().endswith(".pdf")
                or r.content[:4] == b"%PDF"
            )
            if is_pdf:
                text = _bytes_to_text(r.content, max_pages=max_pages)
                if text:
                    logger.debug("Extracted PDF text (%d chars) from %s", len(text), url)
                return text

            # ── Unknown content type — attempt PDF first, then HTML ───────────
            text = _bytes_to_text(r.content, max_pages=max_pages)
            if text:
                return text
            return _html_to_text(r.content)

    except httpx.HTTPStatusError as exc:
        logger.warning("HTTP %s fetching document: %s", exc.response.status_code, url)
    except Exception as exc:
        logger.warning("Document extraction failed for %s: %s", url, exc)

    return None
