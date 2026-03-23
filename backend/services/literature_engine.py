"""
literature_engine.py

Concurrent, paginated integrations for:
  PubMed · PubMed Central · Crossref · OpenAlex · Semantic Scholar · Unpaywall

Rate-limit strategy (fixes for concurrent 429 errors)
───────────────────────────────────────────────────────
• Each source task gets its OWN httpx.AsyncClient — no shared connection pool.
• A per-engine asyncio.Semaphore(1) serialises ALL NCBI calls (PubMed + PMC
  share the same 3 req/s budget) with a mandatory 0.4 s gap between releases.
• _get() wraps every HTTP call with up to 4 retries and exponential back-off
  on 429 / 5xx responses, so transient rate-limit hits are recovered silently.
"""

import asyncio
import logging
import math
import re
import xml.etree.ElementTree as ET
from typing import AsyncIterator, Optional

import httpx

from models import Paper

logger = logging.getLogger(__name__)

# ── API base URLs ──────────────────────────────────────────────────────────────
NCBI_BASE        = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
OPENALEX_BASE    = "https://api.openalex.org"
S2_BASE          = "https://api.semanticscholar.org/graph/v1"
CROSSREF_BASE    = "https://api.crossref.org"
UNPAYWALL_BASE   = "https://api.unpaywall.org/v2"
EUROPE_PMC_BASE  = "https://www.ebi.ac.uk/europepmc/webservices/rest"
CT_BASE          = "https://clinicaltrials.gov/api/v2"
ARXIV_BASE       = "https://export.arxiv.org/api"
ATOM_NS          = "http://www.w3.org/2005/Atom"
ARXIV_NS         = "http://arxiv.org/schemas/atom"

POLITE_EMAIL = "academic-writer-agent@localhost.dev"
TIMEOUT    = httpx.Timeout(45.0, connect=10.0)
S2_TIMEOUT = httpx.Timeout(15.0, connect=6.0)   # S2 is notoriously slow; hard-cap it
HEADERS  = {
    "User-Agent": f"AcademicWriterAgent/0.2 (mailto:{POLITE_EMAIL})",
    "Accept": "application/json",
}
ARXIV_HEADERS = {
    "User-Agent": f"AcademicWriterAgent/0.2 (mailto:{POLITE_EMAIL})",
    "Accept": "application/atom+xml",
}

NCBI_BATCH       = 200   # max PMIDs per efetch call
S2_PAGE          = 100   # Semantic Scholar page size
OA_PAGE          = 200   # OpenAlex page size
CR_PAGE          = 1000  # Crossref rows per call
EUROPE_PMC_PAGE  = 200   # Europe PMC page size (max 1000; 200 for speed)
CT_PAGE          = 100   # ClinicalTrials.gov page size (max 1000)
ARXIV_PAGE       = 100   # arXiv max per request (hard limit; rate-limited)

# 8 sources total — each fetches candidate_per_source papers.
# With OVERSAMPLE_FACTOR=5 the pool before dedup is ~5× total_limit.
OVERSAMPLE_FACTOR = 5


