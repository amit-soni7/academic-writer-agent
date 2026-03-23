"""
routers/sr_pipeline.py

Systematic Review pipeline API.
All endpoints require authentication.
Prefix: /api/sr

Protocol:   /api/sr/{id}/pico, /api/sr/{id}/protocol/...
Search:     /api/sr/{id}/search, /api/sr/{id}/search/...
Screening:  /api/sr/{id}/screening/...
Extraction: /api/sr/{id}/extraction/...
RoB:        /api/sr/{id}/rob/...
Synthesis:  /api/sr/{id}/meta_analysis, /api/sr/{id}/synthesis
Manuscript: /api/sr/{id}/manuscript/...
Audit:      /api/sr/{id}/audit_log
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from fastapi.responses import Response, StreamingResponse

from models import (
    OSFRegistrationRequest,
    PRISMAFlowCounts,
    SavePicoRequest,
    SRConflictResolutionRequest,
    SRExtractionSchemaRequest,
    SRHumanVerificationRequest,
    SRMetaAnalysisRequest,
    SRRoBConfirmRequest,
    SRScreeningDecision,
    SRSearchRequest,
)
from routers.settings import load_settings_for_user
from services.ai_provider import AIProvider
from services.auth import get_current_user
from services.db import create_engine_async, projects, sr_protocols, sr_search_runs, _IS_PG
from services.paper_fetcher import FetchSettings
from services.provider_resolver import build_provider_for_user_config
from services.sr_audit import get_audit_log
from services.sr_data_extraction_service import (
    extract_with_dual_pass,
    get_all_extractions,
    save_extraction,
    save_human_verification,
)
from services.sr_protocol_generator import (
    build_evidence_pack,
    generate_background_draft,
    generate_database_search_strings,
    generate_phase_content,
    generate_prisma_p_checklist,
    generate_prisma_p_checklist_docx,
    generate_protocol_document,
    generate_protocol_docx,
    generate_review_question_from_elements,
    map_to_prospero_fields,
    parse_pico_from_text,
    register_on_osf,
    write_background_from_pack,
    write_rationale_from_pack,
)
from services.sr_rob_service import (
    all_included_papers_rob_confirmed,
    assess_rob2_ai,
    confirm_rob_assessment,
    get_rob_for_paper,
    get_rob_summary,
    save_rob_assessment,
)
from services.sr_screening_service import (
    get_prisma_flow_counts,
    get_screening_queue,
    resolve_conflict,
    save_human_screening_decision,
    screen_batch_ai,
)
from services.sr_search_engine import generate_search_queries, run_full_sr_search
from services.sr_synthesis_service import (
    compute_prisma_flow,
    generate_narrative_synthesis,
    prepare_meta_analysis_data,
    run_meta_analysis,
)
from sqlalchemy import insert, select, update
from services.token_context import TokenContext

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sr", tags=["systematic-review"])


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _get_provider(user_id: str) -> AIProvider:
    cfg = await load_settings_for_user(user_id)
    provider = await build_provider_for_user_config(user_id, cfg)
    if provider:
        return provider
    raise HTTPException(status_code=422, detail="AI provider not configured. Please add an API key in Settings.")


async def _get_project_folder(project_id: str) -> str | None:
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = await conn.execute(
            select(projects.c.project_folder).where(projects.c.project_id == project_id)
        )
        return row.scalar_one_or_none()


def _write_protocol_evidence_artifacts(project_folder: str | None, pack: dict) -> dict:
    updated_pack = dict(pack)
    if not project_folder:
        return updated_pack

    os.makedirs(project_folder, exist_ok=True)
    full_papers_path = os.path.join(project_folder, "full_papers")
    updated_pack["saved_full_papers_path"] = full_papers_path

    bibtex = str(updated_pack.get("bibtex") or "").strip()
    bib_path = os.path.join(project_folder, "protocol_evidence_references.bib")
    if bibtex:
        with open(bib_path, "w", encoding="utf-8") as handle:
            handle.write(bibtex + "\n")
        updated_pack["saved_bib_path"] = bib_path
    elif os.path.exists(bib_path):
        os.remove(bib_path)
        updated_pack["saved_bib_path"] = None

    return updated_pack


async def _persist_protocol_evidence_pack(project_id: str, pack: dict) -> dict:
    project_folder = await _get_project_folder(project_id)
    updated_pack = _write_protocol_evidence_artifacts(project_folder, pack)
    try:
        await _upsert_protocol(project_id, evidence_pack=updated_pack)
    except Exception as exc:
        logger.warning("Could not persist evidence_pack: %s", exc)
    return updated_pack


async def _fetch_settings_for_protocol(user_id: str, project_id: str) -> FetchSettings:
    cfg = await load_settings_for_user(user_id)
    project_folder = await _get_project_folder(project_id)

    return FetchSettings(
        pdf_save_enabled=cfg.pdf_save_enabled or bool(project_folder),
        pdf_save_path=cfg.pdf_save_path,
        project_folder=project_folder,
        sci_hub_enabled=cfg.sci_hub_enabled,
        http_proxy=cfg.http_proxy,
    )


async def _load_pico(project_id: str) -> dict:
    """Load PICO from projects table."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(
                projects.c.pico_question,
                projects.c.inclusion_criteria,
                projects.c.exclusion_criteria,
                projects.c.data_extraction_schema,
                projects.c.project_type,
            ).where(projects.c.project_id == project_id)
        )
        row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if row.project_type not in ("systematic_review", "write"):
        # Allow write projects to use SR for meta_analysis type too
        pass
    pico = row.pico_question or {}
    if isinstance(pico, str):
        try:
            pico = json.loads(pico)
        except json.JSONDecodeError:
            pico = {}
    ic = row.inclusion_criteria or []
    if isinstance(ic, str):
        try:
            ic = json.loads(ic)
        except Exception:
            ic = []
    ec = row.exclusion_criteria or []
    if isinstance(ec, str):
        try:
            ec = json.loads(ec)
        except Exception:
            ec = []
    schema = row.data_extraction_schema or []
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except Exception:
            schema = []
    return {"pico": pico, "inclusion_criteria": ic, "exclusion_criteria": ec,
            "data_extraction_schema": schema}


async def _update_sr_stage(project_id: str, stage: str) -> None:
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(sr_current_stage=stage)
        )


async def _get_sr_protocol(project_id: str) -> dict | None:
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(sr_protocols).where(sr_protocols.c.project_id == project_id)
        )
        row = result.fetchone()
    if not row:
        return None
    d = dict(row._mapping)
    for json_col in ("pico", "prospero_fields", "prisma_p_checklist", "campbell_fields",
                     "comet_cos_search", "search_strategies", "evidence_pack"):
        if isinstance(d.get(json_col), str):
            try:
                d[json_col] = json.loads(d[json_col])
            except json.JSONDecodeError:
                d[json_col] = {}
    return d


