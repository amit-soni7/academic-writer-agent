"""
routers/projects.py

Project lifecycle endpoints:

  POST   /api/projects                              – create project from search results
  GET    /api/projects                              – list all projects (metadata)
  GET    /api/projects/{id}                         – load full project
  DELETE /api/projects/{id}                         – delete project
  PATCH  /api/projects/{id}/name                    – update project name

  POST /api/projects/{id}/summarize_all             – SSE: auto-summarize all papers
  POST /api/projects/{id}/recommend_journals        – run journal recommendation pipeline
  POST /api/projects/{id}/synthesize                – cross-paper synthesis
  POST /api/projects/{id}/generate_title            – generate title suggestions
  POST /api/projects/{id}/approve_title             – approve a manuscript title
  POST /api/projects/{id}/write_article             – SSE: stream generated article
  POST /api/projects/{id}/write_article_sync        – sync article generation
  POST /api/projects/{id}/peer_review               – peer review report
  POST /api/projects/{id}/revise_after_review       – revision after review
"""

import json
import logging
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from models import (
    ApproveTitleRequest,
    CreateProjectRequest,
    GenerateTitleRequest,
    JournalRecommendation,
    PeerReviewReport,
    ProjectMeta,
    ReviseAfterReviewRequest,
    RevisionResult,
    SummarizeAllRequest,
    SynthesisResult,
    TitleSuggestions,
    WriteArticleRequest,
)
from services.journal_style_service import (
    JournalStyleService,
    JournalStyle,
)
from routers.settings import load_settings, load_settings_for_user
from services.auth import get_current_user
from fastapi import Depends
from services.ai_provider import AIProvider
from services.project_repo import (
    create_project,
    delete_project,
    get_existing_summary_keys,
    list_projects,
    load_project,
    save_article,
    save_article_type,
    save_journal_recs,
    save_manuscript_title,
    save_summary,
    slugify_project_name,
    update_project_name,
    update_project_phase,
)
from services.title_generator import (
    TitleSuggestions as _TitleSuggestions,
    build_summaries_snapshot,
    generate_title_suggestions,
)
from services.article_builder import (
    ARTICLE_SECTIONS as _ARTICLE_SECTIONS_SVC,
    build_summary_block as _build_summary_block_svc,
    build_article_prompt as _build_article_prompt_svc,
)
from services.cross_paper_synthesizer import synthesize
from services.journal_recommender import recommend_journals
from services.paper_fetcher import FetchSettings
from services.paper_summarizer import summarize_paper
from services.peer_reviewer import generate_peer_review
from services.revision_writer import generate_revision_package

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["projects"])


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _get_provider_for_user(user_id: str) -> AIProvider | None:
    cfg = await load_settings_for_user(user_id)
    if cfg.api_key or cfg.provider in ("ollama", "llamacpp"):
        return AIProvider(cfg)
    # For Gemini: try OAuth token if no API key is stored
    if cfg.provider == "gemini":
        from services.gemini_oauth import get_valid_gemini_access_token
        token = await get_valid_gemini_access_token(user_id)
        if token:
            cfg.gemini_oauth_access_token = token
            return AIProvider(cfg)
    logger.warning(
        "No usable AI provider for user %s (provider=%r, has_api_key=%s). "
        "User may not have saved settings or key decryption failed.",
        user_id, cfg.provider, cfg.has_api_key,
    )
    return None


async def _fetch_settings_for_user(user_id: str, project_folder: str | None = None) -> FetchSettings:
    cfg = await load_settings_for_user(user_id)
    return FetchSettings(
        pdf_save_enabled=cfg.pdf_save_enabled or bool(project_folder),
        pdf_save_path=cfg.pdf_save_path,
        project_folder=project_folder,
        sci_hub_enabled=cfg.sci_hub_enabled,
        http_proxy=cfg.http_proxy,
    )


# ── Request/Response models ────────────────────────────────────────────────────

class UpdateProjectNameRequest(BaseModel):
    project_name: str


# ── Project CRUD ──────────────────────────────────────────────────────────────