class LiteratureEngine:

    def __init__(self, ncbi_api_key: Optional[str] = None) -> None:
        self.ncbi_api_key = ncbi_api_key
        # Serialises PubMed + PMC so they never both hit NCBI at the same time.
        # NCBI allows 3 req/s without a key; we stay comfortably under that.
        self._ncbi_sem: asyncio.Semaphore | None = None   # created lazily per event loop

    def _get_ncbi_sem(self) -> asyncio.Semaphore:
        """Lazily create the semaphore on the running event loop."""
        if self._ncbi_sem is None:
            self._ncbi_sem = asyncio.Semaphore(1)
        return self._ncbi_sem

    # ── Retry-aware GET ────────────────────────────────────────────────────────

    @staticmethod
    async def _get(
        client: httpx.AsyncClient,
        url: str,
        params: dict,
        *,
        headers: dict | None = None,
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
                r = await client.get(url, params=params, headers=headers)
                if r.status_code == 429:
                    # Honour server-supplied Retry-After if available
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
                logger.warning("%s request error (attempt %d): %s", source_label, attempt + 1, exc)
        raise RuntimeError(f"Max retries exceeded for {url}")

    @staticmethod
    def _build_arxiv_search_query(queries: list[str]) -> str:
        """
        Build an arXiv-compliant search_query string.

        arXiv expects explicit field prefixes, boolean operators, and quoted
        phrases. Free-text expanded queries are therefore converted to
        all:"..." phrase searches and combined with OR in a single request.
        """
        fielded_or_structured = re.compile(
            r"\b(?:all|ti|au|abs|co|jr|cat|rn|id|submittedDate|lastUpdatedDate):"
            r"|\b(?:AND|OR|ANDNOT)\b|[()\"]",
            flags=re.IGNORECASE,
        )

        built: list[str] = []
        seen: set[str] = set()
        for raw in queries:
            normalized = " ".join((raw or "").split())
            if not normalized:
                continue
            if fielded_or_structured.search(normalized):
                clause = normalized
            else:
                escaped = normalized.replace('"', "")
                clause = f'all:"{escaped}"'
            if clause.lower() in seen:
                continue
            seen.add(clause.lower())
            built.append(f"({clause})")
            if len(built) >= 4:
                break
        return " OR ".join(built)

    # ═══════════════════════════════════════════════════════════════════════════
    # Streaming entry point
    # ═══════════════════════════════════════════════════════════════════════════

    async def search_all_streaming(
        self,
        queries: list[str],
        total_limit: int,
        pubmed_queries: list[str] | None = None,
    ) -> AsyncIterator[dict]:
        """
        Async generator — yields SSE-ready dicts as each source finishes.

        Each source runs in its own task with its own httpx.AsyncClient so that
        connection pools and TLS sessions are fully isolated. NCBI calls are
        additionally serialised through self._ncbi_sem.
        """
        # Fetch OVERSAMPLE_FACTOR × more candidates so we can rank and pick
        # the truly best papers after cross-source deduplication.
        candidate_per_source = max(20, (total_limit * OVERSAMPLE_FACTOR) // 5)
        queue: asyncio.Queue[tuple] = asyncio.Queue()
        sem = self._get_ncbi_sem()

        # PubMed/PMC get their own MeSH/field-tagged queries when available;
        # other databases receive the general queries.
        ncbi_queries = pubmed_queries if pubmed_queries else queries

        async def run(name: str, search_coro_fn):
            """
            search_coro_fn: async callable (client) → list[Paper]
            Creates a private client, runs the search, pushes results to queue.
            """
            try:
                async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
                    papers = await search_coro_fn(client)
                await queue.put(("papers", name, papers))
            except Exception as exc:
                logger.warning("Source '%s' failed: %s", name, exc)
                await queue.put(("error", name, str(exc)))
            finally:
                await queue.put(("done", name, None))

        tasks = [
            asyncio.create_task(run("pubmed",            lambda c, q=ncbi_queries, n=candidate_per_source: self._pubmed_multi(c, q, n, sem))),
            asyncio.create_task(run("pmc",               lambda c, q=ncbi_queries, n=candidate_per_source: self._pmc_multi(c, q, n, sem))),
            asyncio.create_task(run("openalex",          lambda c, q=queries, n=candidate_per_source: self._openalex_multi(c, q, n))),
            asyncio.create_task(run("semantic_scholar",  lambda c, q=queries, n=candidate_per_source: self._s2_multi(c, q, n))),
            asyncio.create_task(run("crossref",          lambda c, q=queries, n=candidate_per_source: self._crossref_multi(c, q, n))),
            asyncio.create_task(run("europe_pmc",        lambda c, q=queries, n=candidate_per_source: self._europe_pmc_multi(c, q, n))),
            asyncio.create_task(run("clinical_trials",   lambda c, q=queries, n=candidate_per_source: self._clinical_trials_multi(c, q, n))),
            asyncio.create_task(run("arxiv",             lambda c, q=queries, n=candidate_per_source: self._arxiv_multi(c, q, n))),
        ]

        all_papers: list[Paper] = []
        completed = 0

        while completed < len(tasks):
            event_type, source, data = await queue.get()

            if event_type == "papers":
                all_papers.extend(data)
                yield {
                    "type": "papers",
                    "source": source,
                    "count": len(data),
                    "papers": [p.model_dump() for p in data],
                }
            elif event_type == "error":
                yield {"type": "source_error", "source": source, "message": data}
            elif event_type == "done":
                completed += 1
                yield {"type": "source_done", "source": source}

        await asyncio.gather(*tasks, return_exceptions=True)

        # ── Post-processing ────────────────────────────────────────────────────

        # 1. Deduplicate the full candidate pool
        unique = self._deduplicate(all_papers)
        yield {"type": "deduplicating", "before": len(all_papers), "after": len(unique)}

        # 2. Rank by citations + recency + richness and trim to the requested limit
        ranked = self._rank_and_trim(unique, total_limit)
        yield {
            "type": "ranking",
            "candidates": len(unique),
            "selected": len(ranked),
            "requested": total_limit,
        }

        # 3. Mandatory Unpaywall OA enrichment on the final selection
        yield {"type": "enriching"}
        async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
            enriched = await self._enrich_unpaywall(client, ranked)

        yield {"type": "complete", "total": len(enriched), "papers": [p.model_dump() for p in enriched]}

    # ═══════════════════════════════════════════════════════════════════════════
    # Legacy single-query search (used by /api/search_literature)
    # ═══════════════════════════════════════════════════════════════════════════

    async def search_all(self, query: str, max_per_source: int = 5) -> list[Paper]:
        sem = self._get_ncbi_sem()
        all_papers: list[Paper] = []

        async def one_source(search_fn):
            async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
                return await search_fn(client)

        results = await asyncio.gather(
            one_source(lambda c: self._pubmed_multi(c, [query], max_per_source, sem)),
            one_source(lambda c: self._pmc_multi(c, [query], max_per_source, sem)),
            one_source(lambda c: self._openalex_multi(c, [query], max_per_source)),
            one_source(lambda c: self._s2_multi(c, [query], max_per_source)),
            one_source(lambda c: self._crossref_multi(c, [query], max_per_source)),
            one_source(lambda c: self._europe_pmc_multi(c, [query], max_per_source)),
            one_source(lambda c: self._clinical_trials_multi(c, [query], max_per_source)),
            one_source(lambda c: self._arxiv_multi(c, [query], max_per_source)),
            return_exceptions=True,
        )
        for r in results:
            if not isinstance(r, BaseException):
                all_papers.extend(r)

        unique = self._deduplicate(all_papers)
        async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
            unique = await self._enrich_unpaywall(client, unique)

        unique.sort(key=lambda p: p.citation_count if p.citation_count is not None else -1, reverse=True)
        return unique

    # ═══════════════════════════════════════════════════════════════════════════
    # Multi-query wrappers
    # ═══════════════════════════════════════════════════════════════════════════

    async def _pubmed_multi(self, client, queries: list[str], total: int, sem: asyncio.Semaphore) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_pubmed(client, q, per_q, sem):
                key = p.pmid or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _pmc_multi(self, client, queries: list[str], total: int, sem: asyncio.Semaphore) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_pmc(client, q, per_q, sem):
                key = p.pmcid or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _openalex_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_openalex(client, q, per_q):
                key = (p.doi or "").lower() or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _s2_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_s2(client, q, per_q):
                key = (p.doi or "").lower() or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _crossref_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_crossref(client, q, per_q):
                key = (p.doi or "").lower() or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _europe_pmc_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_europe_pmc(client, q, per_q):
                key = (p.doi or "").lower() or p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _clinical_trials_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        seen: set[str] = set()
        out: list[Paper] = []
        per_q = max(total, total // max(len(queries), 1))
        for q in queries:
            for p in await self._search_clinical_trials(client, q, per_q):
                key = p.title[:60].lower()
                if key not in seen:
                    seen.add(key)
                    out.append(p)
            if len(out) >= total:
                break
        return out[:total]

    async def _arxiv_multi(self, client, queries: list[str], total: int) -> list[Paper]:
        search_query = self._build_arxiv_search_query(queries)
        if not search_query:
            return []
        return await self._search_arxiv(client, search_query, min(total, ARXIV_PAGE))

    # ═══════════════════════════════════════════════════════════════════════════
    # PubMed  (semaphore-protected, batched efetch)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_pubmed(
        self, client: httpx.AsyncClient, query: str, max_results: int, sem: asyncio.Semaphore
    ) -> list[Paper]:
        try:
            async with sem:
                r = await self._get(client, f"{NCBI_BASE}/esearch.fcgi", params={
                    "db": "pubmed", "term": query,
                    "retmax": min(max_results, 9999),
                    "retmode": "json", "sort": "relevance",
                    **({"api_key": self.ncbi_api_key} if self.ncbi_api_key else {}),
                }, source_label="PubMed-esearch")
                await asyncio.sleep(0.4)   # mandatory gap before releasing sem

            pmids: list[str] = r.json()["esearchresult"]["idlist"][:max_results]
            if not pmids:
                return []

            papers: list[Paper] = []
            for i in range(0, len(pmids), NCBI_BATCH):
                batch = pmids[i : i + NCBI_BATCH]
                async with sem:
                    r2 = await self._get(client, f"{NCBI_BASE}/efetch.fcgi", params={
                        "db": "pubmed", "id": ",".join(batch),
                        "rettype": "xml", "retmode": "xml",
                        **({"api_key": self.ncbi_api_key} if self.ncbi_api_key else {}),
                    }, source_label="PubMed-efetch")
                    await asyncio.sleep(0.4)
                papers.extend(self._parse_pubmed_xml(r2.text))
            return papers
        except Exception as exc:
            logger.error("PubMed error: %s", exc)
            return []

    def _parse_pubmed_xml(self, xml_text: str) -> list[Paper]:
        papers: list[Paper] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as exc:
            logger.error("PubMed XML parse error: %s", exc)
            return []
        for article in root.findall(".//PubmedArticle"):
            mc = article.find("MedlineCitation")
            if mc is None:
                continue
            title_el = mc.find(".//ArticleTitle")
            title = "".join(title_el.itertext()).strip() if title_el is not None else "Untitled"
            authors: list[str] = []
            for au in mc.findall(".//Author"):
                last = au.findtext("LastName", "")
                fore = au.findtext("ForeName", "") or au.findtext("Initials", "")
                name = f"{last}, {fore}".strip(", ")
                if name:
                    authors.append(name)
            abstract = " ".join(
                "".join(p.itertext()) for p in mc.findall(".//AbstractText")
            ).strip() or None
            journal = mc.findtext(".//Journal/Title") or mc.findtext(".//MedlineTA") or None
            year: Optional[int] = None
            ys = mc.findtext(".//PubDate/Year") or mc.findtext(".//PubDate/MedlineDate", "")
            if ys:
                try:
                    year = int(ys[:4])
                except ValueError:
                    pass
            pmid = mc.findtext("PMID")
            doi: Optional[str] = None
            pmcid: Optional[str] = None
            for aid in article.findall(".//ArticleId"):
                if aid.get("IdType") == "doi":
                    doi = aid.text
                elif aid.get("IdType") == "pmc":
                    pmcid = aid.text
            papers.append(Paper(
                title=title, authors=authors, abstract=abstract,
                doi=doi, pmid=pmid, pmcid=pmcid,
                year=year, journal=journal,
                citation_count=None, oa_pdf_url=None, source="pubmed",
            ))
        return papers

    # ═══════════════════════════════════════════════════════════════════════════
    # PubMed Central  (semaphore-protected)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_pmc(
        self, client: httpx.AsyncClient, query: str, max_results: int, sem: asyncio.Semaphore
    ) -> list[Paper]:
        try:
            async with sem:
                r = await self._get(client, f"{NCBI_BASE}/esearch.fcgi", params={
                    "db": "pmc",
                    "term": f"{query} AND open access[filter]",
                    "retmax": min(max_results, 9999),
                    "retmode": "json", "sort": "relevance",
                    **({"api_key": self.ncbi_api_key} if self.ncbi_api_key else {}),
                }, source_label="PMC-esearch")
                await asyncio.sleep(0.4)

            pmcids: list[str] = r.json().get("esearchresult", {}).get("idlist", [])[:max_results]
            if not pmcids:
                return []

            papers: list[Paper] = []
            for i in range(0, len(pmcids), NCBI_BATCH):
                batch = pmcids[i : i + NCBI_BATCH]
                async with sem:
                    r2 = await self._get(client, f"{NCBI_BASE}/efetch.fcgi", params={
                        "db": "pmc", "id": ",".join(batch),
                        "rettype": "xml", "retmode": "xml",
                        **({"api_key": self.ncbi_api_key} if self.ncbi_api_key else {}),
                    }, source_label="PMC-efetch")
                    await asyncio.sleep(0.4)
                papers.extend(self._parse_pmc_xml(r2.text, batch))
            return papers
        except Exception as exc:
            logger.error("PMC error: %s", exc)
            return []

    def _parse_pmc_xml(self, xml_text: str, pmcids: list[str]) -> list[Paper]:
        papers: list[Paper] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError as exc:
            logger.error("PMC XML parse error: %s", exc)
            return []
        for idx, article in enumerate(root.findall(".//article")):
            front = article.find("front")
            if front is None:
                continue
            meta = front.find("article-meta")
            jmeta = front.find("journal-meta")
            if meta is None:
                continue
            tg = meta.find("title-group")
            te = tg.find("article-title") if tg is not None else None
            title = "".join(te.itertext()).strip() if te is not None else "Untitled"
            authors: list[str] = []
            for c in meta.findall(".//contrib[@contrib-type='author']"):
                last = c.findtext(".//surname", "")
                first = c.findtext(".//given-names", "")
                if last:
                    authors.append(f"{last}, {first}".strip(", "))
            ae = meta.find(".//abstract")
            abstract = "".join(ae.itertext()).strip() if ae is not None else None
            doi: Optional[str] = None
            for aid in meta.findall(".//article-id"):
                if aid.get("pub-id-type") == "doi":
                    doi = aid.text
            year: Optional[int] = None
            pd = meta.find(".//pub-date")
            if pd is not None:
                ys = pd.findtext("year")
                if ys:
                    try:
                        year = int(ys)
                    except ValueError:
                        pass
            journal = jmeta.findtext(".//journal-title") if jmeta is not None else None
            raw_id = pmcids[idx] if idx < len(pmcids) else None
            pmcid = f"PMC{raw_id}" if raw_id else None
            oa_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{raw_id}/pdf/" if raw_id else None
            papers.append(Paper(
                title=title, authors=authors, abstract=abstract,
                doi=doi, pmid=None, pmcid=pmcid,
                year=year, journal=journal,
                citation_count=None, oa_pdf_url=oa_url, source="pmc",
            ))
        return papers

    # ═══════════════════════════════════════════════════════════════════════════
    # OpenAlex  (cursor pagination, no rate limit issues)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_openalex(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        try:
            papers: list[Paper] = []
            cursor = "*"
            while len(papers) < max_results:
                batch = min(OA_PAGE, max_results - len(papers))
                r = await self._get(client, f"{OPENALEX_BASE}/works", params={
                    "search": query, "per-page": batch,
                    "cursor": cursor, "mailto": POLITE_EMAIL,
                    "select": (
                        "id,title,authorships,abstract_inverted_index,doi,"
                        "publication_year,primary_location,cited_by_count,open_access"
                    ),
                }, source_label="OpenAlex")
                data = r.json()
                works = data.get("results", [])
                if not works:
                    break
                for w in works:
                    authors = [
                        a.get("author", {}).get("display_name", "")
                        for a in w.get("authorships", [])
                        if a.get("author")
                    ]
                    abstract = self._openalex_abstract(w.get("abstract_inverted_index"))
                    doi = w.get("doi", "")
                    if doi and doi.startswith("https://doi.org/"):
                        doi = doi[len("https://doi.org/"):]
                    oa = w.get("open_access") or {}
                    oa_url = oa.get("oa_url") if oa.get("is_oa") else None
                    loc = w.get("primary_location") or {}
                    src = loc.get("source") or {}
                    journal = src.get("display_name")
                    papers.append(Paper(
                        title=w.get("title") or "Untitled",
                        authors=authors, abstract=abstract or None, doi=doi or None,
                        pmid=None, pmcid=None, year=w.get("publication_year"),
                        journal=journal, citation_count=w.get("cited_by_count"),
                        oa_pdf_url=oa_url, source="openalex",
                    ))
                cursor = data.get("meta", {}).get("next_cursor")
                if not cursor:
                    break
            return papers[:max_results]
        except Exception as exc:
            logger.error("OpenAlex error: %s", exc)
            return []

    @staticmethod
    def _openalex_abstract(inv: Optional[dict]) -> str:
        if not inv:
            return ""
        pos = [(loc, word) for word, locs in inv.items() for loc in locs]
        pos.sort()
        return " ".join(w for _, w in pos)

    # ═══════════════════════════════════════════════════════════════════════════
    # Semantic Scholar  (offset pagination + retry for 429)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_s2(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        # S2 is notoriously slow — use a dedicated short-timeout client so it
        # never stalls the entire pipeline.  The caller's `client` is ignored.
        try:
            papers: list[Paper] = []
            offset = 0
            async with httpx.AsyncClient(headers=HEADERS, timeout=S2_TIMEOUT) as s2_client:
                while len(papers) < max_results:
                    batch = min(S2_PAGE, max_results - len(papers))
                    r = await self._get(s2_client, f"{S2_BASE}/paper/search", params={
                        "query": query, "limit": batch, "offset": offset,
                        "fields": "title,authors,abstract,year,externalIds,citationCount,journal,openAccessPdf",
                    }, max_retries=2, base_wait=2.0, source_label="Semantic Scholar")
                    items = r.json().get("data", [])
                    if not items:
                        break
                    for it in items:
                        authors = [a.get("name", "") for a in it.get("authors", [])]
                        ext = it.get("externalIds") or {}
                        doi = ext.get("DOI")
                        pmid_raw = ext.get("PubMed")
                        pmcid = ext.get("PubMedCentral")
                        oa = it.get("openAccessPdf")
                        oa_url = oa.get("url") if isinstance(oa, dict) else None
                        ji = it.get("journal") or {}
                        journal = ji.get("name") if isinstance(ji, dict) else None
                        papers.append(Paper(
                            title=it.get("title") or "Untitled",
                            authors=authors, abstract=it.get("abstract"),
                            doi=doi, pmid=str(pmid_raw) if pmid_raw else None, pmcid=pmcid,
                            year=it.get("year"), journal=journal,
                            citation_count=it.get("citationCount"),
                            oa_pdf_url=oa_url, source="semantic_scholar",
                        ))
                    if len(items) < batch:
                        break
                    offset += batch
            return papers[:max_results]
        except Exception as exc:
            logger.error("Semantic Scholar error: %s", exc)
            return []

    # ═══════════════════════════════════════════════════════════════════════════
    # Crossref  (offset pagination)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_crossref(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        try:
            papers: list[Paper] = []
            offset = 0
            while len(papers) < max_results:
                rows = min(CR_PAGE, max_results - len(papers))
                r = await self._get(client, f"{CROSSREF_BASE}/works", params={
                    "query": query, "rows": rows, "offset": offset,
                    "mailto": POLITE_EMAIL,
                    "select": "title,author,abstract,DOI,published,container-title,is-referenced-by-count",
                }, source_label="Crossref")
                items = r.json().get("message", {}).get("items", [])
                if not items:
                    break
                for it in items:
                    titles = it.get("title") or []
                    title = titles[0] if titles else "Untitled"
                    authors: list[str] = []
                    for a in it.get("author") or []:
                        name = f"{a.get('family', '')}, {a.get('given', '')}".strip(", ")
                        if name.strip(","):
                            authors.append(name)
                    abstract_raw = it.get("abstract", "")
                    abstract: Optional[str] = None
                    if abstract_raw:
                        try:
                            parsed = ET.fromstring(f"<root>{abstract_raw}</root>")
                            abstract = ET.tostring(parsed, method="text", encoding="unicode").strip() or None
                        except ET.ParseError:
                            abstract = abstract_raw or None
                    doi = it.get("DOI")
                    dp = (it.get("published") or {}).get("date-parts", [[]])[0]
                    year = dp[0] if dp else None
                    jls = it.get("container-title") or []
                    journal = jls[0] if jls else None
                    papers.append(Paper(
                        title=title, authors=authors, abstract=abstract, doi=doi,
                        pmid=None, pmcid=None, year=year, journal=journal,
                        citation_count=it.get("is-referenced-by-count"),
                        oa_pdf_url=None, source="crossref",
                    ))
                if len(items) < rows:
                    break
                offset += rows
            return papers[:max_results]
        except Exception as exc:
            logger.error("Crossref error: %s", exc)
            return []

    # ═══════════════════════════════════════════════════════════════════════════
    # Europe PMC  (cursor pagination, biomedical + preprints, no key needed)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_europe_pmc(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        try:
            papers: list[Paper] = []
            cursor = "*"
            while len(papers) < max_results:
                batch = min(EUROPE_PMC_PAGE, max_results - len(papers))
                params = {
                    "query":      query,
                    "format":     "json",
                    "pageSize":   batch,
                    "resultType": "core",
                    "cursorMark": cursor,
                    "sort":       "relevance",
                    "email":      POLITE_EMAIL,
                }
                r = await self._get(client, f"{EUROPE_PMC_BASE}/search", params=params,
                                    source_label="Europe PMC")
                data = r.json()
                # Europe PMC sets a JSESSIONID session cookie on the very first request
                # and returns {"version":"x.y"} with no resultList. Retry once so the
                # now-set cookie is sent and actual results are returned.
                if "resultList" not in data and data.get("hitCount") is not None:
                    r = await self._get(client, f"{EUROPE_PMC_BASE}/search", params=params,
                                        source_label="Europe PMC")
                    data = r.json()
                results = data.get("resultList", {}).get("result", [])
                if not results:
                    break
                for item in results:
                    author_string = item.get("authorString", "")
                    authors = [
                        a.strip().rstrip(".")
                        for a in author_string.split(",")
                        if a.strip()
                    ] if author_string else []

                    oa_url: Optional[str] = None
                    if item.get("isOpenAccess") == "Y":
                        for url_info in (item.get("fullTextUrlList") or {}).get("fullTextUrl", []):
                            if url_info.get("documentStyle") == "pdf":
                                oa_url = url_info.get("url")
                                break
                        if not oa_url:
                            urls = (item.get("fullTextUrlList") or {}).get("fullTextUrl", [])
                            oa_url = urls[0].get("url") if urls else None

                    year: Optional[int] = None
                    try:
                        year = int(item["pubYear"]) if item.get("pubYear") else None
                    except (ValueError, TypeError):
                        pass

                    pmcid = item.get("pmcid")
                    if pmcid and not pmcid.startswith("PMC"):
                        pmcid = f"PMC{pmcid}"

                    papers.append(Paper(
                        title=item.get("title") or "Untitled",
                        authors=authors,
                        abstract=item.get("abstractText") or None,
                        doi=item.get("doi") or None,
                        pmid=str(item["pmid"]) if item.get("pmid") else None,
                        pmcid=pmcid,
                        year=year,
                        journal=(
                            (item.get("journalInfo") or {}).get("journal", {}).get("title")
                            or item.get("journalTitle")
                            or None
                        ),
                        citation_count=item.get("citedByCount"),
                        oa_pdf_url=oa_url,
                        source="europe_pmc",
                    ))
                next_cursor = data.get("nextCursorMark")
                if not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
            return papers[:max_results]
        except Exception as exc:
            logger.error("Europe PMC error: %s", exc)
            return []

    # ═══════════════════════════════════════════════════════════════════════════
    # ClinicalTrials.gov v2  (grey literature — trials, no key needed)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_clinical_trials(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        try:
            papers: list[Paper] = []
            page_token: Optional[str] = None
            while len(papers) < max_results:
                batch = min(CT_PAGE, max_results - len(papers))
                params: dict = {
                    "query.term": query,
                    "pageSize":   batch,
                    "format":     "json",
                    "fields":     (
                        "NCTId,BriefTitle,OfficialTitle,BriefSummary,"
                        "OverallStatus,StartDateStruct,LeadSponsorName,Acronym"
                    ),
                }
                if page_token:
                    params["pageToken"] = page_token
                r = await self._get(client, f"{CT_BASE}/studies", params=params,
                                    source_label="ClinicalTrials.gov")
                data = r.json()
                studies = data.get("studies", [])
                if not studies:
                    break
                for study in studies:
                    proto = study.get("protocolSection", {})
                    ident  = proto.get("identificationModule", {})
                    status = proto.get("statusModule", {})
                    desc   = proto.get("descriptionModule", {})
                    sponsor = proto.get("sponsorCollaboratorsModule", {})

                    nct_id  = ident.get("nctId", "")
                    title   = ident.get("officialTitle") or ident.get("briefTitle") or "Untitled"
                    abstract = desc.get("briefSummary")
                    lead    = (sponsor.get("leadSponsor") or {}).get("name")
                    authors = [lead] if lead else []

                    year: Optional[int] = None
                    start = (status.get("startDateStruct") or {}).get("date", "")
                    try:
                        year = int(start[:4]) if start else None
                    except (ValueError, TypeError):
                        pass

                    papers.append(Paper(
                        title=title,
                        authors=authors,
                        abstract=abstract,
                        doi=None,
                        pmid=None,
                        pmcid=None,
                        year=year,
                        journal="ClinicalTrials.gov",
                        citation_count=None,
                        oa_pdf_url=f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else None,
                        source="clinical_trials",
                    ))
                page_token = data.get("nextPageToken")
                if not page_token:
                    break
            return papers[:max_results]
        except Exception as exc:
            logger.error("ClinicalTrials.gov error: %s", exc)
            return []

    # ═══════════════════════════════════════════════════════════════════════════
    # arXiv  (preprints — physics, CS, bio, stats; Atom XML; rate-limited)
    # ═══════════════════════════════════════════════════════════════════════════

    async def _search_arxiv(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[Paper]:
        # arXiv recommends a 3-second delay for repeated automated calls. We
        # avoid that fan-out by folding expanded queries into one request.
        try:
            fetch = min(max_results, ARXIV_PAGE)
            r = await self._get(client, f"{ARXIV_BASE}/query", params={
                "search_query": query,
                "start":        0,
                "max_results":  fetch,
                "sortBy":       "relevance",
                "sortOrder":    "descending",
            }, headers=ARXIV_HEADERS, max_retries=2, base_wait=3.0, source_label="arXiv")

            root = ET.fromstring(r.content)
            papers: list[Paper] = []
            for entry in root.findall(f"{{{ATOM_NS}}}entry"):
                title_el = entry.find(f"{{{ATOM_NS}}}title")
                title = " ".join((title_el.text or "Untitled").split()).strip() if title_el is not None else "Untitled"

                summary_el = entry.find(f"{{{ATOM_NS}}}summary")
                abstract = " ".join(summary_el.text.split()).strip() if summary_el is not None and summary_el.text else None

                authors = []
                for author_el in entry.findall(f"{{{ATOM_NS}}}author"):
                    name_el = author_el.find(f"{{{ATOM_NS}}}name")
                    if name_el is not None and name_el.text:
                        authors.append(name_el.text.strip())

                year: Optional[int] = None
                pub_el = entry.find(f"{{{ATOM_NS}}}published")
                if pub_el is not None and pub_el.text:
                    try:
                        year = int(pub_el.text[:4])
                    except (ValueError, TypeError):
                        pass

                oa_url: Optional[str] = None
                for link_el in entry.findall(f"{{{ATOM_NS}}}link"):
                    if link_el.get("type") == "application/pdf":
                        oa_url = link_el.get("href")
                        break

                doi: Optional[str] = None
                doi_el = entry.find(f"{{{ARXIV_NS}}}doi")
                if doi_el is not None and doi_el.text:
                    doi = doi_el.text.strip()

                papers.append(Paper(
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    doi=doi,
                    pmid=None,
                    pmcid=None,
                    year=year,
                    journal="arXiv",
                    citation_count=None,
                    oa_pdf_url=oa_url,
                    source="arxiv",
                ))
            return papers
        except Exception as exc:
            logger.error("arXiv error: %s", exc)
            return []

    # ═══════════════════════════════════════════════════════════════════════════
    # Unpaywall enrichment
    # ═══════════════════════════════════════════════════════════════════════════

    async def _enrich_unpaywall(self, client: httpx.AsyncClient, papers: list[Paper]) -> list[Paper]:
        indices = [i for i, p in enumerate(papers) if p.doi and not p.oa_pdf_url]
        if not indices:
            return papers
        results = await asyncio.gather(
            *[self._unpaywall_url(client, papers[i].doi) for i in indices],
            return_exceptions=True,
        )
        for i, result in zip(indices, results):
            if isinstance(result, str):
                papers[i] = papers[i].model_copy(update={"oa_pdf_url": result})
        return papers

    async def _unpaywall_url(self, client: httpx.AsyncClient, doi: str) -> Optional[str]:
        try:
            r = await client.get(f"{UNPAYWALL_BASE}/{doi}", params={"email": POLITE_EMAIL})
            r.raise_for_status()
            data = r.json()
            if data.get("is_oa"):
                best = data.get("best_oa_location") or {}
                return best.get("url_for_pdf") or best.get("url")
        except Exception:
            pass
        return None

    # ═══════════════════════════════════════════════════════════════════════════
    # Ranking
    # ═══════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _rank_and_trim(papers: list[Paper], limit: int) -> list[Paper]:
        """
        Score every paper and return the top `limit`.

        Score (0–1) = 0.60 × citation_score
                    + 0.30 × recency_score
                    + 0.07 × has_abstract
                    + 0.03 × has_oa_pdf

        citation_score  = log1p(citations) / log1p(max_citations)  — rewards highly cited work
        recency_score   = (year − min_year) / year_range            — rewards recent papers

        Papers without a year are treated as the oldest in the set.
        Papers without citations are treated as 0 citations but still ranked above
        those that would score lower on recency/richness.
        """
        if len(papers) <= limit:
            return papers

        max_cites = max((p.citation_count or 0) for p in papers) or 1
        years     = [p.year for p in papers if p.year]
        min_year  = min(years) if years else 2000
        max_year  = max(years) if years else 2024
        year_range = max(max_year - min_year, 1)

        def _score(p: Paper) -> float:
            cite_score = math.log1p(p.citation_count or 0) / math.log1p(max_cites)
            year_score = ((p.year or min_year) - min_year) / year_range
            return (
                cite_score * 0.60
                + year_score * 0.30
                + (0.07 if p.abstract else 0.0)
                + (0.03 if p.oa_pdf_url else 0.0)
            )

        return sorted(papers, key=_score, reverse=True)[:limit]

    # ═══════════════════════════════════════════════════════════════════════════
    # Deduplication
    # ═══════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _deduplicate(papers: list[Paper]) -> list[Paper]:
        """
        Two-pass deduplication:
          1. Papers WITH a DOI are deduplicated only by exact DOI match.
             We never drop a paper solely because another paper has a similar title;
             that would incorrectly merge distinct works that happen to share a long
             common title prefix (very common in medical literature).
          2. Papers WITHOUT a DOI are deduplicated by an 80-character title prefix
             against the full pool of already-accepted titles.  This catches the same
             paper appearing in multiple databases without a DOI.
        Papers are pre-sorted by "richness" so that the most complete record wins.
        """
        def richness(p: Paper) -> int:
            return bool(p.abstract) + (p.citation_count is not None) + bool(p.doi) + bool(p.oa_pdf_url)

        sorted_papers = sorted(papers, key=richness, reverse=True)
        seen_dois: set[str] = set()
        seen_titles: set[str] = set()   # titles of every accepted paper (for no-DOI dedup)
        unique: list[Paper] = []

        for p in sorted_papers:
            doi_key = p.doi.lower().strip() if p.doi else None
            title_key = p.title.lower().strip()[:80]

            if doi_key:
                # Has a DOI → deduplicate ONLY by DOI
                if doi_key in seen_dois:
                    continue
                seen_dois.add(doi_key)
            else:
                # No DOI → deduplicate by title prefix against all accepted papers
                if title_key in seen_titles:
                    continue

            seen_titles.add(title_key)
            unique.append(p)

        return unique