async def _upsert_protocol(project_id: str, **kwargs) -> None:
    eng = create_engine_async()
    existing = await _get_sr_protocol(project_id)
    async with eng.begin() as conn:
        # Serialize any dicts to JSON strings for non-JSONB dbs
        values = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
                  for k, v in kwargs.items()}
        if existing:
            await conn.execute(
                update(sr_protocols)
                .where(sr_protocols.c.project_id == project_id)
                .values(**values)
            )
        else:
            await conn.execute(
                insert(sr_protocols).values(project_id=project_id, **values)
            )


# ── AI-assisted PICO parsing (no project ID needed) ────────────────────────────

class ParsePicoRequest(BaseModel):
    text: str
    review_type: str = "systematic_review"
    framework: str = ""   # preferred framework hint; empty = AI auto-selects


@router.post("/parse_pico")
async def api_parse_pico(
    body: ParsePicoRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Parse a free-form research question or protocol excerpt into structured
    PICO components, inclusion/exclusion criteria, and extraction schema.
    No project required — used at intake before a project is created.
    """
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="text must not be empty")
    provider = await _get_provider(user["id"])
    return await parse_pico_from_text(body.text, provider, review_type=body.review_type, framework=body.framework)


# ── New AI-first Protocol Builder endpoints ───────────────────────────────────

class ResearchBackgroundRequest(BaseModel):
    query: str
    review_type: str = "systematic_review"
    section: str = "background"  # "background" | "rationale"
    n_articles: int = 20        # 0 = AI-only; >0 = real literature search
    pico_context: dict = {}


@router.post("/research_background")
async def api_research_background(
    body: ResearchBackgroundRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Generate an AI-written background or rationale section for a protocol.
    No project ID required — used before/during protocol building.
    Returns: { draft, summary }
    """
    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query must not be empty")
    provider = await _get_provider(user["id"])
    return await generate_background_draft(
        query=body.query,
        ai_provider=provider,
        section=body.section,
        review_type=body.review_type,
    )


class GenerateReviewQuestionRequest(BaseModel):
    framework: str = "PICO"
    elements: dict = {}
    feedback: str = ""
    review_type: str = "systematic_review"


@router.post("/generate_review_question")
async def api_generate_review_question(
    body: GenerateReviewQuestionRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Generate a structured research question from framework elements.
    Elements-first approach: PICO/SPIDER/PCC elements → RQ (not the other way around).
    Returns: { review_question, alternative_phrasings, methodological_cautions }
    """
    if not body.elements:
        raise HTTPException(status_code=422, detail="elements must not be empty")
    provider = await _get_provider(user["id"])
    return await generate_review_question_from_elements(
        framework=body.framework,
        elements=body.elements,
        ai_provider=provider,
        feedback=body.feedback,
        review_type=body.review_type,
    )


class PhaseChatMessage(BaseModel):
    role: str  # "ai" | "user"
    text: str


class PhaseChatRequest(BaseModel):
    phase: str
    messages: list[PhaseChatMessage] = []
    current_content: dict = {}
    pico_context: dict = {}
    context_data: dict = {}
    review_type: str = "systematic_review"
    mode: str = "direct"  # "direct" | "plan"


@router.post("/{project_id}/protocol/phase_chat")
async def api_phase_chat(
    project_id: str,
    body: PhaseChatRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    AI-human iterative collaboration for a single protocol phase.
    mode="direct": returns updated content immediately.
    mode="plan": returns options/questions only, no content update.
    Returns: { reply: str, content: dict }
    """
    provider = await _get_provider(user["id"])
    messages = [{"role": m.role, "text": m.text} for m in body.messages]
    result = await generate_phase_content(
        phase=body.phase,
        pico_context=body.pico_context,
        context_data=body.context_data,
        current_content=body.current_content,
        messages=messages,
        ai_provider=provider,
        review_type=body.review_type,
        mode=body.mode,
    )
    if body.phase in {"background", "rationale"} and isinstance(result.get("content"), dict):
        pack = result["content"].get("evidence_pack")
        if isinstance(pack, dict) and (pack.get("summaries") or pack.get("ranked_papers")):
            result["content"]["evidence_pack"] = await _persist_protocol_evidence_pack(project_id, pack)
    return result


# ── Evidence Pack endpoints ────────────────────────────────────────────────────

class BuildEvidencePackRequest(BaseModel):
    query: str
    n_articles: int = 20
    pico_context: dict = {}
    review_type: str = "systematic_review"


@router.post("/{project_id}/protocol/build_evidence_pack")
async def api_build_evidence_pack(
    project_id: str,
    body: BuildEvidencePackRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Build an Evidence Pack by running a scoping literature search, then write
    the Background section with citation-validated [SRC{n}] markers resolved.
    Stores the pack in sr_protocols.evidence_pack for reuse by rationale.
    Returns: { pack, warnings, summary }
    """
    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query must not be empty")
    provider = await _get_provider(user["id"])
    fetch_settings = await _fetch_settings_for_protocol(user["id"], project_id)

    pack = await build_evidence_pack(
        query=body.query,
        ai_provider=provider,
        n_articles=body.n_articles,
        pico_context=body.pico_context or None,
        fetch_settings=fetch_settings,
    )
    result = await write_background_from_pack(
        pack=pack,
        query=body.query,
        ai_provider=provider,
        review_type=body.review_type,
    )
    result["pack"] = await _persist_protocol_evidence_pack(project_id, result["pack"])

    return {"pack": result["pack"], "warnings": result.get("warnings", []), "summary": result.get("summary", "")}


class WriteRationaleRequest(BaseModel):
    query: str
    review_type: str = "systematic_review"


@router.post("/{project_id}/protocol/write_rationale")
async def api_write_rationale(
    project_id: str,
    body: WriteRationaleRequest,
    user=Depends(get_current_user),
) -> dict:
    """
    Write Rationale & Gap section by reusing the existing Evidence Pack.
    Returns: { pack, warnings, summary }
    """
    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query must not be empty")

    # Load existing pack
    pack = None
    try:
        eng = create_engine_async()
        async with eng.connect() as conn:
            row = await conn.execute(
                sr_protocols.select().where(sr_protocols.c.project_id == project_id)
            )
            rec = row.mappings().first()
            if rec and rec.get("evidence_pack"):
                pack = rec["evidence_pack"] if isinstance(rec["evidence_pack"], dict) else {}
    except Exception:
        pass

    if not pack or not pack.get("ranked_papers"):
        raise HTTPException(status_code=400, detail="No evidence pack found. Run build_evidence_pack first.")

    provider = await _get_provider(user["id"])
    result = await write_rationale_from_pack(
        pack=pack,
        query=body.query,
        ai_provider=provider,
        review_type=body.review_type,
    )
    result["pack"] = await _persist_protocol_evidence_pack(project_id, result["pack"])

    return {"pack": result["pack"], "warnings": result.get("warnings", []), "summary": result.get("summary", "")}


# ── Protocol endpoints ─────────────────────────────────────────────────────────

@router.post("/{project_id}/pico")
async def save_pico(
    project_id: str,
    body: SavePicoRequest,
    user=Depends(get_current_user),
):
    """Save PICO question, inclusion/exclusion criteria, extraction schema."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(
                pico_question=json.dumps(body.pico),
                inclusion_criteria=json.dumps(body.inclusion_criteria),
                exclusion_criteria=json.dumps(body.exclusion_criteria),
                data_extraction_schema=json.dumps(body.data_extraction_schema),
                sr_current_stage="protocol",
            )
        )
    return {"status": "saved", "project_id": project_id}


@router.get("/{project_id}/prisma_p")
async def get_prisma_p(project_id: str, user=Depends(get_current_user)):
    """Return full PRISMA-P 2015 structured data for this project."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(
                projects.c.prisma_p_data,
                projects.c.pico_question,
                projects.c.inclusion_criteria,
                projects.c.exclusion_criteria,
                projects.c.data_extraction_schema,
                projects.c.query,
            ).where(projects.c.project_id == project_id)
        )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    def _j(v):
        if isinstance(v, (dict, list)):
            return v
        try:
            return json.loads(v) if v else {}
        except Exception:
            return {}

    prisma_p = _j(row.prisma_p_data) or {}

    # Merge in existing PICO / criteria / schema so the UI always has the latest values
    intro = prisma_p.get("introduction", {})
    if not intro.get("pico"):
        intro["pico"] = _j(row.pico_question)
    if not intro.get("review_question"):
        intro["review_question"] = row.query or ""
    prisma_p["introduction"] = intro

    elig = prisma_p.get("methods_eligibility", {})
    if not elig.get("inclusion_criteria"):
        elig["inclusion_criteria"] = _j(row.inclusion_criteria)
    if not elig.get("exclusion_criteria"):
        elig["exclusion_criteria"] = _j(row.exclusion_criteria)
    prisma_p["methods_eligibility"] = elig

    dc = prisma_p.get("methods_data_collection", {})
    if not dc.get("extraction_schema"):
        dc["extraction_schema"] = _j(row.data_extraction_schema)
    prisma_p["methods_data_collection"] = dc

    return {"project_id": project_id, "prisma_p": prisma_p, "query": row.query or ""}


@router.put("/{project_id}/prisma_p")
async def save_prisma_p(project_id: str, body: dict, user=Depends(get_current_user)):
    """
    Save one or more PRISMA-P sections.
    Body: { "section": "introduction", "data": {...} }
      OR: { "prisma_p": { full prisma_p dict } }
    Syncs pico_question, inclusion_criteria, exclusion_criteria, data_extraction_schema
    from the corresponding sections for backward compatibility.
    """
    eng = create_engine_async()

    # Load existing
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.prisma_p_data).where(projects.c.project_id == project_id)
        )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    def _j(v):
        if isinstance(v, (dict, list)):
            return v
        try:
            return json.loads(v) if v else {}
        except Exception:
            return {}

    existing = _j(row.prisma_p_data) or {}

    # Merge incoming data
    if "prisma_p" in body:
        # Full replace
        merged = body["prisma_p"]
    elif "section" in body and "data" in body:
        # Section update
        merged = {**existing}
        merged[body["section"]] = {**existing.get(body["section"], {}), **body["data"]}
    else:
        # Partial flat update (legacy)
        merged = {**existing, **body}

    # Build sync values for backward-compatible columns
    sync_vals: dict = {"prisma_p_data": merged}

    intro = merged.get("introduction", {})
    if intro.get("pico"):
        sync_vals["pico_question"] = intro["pico"]
    if intro.get("review_title"):
        # No separate column; stored only in prisma_p_data
        pass

    elig = merged.get("methods_eligibility", {})
    if elig.get("inclusion_criteria"):
        sync_vals["inclusion_criteria"] = elig["inclusion_criteria"]
    if elig.get("exclusion_criteria"):
        sync_vals["exclusion_criteria"] = elig["exclusion_criteria"]

    dc = merged.get("methods_data_collection", {})
    if dc.get("extraction_schema"):
        sync_vals["data_extraction_schema"] = dc["extraction_schema"]

    # Serialize dicts/lists for non-JSONB DBs
    serialized = {
        k: (json.dumps(v) if isinstance(v, (dict, list)) and not _IS_PG else v)
        for k, v in sync_vals.items()
    }

    async with eng.begin() as conn:
        await conn.execute(
            update(projects).where(projects.c.project_id == project_id).values(**serialized)
        )

    return {"status": "saved", "project_id": project_id}


# Required PRISMA-P item keys for completeness gate
_REQUIRED_ITEMS = {
    "introduction.review_question",
    "introduction.pico.population",
    "introduction.pico.outcome",
    "methods_eligibility.inclusion_criteria",
    "methods_eligibility.exclusion_criteria",
    "methods_eligibility.databases",
    "methods_data_collection.extraction_schema",
    "methods_synthesis.rob_tool",
    "methods_synthesis.synthesis_type",
}

_ALL_ITEMS = [
    "administrative.review_title",           # 1a
    "administrative.is_update",              # 1b
    "administrative.registration_number",    # 2
    "administrative.authors",                # 3a
    "administrative.contributions",          # 3b
    "administrative.amendment_plan",         # 4
    "administrative.funding_sources",        # 5a
    "administrative.sponsor_name",           # 5b
    "administrative.sponsor_role",           # 5c
    "introduction.rationale",                # 6
    "introduction.pico.population",          # 7 (PICO)
    "methods_eligibility.inclusion_criteria", # 8
    "methods_eligibility.exclusion_criteria", # 8
    "methods_eligibility.databases",          # 9
    "methods_search.search_strategies",       # 10
    "methods_data_collection.selection_process",  # 11b
    "methods_data_collection.extraction_schema",  # 12
    "methods_synthesis.rob_tool",             # 14
    "methods_synthesis.synthesis_type",       # 15a
]


def _is_nonempty(v) -> bool:
    if v is None:
        return False
    if isinstance(v, str):
        return v.strip() != ""
    if isinstance(v, (list, dict)):
        return len(v) > 0
    return bool(v)


def _get_nested(d: dict, path: str):
    parts = path.split(".")
    cur = d
    for p in parts:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


@router.get("/{project_id}/prisma_p/score")
async def get_prisma_p_score(project_id: str, user=Depends(get_current_user)):
    """Return completion score for PRISMA-P items."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.prisma_p_data).where(projects.c.project_id == project_id)
        )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    def _j(v):
        if isinstance(v, (dict, list)):
            return v
        try:
            return json.loads(v) if v else {}
        except Exception:
            return {}

    prisma_p = _j(row.prisma_p_data) or {}
    completed = [item for item in _ALL_ITEMS if _is_nonempty(_get_nested(prisma_p, item))]
    missing_required = [item for item in _REQUIRED_ITEMS if not _is_nonempty(_get_nested(prisma_p, item))]
    return {
        "completed": len(completed),
        "total": len(_ALL_ITEMS),
        "required_complete": len(missing_required) == 0,
        "missing_required": missing_required,
        "completed_items": completed,
    }


