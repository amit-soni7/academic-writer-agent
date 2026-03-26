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

SR Pipeline tables:
sr_protocols, sr_search_runs, sr_screenings, sr_data_extraction,
sr_risk_of_bias, sr_audit_log

All JSON payloads are stored as JSONB for Postgres.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    MetaData, Table, Column, String, Text, DateTime, ForeignKey,
    PrimaryKeyConstraint, Integer, Float, Boolean, UniqueConstraint, text,
    func,
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
_json_type = JSONB if _IS_PG else Text
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
    Column("project_type", Text, nullable=True, server_default="write"),
    Column("base_manuscript", Text, nullable=True),
    Column("base_manuscript_summary", Text, nullable=True),
    Column("manuscript_files", Text, nullable=True),
    Column("base_section_index", Text, nullable=True),
    Column("gemini_cache_name", Text, nullable=True),
    Column("revision_rounds", Text, nullable=True, server_default="[]"),
    Column("revision_wip", Text, nullable=True),
    Column("synthesis_result", Text, nullable=True),
    Column("deep_synthesis_result", Text, nullable=True),
    Column("peer_review_result", Text, nullable=True),
    Column("literature_search_state", _json_type, nullable=True),
    # SR pipeline columns
    Column("pico_question", _json_type, nullable=True),
    Column("inclusion_criteria", _json_type, nullable=True),
    Column("exclusion_criteria", _json_type, nullable=True),
    Column("data_extraction_schema", _json_type, nullable=True),
    Column("sr_current_stage", String(50), nullable=True, server_default="protocol"),
    # PRISMA-P 2015 structured data (all 17 items)
    Column("prisma_p_data", _json_type, nullable=True),
    Column("visual_recommendations", _json_type, nullable=True),
)

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
    Column("track_changes_author", Text, nullable=True),
    Column("scihub_mirrors_json", Text, nullable=True),  # JSON list of mirror URLs
    Column("image_backend", Text, nullable=True),
    Column("image_model", Text, nullable=True),
    Column("image_background", Text, nullable=True),
    Column("image_quality", Text, nullable=True),
    Column("image_candidate_count", Text, nullable=True),
    Column("image_asset_mode", Text, nullable=True),
    Column("image_provider_profiles_json", Text, nullable=True),
)

journal_style_cache = Table(
    "journal_style_cache", metadata,
    Column("journal_key", String, primary_key=True),
    Column("style_data", Text, nullable=False),
    Column("source", String, nullable=False),
    Column("fetched_at", String, nullable=False),  # ISO datetime string
)

screenings = Table(
    "screenings", metadata,
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False),
    Column("paper_key", String, nullable=False),
    Column("decision", String, nullable=False),      # include | exclude | uncertain
    Column("reason", Text, nullable=False, server_default=""),
    Column("overridden", String, nullable=False, server_default="false"),  # "true" / "false"
    PrimaryKeyConstraint("project_id", "paper_key"),
)

# ── Per-comment revision work ─────────────────────────────────────────────────

comment_work = Table(
    "comment_work", metadata,
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False),
    Column("round_number", Integer, nullable=False, server_default="1"),
    Column("reviewer_number", Integer, nullable=False),
    Column("comment_number", Integer, nullable=False),
    # Parsed comment
    Column("original_comment", Text, nullable=False, server_default=""),
    Column("category", String(20), nullable=False, server_default="major"),
    Column("severity", String(20), server_default="major"),
    Column("domain", String(30), server_default="other"),
    Column("requirement_level", String(20), server_default="unclear"),
    Column("ambiguity_flag", String(5), server_default="false"),
    Column("ambiguity_question", Text, server_default=""),
    Column("intent_interpretation", Text, server_default=""),
    # AI suggestion (full object)
    Column("suggestion", _json_type, nullable=True),
    # Discussion + plan
    Column("discussion", _json_type, server_default="[]"),
    Column("current_plan", Text, server_default=""),
    Column("doi_references", _json_type, server_default="[]"),
    # Finalization
    Column("is_finalized", String(5), server_default="false"),
    Column("author_response", Text, server_default=""),
    Column("action_taken", Text, server_default=""),
    Column("manuscript_changes", Text, server_default=""),
    # Timestamps
    Column("created_at", Text, server_default=""),
    Column("updated_at", Text, nullable=True),
    PrimaryKeyConstraint("project_id", "round_number", "reviewer_number", "comment_number"),
)

