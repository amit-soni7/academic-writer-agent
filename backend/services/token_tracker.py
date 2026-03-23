"""
services/token_tracker.py

Async token usage recording and querying service.

- Records every LLM call with input/output tokens, provider, model, stage, project.
- Estimates USD cost from a built-in pricing table.
- Uses batched inserts to minimize DB round-trips.
- Provides query functions for dashboards.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import text as sa_text

from services.db import create_engine_async

logger = logging.getLogger(__name__)

# ── Pricing table (USD per 1M tokens) ────────────────────────────────────────
# { provider: { model_prefix: (input_per_1M, output_per_1M) } }

PRICING: dict[str, dict[str, tuple[float, float]]] = {
    "openai": {
        "gpt-4o-mini":     (0.15,   0.60),
        "gpt-4o":          (2.50,  10.00),
        "gpt-4.1-mini":    (0.40,   1.60),
        "gpt-4.1-nano":    (0.10,   0.40),
        "gpt-4.1":         (2.00,   8.00),
        "o3-mini":         (1.10,   4.40),
        "o4-mini":         (1.10,   4.40),
        "_default":        (2.50,  10.00),
    },
    "gemini": {
        "gemini-2.5-flash-lite": (0.075, 0.30),
        "gemini-2.5-flash":  (0.15,  0.60),
        "gemini-2.5-pro":    (1.25, 10.00),
        "gemini-2.0-flash":  (0.10,  0.40),
        "_default":          (0.15,  0.60),
    },
    "claude": {
        "claude-haiku-4-5":    (0.80,   4.00),
        "claude-sonnet-4-6":   (3.00,  15.00),
        "claude-opus-4-6":    (15.00,  75.00),
        "_default":            (3.00,  15.00),
    },
    "ollama":   {"_default": (0.0, 0.0)},
    "llamacpp": {"_default": (0.0, 0.0)},
}


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate USD cost for a single LLM call."""
    provider_pricing = PRICING.get(provider, {})

    rates = None
    if model in provider_pricing:
        rates = provider_pricing[model]
    else:
        for prefix, r in provider_pricing.items():
            if prefix != "_default" and model.startswith(prefix):
                rates = r
                break
    if rates is None:
        rates = provider_pricing.get("_default", (0.0, 0.0))

    input_cost = (input_tokens / 1_000_000) * rates[0]
    output_cost = (output_tokens / 1_000_000) * rates[1]
    return round(input_cost + output_cost, 6)


# ── Batch insert buffer ───────────────────────────────────────────────────────
_buffer: list[dict] = []
_buffer_lock = asyncio.Lock()
_BATCH_SIZE = 20


async def record_usage(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    project_id: Optional[str] = None,
    user_id: Optional[str] = None,
    stage: Optional[str] = None,
) -> None:
    """Record a single token usage event. Batches inserts for efficiency."""
    if input_tokens == 0 and output_tokens == 0:
        return

    cost = estimate_cost(provider, model, input_tokens, output_tokens)
    record = {
        "user_id": user_id,
        "project_id": project_id,
        "provider": provider,
        "model": model,
        "stage": stage,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost_usd": cost,
    }

    async with _buffer_lock:
        _buffer.append(record)
        if len(_buffer) >= _BATCH_SIZE:
            await _flush_buffer()


async def _flush_buffer() -> None:
    """Flush buffered records to DB. Must be called with _buffer_lock held."""
    global _buffer
    if not _buffer:
        return
    records = _buffer[:]
    _buffer = []

    placeholders = ", ".join(
        f"(:user_id_{i}, :project_id_{i}, :provider_{i}, :model_{i}, :stage_{i}, "
        f":input_tokens_{i}, :output_tokens_{i}, :estimated_cost_usd_{i})"
        for i in range(len(records))
    )
    params: dict = {}
    for i, r in enumerate(records):
        for k, v in r.items():
            params[f"{k}_{i}"] = v

    sql = f"""
        INSERT INTO token_usage
            (user_id, project_id, provider, model, stage,
             input_tokens, output_tokens, estimated_cost_usd)
        VALUES {placeholders}
    """

    try:
        eng = create_engine_async()
        async with eng.begin() as conn:
            await conn.execute(sa_text(sql), params)
    except Exception as exc:
        logger.warning("Failed to flush token usage records: %s", exc)
        if len(records) < 200:
            _buffer.extend(records)


async def flush_pending() -> None:
    """Force-flush any pending records. Call on shutdown."""
    async with _buffer_lock:
        await _flush_buffer()


# ── Query functions ───────────────────────────────────────────────────────────