@router.get("/{project_id}/protocol")
async def get_protocol(project_id: str, user=Depends(get_current_user)):
    """Return generated protocol document and all registration fields."""
    protocol = await _get_sr_protocol(project_id)
    pico_data = await _load_pico(project_id)
    if not protocol:
        return {
            "project_id": project_id,
            "pico": pico_data["pico"],
            "data_extraction_schema": pico_data["data_extraction_schema"],
            "protocol_document": None,
            "prospero_fields": {},
            "prisma_p_checklist": {},
            "search_strategies": {},
            "registration_status": "not_started",
        }
    return {
        "project_id": project_id,
        "pico": pico_data["pico"],
        "data_extraction_schema": pico_data["data_extraction_schema"],
        **protocol,
    }


@router.post("/{project_id}/protocol/generate")
async def generate_protocol(project_id: str, user=Depends(get_current_user)):
    """Stream protocol document generation via SSE."""
    pico_data = await _load_pico(project_id)
    pico = pico_data["pico"]

    # Load prisma_p_data for enriched protocol generation
    eng = create_engine_async()
    async with eng.connect() as conn:
        p_row = (await conn.execute(
            select(projects.c.prisma_p_data).where(projects.c.project_id == project_id)
        )).fetchone()
    prisma_p_raw = p_row.prisma_p_data if p_row else None
    if isinstance(prisma_p_raw, str):
        try:
            prisma_p_raw = json.loads(prisma_p_raw)
        except Exception:
            prisma_p_raw = None

    # Allow generating protocol even without PICO if prisma_p_data has intro
    if not pico and not (prisma_p_raw and prisma_p_raw.get("introduction", {}).get("pico")):
        raise HTTPException(status_code=422, detail="PICO not set. Complete the Introduction tab first.")

    provider = await _get_provider(user["id"])

    async def _stream():
        yield _sse({"type": "progress", "message": "Generating PRISMA-P compliant protocol..."})
        try:
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_protocol"):
                protocol_text = await generate_protocol_document(pico, provider, prisma_p_data=prisma_p_raw)
                yield _sse({"type": "progress", "message": "Mapping to PROSPERO fields..."})
                prospero = await map_to_prospero_fields(pico, protocol_text, provider)
                yield _sse({"type": "progress", "message": "Generating search strings for 8 databases..."})
                search_strings = await generate_database_search_strings(pico, provider)
                yield _sse({"type": "progress", "message": "Building PRISMA-P checklist..."})
                checklist = await generate_prisma_p_checklist(protocol_text)

            await _upsert_protocol(
                project_id,
                pico=pico,
                protocol_document=protocol_text,
                prospero_fields=prospero,
                search_strategies=search_strings,
                prisma_p_checklist=checklist,
                registration_status="draft",
            )
            await _update_sr_stage(project_id, "protocol")

            yield _sse({
                "type": "complete",
                "protocol_document": protocol_text,
                "prospero_fields": prospero,
                "search_strategies": search_strings,
                "prisma_p_checklist": checklist,
            })
        except Exception as exc:
            logger.exception("Protocol generation failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/{project_id}/protocol/register_osf")
