"""
project_repo.py

User-scoped persistence using the async SQLAlchemy engine (Postgres).
Maintains the same JSON blob contract as session_repo, but with Projects terminology.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)
from typing import Optional

from sqlalchemy import select, insert, update, delete, func
from sqlalchemy.ext.asyncio import AsyncEngine

from services.db import create_engine_async, projects, papers, summaries, journal_recs, screenings, comment_work
from services.manuscript_citation_formatter import build_citation_map, reinject_citation_markers


def _now() -> datetime:
    return datetime.utcnow()


# ── Folder helpers ─────────────────────────────────────────────────────────────

def _auto_project_name(query: str) -> str:
    """Slugify first 50 chars of query for use as initial project name."""
    slug = re.sub(r'[^a-zA-Z0-9 ]', '', query).strip()
    slug = re.sub(r'\s+', '_', slug)[:50]
    return slug or "project"


def auto_project_title(query: str, max_len: int = 80) -> str:
    """Create a readable fallback display title from the user's query."""
    title = re.sub(r'\s+', ' ', (query or '').strip())
    title = title[:max_len].strip()
    return title or "Project"


def slugify_project_name(text: str, max_len: int = 80) -> str:
    """Slugify any text into a clean folder-safe name."""
    slug = re.sub(r'[^a-zA-Z0-9 ]', '', text).strip()
    slug = re.sub(r'\s+', '_', slug)[:max_len]
    return slug or "project"


def _project_base_dir() -> str:
    """Return the base directory for all project folders: backend/public/projects/."""
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), "public", "projects")


def _project_storage_root(pdf_save_path: Optional[str] = None) -> str:
    """Return the base directory used for project folders."""
    custom_root = str(pdf_save_path or "").strip()
    return custom_root or _project_base_dir()


def resolve_project_folder_path(project_name: str, pdf_save_path: Optional[str] = None) -> str:
    """Return the canonical folder path for a project name under the active storage root."""
    folder_slug = slugify_project_name((project_name or "").strip() or "project") or "project"
    return os.path.join(_project_storage_root(pdf_save_path), folder_slug)


def ensure_project_folder(project_name: str, pdf_save_path: Optional[str] = None) -> str:
    """Create and return the canonical project folder path."""
    folder = resolve_project_folder_path(project_name, pdf_save_path=pdf_save_path)
    os.makedirs(folder, exist_ok=True)
    return folder


def _make_project_folder(project_name: str) -> str:
    """Return (and create) the project folder path under backend/public/projects/."""
    folder = os.path.join(_project_base_dir(), project_name)
    os.makedirs(folder, exist_ok=True)
    return folder


# ── CRUD ───────────────────────────────────────────────────────────────────────

async def create_project(
    user_id: str,
    query: str,
    papers_list: list[dict],
    engine: Optional[AsyncEngine] = None,
    article_type: Optional[str] = None,
    project_description: Optional[str] = None,
    pdf_save_path: Optional[str] = None,
    project_name: Optional[str] = None,
    project_type: Optional[str] = 'write',
    literature_search_state: Optional[dict] = None,
) -> str:
    eng = engine or create_engine_async()
    pid = uuid.uuid4().hex[:8]

    display_name = (project_name or "").strip() or auto_project_title(query)
    project_folder = ensure_project_folder(display_name, pdf_save_path=pdf_save_path)

    async with eng.begin() as conn:
        await conn.execute(insert(projects).values(
            project_id=pid,
            user_id=user_id,
            query=query,
            project_name=display_name,
            project_description=project_description,
            project_folder=project_folder,
            current_phase='intake',
            created_at=_now(),
            updated_at=_now(),
            article_type=article_type,
            project_type=project_type or 'write',
            revision_rounds='[]',
            literature_search_state=(
                literature_search_state
                if projects.c.literature_search_state.type.__class__.__name__.lower() == 'jsonb' or literature_search_state is None
                else json.dumps(literature_search_state, ensure_ascii=False)
            ),
        ))
        is_jsonb = papers.c.data.type.__class__.__name__.lower() == 'jsonb'
        for p in papers_list:
            await conn.execute(insert(papers).values(
                project_id=pid,
                paper_key=(p.get('doi') or (p.get('title') or '')[:60]).lower().strip(),
                data=(p if is_jsonb else json.dumps(p, ensure_ascii=False)),
            ))
    return pid


