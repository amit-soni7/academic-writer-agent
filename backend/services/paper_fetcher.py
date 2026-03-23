"""
paper_fetcher.py

Retrieves the best available text for a paper in priority order:
  1. PubMed Central full-text XML  (free, structured JATS)
  2. Open-Access URL via oa_pdf_url — PDF or HTML (Unpaywall / OpenAlex)
  3. PMC HTML full-text page        (fallback when XML parse fails)
  4. Institutional PDF via DOI      (ONOS / EZproxy / Shibboleth networks)
  5. Sci-Hub                        (if enabled in FetchSettings)
  6. Abstract only                  (always available)

Returns (text: str, source_label: str) where source_label is one of:
  "pmc_xml" | "full_pdf" | "full_html" | "abstract_only" | "none"
"""

import logging
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

import httpx

from models import Paper
from services.pdf_extractor import extract_text_from_url


_DEFAULT_SCIHUB_MIRRORS = ["https://sci-hub.su", "https://www.sci-hub.ren"]


@dataclass
class FetchSettings:
    """User preferences for full-text fetching and PDF persistence."""
    pdf_save_enabled: bool = False
    pdf_save_path: Optional[str] = None   # legacy fallback when no project folder is available
    project_folder: Optional[str] = None  # canonical project artifact root
    sci_hub_enabled: bool = False
    http_proxy: Optional[str] = None
    scihub_mirrors: list = field(default_factory=lambda: list(_DEFAULT_SCIHUB_MIRRORS))

def _effective_save_path(fs: "FetchSettings") -> Optional[str]:
    """Return the effective PDF save path.

    Project-bound work always saves to project_folder/full_papers.
    pdf_save_path is retained only as a legacy fallback when no project folder exists.
    """
    if fs.project_folder:
        return os.path.join(fs.project_folder, "full_papers")
    if fs.pdf_save_path:
        return fs.pdf_save_path
    return None


logger = logging.getLogger(__name__)

NCBI_BASE    = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PMC_HTML_BASE = "https://pmc.ncbi.nlm.nih.gov/articles"
NCBI_IDCONV  = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
UNPAYWALL_BASE = "https://api.unpaywall.org/v2"
UNPAYWALL_EMAIL = "academic-writer@localhost.dev"   # polite pool email
TIMEOUT      = httpx.Timeout(45.0, connect=10.0)
HEADERS      = {"User-Agent": "AcademicWriterAgent/0.2 (academic-writer-agent@localhost.dev)"}
MAX_CHARS    = 32_000   # ~8 000 words — enough for summarisation, fits any LLM context
_ELLIPSIS_MARKER = "\n\n[… section-balanced truncation for summarisation …]"
_OMIT_MARKER = "\n\n[… intermediate sections omitted …]\n\n"