async def register_osf(
    project_id: str,
    body: OSFRegistrationRequest,
    user=Depends(get_current_user),
):
    """Register protocol on OSF. Returns registration URL and DOI."""
    protocol = await _get_sr_protocol(project_id)
    if not protocol or not protocol.get("protocol_document"):
        raise HTTPException(status_code=422, detail="Generate the protocol first.")

    pico_data = await _load_pico(project_id)
    result = await register_on_osf(
        protocol_text=protocol["protocol_document"],
        pico=pico_data["pico"],
        osf_token=body.osf_token,
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=502, detail=result.get("message", "OSF registration failed"))

    await _upsert_protocol(
        project_id,
        osf_registration_id=result.get("osf_id"),
        osf_draft_id=result.get("draft_id"),
        registration_status="registered" if result.get("doi") else "draft",
    )
    return result


@router.get("/{project_id}/search_strings")
async def get_search_strings(project_id: str, user=Depends(get_current_user)):
    """Return generated search strings for all 8 databases."""
    protocol = await _get_sr_protocol(project_id)
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not yet generated.")
    return {"search_strategies": protocol.get("search_strategies", {})}


@router.post("/{project_id}/protocol/export_references_bib")
async def export_protocol_references_bib(project_id: str, user=Depends(get_current_user)):
    """Download the current protocol evidence-pack references as BibTeX."""
    protocol = await _get_sr_protocol(project_id)
    if not protocol or not protocol.get("evidence_pack"):
        raise HTTPException(status_code=422, detail="Generate the background evidence pack first.")

    evidence_pack = protocol.get("evidence_pack") or {}
    bibtex = str(evidence_pack.get("bibtex") or "").strip()
    if not bibtex:
        raise HTTPException(status_code=422, detail="No cited references available for BibTeX export yet.")

    return Response(
        content=bibtex + "\n",
        media_type="application/x-bibtex; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="SR_Protocol_References_{project_id}.bib"'},
    )


@router.post("/{project_id}/protocol/export_docx")
async def export_protocol_docx(project_id: str, user=Depends(get_current_user)):
    """Download protocol as PRISMA-P structured Word document."""
    protocol = await _get_sr_protocol(project_id)
    if not protocol or not protocol.get("protocol_document"):
        raise HTTPException(status_code=422, detail="Generate the protocol first.")
    pico_data = await _load_pico(project_id)
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.prisma_p_data).where(projects.c.project_id == project_id)
        )).fetchone()
    prisma_p_data = row.prisma_p_data if row else None
    if isinstance(prisma_p_data, str):
        try:
            prisma_p_data = json.loads(prisma_p_data)
        except Exception:
            prisma_p_data = None
    docx_bytes = await generate_protocol_docx(
        protocol_text=protocol["protocol_document"],
        pico=pico_data["pico"],
        prisma_p_data=prisma_p_data,
    )
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="SR_Protocol_{project_id}.docx"'},
    )


@router.post("/{project_id}/protocol/export_prisma_p_docx")
async def export_prisma_p_docx(project_id: str, user=Depends(get_current_user)):
    """Download a standalone PRISMA-P checklist .docx with reported page numbers."""
    protocol = await _get_sr_protocol(project_id)
    if not protocol or not protocol.get("protocol_document"):
        raise HTTPException(status_code=422, detail="Generate the protocol first.")

    pico_data = await _load_pico(project_id)
    eng = create_engine_async()
    async with eng.connect() as conn:
        row = (await conn.execute(
            select(projects.c.prisma_p_data).where(projects.c.project_id == project_id)
        )).fetchone()
    prisma_p_data = row.prisma_p_data if row else None
    if isinstance(prisma_p_data, str):
        try:
            prisma_p_data = json.loads(prisma_p_data)
        except Exception:
            prisma_p_data = None

    docx_bytes = await generate_prisma_p_checklist_docx(
        protocol_text=protocol["protocol_document"],
        pico=pico_data["pico"],
        prisma_p_data=prisma_p_data,
    )
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="PRISMA-P_Checklist_{project_id}.docx"'},
    )


