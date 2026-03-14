"""
sr_search_engine.py

Enhanced multi-database search for Systematic Reviews.
Covers: PubMed (via Entrez), OpenAlex, Scopus (via pybliometrics),
        Semantic Scholar, ClinicalTrials.gov v2, ERIC.

Install: pip install biopython pyalex pybliometrics semanticscholar rapidfuzz

Rate-limit strategy (mirrors literature_engine.py)
───────────────────────────────────────────────────
• Each database search gets its own httpx.AsyncClient — no shared connection
  pool between database calls.
• _get() wraps every HTTP call with up to 4 retries and exponential back-off
  on 429 / 5xx responses, honouring Retry-After headers.
• Biopython Entrez calls run in a thread-pool executor to avoid blocking the
  event loop; an asyncio.Semaphore(1) serialises them.
• All database searches run concurrently via asyncio.gather.
• Results are saved to the papers table and sr_search_runs for PRISMA tracking.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import AsyncIterator, Optional

import httpx

from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

TIMEOUT = httpx.Timeout(45.0, connect=10.0)
S2_TIMEOUT = httpx.Timeout(15.0, connect=6.0)   # S2 is notoriously slow

HEADERS = {
    "User-Agent": "FirstQuill-SR/1.0 (mailto:academic-writer-agent@localhost.dev)",
    "Accept": "application/json",
}

CT_BASE   = "https://clinicaltrials.gov/api/v2"
ERIC_BASE = "https://api.ies.ed.gov/eric"
OA_BASE   = "https://api.openalex.org"
S2_BASE   = "https://api.semanticscholar.org/graph/v1"

POLITE_EMAIL = "academic-writer-agent@localhost.dev"

# Per-database batch / page sizes
OA_PAGE     = 200    # OpenAlex per-page max
S2_PAGE     = 100    # Semantic Scholar page size (hard-capped at 100)
CT_PAGE     = 1000   # ClinicalTrials.gov pageSize max
ERIC_PAGE   = 200    # ERIC rows per call
NCBI_BATCH  = 500    # Entrez efetch batch size


# ── Retry-aware GET (same pattern as literature_engine.py) ───────────────────

async def _get(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
    *,
    max_retries: int = 4,
    base_wait: float = 2.0,
    source_label: str = "",
) -> httpx.Response:
    """
    GET with exponential back-off on 429 / 5xx.
    Honours the Retry-After response header when present.
    Raises on final failure.
    """
    for attempt in range(max_retries):
        try:
            r = await client.get(url, params=params)
            if r.status_code == 429:
                retry_after = r.headers.get("Retry-After") or r.headers.get("retry-after")
                if retry_after:
                    try:
                        wait = min(float(retry_after), 120.0)
                    except ValueError:
                        wait = base_wait * (2 ** attempt)
                else:
                    wait = base_wait * (2 ** attempt)
                logger.warning(
                    "%s 429 on attempt %d/%d — retrying in %.0fs",
                    source_label or url, attempt + 1, max_retries, wait,
                )
                await asyncio.sleep(wait)
                continue
            r.raise_for_status()
            return r
        except httpx.HTTPStatusError:
            raise
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            if attempt == max_retries - 1:
                raise
            await asyncio.sleep(base_wait * (2 ** attempt))
            logger.warning(
                "%s request error (attempt %d): %s", source_label, attempt + 1, exc
            )
    raise RuntimeError(f"Max retries exceeded for {url}")


# ── Abstract reconstruction from OpenAlex inverted index ─────────────────────

def reconstruct_abstract(inverted_index: dict | None) -> str:
    """Rebuild plain text from OpenAlex abstract_inverted_index."""
    if not inverted_index:
        return ""
    try:
        positions: dict[int, str] = {}
        for word, pos_list in inverted_index.items():
            for pos in pos_list:
                positions[pos] = word
        return " ".join(positions[v] for v in sorted(positions))
    except Exception:
        return ""


# ── PubMed via Biopython Entrez ───────────────────────────────────────────────

# Module-level semaphore placeholder — created lazily per event loop.
_entrez_sem: asyncio.Semaphore | None = None


def _get_entrez_sem() -> asyncio.Semaphore:
    """Return (or create) the module-level Entrez semaphore on the running loop."""
    global _entrez_sem
    if _entrez_sem is None:
        _entrez_sem = asyncio.Semaphore(1)
    return _entrez_sem


async def search_pubmed_sr(
    query: str,
    date_from: str = "",
    date_to: str = "",
    api_key: str = "",
    email: str = POLITE_EMAIL,
) -> list[dict]:
    """
    Search PubMed using Biopython Entrez with history server (WebEnv).
    Runs Entrez calls in a thread-pool executor (blocking I/O) serialised
    through a module-level semaphore so we never exceed NCBI's 3 req/s limit.
    Returns a list of paper dicts.
    """
    try:
        from Bio import Entrez  # type: ignore
    except ImportError:
        logger.warning(
            "biopython not installed; PubMed SR search unavailable. pip install biopython"
        )
        return []

    Entrez.email = email
    if api_key:
        Entrez.api_key = api_key

    date_range = ""
    if date_from:
        df = date_from.replace("-", "/")
        dt = (date_to or datetime.utcnow().strftime("%Y/%m/%d")).replace("-", "/")
        date_range = f" AND ({df}[PDAT] : {dt}[PDAT])"

    full_query = query + date_range

    def _entrez_search_and_fetch(q: str) -> list[dict]:
        """Blocking Entrez calls — run inside executor."""
        try:
            handle = Entrez.esearch(db="pubmed", term=q, usehistory="y", retmax=0)
            search_results = Entrez.read(handle)
            handle.close()
        except Exception as exc:
            logger.error("PubMed esearch failed: %s", exc)
            return []

        count = int(search_results.get("Count", 0))
        if count == 0:
            return []

        webenv    = search_results["WebEnv"]
        query_key = search_results["QueryKey"]

        records: list[dict] = []
        for start in range(0, min(count, 10_000), NCBI_BATCH):
            try:
                fetch_handle = Entrez.efetch(
                    db="pubmed", retstart=start, retmax=NCBI_BATCH,
                    webenv=webenv, query_key=query_key,
                    rettype="xml", retmode="xml",
                )
                batch = Entrez.read(fetch_handle)
                fetch_handle.close()
            except Exception as exc:
                logger.warning("PubMed efetch batch start=%d failed: %s", start, exc)
                continue

            for article in batch.get("PubmedArticle", []):
                try:
                    med = article["MedlineCitation"]
                    art = med["Article"]
                    pmid  = str(med["PMID"])
                    title = str(art.get("ArticleTitle", ""))

                    # Abstract — may be structured (list) or a single string
                    abstract = ""
                    if "Abstract" in art:
                        ab = art["Abstract"].get("AbstractText", [])
                        if isinstance(ab, list):
                            abstract = " ".join(str(x) for x in ab)
                        else:
                            abstract = str(ab)

                    # Authors
                    authors: list[str] = []
                    for au in art.get("AuthorList", []):
                        ln = au.get("LastName", "")
                        fn = au.get("ForeName", au.get("Initials", ""))
                        if ln:
                            authors.append(f"{ln} {fn}".strip())

                    journal = str(art.get("Journal", {}).get("Title", ""))

                    # Year
                    year: int | None = None
                    pub_date = (
                        art.get("Journal", {})
                        .get("JournalIssue", {})
                        .get("PubDate", {})
                    )
                    if "Year" in pub_date:
                        try:
                            year = int(pub_date["Year"])
                        except (ValueError, TypeError):
                            pass

                    # DOI
                    doi: str | None = None
                    for id_obj in article.get("PubmedData", {}).get("ArticleIdList", []):
                        if id_obj.attributes.get("IdType") == "doi":
                            doi = str(id_obj)

                    # MeSH terms
                    mesh_terms: list[dict] = []
                    for mh in med.get("MeshHeadingList", []):
                        term = str(mh.get("DescriptorName", ""))
                        major = (
                            mh["DescriptorName"].attributes.get("MajorTopicYN", "N") == "Y"
                        )
                        if term:
                            mesh_terms.append({"term": term, "major": major})

                    pub_types = [str(pt) for pt in art.get("PublicationTypeList", [])]
                    ji = art.get("Journal", {}).get("JournalIssue", {})
                    volume = str(ji.get("Volume", ""))
                    issue  = str(ji.get("Issue", ""))
                    pages  = str(art.get("Pagination", {}).get("MedlinePgn", ""))

                    records.append({
                        "pmid": pmid, "title": title, "abstract": abstract,
                        "authors": authors, "journal": journal, "year": year,
                        "doi": doi, "mesh_terms": mesh_terms, "pub_types": pub_types,
                        "volume": volume, "issue": issue, "pages": pages,
                        "source": "pubmed",
                    })
                except Exception as exc:
                    logger.debug("PubMed record parse error: %s", exc)

        return records

    # Run blocking Entrez calls serialised through the semaphore
    sem = _get_entrez_sem()
    loop = asyncio.get_event_loop()
    async with sem:
        result = await loop.run_in_executor(None, _entrez_search_and_fetch, full_query)
        await asyncio.sleep(0.4)   # mandatory post-release gap (mirrors literature_engine)
    return result


# ── OpenAlex via pyalex (with httpx cursor-pagination fallback) ───────────────

async def search_openalex_sr(
    query: str,
    date_from: str = "",
    date_to: str = "",
    mailto: str = POLITE_EMAIL,
) -> list[dict]:
    """
    Search OpenAlex with cursor pagination.
    Tries the pyalex library first; falls back to httpx cursor pagination.
    """
    try:
        import pyalex  # type: ignore
        pyalex.config.email = mailto
        from pyalex import Works  # type: ignore
    except ImportError:
        logger.warning(
            "pyalex not installed; falling back to httpx for OpenAlex. pip install pyalex"
        )
        return await _search_openalex_httpx(query, date_from, date_to, mailto)

    def _pyalex_search() -> list[dict]:
        filters: dict = {"default.search": query}
        if date_from:
            filters["from_publication_date"] = date_from
        if date_to:
            filters["to_publication_date"] = date_to

        records: list[dict] = []
        try:
            for work in Works().filter(**filters).paginate(per_page=OA_PAGE, n_max=5000):
                rec = _openalex_work_to_dict(work)
                if rec:
                    records.append(rec)
        except Exception as exc:
            logger.warning("pyalex search error: %s", exc)
        return records

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _pyalex_search)


async def _search_openalex_httpx(
    query: str,
    date_from: str,
    date_to: str,
    mailto: str = POLITE_EMAIL,
) -> list[dict]:
    """OpenAlex via httpx cursor pagination — used when pyalex is unavailable."""
    records: list[dict] = []
    params: dict = {
        "search":   query,
        "per-page": str(OA_PAGE),
        "mailto":   mailto,
        "select": (
            "id,title,abstract_inverted_index,authorships,"
            "publication_year,doi,ids,open_access,"
            "primary_location,cited_by_count,type"
        ),
    }

    # Build filter string
    date_filters: list[str] = []
    if date_from:
        date_filters.append(f"from_publication_date:{date_from}")
    if date_to:
        date_filters.append(f"to_publication_date:{date_to}")
    if date_filters:
        params["filter"] = ",".join(date_filters)

    cursor = "*"
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        while cursor:
            try:
                params["cursor"] = cursor
                r = await _get(
                    client, f"{OA_BASE}/works", params,
                    source_label="OpenAlex-SR",
                )
                data = r.json()
                results = data.get("results", [])
                if not results:
                    break
                for work in results:
                    rec = _openalex_work_to_dict(work)
                    if rec:
                        records.append(rec)
                cursor = data.get("meta", {}).get("next_cursor") or ""
                if len(records) >= 5000:
                    break
            except Exception as exc:
                logger.warning("OpenAlex httpx search error: %s", exc)
                break
    return records


def _openalex_work_to_dict(work: dict) -> dict | None:
    """Convert an OpenAlex work object (dict or pyalex Work) to a paper dict."""
    try:
        # pyalex Work objects behave like dicts
        title = work.get("title", "") or ""
        if not title:
            return None

        abstract = reconstruct_abstract(work.get("abstract_inverted_index"))

        authors: list[str] = []
        for au in (work.get("authorships") or []):
            name = (au.get("author") or {}).get("display_name", "")
            if name:
                authors.append(name)

        year = work.get("publication_year")

        doi = work.get("doi", "") or ""
        if doi:
            doi = doi.replace("https://doi.org/", "").strip()

        ids = work.get("ids") or {}
        pmid = ids.get("pmid", "") or ""
        if pmid:
            pmid = str(pmid).replace(
                "https://pubmed.ncbi.nlm.nih.gov/", ""
            ).strip("/")

        oa      = work.get("open_access") or {}
        is_oa   = oa.get("is_oa", False)
        pdf_url = oa.get("oa_url", "")

        cited_by_count = work.get("cited_by_count", 0)
        w_type         = work.get("type", "")

        # Journal name from primary_location
        loc    = work.get("primary_location") or {}
        src    = loc.get("source") or {}
        journal = src.get("display_name") if isinstance(src, dict) else None

        return {
            "openalex_id":    work.get("id", ""),
            "title":          title,
            "abstract":       abstract,
            "authors":        authors,
            "year":           year,
            "doi":            doi or None,
            "pmid":           pmid or None,
            "journal":        journal,
            "is_oa":          is_oa,
            "pdf_url":        pdf_url or None,
            "cited_by_count": cited_by_count,
            "type":           w_type,
            "source":         "openalex",
        }
    except Exception:
        return None


# ── ClinicalTrials.gov v2 ─────────────────────────────────────────────────────

async def search_clinicaltrials_sr(
    query: str,
    condition: str = "",
) -> list[dict]:
    """
    Search ClinicalTrials.gov v2 API with pageToken pagination.
    Returns up to 5 000 study records as paper dicts.
    """
    records: list[dict] = []
    params: dict = {
        "query.term": query,
        "pageSize":   str(CT_PAGE),
        "format":     "json",
    }
    if condition:
        params["query.cond"] = condition

    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        next_token: str | None = None
        while True:
            try:
                if next_token:
                    params["pageToken"] = next_token
                elif "pageToken" in params:
                    del params["pageToken"]

                r = await _get(
                    client, f"{CT_BASE}/studies", params,
                    source_label="ClinicalTrials.gov-SR",
                )
                data = r.json()
                for study in data.get("studies", []):
                    rec = _ct_study_to_dict(study)
                    if rec:
                        records.append(rec)
                next_token = data.get("nextPageToken") or ""
                if not next_token or len(records) >= 5000:
                    break
            except Exception as exc:
                logger.warning("ClinicalTrials.gov search error: %s", exc)
                break
    return records


def _ct_study_to_dict(study: dict) -> dict | None:
    """Convert a ClinicalTrials.gov v2 study object to a paper dict."""
    try:
        proto    = study.get("protocolSection", {})
        id_mod   = proto.get("identificationModule", {})
        desc_mod = proto.get("descriptionModule", {})
        status_mod = proto.get("statusModule", {})
        cond_mod = proto.get("conditionsModule", {})
        sponsor_mod = proto.get("sponsorCollaboratorsModule", {})

        nct_id = id_mod.get("nctId", "")
        title  = id_mod.get("officialTitle", "") or id_mod.get("briefTitle", "")
        if not title:
            return None

        abstract = desc_mod.get("briefSummary", "")

        year: int | None = None
        start_date = (status_mod.get("startDateStruct") or {}).get("date", "")
        if start_date:
            try:
                year = int(start_date[:4])
            except (ValueError, TypeError):
                pass

        lead = (sponsor_mod.get("leadSponsor") or {}).get("name", "")
        authors = [lead] if lead else []

        return {
            "pmid":       None,
            "doi":        None,
            "nct_id":     nct_id,
            "title":      title,
            "abstract":   abstract,
            "authors":    authors,
            "journal":    "ClinicalTrials.gov",
            "year":       year,
            "conditions": cond_mod.get("conditions", []),
            "oa_pdf_url": f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else None,
            "source":     "clinicaltrials",
        }
    except Exception:
        return None


# ── ERIC ─────────────────────────────────────────────────────────────────────

async def search_eric_sr(
    query: str,
    date_from: str = "",
) -> list[dict]:
    """
    Search the ERIC education research database via the IES Solr API.
    Uses offset pagination; returns up to 2 000 records.
    """
    records: list[dict] = []
    fields = (
        "id,title,author,description,publicationdateyear,"
        "peerreviewed,iescitation,subject,publicationtype"
    )
    start = 0

    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        while True:
            try:
                params: dict = {
                    "search": query,
                    "fields": fields,
                    "format": "json",
                    "rows":   ERIC_PAGE,
                    "start":  start,
                }
                if date_from:
                    try:
                        yr = int(date_from[:4])
                        params["fq"] = f"publicationdateyear:[{yr} TO *]"
                    except (ValueError, TypeError):
                        pass

                r = await _get(
                    client, f"{ERIC_BASE}/", params,
                    source_label="ERIC-SR",
                )
                data = r.json()
                docs = data.get("response", {}).get("docs", [])
                if not docs:
                    break

                for doc in docs:
                    title = doc.get("title", "")
                    if not title:
                        continue
                    raw_authors = doc.get("author", [])
                    if isinstance(raw_authors, str):
                        authors_list = [raw_authors]
                    elif isinstance(raw_authors, list):
                        authors_list = [str(a) for a in raw_authors]
                    else:
                        authors_list = []
                    records.append({
                        "pmid":     None,
                        "doi":      None,
                        "eric_id":  doc.get("id", ""),
                        "title":    title,
                        "abstract": doc.get("description", ""),
                        "authors":  authors_list,
                        "year":     doc.get("publicationdateyear"),
                        "journal":  "",
                        "source":   "eric",
                    })

                total_found = data.get("response", {}).get("numFound", 0)
                start += ERIC_PAGE
                if start >= total_found or len(records) >= 2000:
                    break
            except Exception as exc:
                logger.warning("ERIC search error: %s", exc)
                break
    return records


# ── Semantic Scholar ──────────────────────────────────────────────────────────

async def search_semantic_scholar_sr(
    query: str,
    date_from: str = "",
    date_to: str = "",
) -> list[dict]:
    """
    Search Semantic Scholar.
    Tries the semanticscholar library first; falls back to httpx offset pagination.
    Year filtering is applied post-fetch when using the library (S2 API does not
    expose date range filters in the paper/search endpoint).
    """
    try:
        from semanticscholar import SemanticScholar  # type: ignore

        ss = SemanticScholar()
        fields = [
            "title", "abstract", "authors", "year",
            "externalIds", "publicationTypes",
            "journal", "citationCount", "openAccessPdf",
        ]

        year_from: int | None = None
        year_to:   int | None = None
        if date_from:
            try:
                year_from = int(date_from[:4])
            except (ValueError, TypeError):
                pass
        if date_to:
            try:
                year_to = int(date_to[:4])
            except (ValueError, TypeError):
                pass

        def _ss_search() -> list[dict]:
            records: list[dict] = []
            try:
                results = ss.search_paper(query, fields=fields, limit=500)
                for paper in results:
                    try:
                        # Apply year filter manually
                        yr = paper.year
                        if year_from and yr and yr < year_from:
                            continue
                        if year_to and yr and yr > year_to:
                            continue

                        authors = [
                            a["name"] for a in (paper.authors or [])
                            if isinstance(a, dict) and a.get("name")
                        ]
                        doi   = (paper.externalIds or {}).get("DOI")
                        pmid  = (paper.externalIds or {}).get("PubMed")
                        pdf_url = (
                            (paper.openAccessPdf or {}).get("url")
                            if paper.openAccessPdf
                            else None
                        )
                        journal_name = None
                        if paper.journal:
                            j = paper.journal
                            journal_name = j.get("name") if isinstance(j, dict) else str(j)

                        records.append({
                            "s2_id":          paper.paperId,
                            "title":          paper.title or "",
                            "abstract":       paper.abstract or "",
                            "authors":        authors,
                            "year":           yr,
                            "doi":            doi,
                            "pmid":           str(pmid) if pmid else None,
                            "journal":        journal_name,
                            "citation_count": paper.citationCount or 0,
                            "oa_pdf_url":     pdf_url,
                            "source":         "semantic_scholar",
                        })
                    except Exception:
                        pass
            except Exception as exc:
                logger.warning("semanticscholar library search error: %s", exc)
            return records

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _ss_search)

    except ImportError:
        logger.warning(
            "semanticscholar not installed; falling back to httpx. pip install semanticscholar"
        )
        return await _search_s2_httpx(query, date_from, date_to)


async def _search_s2_httpx(
    query: str,
    date_from: str = "",
    date_to: str = "",
) -> list[dict]:
    """Fallback: Semantic Scholar paper/search via httpx offset pagination."""
    records: list[dict] = []
    fields = (
        "title,abstract,authors,year,externalIds,"
        "journal,citationCount,openAccessPdf"
    )
    offset = 0

    year_from: int | None = None
    year_to:   int | None = None
    if date_from:
        try:
            year_from = int(date_from[:4])
        except (ValueError, TypeError):
            pass
    if date_to:
        try:
            year_to = int(date_to[:4])
        except (ValueError, TypeError):
            pass

    async with httpx.AsyncClient(headers=HEADERS, timeout=S2_TIMEOUT) as client:
        while True:
            try:
                r = await _get(
                    client,
                    f"{S2_BASE}/paper/search",
                    {"query": query, "fields": fields, "offset": offset, "limit": S2_PAGE},
                    max_retries=2,
                    base_wait=2.0,
                    source_label="Semantic Scholar (httpx)",
                )
                data   = r.json()
                papers = data.get("data", [])
                if not papers:
                    break
                for p in papers:
                    yr = p.get("year")
                    if year_from and yr and yr < year_from:
                        continue
                    if year_to and yr and yr > year_to:
                        continue
                    ext = p.get("externalIds") or {}
                    doi  = ext.get("DOI")
                    pmid = ext.get("PubMed")
                    oa   = p.get("openAccessPdf")
                    pdf_url = oa.get("url") if isinstance(oa, dict) else None
                    ji   = p.get("journal") or {}
                    journal_name = ji.get("name") if isinstance(ji, dict) else None
                    records.append({
                        "s2_id":          p.get("paperId", ""),
                        "title":          p.get("title", ""),
                        "abstract":       p.get("abstract", ""),
                        "authors":        [a.get("name", "") for a in p.get("authors", [])],
                        "year":           yr,
                        "doi":            doi,
                        "pmid":           str(pmid) if pmid else None,
                        "journal":        journal_name,
                        "citation_count": p.get("citationCount", 0),
                        "oa_pdf_url":     pdf_url,
                        "source":         "semantic_scholar",
                    })
                total = data.get("total", 0)
                if len(records) >= 500 or offset + S2_PAGE >= total:
                    break
                offset += S2_PAGE
                await asyncio.sleep(0.5)   # S2 rate limit — 100 req/5 min unauthenticated
            except Exception as exc:
                logger.warning("Semantic Scholar httpx error: %s", exc)
                break
    return records


# ── Query generation ──────────────────────────────────────────────────────────

async def generate_search_queries(
    pico: dict,
    databases: list[str],
    ai_provider: AIProvider,
) -> dict:
    """
    Generate database-specific Boolean search strings from PICO elements using AI.

    Returns a dict keyed by database name, e.g.:
    {"pubmed": "...", "openalex": "...", "semantic_scholar": "...", ...}
    """
    system = (
        "You are an expert systematic review librarian. "
        "Generate optimised Boolean search strings for each requested database.\n\n"
        "Use correct field codes and controlled vocabulary:\n"
        "- PubMed: [tiab] for title/abstract, [mesh] for MeSH terms. Use AND/OR/NOT.\n"
        "- Scopus: TITLE-ABS-KEY() fields, DOCTYPE(ar OR re), PUBYEAR > XXXX\n"
        "- OpenAlex: plain text search (no field codes)\n"
        "- Semantic Scholar: plain text search, simple terms\n"
        "- ClinicalTrials: plain text, focus on condition and intervention terms\n"
        "- ERIC: plain text, education-focused terms\n\n"
        "Return ONLY valid JSON with no prose, no markdown fences:\n"
        '{"pubmed": "...", "scopus": "...", "openalex": "...", '
        '"semantic_scholar": "...", "clinicaltrials": "...", "eric": "...", '
        '"embase_ovid": "...", "cochrane_central": "...", "who_ictrp": "..."}'
    )

    pico_text = (
        f"PICO:\n"
        f"Population: {pico.get('population', '')}\n"
        f"Intervention: {pico.get('intervention', '')}\n"
        f"Comparator: {pico.get('comparator', '')}\n"
        f"Outcome: {pico.get('outcome', '')}\n"
        f"Study Design: {pico.get('study_design', '')}\n"
        f"Date Range: {pico.get('date_from', '')} to {pico.get('date_to', '')}\n"
        f"Language: {pico.get('language_restriction', 'English')}\n"
        f"Health Area: {pico.get('health_area', '')}\n\n"
        f"Generate search strings for these databases: {', '.join(databases)}"
    )

    try:
        raw    = await ai_provider.complete(
            system=system, user=pico_text, json_mode=True, temperature=0.2
        )
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("AI returned non-dict JSON for query generation")
        return result
    except Exception as exc:
        logger.error("Query generation failed: %s", exc)
        # Fallback: build a simple free-text query from the most important PICO arms
        terms = " AND ".join(
            filter(None, [
                pico.get("population", ""),
                pico.get("intervention", ""),
                pico.get("outcome", ""),
            ])
        )
        return {db: terms for db in databases}


# ── Full SR search orchestrator ───────────────────────────────────────────────

async def run_full_sr_search(
    project_id: str,
    pico: dict,
    settings: dict,
    databases: list[str] | None = None,
    ai_provider: AIProvider | None = None,
) -> AsyncIterator[dict]:
    """
    Orchestrate a multi-database SR search.

    Async generator yielding SSE-ready event dicts as each stage completes.
    Saves deduplicated papers to the papers table and records a search run in
    sr_search_runs for PRISMA flow tracking.

    Parameters
    ----------
    project_id  : str      — project UUID
    pico        : dict     — keys: population, intervention, comparator, outcome,
                             study_design, date_from, date_to, language_restriction,
                             health_area
    settings    : dict     — keys: ncbi_api_key (opt), openalex_email (opt)
    databases   : list     — subset of ["pubmed","openalex","semantic_scholar",
                             "clinicaltrials","eric"]; defaults to first four
    ai_provider : AIProvider | None — if provided, AI-generated per-DB queries are used
    """
    from services.db import (         # deferred to avoid circular imports
        create_engine_async,
        papers as papers_table,
        sr_search_runs,
    )
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy import insert as sa_insert

    if databases is None:
        databases = ["pubmed", "openalex", "semantic_scholar", "clinicaltrials"]

    date_from       = pico.get("date_from", "")
    date_to         = pico.get("date_to", "")
    ncbi_api_key    = settings.get("ncbi_api_key", "")
    openalex_email  = settings.get("openalex_email", POLITE_EMAIL)

    # ── Step 1: AI query generation ───────────────────────────────────────────
    queries: dict = {}
    if ai_provider:
        try:
            yield {"type": "status", "message": "Generating database-specific search queries..."}
            queries = await generate_search_queries(pico, databases, ai_provider)
            yield {"type": "queries_generated", "queries": queries}
        except Exception as exc:
            yield {
                "type":    "warning",
                "message": f"Query generation failed, using basic PICO terms: {exc}",
            }

    # Fallback query — always available even when AI generation fails
    fallback_query = (
        " AND ".join(
            filter(None, [
                pico.get("population", ""),
                pico.get("intervention", ""),
                pico.get("outcome", ""),
            ])
        )
        or pico.get("population", "systematic review")
    )

    def get_query(db: str) -> str:
        return queries.get(db) or fallback_query

    # ── Step 2: Concurrent database searches ─────────────────────────────────
    search_tasks: dict[str, asyncio.coroutine] = {}  # type: ignore[type-arg]

    if "pubmed" in databases:
        search_tasks["pubmed"] = search_pubmed_sr(
            get_query("pubmed"), date_from, date_to, ncbi_api_key, openalex_email
        )
    if "openalex" in databases:
        search_tasks["openalex"] = search_openalex_sr(
            get_query("openalex"), date_from, date_to, openalex_email
        )
    if "semantic_scholar" in databases:
        search_tasks["semantic_scholar"] = search_semantic_scholar_sr(
            get_query("semantic_scholar"), date_from, date_to
        )
    if "clinicaltrials" in databases:
        search_tasks["clinicaltrials"] = search_clinicaltrials_sr(
            get_query("clinicaltrials"), pico.get("population", "")
        )
    if "eric" in databases:
        search_tasks["eric"] = search_eric_sr(
            get_query("eric"), date_from
        )

    yield {
        "type":    "status",
        "message": f"Searching {len(search_tasks)} database(s) concurrently...",
    }

    db_names         = list(search_tasks.keys())
    results_coros    = list(search_tasks.values())
    all_records:     list[dict] = []
    db_stats:        dict       = {}

    completed_results = await asyncio.gather(*results_coros, return_exceptions=True)

    for db_name, result in zip(db_names, completed_results):
        if isinstance(result, Exception):
            logger.warning("Database '%s' search failed: %s", db_name, result)
            yield {
                "type":    "source_error",
                "source":  db_name,
                "message": str(result),
            }
            db_stats[db_name] = {"hits": 0, "error": str(result)}
        else:
            count = len(result)
            all_records.extend(result)
            db_stats[db_name] = {"hits": count, "query": get_query(db_name)}
            yield {"type": "source_done", "source": db_name, "count": count}

    total_retrieved = len(all_records)
    yield {
        "type":    "status",
        "message": f"Total retrieved: {total_retrieved}. Running deduplication...",
    }

    # ── Step 3: Deduplication ─────────────────────────────────────────────────
    from services.sr_deduplicator import deduplicate  # type: ignore

    dedup_result   = deduplicate(all_records)
    unique_records = dedup_result["unique_records"]
    after_dedup    = len(unique_records)

    yield {
        "type":                "dedup_complete",
        "before":              total_retrieved,
        "after":               after_dedup,
        "removed":             dedup_result["stats"]["removed"],
        "flagged":             dedup_result["stats"].get("flagged", 0),
        "potential_duplicates": dedup_result.get("potential_duplicates", []),
    }

    # ── Step 4: Persist to DB ─────────────────────────────────────────────────
    yield {"type": "status", "message": "Saving results to database..."}

    eng        = create_engine_async()
    is_pg      = papers_table.c.data.type.__class__.__name__.lower() == "jsonb"

    async with eng.begin() as conn:
        # Save unique papers (skip on PK conflict — same paper_key already stored)
        for rec in unique_records:
            paper_key = (
                rec.get("doi") or (rec.get("title") or "")[:60]
            ).lower().strip()
            if not paper_key:
                continue

            data_payload = rec if is_pg else json.dumps(rec, ensure_ascii=False)
            try:
                if is_pg:
                    stmt = (
                        pg_insert(papers_table)
                        .values(
                            project_id=project_id,
                            paper_key=paper_key,
                            data=data_payload,
                        )
                        .on_conflict_do_nothing()
                    )
                else:
                    stmt = (
                        sa_insert(papers_table)
                        .values(
                            project_id=project_id,
                            paper_key=paper_key,
                            data=data_payload,
                        )
                        .prefix_with("OR IGNORE")
                    )
                await conn.execute(stmt)
            except Exception as exc:
                logger.debug("Paper insert skipped (duplicate?): %s", exc)

        # Build PRISMA identification counts for this search run
        prisma_counts = {
            "identified":          total_retrieved,
            "duplicates_removed":  dedup_result["stats"]["removed"],
            "screened":            0,
            "excluded_screening":  0,
            "sought_retrieval":    after_dedup,
            "not_retrieved":       0,
            "assessed_eligibility": 0,
            "excluded_fulltext":   0,
            "included":            0,
        }

        counts_payload   = prisma_counts if is_pg else json.dumps(prisma_counts)
        db_stats_payload = db_stats      if is_pg else json.dumps(db_stats)

        try:
            await conn.execute(
                sa_insert(sr_search_runs).values(
                    project_id         = project_id,
                    databases_searched = db_stats_payload,
                    total_retrieved    = total_retrieved,
                    after_dedup        = after_dedup,
                    prisma_counts      = counts_payload,
                    status             = "complete",
                )
            )
        except Exception as exc:
            logger.warning("sr_search_runs insert failed: %s", exc)

    # ── Step 5: Done ──────────────────────────────────────────────────────────
    yield {
        "type":            "complete",
        "total_retrieved": total_retrieved,
        "after_dedup":     after_dedup,
        "papers":          unique_records,
        "prisma_counts":   prisma_counts,
        "db_stats":        db_stats,
    }