async def fetch_full_text(
    paper: Paper,
    fetch_settings: Optional[FetchSettings] = None,
) -> tuple[str, str]:
    """
    Return (text_content, source_label).

    Priority order:
      1. PubMed Central full-text XML  — via stored PMCID
      1b. PMC XML via DOI→PMCID lookup — corrects wrong/missing PMCIDs
      2. OA URL via oa_pdf_url         — PDF or HTML (Unpaywall / OpenAlex)
      3. PMC HTML page                 — when XML body is absent (JMIR, Frontiers)
      4. Institutional PDF via DOI     — ONOS / EZproxy / Shibboleth
      5. Sci-Hub                       — if fetch_settings.sci_hub_enabled
      6. Abstract fallback             — always available

    Truncates to MAX_CHARS for LLM token budgets.
    When fetch_settings.pdf_save_enabled, saves downloaded PDFs to disk.
    """
    fs = fetch_settings or FetchSettings()
    _save_path = _effective_save_path(fs)

    # 1. PMC XML — richest source, structured JATS with section headings
    if paper.pmcid:
        text = await _fetch_pmc_xml_text(paper.pmcid)
        if text:
            if fs.pdf_save_enabled and _save_path:
                saved = await _maybe_save_pmc_pdf(paper.pmcid, _save_path, paper)
                if not saved:
                    # PMC PDF unavailable — save the extracted text instead
                    _save_text_to_disk(text, _save_path, paper)
            logger.debug("Full text via PMC XML: %s", paper.pmcid)
            return _truncate(text), "pmc_xml"

    # 1b. If stored PMCID is wrong/missing and we have a DOI, look up the
    #     correct PMCID via NCBI's ID Converter and retry.
    if paper.doi:
        resolved_pmcid = await _lookup_pmcid_from_doi(paper.doi)
        if resolved_pmcid and resolved_pmcid != paper.pmcid:
            logger.debug(
                "Resolved PMCID %s for DOI %s (stored was %s)",
                resolved_pmcid, paper.doi, paper.pmcid,
            )
            text = await _fetch_pmc_xml_text(resolved_pmcid)
            if text:
                if fs.pdf_save_enabled and _save_path:
                    saved = await _maybe_save_pmc_pdf(resolved_pmcid, _save_path, paper)
                    if not saved:
                        _save_text_to_disk(text, _save_path, paper)
                return _truncate(text), "pmc_xml"
            # No XML body — try HTML for this resolved PMCID
            text = await _fetch_pmc_html_text(resolved_pmcid)
            if text:
                if fs.pdf_save_enabled and _save_path:
                    saved = await _maybe_save_pmc_pdf(resolved_pmcid, _save_path, paper)
                    if not saved:
                        _save_text_to_disk(text, _save_path, paper)
                return _truncate(text), "full_html"

    # 2. OA URL (PDF or HTML) — from Unpaywall / OpenAlex / Semantic Scholar
    #    extract_text_from_url handles both PDF and HTML transparently.
    if paper.oa_pdf_url:
        pdf_bytes, text = await _fetch_url_with_bytes(paper.oa_pdf_url)
        if text:
            logger.debug("Full text via OA URL (%d chars): %s", len(text), paper.oa_pdf_url)
            if fs.pdf_save_enabled and _save_path:
                if pdf_bytes:
                    _save_pdf_to_disk(pdf_bytes, _save_path, paper)
                else:
                    # HTML content — save as text file
                    _save_text_to_disk(text, _save_path, paper)
            return _truncate(text), "full_pdf"
        else:
            logger.debug("OA URL returned no usable text: %s", paper.oa_pdf_url)

    # 2b. Unpaywall live query — catches papers where oa_pdf_url was missing/stale.
    #     Queries Unpaywall's API and tries every url_for_pdf across all OA locations.
    if paper.doi:
        pdf_bytes, text = await _fetch_unpaywall_pdf(paper.doi)
        if text:
            logger.debug("Full text via Unpaywall (%d chars): DOI %s", len(text), paper.doi)
            if fs.pdf_save_enabled and _save_path:
                if pdf_bytes:
                    _save_pdf_to_disk(pdf_bytes, _save_path, paper)
                else:
                    _save_text_to_disk(text, _save_path, paper)
            return _truncate(text), "full_pdf"

    # 3. PMC HTML page — fallback when the JATS XML has no <body>.
    if paper.pmcid:
        text = await _fetch_pmc_html_text(paper.pmcid)
        if text:
            if fs.pdf_save_enabled and _save_path:
                saved = await _maybe_save_pmc_pdf(paper.pmcid, _save_path, paper)
                if not saved:
                    _save_text_to_disk(text, _save_path, paper)
            logger.debug("Full text via PMC HTML page: %s", paper.pmcid)
            return _truncate(text), "full_html"

    # 4. Institutional PDF via DOI.
    if paper.doi:
        pdf_bytes, text = await _fetch_via_doi_with_bytes(paper.doi)
        if text:
            logger.debug("Full text via DOI PDF redirect: %s", paper.doi)
            if pdf_bytes and fs.pdf_save_enabled and _save_path:
                _save_pdf_to_disk(pdf_bytes, _save_path, paper)
            return _truncate(text), "full_pdf"

    # 5. Sci-Hub — last resort before abstract fallback
    if fs.sci_hub_enabled and paper.doi:
        try:
            from services.scihub_fetcher import fetch_pdf_via_scihub
            from services.pdf_extractor import _bytes_to_text as _b2t
            pdf_bytes = await fetch_pdf_via_scihub(paper.doi, proxy=fs.http_proxy, mirrors=fs.scihub_mirrors or None)
            if pdf_bytes:
                text = _b2t(pdf_bytes, max_pages=30)
                if text:
                    logger.debug("Full text via Sci-Hub: %s", paper.doi)
                    if fs.pdf_save_enabled and _save_path:
                        _save_pdf_to_disk(pdf_bytes, _save_path, paper)
                    return _truncate(text), "full_pdf"
        except Exception as exc:
            logger.debug("Sci-Hub fetch failed for %s: %s", paper.doi, exc)

    # 6. Abstract fallback
    if paper.abstract:
        logger.debug("Falling back to abstract for: %s", paper.title[:60])
        if fs.pdf_save_enabled and _save_path:
            _save_text_to_disk(paper.abstract.strip(), _save_path, paper)
        return paper.abstract.strip(), "abstract_only"

    return "", "none"