# ── SR Pipeline tables ─────────────────────────────────────────────────────────

sr_protocols = Table(
    "sr_protocols", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE"), unique=True),
    Column("pico", _json_type, nullable=False, server_default='{}'),
    Column("prospero_fields", _json_type, server_default='{}'),
    Column("prisma_p_checklist", _json_type, server_default='{}'),
    Column("campbell_fields", _json_type, server_default='{}'),
    Column("comet_cos_search", _json_type, server_default='{}'),
    Column("osf_registration_id", String(50), nullable=True),
    Column("osf_draft_id", String(50), nullable=True),
    Column("registration_status", String(30), server_default="not_started"),
    Column("protocol_document", Text, nullable=True),
    Column("search_strategies", _json_type, server_default='{}'),
    Column("evidence_pack", _json_type, nullable=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
    Column("updated_at", DateTime(timezone=True), nullable=True),
)

sr_search_runs = Table(
    "sr_search_runs", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE")),
    Column("run_date", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
    Column("databases_searched", _json_type),
    Column("total_retrieved", Integer, default=0),
    Column("after_dedup", Integer, default=0),
    Column("prisma_counts", _json_type, server_default='{}'),
    Column("status", String(20), server_default="running"),
)

sr_screenings = Table(
    "sr_screenings", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE")),
    Column("paper_key", String(100), nullable=False),
    Column("screening_stage", String(20), nullable=False),
    Column("reviewer1_decision", String(20), nullable=True),
    Column("reviewer1_type", String(10), server_default="ai"),
    Column("reviewer1_reason", Text, nullable=True),
    Column("reviewer1_confidence", Float, nullable=True),
    Column("reviewer1_criteria_scores", _json_type, server_default='{}'),
    Column("reviewer2_decision", String(20), nullable=True),
    Column("reviewer2_type", String(10), server_default="human"),
    Column("reviewer2_reason", Text, nullable=True),
    Column("final_decision", String(20), nullable=True),
    Column("conflict_resolved_by", String(20), nullable=True),
    Column("exclusion_reason_category", String(100), nullable=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
    Column("updated_at", DateTime(timezone=True), nullable=True),
    UniqueConstraint("project_id", "paper_key", "screening_stage", name="uq_sr_screenings"),
)

sr_data_extraction = Table(
    "sr_data_extraction", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE")),
    Column("paper_key", String(100), nullable=False),
    Column("extraction_schema", _json_type, server_default='{}'),
    Column("ai_extracted", _json_type, server_default='{}'),
    Column("human_verified", _json_type, server_default='{}'),
    Column("final_data", _json_type, server_default='{}'),
    Column("extraction_notes", Text, nullable=True),
    Column("verified_by_human", Boolean, server_default="false"),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
    Column("updated_at", DateTime(timezone=True), nullable=True),
    UniqueConstraint("project_id", "paper_key", name="uq_sr_extraction"),
)

sr_risk_of_bias = Table(
    "sr_risk_of_bias", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE")),
    Column("paper_key", String(100), nullable=False),
    Column("tool_used", String(50), server_default="rob2"),
    Column("ai_assessment", _json_type, server_default='{}'),
    Column("robotreviewer_assessment", _json_type, server_default='{}'),
    Column("human_assessment", _json_type, server_default='{}'),
    Column("final_assessment", _json_type, server_default='{}'),
    Column("overall_risk", String(20), nullable=True),
    Column("human_confirmed", Boolean, server_default="false"),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
    Column("updated_at", DateTime(timezone=True), nullable=True),
    UniqueConstraint("project_id", "paper_key", name="uq_sr_rob"),
)

sr_audit_log = Table(
    "sr_audit_log", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="CASCADE")),
    Column("paper_key", String(100), nullable=True),
    Column("stage", String(50)),
    Column("action", String(100)),
    Column("ai_model", String(100)),
    Column("prompt_hash", String(64)),
    Column("response_summary", Text),
    Column("human_override", Boolean, server_default="false"),
    Column("timestamp", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
)

token_usage = Table(
    "token_usage", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("user_id", String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
    Column("project_id", String, ForeignKey("projects.project_id", ondelete="SET NULL"), nullable=True),
    Column("provider", String(20), nullable=False),
    Column("model", String(100), nullable=False),
    Column("stage", String(100), nullable=True),
    Column("input_tokens", Integer, nullable=False, server_default="0"),
    Column("output_tokens", Integer, nullable=False, server_default="0"),
    Column("estimated_cost_usd", Float, nullable=True),
    Column("created_at", DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP")),
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
    await _migrate_add_revision_columns(eng)
    await _migrate_add_revision_wip(eng)
    await _migrate_add_write_result_columns(eng)
    await _migrate_add_screenings_table(eng)
    await _migrate_add_sr_columns(eng)
    await _migrate_add_sr_tables(eng)
    await _migrate_add_prisma_p_data(eng)
    await _migrate_add_manuscript_meta(eng)
    await _migrate_add_evidence_pack(eng)
    await _migrate_add_track_changes_author(eng)
    await _migrate_add_scihub_mirrors(eng)
    await _migrate_add_manuscript_files(eng)
    await _migrate_add_literature_search_state(eng)
    await _migrate_add_comment_work_table(eng)
    await _migrate_wip_to_comment_work(eng)
    await _migrate_add_deep_synthesis_result(eng)
    await _migrate_add_token_usage_table(eng)
    await _migrate_add_image_settings(eng)
    await _migrate_add_visual_recommendations(eng)


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


async def _migrate_add_revision_columns(eng: AsyncEngine) -> None:
    """Add project_type, base_manuscript, revision_rounds columns to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'write';"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_manuscript TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS revision_rounds TEXT DEFAULT '[]';"
            ))
    except Exception:
        pass


async def _migrate_add_revision_wip(eng: AsyncEngine) -> None:
    """Add revision_wip column to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS revision_wip TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_write_result_columns(eng: AsyncEngine) -> None:
    """Add synthesis_result and peer_review_result columns to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS synthesis_result TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS peer_review_result TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_screenings_table(eng: AsyncEngine) -> None:
    """Create screenings table if it does not exist (safe, idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS screenings ("
                "  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  paper_key  TEXT NOT NULL,"
                "  decision   TEXT NOT NULL,"
                "  reason     TEXT NOT NULL DEFAULT '',"
                "  overridden TEXT NOT NULL DEFAULT 'false',"
                "  PRIMARY KEY (project_id, paper_key)"
                ")"
            ))
    except Exception:
        pass


async def _migrate_add_sr_columns(eng: AsyncEngine) -> None:
    """Add SR-specific columns to projects table if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS pico_question JSONB DEFAULT '{}'::jsonb;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS inclusion_criteria JSONB DEFAULT '[]'::jsonb;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS exclusion_criteria JSONB DEFAULT '[]'::jsonb;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS data_extraction_schema JSONB DEFAULT '[]'::jsonb;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS sr_current_stage TEXT DEFAULT 'protocol';"
            ))
    except Exception:
        pass


async def _migrate_add_sr_tables(eng: AsyncEngine) -> None:
    """Create all SR pipeline tables if they do not exist (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_protocols ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT UNIQUE REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  pico JSONB NOT NULL DEFAULT '{}',"
                "  prospero_fields JSONB DEFAULT '{}',"
                "  prisma_p_checklist JSONB DEFAULT '{}',"
                "  campbell_fields JSONB DEFAULT '{}',"
                "  comet_cos_search JSONB DEFAULT '{}',"
                "  osf_registration_id VARCHAR(50),"
                "  osf_draft_id VARCHAR(50),"
                "  registration_status VARCHAR(30) DEFAULT 'not_started',"
                "  protocol_document TEXT,"
                "  search_strategies JSONB DEFAULT '{}',"
                "  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"
                "  updated_at TIMESTAMPTZ"
                ")"
            ))
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_search_runs ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  run_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"
                "  databases_searched JSONB,"
                "  total_retrieved INTEGER DEFAULT 0,"
                "  after_dedup INTEGER DEFAULT 0,"
                "  prisma_counts JSONB DEFAULT '{}',"
                "  status VARCHAR(20) DEFAULT 'running'"
                ")"
            ))
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_screenings ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  paper_key VARCHAR(100) NOT NULL,"
                "  screening_stage VARCHAR(20) NOT NULL,"
                "  reviewer1_decision VARCHAR(20),"
                "  reviewer1_type VARCHAR(10) DEFAULT 'ai',"
                "  reviewer1_reason TEXT,"
                "  reviewer1_confidence FLOAT,"
                "  reviewer1_criteria_scores JSONB DEFAULT '{}',"
                "  reviewer2_decision VARCHAR(20),"
                "  reviewer2_type VARCHAR(10) DEFAULT 'human',"
                "  reviewer2_reason TEXT,"
                "  final_decision VARCHAR(20),"
                "  conflict_resolved_by VARCHAR(20),"
                "  exclusion_reason_category VARCHAR(100),"
                "  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"
                "  updated_at TIMESTAMPTZ,"
                "  UNIQUE (project_id, paper_key, screening_stage)"
                ")"
            ))
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_data_extraction ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  paper_key VARCHAR(100) NOT NULL,"
                "  extraction_schema JSONB DEFAULT '{}',"
                "  ai_extracted JSONB DEFAULT '{}',"
                "  human_verified JSONB DEFAULT '{}',"
                "  final_data JSONB DEFAULT '{}',"
                "  extraction_notes TEXT,"
                "  verified_by_human BOOLEAN DEFAULT FALSE,"
                "  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"
                "  updated_at TIMESTAMPTZ,"
                "  UNIQUE (project_id, paper_key)"
                ")"
            ))
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_risk_of_bias ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  paper_key VARCHAR(100) NOT NULL,"
                "  tool_used VARCHAR(50) DEFAULT 'rob2',"
                "  ai_assessment JSONB DEFAULT '{}',"
                "  robotreviewer_assessment JSONB DEFAULT '{}',"
                "  human_assessment JSONB DEFAULT '{}',"
                "  final_assessment JSONB DEFAULT '{}',"
                "  overall_risk VARCHAR(20),"
                "  human_confirmed BOOLEAN DEFAULT FALSE,"
                "  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,"
                "  updated_at TIMESTAMPTZ,"
                "  UNIQUE (project_id, paper_key)"
                ")"
            ))
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS sr_audit_log ("
                "  id SERIAL PRIMARY KEY,"
                "  project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  paper_key VARCHAR(100),"
                "  stage VARCHAR(50),"
                "  action VARCHAR(100),"
                "  ai_model VARCHAR(100),"
                "  prompt_hash VARCHAR(64),"
                "  response_summary TEXT,"
                "  human_override BOOLEAN DEFAULT FALSE,"
                "  timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"
                ")"
            ))
    except Exception:
        pass


