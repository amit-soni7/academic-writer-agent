"""
sr_audit.py

RAISE-compliant audit logging for all AI decisions in the SR pipeline.
Every AI decision must be logged here to support publication compliance.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncEngine

from services.db import create_engine_async, sr_audit_log

logger = logging.getLogger(__name__)


async def log_ai_decision(
    project_id: str,
    stage: str,
    action: str,
    ai_model: str,
    prompt: str,
    response: str,
    *,
    paper_key: str | None = None,
    human_override: bool = False,
    engine: AsyncEngine | None = None,
) -> None:
    """
    Log one AI decision to the sr_audit_log table.

    Call this after every AI call that makes a screening/extraction/RoB decision.
    The prompt is hashed (SHA-256) — full prompt text is NOT stored.
    Only the first 500 chars of the response are stored.

    Args:
        project_id: The project this decision belongs to.
        stage: Pipeline stage (screening_ta | screening_ft | extraction | rob | synthesis | protocol)
        action: Specific action (ai_screen | ai_extract | ai_rob | ai_protocol | ai_synthesis)
        ai_model: Model name/ID used (e.g., "claude-sonnet-4-6")
        prompt: Full prompt text (will be hashed, not stored in plaintext)
        response: Full response text (truncated to 500 chars for storage)
        paper_key: Optional paper key if action is paper-specific
        human_override: True if a human subsequently overrode this AI decision
        engine: Optional AsyncEngine; uses singleton if omitted
    """
    eng = engine or create_engine_async()
    prompt_hash = hashlib.sha256(prompt.encode("utf-8", errors="replace")).hexdigest()
    response_summary = response[:500] if response else ""

    try:
        async with eng.begin() as conn:
            await conn.execute(
                insert(sr_audit_log).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    stage=stage,
                    action=action,
                    ai_model=ai_model,
                    prompt_hash=prompt_hash,
                    response_summary=response_summary,
                    human_override=human_override,
                )
            )
    except Exception as exc:
        # Audit log failure must NEVER crash the main pipeline
        logger.error("sr_audit: failed to log AI decision project=%s stage=%s action=%s: %s",
                     project_id, stage, action, exc)


async def get_audit_log(project_id: str, engine: AsyncEngine | None = None) -> list[dict]:
    """Return the full audit log for a project, ordered by timestamp."""
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(
                sr_audit_log.c.id,
                sr_audit_log.c.paper_key,
                sr_audit_log.c.stage,
                sr_audit_log.c.action,
                sr_audit_log.c.ai_model,
                sr_audit_log.c.prompt_hash,
                sr_audit_log.c.response_summary,
                sr_audit_log.c.human_override,
                sr_audit_log.c.timestamp,
            )
            .where(sr_audit_log.c.project_id == project_id)
            .order_by(sr_audit_log.c.timestamp)
        )
        return [dict(r._mapping) for r in result]
