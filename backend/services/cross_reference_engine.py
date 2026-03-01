"""
cross_reference_engine.py

Fetch and summarize papers cited within the primary paper corpus,
building a deeper evidence base for manuscript writing.

Workflow (per depth level):
  1. Load all PaperSummary objects at depth=0 (or depth=N-1 for deeper runs)
  2. Collect all `cited_references` from each summary
  3. Deduplicate by DOI; skip any DOI already in the session
  4. Resolve each CitedReference → Paper object (CrossRef API or OpenAlex title search)
  5. Summarize each with summarize_paper() → PaperSummary(depth=N)
  6. Store in the summaries table; yield SSE progress events as an async generator

Usage:
  async for event in stream_cross_references(session_id, depth, provider, query, fs):
      yield _sse(event)
"""

from __future__ import annotations

import json as _json
import logging
import re
from collections import defaultdict
from typing import AsyncGenerator, Optional

import httpx

from models import CitedReference, Paper, PaperSummary
from services.ai_provider import AIProvider
from services.paper_fetcher import FetchSettings
from services.paper_summarizer import summarize_paper

logger = logging.getLogger(__name__)

_CROSSREF_WORKS = "https://api.crossref.org/works/{doi}"
_OPENALEX_WORKS = "https://api.openalex.org/works"
_S2_SEARCH     = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_FIELDS     = "paperId,title,authors,year,openAccessPdf,externalIds,abstract,venue,publicationVenue"
_TIMEOUT = httpx.Timeout(20.0, connect=8.0)
_HEADERS = {"User-Agent": "AcademicWriterAgent/0.2 (mailto:academic-writer@localhost.dev)"}


# ── Public entry point (async generator) ─────────────────────────────────────

