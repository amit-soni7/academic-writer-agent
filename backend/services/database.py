"""
database.py

Async SQLite persistence for the Academic Writer Agent.

Database file : backend/academic_writer.db
WAL mode      : enabled (safe concurrent reads + writes)
Foreign keys  : enforced (cascade deletes work)

Schema
------
sessions      – one row per research session
papers        – all papers fetched for a session (JSON blob)
summaries     – per-paper AI analysis (JSON blob, 26 fields)
journal_recs  – journal recommendations for a session (JSON blob)

JSON blob approach: each Paper / PaperSummary / JournalRecommendation is stored
as a JSON string. This keeps the schema stable while the Python models evolve —
no migration needed when we add fields.
"""

import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite

logger  = logging.getLogger(__name__)
DB_PATH = Path(__file__).parent.parent / "academic_writer.db"


# ── Schema ────────────────────────────────────────────────────────────────────

_DDL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    session_id       TEXT PRIMARY KEY,
    query            TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    selected_journal TEXT,
    article          TEXT
);

CREATE TABLE IF NOT EXISTS papers (
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    paper_key   TEXT NOT NULL,
    data        TEXT NOT NULL,          -- Paper serialised as JSON
    PRIMARY KEY (session_id, paper_key)
);

CREATE TABLE IF NOT EXISTS summaries (
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    paper_key   TEXT NOT NULL,
    data        TEXT NOT NULL,          -- PaperSummary serialised as JSON
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, paper_key)
);

CREATE TABLE IF NOT EXISTS journal_recs (
    session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    data        TEXT NOT NULL,          -- list[JournalRecommendation] as JSON
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (session_id)
);

CREATE INDEX IF NOT EXISTS idx_papers_session    ON papers(session_id);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
"""


async def init_db() -> None:
    """Create all tables on startup. Safe to call multiple times."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_DDL)
        await db.commit()
    logger.info("Database ready at %s", DB_PATH)


# ── Internal helper ───────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().isoformat()


def _paper_key(paper: dict) -> str:
    return (paper.get("doi") or paper.get("title", "")[:60]).lower().strip()


# ── Sessions ──────────────────────────────────────────────────────────────────

async def create_session(query: str, papers: list[dict]) -> str:
    """Persist a new session with all its papers. Returns session_id."""
    session_id = uuid.uuid4().hex[:8]
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute(
            "INSERT INTO sessions (session_id, query, created_at, updated_at) VALUES (?,?,?,?)",
            (session_id, query, now, now),
        )
        for p in papers:
            key = _paper_key(p)
            await db.execute(
                "INSERT OR REPLACE INTO papers (session_id, paper_key, data) VALUES (?,?,?)",
                (session_id, key, json.dumps(p, ensure_ascii=False)),
            )
        await db.commit()
    logger.info("Created session %s with %d papers", session_id, len(papers))
    return session_id


async def list_sessions() -> list[dict]:
    """Return lightweight metadata for all sessions, newest first."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # Count papers and summaries per session in one query
        rows = await db.execute_fetchall("""
            SELECT
                s.session_id,
                s.query,
                s.created_at,
                s.updated_at,
                s.selected_journal,
                (s.article IS NOT NULL AND s.article != '') AS has_article,
                COUNT(DISTINCT p.paper_key)  AS paper_count,
                COUNT(DISTINCT sm.paper_key) AS summary_count,
                EXISTS(SELECT 1 FROM journal_recs jr WHERE jr.session_id = s.session_id) AS has_journals
            FROM sessions s
            LEFT JOIN papers   p  ON p.session_id  = s.session_id
            LEFT JOIN summaries sm ON sm.session_id = s.session_id
            GROUP BY s.session_id
            ORDER BY s.updated_at DESC
        """)
    return [dict(r) for r in rows]


async def load_session(session_id: str) -> Optional[dict]:
    """Load full session data: metadata + papers + summaries + journal_recs."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Session metadata
        row = await (await db.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        )).fetchone()
        if row is None:
            return None
        meta = dict(row)

        # Papers
        paper_rows = await db.execute_fetchall(
            "SELECT data FROM papers WHERE session_id = ? ORDER BY rowid", (session_id,)
        )
        papers = [json.loads(r["data"]) for r in paper_rows]

        # Summaries
        sum_rows = await db.execute_fetchall(
            "SELECT paper_key, data FROM summaries WHERE session_id = ?", (session_id,)
        )
        summaries = {r["paper_key"]: json.loads(r["data"]) for r in sum_rows}

        # Journal recs
        jr_row = await (await db.execute(
            "SELECT data FROM journal_recs WHERE session_id = ?", (session_id,)
        )).fetchone()
        journal_recs = json.loads(jr_row["data"]) if jr_row else []

    return {
        **meta,
        "papers":       papers,
        "summaries":    summaries,
        "journal_recs": journal_recs,
    }


async def delete_session(session_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        cur = await db.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        await db.commit()
    return cur.rowcount > 0


# ── Summaries ─────────────────────────────────────────────────────────────────

async def save_summary(session_id: str, paper_key: str, summary: dict) -> None:
    """Upsert a single paper summary."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO summaries (session_id, paper_key, data, created_at)
               VALUES (?,?,?,?)
               ON CONFLICT(session_id, paper_key) DO UPDATE SET data=excluded.data""",
            (session_id, paper_key, json.dumps(summary, ensure_ascii=False), _now()),
        )
        await db.execute(
            "UPDATE sessions SET updated_at=? WHERE session_id=?", (_now(), session_id)
        )
        await db.commit()


async def get_existing_summary_keys(session_id: str) -> set[str]:
    """Return paper_keys that already have summaries (for resume support)."""
    async with aiosqlite.connect(DB_PATH) as db:
        rows = await db.execute_fetchall(
            "SELECT paper_key FROM summaries WHERE session_id = ?", (session_id,)
        )
    return {r[0] for r in rows}


# ── Journal recommendations ───────────────────────────────────────────────────

async def save_journal_recs(session_id: str, recs: list[dict]) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        now = _now()
        await db.execute(
            """INSERT INTO journal_recs (session_id, data, updated_at) VALUES (?,?,?)
               ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
            (session_id, json.dumps(recs, ensure_ascii=False), now),
        )
        await db.execute(
            "UPDATE sessions SET updated_at=? WHERE session_id=?", (now, session_id)
        )
        await db.commit()


# ── Article ───────────────────────────────────────────────────────────────────

async def save_article(session_id: str, article: str, selected_journal: Optional[str] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE sessions
               SET article=?, selected_journal=COALESCE(?,selected_journal), updated_at=?
               WHERE session_id=?""",
            (article, selected_journal, _now(), session_id),
        )
        await db.commit()
