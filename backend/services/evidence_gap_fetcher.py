"""
services/evidence_gap_fetcher.py

Stage 3 of the deep synthesis pipeline: Evidence Gap Auto-Fetch.

When claim normalization reveals thin evidence (<=1 paper supporting a claim),
this service automatically searches for and summarizes additional papers to
strengthen the evidence base before clustering.

Public API
----------
fetch_evidence_gaps(provider, claims, summaries, query, project_id, ...) → AutoFetchResult
"""

import asyncio
import json
import logging
import time
from typing import AsyncGenerator, Callable, Awaitable, Optional

from models import AutoFetchResult, NormalizedClaim, Paper, PaperSummary
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# Guardrails
MAX_THIN_CLAIMS = 5       # Max thin claims to process per run
MAX_PAPERS_PER_CLAIM = 5  # Max papers to fetch per thin claim
FETCH_TIMEOUT_SEC = 60    # Total wall time budget for auto-fetch


_QUERY_GEN_SYSTEM = """\
You are a systematic-review search specialist. Given evidence claims that \
lack sufficient supporting papers, generate targeted academic search queries \
to find additional evidence.

RULES:
1. Each query should be specific enough to find relevant empirical evidence.
2. Include population, outcome, and key terms from the claim.
3. Use academic search terms (not conversational language).
4. Output ONLY valid JSON — an array of query strings."""

_QUERY_GEN_USER = """\
Research question: {query}

The following claims need additional supporting evidence (currently supported by <=1 paper):
{thin_claims_json}

Generate ONE focused search query per claim. Return JSON array of strings:
["query for claim 1", "query for claim 2", ...]"""


def identify_thin_claims(
    claims: list[NormalizedClaim],
) -> list[NormalizedClaim]:
    """Identify claims with insufficient evidence (<=1 supporting paper, not high grade)."""
    thin: list[NormalizedClaim] = []
    for c in claims:
        if (
            len(c.source_paper_keys) <= 1
            and c.evidence_grade.lower() not in ("high",)
            and c.canonical_text.strip()
        ):
            thin.append(c)

    # Sort by fewest sources first, then limit
    thin.sort(key=lambda c: len(c.source_paper_keys))
    return thin[:MAX_THIN_CLAIMS]


async def _generate_search_queries(
    provider: AIProvider,
    thin_claims: list[NormalizedClaim],
    query: str,
) -> list[str]:
    """Generate targeted search queries for thin claims via LLM."""
    claims_compact = [
        {
            "canonical_text": c.canonical_text,
            "population": c.population,
            "outcome": c.outcome,
            "effect_direction": c.effect_direction,
            "source_paper_keys": c.source_paper_keys,
        }
        for c in thin_claims
    ]

    user_prompt = _QUERY_GEN_USER.format(
        query=query,
        thin_claims_json=json.dumps(claims_compact, indent=2),
    )

    try:
        raw = await provider.complete(
            system=_QUERY_GEN_SYSTEM,
            user=user_prompt,
            json_mode=True,
            temperature=0.2,
        )
        data = json.loads(raw)
        if isinstance(data, list):
            return [str(q) for q in data if isinstance(q, str) and q.strip()]
        if isinstance(data, dict):
            for key in ("queries", "search_queries", "results"):
                if isinstance(data.get(key), list):
                    return [str(q) for q in data[key] if isinstance(q, str)]
    except Exception as e:
        logger.warning("Search query generation failed: %s", e)

    return []