async def stream_cross_references(
    session_id: str,
    depth: int,
    provider: AIProvider,
    query: str,
    fetch_settings: FetchSettings,
    engine=None,
) -> AsyncGenerator[dict, None]:
    """
    Async generator that yields SSE-ready event dicts.

    depth=1: follow citations of primary papers (depth=0)
    depth=2: also follow citations of the depth-1 papers

    Example:
        async for event in stream_cross_references(...):
            yield _sse(event)
    """
    from services.db import create_engine_async, summaries as summaries_table
    from services.project_repo import save_summary
    from sqlalchemy import select

    eng = engine or create_engine_async()

    # ── helpers ---------------------------------------------------------------

    async def _load_summaries_at_depth(target_depth: int) -> list[PaperSummary]:
        async with eng.connect() as conn:
            res = await conn.execute(
                select(summaries_table.c.paper_key, summaries_table.c.data)
                .where(summaries_table.c.project_id == session_id)
            )
            rows = res.fetchall()
        result: list[PaperSummary] = []
        for _, data_raw in rows:
            try:
                data = data_raw if isinstance(data_raw, dict) else _json.loads(data_raw)
                ps = PaperSummary.model_validate(data)
                if ps.depth == target_depth:
                    result.append(ps)
            except Exception as exc:
                logger.debug("Failed to parse summary: %s", exc)
        return result

    async def _existing_dois(up_to_depth: int) -> set[str]:
        """DOIs of papers already in the session up to (inclusive) up_to_depth."""
        async with eng.connect() as conn:
            res = await conn.execute(
                select(summaries_table.c.data)
                .where(summaries_table.c.project_id == session_id)
            )
            rows = res.fetchall()
        dois: set[str] = set()
        for (data_raw,) in rows:
            try:
                data = data_raw if isinstance(data_raw, dict) else _json.loads(data_raw)
                ps = PaperSummary.model_validate(data)
                if ps.depth <= up_to_depth:
                    doi = _normalise_doi(ps.bibliography.doi)
                    if doi:
                        dois.add(doi)
            except Exception:
                pass
        return dois

    async def _existing_summary_keys() -> set[str]:
        async with eng.connect() as conn:
            res = await conn.execute(
                select(summaries_table.c.paper_key)
                .where(summaries_table.c.project_id == session_id)
            )
            return {str(r[0]).strip().lower() for r in res if r[0]}

    # ── main loop ------------------------------------------------------------

    total_fetched_all = 0
    by_depth: dict[int, int] = {}
    existing_summary_keys = await _existing_summary_keys()

    for current_depth in range(1, depth + 1):
        source_depth = current_depth - 1
        source_summaries = await _load_summaries_at_depth(source_depth)

        if not source_summaries:
            yield {
                "type": "warning",
                "message": (
                    f"No depth-{source_depth} summaries found with introduction/discussion data. "
                    "Summarize papers with full text (PMC XML or PDF) before running cross-reference."
                ),
            }
            continue

        # Collect cited_references with provenance
        doi_map: dict[str, tuple[CitedReference, list[str]]] = {}
        no_doi_list: list[tuple[CitedReference, list[str]]] = []
        priority_score: dict[str, int] = defaultdict(int)
        claim_context: dict[str, list[str]] = defaultdict(list)
        priority_hits_intro = 0
        priority_hits_disc = 0

        for ps in source_summaries:
            intro_ids: set[str] = set()
            disc_ids: set[str] = set()
            claim_text_by_ref_id: dict[str, list[str]] = defaultdict(list)

            for claim in ps.introduction_claims:
                text = (claim.claim or claim.verbatim_quote or "").strip()
                if not text:
                    continue
                for rid in claim.cited_ref_ids:
                    nk = _norm_ref_id(rid)
                    if not nk:
                        continue
                    intro_ids.add(nk)
                    claim_text_by_ref_id[nk].append(f"Introduction support point: {text[:260]}")

            for insight in ps.discussion_insights:
                text = (insight.text or insight.verbatim_quote or "").strip()
                if not text:
                    continue
                for rid in insight.cited_ref_ids:
                    nk = _norm_ref_id(rid)
                    if not nk:
                        continue
                    disc_ids.add(nk)
                    claim_text_by_ref_id[nk].append(f"Discussion support point: {text[:260]}")

            for ref in ps.cited_references:
                ref_id_norm = _norm_ref_id(ref.ref_id)
                weight = 0
                if ref_id_norm and ref_id_norm in intro_ids:
                    weight += 3
                    priority_hits_intro += 1
                if ref_id_norm and ref_id_norm in disc_ids:
                    weight += 2
                    priority_hits_disc += 1

                doi = _normalise_doi(ref.doi)
                if doi:
                    if weight:
                        priority_score[f"doi:{doi}"] += weight
                        for snippet in claim_text_by_ref_id.get(ref_id_norm, []):
                            _append_unique_limited(claim_context[f"doi:{doi}"], snippet, limit=6)
                    if doi in doi_map:
                        doi_map[doi][1].append(ps.paper_key)
                    else:
                        doi_map[doi] = (ref, [ps.paper_key])
                else:
                    tk = _title_key(ref.title or ref.raw_text)
                    if tk and weight:
                        priority_score[f"title:{tk}"] += weight
                        for snippet in claim_text_by_ref_id.get(ref_id_norm, []):
                            _append_unique_limited(claim_context[f"title:{tk}"], snippet, limit=6)
                    no_doi_list.append((ref, [ps.paper_key]))

        # Deduplicate no-DOI refs by title
        title_seen: set[str] = set()
        unique_no_doi: list[tuple[CitedReference, list[str]]] = []
        for ref, by_keys in no_doi_list:
            tk = _title_key(ref.title or ref.raw_text)
            if tk and tk not in title_seen:
                title_seen.add(tk)
                unique_no_doi.append((ref, by_keys))

        candidates = list(doi_map.values()) + unique_no_doi
        existing = await _existing_dois(up_to_depth=source_depth)

        to_process: list[tuple[CitedReference, list[str]]] = []
        already_skipped = 0
        for ref, by_keys in candidates:
            doi = _normalise_doi(ref.doi)
            if doi and doi in existing:
                already_skipped += 1
            else:
                to_process.append((ref, by_keys))

        def _candidate_rank(item: tuple[CitedReference, list[str]]) -> tuple[int, int]:
            ref, by_keys = item
            doi = _normalise_doi(ref.doi)
            if doi:
                score = priority_score.get(f"doi:{doi}", 0)
            else:
                score = priority_score.get(f"title:{_title_key(ref.title or ref.raw_text) or ''}", 0)
            return (score, len(set(by_keys)))

        to_process.sort(key=_candidate_rank, reverse=True)

        yield {
            "type": "start",
            "depth": current_depth,
            "total_cited": len(candidates),
            "to_process": len(to_process),
            "skipped_already_in_session": already_skipped,
            "priority_intro_hits": priority_hits_intro,
            "priority_discussion_hits": priority_hits_disc,
        }

        fetched = 0
        failed = 0

        for i, (ref, by_keys) in enumerate(to_process):
            ref_label = _ref_label(ref)

            yield {
                "type": "resolving",
                "depth": current_depth,
                "ref": ref_label,
                "index": i + 1,
                "total": len(to_process),
            }

            paper = await _resolve_cited_ref(ref)
            if paper is None:
                yield {
                    "type": "skip",
                    "depth": current_depth,
                    "reason": "unresolvable",
                    "ref": ref_label,
                }
                failed += 1
                continue

            # Normalize the resolved DOI so it matches stored paper_keys (which strip
            # "https://doi.org/" prefixes).  CrossRef returns full URL-form DOIs.
            _resolved_doi = _normalise_doi(paper.doi)
            resolved_key = _resolved_doi or (paper.title[:60]).lower().strip()
            if resolved_key in existing_summary_keys:
                yield {
                    "type": "skip",
                    "depth": current_depth,
                    "reason": "already_in_session",
                    "ref": ref_label,
                }
                already_skipped += 1
                continue

            try:
                doi = _normalise_doi(ref.doi) or _resolved_doi
                ckey = f"doi:{doi}" if doi else f"title:{_title_key(ref.title or paper.title) or ''}"
                focus_notes = claim_context.get(ckey, [])
                query_for_ref = _build_ref_query(query, focus_notes)

                summary = await summarize_paper(
                    provider,
                    paper,
                    query_for_ref,
                    fetch_settings=fetch_settings,
                    session_id=session_id,
                )
                summary = summary.model_copy(update={
                    "depth": current_depth,
                    "cited_by_keys": list(set(by_keys)),
                })

                # Second guard: summarize_paper may compute a paper_key that differs
                # from resolved_key (e.g. when paper has no DOI → title-based key).
                # Avoid overwriting an existing primary-paper summary.
                if summary.paper_key.lower().strip() in existing_summary_keys:
                    yield {
                        "type": "skip",
                        "depth": current_depth,
                        "reason": "already_in_session",
                        "ref": ref_label,
                    }
                    already_skipped += 1
                    continue

                await save_summary(session_id, summary.paper_key, summary.model_dump())
                existing_summary_keys.add(summary.paper_key.lower().strip())

                fetched += 1
                total_fetched_all += 1

                yield {
                    "type": "paper_done",
                    "depth": current_depth,
                    "paper_key": summary.paper_key,
                    "title": paper.title,
                    "text_source": summary.text_source,
                    "triage_decision": summary.triage.decision,
                    "one_line_takeaway": summary.one_line_takeaway or "",
                    "focus_notes": focus_notes[:3],  # intro/discussion claims that drove this fetch
                    "success": True,
                    "index": i + 1,
                    "total": len(to_process),
                }

            except Exception as exc:
                logger.warning("Failed to summarize cross-ref %r: %s", ref_label, exc)
                yield {
                    "type": "paper_done",
                    "depth": current_depth,
                    "paper_key": "",
                    "title": paper.title,
                    "success": False,
                    "error": str(exc),
                    "index": i + 1,
                    "total": len(to_process),
                }
                failed += 1

        by_depth[current_depth] = fetched

        yield {
            "type": "depth_complete",
            "depth": current_depth,
            "fetched": fetched,
            "failed": failed,
        }

    yield {
        "type": "complete",
        "total_fetched": total_fetched_all,
        "by_depth": {str(k): v for k, v in by_depth.items()},
    }