async def list_projects(user_id: str) -> list[dict]:
    eng = create_engine_async()
    async with eng.connect() as conn:
        paper_count = select(func.count().label('c')).where(papers.c.project_id == projects.c.project_id).correlate(projects).scalar_subquery()
        summary_count = select(func.count().label('c')).where(summaries.c.project_id == projects.c.project_id).correlate(projects).scalar_subquery()
        has_journals = select(func.count().label('c')).where(journal_recs.c.project_id == projects.c.project_id).correlate(projects).scalar_subquery()
        res = await conn.execute(
            select(
                projects.c.project_id,
                projects.c.query,
                projects.c.created_at,
                projects.c.updated_at,
                projects.c.selected_journal,
                projects.c.manuscript_title,
                projects.c.article_type,
                projects.c.project_name,
                projects.c.project_description,
                projects.c.project_folder,
                projects.c.current_phase,
                projects.c.project_type,
                (projects.c.article.is_not(None) & (projects.c.article != '')).label('has_article'),
                paper_count.label('paper_count'),
                summary_count.label('summary_count'),
                (has_journals > 0).label('has_journals'),
            ).where(projects.c.user_id == user_id).order_by(projects.c.updated_at.desc())
        )
        return [dict(r._mapping) for r in res]


async def load_project(user_id: str, project_id: str) -> Optional[dict]:
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(select(projects).where(
            (projects.c.project_id == project_id) & (projects.c.user_id == user_id)
        ))).mappings().first()
        if not row:
            return None

        pr = await conn.execute(select(papers.c.data).where(papers.c.project_id == project_id).order_by(papers.c.paper_key))
        sr = await conn.execute(select(summaries.c.paper_key, summaries.c.data).where(summaries.c.project_id == project_id))
        jr = await conn.execute(select(journal_recs.c.data).where(journal_recs.c.project_id == project_id))

        def _coerce(v):
            if isinstance(v, (dict, list)):
                return v
            try:
                return json.loads(v)
            except Exception:
                return v

        row_dict = dict(row)
        row_dict["literature_search_state"] = _coerce(row_dict.get("literature_search_state"))
        papers_list = [_coerce(r[0]) for r in pr]
        summaries_map = {k: _coerce(v) for k, v in sr}
        jr_first = jr.mappings().first()
        journal_list = _coerce(jr_first["data"]) if jr_first else []

        article_text = str(row_dict.get("article") or "")
        citation_map_text = row_dict.get("citation_map")
        stored_citation_map = _coerce(citation_map_text) if citation_map_text else {}
        if not isinstance(stored_citation_map, dict):
            stored_citation_map = {}

        updated_fields: dict = {}

        if article_text and not stored_citation_map and "[CITE:" in article_text:
            rebuilt_map = build_citation_map(article_text, list(summaries_map.values()))
            if rebuilt_map:
                citation_map_text = json.dumps(rebuilt_map, ensure_ascii=False)
                row_dict["citation_map"] = citation_map_text
                stored_citation_map = rebuilt_map
                updated_fields["citation_map"] = citation_map_text

        if article_text and stored_citation_map and "[CITE:" not in article_text:
            restored_article = reinject_citation_markers(article_text, stored_citation_map)
            if restored_article != article_text:
                row_dict["article"] = restored_article
                updated_fields["article"] = restored_article

        if updated_fields:
            await conn.execute(
                update(projects)
                .where(projects.c.project_id == project_id)
                .values(**updated_fields)
            )

        return {
            **row_dict,
            'papers': papers_list,
            'summaries': summaries_map,
            'journal_recs': journal_list,
            'visual_recommendations': _coerce(row_dict.get("visual_recommendations")),
        }


