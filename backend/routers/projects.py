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

import asyncio
import io
import json
import logging
import os
import re
import zipfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel
from models import (
    ApproveTitleRequest,
    CreateProjectRequest,
    DiscussCommentRequest,
    FigureBuilderExportRequest,
    FigureBuilderGenerateResponse,
    FigureBuilderRefineRequest,
    FigureBuilderRequest,
    FinalizeCommentRequest,
    GenerateAllDocsRequest,
    GenerateFromPlansRequest,
    GenerateTitleRequest,
    GenerateRealRevisionRequest,
    ImportManuscriptResult,
    JournalRecommendation,
    OverrideScreeningRequest,
    ParseCommentsRequest,
    PeerReviewReport,
    ProjectMeta,
    Paper,
    RealReviewerComment,
    ReplaceCommentsRequest,
    ReviseAfterReviewRequest,
    RevisionResult,
    RevisionRound,
    RevisionWipPayload,
    ScreenPapersRequest,
    SuggestChangesRequest,
    SummarizeAllRequest,
    SynthesisResult,
    TitleSuggestions,
    UpdateCommentWorkRequest,
    WriteArticleRequest,
    AcceptVisualRequest,
    EditVisualRequest,
    FinalizeVisualRequest,
    PromptPackage,
    VisualRecommendations,
)
from services.journal_style_service import (
    JournalStyleService,
    JournalStyle,
)
from routers.settings import load_settings, load_settings_for_user
from services.auth import get_current_user
from services.ai_provider import AIProvider
from services.project_repo import (
    auto_project_title,
    append_discussion_message,
    clear_round_exports,
    create_project,
    delete_project,
    get_comment_work_rows,
    clear_project_summaries,
    get_existing_summary_keys,
    get_revision_rounds,
    get_screenings,
    list_projects,
    load_project,
    load_project_minimal,
    override_screening,
    get_peer_review_result,
    get_synthesis_result,
    save_article,
    save_article_type,
    save_base_manuscript,
    save_comment_finalization,
    save_manuscript_files,
    get_original_docx_bytes,
    save_round_export,
    save_manuscript_paths,
    save_journal_recs,
    save_manuscript_title,
    save_peer_review_result,
    save_revision_round,
    save_revision_wip,
    get_revision_wip,
    save_screening,
    save_literature_search_state,
    save_summary,
    save_synthesis_result,
    save_deep_synthesis_result,
    get_deep_synthesis_result,
    slugify_project_name,
    update_comment_work_fields,
    update_project_name,
    update_project_phase,
    upsert_comment_work_batch,
    upsert_comment_suggestions_batch,
    save_visual_recommendations,
    load_visual_recommendations,
    update_visual_item,
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
from services.manuscript_citation_formatter import normalize_numbered_citation_order
from services.cross_paper_synthesizer import synthesize
from services.journal_recommender import recommend_journals, recommend_single_journal
from services.paper_fetcher import FetchSettings
from services.provider_resolver import build_provider_for_user_config
from services.paper_fetcher import ensure_saved_pdf
from services.paper_summarizer import summarize_paper
from services.peer_reviewer import generate_peer_review
from services.query_expander import (
    expand_query,
    generate_tentative_title,
    heuristic_tentative_title,
    looks_like_low_quality_title,
    sanitize_project_title,
)
from services.project_storage import normalize_project_storage_for_user
from services.revision_writer import generate_revision_package
from services.secure_settings import get_user_provider_api_key
from services.visual_planner import plan_visuals, renumber_visuals
from services.figure_renderer import (
    build_figure_brief,
    build_editable_prompt,
    build_prompt_package,
    build_refined_prompt_package,
    generated_visual_from_candidate,
    generate_illustration_candidates,
    generate_figure_code,
    generate_table_data,
    edit_visual_code,
    execute_figure_code,
    generate_caption,
    hydrate_visual_prompt_state,
    public_candidate_payload,
    render_table_html,
)
from services.token_context import TokenContext

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["projects"])

# ── In-memory background-task registry ───────────────────────────────────────
# Maps project_id → live status dict so any endpoint can poll progress.
_BG_TASKS: dict[str, dict] = {}


def _bg_status(project_id: str) -> dict:
    """Return a safe copy of the current background task status."""
    return dict(_BG_TASKS.get(project_id, {"running": False, "current": 0, "total": 0, "current_title": "", "errors": 0}))


def _parse_section_index(raw: str | None) -> list[dict] | None:
    """Deserialise the JSON section_index stored in the DB, or return None."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _paper_key_dict(paper: dict) -> str:
    doi = str(paper.get("doi") or "").strip().lower()
    if doi:
        return doi
    return str(paper.get("title") or "")[:60].lower().strip()


def _looks_like_legacy_project_title(project_name: str, query: str) -> bool:
    """Detect old query-derived project names that should be replaced with a real AI title."""
    name = sanitize_project_title(project_name)
    source = sanitize_project_title(query)
    if not name:
        return True
    if name == source:
        return True

    name_slug = slugify_project_name(name, max_len=120)
    query_slug = slugify_project_name(source, max_len=240)
    if not name_slug:
        return True
    if name_slug == query_slug:
        return True
    if query_slug.startswith(name_slug):
        return True

    name_words = re.findall(r"[a-z0-9]+", name.lower())
    source_words = re.findall(r"[a-z0-9]+", source.lower())
    if len(name_words) >= 4 and source_words[:len(name_words)] == name_words:
        return True

    if name.lower().startswith((
        "most research",
        "most psychological research",
        "this study",
        "the present study",
        "the current study",
        "background",
        "objective",
        "research on",
        "little is known",
    )):
        return True
    return False


def _humanize_project_title(project_name: str) -> str:
    return sanitize_project_title(project_name)


def _looks_like_weak_generated_title(project_name: str) -> bool:
    name = _humanize_project_title(project_name)
    return looks_like_low_quality_title(name) or (name.endswith(": A Literature Review") and len(re.findall(r"[A-Za-z0-9]+", name)) <= 7)


def _needs_title_backfill(project: dict) -> bool:
    query = str(project.get("query") or "").strip()
    project_name = str(project.get("project_name") or "").strip()
    search_state = project.get("literature_search_state") or {}
    saved_title = str(search_state.get("tentative_title") or "").strip()
    if _looks_like_legacy_project_title(project_name, query):
        return True
    if _looks_like_weak_generated_title(project_name):
        return True
    if saved_title and _looks_like_legacy_project_title(saved_title, query):
        return True
    if saved_title and _looks_like_weak_generated_title(saved_title):
        return True
    if not saved_title and (project.get("project_type") or "write") != "revision":
        return True
    return bool(project_name and project_name != _humanize_project_title(project_name))


async def _resolve_project_title(user_id: str, project: dict) -> str:
    query = str(project.get("query") or "").strip()
    article_type = str(project.get("article_type") or "").strip()
    search_state = project.get("literature_search_state") or {}
    saved_title = _humanize_project_title(str(search_state.get("tentative_title") or ""))
    project_name = _humanize_project_title(str(project.get("project_name") or ""))

    if saved_title and not _looks_like_legacy_project_title(saved_title, query) and not _looks_like_weak_generated_title(saved_title):
        return saved_title
    if project_name and not _looks_like_legacy_project_title(project_name, query) and not _looks_like_weak_generated_title(project_name):
        return project_name

    provider = await _get_provider_for_user(user_id)
    if provider:
        title = await generate_tentative_title(provider, query, article_type=article_type)
        title = _humanize_project_title(title)
        if title and not _looks_like_legacy_project_title(title, query):
            return title
        try:
            expanded = await expand_query(provider, query, article_type=article_type)
            title = _humanize_project_title(expanded.tentative_title or "")
            if title and not _looks_like_legacy_project_title(title, query):
                return title
        except Exception as exc:
            logger.warning("Fallback expansion title generation failed for %s: %s", project.get("project_id"), exc)

    fallback = _humanize_project_title(heuristic_tentative_title(query, article_type=article_type))
    return fallback or auto_project_title(query)


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _get_provider_for_user(user_id: str) -> AIProvider | None:
    cfg = await load_settings_for_user(user_id)
    provider = await build_provider_for_user_config(user_id, cfg)
    if provider:
        return provider
    if cfg.provider == "gemini" and cfg.auth_method == "oauth" and cfg.api_key:
        logger.warning(
            "Gemini OAuth primary path is unavailable for user %s; API key fallback is saved but runtime setup failed before request dispatch.",
            user_id,
        )
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
        scihub_mirrors=cfg.scihub_mirrors,
    )


# ── Request/Response models ────────────────────────────────────────────────────

class UpdateProjectNameRequest(BaseModel):
    project_name: str


# ── Project CRUD ──────────────────────────────────────────────────────────────

@router.post("/projects", response_model=ProjectMeta)
async def create_project_endpoint(payload: CreateProjectRequest, user=Depends(get_current_user)) -> ProjectMeta:
    """Create a new research project scoped to the current user."""
    import json as _json
    from services.db import create_engine_async as _eng, projects as _projects_tbl
    from sqlalchemy import update as _update

    papers_dicts = [p.model_dump() for p in payload.papers]
    cfg = await load_settings_for_user(user["id"])
    project_type = payload.project_type or 'write'
    project_id = await create_project(
        user["id"], payload.query, papers_dicts,
        article_type=payload.article_type or (
            "systematic_review" if project_type == "systematic_review" else payload.article_type
        ),
        project_description=payload.project_description,
        pdf_save_path=cfg.pdf_save_path,
        project_name=payload.project_name,
        project_type=project_type,
        literature_search_state=payload.literature_search_state,
    )
    # Update phase based on project type
    if project_type == 'revision':
        initial_phase = 'realrevision'
    elif project_type == 'systematic_review':
        initial_phase = 'sr_protocol'
    else:
        initial_phase = 'literature'
    await update_project_phase(project_id, initial_phase)

    # For SR projects, save PICO and criteria immediately
    if project_type == 'systematic_review' and payload.pico is not None:
        eng = _eng()
        async with eng.begin() as conn:
            await conn.execute(
                _update(_projects_tbl)
                .where(_projects_tbl.c.project_id == project_id)
                .values(
                    pico_question=_json.dumps(payload.pico),
                    inclusion_criteria=_json.dumps(payload.inclusion_criteria),
                    exclusion_criteria=_json.dumps(payload.exclusion_criteria),
                    data_extraction_schema=_json.dumps(payload.data_extraction_schema),
                    sr_current_stage="protocol",
                )
            )

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
        current_phase=initial_phase,
        project_type=project_type,
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
        "project_type": s.get("project_type", "write"),
    }) for s in items]


@router.get("/projects/{project_id}")
async def get_project(project_id: str, user=Depends(get_current_user)) -> dict:
    data = await load_project(user["id"], project_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return data


@router.get("/projects/{project_id}/paper_pdf")
async def get_project_paper_pdf(
    project_id: str,
    paper_key: str,
    user=Depends(get_current_user),
):
    """Open the saved full-text PDF for a project paper, or fall back to the OA link."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    target_key = str(paper_key or "").strip().lower()
    if not target_key:
        raise HTTPException(status_code=400, detail="paper_key is required.")

    paper_dict = next(
        (p for p in project.get("papers", []) if _paper_key_dict(p) == target_key),
        None,
    )
    if not paper_dict:
        raise HTTPException(status_code=404, detail="Paper not found in project.")

    paper = Paper(**paper_dict)
    project_folder = project.get("project_folder")
    fs = await _fetch_settings_for_user(user["id"], project_folder)
    pdf_path = await ensure_saved_pdf(paper, fs)
    if pdf_path and os.path.exists(pdf_path):
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=os.path.basename(pdf_path),
            headers={"Content-Disposition": f'inline; filename="{os.path.basename(pdf_path)}"'},
        )

    if paper.oa_pdf_url:
        return RedirectResponse(url=paper.oa_pdf_url)
    if paper.doi:
        return RedirectResponse(url=f"https://doi.org/{paper.doi}")

    raise HTTPException(status_code=404, detail="No PDF or open-access link available for this paper.")


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

        # Pre-filter: count and skip already-summarized papers up front
        papers_to_summarize: list[tuple[int, Paper]] = []
        for i, paper in enumerate(papers):
            paper_key = (paper.doi or paper.title[:60]).lower().strip()
            if paper_key in existing_keys:
                done += 1
            else:
                papers_to_summarize.append((i, paper))

        # Notify frontend of pre-existing summaries in a single event
        if done > 0:
            yield _sse({
                "type": "progress",
                "current": done,
                "total": len(papers),
                "title": "",
                "skipped": True,
                "skip_reason": "already_summarized",
                "skipped_count": done,
            })

        for i, paper in papers_to_summarize:
            yield _sse({
                "type": "progress",
                "current": done + 1,
                "total": len(papers),
                "title": paper.title[:80],
                "skipped": False,
            })

            try:
                # Queue to receive sub-step labels from inside summarize_paper
                q: asyncio.Queue = asyncio.Queue()

                async def _progress_cb(step: str, _q: asyncio.Queue = q) -> None:
                    await _q.put(step)

                async with TokenContext(project_id=effective_project_id, user_id=user["id"], stage="summarize_paper"):
                    task = asyncio.create_task(
                        summarize_paper(
                            provider, paper, payload.query,
                            fetch_settings=fs, session_id=effective_project_id,
                            progress_cb=_progress_cb,
                        )
                    )

                    # Drain queue while task runs, emitting step_progress events
                    while not task.done():
                        try:
                            step = q.get_nowait()
                            yield _sse({
                                "type": "step_progress",
                                "step": step,
                                "current": i + 1,
                                "total": len(papers),
                            })
                        except asyncio.QueueEmpty:
                            await asyncio.sleep(0.05)

                    # Drain any remaining events after task completes
                    while not q.empty():
                        step = q.get_nowait()
                        yield _sse({
                            "type": "step_progress",
                            "step": step,
                            "current": i + 1,
                            "total": len(papers),
                        })

                    summary = task.result()
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


