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


@dataclass
class FetchSettings:
    """User preferences for full-text fetching and PDF persistence."""
    pdf_save_enabled: bool = False
    pdf_save_path: Optional[str] = None   # legacy; use project_folder when set
    project_folder: Optional[str] = None  # preferred: saves into project dir
    sci_hub_enabled: bool = False
    http_proxy: Optional[str] = None

def _effective_save_path(fs: "FetchSettings") -> Optional[str]:
    """Return the effective PDF save path: project_folder takes priority over pdf_save_path."""
    return fs.project_folder or fs.pdf_save_path


logger = logging.getLogger(__name__)

NCBI_BASE    = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
PMC_HTML_BASE = "https://pmc.ncbi.nlm.nih.gov/articles"
NCBI_IDCONV  = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
TIMEOUT      = httpx.Timeout(45.0, connect=10.0)
HEADERS      = {"User-Agent": "AcademicWriterAgent/0.2 (academic-writer-agent@localhost.dev)"}
MAX_CHARS    = 32_000   # ~8 000 words — enough for summarisation, fits any LLM context


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
                await _maybe_save_pmc_pdf(paper.pmcid, _save_path, paper)
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
                    await _maybe_save_pmc_pdf(resolved_pmcid, _save_path, paper)
                return _truncate(text), "pmc_xml"
            # No XML body — try HTML for this resolved PMCID
            text = await _fetch_pmc_html_text(resolved_pmcid)
            if text:
                if fs.pdf_save_enabled and _save_path:
                    await _maybe_save_pmc_pdf(resolved_pmcid, _save_path, paper)
                return _truncate(text), "full_html"

    # 2. OA URL (PDF or HTML) — from Unpaywall / OpenAlex / Semantic Scholar
    #    extract_text_from_url handles both PDF and HTML transparently.
    if paper.oa_pdf_url:
        pdf_bytes, text = await _fetch_url_with_bytes(paper.oa_pdf_url)
        if text:
            logger.debug("Full text via OA URL (%d chars): %s", len(text), paper.oa_pdf_url)
            if pdf_bytes and fs.pdf_save_enabled and _save_path:
                _save_pdf_to_disk(pdf_bytes, _save_path, paper)
            return _truncate(text), "full_pdf"
        else:
            logger.debug("OA URL returned no usable text: %s", paper.oa_pdf_url)

    # 3. PMC HTML page — fallback when the JATS XML has no <body>.
    if paper.pmcid:
        text = await _fetch_pmc_html_text(paper.pmcid)
        if text:
            if fs.pdf_save_enabled and _save_path:
                await _maybe_save_pmc_pdf(paper.pmcid, _save_path, paper)
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
            pdf_bytes = await fetch_pdf_via_scihub(paper.doi, proxy=fs.http_proxy)
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
        return paper.abstract.strip(), "abstract_only"

    return "", "none"


# ── PDF save to disk ──────────────────────────────────────────────────────────

def _sanitize(s: str, max_len: int = 30) -> str:
    """Replace non-alphanumeric chars with underscores and truncate."""
    s = re.sub(r"[^\w]", "_", s or "")
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:max_len]


def _save_pdf_to_disk(pdf_bytes: bytes, save_path: str, paper: Paper) -> Optional[str]:
    """
    Save *pdf_bytes* to *save_path* with a descriptive filename.

    Filename: {FirstAuthor}_{Year}_{JournalAbbrev}_{TitleWords}.pdf
    Returns the saved file path or None on error.
    """
    try:
        os.makedirs(save_path, exist_ok=True)
        first_author = _sanitize(paper.authors[0].split(",")[0] if paper.authors else "Unknown", 20)
        year = str(paper.year or "XXXX")
        journal = _sanitize(paper.journal or "Unknown", 20)
        title_words = _sanitize(" ".join(paper.title.split()[:6]), 40)
        filename = f"{first_author}_{year}_{journal}_{title_words}.pdf"
        filepath = os.path.join(save_path, filename)
        with open(filepath, "wb") as f:
            f.write(pdf_bytes)
        logger.debug("PDF saved: %s", filepath)
        return filepath
    except Exception as exc:
        logger.warning("Failed to save PDF for %r: %s", paper.title[:40], exc)
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
    return text[:MAX_CHARS] + "\n\n[… text truncated for summarisation …]"