async def load_project_minimal(project_id: str) -> dict:
    """Load the project row excluding heavy blob columns — for internal use."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(select(projects).where(
            projects.c.project_id == project_id
        ))).mappings().first()
        return dict(row) if row else {}


async def delete_project(user_id: str, project_id: str) -> bool:
    eng = create_engine_async()
    async with eng.begin() as conn:
        own = (await conn.execute(select(projects.c.project_id).where(
            (projects.c.project_id == project_id) & (projects.c.user_id == user_id)
        ))).first()
        if not own:
            return False
        await conn.execute(delete(projects).where(projects.c.project_id == project_id))
        return True


# ── Summary & data persistence ─────────────────────────────────────────────────

async def save_summary(project_id: str, paper_key: str, summary: dict) -> None:
    """Upsert a paper summary."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        is_jsonb = summaries.c.data.type.__class__.__name__.lower() == 'jsonb'
        payload = summary if is_jsonb else json.dumps(summary, ensure_ascii=False)
        now = _now()

        existing = (await conn.execute(
            select(summaries.c.paper_key).where(
                (summaries.c.project_id == project_id) &
                (summaries.c.paper_key == paper_key)
            )
        )).first()

        if existing:
            await conn.execute(
                update(summaries)
                .where(
                    (summaries.c.project_id == project_id) &
                    (summaries.c.paper_key == paper_key)
                )
                .values(data=payload)
            )
        else:
            await conn.execute(
                insert(summaries).values(
                    project_id=project_id, paper_key=paper_key,
                    data=payload, created_at=now,
                )
            )

        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(updated_at=_now())
        )


async def get_existing_summary_keys(project_id: str) -> set[str]:
    eng = create_engine_async()
    async with eng.connect() as conn:
        res = await conn.execute(select(summaries.c.paper_key).where(summaries.c.project_id == project_id))
        return {r[0] for r in res}


async def clear_project_summaries(project_id: str) -> int:
    """Delete all summaries for a project. Returns count of deleted rows."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        result = await conn.execute(
            delete(summaries).where(summaries.c.project_id == project_id)
        )
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(updated_at=_now())
        )
        return result.rowcount


async def save_journal_recs(project_id: str, recs: list[dict]) -> None:
    eng = create_engine_async()
    is_jsonb = journal_recs.c.data.type.__class__.__name__.lower() == 'jsonb'
    payload = recs if is_jsonb else json.dumps(recs, ensure_ascii=False)
    async with eng.begin() as conn:
        upd = await conn.execute(
            update(journal_recs)
            .where(journal_recs.c.project_id == project_id)
            .values(data=payload, updated_at=_now())
        )
        if upd.rowcount == 0:
            await conn.execute(insert(journal_recs).values(project_id=project_id, data=payload, updated_at=_now()))
        await conn.execute(update(projects).where(projects.c.project_id == project_id).values(updated_at=_now()))


async def save_article(
    project_id: str,
    article: str,
    selected_journal: Optional[str] = None,
    citation_map: Optional[str] = None,
) -> None:
    eng = create_engine_async()
    vals: dict = dict(
        article=article,
        selected_journal=selected_journal or projects.c.selected_journal,
        # Always update citation_map — use empty JSON object when None
        # to prevent stale maps from previous drafts persisting
        citation_map=citation_map or "{}",
        updated_at=_now(),
    )
    async with eng.begin() as conn:
        result = await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(**vals)
        )
        if result.rowcount == 0:
            logger.warning("save_article: no row updated for project_id=%s", project_id)
        else:
            logger.info(
                "save_article: saved %d chars, citation_map=%d chars for project_id=%s",
                len(article), len(citation_map or "{}"), project_id,
            )


async def save_manuscript_title(project_id: str, title: str) -> None:
    """Persist the approved manuscript title for this project."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(manuscript_title=title, updated_at=_now())
        )