# ── Reset summaries ───────────────────────────────────────────────────────────

@router.delete("/projects/{project_id}/summaries")
async def reset_summaries(project_id: str, user=Depends(get_current_user)):
    """Delete all summaries for a project so summarization can restart from scratch."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    deleted = await clear_project_summaries(project_id)
    return {"deleted": deleted, "project_id": project_id}


# ── Background summarise-all task ────────────────────────────────────────────

@router.post("/projects/{project_id}/summarize_all/start")
async def start_summarize_all_bg(
    project_id: str,
    payload: SummarizeAllRequest,
    user=Depends(get_current_user),
):
    """
    Launch summarisation as a backend background task so it survives frontend
    navigation.  Returns immediately; poll /summarize_all/status for progress.
    """
    # Guard: only one concurrent run per project
    existing = _BG_TASKS.get(project_id, {})
    if existing.get("running"):
        return {"started": False, "reason": "already_running", **_bg_status(project_id)}

    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    project_folder = project.get("project_folder")

    async def _run():
        _BG_TASKS[project_id] = {"running": True, "current": 0, "total": len(payload.papers), "current_title": "", "errors": 0}
        try:
            provider = await _get_provider_for_user(user["id"])
            if not provider:
                _BG_TASKS[project_id]["running"] = False
                _BG_TASKS[project_id]["error"] = "No AI provider configured"
                return

            fs = await _fetch_settings_for_user(user["id"], project_folder)
            existing_keys = await get_existing_summary_keys(project_id)
            done = sum(1 for p in payload.papers if (p.doi or p.title[:60]).lower().strip() in existing_keys)
            _BG_TASKS[project_id]["current"] = done

            for paper in payload.papers:
                paper_key = (paper.doi or paper.title[:60]).lower().strip()
                if paper_key in existing_keys:
                    continue
                _BG_TASKS[project_id]["current_title"] = paper.title[:80]
                try:
                    summary = await summarize_paper(provider, paper, payload.query, fetch_settings=fs, session_id=project_id)
                    await save_summary(project_id, summary.paper_key, summary.model_dump())
                    existing_keys.add(paper_key)
                    done += 1
                    _BG_TASKS[project_id]["current"] = done
                except Exception as exc:
                    _BG_TASKS[project_id]["errors"] = _BG_TASKS[project_id].get("errors", 0) + 1
                    logger.warning("BG summarise failed for %r: %s", paper.title[:40], exc)
        finally:
            status = _BG_TASKS.get(project_id, {})
            status["running"] = False
            status["current_title"] = ""
            _BG_TASKS[project_id] = status

    asyncio.create_task(_run())
    return {"started": True, **_bg_status(project_id)}


@router.get("/projects/{project_id}/summarize_all/status")
async def summarize_all_status(project_id: str, user=Depends(get_current_user)):
    """Poll the background summarisation progress for a project."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    # Also count summaries actually saved (source of truth)
    existing_keys = await get_existing_summary_keys(project_id)
    status = _bg_status(project_id)
    status["saved"] = len(existing_keys)
    return status


# ── PDF / text backfill ────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/backfill_files")
async def backfill_files(project_id: str, user=Depends(get_current_user)):
    """
    Retroactively save a file (PDF or .txt fallback) for every paper that has
    already been summarised but has no corresponding file in full_papers/.

    Returns counts of newly saved files, already-existing files, and failures.
    """
    from services.paper_fetcher import ensure_saved_pdf, _save_text_to_disk, _txt_filename, _pdf_filename
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    project_folder = project.get("project_folder")
    if not project_folder:
        raise HTTPException(status_code=400, detail="Project has no folder configured")

    save_path = os.path.join(project_folder, "full_papers")
    fs = await _fetch_settings_for_user(user["id"], project_folder)

    papers_raw = project.get("papers", [])
    existing_keys = await get_existing_summary_keys(project_id)

    # Only backfill papers that have been summarised
    summarised_papers = [
        Paper(**p) if isinstance(p, dict) else p
        for p in papers_raw
        if (p.get("doi") or p.get("title", "")[:60]).lower().strip() in existing_keys
    ]

    saved = 0
    already_existed = 0
    failed = 0

    for paper in summarised_papers:
        # Check if any file already exists for this paper
        pdf_path = os.path.join(save_path, _pdf_filename(paper))
        txt_path = os.path.join(save_path, _txt_filename(paper))
        if os.path.exists(pdf_path) or os.path.exists(txt_path):
            already_existed += 1
            continue

        try:
            result = await ensure_saved_pdf(paper, fs)
            if result and os.path.exists(result):
                saved += 1
            elif paper.abstract:
                # ensure_saved_pdf found no PDF — save abstract as text
                r = _save_text_to_disk(paper.abstract.strip(), save_path, paper)
                if r:
                    saved += 1
                else:
                    failed += 1
            else:
                failed += 1
        except Exception as exc:
            logger.warning("Backfill failed for %r: %s", paper.title[:40], exc)
            failed += 1

    return {
        "saved": saved,
        "already_existed": already_existed,
        "failed": failed,
        "total_summarised": len(summarised_papers),
    }


# ── Screening ─────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/screen_papers")
async def screen_papers(
    project_id: str,
    payload: ScreenPapersRequest,
    user=Depends(get_current_user),
) -> StreamingResponse:
    """
    SSE stream that screens papers one by one (abstract-only, single AI call).

    Event types:
      progress    – { current, total, title }
      screen_done – { paper_key, decision, reason }
      screen_error – { title, message }
      complete    – { include, exclude, uncertain, error, total }
    """
    from services.paper_screener import screen_paper as _screen_paper

    async def generate():
        provider = await _get_provider_for_user(user["id"])
        if not provider:
            yield _sse({"type": "error", "message": "No AI provider configured. Open Settings first."})
            return

        papers = payload.papers
        n = len(papers)
        counts = {"include": 0, "exclude": 0, "uncertain": 0, "error": 0}

        for i, paper in enumerate(papers):
            yield _sse({
                "type": "progress",
                "current": i + 1,
                "total": n,
                "title": paper.title[:80],
            })
            try:
                result = await _screen_paper(provider, paper, payload.query)
                await save_screening(
                    project_id,
                    result["paper_key"],
                    result["decision"],
                    result["reason"],
                )
                dec = result["decision"]
                if dec in counts:
                    counts[dec] += 1
                yield _sse({"type": "screen_done", **result})
            except Exception as exc:
                counts["error"] += 1
                logger.warning("Screening failed for %r: %s", paper.title[:40], exc)
                yield _sse({
                    "type": "screen_error",
                    "title": paper.title[:80],
                    "message": str(exc),
                })

        yield _sse({"type": "complete", **counts, "total": n})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.get("/projects/{project_id}/screenings")