# ── Cross-reference stats ─────────────────────────────────────────────────────

async def get_cross_reference_stats(project_id: str, engine=None) -> dict:
    session_id = project_id  # alias
    """Return paper counts grouped by depth for the given session."""
    from services.db import create_engine_async, summaries as summaries_table
    from sqlalchemy import select

    eng = engine or create_engine_async()
    by_depth: dict[int, int] = {}
    total = 0

    async with eng.connect() as conn:
        res = await conn.execute(
            select(summaries_table.c.data)
            .where(summaries_table.c.project_id == session_id)
        )
        rows = res.fetchall()

    for (data_raw,) in rows:
        try:
            data = data_raw if isinstance(data_raw, dict) else _json.loads(data_raw)
            d = int(data.get("depth", 0))
            by_depth[d] = by_depth.get(d, 0) + 1
            total += 1
        except Exception:
            pass

    return {
        "total": total,
        "by_depth": {str(k): v for k, v in sorted(by_depth.items())},
    }


# ── Resolve CitedReference → Paper ───────────────────────────────────────────

async def _resolve_cited_ref(ref: CitedReference) -> Optional[Paper]:
    """Resolve a CitedReference to a Paper object.

    Resolution order:
    1. CrossRef DOI lookup (fastest, most accurate when DOI is present)
    2. OpenAlex full-text title search (good journal coverage)
    3. Semantic Scholar title search (better for conference proceedings; returns OA PDFs)
    4. Minimal stub from available metadata (allows abstract-only summarisation)
    """
    doi = _normalise_doi(ref.doi)
    if doi:
        paper = await _crossref_lookup(doi)
        if paper:
            return paper

    # Derive the best available title for searching
    title = ref.title or _extract_title_from_raw(ref.raw_text)

    if title and len(title) > 10:
        paper = await _openalex_title_search(title)
        if paper:
            return paper

        # Semantic Scholar: especially useful for conference proceedings (ICIS, NeurIPS, …)
        # that may not be in OpenAlex, and often provides open-access PDF URLs.
        paper = await _semantic_scholar_search(title, year=ref.year, authors=ref.authors)
        if paper:
            return paper

    # Minimal fallback — lets the pipeline attempt an abstract-only summarisation
    # using whatever metadata the LLM extracted from the reference list.
    if ref.title or ref.raw_text:
        return Paper(
            title=ref.title or ref.raw_text[:120],
            authors=ref.authors or [],
            year=ref.year,
            journal=ref.journal,
            doi=doi,
            abstract=None,
            source="cited_reference",
        )

    return None