# ── Search endpoints ──────────────────────────────────────────────────────────

@router.post("/{project_id}/search")
async def run_sr_search(
    project_id: str,
    body: SRSearchRequest,
    user=Depends(get_current_user),
):
    """Stream multi-database SR search progress and results via SSE."""
    pico_data = await _load_pico(project_id)
    pico = pico_data["pico"]
    if not pico:
        raise HTTPException(status_code=422, detail="PICO not set. POST to /pico first.")

    provider = await _get_provider(user["id"])

    # Load user AI settings for API keys
    cfg = await load_settings_for_user(user["id"])
    settings = {
        "ncbi_api_key": getattr(cfg, "ncbi_api_key", None) or "",
        "scopus_api_key": getattr(cfg, "scopus_api_key", None) or "",
        "semantic_scholar_api_key": getattr(cfg, "semantic_scholar_api_key", None) or "",
        "openalex_email": getattr(cfg, "openalex_email", None) or "researcher@example.com",
        "databases": body.databases,
        "date_from": body.date_from,
        "date_to": body.date_to,
        "custom_queries": body.custom_queries,
    }

    async def _stream():
        yield _sse({"type": "progress", "message": "Generating database-specific search queries..."})
        try:
            async for event in run_full_sr_search(
                project_id=project_id,
                pico=pico,
                settings=settings,
                databases=body.databases,
                ai_provider=provider,
            ):
                yield _sse(event)
            await _update_sr_stage(project_id, "search")
        except Exception as exc:
            logger.exception("SR search failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/{project_id}/search/status")
async def get_search_status(project_id: str, user=Depends(get_current_user)):
    """Return current search run status and PRISMA flow counts."""
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(sr_search_runs)
            .where(sr_search_runs.c.project_id == project_id)
            .order_by(sr_search_runs.c.run_date.desc())
            .limit(1)
        )
        row = result.fetchone()

    prisma = await compute_prisma_flow(project_id)

    if not row:
        return {"status": "not_started", "prisma_flow": prisma}

    d = dict(row._mapping)
    for json_col in ("databases_searched", "prisma_counts"):
        if isinstance(d.get(json_col), str):
            try:
                d[json_col] = json.loads(d[json_col])
            except json.JSONDecodeError:
                d[json_col] = {}
    return {"run": d, "prisma_flow": prisma}


@router.post("/{project_id}/search/snowball")
async def snowball_search(
    project_id: str,
    body: dict,
    user=Depends(get_current_user),
):
    """Citation chain (snowball) search via Semantic Scholar."""
    paper_keys: list[str] = body.get("paper_keys", [])

    async def _stream():
        yield _sse({"type": "progress",
                    "message": f"Snowball search queued for {len(paper_keys)} papers..."})
        yield _sse({"type": "complete", "message": "Snowball search not yet implemented.",
                    "new_records": 0})

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ── Screening endpoints ───────────────────────────────────────────────────────

@router.post("/{project_id}/screening/ai_screen")
async def ai_screen_papers(
    project_id: str,
    body: dict,
    user=Depends(get_current_user),
):
    """Stream AI screening decisions for all (or selected) papers."""
    stage: str = body.get("stage", "title_abstract")
    paper_keys: list[str] | None = body.get("paper_keys")

    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    # Load papers from DB
    from services.db import papers as papers_table, summaries as summaries_table
    eng = create_engine_async()
    async with eng.connect() as conn:
        q = select(papers_table).where(papers_table.c.project_id == project_id)
        if paper_keys:
            q = q.where(papers_table.c.paper_key.in_(paper_keys))
        result = await conn.execute(q)
        raw_papers = result.fetchall()

    papers_list = []
    for row in raw_papers:
        d = row.data if hasattr(row, 'data') else {}
        if isinstance(d, str):
            try:
                d = json.loads(d)
            except json.JSONDecodeError:
                d = {}
        papers_list.append({
            "paper_key": row.paper_key,
            **d,
        })

    async def _stream():
        total = len(papers_list)
        yield _sse({"type": "progress", "total": total, "screened": 0,
                    "message": f"Screening {total} papers ({stage})..."})
        try:
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_screening"):
                results = await screen_batch_ai(
                    papers=papers_list,
                    inclusion_criteria=pico_data["inclusion_criteria"],
                    exclusion_criteria=pico_data["exclusion_criteria"],
                    stage=stage,
                    ai_provider=provider,
                    project_id=project_id,
                )
            screened = 0
            for result in results:
                screened += 1
                yield _sse({
                    "type": "screen_result",
                    "paper_key": result["paper_key"],
                    "decision": result["decision"],
                    "confidence": result.get("confidence", 0),
                    "reason": result.get("reason", ""),
                    "key_quote": result.get("key_quote", ""),
                    "progress": screened,
                    "total": total,
                })

            # Update stage
            if stage == "title_abstract":
                await _update_sr_stage(project_id, "screening_ta")
            else:
                await _update_sr_stage(project_id, "screening_ft")

            prisma = await compute_prisma_flow(project_id)
            yield _sse({"type": "complete", "screened": screened, "prisma_flow": prisma})
        except Exception as exc:
            logger.exception("AI screening failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/{project_id}/screening/queue")
async def get_screening_queue_endpoint(
    project_id: str,
    stage: str = "title_abstract",
    status: str = "all",
    user=Depends(get_current_user),
):
    """Return papers awaiting human review decision."""
    queue = await get_screening_queue(project_id, stage=stage, filter_status=status)
    return {"papers": queue, "total": len(queue)}


@router.post("/{project_id}/screening/{paper_key}")
async def save_human_screen(
    project_id: str,
    paper_key: str,
    body: SRScreeningDecision,
    user=Depends(get_current_user),
):
    """Save human screening decision for a paper."""
    await save_human_screening_decision(
        project_id=project_id,
        paper_key=paper_key,
        stage=body.stage,
        decision=body.decision,
        reason=body.reason,
        exclusion_reason_category=body.exclusion_reason_category,
    )
    return {"status": "saved", "paper_key": paper_key, "decision": body.decision}