@router.post("/projects", response_model=ProjectMeta)
async def create_project_endpoint(payload: CreateProjectRequest, user=Depends(get_current_user)) -> ProjectMeta:
    """Create a new research project scoped to the current user."""
    papers_dicts = [p.model_dump() for p in payload.papers]
    cfg = await load_settings_for_user(user["id"])
    project_id = await create_project(
        user["id"], payload.query, papers_dicts,
        article_type=payload.article_type,
        project_description=payload.project_description,
        pdf_save_path=cfg.pdf_save_path,
        project_name=payload.project_name,
    )
    # Update phase to 'literature' now that project is created
    await update_project_phase(project_id, 'literature')
    meta = await load_project(user["id"], project_id) or {}
    return ProjectMeta(
        project_id=project_id,
        query=payload.query,
        created_at=str(meta.get("created_at", "")),
        updated_at=str(meta.get("updated_at", "")),
        paper_count=len(payload.papers),
        summary_count=0,
        has_journals=False,
        has_article=False,
        manuscript_title=None,
        article_type=payload.article_type,
        project_name=meta.get("project_name"),
        project_description=meta.get("project_description"),
        project_folder=meta.get("project_folder"),
        current_phase='literature',
    )


@router.get("/projects", response_model=list[ProjectMeta])
async def list_projects_endpoint(user=Depends(get_current_user)) -> list[ProjectMeta]:
    items = await list_projects(user["id"])
    return [ProjectMeta(**{
        "project_id": s["project_id"],
        "query": s.get("query", ""),
        "created_at": str(s.get("created_at", "")),
        "updated_at": str(s.get("updated_at", "")),
        "paper_count": int(s.get("paper_count", 0)),
        "summary_count": int(s.get("summary_count", 0)),
        "has_journals": bool(s.get("has_journals", False)),
        "has_article": bool(s.get("has_article", False)),
        "manuscript_title": s.get("manuscript_title"),
        "article_type": s.get("article_type"),
        "project_name": s.get("project_name"),
        "project_description": s.get("project_description"),
        "project_folder": s.get("project_folder"),
        "current_phase": s.get("current_phase", "intake"),
    }) for s in items]