async def _crossref_lookup(doi: str) -> Optional[Paper]:
    try:
        async with httpx.AsyncClient(headers=_HEADERS, timeout=_TIMEOUT) as client:
            r = await client.get(
                _CROSSREF_WORKS.format(doi=doi),
                params={"mailto": "academic-writer@localhost.dev"},
            )
            if r.status_code != 200:
                return None
            item = r.json().get("message", {})

        authors = []
        for a in item.get("author", []):
            if a.get("family") and a.get("given"):
                authors.append(f"{a['family']}, {a['given']}")
            elif a.get("family"):
                authors.append(a["family"])
            elif a.get("literal"):
                authors.append(a["literal"])

        year = None
        parts = item.get("issued", {}).get("date-parts", [[]])
        if parts and parts[0]:
            year = parts[0][0]

        titles = item.get("title", [])
        title = titles[0] if titles else ""
        journals = item.get("container-title", [])
        journal = journals[0] if journals else None

        oa_url = None
        for link in item.get("link", []):
            if "pdf" in link.get("content-type", "").lower() or link.get("URL", "").endswith(".pdf"):
                oa_url = link["URL"]
                break

        return Paper(
            title=title or doi,
            authors=authors,
            year=year,
            journal=journal,
            doi=doi,
            abstract=item.get("abstract"),
            oa_pdf_url=oa_url,
            source="crossref",
        )
    except Exception as exc:
        logger.debug("CrossRef lookup failed for DOI %s: %s", doi, exc)
        return None