async def get_screenings_endpoint(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Return all screening decisions for a project."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return await get_screenings(project_id)


@router.patch("/projects/{project_id}/screenings/{paper_key}")
async def override_screening_endpoint(
    project_id: str,
    paper_key: str,
    body: OverrideScreeningRequest,
    user=Depends(get_current_user),
) -> dict:
    """Override a paper's screening decision."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    if body.decision not in ("include", "exclude", "uncertain"):
        raise HTTPException(status_code=400, detail="decision must be include | exclude | uncertain")
    await override_screening(project_id, paper_key, body.decision)
    return {"ok": True, "paper_key": paper_key, "decision": body.decision}


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
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="journal_recommendation"):
        recs = await recommend_journals(provider, papers, query)

    recs_dicts = [r.model_dump() for r in recs]
    await save_journal_recs(project_id, recs_dicts)
    await update_project_phase(project_id, 'journals')

    return recs


class CustomJournalLookupRequest(BaseModel):
    journal_name: str


@router.post("/projects/{project_id}/journal_lookup", response_model=JournalRecommendation)
async def journal_lookup_endpoint(
    project_id: str,
    payload: CustomJournalLookupRequest,
    user=Depends(get_current_user),
) -> JournalRecommendation:
    """Enrich a user-typed journal with the same metadata used in recommendations."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    journal_name = (payload.journal_name or "").strip()
    if not journal_name:
        raise HTTPException(status_code=400, detail="journal_name is required.")

    provider = await _get_provider_for_user(user["id"])
    query = project.get("query", "")
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="journal_recommendation"):
        return await recommend_single_journal(provider, query, journal_name)


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

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="generate_title"):
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

    # Update project name from approved title — folder slug is handled internally.
    await update_project_name(project_id, title)

    return {"status": "approved", "manuscript_title": title}


