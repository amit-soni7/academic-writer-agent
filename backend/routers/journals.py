"""
routers/journals.py

  GET /api/journal-style?name={name}  — look up citation style for a journal

Returns JournalStyleResponse with citation style, accepted article types,
reference format name, confidence, and source tier.
"""

from fastapi import APIRouter, Query

from models import JournalStyleResponse
from services.journal_style_service import JournalStyleService
from services.auth import get_current_user
from fastapi import Depends

router = APIRouter(prefix="/api", tags=["journals"])

# Module-level service instance (no DB engine needed for cached reads;
# the engine is injected at startup if journal_style_cache table is available)
_style_service = JournalStyleService()


@router.get("/journal-style", response_model=JournalStyleResponse)
async def get_journal_style(
    name: str = Query(..., min_length=1, description="Journal name to look up"),
    publisher: str = Query(default="", description="Optional publisher name for fallback inference"),
    user=Depends(get_current_user),
) -> JournalStyleResponse:
    """
    Look up citation style, accepted article types, and formatting rules
    for a given journal name.

    Uses a 4-tier lookup:
      1. Curated table (instant, confidence 1.0)
      2. Publisher-based default (confidence 0.8)
      3. LLM inference — not called from this endpoint (requires provider)
      4. Universal fallback — AMA/NLM (confidence 0.5)
    """
    style = await _style_service.get_style(
        journal_name=name.strip(),
        provider=None,  # No LLM inference from lookup endpoint (no user provider here)
        publisher=publisher.strip() or None,
    )

    return JournalStyleResponse(
        journal_name=style.journal_name,
        citation_style=style.citation_style.value,
        in_text_format=style.in_text_format,
        reference_sort_order=style.reference_sort_order,
        accepted_article_types=style.accepted_article_types,
        max_references=style.max_references,
        abstract_structure=style.abstract_structure,
        abstract_word_limit=style.abstract_word_limit,
        word_limits=style.word_limits,
        sections_by_type=style.sections_by_type,
        reference_format_name=style.reference_format_name,
        source=style.source,
        confidence=style.confidence,
    )