@router.post("/{project_id}/screening/resolve_conflict/{paper_key}")
async def resolve_screening_conflict(
    project_id: str,
    paper_key: str,
    body: SRConflictResolutionRequest,
    user=Depends(get_current_user),
):
    """Resolve AI-human screening conflict. Requires human final decision."""
    if not body.final_decision:
        raise HTTPException(status_code=422, detail="final_decision is required for conflict resolution.")

    await save_human_screening_decision(
        project_id=project_id,
        paper_key=paper_key,
        stage=body.stage,
        decision=body.final_decision,
        reason=body.resolution_notes,
        exclusion_reason_category="",
    )
    return {"status": "resolved", "paper_key": paper_key, "final_decision": body.final_decision}


@router.get("/{project_id}/screening/prisma_flow")
async def get_prisma_flow(project_id: str, user=Depends(get_current_user)):
    """Return live PRISMA 2020 flow counts."""
    counts = await compute_prisma_flow(project_id)
    return PRISMAFlowCounts(**counts)


# ── Extraction endpoints ──────────────────────────────────────────────────────

@router.post("/{project_id}/extraction/schema")
async def save_extraction_schema(
    project_id: str,
    body: SRExtractionSchemaRequest,
    user=Depends(get_current_user),
):
    """Save user-defined extraction schema."""
    eng = create_engine_async()
    async with eng.begin() as conn:
        await conn.execute(
            update(projects)
            .where(projects.c.project_id == project_id)
            .values(data_extraction_schema=json.dumps(body.fields))
        )
    return {"status": "saved", "fields": body.fields}


@router.post("/{project_id}/extraction/extract/{paper_key}")
async def extract_single_paper(
    project_id: str,
    paper_key: str,
    user=Depends(get_current_user),
):
    """Stream AI extraction for one paper."""
    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    # Load paper data
    from services.db import papers as papers_table
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(papers_table)
            .where(papers_table.c.project_id == project_id)
            .where(papers_table.c.paper_key == paper_key)
        )
        row = result.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"Paper {paper_key!r} not found.")

    paper_d = row.data if hasattr(row, 'data') else {}
    if isinstance(paper_d, str):
        try:
            paper_d = json.loads(paper_d)
        except json.JSONDecodeError:
            paper_d = {}
    full_text = paper_d.get("full_text") or paper_d.get("abstract") or ""

    async def _stream():
        yield _sse({"type": "progress", "message": f"Extracting data from {paper_key}..."})
        try:
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_extraction"):
                extraction = await extract_with_dual_pass(
                    project_id=project_id,
                    paper_key=paper_key,
                    full_text=full_text,
                    extraction_schema=pico_data["data_extraction_schema"],
                    pico=pico_data["pico"],
                    ai_provider=provider,
                )
            yield _sse({"type": "complete", "paper_key": paper_key, "extraction": extraction})
        except Exception as exc:
            logger.exception("Extraction failed for %s/%s", project_id, paper_key)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/{project_id}/extraction/extract_all")
async def extract_all_papers(project_id: str, user=Depends(get_current_user)):
    """Stream batch AI extraction for all included papers."""
    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    # Get included papers from screening
    from services.db import sr_screenings as sr_screenings_table, papers as papers_table
    eng = create_engine_async()
    async with eng.connect() as conn:
        # Get included paper keys from full-text screening
        screen_result = await conn.execute(
            select(sr_screenings_table.c.paper_key)
            .where(sr_screenings_table.c.project_id == project_id)
            .where(sr_screenings_table.c.screening_stage == "full_text")
            .where(sr_screenings_table.c.final_decision == "include")
        )
        included_keys = [r.paper_key for r in screen_result]

        # Fall back to title/abstract screening if no FT screening done
        if not included_keys:
            screen_result = await conn.execute(
                select(sr_screenings_table.c.paper_key)
                .where(sr_screenings_table.c.project_id == project_id)
                .where(sr_screenings_table.c.screening_stage == "title_abstract")
                .where(sr_screenings_table.c.final_decision == "include")
            )
            included_keys = [r.paper_key for r in screen_result]

        # Load paper data
        papers_result = await conn.execute(
            select(papers_table)
            .where(papers_table.c.project_id == project_id)
            .where(papers_table.c.paper_key.in_(included_keys))
        )
        papers_rows = papers_result.fetchall()

    async def _stream():
        total = len(papers_rows)
        yield _sse({"type": "progress", "total": total, "extracted": 0,
                    "message": f"Extracting data from {total} included papers..."})
        extracted_count = 0
        try:
            for row in papers_rows:
                paper_d = row.data if hasattr(row, 'data') else {}
                if isinstance(paper_d, str):
                    try:
                        paper_d = json.loads(paper_d)
                    except json.JSONDecodeError:
                        paper_d = {}
                full_text = paper_d.get("full_text") or paper_d.get("abstract") or ""
                paper_key = row.paper_key

                yield _sse({"type": "progress", "paper_key": paper_key,
                            "message": f"Extracting {paper_key}...", "extracted": extracted_count, "total": total})
                try:
                    async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_extraction"):
                        extraction = await extract_with_dual_pass(
                            project_id=project_id,
                            paper_key=paper_key,
                            full_text=full_text,
                            extraction_schema=pico_data["data_extraction_schema"],
                            pico=pico_data["pico"],
                            ai_provider=provider,
                        )
                    extracted_count += 1
                    yield _sse({"type": "paper_done", "paper_key": paper_key,
                                "extracted": extracted_count, "total": total})
                except Exception as paper_exc:
                    yield _sse({"type": "paper_error", "paper_key": paper_key, "message": str(paper_exc)})

            await _update_sr_stage(project_id, "extraction")
            yield _sse({"type": "complete", "extracted": extracted_count, "total": total})
        except Exception as exc:
            logger.exception("Batch extraction failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/{project_id}/extraction/{paper_key}")
async def get_extraction(project_id: str, paper_key: str, user=Depends(get_current_user)):
    """Return extraction data for one paper."""
    all_ext = await get_all_extractions(project_id)
    for ext in all_ext:
        if ext.get("paper_key") == paper_key:
            return ext
    raise HTTPException(status_code=404, detail=f"No extraction found for {paper_key!r}")


@router.put("/{project_id}/extraction/{paper_key}")
async def update_extraction(
    project_id: str,
    paper_key: str,
    body: SRHumanVerificationRequest,
    user=Depends(get_current_user),
):
    """Save human corrections/confirmations for extraction."""
    await save_human_verification(
        project_id=project_id,
        paper_key=paper_key,
        human_verified=body.human_verified,
        extraction_notes=body.extraction_notes,
    )
    return {"status": "saved", "paper_key": paper_key}