@router.post("/projects/{project_id}/ensure_tentative_title")
async def ensure_tentative_title_endpoint(project_id: str, user=Depends(get_current_user)) -> dict:
    """Return a human-readable project title, generating one for older projects when missing."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    query = (project.get("query") or "").strip()
    project_name = str(project.get("project_name") or "").strip()
    search_state = project.get("literature_search_state") or {}
    title = await _resolve_project_title(user["id"], project)
    search_state["tentative_title"] = title
    await save_literature_search_state(project_id, search_state, query=query)

    if _looks_like_legacy_project_title(project_name, query) or _humanize_project_title(project_name) != title:
        await update_project_name(project_id, title)

    return {
        "project_id": project_id,
        "tentative_title": title,
        "project_slug": slugify_project_name(title),
    }


@router.post("/projects/backfill_legacy_titles")
async def backfill_legacy_titles_endpoint(user=Depends(get_current_user)) -> dict:
    """One-time backfill to replace legacy query-derived project names with generated titles."""
    items = await list_projects(user["id"])
    updated: list[dict] = []

    for item in items:
        if (item.get("project_type") or "write") == "revision":
            continue
        project = await load_project(user["id"], item["project_id"])
        if project is None or not _needs_title_backfill(project):
            continue

        title = await _resolve_project_title(user["id"], project)
        search_state = project.get("literature_search_state") or {}
        search_state["tentative_title"] = title
        await save_literature_search_state(project["project_id"], search_state, query=project.get("query") or "")
        await update_project_name(project["project_id"], title)
        updated.append({
            "project_id": project["project_id"],
            "project_name": title,
            "project_slug": slugify_project_name(title),
        })

    return {
        "updated_count": len(updated),
        "projects": updated,
    }


@router.post("/projects/normalize_storage")
async def normalize_project_storage_endpoint(user=Depends(get_current_user)) -> dict:
    """Normalize legacy mixed-root project files into canonical per-project folders."""
    return await normalize_project_storage_for_user(user["id"])


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
            article_tokens = max(16384, payload.word_limit * 4)
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="write_article"):
                article_text = await provider.complete(
                    system=effective_system,
                    user=user_msg,
                    json_mode=False,
                    temperature=0.4,
                    max_tokens=article_tokens,
                )

            # If model stopped short (< 60% of target), retry with expansion prompt
            actual_words = len(article_text.split())
            if actual_words < payload.word_limit * 0.6:
                logger.warning(
                    "Article too short (%d words, target %d) — attempting expansion",
                    actual_words, payload.word_limit,
                )
                yield _sse({"type": "progress", "message": f"Draft too short ({actual_words} words) — expanding to full length…"})
                expansion_msg = (
                    f"The draft is only {actual_words} words, far below the {payload.word_limit}-word requirement.\n\n"
                    f"Incomplete draft:\n\n{article_text}\n\n"
                    f"---\n\n"
                    f"CONTINUE and EXPAND this into a complete {payload.word_limit}-word article. "
                    f"Keep all existing content. Expand every section with full scholarly analysis, "
                    f"evidence-based prose, and inline citations. Add all missing sections. "
                    f"The final article MUST reach {payload.word_limit} words."
                )
                async with TokenContext(project_id=project_id, user_id=user["id"], stage="write_article"):
                    article_text = await provider.complete(
                        system=effective_system,
                        user=expansion_msg,
                        json_mode=False,
                        temperature=0.4,
                        max_tokens=article_tokens,
                    )

            if manuscript_title and not article_text.lstrip().startswith(f"# {manuscript_title}"):
                article_text = f"# {manuscript_title}\n\n{article_text}"
            article_text = normalize_numbered_citation_order(
                article_text,
                journal_style,
                project_summaries,
            )
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

    # ── Return cached article if it exists and force=False ──────────────────────
    if not payload.force:
        existing_article = (project.get("article") or "").strip()
        if existing_article:
            existing_recs = await load_visual_recommendations(project_id)
            return {
                "article": existing_article,
                "word_count": len(existing_article.split()),
                "ref_count": 0,
                "ref_limit": payload.max_references,
                "word_limit": payload.word_limit,
                "visual_recommendations": existing_recs,
            }

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

    article_tokens_sync = max(16384, payload.word_limit * 4)
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="write_article"):
        article_text = await provider.complete(
            system=effective_system,
            user=user_msg,
            json_mode=False,
            temperature=0.4,
            max_tokens=article_tokens_sync,
        )

    actual_words_sync = len(article_text.split())
    if actual_words_sync < payload.word_limit * 0.6:
        logger.warning(
            "Article too short (%d words, target %d) — attempting expansion",
            actual_words_sync, payload.word_limit,
        )
        expansion_msg_sync = (
            f"The draft is only {actual_words_sync} words, far below the {payload.word_limit}-word requirement.\n\n"
            f"Incomplete draft:\n\n{article_text}\n\n"
            f"---\n\n"
            f"CONTINUE and EXPAND this into a complete {payload.word_limit}-word article. "
            f"Keep all existing content. Expand every section with full scholarly analysis, "
            f"evidence-based prose, and inline citations. Add all missing sections. "
            f"The final article MUST reach {payload.word_limit} words."
        )
        async with TokenContext(project_id=project_id, user_id=user["id"], stage="write_article"):
            article_text = await provider.complete(
                system=effective_system,
                user=expansion_msg_sync,
                json_mode=False,
                temperature=0.4,
                max_tokens=article_tokens_sync,
            )

    if manuscript_title_sync and not article_text.lstrip().startswith(f"# {manuscript_title_sync}"):
        article_text = f"# {manuscript_title_sync}\n\n{article_text}"
    article_text = normalize_numbered_citation_order(
        article_text,
        journal_style,
        project_summaries,
    )
    await save_article(project_id, article_text, payload.selected_journal)
    await update_project_phase(project_id, 'article')
    cited_keys_sync = set(re.findall(r'\[CITE:([^\]]+)\]', article_text))

    # ── Auto-run visual planner after article generation (non-fatal) ──────────
    # Skip if recommendations already exist and this is not a forced regeneration
    visual_recommendations_data = None
    try:
        existing_recs_check = await load_visual_recommendations(project_id)
        if existing_recs_check and not payload.force:
            visual_recommendations_data = _hydrate_visual_recommendations_payload(
                existing_recs_check,
                article_text=article_text,
                article_type=str(effective_article_type_sync or ""),
                selected_journal=str(payload.selected_journal or ""),
            )
        else:
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_planner"):
                vis_recs = await plan_visuals(
                    provider,
                    article_text,
                    effective_article_type_sync,
                    project.get("query", ""),
                )
            vis_dict = vis_recs.model_dump()
            vis_dict = _hydrate_visual_recommendations_payload(
                vis_dict,
                article_text=article_text,
                article_type=str(effective_article_type_sync or ""),
                selected_journal=str(payload.selected_journal or ""),
            )
            await save_visual_recommendations(project_id, vis_dict)
            visual_recommendations_data = vis_dict
    except Exception as _vp_err:
        logger.warning("Visual planner failed for project %s: %s", project_id, _vp_err)

    return {
        "article":                 article_text,
        "word_count":              len(article_text.split()),
        "ref_count":               len(cited_keys_sync),
        "ref_limit":               payload.max_references,
        "word_limit":              payload.word_limit,
        "visual_recommendations":  visual_recommendations_data,
    }


# ── Visual recommendations ────────────────────────────────────────────────────


def _visuals_storage_dir(project: dict) -> str:
    """Return (and create) the images/ sub-directory inside the project folder."""
    folder = project.get("project_folder") or ""
    if folder:
        img_dir = os.path.join(folder, "images")
    else:
        img_dir = os.path.join(
            os.path.expanduser("~"),
            "Documents", "AcademicWriter", "_figures", project.get("project_id", "unknown"),
        )
    os.makedirs(img_dir, exist_ok=True)
    return img_dir


def _figure_builder_storage_dir(project: dict) -> str:
    storage_dir = os.path.join(_visuals_storage_dir(project), "figure_builder")
    os.makedirs(storage_dir, exist_ok=True)
    return storage_dir


def _resolve_active_image_settings(user_settings, payload: AcceptVisualRequest | None = None) -> tuple[str, str, str, str, int]:
    backend = str((payload.image_backend if payload and payload.image_backend else user_settings.image_backend) or "openai")
    provider_entry = (user_settings.image_provider_configs or {}).get(backend)
    model = str((provider_entry.model if provider_entry and provider_entry.model else user_settings.image_model) or ("gpt-image-1" if backend == "openai" else "imagen-3.0-generate-002"))
    background = str(user_settings.image_background or "opaque")
    quality = str(user_settings.image_quality or "high")
    candidate_count = payload.candidate_count if payload and payload.candidate_count else user_settings.image_candidate_count
    candidate_count = max(1, min(4, int(candidate_count or 1)))
    return backend, model, background, quality, candidate_count


async def _resolve_image_backend_api_key(user_id: str, backend: str) -> str:
    provider_name = "gemini" if backend == "gemini_imagen" else backend
    return await get_user_provider_api_key(user_id, provider_name)


def _hydrate_visual_recommendations_payload(
    recs: dict | None,
    *,
    article_text: str = "",
    article_type: str = "",
    selected_journal: str = "",
) -> dict | None:
    if not recs:
        return recs
    items = []
    changed = False
    for raw_item in recs.get("items", []):
        try:
            from models import VisualItem as _VisualItem
            item = _VisualItem(**raw_item)
            hydrated = hydrate_visual_prompt_state(
                item,
                article_context=article_text[:3000],
                article_type=article_type,
                selected_journal=selected_journal,
            )
            item_dict = hydrated.model_dump()
            changed = changed or item_dict != raw_item
            items.append(item_dict)
        except Exception:
            items.append(raw_item)
    if changed:
        recs = {**recs, "items": items}
    return recs


@router.get("/projects/{project_id}/visuals")
async def get_visual_recommendations(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Return the current visual_recommendations for this project."""
    project = await load_project(user["id"], project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    recs = await load_visual_recommendations(project_id)
    if recs is None:
        return {"summary": "", "empty_reason": "No visual planning run yet.", "items": []}
    recs = _hydrate_visual_recommendations_payload(
        recs,
        article_text=str(project.get("article") or ""),
        article_type=str(project.get("article_type") or ""),
        selected_journal=str(project.get("selected_journal") or ""),
    )
    await save_visual_recommendations(project_id, recs)
    return recs


@router.post("/projects/{project_id}/visuals/plan")
async def run_visual_planner(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """(Re-)run the visual planner for this project's current article text."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    article_text = (project.get("article") or "").strip()
    if not article_text:
        raise HTTPException(status_code=400, detail="No article draft found. Generate the manuscript first.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    article_type = project.get("article_type") or "review"

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_planner"):
        vis_recs = await plan_visuals(
            provider,
            article_text,
            article_type,
            project.get("query", ""),
        )

    vis_dict = vis_recs.model_dump()
    vis_dict = _hydrate_visual_recommendations_payload(
        vis_dict,
        article_text=article_text,
        article_type=str(article_type or ""),
        selected_journal=str(project.get("selected_journal") or ""),
    )
    await save_visual_recommendations(project_id, vis_dict)
    return vis_dict


@router.post("/projects/{project_id}/visuals/{item_id}/accept")
async def accept_visual(
    project_id: str,
    item_id: str,
    payload: AcceptVisualRequest,
    user=Depends(get_current_user),
) -> dict:
    """Accept a recommended visual item and trigger generation."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    recs = await load_visual_recommendations(project_id)
    if not recs:
        raise HTTPException(status_code=404, detail="No visual recommendations found.")

    item_data = next((i for i in recs.get("items", []) if i.get("id") == item_id), None)
    if not item_data:
        raise HTTPException(status_code=404, detail=f"Visual item {item_id!r} not found.")

    if item_data.get("status") not in ("recommended", "generated"):
        raise HTTPException(status_code=400, detail=f"Item {item_id} is in status {item_data.get('status')!r} and cannot be accepted.")

    from models import VisualItem as _VisualItem
    item = _VisualItem(**item_data)
    render_mode = getattr(item, "render_mode", None) or ("table" if item.type == "table" else "matplotlib")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    # Mark as generating
    await update_visual_item(project_id, item_id, {"status": "generating"})

    storage_dir = _visuals_storage_dir(project)
    article_text = (project.get("article") or "")[:3000]

    try:
        if render_mode == "table":
            # Generate structured table data
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_generate"):
                table_data = await generate_table_data(provider, item, article_text)

            # Count finalized/generated tables for numbering
            all_items = recs.get("items", [])
            table_number = sum(
                1 for i in all_items
                if i.get("type") == "table"
                and i.get("status") in ("generated", "finalized")
                and i.get("id") != item_id
            ) + 1

            table_html = render_table_html(table_data, table_number, item.title)

            async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_caption"):
                caption = await generate_caption(provider, item, table_number)

            generated = {
                "image_url": None,
                "pdf_url": None,
                "table_html": table_html,
                "table_data": table_data,
                "caption": caption,
                "source_code": "",
                "style_preset": payload.style_preset,
            }
            updated = await update_visual_item(project_id, item_id, {
                "status": "generated",
                "generated": generated,
            })
        elif render_mode == "ai_illustration":
            user_settings = await load_settings_for_user(user["id"])
            backend, model, background, quality, candidate_count = _resolve_active_image_settings(user_settings, payload)
            backend_api_key = await _resolve_image_backend_api_key(user["id"], backend)
            if not backend_api_key:
                raise HTTPException(status_code=400, detail=f"No API key configured for image backend {backend!r}.")

            default_hydrated = hydrate_visual_prompt_state(
                item,
                article_context=article_text,
                article_type=str(project.get("article_type") or ""),
                selected_journal=str(project.get("selected_journal") or ""),
            )
            brief = payload.figure_brief or default_hydrated.figure_brief or build_figure_brief(
                item=item,
                article_context=article_text,
                article_type=str(project.get("article_type") or ""),
                selected_journal=str(project.get("selected_journal") or ""),
            )
            prompt_package = payload.prompt_package or (
                build_prompt_package(brief)
                if payload.figure_brief
                else (PromptPackage(**default_hydrated.prompt_package) if default_hydrated.prompt_package else build_prompt_package(brief))
            )
            palette = payload.palette or (default_hydrated.style_controls.palette if default_hydrated.style_controls else None)
            background = payload.image_background or (default_hydrated.style_controls.background if default_hydrated.style_controls else background)
            transparent_background = payload.transparent_background if payload.transparent_background is not None else (
                default_hydrated.style_controls.transparent_background if default_hydrated.style_controls else False
            )
            if transparent_background:
                background = "transparent"
            # Use explicit user prompt if provided; otherwise LLM will generate one
            user_prompt = payload.editable_prompt or None
            candidate_storage_dir = _figure_builder_storage_dir(project)
            candidates = await generate_illustration_candidates(
                api_key=backend_api_key,
                backend=backend,
                model=model,
                brief=brief,
                prompt_package=prompt_package,
                storage_dir=candidate_storage_dir,
                candidate_count=candidate_count,
                background=background,
                quality=quality,
                custom_prompt=user_prompt,
                provider=provider,
                article_context=article_text,
            )
            if not candidates:
                raise HTTPException(status_code=500, detail="Image generation returned no candidates.")
            primary = candidates[0]
            public_candidates = [public_candidate_payload(project_id, candidate).model_dump() for candidate in candidates]

            all_items = recs.get("items", [])
            figure_number = sum(
                1 for i in all_items
                if i.get("type") == "figure"
                and i.get("status") in ("generated", "finalized")
                and i.get("id") != item_id
            ) + 1
            try:
                async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_caption"):
                    caption = await generate_caption(provider, item, figure_number)
            except Exception as cap_err:
                logger.warning("Caption generation failed (non-fatal): %s", cap_err)
                caption = item.title or f"Figure {figure_number}."

            generated = generated_visual_from_candidate(
                project_id,
                primary,
                caption=caption,
                style_preset=payload.style_preset,
            ).model_dump()
            generated["image_url"] = f"/api/projects/{project_id}/visuals/{item_id}/image"

            updated = await update_visual_item(project_id, item_id, {
                "status": "generated",
                "image_backend": backend,
                "figure_brief": brief.model_dump(),
                "prompt_package": prompt_package.model_dump(),
                "editable_prompt": primary.prompt or user_prompt,
                "style_controls": {
                    "palette": palette,
                    "background": background,
                    "transparent_background": transparent_background,
                },
                "candidates": public_candidates,
                "generated": generated,
            })
        else:
            # Generate matplotlib figure code
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_generate"):
                source_code = await generate_figure_code(provider, item, article_text)

            render_result = execute_figure_code(source_code, item_id, storage_dir)

            if render_result["error"]:
                await update_visual_item(project_id, item_id, {"status": "recommended"})
                raise HTTPException(status_code=500, detail=f"Figure generation failed: {render_result['error']}")

            # Count finalized/generated figures for numbering
            all_items = recs.get("items", [])
            figure_number = sum(
                1 for i in all_items
                if i.get("type") == "figure"
                and i.get("status") in ("generated", "finalized")
                and i.get("id") != item_id
            ) + 1

            async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_caption"):
                caption = await generate_caption(provider, item, figure_number)

            # Build URL for the image (served via the /image endpoint below)
            image_url = f"/api/projects/{project_id}/visuals/{item_id}/image"

            generated = {
                "image_url": image_url,
                "pdf_url": None,
                "table_html": None,
                "table_data": None,
                "caption": caption,
                "source_code": source_code,
                "style_preset": payload.style_preset,
            }
            updated = await update_visual_item(project_id, item_id, {
                "status": "generated",
                "generated": generated,
            })

        return updated or recs

    except HTTPException:
        raise
    except Exception as e:
        await update_visual_item(project_id, item_id, {"status": "recommended"})
        logger.exception("Visual accept failed for %s/%s", project_id, item_id)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/{project_id}/visuals/{item_id}/image")
async def get_visual_image(
    project_id: str,
    item_id: str,
    user=Depends(get_current_user),
) -> FileResponse:
    """Serve the generated PNG for a figure item."""
    project = await load_project_minimal(project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    storage_dir = _visuals_storage_dir(project)
    png_path = os.path.join(storage_dir, f"{item_id}.png")
    recs = await load_visual_recommendations(project_id)
    candidate_path = None
    if recs:
        item_data = next((i for i in recs.get("items", []) if i.get("id") == item_id), None)
        candidate_id = ((item_data or {}).get("generated") or {}).get("candidate_id") if item_data else None
        if candidate_id:
            maybe_path = os.path.join(_figure_builder_storage_dir(project), f"{candidate_id}.png")
            if os.path.exists(maybe_path):
                candidate_path = maybe_path
    if candidate_path:
        png_path = candidate_path
    if not os.path.exists(png_path):
        raise HTTPException(status_code=404, detail="Image not found.")
    return FileResponse(png_path, media_type="image/png")


@router.post("/projects/{project_id}/visuals/{item_id}/dismiss")
async def dismiss_visual(
    project_id: str,
    item_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Mark a visual item as dismissed."""
    project = await load_project_minimal(project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    updated = await update_visual_item(project_id, item_id, {"status": "dismissed"})
    if updated is None:
        raise HTTPException(status_code=404, detail="Visual recommendations not found.")

    renumbered = renumber_visuals(updated)
    await save_visual_recommendations(project_id, renumbered)
    return renumbered


@router.post("/projects/{project_id}/visuals/{item_id}/select_candidate")
async def select_visual_candidate(
    project_id: str,
    item_id: str,
    payload: dict,
    user=Depends(get_current_user),
) -> dict:
    """Swap the active candidate shown for a visual item without finalizing it."""
    candidate_id = payload.get("candidate_id")
    if not candidate_id:
        raise HTTPException(status_code=422, detail="candidate_id is required.")
    project = await load_project_minimal(project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    recs = await load_visual_recommendations(project_id)
    if not recs:
        raise HTTPException(status_code=404, detail="No visual recommendations found.")
    item_data = next((i for i in recs.get("items", []) if i.get("id") == item_id), None)
    if not item_data:
        raise HTTPException(status_code=404, detail=f"Visual item {item_id!r} not found.")
    generated = dict(item_data.get("generated") or {})
    generated["candidate_id"] = candidate_id
    updated = await update_visual_item(project_id, item_id, {"generated": generated})
    return updated or recs


@router.post("/projects/{project_id}/visuals/{item_id}/finalize")
async def finalize_visual(
    project_id: str,
    item_id: str,
    payload: FinalizeVisualRequest,
    user=Depends(get_current_user),
) -> dict:
    """Lock a visual item as finalized (publication-ready)."""
    project = await load_project_minimal(project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    recs = await load_visual_recommendations(project_id)
    if not recs:
        raise HTTPException(status_code=404, detail="No visual recommendations found.")

    item_data = next((i for i in recs.get("items", []) if i.get("id") == item_id), None)
    if not item_data:
        raise HTTPException(status_code=404, detail=f"Visual item {item_id!r} not found.")

    updates: dict = {"status": "finalized"}
    if payload.caption and item_data.get("generated"):
        generated = dict(item_data["generated"])
        generated["caption"] = payload.caption
        updates["generated"] = generated

    updated = await update_visual_item(project_id, item_id, updates)
    return updated or recs


@router.post("/projects/{project_id}/visuals/{item_id}/edit")
async def edit_visual(
    project_id: str,
    item_id: str,
    payload: EditVisualRequest,
    user=Depends(get_current_user),
) -> dict:
    """One turn of iterative AI editing for a generated visual."""
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    recs = await load_visual_recommendations(project_id)
    if not recs:
        raise HTTPException(status_code=404, detail="No visual recommendations found.")

    item_data = next((i for i in recs.get("items", []) if i.get("id") == item_id), None)
    if not item_data:
        raise HTTPException(status_code=404, detail=f"Visual item {item_id!r} not found.")

    if item_data.get("status") not in ("generated", "editing", "finalized"):
        raise HTTPException(status_code=400, detail="Item must be in generated/editing state to edit.")

    from models import VisualItem as _VisualItem
    item = _VisualItem(**item_data)
    render_mode = getattr(item, "render_mode", None) or ("table" if item.type == "table" else "matplotlib")

    await update_visual_item(project_id, item_id, {"status": "editing"})

    try:
        generated = dict(item_data.get("generated") or {})
        if render_mode == "ai_illustration":
            user_settings = await load_settings_for_user(user["id"])
            backend, model, background, quality, _ = _resolve_active_image_settings(user_settings, None)
            current_candidate_id = payload.candidate_id or generated.get("candidate_id")
            current_candidates = item_data.get("candidates") or []
            current_candidate = next((c for c in current_candidates if c.get("id") == current_candidate_id), None)
            prompt_payload = item_data.get("prompt_package") or (current_candidate or {}).get("prompt_package") or {}
            hydrated = hydrate_visual_prompt_state(
                item,
                article_context=(project.get("article") or "")[:3000],
                article_type=str(project.get("article_type") or ""),
                selected_journal=str(project.get("selected_journal") or ""),
            )
            brief = payload.figure_brief or item.figure_brief or hydrated.figure_brief or build_figure_brief(
                item=item,
                article_context=(project.get("article") or "")[:3000],
                article_type=str(project.get("article_type") or ""),
                selected_journal=str(project.get("selected_journal") or ""),
            )
            original_prompt = payload.prompt_package or (
                build_prompt_package(brief)
                if payload.figure_brief
                else (PromptPackage(**prompt_payload) if prompt_payload else build_prompt_package(brief))
            )
            palette = payload.palette or (item_data.get("style_controls") or {}).get("palette")
            background = payload.image_background or (item_data.get("style_controls") or {}).get("background") or background
            transparent_background = payload.transparent_background if payload.transparent_background is not None else (
                (item_data.get("style_controls") or {}).get("transparent_background") or False
            )
            if transparent_background:
                background = "transparent"
            editable_prompt = payload.editable_prompt or item_data.get("editable_prompt")
            if editable_prompt:
                refined_prompt = original_prompt.model_copy(update={"final_prompt": editable_prompt})
            else:
                refined_prompt = build_refined_prompt_package(brief, original_prompt, payload.message)
                editable_prompt = refined_prompt.final_prompt
            backend_api_key = await _resolve_image_backend_api_key(user["id"], backend)
            if not backend_api_key:
                raise HTTPException(status_code=400, detail=f"No API key configured for image backend {backend!r}.")
            candidate_storage_dir = _figure_builder_storage_dir(project)
            candidates = await generate_illustration_candidates(
                api_key=backend_api_key,
                backend=backend,
                model=model,
                brief=brief,
                prompt_package=refined_prompt,
                storage_dir=candidate_storage_dir,
                candidate_count=1,
                background=background,
                quality=quality,
                custom_prompt=editable_prompt,
            )
            primary = candidates[0]
            public_candidates = [public_candidate_payload(project_id, primary).model_dump()]
            updated_generated = generated_visual_from_candidate(
                project_id,
                primary,
                caption=generated.get("caption") or item.title,
                style_preset=generated.get("style_preset") or "academic",
            ).model_dump()
            updated_generated["image_url"] = f"/api/projects/{project_id}/visuals/{item_id}/image"
            updated = await update_visual_item(project_id, item_id, {
                "status": "generated",
                "figure_brief": brief.model_dump(),
                "prompt_package": refined_prompt.model_dump(),
                "editable_prompt": editable_prompt,
                "style_controls": {
                    "palette": palette,
                    "background": background,
                    "transparent_background": transparent_background,
                },
                "candidates": public_candidates,
                "generated": updated_generated,
            })
            return {"recs": updated or recs, "explanation": "Updated the illustration brief/prompt and regenerated the image."}

        provider = await _get_provider_for_user(user["id"])
        if not provider:
            raise HTTPException(status_code=400, detail="No AI provider configured.")
        async with TokenContext(project_id=project_id, user_id=user["id"], stage="visual_edit"):
            edit_result = await edit_visual_code(
                provider,
                item,
                payload.message,
                payload.context,
                payload.current_code,
            )

        new_code = edit_result["new_code"]
        explanation = edit_result.get("explanation", "")

        if render_mode == "table":
            # Re-parse and re-render the table
            try:
                import json as _json
                new_table_data = _json.loads(new_code)
                table_number = 1  # simplified — full renumber not needed here
                new_html = render_table_html(new_table_data, table_number, item.title)
                generated["table_data"] = new_table_data
                generated["table_html"] = new_html
                generated["source_code"] = new_code
            except Exception as parse_err:
                raise HTTPException(status_code=500, detail=f"Table edit parse error: {parse_err}")
        else:
            storage_dir = _visuals_storage_dir(project)
            render_result = execute_figure_code(new_code, item_id, storage_dir)
            if render_result["error"]:
                raise HTTPException(status_code=500, detail=f"Figure re-render failed: {render_result['error']}")
            generated["source_code"] = new_code
            generated["image_url"] = f"/api/projects/{project_id}/visuals/{item_id}/image"

        updated = await update_visual_item(project_id, item_id, {
            "status": "generated",
            "generated": generated,
        })
        return {"recs": updated or recs, "explanation": explanation}

    except HTTPException:
        await update_visual_item(project_id, item_id, {"status": "generated"})
        raise
    except Exception as e:
        await update_visual_item(project_id, item_id, {"status": "generated"})
        logger.exception("Visual edit failed for %s/%s", project_id, item_id)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_id}/figure_builder/generate", response_model=FigureBuilderGenerateResponse)
async def generate_figure_builder_candidates(
    project_id: str,
    payload: FigureBuilderRequest,
    user=Depends(get_current_user),
) -> FigureBuilderGenerateResponse:
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    user_settings = await load_settings_for_user(user["id"])
    backend = str(payload.image_backend or user_settings.image_backend or "openai")
    model = str(
        payload.image_backend
        and (user_settings.image_provider_configs.get(backend).model if user_settings.image_provider_configs.get(backend) else None)
        or user_settings.image_model
        or ("gpt-image-1" if backend == "openai" else "imagen-3.0-generate-002")
    )
    api_key = await _resolve_image_backend_api_key(user["id"], backend)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No API key configured for image backend {backend!r}.")

    brief = build_figure_brief(
        request=payload,
        article_context=(project.get("article") or "")[:3000],
        article_type=str(project.get("article_type") or payload.article_type or ""),
        selected_journal=str(project.get("selected_journal") or ""),
    )
    prompt_package = build_prompt_package(brief)
    candidates = await generate_illustration_candidates(
        api_key=api_key,
        backend=backend,
        model=model,
        brief=brief,
        prompt_package=prompt_package,
        storage_dir=_figure_builder_storage_dir(project),
        candidate_count=max(1, min(4, int(payload.candidate_count or user_settings.image_candidate_count or 1))),
        background="transparent" if payload.transparent_background else str(user_settings.image_background or "opaque"),
        quality=str(user_settings.image_quality or "high"),
    )
    return FigureBuilderGenerateResponse(
        brief=brief,
        prompt_package=prompt_package,
        candidates=[public_candidate_payload(project_id, candidate) for candidate in candidates],
    )


@router.post("/projects/{project_id}/figure_builder/refine", response_model=FigureBuilderGenerateResponse)
async def refine_figure_builder_candidate(
    project_id: str,
    payload: FigureBuilderRefineRequest,
    user=Depends(get_current_user),
) -> FigureBuilderGenerateResponse:
    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    user_settings = await load_settings_for_user(user["id"])
    backend = str(payload.image_backend or payload.candidate.backend or user_settings.image_backend or "openai")
    api_key = await _resolve_image_backend_api_key(user["id"], backend)
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No API key configured for image backend {backend!r}.")

    brief = payload.brief
    prompt_package = build_refined_prompt_package(brief, payload.prompt_package, payload.instruction)
    candidates = await generate_illustration_candidates(
        api_key=api_key,
        backend=backend,
        model=str(payload.candidate.model or user_settings.image_model or ("gpt-image-1" if backend == "openai" else "imagen-3.0-generate-002")),
        brief=brief,
        prompt_package=prompt_package,
        storage_dir=_figure_builder_storage_dir(project),
        candidate_count=1,
        background=str(payload.candidate.background or user_settings.image_background or "opaque"),
        quality=str(payload.candidate.quality or user_settings.image_quality or "high"),
    )
    return FigureBuilderGenerateResponse(
        brief=brief,
        prompt_package=prompt_package,
        candidates=[public_candidate_payload(project_id, candidate) for candidate in candidates],
    )


@router.get("/projects/{project_id}/figure_builder/candidates/{candidate_id}/image")
async def get_figure_builder_candidate_image(
    project_id: str,
    candidate_id: str,
    user=Depends(get_current_user),
) -> FileResponse:
    project = await load_project_minimal(project_id)
    if not project or project.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    png_path = os.path.join(_figure_builder_storage_dir(project), f"{candidate_id}.png")
    if not os.path.exists(png_path):
        raise HTTPException(status_code=404, detail="Image not found.")
    return FileResponse(png_path, media_type="image/png")


# ── Saved synthesis / peer-review results (for resume) ────────────────────────

@router.get("/projects/{project_id}/synthesis_result")
async def get_synthesis_result_endpoint(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Return the last saved synthesis result for this project, or {} if none."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    result = await get_synthesis_result(project_id)
    return result or {}


@router.get("/projects/{project_id}/peer_review_result")
async def get_peer_review_result_endpoint(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Return the last saved peer review report for this project, or {} if none."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    result = await get_peer_review_result(project_id)
    return result or {}


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
    article_type = project.get("article_type", "review")

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="cross_paper_synthesis"):
        result = await synthesize(
            provider, project_summaries, query,
            article_type=article_type,
            build_packs=True,
        )
    await update_project_phase(project_id, 'cross_reference')
    await save_synthesis_result(project_id, result.model_dump())
    return result


# ── Deep synthesis ─────────────────────────────────────────────────────────────

class DeepSynthesizeRequest(BaseModel):
    auto_fetch_enabled: bool = True

@router.post("/projects/{project_id}/deep_synthesize")
async def deep_synthesize_endpoint(
    project_id: str,
    payload: DeepSynthesizeRequest = DeepSynthesizeRequest(),
    user=Depends(get_current_user),
) -> StreamingResponse:
    """Run multi-stage deep synthesis pipeline with SSE streaming progress."""
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
    article_type = project.get("article_type", "review")

    from services.deep_synthesizer import deep_synthesize

    async def _stream():
        import json as _json
        result_data = None
        async with TokenContext(project_id=project_id, user_id=user["id"], stage="deep_synthesis"):
            async for event in deep_synthesize(
                provider=provider,
                summaries=project_summaries,
                query=query,
                article_type=article_type,
                project_id=project_id,
                auto_fetch_enabled=payload.auto_fetch_enabled,
            ):
                if event.get("type") == "complete":
                    result_data = event.get("result")
                yield f"data: {_json.dumps(event, ensure_ascii=False)}\n\n"

        # Save the result to DB
        if result_data:
            await save_deep_synthesis_result(project_id, result_data)
            await update_project_phase(project_id, 'cross_reference')

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/projects/{project_id}/deep_synthesis_result")
async def get_deep_synthesis(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Fetch the saved deep synthesis result for a project."""
    result = await get_deep_synthesis_result(project_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No deep synthesis result found.")
    return result


# ── Citation Audit ─────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/citation_audit")
async def citation_audit(project_id: str, user=Depends(get_current_user)) -> dict:
    """
    Section-sensitive citation audit of the project's current draft manuscript.

    Checks for:
    - Unsupported claims (factual statements without citations where expected)
    - Missing citation purposes by section (e.g. no identify_gap paper in Introduction)
    - Uncited seminal/key papers that are in the Citation Base but absent from the draft
    - Citation stacking (≥4 citations in sequence with no synthesis prose)

    Returns a structured audit report.
    """
    import json as _json
    import re as _re

    project = await load_project(user["id"], project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    draft = project.get("article_draft") or project.get("article") or ""
    if not draft:
        raise HTTPException(status_code=400, detail="No draft found. Generate a manuscript first.")

    summaries_raw = project.get("summaries", {})
    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured. Open Settings first.")

    from models import PaperSummary as PS
    project_summaries = [PS(**v) for v in summaries_raw.values()]
    query = project.get("query", "")

    # Collect seminal papers not cited in draft
    seminal_uncited: list[dict] = []
    for ps in project_summaries:
        if ps.is_seminal:
            if ps.paper_key not in draft and ps.bibliography.title not in draft:
                seminal_uncited.append({
                    "paper_key": ps.paper_key,
                    "title": ps.bibliography.title or ps.paper_key,
                    "reason": "seminal — present in Citation Base but not found in draft text",
                })

    # Build audit prompt
    audit_system = """You are an expert academic manuscript editor specializing in citation quality.
You will audit a draft manuscript for citation issues.

Return ONLY a valid JSON object with these fields:
{
  "unsupported_claims": [
    {"text": "sentence from draft", "section": "introduction|methods|results|discussion", "suggested_purpose": "background|theory|..."}
  ],
  "missing_purposes_by_section": {
    "introduction": ["identify_gap", "theory"],
    "methods": ["methodology"]
  },
  "citation_stacking": [
    {"section": "discussion", "excerpt": "short excerpt showing stacking"}
  ],
  "purpose_mismatch": [
    {"excerpt": "text excerpt", "issue": "description of the mismatch"}
  ]
}

SECTION-SPECIFIC AUDIT RULES:
Introduction:
  - Every prevalence/epidemiology claim needs a citation
  - The rationale for the gap should have at least one [identify_gap] citation
  - Theory/framework statements should have [theory] or [original_source] citations
  - MISSING: flag if none of these purposes appear: identify_gap, background, theory

Methods:
  - Every named scale, instrument, or validated tool should have a citation
  - Statistical methods that are not standard should be cited
  - MISSING: flag if methodology citations are absent

Results:
  - Minimal citations expected — do NOT flag absence of citations here
  - Only flag if citations appear out of place

Discussion:
  - Comparisons with prior work should cite specific papers
  - Do NOT flag as "unsupported" if the claim refers to the study's own findings
  - MISSING: flag if compare_findings citations are absent entirely

Citation stacking:
  - Flag ONLY when 4+ distinct citations appear consecutively with no synthesis prose

Do NOT flag:
  - Results section statements about the study's own data
  - Methodological descriptions of the current study's procedure
  - Standard sentences that do not require citations (e.g., objectives, aims)
"""

    audit_user = f"""Research question: {query}

Known seminal papers NOT cited in draft (pre-detected):
{_json.dumps(seminal_uncited, indent=2)}

DRAFT MANUSCRIPT:
{draft[:12000]}

Audit the draft according to the rules. Return only the JSON object."""

    try:
        async with TokenContext(project_id=project_id, user_id=user["id"], stage="citation_audit"):
            raw = await provider.generate(audit_system, audit_user, json_mode=True, temperature=0.1)
        result = _json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        result = {}

    # Merge pre-detected seminal papers
    result.setdefault("uncited_key_papers", [])
    result["uncited_key_papers"] = seminal_uncited + result.get("uncited_key_papers", [])
    result.setdefault("unsupported_claims", [])
    result.setdefault("missing_purposes_by_section", {})
    result.setdefault("citation_stacking", [])
    result.setdefault("purpose_mismatch", [])

    return result


@router.post("/sessions/{project_id}/citation_audit")
async def citation_audit_compat(project_id: str, user=Depends(get_current_user)) -> dict:
    return await citation_audit(project_id, user)


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

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="peer_review"):
        report = await generate_peer_review(provider, project_summaries, query, article)
    await save_peer_review_result(project_id, report.model_dump())
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

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="revision"):
        result = await generate_revision_package(
            provider=provider,
            summaries=project_summaries,
            query=query,
            article=payload.article or (project.get("article") or ""),
            review=payload.review,
            journal=payload.selected_journal or (project.get("selected_journal") or ""),
        )
    if result.revised_article.strip():
        publisher = _get_publisher_from_project(project)
        journal_style = await _journal_style_service.get_style(
            journal_name=payload.selected_journal or (project.get("selected_journal") or ""),
            provider=provider,
            publisher=publisher,
        )
        normalized_revised_article = normalize_numbered_citation_order(
            result.revised_article,
            journal_style,
            list(summaries_raw.values()),
        )
        result.revised_article = normalized_revised_article
        await save_article(
            project_id,
            normalized_revised_article,
            payload.selected_journal or (project.get("selected_journal") or ""),
        )
    return result


# ── Real peer-review revision endpoints ───────────────────────────────────────

@router.post("/projects/{project_id}/import_manuscript")
async def import_manuscript_endpoint(
    project_id: str,
    user=Depends(get_current_user),
    file: UploadFile | None = File(default=None),
    text: str = Form(default=""),
) -> dict:
    """
    Upload or paste a manuscript. Extracts text, detects sections and references,
    generates an AI summary, and saves to projects.base_manuscript.
    Accepts multipart/form-data with either `file` (.docx) or `text` field.
    """
    from services.docx_pdf_converter import convert_docx_to_pdf
    from services.manuscript_importer import extract_text_from_docx, import_manuscript
    from services.revision_docx_builder import prepare_revision_manuscript_docx

    # Verify project ownership
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    # Extract text (and preserve raw .docx bytes for formatting-safe exports)
    manuscript_text = ""
    docx_bytes: bytes | None = None
    prepared_docx = False
    reference_pdf_ready = False
    reference_pdf_warning = ""
    if file and file.filename:
        file_bytes = await file.read()
        if file.filename.endswith('.docx'):
            manuscript_text = extract_text_from_docx(file_bytes)
            try:
                docx_bytes = prepare_revision_manuscript_docx(file_bytes)
                prepared_docx = True
            except Exception as exc:
                logger.warning("Failed to prepare uploaded manuscript .docx for revision: %s", exc)
                docx_bytes = file_bytes
                reference_pdf_warning = (
                    "The manuscript was imported, but enabling track changes and line numbering failed."
                )
        else:
            manuscript_text = file_bytes.decode('utf-8', errors='replace')
    elif text:
        manuscript_text = text

    if not manuscript_text.strip():
        raise HTTPException(status_code=400, detail="No manuscript text provided.")

    provider = await _get_provider_for_user(user["id"])
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="import_manuscript"):
        result = await import_manuscript(provider, manuscript_text)

    # Optionally create Gemini cache
    gemini_cache_name = ""
    if provider and provider.config.provider == "gemini":
        try:
            gemini_cache_name = await provider.create_gemini_cache(
                system="You are an expert academic manuscript revision assistant.",
                content=f"FULL MANUSCRIPT:\n{manuscript_text}",
                ttl_seconds=7200,
            ) or ""
        except Exception:
            pass

    # Persist the manuscript text + metadata to DB
    await save_base_manuscript(
        project_id,
        manuscript_text,
        summary=result.get("manuscript_summary", ""),
        section_index=result.get("section_index"),
        gemini_cache_name=gemini_cache_name,
    )

    # Save files to project folder on disk
    project_folder = proj.get("project_folder") or ""
    if project_folder:
        file_paths = save_manuscript_files(project_folder, docx_bytes=docx_bytes, markdown_text=manuscript_text)
        reference_pdf_path = os.path.join(project_folder, "original_manuscript_reference.pdf")
        if docx_bytes and file_paths.get("original_docx"):
            try:
                pdf_path = convert_docx_to_pdf(file_paths["original_docx"], reference_pdf_path)
                file_paths["original_reference_pdf"] = pdf_path
                reference_pdf_ready = True
            except Exception as exc:
                logger.warning("Failed to generate manuscript reference PDF for %s: %s", project_id, exc)
                if os.path.exists(reference_pdf_path):
                    os.remove(reference_pdf_path)
                if not reference_pdf_warning:
                    reference_pdf_warning = str(exc)
        elif os.path.exists(reference_pdf_path):
            os.remove(reference_pdf_path)
        if file_paths:
            await save_manuscript_paths(project_id, file_paths)

    result["prepared_docx"] = prepared_docx
    result["reference_pdf_ready"] = reference_pdf_ready
    result["reference_pdf_warning"] = reference_pdf_warning
    return result


@router.post("/projects/{project_id}/revision_rounds/parse")
async def parse_reviewer_comments_endpoint(
    project_id: str,
    payload: ParseCommentsRequest,
    user=Depends(get_current_user),
) -> list[dict]:
    """Parse pasted reviewer comments into structured RealReviewerComment objects."""
    from services.reviewer_comment_parser import parse_reviewer_comments

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    provider = await _get_provider_for_user(user["id"])
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="parse_comments"):
        comments = await parse_reviewer_comments(provider, payload.raw_comments)
    # Persist parsed comments to comment_work table immediately
    comment_dicts = [c if isinstance(c, dict) else c.model_dump() if hasattr(c, 'model_dump') else dict(c)
                     for c in comments]
    await upsert_comment_work_batch(project_id, payload.round_number, comment_dicts)
    return comments


@router.post("/projects/{project_id}/revision_rounds/parse_docx")
async def parse_reviewer_comments_docx_endpoint(
    project_id: str,
    user=Depends(get_current_user),
    file: UploadFile = File(...),
) -> list[dict]:
    """Parse reviewer comments from an uploaded .docx file."""
    from services.manuscript_importer import extract_text_from_docx
    from services.reviewer_comment_parser import parse_reviewer_comments

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    file_bytes = await file.read()
    if file.filename and file.filename.endswith('.docx'):
        raw_text = extract_text_from_docx(file_bytes)
    else:
        raw_text = file_bytes.decode('utf-8', errors='replace')

    provider = await _get_provider_for_user(user["id"])
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="parse_comments"):
        comments = await parse_reviewer_comments(provider, raw_text)
    comment_dicts = [c if isinstance(c, dict) else c.model_dump() if hasattr(c, 'model_dump') else dict(c)
                     for c in comments]
    await upsert_comment_work_batch(project_id, 1, comment_dicts)
    return comments


@router.post("/projects/{project_id}/revision_rounds/suggest_changes")
async def suggest_changes_endpoint(
    project_id: str,
    payload: SuggestChangesRequest,
    user=Depends(get_current_user),
) -> list[dict]:
    """Generate comment-wise change suggestions (copy-paste ready), without auto-editing manuscript."""
    from services.real_revision_writer import suggest_comment_changes

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    provider = await _get_provider_for_user(user["id"])
    manuscript_text = payload.manuscript_text or proj.get("base_manuscript") or ""
    manuscript_summary = proj.get("base_manuscript_summary") or ""
    section_index = _parse_section_index(proj.get("base_section_index"))
    async with TokenContext(project_id=project_id, user_id=user["id"], stage="revision_suggestions"):
        suggestions = await suggest_comment_changes(
            provider=provider,
            manuscript_text=manuscript_text,
            parsed_comments=[c.model_dump() for c in payload.parsed_comments],
            journal_name=payload.journal_name,
            manuscript_summary=manuscript_summary,
            section_index=section_index,
        )
    # Persist suggestions to comment_work table immediately
    sug_dicts = [s if isinstance(s, dict) else s.model_dump() if hasattr(s, 'model_dump') else dict(s)
                 for s in suggestions]
    await upsert_comment_suggestions_batch(project_id, payload.round_number, sug_dicts)
    return suggestions


@router.post("/projects/{project_id}/revision_rounds/discuss_comment")
async def discuss_comment_endpoint(
    project_id: str,
    payload: DiscussCommentRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    One turn of the per-comment discussion.
    Returns {ai_response: str, updated_plan: str}.
    """
    from services.real_revision_writer import discuss_comment

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    manuscript_text = payload.manuscript_text or proj.get("base_manuscript") or ""
    manuscript_summary = proj.get("base_manuscript_summary") or ""
    section_index = _parse_section_index(proj.get("base_section_index"))

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="revision_discussion"):
        result = await discuss_comment(
            provider=provider,
            original_comment=payload.original_comment,
            user_message=payload.user_message,
            history=payload.history,
            current_plan=payload.current_plan,
            doi_refs=payload.doi_references,
            manuscript_text=manuscript_text,
            finalized_context=payload.finalized_context,
            manuscript_summary=manuscript_summary,
            section_index=section_index,
        )
    # Persist discussion messages + updated plan immediately
    await append_discussion_message(
        project_id, payload.round_number,
        payload.reviewer_number, payload.comment_number,
        [{"role": "user", "content": payload.user_message},
         {"role": "ai", "content": result["ai_response"]}],
        result["updated_plan"],
    )
    return result


@router.post("/projects/{project_id}/revision_rounds/finalize_comment")
async def finalize_comment_endpoint(
    project_id: str,
    payload: FinalizeCommentRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Write formal author_response and action_taken from an agreed change plan.
    Returns {author_response: str, action_taken: str, manuscript_changes: str}.
    """
    from services.real_revision_writer import finalize_comment_response

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    manuscript_text = payload.manuscript_text or proj.get("base_manuscript") or ""
    manuscript_summary = proj.get("base_manuscript_summary") or ""
    section_index = _parse_section_index(proj.get("base_section_index"))

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="revision_finalize"):
        result = await finalize_comment_response(
            provider=provider,
            original_comment=payload.original_comment,
            finalized_plan=payload.finalized_plan,
            manuscript_text=manuscript_text,
            reviewer_number=payload.reviewer_number,
            comment_number=payload.comment_number,
            manuscript_summary=manuscript_summary,
            section_index=section_index,
        )
    # Validate manuscript_changes operations against manuscript text
    validation_warnings: list[str] = []
    mc_str = result.get("manuscript_changes", "[]")
    try:
        ops = json.loads(mc_str)
        if isinstance(ops, list):
            for op in ops:
                search_text = op.get("find") or op.get("anchor", "")
                if search_text and manuscript_text and search_text not in manuscript_text:
                    validation_warnings.append(f"Text not found in manuscript: '{search_text[:60]}...'")
    except (json.JSONDecodeError, TypeError):
        pass  # legacy format — skip validation

    if validation_warnings:
        import logging
        logging.getLogger(__name__).warning(
            "Finalize R%d.C%d validation warnings: %s",
            payload.reviewer_number, payload.comment_number, validation_warnings,
        )

    # Persist finalization immediately
    await save_comment_finalization(
        project_id, payload.round_number,
        payload.reviewer_number, payload.comment_number,
        result["author_response"], result["action_taken"], result["manuscript_changes"],
    )
    result["validation_warnings"] = validation_warnings
    return result


@router.post("/projects/{project_id}/revision_rounds")
async def generate_revision_round_endpoint(
    project_id: str,
    payload: GenerateFromPlansRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Generate revised manuscript from pre-finalized per-comment plans.
    Saves the round to the DB and returns the full RevisionRound data.
    """
    from services.real_revision_writer import generate_revision_from_plans

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    base_manuscript = proj.get("base_manuscript") or ""
    if not base_manuscript.strip():
        raise HTTPException(status_code=400, detail="No manuscript imported. Call import_manuscript first.")

    provider = await _get_provider_for_user(user["id"])
    if not provider:
        raise HTTPException(status_code=400, detail="No AI provider configured.")

    async with TokenContext(project_id=project_id, user_id=user["id"], stage="revision_round"):
        round_data = await generate_revision_from_plans(
            provider=provider,
            manuscript_text=base_manuscript,
            finalized_plans=payload.finalized_plans,
            journal_name=payload.journal_name,
            round_number=payload.round_number,
        )
    await save_revision_round(project_id, round_data)
    await update_project_phase(project_id, f'realrevision_round_{payload.round_number}')
    return round_data


@router.get("/projects/{project_id}/revision_rounds")
async def list_revision_rounds_endpoint(
    project_id: str,
    user=Depends(get_current_user),
) -> list[dict]:
    """List all revision rounds (summary only — no full text)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    rounds = await get_revision_rounds(project_id)
    # Return summary only (omit heavy text fields)
    return [
        {
            "round_number": r.get("round_number"),
            "journal_name": r.get("journal_name", ""),
            "comment_count": len(r.get("parsed_comments", [])),
            "created_at": r.get("created_at", ""),
            "has_revised_article": bool(r.get("revised_article", "").strip()),
        }
        for r in rounds
    ]


@router.get("/projects/{project_id}/revision_wip")
async def get_revision_wip_endpoint(
    project_id: str,
    user=Depends(get_current_user),
) -> dict:
    """Return saved work-in-progress revision state (parsed comments, plans, etc.)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    return await get_revision_wip(project_id)


@router.put("/projects/{project_id}/revision_wip")
async def save_revision_wip_endpoint(
    project_id: str,
    payload: RevisionWipPayload,
    user=Depends(get_current_user),
) -> dict:
    """Persist work-in-progress revision state."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    await save_revision_wip(project_id, payload.model_dump())
    return {"ok": True}


# ── Comment work endpoints (per-comment persistent storage) ──────────────────

@router.get("/projects/{project_id}/comment_work/{round_number}")
async def get_comment_work_endpoint(
    project_id: str,
    round_number: int,
    user=Depends(get_current_user),
) -> list[dict]:
    """Load all per-comment state for a revision round."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    return await get_comment_work_rows(project_id, round_number)


@router.patch("/projects/{project_id}/comment_work/{round_number}/{reviewer_number}/{comment_number}")
async def update_comment_work_endpoint(
    project_id: str,
    round_number: int,
    reviewer_number: int,
    comment_number: int,
    payload: UpdateCommentWorkRequest,
    user=Depends(get_current_user),
) -> dict:
    """Update one comment's fields (plan, DOIs, category, unfinalize, etc.)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    await update_comment_work_fields(project_id, round_number, reviewer_number, comment_number, updates)
    return {"ok": True}


@router.put("/projects/{project_id}/comment_work/{round_number}")
async def replace_comments_endpoint(
    project_id: str,
    round_number: int,
    payload: ReplaceCommentsRequest,
    user=Depends(get_current_user),
) -> dict:
    """Replace all comments for a round (after delete/split/combine/reorder)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")
    await upsert_comment_work_batch(project_id, round_number, payload.comments)
    return {"ok": True}


@router.get("/projects/{project_id}/revision_rounds/{round_number}/point_by_point_docx")
async def download_point_by_point_docx(
    project_id: str,
    round_number: int,
    user=Depends(get_current_user),
) -> Response:
    """Download the point-by-point reply as a formatted .docx (pre-generated)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    if pf:
        cached = os.path.join(pf, f"round_{round_number}", "point_by_point.docx")
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                docx_bytes = f.read()
            filename = f"point_by_point_reply_round{round_number}.docx"
            return Response(
                content=docx_bytes,
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

    raise HTTPException(
        status_code=404,
        detail="Point-by-point document not found. Click 'Generate Documents' first.",
    )


@router.get("/projects/{project_id}/manuscript_reference_pdf")
async def download_manuscript_reference_pdf(
    project_id: str,
    user=Depends(get_current_user),
) -> Response:
    """Download the line-numbered reference PDF generated from the uploaded manuscript."""
    from services.docx_pdf_converter import convert_docx_to_pdf

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    pdf_path = os.path.join(pf, "original_manuscript_reference.pdf")
    docx_path = os.path.join(pf, "original_manuscript.docx")

    if not os.path.exists(pdf_path):
        if not os.path.exists(docx_path):
            raise HTTPException(status_code=404, detail="Reference manuscript PDF not found.")
        try:
            convert_docx_to_pdf(docx_path, pdf_path)
        except Exception as exc:
            logger.error("Manuscript reference PDF generation failed for %s: %s", project_id, exc)
            raise HTTPException(status_code=500, detail=f"Reference manuscript PDF generation failed: {exc}")

    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()

    filename = f"manuscript_reference_{project_id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/revision_rounds/{round_number}/revised_manuscript_docx")
async def download_revised_manuscript_docx(
    project_id: str,
    round_number: int,
    user=Depends(get_current_user),
) -> Response:
    """Download the clean revised manuscript as a .docx.

    Serves cached file generated by generate_all_docs.
    Falls back to deriving from track_changes.docx if cached clean file missing.
    """
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    docx_bytes = None

    # Strategy 1: cached clean file on disk
    if pf:
        cached = os.path.join(pf, f"round_{round_number}", "revised_manuscript.docx")
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                docx_bytes = f.read()

    # Strategy 2: derive from existing track_changes.docx on disk
    if not docx_bytes and pf:
        tc_path = os.path.join(pf, f"round_{round_number}", "track_changes.docx")
        if os.path.exists(tc_path):
            from services.revision_docx_builder import generate_clean_docx
            with open(tc_path, "rb") as f:
                docx_bytes = generate_clean_docx(f.read())
            save_round_export(pf, round_number, "revised_manuscript.docx", docx_bytes)

    if not docx_bytes:
        raise HTTPException(
            status_code=404,
            detail="Revised manuscript not found. Click 'Generate Documents' first.",
        )

    filename = f"revised_manuscript_round{round_number}.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/revision_rounds/{round_number}/revised_manuscript_pdf")
async def download_revised_manuscript_pdf(
    project_id: str,
    round_number: int,
    user=Depends(get_current_user),
) -> Response:
    """Download the revised manuscript as a line-numbered PDF."""
    from services.docx_pdf_converter import convert_docx_to_pdf
    from services.revision_docx_builder import generate_clean_docx

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    if not pf:
        raise HTTPException(status_code=404, detail="Project folder not found.")

    round_dir = os.path.join(pf, f"round_{round_number}")
    pdf_path = os.path.join(round_dir, "revised_manuscript.pdf")
    clean_path = os.path.join(round_dir, "revised_manuscript.docx")
    tc_path = os.path.join(round_dir, "track_changes.docx")

    if not os.path.exists(pdf_path):
        if not os.path.exists(clean_path) and os.path.exists(tc_path):
            with open(tc_path, "rb") as f:
                clean_bytes = generate_clean_docx(f.read())
            save_round_export(pf, round_number, "revised_manuscript.docx", clean_bytes)

        if not os.path.exists(clean_path):
            raise HTTPException(
                status_code=404,
                detail="Revised manuscript PDF not found. Click 'Generate Documents' first.",
            )

        try:
            convert_docx_to_pdf(clean_path, pdf_path)
        except Exception as exc:
            logger.error("Revised manuscript PDF generation failed for %s round %s: %s", project_id, round_number, exc)
            raise HTTPException(status_code=500, detail=f"Revised manuscript PDF generation failed: {exc}")

    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()

    filename = f"revised_manuscript_round{round_number}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/revision_rounds/{round_number}/track_changes_docx")