# ── PDF save to disk ──────────────────────────────────────────────────────────

def _sanitize(s: str, max_len: int = 30) -> str:
    """Replace non-alphanumeric chars with underscores and truncate."""
    s = re.sub(r"[^\w]", "_", s or "")
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:max_len]


def _pdf_filename(paper: Paper) -> str:
    """Return the deterministic filename used for saved full-text PDFs."""
    first_author = _sanitize(paper.authors[0].split(",")[0] if paper.authors else "Unknown", 20)
    year = str(paper.year or "XXXX")
    journal = _sanitize(paper.journal or "Unknown", 20)
    title_words = _sanitize(" ".join(paper.title.split()[:6]), 40)
    return f"{first_author}_{year}_{journal}_{title_words}.pdf"


def saved_pdf_path_for_paper(paper: Paper, fetch_settings: Optional[FetchSettings] = None) -> Optional[str]:
    """Return the expected saved PDF path for this paper, if a save directory exists."""
    fs = fetch_settings or FetchSettings()
    save_path = _effective_save_path(fs)
    if not save_path:
        return None
    return os.path.join(save_path, _pdf_filename(paper))


def _save_pdf_to_disk(pdf_bytes: bytes, save_path: str, paper: Paper) -> Optional[str]:
    """
    Save *pdf_bytes* to *save_path* with a descriptive filename.

    Filename: {FirstAuthor}_{Year}_{JournalAbbrev}_{TitleWords}.pdf
    Returns the saved file path or None on error.
    """
    try:
        os.makedirs(save_path, exist_ok=True)
        filename = _pdf_filename(paper)
        filepath = os.path.join(save_path, filename)
        with open(filepath, "wb") as f:
            f.write(pdf_bytes)
        logger.debug("PDF saved: %s", filepath)
        return filepath
    except Exception as exc:
        logger.warning("Failed to save PDF for %r: %s", paper.title[:40], exc)
        return None


def _txt_filename(paper: Paper) -> str:
    """Return the deterministic filename used for saved text/abstract files."""
    first_author = _sanitize(paper.authors[0].split(",")[0] if paper.authors else "Unknown", 20)
    year = str(paper.year or "XXXX")
    journal = _sanitize(paper.journal or "Unknown", 20)
    title_words = _sanitize(" ".join(paper.title.split()[:6]), 40)
    return f"{first_author}_{year}_{journal}_{title_words}.txt"


def _save_text_to_disk(text: str, save_path: str, paper: Paper) -> Optional[str]:
    """
    Save *text* as a UTF-8 .txt file when no PDF is available.

    Used as a fallback for abstract-only papers and PMC articles where the PDF
    is restricted, so that file count in full_papers/ matches summary count.
    Skips silently if the file already exists.
    Returns the saved file path or None on error.
    """
    try:
        os.makedirs(save_path, exist_ok=True)
        filename = _txt_filename(paper)
        filepath = os.path.join(save_path, filename)
        if os.path.exists(filepath):
            return filepath
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(text)
        logger.debug("Text saved: %s", filepath)
        return filepath
    except Exception as exc:
        logger.warning("Failed to save text for %r: %s", paper.title[:40], exc)
        return None


async def _maybe_save_pmc_pdf(pmcid: str, save_path: str, paper: Paper) -> Optional[str]:
    """Best-effort PMC PDF download for users who enabled PDF saving."""
    try:
        pdf_bytes = await _fetch_pmc_pdf_bytes(pmcid)
        if pdf_bytes:
            return _save_pdf_to_disk(pdf_bytes, save_path, paper)
    except Exception as exc:
        logger.debug("PMC PDF save skipped for %s: %s", pmcid, exc)
    return None