@router.get("/{project_id}/extraction/export_csv")
async def export_extraction_csv(project_id: str, user=Depends(get_current_user)):
    """Download all extracted data as CSV."""
    extractions = await get_all_extractions(project_id)
    if not extractions:
        return Response(content="No extraction data", media_type="text/csv")

    # Collect all field names
    all_fields: set[str] = set()
    for ext in extractions:
        final = ext.get("final_data") or ext.get("ai_extracted") or {}
        if isinstance(final, str):
            try:
                final = json.loads(final)
            except Exception:
                final = {}
        all_fields.update(final.keys())

    fieldnames = ["paper_key"] + sorted(all_fields) + ["verified_by_human", "extraction_notes"]

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()

    for ext in extractions:
        final = ext.get("final_data") or ext.get("ai_extracted") or {}
        if isinstance(final, str):
            try:
                final = json.loads(final)
            except Exception:
                final = {}

        row: dict = {"paper_key": ext.get("paper_key", "")}
        for field, field_data in final.items():
            if isinstance(field_data, dict):
                row[field] = field_data.get("value", "")
            else:
                row[field] = field_data
        row["verified_by_human"] = ext.get("verified_by_human", False)
        row["extraction_notes"] = ext.get("extraction_notes", "")
        writer.writerow(row)

    csv_content = output.getvalue()
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="extraction_{project_id}.csv"'},
    )


# ── Risk of Bias endpoints ────────────────────────────────────────────────────

@router.post("/{project_id}/rob/{paper_key}/assess")
async def assess_rob(
    project_id: str,
    paper_key: str,
    user=Depends(get_current_user),
):
    """Stream AI RoB 2.0 assessment for one paper."""
    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    # Load paper data
    from services.db import papers as papers_table
    eng = create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(papers_table)
            .where(papers_table.c.project_id == project_id)
            .where(papers_table.c.paper_key == paper_key)
        )
        row = result.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail=f"Paper {paper_key!r} not found.")

    paper_d = row.data if hasattr(row, 'data') else {}
    if isinstance(paper_d, str):
        try:
            paper_d = json.loads(paper_d)
        except json.JSONDecodeError:
            paper_d = {}

    async def _stream():
        yield _sse({"type": "progress", "message": f"Assessing RoB 2.0 for {paper_key}...",
                    "note": "This assessment must be confirmed by a human before synthesis."})
        try:
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_rob"):
                assessment = await assess_rob2_ai(
                    project_id=project_id,
                    paper_key=paper_key,
                    paper_data=paper_d,
                    pico=pico_data["pico"],
                    ai_provider=provider,
                )

            # Check RobotReviewer
            cfg = await load_settings_for_user(user["id"])
            rr_url = getattr(cfg, "robotreviewer_url", None) or ""
            rr_result = {}
            if rr_url:
                from services.sr_rob_service import call_robotreviewer
                full_text = paper_d.get("full_text") or paper_d.get("abstract") or ""
                yield _sse({"type": "progress", "message": "Consulting RobotReviewer (second opinion)..."})
                rr_result = await call_robotreviewer(full_text, rr_url)

            await save_rob_assessment(
                project_id=project_id,
                paper_key=paper_key,
                ai_assessment=assessment,
                robotreviewer_assessment=rr_result,
                tool_used="rob2",
            )
            yield _sse({
                "type": "complete",
                "paper_key": paper_key,
                "assessment": assessment,
                "robotreviewer": rr_result,
                "human_confirmation_required": True,
            })
        except Exception as exc:
            logger.exception("RoB assessment failed for %s/%s", project_id, paper_key)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/{project_id}/rob/{paper_key}/confirm")
async def confirm_rob(
    project_id: str,
    paper_key: str,
    body: SRRoBConfirmRequest,
    user=Depends(get_current_user),
):
    """
    Human confirms/overrides RoB assessment.
    REQUIRED before this paper can proceed to synthesis.
    """
    await confirm_rob_assessment(
        project_id=project_id,
        paper_key=paper_key,
        human_assessment=body.human_assessment,
        final_assessment=body.final_assessment,
    )
    # Check if all included papers now confirmed → advance stage
    prisma = await compute_prisma_flow(project_id)
    included_count = prisma.get("included", 0)
    rob_summary_data = await get_rob_summary(project_id)
    if rob_summary_data["confirmed"] >= included_count > 0:
        await _update_sr_stage(project_id, "rob")

    return {
        "status": "confirmed",
        "paper_key": paper_key,
        "final_assessment": body.final_assessment,
        "rob_confirmed_count": rob_summary_data["confirmed"],
        "rob_total": rob_summary_data["total"],
    }


@router.get("/{project_id}/rob/summary")
async def get_rob_summary_endpoint(project_id: str, user=Depends(get_current_user)):
    """Return RoB summary table for all assessed papers."""
    summary = await get_rob_summary(project_id)
    return summary


# ── Synthesis endpoints ───────────────────────────────────────────────────────

@router.post("/{project_id}/meta_analysis")
async def run_meta_analysis_endpoint(
    project_id: str,
    body: SRMetaAnalysisRequest,
    user=Depends(get_current_user),
):
    """Run meta-analysis. Returns results + forest plot JSON."""
    data = await prepare_meta_analysis_data(project_id, outcome_field=body.effect_measure)
    if not data:
        raise HTTPException(status_code=422, detail="No extraction data found for meta-analysis.")

    result = run_meta_analysis(data, effect_measure=body.effect_measure,
                               model=body.model, subgroups=body.subgroups or [])
    return result


