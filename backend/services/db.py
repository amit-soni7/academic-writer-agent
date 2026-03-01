"""
db.py

Async SQLAlchemy engine and schema for multi-user Postgres.

Tables
------
users(id, email, name, picture, created_at)
projects(project_id, user_id, query, project_name, project_description, project_folder,
         current_phase, created_at, updated_at, selected_journal, article,
         manuscript_title, article_type)
papers(project_id, paper_key, data)
summaries(project_id, paper_key, data, created_at)
journal_recs(project_id, data, updated_at)

All JSON payloads are stored as JSONB for Postgres.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    MetaData, Table, Column, String, Text, DateTime, ForeignKey, PrimaryKeyConstraint, text
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def _now() -> str:
    return datetime.utcnow().isoformat()


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://academeet:Academeet%402026@localhost:5432/academeet_writer_db",
)

_IS_PG = DATABASE_URL.startswith("postgresql+") or DATABASE_URL.startswith("postgres+")
metadata = MetaData()

users = Table(
    "users", metadata,
    Column("id", String, primary_key=True),
    Column("email", String, nullable=False, unique=True),
    Column("name", String, nullable=True),
    Column("picture", String, nullable=True),
    Column("created_at", DateTime, nullable=False),
)

projects = Table(
    "projects", metadata,
    Column("project_id", String, primary_key=True),
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("query", Text, nullable=False),
    Column("project_name", Text, nullable=True),
    Column("project_description", Text, nullable=True),
    Column("project_folder", Text, nullable=True),
    Column("current_phase", Text, nullable=True, server_default="intake"),
    Column("created_at", DateTime, nullable=False),
    Column("updated_at", DateTime, nullable=False),
    Column("selected_journal", String, nullable=True),
    Column("article", Text, nullable=True),
    Column("manuscript_title", Text, nullable=True),
    Column("article_type", String, nullable=True),
)

_json_type = JSONB if _IS_PG else Text

papers = Table(
    "papers", metadata,
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False),
    Column("paper_key", String, nullable=False),
    Column("data", _json_type, nullable=False),
    PrimaryKeyConstraint("project_id", "paper_key"),
)

summaries = Table(
    "summaries", metadata,
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False),
    Column("paper_key", String, nullable=False),
    Column("data", _json_type, nullable=False),
    Column("created_at", DateTime, nullable=False),
    PrimaryKeyConstraint("project_id", "paper_key"),
)

journal_recs = Table(
    "journal_recs", metadata,
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), primary_key=True),
    Column("data", _json_type, nullable=False),
    Column("updated_at", DateTime, nullable=False),
)

user_settings = Table(
    "user_settings", metadata,
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("provider", String, nullable=False),
    Column("model", String, nullable=False),
    Column("api_key_encrypted", Text, nullable=True),
    Column("base_url", String, nullable=True),
    Column("updated_at", DateTime, nullable=False),
    Column("pdf_save_enabled", Text, nullable=True),   # "true" / "false"
    Column("pdf_save_path", Text, nullable=True),
    Column("sci_hub_enabled", Text, nullable=True),   # "true" / "false"
    Column("http_proxy", Text, nullable=True),
    Column("provider_profiles_json", Text, nullable=True),         # per-provider non-secret settings
    Column("provider_api_keys_encrypted_json", Text, nullable=True),  # encrypted JSON map {provider: api_key}
    Column("provider_oauth_tokens_encrypted_json", Text, nullable=True),  # encrypted JSON: {provider: {access_token, refresh_token, expires_at}}
)

journal_style_cache = Table(
    "journal_style_cache", metadata,
    Column("journal_key", String, primary_key=True),
    Column("style_data", Text, nullable=False),
    Column("source", String, nullable=False),
    Column("fetched_at", String, nullable=False),  # ISO datetime string
)


_engine: Optional[AsyncEngine] = None


def create_engine_async() -> AsyncEngine:
    """Return the shared singleton engine (creates it on first call)."""
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            DATABASE_URL,
            future=True,
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
        )
    return _engine


async def init_db(engine: Optional[AsyncEngine] = None) -> None:
    eng = engine or create_engine_async()

    # Create all tables that don't exist yet (using the new 'projects' schema)
    async with eng.begin() as conn:
        await conn.run_sync(metadata.create_all)

    # Migrate from old 'sessions' table to 'projects' if sessions table still exists
    await _migrate_sessions_to_projects(eng)

    # Additional column migrations for existing deployments
    await _migrate_add_project_columns(eng)
    await _migrate_add_journal_style_cache(eng)
    await _migrate_add_pdf_settings(eng)
    await _migrate_add_sci_hub_settings(eng)
    await _migrate_add_provider_settings_v2(eng)
    await _migrate_add_oauth_token_column(eng)


async def _migrate_sessions_to_projects(eng: AsyncEngine) -> None:
    """
    Idempotent migration: rename sessions table → projects and update FK columns.
    Runs only if the old 'sessions' table still exists.
    """
    try:
        async with eng.begin() as conn:
            # Check if 'sessions' table still exists
            result = await conn.execute(text(
                "SELECT COUNT(*) FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'sessions'"
            ))
            if result.scalar() == 0:
                return  # Already migrated or fresh install

            # 1. Rename sessions → projects
            await conn.execute(text(
                "DO $$ BEGIN "
                "  IF EXISTS (SELECT 1 FROM information_schema.tables "
                "             WHERE table_schema='public' AND table_name='sessions') "
                "  AND NOT EXISTS (SELECT 1 FROM information_schema.tables "
                "             WHERE table_schema='public' AND table_name='projects') "
                "  THEN ALTER TABLE sessions RENAME TO projects; END IF; "
                "END $$;"
            ))

            # 2. Rename PK column session_id → project_id
            await conn.execute(text(
                "DO $$ BEGIN "
                "  IF EXISTS (SELECT 1 FROM information_schema.columns "
                "             WHERE table_name='projects' AND column_name='session_id') "
                "  THEN ALTER TABLE projects RENAME COLUMN session_id TO project_id; END IF; "
                "END $$;"
            ))

            # 3. Add new columns to projects
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_name TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_description TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_folder TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_phase TEXT DEFAULT 'intake';"
            ))

            # 4. Backfill project_name from query
            await conn.execute(text(
                "UPDATE projects SET project_name = LEFT(query, 60) WHERE project_name IS NULL;"
            ))

            # 5. Migrate papers table FK column session_id → project_id
            await conn.execute(text(
                "DO $$ BEGIN "
                "  IF EXISTS (SELECT 1 FROM information_schema.columns "
                "             WHERE table_name='papers' AND column_name='session_id') "
                "  THEN ALTER TABLE papers RENAME COLUMN session_id TO project_id; END IF; "
                "END $$;"
            ))

            # 6. Migrate summaries table FK column session_id → project_id
            await conn.execute(text(
                "DO $$ BEGIN "
                "  IF EXISTS (SELECT 1 FROM information_schema.columns "
                "             WHERE table_name='summaries' AND column_name='session_id') "
                "  THEN ALTER TABLE summaries RENAME COLUMN session_id TO project_id; END IF; "
                "END $$;"
            ))

            # 7. Migrate journal_recs table FK column session_id → project_id
            await conn.execute(text(
                "DO $$ BEGIN "
                "  IF EXISTS (SELECT 1 FROM information_schema.columns "
                "             WHERE table_name='journal_recs' AND column_name='session_id') "
                "  THEN ALTER TABLE journal_recs RENAME COLUMN session_id TO project_id; END IF; "
                "END $$;"
            ))

    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("sessions→projects migration warning: %s", exc)


async def _migrate_add_project_columns(eng: AsyncEngine) -> None:
    """Add project_name/description/folder/current_phase to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_name TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_description TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_folder TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_phase TEXT DEFAULT 'intake';"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS manuscript_title TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS article_type TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_journal_style_cache(eng: AsyncEngine) -> None:
    """Create journal_style_cache table if it does not exist (safe, idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS journal_style_cache ("
                "  journal_key TEXT PRIMARY KEY,"
                "  style_data  TEXT NOT NULL,"
                "  source      TEXT NOT NULL,"
                "  fetched_at  TEXT NOT NULL"
                ")"
            ))
    except Exception:
        pass


async def _migrate_add_pdf_settings(eng: AsyncEngine) -> None:
    """Add pdf_save_enabled and pdf_save_path columns to user_settings if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pdf_save_enabled TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pdf_save_path TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_sci_hub_settings(eng: AsyncEngine) -> None:
    """Add sci_hub_enabled and http_proxy columns to user_settings if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sci_hub_enabled TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS http_proxy TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_provider_settings_v2(eng: AsyncEngine) -> None:
    """Add per-provider settings columns to user_settings (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_profiles_json TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_api_keys_encrypted_json TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_oauth_token_column(eng: AsyncEngine) -> None:
    """Add provider_oauth_tokens_encrypted_json column to user_settings if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS provider_oauth_tokens_encrypted_json TEXT;"
            ))
    except Exception:
        pass


def new_user_id() -> str:
    return uuid.uuid4().hex
