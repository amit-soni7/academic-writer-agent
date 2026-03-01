"""
journal_recommender.py

Builds a ranked list of target journals for the researcher's topic.

Pipeline
--------
1. Count journals that appear in the search results (frequency ranking).
2. Enrich each with free OpenAlex metadata:
     - Publisher, ISSN, open-access status, h-index, 2-yr mean citedness, APC.
3. Check PubMed indexing via the NLM catalog (free, no key required).
4. Check ONOS APC support from https://www.onos.gov.in/APCTitles
     - Full journal list scraped and cached on disk for 30 days.
5. LLM annotates each with a scope-match note and suggests up to 3 extra journals.

All steps degrade gracefully — the function always returns something even if
external services are unreachable.
"""

import asyncio
import json
import logging
import pathlib
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

from models import JournalRecommendation, Paper
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

_HEADERS = {"User-Agent": "AcademicWriterAgent/0.2 (academic-writer-agent@localhost.dev)"}
_OA_URL  = "https://api.openalex.org/sources"
_NLM_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"

# ── ONOS cache configuration ──────────────────────────────────────────────────
# Cached on disk so it survives server restarts; refreshed every 30 days.
_ONOS_CACHE_PATH = pathlib.Path(__file__).parent.parent / "data" / "onos_cache.json"
_ONOS_TTL_DAYS   = 30

_onos_lock: asyncio.Lock | None = None   # created lazily (needs running event loop)
_onos_issns: Optional[set[str]] = None  # in-memory copy once loaded

# ── PubMed J_Medline cache (journal indexing) ────────────────────────────────
_J_MEDLINE_URL   = "https://ftp.ncbi.nih.gov/pubmed/J_Medline.txt"
_J_MEDLINE_PATH  = pathlib.Path(__file__).parent.parent / "data" / "J_Medline.txt"
_J_MEDLINE_TTL_DAYS = 30
_jmed_cache: Optional[dict] = None  # {"issns": set[str], "titles": set[str]}

# ── LLM prompts ───────────────────────────────────────────────────────────────

_LLM_SYSTEM = """\
You are an expert academic editor advising on journal selection.
Given a research topic and a list of journals found in the literature search,
provide a 1-2 sentence scope-match note for each, then suggest up to 3 additional
relevant journals not already in the list.
Respond with ONLY valid JSON — no markdown, no prose outside the JSON.
"""

_LLM_USER = """\
Research topic: {query}

Journals from search results:
{journal_list}

Return exactly this JSON shape:
{{
  "annotations": [
    {{ "name": "exact journal name", "scope_match": "1-2 sentence note on fit for this topic" }}
  ],
  "suggested_additional": [
    {{
      "name": "journal name",
      "publisher": "publisher name or null",
      "issn": "ISSN or null",
      "scope_match": "why this journal is relevant to the topic"
    }}
  ]
}}
"""


# ── Public entry point ────────────────────────────────────────────────────────

async def recommend_journals(
    provider: Optional[AIProvider],
    papers: list[Paper],
    query: str,
) -> list[JournalRecommendation]:
    """Return a ranked list of JournalRecommendation objects."""

    # 1. Frequency count from search results
    counts: dict[str, int] = {}
    for p in papers:
        if p.journal and p.journal.strip():
            j = p.journal.strip()
            counts[j] = counts.get(j, 0) + 1

    ranked = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:12]
    if not ranked:
        return []

    # 2. Load ONOS cache once (shared across all enrichments)
    onos_set = await _load_onos_issns()

    # 3. Enrich with OpenAlex + PubMed + ONOS (concurrent, max 5 simultaneous)
    sem = asyncio.Semaphore(5)

    async def _enrich(name: str, freq: int) -> JournalRecommendation:
        async with sem:
            meta  = await _fetch_openalex(name)
            issns = meta.get("issns", []) if meta else []
            issn  = meta.get("issn")      if meta else None

            pubmed = await _check_pubmed_local(name, issns)
            onos   = _check_onos(issns, onos_set)

            apc_usd = meta.get("apc_usd") if meta else None
            apc_note: Optional[str] = None
            if onos:
                apc_note = "Waived via ONOS"
            elif apc_usd is not None and apc_usd == 0:
                apc_note = "Free"

            return JournalRecommendation(
                name=name,
                publisher=meta.get("publisher")     if meta else None,
                issn=issn,
                frequency_in_results=freq,
                open_access=meta.get("open_access") if meta else None,
                h_index=meta.get("h_index")         if meta else None,
                avg_citations=meta.get("avg_citations") if meta else None,
                scope_match=None,
                openalex_url=meta.get("url")        if meta else None,
                website_url=meta.get("homepage")    if meta else None,
                indexed_pubmed=pubmed,
                indexed_scopus=None,   # Requires paid Elsevier/Scopus API key
                apc_usd=apc_usd,
                apc_note=apc_note,
                onos_supported=onos,
            )

    recs: list[JournalRecommendation] = list(
        await asyncio.gather(*[_enrich(n, f) for n, f in ranked])
    )

    # 4. LLM annotation + extra suggestions
    if provider:
        recs = await _llm_annotate(provider, query, recs)

    return recs