@router.get("/projects/{project_id}")
async def get_project(project_id: str, user=Depends(get_current_user)) -> dict:
    data = await load_project(user["id"], project_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return data


@router.delete("/projects/{project_id}")
async def delete_project_endpoint(project_id: str, user=Depends(get_current_user)) -> dict:
    ok = await delete_project(user["id"], project_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"status": "deleted", "project_id": project_id}


@router.patch("/projects/{project_id}/name")
async def update_project_name_endpoint(
    project_id: str,
    body: UpdateProjectNameRequest,
    user=Depends(get_current_user),
) -> dict:
    """Rename a project and rename its folder on disk."""
    # Verify ownership
    proj = await load_project(user["id"], project_id)
    if proj is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    new_folder = await update_project_name(project_id, body.project_name)
    return {
        "project_id": project_id,
        "project_name": body.project_name,
        "project_folder": new_folder,
    }


# ── Auto-summarize all papers (SSE) ──────────────────────────────────────────

@router.post("/projects/{project_id}/summarize_all")
async def summarize_all(project_id: str, payload: SummarizeAllRequest, user=Depends(get_current_user)) -> StreamingResponse:
    """
    SSE stream that summarises papers one by one, saving each to the DB.

    Event types:
      progress      – { current, total, title }
      summary_done  – { paper_key, summary }
      paper_error   – { title, message }
      complete      – { project_id, done, errors }
    """
    effective_project_id = project_id
    project = await load_project(user["id"], project_id)
    if project is None:
        # Auto-create project if it doesn't exist yet
        papers_dicts = [p.model_dump() for p in payload.papers]
        cfg = await load_settings_for_user(user["id"])
        effective_project_id = await create_project(
            user["id"], payload.query, papers_dicts,
            pdf_save_path=cfg.pdf_save_path,
        )
        project = await load_project(user["id"], effective_project_id) or {}

    project_folder = project.get("project_folder")

    async def generate():
        provider = await _get_provider_for_user(user["id"])
        if not provider:
            yield _sse({"type": "error", "message": "No AI provider configured. Open Settings first."})
            return

        fs = await _fetch_settings_for_user(user["id"], project_folder)
        papers = payload.papers
        done = 0
        errors = 0

        existing_keys = await get_existing_summary_keys(effective_project_id)

        for i, paper in enumerate(papers):
            paper_key = (paper.doi or paper.title[:60]).lower().strip()

            if paper_key in existing_keys:
                yield _sse({
                    "type": "progress",
                    "current": i + 1,
                    "total": len(papers),
                    "title": paper.title[:80],
                    "skipped": True,
                })
                done += 1
                continue

            yield _sse({
                "type": "progress",
                "current": i + 1,
                "total": len(papers),
                "title": paper.title[:80],
                "skipped": False,
            })

            try:
                summary = await summarize_paper(
                    provider, paper, payload.query,
                    fetch_settings=fs, session_id=effective_project_id,
                )
                summary_dict = summary.model_dump()
                await save_summary(effective_project_id, summary.paper_key, summary_dict)
                done += 1
                yield _sse({
                    "type": "summary_done",
                    "paper_key": summary.paper_key,
                    "summary": summary_dict,
                })
            except Exception as exc:
                errors += 1
                logger.warning("Summarise failed for %r: %s", paper.title[:40], exc)
                yield _sse({
                    "type": "paper_error",
                    "title": paper.title[:60],
                    "message": str(exc),
                })

        yield _sse({
            "type": "complete",
            "project_id": effective_project_id,
            "session_id": effective_project_id,  # backward-compat
            "done": done,
            "errors": errors,
            "total": len(papers),
        })

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ── Journal recommendations ────────────────────────────────────────────────────

@router.post("/projects/{project_id}/recommend_journals",
             response_model=list[JournalRecommendation])
async def recommend_journals_endpoint(project_id: str, user=Depends(get_current_user)) -> list[JournalRecommendation]:
    """Build journal recommendations from the project's papers."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    from models import Paper
    papers = [Paper(**p) for p in project.get("papers", [])]
    query  = project.get("query", "")

    provider = await _get_provider_for_user(user["id"])
    recs = await recommend_journals(provider, papers, query)

    recs_dicts = [r.model_dump() for r in recs]
    await save_journal_recs(project_id, recs_dicts)
    await update_project_phase(project_id, 'journals')

    return recs


# ── Title quality policy ──────────────────────────────────────────────────────

_TITLE_REQUIRED_MSG = (
    "TITLE_REQUIRED: Please provide or approve a manuscript title before proceeding."
)


@router.post("/projects/{project_id}/generate_title", response_model=TitleSuggestions)
async def generate_title_endpoint(
    project_id: str,
    payload: GenerateTitleRequest,
    user=Depends(get_current_user),
) -> TitleSuggestions:
    """Generate 1 best + 5 alternative manuscript title candidates."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured. Open Settings first.")

    query = project.get("query", "")
    project_summaries = list(project.get("summaries", {}).values())
    snapshot = build_summaries_snapshot(project_summaries) if project_summaries else ""

    suggestions = await generate_title_suggestions(
        provider=provider,
        query=query,
        article_type=payload.article_type,
        journal=payload.selected_journal,
        summaries_snapshot=snapshot,
    )
    return TitleSuggestions(
        best_title=suggestions.best_title,
        best_title_rationale=suggestions.best_title_rationale,
        alternatives=[
            {"title": a.title, "rationale": a.rationale}
            for a in suggestions.alternatives
        ],
        quality_notes=suggestions.quality_notes,
    )


@router.post("/projects/{project_id}/approve_title")
async def approve_title_endpoint(
    project_id: str,
    payload: ApproveTitleRequest,
    user=Depends(get_current_user),
) -> dict:
    """Save the approved manuscript title and update project name."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title must not be empty.")

    await save_manuscript_title(project_id, title)

    # Update project name from approved title (slugified) — renames folder on disk too
    clean_name = slugify_project_name(title, max_len=80)
    if clean_name:
        await update_project_name(project_id, clean_name)

    return {"status": "approved", "manuscript_title": title}


# ── Article writer system prompt ──────────────────────────────────────────────

_ARTICLE_SYSTEM_BASE = """\
You are an expert academic writer producing a high-impact, reviewer-ready manuscript.