async def get_project_usage(project_id: str) -> dict:
    """Get total token usage for a specific project."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                COALESCE(SUM(input_tokens), 0) AS total_input,
                COALESCE(SUM(output_tokens), 0) AS total_output,
                COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE project_id = :pid
        """), {"pid": project_id})
        row = result.first()
        return {
            "project_id": project_id,
            "total_input_tokens": row.total_input,
            "total_output_tokens": row.total_output,
            "total_cost_usd": round(float(row.total_cost), 4),
            "call_count": row.call_count,
        }


async def get_project_usage_by_stage(project_id: str) -> list[dict]:
    """Get per-stage breakdown for a project."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                COALESCE(stage, 'unknown') AS stage,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(estimated_cost_usd) AS cost_usd,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE project_id = :pid
            GROUP BY stage
            ORDER BY SUM(estimated_cost_usd) DESC
        """), {"pid": project_id})
        return [dict(row._mapping) for row in result.all()]


async def get_user_usage(user_id: str, days: int = 30) -> dict:
    """Get overall usage for a user in the last N days."""
    eng = create_engine_async()
    since = datetime.utcnow() - timedelta(days=days)
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                COALESCE(SUM(input_tokens), 0) AS total_input,
                COALESCE(SUM(output_tokens), 0) AS total_output,
                COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE user_id = :uid AND created_at >= :since
        """), {"uid": user_id, "since": since})
        row = result.first()
        return {
            "user_id": user_id,
            "days": days,
            "total_input_tokens": row.total_input,
            "total_output_tokens": row.total_output,
            "total_cost_usd": round(float(row.total_cost), 4),
            "call_count": row.call_count,
        }


async def get_user_usage_by_provider(user_id: str, days: int = 30) -> list[dict]:
    """Get per-provider/model breakdown for a user."""
    eng = create_engine_async()
    since = datetime.utcnow() - timedelta(days=days)
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                provider,
                model,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(estimated_cost_usd) AS cost_usd,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE user_id = :uid AND created_at >= :since
            GROUP BY provider, model
            ORDER BY SUM(estimated_cost_usd) DESC
        """), {"uid": user_id, "since": since})
        return [dict(row._mapping) for row in result.all()]


async def get_user_daily_usage(user_id: str, days: int = 30) -> list[dict]:
    """Get daily usage timeseries for a user."""
    eng = create_engine_async()
    since = datetime.utcnow() - timedelta(days=days)
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                DATE(created_at) AS date,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(estimated_cost_usd) AS cost_usd,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE user_id = :uid AND created_at >= :since
            GROUP BY DATE(created_at)
            ORDER BY date
        """), {"uid": user_id, "since": since})
        rows = result.all()
        return [
            {
                "date": str(row.date),
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "cost_usd": round(float(row.cost_usd), 4),
                "call_count": row.call_count,
            }
            for row in rows
        ]


async def get_user_usage_by_stage(user_id: str, days: int = 30) -> list[dict]:
    """Get per-stage token breakdown aggregated across all projects for a user."""
    eng = create_engine_async()
    since = datetime.utcnow() - timedelta(days=days)
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                COALESCE(stage, 'unknown') AS stage,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(estimated_cost_usd) AS cost_usd,
                COUNT(*) AS call_count
            FROM token_usage
            WHERE user_id = :uid AND created_at >= :since
            GROUP BY stage
            ORDER BY SUM(input_tokens + output_tokens) DESC
        """), {"uid": user_id, "since": since})
        return [
            {
                "stage": row.stage,
                "input_tokens": int(row.input_tokens),
                "output_tokens": int(row.output_tokens),
                "cost_usd": round(float(row.cost_usd), 4),
                "call_count": row.call_count,
            }
            for row in result.all()
        ]


async def get_all_projects_usage(user_id: str, days: int = 30) -> list[dict]:
    """Get all projects ranked by cost for a user."""
    eng = create_engine_async()
    since = datetime.utcnow() - timedelta(days=days)
    async with eng.connect() as conn:
        result = await conn.execute(sa_text("""
            SELECT
                t.project_id,
                p.project_name,
                p.current_phase,
                SUM(t.input_tokens) AS input_tokens,
                SUM(t.output_tokens) AS output_tokens,
                SUM(t.estimated_cost_usd) AS cost_usd,
                COUNT(*) AS call_count
            FROM token_usage t
            LEFT JOIN projects p ON t.project_id = p.project_id
            WHERE t.user_id = :uid AND t.created_at >= :since AND t.project_id IS NOT NULL
            GROUP BY t.project_id, p.project_name, p.current_phase
            ORDER BY SUM(t.estimated_cost_usd) DESC
        """), {"uid": user_id, "since": since})
        rows = result.all()
        return [
            {
                "project_id": row.project_id,
                "project_name": row.project_name,
                "current_phase": row.current_phase,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "cost_usd": round(float(row.cost_usd), 4),
                "call_count": row.call_count,
            }
            for row in rows
        ]