async def _migrate_add_prisma_p_data(eng: AsyncEngine) -> None:
    """Add prisma_p_data JSONB column to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS prisma_p_data JSONB DEFAULT '{}'::jsonb;"
            ))
    except Exception:
        pass


async def _migrate_add_evidence_pack(eng: AsyncEngine) -> None:
    """Add evidence_pack JSONB column to sr_protocols if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE sr_protocols ADD COLUMN IF NOT EXISTS evidence_pack JSONB;"
            ))
    except Exception:
        pass


async def _migrate_add_manuscript_meta(eng: AsyncEngine) -> None:
    """Add base_manuscript_summary, base_section_index, gemini_cache_name columns (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_manuscript_summary TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_section_index TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS gemini_cache_name TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_track_changes_author(eng: AsyncEngine) -> None:
    """Add track_changes_author column to user_settings (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS track_changes_author TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_scihub_mirrors(eng: AsyncEngine) -> None:
    """Add scihub_mirrors_json column to user_settings (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS scihub_mirrors_json TEXT;"
            ))
    except Exception:
        pass


async def _migrate_add_manuscript_files(eng: AsyncEngine) -> None:
    """Add manuscript_files column and drop legacy base_manuscript_docx (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS manuscript_files TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE projects DROP COLUMN IF EXISTS base_manuscript_docx;"
            ))
    except Exception:
        pass