FORMATTING RULES — apply these rigorously:
1. Write each paragraph using CEILS structure internally:
   C (Claim) → E (Evidence) → I (Interpretation) → L (Limitation) → S (So what / implication)
   You do NOT need to label C/E/I/L/S explicitly — the paragraph should flow naturally
   but cover these elements in order.

2. Tag EVERY factual sentence with one of:
   [CK]         — common knowledge / established fact needing no citation
   [CITE:key]   — fact from a specific paper; replace "key" with the paper_key
   [INF]        — your synthesis inference across papers (not directly stated in any single paper)

3. Grounding rules:
   - NEVER write a claim without a tag.
   - [CITE:key] requires the fact to appear in that paper's extracted evidence.
   - [INF] must be a reasonable synthesis of multiple [CITE:key] facts — not speculation.
   - Use "not reported in the available evidence" rather than fabricating statistics.

4. Format:
   - Markdown with ## section headers.
   - Use [Author, Year] inline citation style alongside [CITE:key].
   - Example: "CBT reduced PHQ-9 scores (d=0.52) [CITE:smith2023] (Smith et al., 2023)."

5. Do NOT fabricate any effect sizes, p-values, sample sizes, or quotes not in the summaries.
"""

_ARTICLE_SECTIONS = _ARTICLE_SECTIONS_SVC
_journal_style_service = JournalStyleService()


def _get_publisher_from_project(project: dict) -> str | None:
    journal_recs_list = project.get("journal_recs") or []
    if isinstance(journal_recs_list, list) and journal_recs_list:
        first = journal_recs_list[0]
        if isinstance(first, dict):
            return first.get("publisher")
    return None


def _build_summary_block(project_summaries: list[dict]) -> str:
    return _build_summary_block_svc(project_summaries)


async def _build_article_prompt(
    project: dict,
    payload: WriteArticleRequest,
    journal_style: JournalStyle,
    manuscript_title: str,
    article_type_override: str | None = None,
) -> tuple[str, str]:
    return await _build_article_prompt_svc(
        session=project,
        article_type=article_type_override or payload.article_type,
        selected_journal=payload.selected_journal,
        word_limit=payload.word_limit,
        journal_style=journal_style,
        manuscript_title=manuscript_title,
        base_system=_ARTICLE_SYSTEM_BASE,
        max_references=payload.max_references,
    )


# ── Article writer (SSE) ──────────────────────────────────────────────────────

@router.post("/projects/{project_id}/write_article")
async def write_article(project_id: str, payload: WriteArticleRequest, user=Depends(get_current_user)) -> StreamingResponse:
    """SSE stream that generates a full academic article from saved summaries."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    manuscript_title = (project.get("manuscript_title") or "").strip()
    if not manuscript_title:
        raise HTTPException(status_code=400, detail=_TITLE_REQUIRED_MSG)

    project_summaries = list(project.get("summaries", {}).values())
    if not project_summaries:
        raise HTTPException(status_code=400, detail="No summaries found. Run summarize_all first.")

    effective_article_type = payload.article_type or project.get("article_type") or "review"

    async def generate():
        provider = await _get_provider_for_user(user["id"])
        if not provider:
            yield _sse({"type": "error", "message": "No AI provider configured."})
            return

        await save_article_type(project_id, effective_article_type)

        publisher = _get_publisher_from_project(project)
        journal_style = await _journal_style_service.get_style(
            journal_name=payload.selected_journal,
            provider=provider,
            publisher=publisher,
        )

        effective_system, user_msg = await _build_article_prompt(
            project, payload, journal_style, manuscript_title,
            article_type_override=effective_article_type,
        )

        try:
            article_text = await provider.complete(
                system=effective_system,
                user=user_msg,
                json_mode=False,
                temperature=0.4,
            )
            if manuscript_title and not article_text.lstrip().startswith(f"# {manuscript_title}"):
                article_text = f"# {manuscript_title}\n\n{article_text}"
            await save_article(project_id, article_text, payload.selected_journal)
            await update_project_phase(project_id, 'article')
            cited_keys = set(re.findall(r'\[CITE:([^\]]+)\]', article_text))
            yield _sse({
                "type": "complete",
                "project_id": project_id,
                "session_id": project_id,  # backward-compat
                "article": article_text,
                "word_count": len(article_text.split()),
                "ref_count": len(cited_keys),
                "ref_limit": payload.max_references,
                "word_limit": payload.word_limit,
            })
        except Exception as exc:
            logger.exception("Article generation failed")
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Article writer (sync JSON variant) ───────────────────────────────────────

