"""
scihub_fetcher.py

Last-resort full-text PDF retrieval via Sci-Hub.

Three-tier strategy:
  Tier 1 — scidownl Python package (pip install scidownl)
            Downloads to a temp directory; reads and returns bytes.
  Tier 2 — Verified working mirrors (tested 2026-03-22) using mirror-specific
            HTML scraping strategies:
              • sci-hub.su  → <meta name="citation_pdf_url"> path
              • sci-hub.ren → <embed src="...sci.bban.top/pdf/...">
            Falls back to generic iframe/embed patterns for other mirrors.

Usage: enabled only when the user explicitly opts in via FetchSettings.sci_hub_enabled.
Intended for personal research use — users must ensure compliance with their
institution's policies and applicable laws before enabling.
"""

from __future__ import annotations

import logging
import re
import tempfile
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Mirrors ordered by confirmed availability (tested 2026-03-22).
# sci-hub.su and sci-hub.ren both confirmed returning real PDFs (NEJM 915KB, Cell 5.5MB).
_MIRRORS = [
    "https://sci-hub.su",
    "https://www.sci-hub.ren",
    "https://sci-hub.tf",
    "https://sci-hub.se",
    "https://sci-hub.st",
    "https://sci-hub.ru",
]

_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}


async def fetch_pdf_via_scihub(
    doi: str,
    proxy: Optional[str] = None,
    mirrors: Optional[list[str]] = None,
) -> Optional[bytes]:
    """
    Attempt to retrieve a PDF for the given DOI via Sci-Hub.

    Returns raw PDF bytes or None if all methods fail.
    Tier 1 runs synchronously (scidownl uses blocking I/O) via asyncio.to_thread.
    Tier 2 is fully async.

    mirrors: ordered list of mirror base URLs to try. Defaults to _MIRRORS.
    """
    import asyncio

    # Tier 1: scidownl (if installed)
    result = await asyncio.to_thread(_try_scidownl, doi)
    if result:
        logger.debug("Sci-Hub (scidownl) succeeded for DOI %s", doi)
        return result

    # Tier 2: direct mirror scraping (use caller-supplied list or module default)
    result = await _try_mirrors(doi, proxy, mirrors=mirrors or _MIRRORS)
    if result:
        logger.debug("Sci-Hub (mirror scraping) succeeded for DOI %s", doi)
    return result


# ── Tier 1: scidownl ─────────────────────────────────────────────────────────

def _try_scidownl(doi: str) -> Optional[bytes]:
    """
    Use the scidownl package to download the PDF to a temp directory.
    Returns PDF bytes or None.
    """
    try:
        import scidownl  # type: ignore
    except ImportError:
        logger.debug("scidownl not installed — skipping Tier 1 Sci-Hub")
        return None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            scidownl.scihub_download(doi, paper_type="doi", out=tmpdir)
            for fname in os.listdir(tmpdir):
                if fname.lower().endswith(".pdf"):
                    fpath = os.path.join(tmpdir, fname)
                    with open(fpath, "rb") as f:
                        return f.read()
    except Exception as exc:
        logger.debug("scidownl failed for DOI %s: %s", doi, exc)
    return None


# ── Tier 2: direct mirror scraping ───────────────────────────────────────────

async def _try_mirrors(doi: str, proxy: Optional[str], mirrors: Optional[list[str]] = None) -> Optional[bytes]:
    proxy_settings = {"http://": proxy, "https://": proxy} if proxy else {}
    for mirror in (mirrors or _MIRRORS):
        try:
            pdf_bytes = await _scrape_one_mirror(doi, mirror, proxy_settings)
            if pdf_bytes:
                return pdf_bytes
        except Exception as exc:
            logger.debug("Mirror %s failed for DOI %s: %s", mirror, doi, exc)
    return None