# ── OpenAlex fetch ────────────────────────────────────────────────────────────

async def _fetch_openalex(name: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(headers=_HEADERS, timeout=10.0) as client:
            r = await client.get(_OA_URL, params={
                "search": name,
                "per_page": 1,
                "select": (
                    "display_name,host_organization_name,issn,is_oa,"
                    "summary_stats,homepage_url,id,apc_usd,apc_prices"
                ),
            })
            r.raise_for_status()
            results = r.json().get("results", [])
            if not results:
                return None
            j     = results[0]
            stats = j.get("summary_stats") or {}
            oa_id = (j.get("id") or "").split("/")[-1]

            # APC: prefer apc_usd field; fall back to apc_prices list
            apc_usd: Optional[int] = j.get("apc_usd")
            if apc_usd is None:
                for entry in (j.get("apc_prices") or []):
                    if entry.get("currency") == "USD":
                        apc_usd = int(entry["price"])
                        break

            all_issns: list[str] = j.get("issn") or []
            return {
                "publisher":    j.get("host_organization_name"),
                "issn":         all_issns[0] if all_issns else None,
                "issns":        all_issns,
                "open_access":  j.get("is_oa"),
                "h_index":      stats.get("h_index"),
                "avg_citations": stats.get("2yr_mean_citedness"),
                "apc_usd":      apc_usd,
                "url": (
                    j.get("homepage_url")
                    or (f"https://openalex.org/sources/{oa_id}" if oa_id else None)
                ),
                "homepage": j.get("homepage_url"),
            }
    except Exception as exc:
        logger.debug("OpenAlex fetch failed for %r: %s", name, exc)
        return None


# ── PubMed / NLM catalog ──────────────────────────────────────────────────────

async def _check_pubmed_local(name: str, issns: list[str]) -> Optional[bool]:
    """Prefer offline J_Medline.txt; fall back to NLM query on failure."""
    indexed = await _load_j_medline_index()
    if indexed is not None:
        issn_set: set[str] = indexed["issns"]
        title_set: set[str] = indexed["titles"]
        for s in issns:
            if s and s.replace("-", "").strip().upper() in issn_set:
                return True
        if name.strip().lower() in title_set:
            return True
        return False if issns else None

    # Fallback: live NLM query by ISSN
    for issn in issns:
        try:
            async with httpx.AsyncClient(headers=_HEADERS, timeout=10.0) as client:
                r = await client.get(_NLM_URL, params={
                    "db":      "nlmcatalog",
                    "term":    f"{issn.strip()}[issn] AND currentlyindexed[All]",
                    "retmode": "json",
                    "retmax":  1,
                })
                r.raise_for_status()
                count = int(r.json().get("esearchresult", {}).get("count", "0"))
                if count > 0:
                    return True
        except Exception as exc:
            logger.debug("NLM PubMed check failed for ISSN %s: %s", issn, exc)
    return False if issns else None

async def _load_j_medline_index() -> Optional[dict]:
    """Download/cache and parse J_Medline.txt into title/ISSN sets."""
    global _jmed_cache
    if _jmed_cache is not None:
        return _jmed_cache
    try:
        # TTL check
        if _J_MEDLINE_PATH.exists():
            mtime = datetime.fromtimestamp(_J_MEDLINE_PATH.stat().st_mtime, tz=timezone.utc)
            if datetime.now(timezone.utc) - mtime > timedelta(days=_J_MEDLINE_TTL_DAYS):
                _J_MEDLINE_PATH.unlink(missing_ok=True)
        if not _J_MEDLINE_PATH.exists():
            _J_MEDLINE_PATH.parent.mkdir(parents=True, exist_ok=True)
            async with httpx.AsyncClient(headers=_HEADERS, timeout=60.0) as client:
                r = await client.get(_J_MEDLINE_URL)
                r.raise_for_status()
                _J_MEDLINE_PATH.write_bytes(r.content)

        text = _J_MEDLINE_PATH.read_text(errors="ignore")
        issns: set[str] = set()
        titles: set[str] = set()
        block: list[str] = []

        def _flush():
            if not block:
                return
            btxt = "\n".join(block)
            # Detect MEDLINE/PubMed indexing using robust case-insensitive check
            if re.search(r"Current\s+Indexing\s+Status\s*:\s*Currently\s+Indexed\s+for\s+MEDLINE", btxt, re.IGNORECASE):
                m = re.search(r"^Title:\s*(.+)$", btxt, flags=re.MULTILINE)
                if m:
                    titles.add(m.group(1).strip().lower())
                # Capture ISSN, EISSN, ESSN variants
                for m2 in re.finditer(r"\b(ISSN|EISSN|ESSN)[^:]*:\s*([0-9Xx\-]{8,9})", btxt, re.IGNORECASE):
                    issns.add(m2.group(2).replace("-", "").upper())
            block.clear()

        for line in text.splitlines():
            if line.strip() == "":
                _flush()
            else:
                block.append(line)
        _flush()

        _jmed_cache = {"issns": issns, "titles": titles}
        logger.info("J_Medline: loaded %d titles, %d ISSNs", len(titles), len(issns))
        return _jmed_cache
    except Exception as exc:
        logger.warning("Failed to load/parse J_Medline.txt: %s", exc)
        return None


# ── ONOS APC support ──────────────────────────────────────────────────────────

def _get_onos_lock() -> asyncio.Lock:
    global _onos_lock
    if _onos_lock is None:
        _onos_lock = asyncio.Lock()
    return _onos_lock


async def _load_onos_issns() -> set[str]:
    """
    Return the set of ISSNs (stripped of hyphens) in the ONOS APC list.
    Uses a disk cache that is refreshed every 30 days.
    Returns empty set on failure (all ONOS checks will return None).
    """
    global _onos_issns

    # Fast path: already in memory
    if _onos_issns is not None:
        return _onos_issns

    async with _get_onos_lock():
        if _onos_issns is not None:
            return _onos_issns

        # Try reading from disk cache
        cached = _read_onos_cache()
        if cached is not None:
            _onos_issns = cached
            logger.info("ONOS: loaded %d ISSNs from disk cache", len(cached))
            return _onos_issns

        # Fetch fresh from ONOS
        try:
            fresh = await _fetch_onos_journals()
            _write_onos_cache(fresh)
            _onos_issns = fresh
            logger.info("ONOS: fetched and cached %d ISSNs", len(fresh))
        except Exception as exc:
            logger.warning("ONOS fetch failed — ONOS support checks disabled: %s", exc)
            _onos_issns = set()   # empty → all checks return None

        return _onos_issns


def _read_onos_cache() -> Optional[set[str]]:
    """Read cached ONOS ISSNs from disk; return None if missing or expired."""
    try:
        if not _ONOS_CACHE_PATH.exists():
            return None
        blob = json.loads(_ONOS_CACHE_PATH.read_text())
        fetched_at = datetime.fromisoformat(blob["fetched_at"])
        if datetime.now(timezone.utc) - fetched_at > timedelta(days=_ONOS_TTL_DAYS):
            logger.info("ONOS disk cache expired — will refresh")
            return None
        return set(blob["issns"])
    except Exception as exc:
        logger.debug("ONOS cache read error: %s", exc)
        return None


def _write_onos_cache(issns: set[str]) -> None:
    """Persist ONOS ISSNs to disk."""
    try:
        _ONOS_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _ONOS_CACHE_PATH.write_text(json.dumps({
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "count":      len(issns),
            "issns":      sorted(issns),
        }, indent=2))
    except Exception as exc:
        logger.warning("ONOS cache write failed: %s", exc)


async def _fetch_onos_journals() -> set[str]:
    """
    Fetch the ONOS APC journal list from https://www.onos.gov.in/APCTitles.

    CSRF strategy: extract the plain token from the HTML <meta name="csrf-token">
    tag (NOT from the encrypted XSRF-TOKEN cookie, which triggers a mismatch).
    The session cookie is maintained automatically by the shared httpx client.

    Returns a set of ISSNs (hyphens stripped) from the 431-entry JSON response.
    """
    issn_set: set[str] = set()

    browser_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    # Use a single client so session cookies are shared between GET and POST
    async with httpx.AsyncClient(
        headers=browser_headers,
        timeout=30.0,
        follow_redirects=True,
    ) as client:
        # Step 1: GET the page — establishes the session; HTML contains the CSRF token
        r = await client.get("https://www.onos.gov.in/APCTitles")
        r.raise_for_status()

        # Extract CSRF token from <meta name="csrf-token" content="...">
        # This is the plain token, NOT the encrypted XSRF-TOKEN cookie value.
        m = (
            re.search(r'<meta[^>]+name=["\']csrf-token["\'][^>]+content=["\']([^"\']+)', r.text)
            or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']csrf-token', r.text)
        )
        if not m:
            raise RuntimeError("CSRF meta tag not found in ONOS APCTitles page")

        csrf_token = m.group(1).strip()
        logger.debug("ONOS CSRF token extracted (%d chars)", len(csrf_token))

        # Step 2: POST to the AJAX endpoint that returns the journal JSON list
        r2 = await client.post(
            "https://www.onos.gov.in/APCjournalDetails",
            headers={
                "X-CSRF-TOKEN":     csrf_token,
                "X-Requested-With": "XMLHttpRequest",
                "Accept":           "application/json, text/plain, */*",
                "Referer":          "https://www.onos.gov.in/APCTitles",
                "Content-Type":     "application/x-www-form-urlencoded",
            },
            data={"_token": csrf_token},
        )
        r2.raise_for_status()

        journals = r2.json()
        if not isinstance(journals, list):
            raise RuntimeError(f"Unexpected ONOS response type: {type(journals)}")

        for entry in journals:
            for key in ("print_identifier", "online_identifier"):
                raw = (entry.get(key) or "").strip()
                if raw:
                    issn_set.add(raw.replace("-", ""))

        logger.info("ONOS: parsed %d ISSN entries from %d journal records",
                    len(issn_set), len(journals))

    return issn_set