async def save_article_type(project_id: str, article_type: str) -> None:
    """Persist the article type for this project."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(article_type=article_type, updated_at=_now())
        )


# ── New project management functions ──────────────────────────────────────────

async def update_project_name(project_id: str, new_name: str) -> str:
    """Rename project, rename folder on disk, return new folder path."""
    proj = await load_project_minimal(project_id)
    old_folder = proj.get("project_folder")
    display_name = (new_name or "").strip() or "Project"
    folder_slug = slugify_project_name(display_name)
    # Preserve the same base directory (user's pdf_save_path) when renaming
    if old_folder:
        base = os.path.dirname(old_folder)
        new_folder = os.path.join(base, folder_slug)
        os.makedirs(new_folder, exist_ok=True)
    else:
        new_folder = ensure_project_folder(display_name)
    if old_folder and os.path.exists(old_folder) and old_folder != new_folder:
        try:
            os.rename(old_folder, new_folder)
        except OSError:
            pass  # folder may have been moved manually; create fresh
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(project_name=display_name, project_folder=new_folder, updated_at=_now())
        )
    return new_folder


async def update_project_phase(project_id: str, phase: str) -> None:
    """Update current_phase."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(current_phase=phase, updated_at=_now())
        )


async def update_project_folder(project_id: str, folder: str) -> None:
    """Update project_folder path."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(project_folder=folder, updated_at=_now())
        )


async def save_literature_search_state(
    project_id: str,
    state: dict | None,
    *,
    query: str | None = None,
) -> None:
    """Persist the live literature-search snapshot used to restore the dashboard."""
    eng = create_engine_async()
    is_jsonb = projects.c.literature_search_state.type.__class__.__name__.lower() == 'jsonb'
    values: dict = {
        "literature_search_state": state if is_jsonb or state is None else json.dumps(state, ensure_ascii=False),
        "updated_at": _now(),
    }
    if query is not None:
        values["query"] = query
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(**values)
        )


async def replace_project_papers(project_id: str, papers_list: list[dict]) -> None:
    """Replace the project's selected paper set with a fresh ranked result list."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(delete(papers).where(papers.c.project_id == project_id))
        is_jsonb = papers.c.data.type.__class__.__name__.lower() == 'jsonb'
        for p in papers_list:
            await conn.execute(insert(papers).values(
                project_id=project_id,
                paper_key=(p.get('doi') or (p.get('title') or '')[:60]).lower().strip(),
                data=(p if is_jsonb else json.dumps(p, ensure_ascii=False)),
            ))
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(updated_at=_now())
        )


# ── Revision round persistence ─────────────────────────────────────────────────

async def save_base_manuscript(
    project_id: str,
    text: str,
    summary: str = "",
    section_index: list[dict] | None = None,
    gemini_cache_name: str = "",
) -> None:
    """Store the imported manuscript text and optional metadata."""
    values: dict = {"base_manuscript": text, "updated_at": _now()}
    if summary:
        values["base_manuscript_summary"] = summary
    if section_index is not None:
        values["base_section_index"] = json.dumps(section_index, ensure_ascii=False)
    if gemini_cache_name:
        values["gemini_cache_name"] = gemini_cache_name
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(**values)
        )


# ── Filesystem helpers ─────────────────────────────────────────────────────────

def save_manuscript_files(
    project_folder: str,
    docx_bytes: bytes | None = None,
    markdown_text: str = "",
) -> dict:
    """Save manuscript files to project folder. Returns dict of saved file paths."""
    os.makedirs(project_folder, exist_ok=True)
    paths: dict[str, str] = {}
    docx_path = os.path.join(project_folder, "original_manuscript.docx")
    md_path = os.path.join(project_folder, "original_manuscript.md")

    if docx_bytes:
        with open(docx_path, "wb") as f:
            f.write(docx_bytes)
        paths["original_docx"] = docx_path
    elif os.path.exists(docx_path):
        os.remove(docx_path)

    if markdown_text:
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(markdown_text)
        paths["original_md"] = md_path
    elif os.path.exists(md_path):
        os.remove(md_path)
    return paths


