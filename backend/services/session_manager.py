"""
session_manager.py

Manages research sessions as JSON files on disk.

Storage layout
--------------
backend/sessions/
    {session_id}.json   ← one file per session

Session JSON schema
-------------------
{
  session_id        : str              # 8-char hex
  query             : str              # original research question
  created_at        : ISO datetime str
  updated_at        : ISO datetime str
  papers            : list[Paper]      # all papers from search
  summaries         : dict             # paper_key → PaperSummary dict
  journal_recs      : list             # JournalRecommendation dicts
  selected_journal  : str | null       # chosen journal name
  article           : str | null       # generated article markdown
}
"""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

SESSIONS_DIR = Path(__file__).parent.parent / "sessions"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().isoformat()


def _path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def _load_raw(session_id: str) -> Optional[dict]:
    p = _path(session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_raw(session_id: str, data: dict) -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    _path(session_id).write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ── Public API ────────────────────────────────────────────────────────────────

def create_session(query: str, papers: list[dict]) -> str:
    """Create a new session, save it, return session_id."""
    session_id = uuid.uuid4().hex[:8]
    _save_raw(session_id, {
        "session_id": session_id,
        "query": query,
        "created_at": _now(),
        "updated_at": _now(),
        "papers": papers,
        "summaries": {},
        "journal_recs": [],
        "selected_journal": None,
        "article": None,
    })
    return session_id


def load_session(session_id: str) -> Optional[dict]:
    return _load_raw(session_id)


def list_sessions() -> list[dict]:
    """Return lightweight metadata for all sessions, newest first."""
    if not SESSIONS_DIR.exists():
        return []
    sessions = []
    for f in sorted(SESSIONS_DIR.glob("*.json"),
                    key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            sessions.append({
                "session_id":    d["session_id"],
                "query":         d.get("query", ""),
                "created_at":    d.get("created_at", ""),
                "updated_at":    d.get("updated_at", ""),
                "paper_count":   len(d.get("papers", [])),
                "summary_count": len(d.get("summaries", {})),
                "has_journals":  bool(d.get("journal_recs")),
                "has_article":   bool(d.get("article")),
            })
        except Exception:
            pass
    return sessions


def delete_session(session_id: str) -> bool:
    p = _path(session_id)
    if p.exists():
        p.unlink()
        return True
    return False


def save_summary(session_id: str, paper_key: str, summary: dict) -> None:
    """Upsert a single paper summary into the session file."""
    data = _load_raw(session_id)
    if data is None:
        return
    data["summaries"][paper_key] = summary
    data["updated_at"] = _now()
    _save_raw(session_id, data)


def save_journal_recs(session_id: str, recs: list[dict]) -> None:
    data = _load_raw(session_id)
    if data is None:
        return
    data["journal_recs"] = recs
    data["updated_at"] = _now()
    _save_raw(session_id, data)


def save_article(session_id: str, article: str, selected_journal: Optional[str] = None) -> None:
    data = _load_raw(session_id)
    if data is None:
        return
    data["article"] = article
    if selected_journal:
        data["selected_journal"] = selected_journal
    data["updated_at"] = _now()
    _save_raw(session_id, data)