@router.post("/projects/{project_id}/write_article_sync")
async def write_article_sync(project_id: str, payload: WriteArticleRequest, user=Depends(get_current_user)) -> dict:
    """Non-streaming variant that returns { article, word_count } as JSON."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    manuscript_title_sync = (project.get("manuscript_title") or "").strip()
    if not manuscript_title_sync:
        raise HTTPException(status_code=400, detail=_TITLE_REQUIRED_MSG)

    project_summaries = list(project.get("summaries", {}).values())
    if not project_summaries:
        raise HTTPException(status_code=400, detail="No summaries found. Run summarize_all first.")

    effective_article_type_sync = payload.article_type or project.get("article_type") or "review"
    await save_article_type(project_id, effective_article_type_sync)

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    publisher = _get_publisher_from_project(project)
    journal_style = await _journal_style_service.get_style(
        journal_name=payload.selected_journal,
        provider=provider,
        publisher=publisher,
    )

    effective_system, user_msg = await _build_article_prompt(
        project, payload, journal_style, manuscript_title_sync,
        article_type_override=effective_article_type_sync,
    )

    article_text = await provider.complete(
        system=effective_system,
        user=user_msg,
        json_mode=False,
        temperature=0.4,
    )
    if manuscript_title_sync and not article_text.lstrip().startswith(f"# {manuscript_title_sync}"):
        article_text = f"# {manuscript_title_sync}\n\n{article_text}"
    await save_article(project_id, article_text, payload.selected_journal)
    await update_project_phase(project_id, 'article')
    cited_keys_sync = set(re.findall(r'\[CITE:([^\]]+)\]', article_text))
    return {
        "article":    article_text,
        "word_count": len(article_text.split()),
        "ref_count":  len(cited_keys_sync),
        "ref_limit":  payload.max_references,
        "word_limit": payload.word_limit,
    }


# ── Cross-paper synthesis ──────────────────────────────────────────────────────

@router.post("/projects/{project_id}/synthesize", response_model=SynthesisResult)
async def synthesize_papers(project_id: str, user=Depends(get_current_user)) -> SynthesisResult:
    """Run cross-paper evidence synthesis across all summaries saved for this project."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    summaries_raw = project.get("summaries", {})
    if not summaries_raw:
        raise HTTPException(status_code=400, detail="No summaries found. Run summarize_all first.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured. Open Settings first.")

    from models import PaperSummary as PS
    project_summaries = [PS(**v) for v in summaries_raw.values()]
    query = project.get("query", "")

    result = await synthesize(provider, project_summaries, query)
    await update_project_phase(project_id, 'cross_reference')
    return result


# ── Peer review ────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/peer_review", response_model=PeerReviewReport)
async def peer_review(project_id: str, user=Depends(get_current_user)) -> PeerReviewReport:
    """Generate a rigorous peer-review report from the project's evidence and saved article."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    summaries_raw = project.get("summaries", {})
    if not summaries_raw:
        raise HTTPException(status_code=400, detail="No summaries found. Run summarize_all first.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured. Open Settings first.")

    from models import PaperSummary as PS
    project_summaries = [PS(**v) for v in summaries_raw.values()]
    query   = project.get("query", "")
    article = project.get("article", "") or ""

    report = await generate_peer_review(provider, project_summaries, query, article)
    return report


# ── Revision after peer review ────────────────────────────────────────────────

@router.post("/projects/{project_id}/revise_after_review", response_model=RevisionResult)
async def revise_after_review(
    project_id: str,
    payload: ReviseAfterReviewRequest,
    user=Depends(get_current_user),
) -> RevisionResult:
    """Rewrite manuscript using peer-review feedback and generate a point-by-point reply."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    summaries_raw = project.get("summaries", {})
    if not summaries_raw:
        raise HTTPException(status_code=400, detail="No summaries found. Run summarize_all first.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured. Open Settings first.")

    from models import PaperSummary as PS
    project_summaries = [PS(**v) for v in summaries_raw.values()]
    query = project.get("query", "")

    result = await generate_revision_package(
        provider=provider,
        summaries=project_summaries,
        query=query,
        article=payload.article or (project.get("article") or ""),
        review=payload.review,
        journal=payload.selected_journal or (project.get("selected_journal") or ""),
    )
    if result.revised_article.strip():
        await save_article(project_id, result.revised_article, payload.selected_journal or (project.get("selected_journal") or ""))
    return result