def get_original_docx_bytes(project_folder: str) -> bytes | None:
    """Load original .docx from project folder (None if not found or text-only import)."""
    if not project_folder:
        return None
    path = os.path.join(project_folder, "original_manuscript.docx")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    return None


def save_round_export(project_folder: str, round_number: int, filename: str, data: bytes) -> str:
    """Save a revision round export to round subfolder. Returns saved file path."""
    round_dir = os.path.join(project_folder, f"round_{round_number}")
    os.makedirs(round_dir, exist_ok=True)
    path = os.path.join(round_dir, filename)
    with open(path, "wb") as f:
        f.write(data)
    return path


def clear_round_exports(project_folder: str, round_number: int) -> None:
    """Delete all previously generated files for a revision round."""
    if not project_folder:
        return
    round_dir = os.path.join(project_folder, f"round_{round_number}")
    if os.path.isdir(round_dir):
        shutil.rmtree(round_dir)


async def save_manuscript_paths(project_id: str, paths: dict) -> None:
    """Persist manuscript file paths to DB (merge with existing)."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(
            select(projects.c.manuscript_files).where(projects.c.project_id == project_id)
        )).first()
        existing = {}
        if row and row[0]:
            try:
                existing = json.loads(row[0]) if isinstance(row[0], str) else row[0]
            except Exception:
                existing = {}
        existing.update(paths)
        await conn.execute(
            update(projects).where(projects.c.project_id == project_id)
            .values(manuscript_files=json.dumps(existing, ensure_ascii=False))
        )


async def get_manuscript_paths(project_id: str) -> dict:
    """Retrieve stored manuscript file paths."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.manuscript_files).where(projects.c.project_id == project_id)
        )).first()
    if row and row[0]:
        try:
            return json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            return {}
    return {}


async def get_revision_rounds(project_id: str) -> list[dict]:
    """Return all saved revision rounds for this project."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.revision_rounds)
            .where(projects.c.project_id == project_id)
        )).first()
        if not row or not row[0]:
            return []
        raw = row[0]
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except Exception:
                return []
        return raw if isinstance(raw, list) else []


async def save_synthesis_result(project_id: str, result: dict) -> None:
    """Persist the cross-paper synthesis result."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(synthesis_result=json.dumps(result, ensure_ascii=False), updated_at=_now())
        )


async def get_synthesis_result(project_id: str) -> dict | None:
    """Return the saved synthesis result, or None if not yet run."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.synthesis_result)
            .where(projects.c.project_id == project_id)
        )).first()
        if not row or not row[0]:
            return None
        try:
            return json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            return None


async def save_deep_synthesis_result(project_id: str, result: dict) -> None:
    """Persist the deep synthesis result."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(deep_synthesis_result=json.dumps(result, ensure_ascii=False), updated_at=_now())
        )


async def get_deep_synthesis_result(project_id: str) -> dict | None:
    """Return the saved deep synthesis result, or None if not yet run."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.deep_synthesis_result)
            .where(projects.c.project_id == project_id)
        )).first()
        if not row or not row[0]:
            return None
        try:
            return json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            return None


async def save_peer_review_result(project_id: str, result: dict) -> None:
    """Persist the peer review report."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(peer_review_result=json.dumps(result, ensure_ascii=False), updated_at=_now())
        )