async def _migrate_add_literature_search_state(eng: AsyncEngine) -> None:
    """Add literature_search_state JSONB column to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS literature_search_state JSONB DEFAULT '{}'::jsonb;"
            ))
    except Exception:
        pass


async def _migrate_add_comment_work_table(eng: AsyncEngine) -> None:
    """Create comment_work table if not exists (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS comment_work ("
                "  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,"
                "  round_number INTEGER NOT NULL DEFAULT 1,"
                "  reviewer_number INTEGER NOT NULL,"
                "  comment_number INTEGER NOT NULL,"
                "  original_comment TEXT NOT NULL DEFAULT '',"
                "  category VARCHAR(20) NOT NULL DEFAULT 'major',"
                "  severity VARCHAR(20) DEFAULT 'major',"
                "  domain VARCHAR(30) DEFAULT 'other',"
                "  requirement_level VARCHAR(20) DEFAULT 'unclear',"
                "  ambiguity_flag VARCHAR(5) DEFAULT 'false',"
                "  ambiguity_question TEXT DEFAULT '',"
                "  intent_interpretation TEXT DEFAULT '',"
                "  suggestion JSONB,"
                "  discussion JSONB DEFAULT '[]',"
                "  current_plan TEXT DEFAULT '',"
                "  doi_references JSONB DEFAULT '[]',"
                "  is_finalized VARCHAR(5) DEFAULT 'false',"
                "  author_response TEXT DEFAULT '',"
                "  action_taken TEXT DEFAULT '',"
                "  manuscript_changes TEXT DEFAULT '',"
                "  created_at TEXT DEFAULT '',"
                "  updated_at TEXT,"
                "  PRIMARY KEY (project_id, round_number, reviewer_number, comment_number)"
                ")"
            ))
    except Exception:
        pass