async def download_track_changes_docx(
    project_id: str,
    round_number: int,
    user=Depends(get_current_user),
) -> Response:
    """Download track-changes .docx (pre-generated by generate_all_docs)."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    if pf:
        cached = os.path.join(pf, f"round_{round_number}", "track_changes.docx")
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                docx_bytes = f.read()
            filename = f"track_changes_round{round_number}.docx"
            return Response(
                content=docx_bytes,
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

    raise HTTPException(
        status_code=404,
        detail="Track changes document not found. Click 'Generate Documents' first.",
    )


# ── Generate all revision documents at once ────────────────────────────────────

@router.post("/projects/{project_id}/revision_rounds/generate_all_docs")
async def generate_all_docs(
    project_id: str,
    payload: GenerateAllDocsRequest,
    user=Depends(get_current_user),
) -> dict:
    """Generate the revision document package in one call:
    1. Track changes .docx (direct editing via docx-revisions)
    2. Clean revised .docx (accept all changes)
    3. Line-numbered revised manuscript .pdf
    4. Point-by-point reply .docx
    """
    from services.docx_pdf_converter import convert_docx_to_pdf
    from services.revision_docx_builder import (
        apply_direct_track_changes,
        build_point_by_point_docx,
        generate_clean_docx,
    )

    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    pf = proj.get("project_folder", "")
    manuscript_text = proj.get("base_manuscript") or ""

    # Load original .docx
    saved_docx = get_original_docx_bytes(pf)
    if not saved_docx:
        raise HTTPException(status_code=400, detail="No original .docx found for this project.")

    # Load finalized plans from comment_work table
    plans = await get_comment_work_rows(project_id, payload.round_number)
    finalized = [dict(p) for p in plans if p.get("is_finalized")]
    if not finalized:
        raise HTTPException(status_code=400, detail="No finalized comments found. Finalize at least one comment first.")

    # 1. Track changes .docx (direct editing via docx-revisions)
    try:
        tc_bytes = apply_direct_track_changes(
            saved_docx, finalized, author=payload.author, manuscript_text=manuscript_text,
        )
    except Exception as exc:
        logger.error("Track changes generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Track changes generation failed: {exc}")

    # 2. Clean .docx (accept all changes)
    try:
        clean_bytes = generate_clean_docx(tc_bytes)
    except Exception as exc:
        logger.error("Clean docx generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Clean docx generation failed: {exc}")

    # 3. Point-by-point .docx
    # Build round_data structure from finalized plans
    responses = []
    for p in finalized:
        responses.append({
            "reviewer_number": p.get("reviewer_number", 0),
            "comment_number": p.get("comment_number", 0),
            "original_comment": p.get("original_comment", ""),
            "author_response": p.get("author_response", ""),
            "action_taken": p.get("action_taken", ""),
            "manuscript_changes": p.get("manuscript_changes", ""),
        })
    round_data = {"round_number": payload.round_number, "responses": responses}
    manuscript_title = proj.get("manuscript_title") or proj.get("project_name") or ""

    try:
        pbp_bytes = build_point_by_point_docx(round_data, manuscript_title=manuscript_title)
    except Exception as exc:
        logger.error("Point-by-point generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Point-by-point generation failed: {exc}")

    revised_pdf_ready = False
    if pf:
        clear_round_exports(pf, payload.round_number)
        path = save_round_export(pf, payload.round_number, "track_changes.docx", tc_bytes)
        clean_path = save_round_export(pf, payload.round_number, "revised_manuscript.docx", clean_bytes)
        pbp_path = save_round_export(pf, payload.round_number, "point_by_point.docx", pbp_bytes)
        revised_pdf_path = os.path.join(pf, f"round_{payload.round_number}", "revised_manuscript.pdf")
        try:
            convert_docx_to_pdf(clean_path, revised_pdf_path)
            revised_pdf_ready = True
        except Exception as exc:
            logger.warning(
                "Failed to generate revised manuscript PDF for %s round %s: %s",
                project_id,
                payload.round_number,
                exc,
            )
        await save_manuscript_paths(project_id, {
            f"round_{payload.round_number}_track_changes": path,
            f"round_{payload.round_number}_revised": clean_path,
            f"round_{payload.round_number}_point_by_point": pbp_path,
            **(
                {f"round_{payload.round_number}_revised_pdf": revised_pdf_path}
                if revised_pdf_ready else {}
            ),
        })

    return {
        "status": "ok",
        "round_number": payload.round_number,
        "revised_pdf_ready": revised_pdf_ready,
    }


# ── Download entire project as zip ─────────────────────────────────────────────

@router.get("/projects/{project_id}/download_zip")
async def download_project_zip(project_id: str, user=Depends(get_current_user)) -> Response:
    """Download the entire project folder as a zip file."""
    proj = await load_project_minimal(project_id)
    if not proj or proj.get("user_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Project not found.")

    project_folder = proj.get("project_folder", "")
    if not project_folder or not os.path.isdir(project_folder):
        raise HTTPException(status_code=404, detail="Project folder not found on disk.")

    project_name = proj.get("project_name") or project_id
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(project_folder):
            for fname in files:
                abs_path = os.path.join(root, fname)
                arc_name = os.path.join(project_name, os.path.relpath(abs_path, project_folder))
                zf.write(abs_path, arc_name)
    buf.seek(0)

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project_name}.zip"'},
    )


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