async def _openalex_title_search(title: str) -> Optional[Paper]:
    try:
        async with httpx.AsyncClient(headers=_HEADERS, timeout=_TIMEOUT) as client:
            r = await client.get(
                _OPENALEX_WORKS,
                params={
                    "search": title,
                    "per_page": 1,
                    "mailto": "academic-writer@localhost.dev",
                },
            )
            if r.status_code != 200:
                return None
            results = r.json().get("results", [])
            if not results:
                return None
            item = results[0]

        authors = [
            a.get("author", {}).get("display_name", "")
            for a in item.get("authorships", [])[:6]
        ]
        doi = _normalise_doi(item.get("doi"))
        journal = item.get("primary_location", {}).get("source", {}).get("display_name")
        abstract_inv = item.get("abstract_inverted_index")
        oa_url = item.get("primary_location", {}).get("pdf_url")

        abstract_text: Optional[str] = None
        if isinstance(abstract_inv, dict):
            pos_word = sorted(
                (pos, w) for w, positions in abstract_inv.items() for pos in positions
            )
            abstract_text = " ".join(w for _, w in pos_word)

        return Paper(
            title=item.get("display_name") or title,
            authors=[a for a in authors if a],
            year=item.get("publication_year"),
            journal=journal,
            doi=doi,
            abstract=abstract_text,
            oa_pdf_url=oa_url,
            source="openalex",
        )
    except Exception as exc:
        logger.debug("OpenAlex title search failed for %r: %s", title[:40], exc)
        return None


async def _semantic_scholar_search(
    title: str,
    year: Optional[int] = None,
    authors: Optional[list[str]] = None,
) -> Optional[Paper]:
    """Search Semantic Scholar by title (+ optional year filter).

    Particularly useful for conference proceedings (ICIS, NeurIPS, CHI, …) that
    may not be indexed in OpenAlex or CrossRef with a DOI.  S2 often provides
    open-access PDF URLs via the openAccessPdf field.
    """
    try:
        # Build query: title words + first author surname if available
        query_parts = [title[:180]]
        if authors:
            first_surname = re.split(r"[,\s]", authors[0])[0].strip()
            if first_surname:
                query_parts.append(first_surname)
        query = " ".join(query_parts)

        async with httpx.AsyncClient(headers=_HEADERS, timeout=_TIMEOUT) as client:
            r = await client.get(
                _S2_SEARCH,
                params={"query": query, "limit": 5, "fields": _S2_FIELDS},
            )
            if r.status_code != 200:
                return None
            results = r.json().get("data", [])
            if not results:
                return None

        # Prefer a result whose year matches the reference
        item = results[0]
        if year:
            for candidate in results:
                if candidate.get("year") == year:
                    item = candidate
                    break

        # Extract DOI from externalIds
        ext = item.get("externalIds") or {}
        doi = _normalise_doi(ext.get("DOI") or ext.get("doi"))

        # Open-access PDF URL
        oa_pdf_info = item.get("openAccessPdf") or {}
        oa_url = oa_pdf_info.get("url") or None

        # Journal / venue
        pub_venue = item.get("publicationVenue") or {}
        journal = pub_venue.get("name") or item.get("venue") or None

        s2_authors = [
            a.get("name", "") for a in (item.get("authors") or [])[:6]
        ]

        return Paper(
            title=item.get("title") or title,
            authors=[a for a in s2_authors if a],
            year=item.get("year"),
            journal=journal,
            doi=doi,
            abstract=item.get("abstract"),
            oa_pdf_url=oa_url,
            source="semantic_scholar",
        )
    except Exception as exc:
        logger.debug("Semantic Scholar search failed for %r: %s", title[:40], exc)
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalise_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    doi = doi.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:", "DOI: ", "DOI:"):
        if doi.lower().startswith(prefix.lower()):
            doi = doi[len(prefix):]
    doi = doi.strip().lower()
    return doi if doi.startswith("10.") else None