async def ensure_saved_pdf(
    paper: Paper,
    fetch_settings: Optional[FetchSettings] = None,
) -> Optional[str]:
    """
    Return a readable PDF path for *paper*, downloading/saving it when possible.

    If a saved file already exists it is reused. Otherwise the fetcher tries the same
    PDF-capable channels used during summarisation and saves the bytes to disk.
    """
    fs = fetch_settings or FetchSettings()
    save_path = _effective_save_path(fs)
    if not save_path:
        return None

    expected_path = saved_pdf_path_for_paper(paper, fs)
    if expected_path and os.path.exists(expected_path):
        return expected_path

    if paper.pmcid:
        saved = await _maybe_save_pmc_pdf(paper.pmcid, save_path, paper)
        if saved and os.path.exists(saved):
            return saved

    if paper.doi:
        resolved_pmcid = await _lookup_pmcid_from_doi(paper.doi)
        if resolved_pmcid and resolved_pmcid != paper.pmcid:
            saved = await _maybe_save_pmc_pdf(resolved_pmcid, save_path, paper)
            if saved and os.path.exists(saved):
                return saved

    if paper.oa_pdf_url:
        pdf_bytes, _text = await _fetch_url_with_bytes(paper.oa_pdf_url)
        if pdf_bytes:
            saved = _save_pdf_to_disk(pdf_bytes, save_path, paper)
            if saved and os.path.exists(saved):
                return saved

    # Unpaywall live query — tries all OA pdf locations
    if paper.doi:
        pdf_bytes, text = await _fetch_unpaywall_pdf(paper.doi)
        if pdf_bytes:
            saved = _save_pdf_to_disk(pdf_bytes, save_path, paper)
            if saved and os.path.exists(saved):
                return saved
        elif text:
            saved = _save_text_to_disk(text, save_path, paper)
            if saved and os.path.exists(saved):
                return saved

    if paper.doi:
        pdf_bytes, _text = await _fetch_via_doi_with_bytes(paper.doi)
        if pdf_bytes:
            saved = _save_pdf_to_disk(pdf_bytes, save_path, paper)
            if saved and os.path.exists(saved):
                return saved

    if fs.sci_hub_enabled and paper.doi:
        try:
            from services.scihub_fetcher import fetch_pdf_via_scihub

            pdf_bytes = await fetch_pdf_via_scihub(paper.doi, proxy=fs.http_proxy, mirrors=fs.scihub_mirrors or None)
            if pdf_bytes:
                saved = _save_pdf_to_disk(pdf_bytes, save_path, paper)
                if saved and os.path.exists(saved):
                    return saved
        except Exception as exc:
            logger.debug("Sci-Hub PDF save failed for %s: %s", paper.doi, exc)

    if expected_path and os.path.exists(expected_path):
        return expected_path
    return None


# ── URL fetch returning (bytes_if_pdf, text) ─────────────────────────────────

async def _fetch_url_with_bytes(url: str) -> tuple[Optional[bytes], Optional[str]]:
    """
    Fetch *url*, returning (raw_bytes_if_pdf, extracted_text).
    raw_bytes is only set when the document is a PDF (useful for saving).
    """
    from services.pdf_extractor import _bytes_to_text, _html_to_text
    try:
        async with httpx.AsyncClient(
            headers=HEADERS,
            timeout=TIMEOUT,
            follow_redirects=True,
        ) as client:
            r = await client.get(url)
            r.raise_for_status()
            content_type = r.headers.get("content-type", "").lower()

            if "html" in content_type:
                text = _html_to_text(r.content)
                return None, text

            is_pdf = "pdf" in content_type or url.lower().endswith(".pdf") or r.content[:4] == b"%PDF"
            if is_pdf:
                text = _bytes_to_text(r.content, max_pages=30)
                return r.content, text

            # Unknown — try PDF then HTML
            text = _bytes_to_text(r.content, max_pages=30)
            if text:
                return r.content, text
            return None, _html_to_text(r.content)
    except Exception as exc:
        logger.debug("URL fetch failed for %s: %s", url, exc)
        return None, None