async def _scrape_one_mirror(
    doi: str,
    mirror: str,
    proxy_settings: dict,
) -> Optional[bytes]:
    """
    GET {mirror}/{doi}, parse the response page for an embedded PDF URL,
    then fetch that URL and return the PDF bytes.
    """
    url = f"{mirror}/{doi}"
    proxy_url = next(iter(proxy_settings.values()), None) if proxy_settings else None
    async with httpx.AsyncClient(
        headers=_HEADERS,
        timeout=_TIMEOUT,
        follow_redirects=True,
        proxy=proxy_url,
    ) as client:
        r = await client.get(url)
        if r.status_code != 200:
            return None

        content_type = r.headers.get("content-type", "").lower()

        # Mirror served PDF directly
        if "pdf" in content_type or r.content[:4] == b"%PDF":
            return r.content

        # Parse HTML to find the PDF URL using mirror-specific strategies first,
        # then fall back to generic patterns
        pdf_url = _extract_pdf_url(r.text, mirror)
        if not pdf_url:
            return None

        # Fetch the actual PDF
        r2 = await client.get(pdf_url, headers={**_HEADERS, "Referer": url})
        if r2.status_code == 200 and (
            "pdf" in r2.headers.get("content-type", "").lower()
            or r2.content[:4] == b"%PDF"
        ):
            return r2.content

    return None


def _extract_pdf_url(html: str, mirror: str) -> Optional[str]:
    """
    Extract the PDF download URL from a Sci-Hub mirror page HTML.

    Mirror-specific strategies (confirmed working 2026-03-22):
      sci-hub.su  — <meta name="citation_pdf_url" content="/storage/...pdf">
      sci-hub.ren — <embed src="https://sci.bban.top/pdf/{doi}.pdf...">

    Generic fallbacks for other mirrors:
      <iframe src>, <embed src>, onclick="location.href=...pdf..."
    """
    # ── sci-hub.su: citation_pdf_url meta tag ────────────────────────────────
    # <meta name="citation_pdf_url" content="/storage/.../filename.pdf">
    if "sci-hub.su" in mirror:
        m = re.search(
            r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']',
            html, re.IGNORECASE,
        )
        if not m:
            # Attribute order may vary
            m = re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url["\']',
                html, re.IGNORECASE,
            )
        if m:
            return _normalise_url(m.group(1), mirror)

    # ── sci-hub.ren: embed pointing to sci.bban.top ───────────────────────────
    # <embed src="https://sci.bban.top/pdf/{doi}.pdf#view=FitH">
    if "sci-hub.ren" in mirror or "bban.top" in html:
        m = re.search(
            r'<embed[^>]+src=["\']([^"\']*sci\.bban\.top[^"\']+)["\']',
            html, re.IGNORECASE,
        )
        if m:
            # Strip anchor fragment; download=true param works but is optional
            url = m.group(1).split("#")[0]
            return url

    # ── Generic fallbacks ─────────────────────────────────────────────────────

    # <iframe src="...pdf..."> or <embed src="...pdf...">
    for pattern in [
        r'<iframe[^>]+src=["\']([^"\']+\.pdf[^"\']*)["\']',
        r'<embed[^>]+src=["\']([^"\']+\.pdf[^"\']*)["\']',
        r'<iframe[^>]+src=["\'](//[^"\']+)["\']',
    ]:
        m = re.search(pattern, html, re.IGNORECASE)
        if m:
            return _normalise_url(m.group(1), mirror)

    # onclick="location.href='...pdf...'"
    m = re.search(r"location\.href=['\"]([^'\"]+\.pdf[^'\"]*)['\"]", html, re.IGNORECASE)
    if m:
        return _normalise_url(m.group(1), mirror)

    # /downloads/ or /tree/ src attributes
    m = re.search(r'src=["\']([^"\']*(?:/downloads?/|/tree/)[^"\']+)["\']', html, re.IGNORECASE)
    if m:
        return _normalise_url(m.group(1), mirror)

    return None


def _normalise_url(href: str, mirror: str) -> str:
    """Ensure the URL is absolute."""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return mirror.rstrip("/") + href
    if not href.startswith("http"):
        return mirror.rstrip("/") + "/" + href
    return href