async def get_peer_review_result(project_id: str) -> dict | None:
    """Return the saved peer review report, or None if not yet run."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.peer_review_result)
            .where(projects.c.project_id == project_id)
        )).first()
        if not row or not row[0]:
            return None
        try:
            return json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            return None


async def save_revision_wip(project_id: str, wip: dict) -> None:
    """Save intermediate revision work-in-progress state (parsed comments, plans, etc.)."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(revision_wip=json.dumps(wip, ensure_ascii=False), updated_at=_now())
        )


async def get_revision_wip(project_id: str) -> dict:
    """Return WIP state + base_manuscript for resuming a revision project."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.revision_wip, projects.c.base_manuscript)
            .where(projects.c.project_id == project_id)
        )).first()
        if not row:
            return {}
        wip: dict = {}
        if row[0]:
            try:
                wip = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
            except Exception:
                pass
        # Always include manuscript_text from base_manuscript so frontend can restore it
        if row[1]:
            wip["manuscript_text"] = row[1]
        return wip


async def get_revision_agent_state(project_id: str) -> dict:
    """Return persisted AI revision-agent state nested inside revision_wip."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.revision_wip).where(projects.c.project_id == project_id)
        )).first()
        if not row or not row[0]:
            return {}
        try:
            raw = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
        except Exception:
            return {}
        if not isinstance(raw, dict):
            return {}
        state = raw.get("ai_revision_agent", {})
        return state if isinstance(state, dict) else {}


async def save_revision_agent_state(project_id: str, state: dict) -> None:
    """Persist AI revision-agent state inside revision_wip without clobbering other WIP data."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(
            select(projects.c.revision_wip).where(projects.c.project_id == project_id)
        )).first()
        existing: dict = {}
        if row and row[0]:
            try:
                existing = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or {})
            except Exception:
                existing = {}
        if not isinstance(existing, dict):
            existing = {}
        existing["ai_revision_agent"] = state
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(revision_wip=json.dumps(existing, ensure_ascii=False), updated_at=_now())
        )


async def save_revision_round(project_id: str, round_data: dict) -> None:
    """Upsert a revision round by round_number."""
    rounds = await get_revision_rounds(project_id)
    # Replace existing round with same number or append
    idx = next((i for i, r in enumerate(rounds) if r.get('round_number') == round_data.get('round_number')), None)
    if idx is not None:
        rounds[idx] = round_data
    else:
        rounds.append(round_data)
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(revision_rounds=json.dumps(rounds, ensure_ascii=False), updated_at=_now())
        )


# ── Screening persistence ──────────────────────────────────────────────────────

async def save_screening(project_id: str, paper_key: str, decision: str, reason: str) -> None:
    """Upsert a screening decision."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        existing = (await conn.execute(
            select(screenings.c.paper_key).where(
                (screenings.c.project_id == project_id) &
                (screenings.c.paper_key == paper_key)
            )
        )).first()
        if existing:
            await conn.execute(
                update(screenings)
                .where(
                    (screenings.c.project_id == project_id) &
                    (screenings.c.paper_key == paper_key)
                )
                .values(decision=decision, reason=reason)
            )
        else:
            await conn.execute(
                insert(screenings).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    decision=decision,
                    reason=reason,
                    overridden="false",
                )
            )


async def get_screenings(project_id: str) -> dict[str, dict]:
    """Return {paper_key: {"decision": ..., "reason": ..., "overridden": bool}}."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        res = await conn.execute(
            select(
                screenings.c.paper_key,
                screenings.c.decision,
                screenings.c.reason,
                screenings.c.overridden,
            ).where(screenings.c.project_id == project_id)
        )
        return {
            r[0]: {
                "decision": r[1],
                "reason": r[2],
                "overridden": r[3] == "true",
            }
            for r in res
        }


async def override_screening(project_id: str, paper_key: str, decision: str) -> None:
    """Override a screening decision (marks overridden=true)."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        existing = (await conn.execute(
            select(screenings.c.paper_key).where(
                (screenings.c.project_id == project_id) &
                (screenings.c.paper_key == paper_key)
            )
        )).first()
        if existing:
            await conn.execute(
                update(screenings)
                .where(
                    (screenings.c.project_id == project_id) &
                    (screenings.c.paper_key == paper_key)
                )
                .values(decision=decision, overridden="true")
            )
        else:
            await conn.execute(
                insert(screenings).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    decision=decision,
                    reason="",
                    overridden="true",
                )
            )