def _norm_ref_id(ref_id: Optional[str]) -> Optional[str]:
    """Normalise a citation key so numbered and author-year styles both match.

    • Numbered style   "[1]"  → "1"
    • Author-year style "[Gnewuch et al. 2017]" → "gnewuch et al. 2017"
    Spaces are preserved so that "gnewuch et al. 2017" matches itself on both sides.
    """
    if not ref_id:
        return None
    s = str(ref_id).strip().lower()
    if not s:
        return None
    # Remove only bracket chars; collapse internal whitespace but keep it
    s = re.sub(r"[\[\]\(\)]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def _append_unique_limited(items: list[str], value: str, limit: int = 6) -> None:
    if not value or value in items:
        return
    if len(items) < limit:
        items.append(value)


def _build_ref_query(base_query: str, focus_notes: list[str]) -> str:
    """Give the summarizer context on why this cited paper matters for writing."""
    parts: list[str] = []
    if (base_query or "").strip():
        parts.append(f"Research question: {base_query.strip()}")
    if focus_notes:
        parts.append("Priority support points from source papers:")
        parts.extend(f"- {n}" for n in focus_notes[:6])
        parts.append(
            "Focus on extracting results and conclusions relevant to these support points, "
            "including exact numbers/effect sizes when reported."
        )
    return "\n".join(parts) if parts else "Cross-reference evidence extraction for manuscript support claims."


def _title_key(title: Optional[str]) -> Optional[str]:
    if not title:
        return None
    return re.sub(r"[^\w]", "", title.lower())[:60]


def _ref_label(ref: CitedReference) -> str:
    parts = []
    if ref.authors:
        parts.append(re.split(r"[,\s]", ref.authors[0])[0])
    if ref.year:
        parts.append(str(ref.year))
    if ref.title:
        parts.append(ref.title[:60])
    elif ref.raw_text:
        parts.append(ref.raw_text[:60])
    return " — ".join(parts) if parts else ref.ref_id or "unknown"


def _extract_title_from_raw(raw_text: Optional[str]) -> Optional[str]:
    """Extract the paper title from a raw formatted citation string.

    Handles multiple citation formats:
    • APA/Harvard: "Gnewuch, U., Morana, S., & Maedche, A. (2017). Towards designing..."
    • Vancouver:   "1. Smith J, Jones A. Title of the paper. J Med. 2019;..."
    • Chicago:     "Smith, John. 'Title of paper.' Journal Name 12 (2019): 1–20."
    • IEEE:        "[1] J. Smith and A. Jones, 'Title of paper,' in Conf. Proc., 2019."
    """
    if not raw_text:
        return None

    # APA / Harvard: Authors (Year). Title. → capture text between "). " and next "."
    m = re.search(r'\(\d{4}[a-z]?\)\.\s+(.+?)\.', raw_text)
    if m:
        candidate = m.group(1).strip()
        if len(candidate) > 15:
            return candidate

    # IEEE / conference: 'Title of paper,' or "Title of paper,"
    m = re.search(r"['\u201c](.+?)[',\u201d]", raw_text)
    if m:
        candidate = m.group(1).strip()
        if len(candidate) > 15:
            return candidate

    # Vancouver / generic: "Authors. Title. Journal Year" — second sentence fragment
    parts = raw_text.split(". ", 3)
    if len(parts) >= 2:
        candidate = parts[1].strip()
        # Skip if it looks like a journal/venue rather than a title
        if len(candidate) > 15 and not re.match(r'^(In|vol|pp|doi|http)', candidate, re.I):
            return candidate

    # Last resort: first 120 chars
    return raw_text[:120].strip()
