"""
project_repo.py

User-scoped persistence using the async SQLAlchemy engine (Postgres).
Maintains the same JSON blob contract as session_repo, but with Projects terminology.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select, insert, update, delete, func
from sqlalchemy.ext.asyncio import AsyncEngine

from services.db import create_engine_async, projects, papers, summaries, journal_recs, screenings


def _now() -> datetime:
    return datetime.utcnow()


# ── Folder helpers ─────────────────────────────────────────────────────────────

def _auto_project_name(query: str) -> str:
    """Slugify first 50 chars of query for use as initial project name."""
    slug = re.sub(r'[^a-zA-Z0-9 ]', '', query).strip()
    slug = re.sub(r'\s+', '_', slug)[:50]
    return slug or "project"


def slugify_project_name(text: str, max_len: int = 80) -> str:
    """Slugify any text into a clean folder-safe name."""
    slug = re.sub(r'[^a-zA-Z0-9 ]', '', text).strip()
    slug = re.sub(r'\s+', '_', slug)[:max_len]
    return slug or "project"


def _make_project_folder(project_name: str, pdf_save_path: Optional[str] = None) -> str:
    """Return (and create) the project folder path."""
    base = pdf_save_path or os.path.expanduser("~/Documents/AcademicWriter")
    folder = os.path.join(base, project_name)
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
) -> str:
    eng = engine or create_engine_async()
    pid = uuid.uuid4().hex[:8]

    # Use provided name (tentative title from search strategy) or fall back to query slug
    project_name = slugify_project_name(project_name) if project_name else _auto_project_name(query)
    project_folder = _make_project_folder(project_name, pdf_save_path)

    async with eng.begin() as conn:
        await conn.execute(insert(projects).values(
            project_id=pid,
            user_id=user_id,
            query=query,
            project_name=project_name,
            project_description=project_description,
            project_folder=project_folder,
            current_phase='intake',
            created_at=_now(),
            updated_at=_now(),
            article_type=article_type,
            project_type=project_type or 'write',
            revision_rounds='[]',
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
    async with eng.connect() as conn:
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

        papers_list = [_coerce(r[0]) for r in pr]
        summaries_map = {k: _coerce(v) for k, v in sr}
        jr_first = jr.mappings().first()
        journal_list = _coerce(jr_first["data"]) if jr_first else []

        return {
            **dict(row),
            'papers': papers_list,
            'summaries': summaries_map,
            'journal_recs': journal_list,
        }


async def load_project_minimal(project_id: str) -> dict:
    """Load just the project row (no papers/summaries) — for internal use."""
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


async def save_article(project_id: str, article: str, selected_journal: Optional[str] = None) -> None:
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(article=article, selected_journal=selected_journal or projects.c.selected_journal, updated_at=_now())
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
    # Preserve the same base directory (user's pdf_save_path) when renaming
    if old_folder:
        base = os.path.dirname(old_folder)
        new_folder = os.path.join(base, new_name)
        os.makedirs(new_folder, exist_ok=True)
    else:
        new_folder = _make_project_folder(new_name)
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
            .values(project_name=new_name, project_folder=new_folder, updated_at=_now())
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


# ── Revision round persistence ─────────────────────────────────────────────────

async def save_base_manuscript(project_id: str, text: str) -> None:
    """Store the imported manuscript text."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(base_manuscript=text, updated_at=_now())
        )


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


# ── Backward-compat aliases (used by tests and other services) ─────────────────

async def create_session(user_id: str, query: str, papers_list: list[dict], engine=None, article_type=None, pdf_save_path=None) -> str:
    return await create_project(user_id, query, papers_list, engine=engine, article_type=article_type, pdf_save_path=pdf_save_path)

async def list_sessions(user_id: str) -> list[dict]:
    return await list_projects(user_id)

async def load_session(user_id: str, session_id: str) -> Optional[dict]:
    return await load_project(user_id, session_id)

async def delete_session(user_id: str, session_id: str) -> bool:
    return await delete_project(user_id, session_id)