# ── Comment work CRUD ─────────────────────────────────────────────────────────

async def upsert_comment_work_batch(
    project_id: str, round_number: int, comments: list[dict],
) -> None:
    """Bulk upsert parsed comments into comment_work table (replaces existing)."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            delete(comment_work).where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
            )
        )
        now = datetime.utcnow().isoformat()
        for c in comments:
            await conn.execute(insert(comment_work).values(
                project_id=project_id,
                round_number=round_number,
                reviewer_number=c.get("reviewer_number", 0),
                comment_number=c.get("comment_number", 0),
                original_comment=c.get("original_comment", ""),
                category=c.get("category", "major"),
                severity=c.get("severity", "major"),
                domain=c.get("domain", "other"),
                requirement_level=c.get("requirement_level", "unclear"),
                ambiguity_flag="true" if c.get("ambiguity_flag") else "false",
                ambiguity_question=c.get("ambiguity_question", ""),
                intent_interpretation=c.get("intent_interpretation", ""),
                # Preserve existing plan/discussion if passed (for replace-all scenarios)
                discussion=json.dumps(c.get("discussion", [])),
                current_plan=c.get("current_plan", ""),
                doi_references=json.dumps(c.get("doi_references", [])),
                is_finalized="true" if c.get("is_finalized") else "false",
                author_response=c.get("author_response", ""),
                action_taken=c.get("action_taken", ""),
                manuscript_changes=c.get("manuscript_changes", ""),
                suggestion=json.dumps(c["suggestion"]) if c.get("suggestion") else None,
                created_at=now,
                updated_at=now,
            ))


async def upsert_comment_suggestions_batch(
    project_id: str, round_number: int, suggestions: list[dict],
) -> None:
    """Save AI suggestions for all comments at once."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        now = datetime.utcnow().isoformat()
        for s in suggestions:
            await conn.execute(
                update(comment_work)
                .where(
                    (comment_work.c.project_id == project_id)
                    & (comment_work.c.round_number == round_number)
                    & (comment_work.c.reviewer_number == s.get("reviewer_number", 0))
                    & (comment_work.c.comment_number == s.get("comment_number", 0))
                )
                .values(suggestion=json.dumps(s, ensure_ascii=False), updated_at=now)
            )


async def append_discussion_message(
    project_id: str, round_number: int,
    reviewer_number: int, comment_number: int,
    messages: list[dict], updated_plan: str,
) -> None:
    """Append discussion messages and update the plan for one comment."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = (await conn.execute(
            select(comment_work.c.discussion).where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
                & (comment_work.c.reviewer_number == reviewer_number)
                & (comment_work.c.comment_number == comment_number)
            )
        )).first()
        existing: list = []
        if row and row[0]:
            existing = row[0] if isinstance(row[0], list) else json.loads(row[0])
        existing.extend(messages)
        await conn.execute(
            update(comment_work)
            .where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
                & (comment_work.c.reviewer_number == reviewer_number)
                & (comment_work.c.comment_number == comment_number)
            )
            .values(
                discussion=json.dumps(existing, ensure_ascii=False),
                current_plan=updated_plan,
                updated_at=datetime.utcnow().isoformat(),
            )
        )


async def save_comment_finalization(
    project_id: str, round_number: int,
    reviewer_number: int, comment_number: int,
    author_response: str, action_taken: str, manuscript_changes: str,
) -> None:
    """Mark a comment as finalized and save the outputs."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(comment_work)
            .where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
                & (comment_work.c.reviewer_number == reviewer_number)
                & (comment_work.c.comment_number == comment_number)
            )
            .values(
                is_finalized="true",
                author_response=author_response,
                action_taken=action_taken,
                manuscript_changes=manuscript_changes,
                updated_at=datetime.utcnow().isoformat(),
            )
        )


