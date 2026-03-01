"""
doi_metadata_fetcher.py

Fetches rich bibliographic metadata for a paper via its DOI,
similar to what the Zotero browser plugin does.

Priority:
  1. CrossRef Works API  https://api.crossref.org/works/{doi}
     Returns author family + given names, journal name, year, volume,
     issue, pages, ISSN — the most reliable free source.
  2. DOI content negotiation
     GET https://doi.org/{doi}  Accept: application/vnd.citationstyles.json
     Returns CSL-JSON directly from the publisher.

Returns a CSL-JSON-compatible dict with keys:
  {
    "title": str,
    "author": [{"family": str, "given": str}, ...],
    "container-title": str,
    "issued": {"date-parts": [[int]]},
    "volume": str,
    "issue": str,
    "page": str,
    "DOI": str,
  }
Returns None if both attempts fail or no DOI is supplied.

Public API
----------
fetch_doi_metadata(doi: str) -> dict | None
enrich_summaries_with_doi(summaries: list[dict]) -> list[dict]
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_CROSSREF_BASE = "https://api.crossref.org/works"
_DOI_BASE      = "https://doi.org"
_TIMEOUT       = httpx.Timeout(15.0, connect=8.0)
_HEADERS       = {
    "User-Agent": (
        "AcademicWriterAgent/1.0 "
        "(mailto:academic-writer-agent@localhost.dev; "
        "Polite pool - DOI metadata enrichment)"
    )
}
# Concurrency cap — CrossRef polite pool allows ~50 req/s.
# Created lazily inside async context to avoid event-loop binding issues.
_semaphore: asyncio.Semaphore | None = None

def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(8)
    return _semaphore


# ── CrossRef ──────────────────────────────────────────────────────────────────

async def _fetch_from_crossref(doi: str) -> Optional[dict]:
    """
    Call CrossRef Works API and normalise the response to a CSL-JSON dict.
    """
    url = f"{_CROSSREF_BASE}/{doi}"
    try:
        async with _get_semaphore():
            async with httpx.AsyncClient(headers=_HEADERS, timeout=_TIMEOUT) as client:
                r = await client.get(url)
                if r.status_code != 200:
                    return None
                data = r.json()
    except Exception as exc:
        logger.debug("CrossRef fetch failed for DOI %s: %s", doi, exc)
        return None

    msg = data.get("message", {})
    if not msg:
        return None

    result: dict = {"DOI": doi}

    # Title
    titles = msg.get("title") or []
    if titles:
        result["title"] = titles[0]

    # Authors — CrossRef gives family + given separately
    authors_raw = msg.get("author") or []
    csl_authors = []
    for a in authors_raw:
        entry: dict = {}
        if a.get("family"):
            entry["family"] = a["family"]
        if a.get("given"):
            entry["given"] = a["given"]
        if not entry:
            # Fallback to name or literal
            if a.get("name"):
                entry["literal"] = a["name"]
        if entry:
            csl_authors.append(entry)
    if csl_authors:
        result["author"] = csl_authors

    # Container (journal) title
    container = msg.get("container-title") or []
    if container:
        result["container-title"] = container[0]

    # Publication date — prefer published-print, fall back to published-online / created
    for date_key in ("published-print", "published-online", "created"):
        date_obj = msg.get(date_key)
        if date_obj and date_obj.get("date-parts"):
            parts = date_obj["date-parts"][0]
            result["issued"] = {"date-parts": [parts]}
            break

    # Volume / issue / pages
    for field in ("volume", "issue", "page"):
        val = msg.get(field)
        if val:
            result[field] = str(val)

    return result


# ── DOI content negotiation ───────────────────────────────────────────────────

async def _fetch_via_content_negotiation(doi: str) -> Optional[dict]:
    """
    Use DOI content negotiation to retrieve CSL-JSON from the publisher.
    This is the same mechanism Zotero uses as its primary reference source.
    """
    url = f"{_DOI_BASE}/{doi}"
    try:
        async with _get_semaphore():
            async with httpx.AsyncClient(
                headers={**_HEADERS, "Accept": "application/vnd.citationstyles.json"},
                timeout=_TIMEOUT,
                follow_redirects=True,
            ) as client:
                r = await client.get(url)
                if r.status_code != 200:
                    return None
                data = r.json()
    except Exception as exc:
        logger.debug("DOI content-negotiation failed for %s: %s", doi, exc)
        return None

    if not isinstance(data, dict):
        return None

    result: dict = {"DOI": doi}

    if data.get("title"):
        result["title"] = data["title"]

    # Normalise authors — CSL-JSON author arrays
    authors_raw = data.get("author") or []
    csl_authors = []
    for a in authors_raw:
        if isinstance(a, dict):
            entry: dict = {}
            if a.get("family"):
                entry["family"] = a["family"]
            if a.get("given"):
                entry["given"] = a["given"]
            if not entry and a.get("literal"):
                entry["literal"] = a["literal"]
            if entry:
                csl_authors.append(entry)
    if csl_authors:
        result["author"] = csl_authors

    if data.get("container-title"):
        result["container-title"] = data["container-title"]

    if data.get("issued"):
        result["issued"] = data["issued"]

    for field in ("volume", "issue", "page"):
        if data.get(field):
            result[field] = str(data[field])

    return result


# ── Public API ────────────────────────────────────────────────────────────────

async def fetch_doi_metadata(doi: str) -> Optional[dict]:
    """
    Fetch structured bibliographic metadata for a DOI.

    Tries CrossRef first (most complete author data), falls back to DOI
    content negotiation (Zotero-style).

    Returns a CSL-JSON-compatible dict, or None on failure.
    """
    if not doi:
        return None

    # Normalise DOI — strip leading https://doi.org/ if present
    clean_doi = doi.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi.org/", "DOI:", "doi:"):
        if clean_doi.startswith(prefix):
            clean_doi = clean_doi[len(prefix):]
            break

    if not clean_doi:
        return None

    # 1. CrossRef
    data = await _fetch_from_crossref(clean_doi)
    if data:
        logger.debug("DOI enrichment via CrossRef: %s", clean_doi)
        return data

    # 2. DOI content negotiation
    data = await _fetch_via_content_negotiation(clean_doi)
    if data:
        logger.debug("DOI enrichment via content negotiation: %s", clean_doi)
        return data

    logger.debug("DOI enrichment failed for %s — using AI-extracted metadata", clean_doi)
    return None


async def enrich_summaries_with_doi(summaries: list[dict]) -> list[dict]:
    """
    For each summary that has a DOI, fetch authoritative metadata from CrossRef
    and overwrite the bibliography sub-dict with it.

    Only fields present in the CrossRef response overwrite the existing data —
    AI-extracted fields are kept as fallback when CrossRef doesn't return them.

    Returns a new list of enriched summaries (originals are not mutated).
    """
    if not summaries:
        return summaries

    async def _enrich_one(summary: dict) -> dict:
        bib = summary.get("bibliography", {})
        doi = bib.get("doi") or ""
        if not doi:
            return summary

        enriched = await fetch_doi_metadata(doi)
        if not enriched:
            return summary

        # Deep-copy the summary and merge enriched data into bibliography
        import copy
        s = copy.deepcopy(summary)
        b = s.setdefault("bibliography", {})

        if enriched.get("title"):
            b["title"] = enriched["title"]

        # Authors: CrossRef gives proper family/given — store as list of strings
        # in "LastName, GivenInitials" format (what the rest of the pipeline expects)
        # AND as the raw CSL author list for direct injection.
        if enriched.get("author"):
            b["_csl_authors"] = enriched["author"]   # preserved for bib_to_csl_item
            # Rebuild the string list too so summary blocks look right
            formatted = []
            for a in enriched["author"]:
                if a.get("family") and a.get("given"):
                    formatted.append(f"{a['family']}, {a['given']}")
                elif a.get("family"):
                    formatted.append(a["family"])
                elif a.get("literal"):
                    formatted.append(a["literal"])
            if formatted:
                b["authors"] = formatted

        if enriched.get("container-title"):
            b["journal"] = enriched["container-title"]

        if enriched.get("issued", {}).get("date-parts"):
            parts = enriched["issued"]["date-parts"][0]
            if parts:
                b["year"] = parts[0]

        for field in ("volume", "issue", "page"):
            if enriched.get(field):
                b[field if field != "page" else "pages"] = enriched[field]

        return s

    tasks = [_enrich_one(s) for s in summaries]
    return list(await asyncio.gather(*tasks))