async def _migrate_wip_to_comment_work(eng: AsyncEngine) -> None:
    """One-time migration: move comment data from revision_wip JSON to comment_work table."""
    try:
        async with eng.begin() as conn:
            # Skip if comment_work already has rows
            count = (await conn.execute(text("SELECT COUNT(*) FROM comment_work"))).scalar()
            if count and count > 0:
                return

            rows = (await conn.execute(text(
                "SELECT project_id, revision_wip FROM projects WHERE revision_wip IS NOT NULL"
            ))).fetchall()
            for pid, wip_raw in rows:
                if not wip_raw:
                    continue
                wip = json.loads(wip_raw) if isinstance(wip_raw, str) else wip_raw
                plans = wip.get("comment_plans", [])
                parsed = wip.get("parsed_comments", [])
                suggestions = wip.get("suggestions", [])
                source = plans if plans else parsed
                if not source:
                    continue
                for c in source:
                    sug = next((s for s in suggestions
                                if s.get("reviewer_number") == c.get("reviewer_number")
                                and s.get("comment_number") == c.get("comment_number")), None)
                    await conn.execute(text(
                        "INSERT INTO comment_work "
                        "(project_id, round_number, reviewer_number, comment_number, "
                        " original_comment, category, severity, domain, requirement_level, "
                        " ambiguity_flag, ambiguity_question, intent_interpretation, "
                        " discussion, current_plan, doi_references, "
                        " is_finalized, author_response, action_taken, manuscript_changes, "
                        " suggestion) "
                        "VALUES (:pid, 1, :rn, :cn, :oc, :cat, :sev, :dom, :rl, "
                        " :af, :aq, :ii, :disc, :plan, :dois, :fin, :ar, :at, :mc, :sug) "
                        "ON CONFLICT (project_id, round_number, reviewer_number, comment_number) "
                        "DO NOTHING"
                    ), {
                        "pid": pid,
                        "rn": c.get("reviewer_number", 0),
                        "cn": c.get("comment_number", 0),
                        "oc": c.get("original_comment", ""),
                        "cat": c.get("category", "major"),
                        "sev": c.get("severity", "major"),
                        "dom": c.get("domain", "other"),
                        "rl": c.get("requirement_level", "unclear"),
                        "af": "true" if c.get("ambiguity_flag") else "false",
                        "aq": c.get("ambiguity_question", ""),
                        "ii": c.get("intent_interpretation", ""),
                        "disc": json.dumps(c.get("discussion", [])),
                        "plan": c.get("current_plan", ""),
                        "dois": json.dumps(c.get("doi_references", [])),
                        "fin": "true" if c.get("is_finalized") else "false",
                        "ar": c.get("author_response", ""),
                        "at": c.get("action_taken", ""),
                        "mc": c.get("manuscript_changes", ""),
                        "sug": json.dumps(sug) if sug else None,
                    })
                # Slim down wip — remove migrated comment data
                for key in ("parsed_comments", "suggestions", "comment_plans", "finalized_plans"):
                    wip.pop(key, None)
                await conn.execute(text(
                    "UPDATE projects SET revision_wip = :wip WHERE project_id = :pid"
                ), {"wip": json.dumps(wip, ensure_ascii=False), "pid": pid})
    except Exception:
        import traceback
        logging.getLogger(__name__).warning("WIP→comment_work migration skipped: %s", traceback.format_exc())