async def update_comment_work_fields(
    project_id: str, round_number: int,
    reviewer_number: int, comment_number: int,
    updates: dict,
) -> None:
    """Update arbitrary allowed fields on one comment_work row."""
    allowed = {
        "original_comment", "category", "severity", "domain", "requirement_level",
        "current_plan", "doi_references", "is_finalized",
        "author_response", "action_taken", "manuscript_changes",
    }
    values = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "doi_references":
            values[k] = json.dumps(v, ensure_ascii=False)
        elif k == "is_finalized":
            values[k] = "true" if v else "false"
            if not v:
                values["author_response"] = ""
                values["action_taken"] = ""
                values["manuscript_changes"] = ""
        else:
            values[k] = v
    if not values:
        return
    values["updated_at"] = datetime.utcnow().isoformat()
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(comment_work)
            .where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
                & (comment_work.c.reviewer_number == reviewer_number)
                & (comment_work.c.comment_number == comment_number)
            )
            .values(**values)
        )


async def get_comment_work_rows(
    project_id: str, round_number: int,
) -> list[dict]:
    """Load all comment_work rows for one round, ordered by reviewer then comment."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        res = await conn.execute(
            select(comment_work)
            .where(
                (comment_work.c.project_id == project_id)
                & (comment_work.c.round_number == round_number)
            )
            .order_by(comment_work.c.reviewer_number, comment_work.c.comment_number)
        )
        rows = []
        for r in res.mappings():
            d = dict(r)
            for field in ("suggestion", "discussion", "doi_references"):
                if isinstance(d.get(field), str):
                    try:
                        d[field] = json.loads(d[field])
                    except Exception:
                        pass
            d["is_finalized"] = d.get("is_finalized") == "true"
            d["ambiguity_flag"] = d.get("ambiguity_flag") == "true"
            rows.append(d)
        return rows


# ── Visual recommendations ─────────────────────────────────────────────────────

async def save_visual_recommendations(project_id: str, recs: dict) -> None:
    """Persist VisualRecommendations payload to projects.visual_recommendations (JSONB)."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(visual_recommendations=recs, updated_at=_now())
        )


async def load_visual_recommendations(project_id: str) -> Optional[dict]:
    """Load current visual_recommendations from DB, or None if not set."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        row = await conn.execute(
            select(projects.c.visual_recommendations)
            .where(projects.c.project_id == project_id)
        )
        result = row.first()
        if result is None:
            return None
        val = result[0]
        if val is None:
            return None
        if isinstance(val, str):
            return json.loads(val)
        return val


async def update_visual_item(project_id: str, item_id: str, updates: dict) -> Optional[dict]:
    """Patch a single VisualItem by id inside the JSONB payload. Returns updated recommendations."""
    recs = await load_visual_recommendations(project_id)
    if recs is None:
        return None
    items = recs.get("items", [])
    for i, item in enumerate(items):
        if item.get("id") == item_id:
            items[i] = {**item, **updates}
            break
    recs["items"] = items
    await save_visual_recommendations(project_id, recs)
    return recs


# ── Backward-compat aliases (used by tests and other services) ─────────────────

async def create_session(user_id: str, query: str, papers_list: list[dict], engine=None, article_type=None, pdf_save_path=None) -> str:
    return await create_project(user_id, query, papers_list, engine=engine, article_type=article_type, pdf_save_path=pdf_save_path)

async def list_sessions(user_id: str) -> list[dict]:
    return await list_projects(user_id)

async def load_session(user_id: str, session_id: str) -> Optional[dict]:
    return await load_project(user_id, session_id)

async def delete_session(user_id: str, session_id: str) -> bool:
    return await delete_project(user_id, session_id)