def _check_onos(issns: list[str], onos_set: set[str]) -> Optional[bool]:
    """Return True/False/None for ONOS support. None = data unavailable."""
    if not onos_set:
        return None   # fetch failed — unknown
    if not issns:
        return None
    for issn in issns:
        if issn.replace("-", "").strip() in onos_set:
            return True
    return False


# ── LLM annotation ────────────────────────────────────────────────────────────

async def _llm_annotate(
    provider: AIProvider,
    query: str,
    recs: list[JournalRecommendation],
) -> list[JournalRecommendation]:
    try:
        journal_list = "\n".join(f"{i+1}. {r.name}" for i, r in enumerate(recs))
        raw = await provider.complete(
            system=_LLM_SYSTEM,
            user=_LLM_USER.format(query=query, journal_list=journal_list),
            json_mode=True,
            temperature=0.2,
        )
        data = json.loads(raw)

        # Apply scope-match annotations
        ann_map = {
            a["name"]: a.get("scope_match", "")
            for a in (data.get("annotations") or [])
            if isinstance(a, dict) and a.get("name")
        }
        for r in recs:
            if r.name in ann_map:
                r.scope_match = ann_map[r.name]

        # Append LLM-suggested extras (frequency=0 signals "AI-suggested")
        for sug in (data.get("suggested_additional") or [])[:3]:
            if not isinstance(sug, dict) or not sug.get("name"):
                continue
            recs.append(JournalRecommendation(
                name=sug["name"],
                publisher=sug.get("publisher"),
                issn=sug.get("issn"),
                frequency_in_results=0,
                open_access=None,
                h_index=None,
                avg_citations=None,
                scope_match=sug.get("scope_match"),
                openalex_url=None,
                indexed_pubmed=None,
                indexed_scopus=None,
                apc_usd=None,
                apc_note=None,
                onos_supported=None,
            ))
    except Exception as exc:
        logger.warning("LLM journal annotation failed: %s", exc)

    return recs
