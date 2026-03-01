"""
Migrate existing SQLite data (backend/academic_writer.db) into Postgres defined by DATABASE_URL.

Usage:
  AWA_DEV_USER_ID=<user_id> DATABASE_URL=postgresql+asyncpg://... \
  python -m backend.scripts.migrate_sqlite_to_postgres

All sessions will be assigned to AWA_DEV_USER_ID (required). This is a simple
one-off tool for local migration.
"""

import asyncio
import json
import os
from pathlib import Path
from datetime import datetime

import aiosqlite
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy import insert

from backend.services.db import create_engine_async, sessions, papers, summaries, journal_recs


SQLITE_PATH = Path(__file__).resolve().parents[1] / 'academic_writer.db'


def _to_dt(v):
    if isinstance(v, datetime):
        return v
    if v is None:
        return datetime.utcnow()
    s = str(v).strip()
    # common SQLite timestamp formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            return datetime.strptime(s, fmt)
        except Exception:
            pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return datetime.utcnow()


async def migrate(user_id: str, engine: AsyncEngine):
    if not SQLITE_PATH.exists():
        print("No SQLite DB found at", SQLITE_PATH)
        return
    async with aiosqlite.connect(SQLITE_PATH) as db:
        db.row_factory = aiosqlite.Row
        sess = await db.execute_fetchall("SELECT * FROM sessions")
        async with engine.begin() as conn:
            for s in sess:
                sid = s["session_id"]
                await conn.execute(insert(sessions).values(
                    session_id=sid,
                    user_id=user_id,
                    query=s["query"],
                    created_at=_to_dt(s["created_at"]),
                    updated_at=_to_dt(s["updated_at"]),
                    selected_journal=s["selected_journal"],
                    article=s["article"],
                ))

                # papers
                pr = await db.execute_fetchall("SELECT paper_key, data FROM papers WHERE session_id=?", (sid,))
                for r in pr:
                    await conn.execute(insert(papers).values(
                        session_id=sid,
                        paper_key=r["paper_key"],
                        data=json.loads(r["data"]),
                    ))
                # summaries
                sr = await db.execute_fetchall("SELECT paper_key, data, created_at FROM summaries WHERE session_id=?", (sid,))
                for r in sr:
                    await conn.execute(insert(summaries).values(
                        session_id=sid,
                        paper_key=r["paper_key"],
                        data=json.loads(r["data"]),
                        created_at=_to_dt(r["created_at"]),
                    ))
                # journal recs
                cur = await db.execute("SELECT data, updated_at FROM journal_recs WHERE session_id=?", (sid,))
                jr = await cur.fetchone()
                if jr:
                    await conn.execute(insert(journal_recs).values(
                        session_id=sid,
                        data=json.loads(jr["data"]),
                        updated_at=_to_dt(jr["updated_at"]),
                    ))
    print("Migration complete for", len(sess), "sessions")


if __name__ == '__main__':
    uid = os.getenv('AWA_DEV_USER_ID')
    if not uid:
        print("Set AWA_DEV_USER_ID to assign imported sessions to a user.")
        raise SystemExit(1)
    eng = create_engine_async()
    asyncio.run(migrate(uid, eng))