# ── Backward-compatible session aliases ────────────────────────────────────────
# These let old /api/sessions/... URLs still work while frontend migrates

@router.post("/sessions", response_model=ProjectMeta)
async def create_session_compat(payload: CreateProjectRequest, user=Depends(get_current_user)) -> ProjectMeta:
    return await create_project_endpoint(payload, user)

@router.get("/sessions", response_model=list[ProjectMeta])
async def list_sessions_compat(user=Depends(get_current_user)) -> list[ProjectMeta]:
    return await list_projects_endpoint(user)

@router.get("/sessions/{project_id}")
async def get_session_compat(project_id: str, user=Depends(get_current_user)) -> dict:
    return await get_project(project_id, user)

@router.delete("/sessions/{project_id}")
async def delete_session_compat(project_id: str, user=Depends(get_current_user)) -> dict:
    result = await delete_project_endpoint(project_id, user)
    # Return session_id for backward compat
    return {"status": "deleted", "session_id": project_id, "project_id": project_id}

@router.post("/sessions/{project_id}/summarize_all")
async def summarize_all_compat(project_id: str, payload: SummarizeAllRequest, user=Depends(get_current_user)) -> StreamingResponse:
    return await summarize_all(project_id, payload, user)

@router.post("/sessions/{project_id}/recommend_journals", response_model=list[JournalRecommendation])
async def recommend_journals_compat(project_id: str, user=Depends(get_current_user)) -> list[JournalRecommendation]:
    return await recommend_journals_endpoint(project_id, user)

@router.post("/sessions/{project_id}/generate_title", response_model=TitleSuggestions)
async def generate_title_compat(project_id: str, payload: GenerateTitleRequest, user=Depends(get_current_user)) -> TitleSuggestions:
    return await generate_title_endpoint(project_id, payload, user)

@router.post("/sessions/{project_id}/approve_title")
async def approve_title_compat(project_id: str, payload: ApproveTitleRequest, user=Depends(get_current_user)) -> dict:
    return await approve_title_endpoint(project_id, payload, user)

@router.post("/sessions/{project_id}/write_article")
async def write_article_compat(project_id: str, payload: WriteArticleRequest, user=Depends(get_current_user)) -> StreamingResponse:
    return await write_article(project_id, payload, user)

@router.post("/sessions/{project_id}/write_article_sync")
async def write_article_sync_compat(project_id: str, payload: WriteArticleRequest, user=Depends(get_current_user)) -> dict:
    return await write_article_sync(project_id, payload, user)

@router.post("/sessions/{project_id}/synthesize", response_model=SynthesisResult)
async def synthesize_compat(project_id: str, user=Depends(get_current_user)) -> SynthesisResult:
    return await synthesize_papers(project_id, user)

@router.post("/sessions/{project_id}/peer_review", response_model=PeerReviewReport)
async def peer_review_compat(project_id: str, user=Depends(get_current_user)) -> PeerReviewReport:
    return await peer_review(project_id, user)

@router.post("/sessions/{project_id}/revise_after_review", response_model=RevisionResult)
async def revise_compat(project_id: str, payload: ReviseAfterReviewRequest, user=Depends(get_current_user)) -> RevisionResult:
    return await revise_after_review(project_id, payload, user)