# ── NCBI ID Converter (DOI → PMCID) ──────────────────────────────────────────

async def _lookup_pmcid_from_doi(doi: str) -> Optional[str]:
    """
    Use NCBI's ID Converter API to find the correct PMC ID for a given DOI.

    This corrects situations where the stored PMCID is wrong (from Semantic Scholar
    or other sources that sometimes cache stale identifiers).
    Returns "PMCxxxxxx" string or None.
    """
    try:
        async with httpx.AsyncClient(
            headers=HEADERS,
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        ) as client:
            r = await client.get(
                NCBI_IDCONV,
                params={"ids": doi, "format": "json", "tool": "academic-writer-agent"},
            )
            r.raise_for_status()
            records = r.json().get("records", [])
            if records:
                pmcid = records[0].get("pmcid")
                if pmcid:
                    # Normalise to "PMCxxxxxx" format
                    return pmcid if pmcid.startswith("PMC") else f"PMC{pmcid}"
    except Exception as exc:
        logger.debug("PMCID lookup failed for DOI %s: %s", doi, exc)
    return None


# ── Unpaywall ─────────────────────────────────────────────────────────────────

async def _fetch_unpaywall_pdf(doi: str) -> tuple[Optional[bytes], Optional[str]]:
    """
    Query Unpaywall for all open-access PDF locations and try each in order.

    Returns (pdf_bytes_or_None, text_or_None).  Tries every url_for_pdf across
    all oa_locations (not just best_oa_location) to maximise hit rate.
    """
    try:
        async with httpx.AsyncClient(headers=HEADERS, timeout=httpx.Timeout(12.0, connect=6.0)) as client:
            r = await client.get(f"{UNPAYWALL_BASE}/{doi}", params={"email": UNPAYWALL_EMAIL})
            if r.status_code != 200:
                return None, None
            data = r.json()
            if not data.get("is_oa"):
                return None, None

            # Collect all url_for_pdf values across all OA locations, deduped
            pdf_urls: list[str] = []
            seen: set[str] = set()
            for loc in data.get("oa_locations", []):
                url = loc.get("url_for_pdf")
                if url and url not in seen:
                    pdf_urls.append(url)
                    seen.add(url)

            if not pdf_urls:
                return None, None

            # Try each URL until we get a real PDF
            for pdf_url in pdf_urls:
                try:
                    bytes_, text = await _fetch_url_with_bytes(pdf_url)
                    if text:
                        logger.debug("Unpaywall PDF fetched from %s", pdf_url)
                        return bytes_, text
                except Exception:
                    continue

    except Exception as exc:
        logger.debug("Unpaywall query failed for DOI %s: %s", doi, exc)
    return None, None


# ── PMC XML ───────────────────────────────────────────────────────────────────

async def _fetch_pmc_xml_text(pmcid: str) -> Optional[str]:
    """Fetch JATS full-text XML from PMC efetch and extract body prose."""
    id_num = pmcid.replace("PMC", "").strip()
    if not id_num.isdigit():
        return None
    try:
        async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
            r = await client.get(
                f"{NCBI_BASE}/efetch.fcgi",
                params={"db": "pmc", "id": id_num, "rettype": "xml", "retmode": "xml"},
            )
            r.raise_for_status()
        body_text = _extract_jats_body(r.text)
        if not body_text:
            logger.debug("PMC XML for %s has no <body> element — will try HTML fallback", pmcid)
        return body_text
    except Exception as exc:
        logger.debug("PMC XML fetch failed for %s: %s", pmcid, exc)
        return None