async def _migrate_add_deep_synthesis_result(eng: AsyncEngine) -> None:
    """Add deep_synthesis_result column to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS deep_synthesis_result TEXT"
            ))
    except Exception:
        pass


async def _migrate_add_token_usage_table(eng: AsyncEngine) -> None:
    """Create token_usage table + indexes if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS token_usage (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                    project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
                    provider VARCHAR(20) NOT NULL,
                    model VARCHAR(100) NOT NULL,
                    stage VARCHAR(100),
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    estimated_cost_usd FLOAT,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
            """))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(project_id)"
            ))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id)"
            ))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at)"
            ))
    except Exception:
        pass


async def _migrate_add_visual_recommendations(eng: AsyncEngine) -> None:
    """Add visual_recommendations JSONB column to projects if missing (idempotent)."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS visual_recommendations JSONB"
            ))
    except Exception:
        pass


async def _migrate_add_image_settings(eng: AsyncEngine) -> None:
    """Add image generation settings columns to user_settings if missing."""
    try:
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_backend TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_model TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_background TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_quality TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_candidate_count TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_asset_mode TEXT;"
            ))
            await conn.execute(text(
                "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS image_provider_profiles_json TEXT;"
            ))
    except Exception:
        pass


def new_user_id() -> str:
    return uuid.uuid4().hex