@router.post("/{project_id}/synthesis")
async def run_synthesis(project_id: str, user=Depends(get_current_user)):
    """
    Stream narrative synthesis generation.
    GATE: All included papers must have human-confirmed RoB.
    """
    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    # Check RoB gate
    prisma = await compute_prisma_flow(project_id)
    included_keys_result = []
    from services.db import sr_screenings as sr_screenings_table
    eng = create_engine_async()
    async with eng.connect() as conn:
        screen_result = await conn.execute(
            select(sr_screenings_table.c.paper_key)
            .where(sr_screenings_table.c.project_id == project_id)
            .where(sr_screenings_table.c.final_decision == "include")
        )
        included_keys_result = [r.paper_key for r in screen_result]

    if included_keys_result:
        all_confirmed, unconfirmed = await all_included_papers_rob_confirmed(
            project_id, included_keys_result
        )
        if not all_confirmed:
            raise HTTPException(
                status_code=422,
                detail=f"RoB assessment not confirmed for {len(unconfirmed)} papers: "
                       f"{', '.join(unconfirmed[:5])}{'...' if len(unconfirmed) > 5 else ''}. "
                       f"Human confirmation of all RoB assessments is required before synthesis."
            )

    async def _stream():
        yield _sse({"type": "progress", "message": "Loading extraction data..."})
        try:
            extractions = await get_all_extractions(project_id)
            rob_summary_data = await get_rob_summary(project_id)

            # Run meta-analysis if possible
            meta_results = None
            try:
                ma_data = await prepare_meta_analysis_data(project_id, "MD")
                if ma_data:
                    yield _sse({"type": "progress", "message": "Running meta-analysis..."})
                    meta_results = run_meta_analysis(ma_data, "MD")
            except Exception as ma_exc:
                logger.warning("Meta-analysis failed (non-fatal): %s", ma_exc)

            yield _sse({"type": "progress", "message": "Generating GRADE-aware narrative synthesis..."})
            async with TokenContext(project_id=project_id, user_id=user["id"], stage="sr_synthesis"):
                synthesis_text = await generate_narrative_synthesis(
                    project_id=project_id,
                    pico=pico_data["pico"],
                    extraction_data=extractions,
                    rob_summary=rob_summary_data,
                    meta_results=meta_results,
                    ai_provider=provider,
                )

            # Save synthesis to projects table
            from services.project_repo import save_synthesis_result
            await save_synthesis_result(project_id, synthesis_text)
            await _update_sr_stage(project_id, "synthesis")

            yield _sse({
                "type": "complete",
                "synthesis": synthesis_text,
                "meta_analysis": meta_results,
            })
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Synthesis failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/{project_id}/manuscript/generate")
async def generate_sr_manuscript(project_id: str, user=Depends(get_current_user)):
    """
    Stream SR manuscript generation.
    Reuses existing article_builder with PRISMA/meta-analysis context injected.
    """
    from services.project_repo import (
        load_project,
        save_article,
        update_project_phase,
    )

    project_data = await load_project(user["id"], project_id)
    if not project_data:
        raise HTTPException(status_code=404, detail="Project not found.")

    pico_data = await _load_pico(project_id)
    provider = await _get_provider(user["id"])

    prisma_counts = await compute_prisma_flow(project_id)
    rob_summary_data = await get_rob_summary(project_id)
    extractions = await get_all_extractions(project_id)

    # Build PRISMA/meta-analysis context to inject
    prisma_text = (
        f"\nPRISMA 2020 Flow: Identified={prisma_counts['identified']}, "
        f"After dedup={prisma_counts['identified'] - prisma_counts['duplicates_removed']}, "
        f"Screened={prisma_counts['screened']}, "
        f"Excluded T/A={prisma_counts['excluded_screening']}, "
        f"Full-text assessed={prisma_counts['assessed_eligibility']}, "
        f"Excluded FT={prisma_counts['excluded_fulltext']}, "
        f"Included={prisma_counts['included']}\n"
    )
    rob_text = (
        f"Risk of Bias summary: Low={rob_summary_data['counts'].get('Low',0)}, "
        f"Some concerns={rob_summary_data['counts'].get('Some concerns',0)}, "
        f"High={rob_summary_data['counts'].get('High',0)}\n"
    )
    ai_transparency = (
        "AI Transparency (PRISMA-trAIce): AI was used for title/abstract screening, "
        "full-text screening support, data extraction (all human-verified), "
        "risk of bias assessment (all human-confirmed), and narrative synthesis drafting. "
        f"Model: {provider.config.model}. All AI decisions subject to human oversight and confirmation.\n"
    )

    async def _stream():
        yield _sse({"type": "progress", "message": "Building SR manuscript prompt..."})
        try:
            # Build evidence summary from extractions
            study_lines = []
            for ext in extractions[:40]:
                pk = ext.get("paper_key", "")
                final = ext.get("final_data") or ext.get("ai_extracted") or {}
                if isinstance(final, str):
                    try:
                        final = json.loads(final)
                    except Exception:
                        final = {}
                design = (final.get("study_design") or {})
                if isinstance(design, dict):
                    design = design.get("value", "")
                n = (final.get("sample_size") or {})
                if isinstance(n, dict):
                    n = n.get("value", "")
                study_lines.append(f"- {pk}: design={design}, n={n}")

            synthesis = project_data.get("synthesis_result") or ""
            title = project_data.get("manuscript_title") or project_data.get("query", "Systematic Review")

            system_prompt = (
                "You are an expert biomedical writer. Write a complete, PRISMA 2020 compliant "
                "systematic review manuscript in Markdown. Follow the standard structure: "
                "Abstract (Background, Objectives, Methods, Results, Conclusions), "
                "Introduction, Methods (Eligibility, Information Sources, Search Strategy, "
                "Study Selection, Data Extraction, Risk of Bias, Synthesis), Results "
                "(Study Selection, Study Characteristics, Risk of Bias, Synthesis), "
                "Discussion (Summary, Limitations, Conclusions), Declarations."
            )
            user_prompt = (
                f"# {title}\n\n"
                f"Research question: {project_data.get('query', '')}\n\n"
                f"{prisma_text}\n{rob_text}\n{ai_transparency}\n\n"
                f"Synthesis:\n{synthesis[:3000] if synthesis else 'Not yet generated.'}\n\n"
                f"Included studies ({len(study_lines)}):\n" + "\n".join(study_lines[:30])
            )

            yield _sse({"type": "progress", "message": "Generating manuscript..."})
            article_text = await provider.complete(
                system=system_prompt,
                user=user_prompt,
                temperature=0.3,
                max_tokens=16000,
            )

            await save_article(project_id, article_text)
            await update_project_phase(project_id, "article")
            await _update_sr_stage(project_id, "manuscript")

            yield _sse({"type": "complete", "article": article_text})
        except Exception as exc:
            logger.exception("SR manuscript generation failed for %s", project_id)
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/{project_id}/manuscript/prisma_checklist")
async def get_prisma_checklist(project_id: str, user=Depends(get_current_user)):
    """Return PRISMA 2020 checklist completion status."""
    protocol = await _get_sr_protocol(project_id)
    if protocol and protocol.get("prisma_p_checklist"):
        return {"checklist": protocol["prisma_p_checklist"], "source": "protocol"}
    # Generate a basic completion status from what we have
    prisma_counts = await compute_prisma_flow(project_id)
    has_search = prisma_counts["identified"] > 0
    has_screening = prisma_counts["screened"] > 0
    has_included = prisma_counts["included"] > 0
    return {
        "checklist": {
            "title": {"status": "complete" if protocol else "missing"},
            "abstract": {"status": "partial"},
            "introduction": {"status": "missing"},
            "search": {"status": "complete" if has_search else "missing"},
            "screening": {"status": "complete" if has_screening else "missing"},
            "included_studies": {"status": "complete" if has_included else "missing"},
        },
        "source": "computed",
    }


# ── Audit log ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/audit_log")
async def get_audit_log_endpoint(project_id: str, user=Depends(get_current_user)):
    """Return full RAISE-compliant audit log. Downloadable as CSV."""
    log = await get_audit_log(project_id)
    return {"entries": log, "total": len(log)}


@router.get("/{project_id}/audit_log/csv")
async def export_audit_log_csv(project_id: str, user=Depends(get_current_user)):
    """Download audit log as CSV for publication compliance."""
    log = await get_audit_log(project_id)

    output = io.StringIO()
    fieldnames = ["id", "timestamp", "stage", "action", "paper_key", "ai_model",
                  "prompt_hash", "response_summary", "human_override"]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for entry in log:
        row = {k: str(entry.get(k, "")) for k in fieldnames}
        writer.writerow(row)

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="audit_log_{project_id}.csv"'},
    )