def _extract_jats_body(xml_text: str) -> Optional[str]:
    """
    Parse JATS XML and extract body text with section headings.
    Returns None if no <body> element is found.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    body = root.find(".//body")
    if body is None:
        return None

    parts: list[str] = []

    def _walk(el: ET.Element, depth: int = 0) -> None:
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag

        if tag == "sec":
            title_el = el.find("title")
            if title_el is not None:
                heading = "".join(title_el.itertext()).strip()
                if heading:
                    parts.append(f"{'#' * (depth + 1)} {heading}")
            for child in el:
                _walk(child, depth + 1)

        elif tag == "p":
            text = "".join(el.itertext()).strip()
            if text:
                parts.append(text)

        else:
            for child in el:
                _walk(child, depth)

    _walk(body)
    return "\n\n".join(p for p in parts if p.strip()) or None


# ── PMC HTML fallback ─────────────────────────────────────────────────────────

async def _fetch_pmc_html_text(pmcid: str) -> Optional[str]:
    """
    Fetch the PMC article HTML page and extract readable text.

    Used when the JATS XML is available but has no <body> (some articles,
    especially JMIR/Frontiers, render only metadata in the efetch XML but have
    full HTML available at the PMC web page).
    """
    id_num = pmcid.replace("PMC", "").strip()
    if not id_num.isdigit():
        return None
    url = f"{PMC_HTML_BASE}/PMC{id_num}/"
    try:
        async with httpx.AsyncClient(
            headers={**HEADERS, "Accept": "text/html"},
            timeout=TIMEOUT,
            follow_redirects=True,
        ) as client:
            r = await client.get(url)
            r.raise_for_status()
            ctype = r.headers.get("content-type", "").lower()
            if "html" not in ctype:
                return None
        from services.pdf_extractor import _html_to_text
        return _html_to_text(r.content)
    except Exception as exc:
        logger.debug("PMC HTML fetch failed for %s: %s", pmcid, exc)
        return None


async def _fetch_pmc_pdf_bytes(pmcid: str) -> Optional[bytes]:
    """
    Fetch the PMC article PDF bytes, if available.

    Tries the canonical /pdf/ endpoint first (often redirects to the real file),
    then falls back to scraping a PDF link from the article HTML.
    """
    id_num = pmcid.replace("PMC", "").strip()
    if not id_num.isdigit():
        return None

    base_article = f"{PMC_HTML_BASE}/PMC{id_num}/"
    pdf_entry = f"{base_article}pdf/"

    try:
        async with httpx.AsyncClient(
            headers={**HEADERS, "Accept": "application/pdf, text/html;q=0.9, */*;q=0.8"},
            timeout=TIMEOUT,
            follow_redirects=True,
        ) as client:
            r = await client.get(pdf_entry)
            ctype = r.headers.get("content-type", "").lower()
            if r.status_code < 400 and ("pdf" in ctype or r.content[:4] == b"%PDF"):
                return r.content

            # Some PMC pages return HTML for /pdf/; parse the actual PDF link.
            html = r.text if "html" in ctype else ""
            if not html:
                page = await client.get(base_article)
                page.raise_for_status()
                if "html" in page.headers.get("content-type", "").lower():
                    html = page.text

            if html:
                # Common PMC link shape: /articles/PMC1234567/pdf/<name>.pdf
                m = re.search(
                    rf'href=[\'"](?P<href>/articles/PMC{id_num}/pdf/[^\'"]+\.pdf[^\'"]*)[\'"]',
                    html,
                    flags=re.IGNORECASE,
                )
                if m:
                    href = m.group("href")
                    pdf_url = f"https://pmc.ncbi.nlm.nih.gov{href}"
                    pdf_resp = await client.get(pdf_url)
                    ctype2 = pdf_resp.headers.get("content-type", "").lower()
                    if pdf_resp.status_code < 400 and ("pdf" in ctype2 or pdf_resp.content[:4] == b"%PDF"):
                        return pdf_resp.content
    except Exception as exc:
        logger.debug("PMC PDF fetch failed for %s: %s", pmcid, exc)
    return None


# ── DOI-based institutional PDF ───────────────────────────────────────────────

async def _fetch_via_doi_with_bytes(doi: str) -> tuple[Optional[bytes], Optional[str]]:
    """Like _fetch_via_doi but also returns raw PDF bytes for optional saving."""
    from services.pdf_extractor import _bytes_to_text
    doi_url = f"https://doi.org/{doi}"
    try:
        async with httpx.AsyncClient(
            headers={**HEADERS, "Accept": "application/pdf, */*"},
            timeout=httpx.Timeout(20.0, connect=8.0),
            follow_redirects=True,
        ) as client:
            try:
                head      = await client.head(doi_url)
                final_url = str(head.url)
                ctype_h   = head.headers.get("content-type", "").lower()
            except Exception:
                final_url = doi_url
                ctype_h   = ""

            is_pdf = "pdf" in ctype_h or final_url.lower().endswith(".pdf")
            if not is_pdf:
                try:
                    probe  = await client.get(final_url, headers={**HEADERS, "Range": "bytes=0-4"})
                    is_pdf = probe.content[:4] == b"%PDF"
                except Exception:
                    pass

            if is_pdf:
                r = await client.get(final_url)
                r.raise_for_status()
                text = _bytes_to_text(r.content, max_pages=30)
                return r.content, text
    except Exception as exc:
        logger.debug("DOI institutional fetch failed for %s: %s", doi, exc)
    return None, None


async def _fetch_via_doi(doi: str) -> Optional[str]:
    """
    Follow the DOI redirect and fetch a PDF if the publisher serves one
    directly — works on ONOS / EZproxy / Athens / Shibboleth networks.

    Deliberately PDF-only here: the DOI redirect often goes to a publisher
    landing page (HTML with only the abstract) rather than full open-access
    content. For OA HTML, the oa_pdf_url path (step 2) is the right channel.
    """
    doi_url = f"https://doi.org/{doi}"
    try:
        async with httpx.AsyncClient(
            headers={**HEADERS, "Accept": "application/pdf, */*"},
            timeout=httpx.Timeout(20.0, connect=8.0),
            follow_redirects=True,
        ) as client:
            # HEAD — cheap redirect check
            try:
                head       = await client.head(doi_url)
                final_url  = str(head.url)
                ctype_head = head.headers.get("content-type", "").lower()
            except Exception:
                final_url  = doi_url
                ctype_head = ""

            is_pdf = "pdf" in ctype_head or final_url.lower().endswith(".pdf")
            if not is_pdf:
                # Some publishers return HTML for HEAD even if GET gives PDF —
                # try a range-limited GET to check magic bytes.
                try:
                    probe  = await client.get(
                        final_url,
                        headers={**HEADERS, "Range": "bytes=0-4"},
                    )
                    is_pdf = probe.content[:4] == b"%PDF"
                except Exception:
                    pass

            if is_pdf:
                return await extract_text_from_url(final_url)

    except Exception as exc:
        logger.debug("DOI institutional fetch failed for %s: %s", doi, exc)
    return None


def _truncate(text: str) -> str:
    if len(text) <= MAX_CHARS:
        return text

    budget = MAX_CHARS - len(_ELLIPSIS_MARKER) - (2 * len(_OMIT_MARKER))
    if budget <= 0:
        return text[: MAX_CHARS - len(_ELLIPSIS_MARKER)] + _ELLIPSIS_MARKER

    lower = text.lower()

    def _find_anchor(candidates: list[str]) -> int:
        for candidate in candidates:
            patterns = (
                f"\n{candidate}\n",
                f"\n{candidate}\r\n",
                f"\n{candidate} ",
                f"{candidate}\n",
                candidate,
            )
            for pattern in patterns:
                idx = lower.find(pattern)
                if idx != -1:
                    return idx
        return -1

    def _window_around(anchor: int, size: int) -> tuple[int, int]:
        anchor = max(0, min(anchor, len(text) - 1))
        start = max(0, anchor - size // 5)
        end = start + size
        if end > len(text):
            end = len(text)
            start = max(0, end - size)
        return start, end

    head_budget = int(budget * 0.34)
    middle_budget = int(budget * 0.28)
    tail_budget = budget - head_budget - middle_budget

    results_anchor = _find_anchor(["results", "findings"])
    tail_anchor = _find_anchor(["discussion", "conclusion", "limitations"])

    windows = [
        (0, head_budget),
        _window_around(results_anchor if results_anchor != -1 else len(text) // 2, middle_budget),
        _window_around(tail_anchor if tail_anchor != -1 else max(0, len(text) - tail_budget), tail_budget),
    ]

    merged: list[tuple[int, int]] = []
    for start, end in sorted(windows):
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))

    parts = [text[start:end].strip() for start, end in merged if text[start:end].strip()]
    if len(parts) == 1:
        return parts[0][: MAX_CHARS - len(_ELLIPSIS_MARKER)] + _ELLIPSIS_MARKER
    return _OMIT_MARKER.join(parts)[: MAX_CHARS - len(_ELLIPSIS_MARKER)] + _ELLIPSIS_MARKER