async def fetch_evidence_gaps(
    provider: AIProvider,
    claims: list[NormalizedClaim],
    existing_summaries: list[PaperSummary],
    query: str,
    project_id: str = "",
    fetch_settings: Optional[object] = None,
    progress_cb: Optional[Callable[[dict], Awaitable[None]]] = None,
) -> tuple[AutoFetchResult, list[PaperSummary]]:
    """
    Stage 3: Auto-fetch papers for thin claims.

    Returns:
        (AutoFetchResult, list of new PaperSummary objects)
    """
    from services.literature_engine import LiteratureEngine
    from services.paper_summarizer import summarize_paper

    result = AutoFetchResult()

    # Identify thin claims
    thin_claims = identify_thin_claims(claims)
    if not thin_claims:
        return result, []

    result.thin_claims_detected = len(thin_claims)

    if progress_cb:
        await progress_cb({
            "type": "auto_fetch_start",
            "thin_claims": len(thin_claims),
        })

    # Generate search queries
    queries = await _generate_search_queries(provider, thin_claims, query)
    if not queries:
        return result, []

    result.queries_generated = queries

    # Build set of existing DOIs/keys to skip duplicates
    existing_dois = set()
    existing_keys = set()
    for s in existing_summaries:
        existing_keys.add(s.paper_key)
        if s.bibliography.doi:
            existing_dois.add(s.bibliography.doi.lower())

    # Search for papers
    start_time = time.monotonic()
    engine = LiteratureEngine()
    all_new_papers: list[Paper] = []

    for search_query in queries:
        if time.monotonic() - start_time > FETCH_TIMEOUT_SEC:
            logger.info("Auto-fetch timeout reached after %ds", FETCH_TIMEOUT_SEC)
            break

        try:
            papers_found: list[Paper] = []
            async for event in engine.search_all_streaming(
                queries=[search_query],
                total_limit=MAX_PAPERS_PER_CLAIM,
            ):
                if event.get("type") == "complete":
                    papers_found = event.get("papers", [])

            # Dedup against existing project papers
            for p in papers_found:
                if p.doi and p.doi.lower() in existing_dois:
                    result.skipped_duplicate += 1
                    continue
                # Also check by title similarity (rough dedup)
                p_key = (p.doi or p.title[:60].lower().replace(" ", "_")).strip()
                if p_key in existing_keys:
                    result.skipped_duplicate += 1
                    continue
                all_new_papers.append(p)
                if p.doi:
                    existing_dois.add(p.doi.lower())
                existing_keys.add(p_key)

        except Exception as e:
            logger.warning("Auto-fetch search failed for query '%s': %s", search_query[:50], e)

    result.papers_found = len(all_new_papers)

    if not all_new_papers:
        return result, []

    if progress_cb:
        await progress_cb({
            "type": "auto_fetch_searching",
            "papers_found": len(all_new_papers),
            "queries": queries,
        })

    # Summarize new papers in parallel (with timeout guard)
    remaining_time = max(10, FETCH_TIMEOUT_SEC - (time.monotonic() - start_time))
    new_summaries: list[PaperSummary] = []

    async def _summarize_one(paper: Paper) -> Optional[PaperSummary]:
        try:
            summary = await summarize_paper(
                provider=provider,
                paper=paper,
                query=query,
                fetch_settings=fetch_settings,
                session_id=project_id,
            )
            return summary
        except Exception as e:
            logger.warning("Auto-fetch summarize failed for '%s': %s", paper.title[:50], e)
            return None

    # Run summarizations in parallel with timeout
    tasks = [_summarize_one(p) for p in all_new_papers[:MAX_THIN_CLAIMS * MAX_PAPERS_PER_CLAIM]]
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=remaining_time,
        )
        for r in results:
            if isinstance(r, PaperSummary):
                new_summaries.append(r)
                result.new_paper_keys.append(r.paper_key)
    except asyncio.TimeoutError:
        logger.info("Auto-fetch summarization timed out after %ds total", FETCH_TIMEOUT_SEC)

    result.papers_summarized = len(new_summaries)

    if progress_cb:
        await progress_cb({
            "type": "auto_fetch_complete",
            "papers_summarized": len(new_summaries),
            "new_paper_keys": result.new_paper_keys,
        })

    # Save new summaries to project DB
    if new_summaries and project_id:
        try:
            from services.project_repo import save_summary
            for s in new_summaries:
                await save_summary(project_id, s.paper_key, s.model_dump())
        except Exception as e:
            logger.warning("Failed to save auto-fetched summaries: %s", e)

    return result, new_summaries
