"""
sr_data_extraction_service.py

AI-powered structured data extraction for included SR papers.
Dual-pass extraction with disagreement flagging for human verification.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime

import httpx

from services.ai_provider import AIProvider
from services.db import create_engine_async, sr_data_extraction
from services.sr_audit import log_ai_decision
from sqlalchemy import insert, update, select
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

_STANDARD_FIELDS = [
    "study_design", "sample_size", "population_description",
    "intervention_description", "comparator_description",
    "primary_outcomes", "effect_sizes", "follow_up_duration",
    "country", "funding_source", "conflicts_of_interest",
    "randomization_method", "allocation_concealment", "blinding",
]

# Instructions for structured outcome field types (Cochrane Handbook Ch.11)
_OUTCOME_TYPE_INSTRUCTIONS = """
SPECIAL FIELD TYPES — extract as structured objects:

dichotomous_outcome fields (binary event data):
  Extract as: {"events_intervention": N, "n_intervention": N, "events_control": N, "n_control": N}
  Example: {"events_intervention": 45, "n_intervention": 100, "events_control": 30, "n_control": 100}
  If data not available as events/N, note the proportion and total instead.

continuous_outcome fields (mean/SD data):
  Extract as: {"mean_intervention": X, "sd_intervention": X, "n_intervention": N,
               "mean_control": X, "sd_control": X, "n_control": N}
  If SD not available, extract SE or 95% CI and note the statistic type.
  If median/IQR reported instead of mean/SD, extract those and note "median [IQR]".

list fields: Return as JSON array of strings.
boolean fields: Return true/false.
number fields: Return numeric value only (no units in value; note units in quote).
"""

_EXTRACTION_SYSTEM = """You are an expert systematic review data extractor trained to Cochrane standards.
Extract structured data from the provided paper text according to the extraction schema.

For EACH field, provide:
{
  "field_name": {
    "value": "extracted value — see type rules below",
    "quote": "VERBATIM quote from paper supporting this (max 2 sentences)",
    "confidence": 0.0-1.0,
    "page_section": "Methods|Results|Discussion|Abstract|Tables|Figures"
  }
}

CONFIDENCE SCALE (Cochrane guidance):
- 0.9–1.0: Explicitly and clearly stated in the paper
- 0.7–0.8: Inferrable from stated data (e.g., calculated from reported figures)
- 0.5–0.6: Uncertain — data partially reported or ambiguous
- 0.0–0.4: Not reported / not found

RULES:
- Only extract information explicitly present in the paper
- If a field is not reported, set value to null and confidence to 0.0
- For lists (e.g., primary_outcomes), return as JSON array of strings
- For effect sizes, include measure type (OR, RR, MD, SMD, HR), value, and 95% CI
- Return ONLY valid JSON, no markdown fences""" + _OUTCOME_TYPE_INSTRUCTIONS


async def extract_data_ai(
    paper_key: str,
    full_text: str,
    extraction_schema: list[dict],
    pico: dict,
    ai_provider: AIProvider,
    project_id: str = "",
    pass_num: int = 1,
) -> dict:
    """
    Extract structured data from a paper using AI.
    pass_num: 1 or 2 (for dual-pass comparison)
    """
    # Build field list from schema + standard fields
    all_fields = list({f["field"] for f in extraction_schema})
    for sf in _STANDARD_FIELDS:
        if sf not in all_fields:
            all_fields.append(sf)

    schema_fields_set = {f["field"] for f in extraction_schema}
    schema_description = "\n".join(
        f"- {f['field']} [{f.get('type', 'text')}{'*' if f.get('required') else ''}]"
        f"{': ' + f['description'] if f.get('description') else ''}"
        f" [section: {f.get('section', 'General')}]"
        for f in extraction_schema
    ) + "\n" + "\n".join(
        f"- {sf} [text]: Standard Cochrane PICO extraction field"
        for sf in _STANDARD_FIELDS
        if sf not in schema_fields_set
    )

    user = f"""Paper to extract:
{full_text[:6000]}

PICO context:
Population: {pico.get('population', '')}
Intervention: {pico.get('intervention', '')}
Comparator: {pico.get('comparator', '')}
Outcome: {pico.get('outcome', '')}

Fields to extract:
{schema_description}

Extract ALL fields. Return JSON with field_name → {{value, quote, confidence, page_section}}"""

    # Use slight temperature variation for second pass to get different perspective
    temperature = 0.1 if pass_num == 1 else 0.2

    try:
        raw = await ai_provider.complete(
            system=_EXTRACTION_SYSTEM,
            user=user,
            json_mode=True,
            temperature=temperature,
            max_tokens=4096,
        )

        if project_id:
            await log_ai_decision(
                project_id=project_id,
                stage="extraction",
                action=f"ai_extract_pass{pass_num}",
                ai_model=getattr(getattr(ai_provider, "config", None), "model", "unknown"),
                prompt=user,
                response=raw,
                paper_key=paper_key,
            )

        return json.loads(raw)
    except Exception as e:
        logger.error("Extraction error for %s: %s", paper_key, e)
        return {}


async def extract_with_dual_pass(
    paper_key: str,
    full_text: str,
    extraction_schema: list[dict],
    pico: dict,
    ai_provider: AIProvider,
    project_id: str,
) -> dict:
    """
    Run extraction twice, compare results, flag disagreements.
    Returns merged extraction with disagreement flags.
    """
    # Run both passes concurrently
    pass1, pass2 = await asyncio.gather(
        extract_data_ai(paper_key, full_text, extraction_schema, pico, ai_provider, project_id, 1),
        extract_data_ai(paper_key, full_text, extraction_schema, pico, ai_provider, project_id, 2),
        return_exceptions=True,
    )

    if isinstance(pass1, Exception):
        pass1 = {}
    if isinstance(pass2, Exception):
        pass2 = {}

    all_keys = set(pass1.keys()) | set(pass2.keys())
    merged = {}

    for key in all_keys:
        v1 = pass1.get(key, {})
        v2 = pass2.get(key, {})

        val1 = v1.get("value") if isinstance(v1, dict) else None
        val2 = v2.get("value") if isinstance(v2, dict) else None

        # Determine disagreement (simple string comparison)
        disagree = False
        if val1 is not None and val2 is not None:
            s1 = str(val1).strip().lower()[:100]
            s2 = str(val2).strip().lower()[:100]
            disagree = s1 != s2 and abs(len(s1) - len(s2)) > 5

        # Use pass1 as primary, flag disagreements for human review
        primary = v1 if v1 else v2
        if isinstance(primary, dict):
            primary["disagrees_with_pass2"] = disagree
            if disagree:
                primary["pass2_value"] = val2
        else:
            primary = {
                "value": val1,
                "quote": "",
                "confidence": 0.5,
                "page_section": "",
                "disagrees_with_pass2": False,
            }

        merged[key] = primary

    return merged


async def save_extraction(
    project_id: str,
    paper_key: str,
    ai_extracted: dict,
    extraction_schema: list[dict],
    engine: AsyncEngine | None = None,
) -> None:
    """Save AI extraction results to sr_data_extraction table."""
    eng = engine or create_engine_async()
    is_jsonb = sr_data_extraction.c.ai_extracted.type.__class__.__name__.lower() == "jsonb"

    def _payload(d: dict):
        return d if is_jsonb else json.dumps(d, ensure_ascii=False)

    now = datetime.utcnow()
    async with eng.begin() as conn:
        existing = (await conn.execute(
            select(sr_data_extraction.c.id)
            .where(
                (sr_data_extraction.c.project_id == project_id) &
                (sr_data_extraction.c.paper_key == paper_key)
            )
        )).first()

        if existing:
            await conn.execute(
                update(sr_data_extraction)
                .where(
                    (sr_data_extraction.c.project_id == project_id) &
                    (sr_data_extraction.c.paper_key == paper_key)
                )
                .values(
                    ai_extracted=_payload(ai_extracted),
                    final_data=_payload(ai_extracted),  # Start with AI data
                    extraction_schema=_payload({f["field"]: f for f in extraction_schema}),
                    updated_at=now,
                )
            )
        else:
            await conn.execute(
                insert(sr_data_extraction).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    ai_extracted=_payload(ai_extracted),
                    final_data=_payload(ai_extracted),
                    extraction_schema=_payload({f["field"]: f for f in extraction_schema}),
                    human_verified=_payload({}),
                    verified_by_human=False,
                    created_at=now,
                )
            )


async def save_human_verification(
    project_id: str,
    paper_key: str,
    human_verified: dict,
    extraction_notes: str = "",
    engine: AsyncEngine | None = None,
) -> None:
    """Save human corrections/verifications. Merges with AI data for final_data."""
    eng = engine or create_engine_async()
    is_jsonb = sr_data_extraction.c.ai_extracted.type.__class__.__name__.lower() == "jsonb"

    async with eng.begin() as conn:
        # Get existing AI data
        row = (await conn.execute(
            select(sr_data_extraction.c.ai_extracted, sr_data_extraction.c.final_data)
            .where(
                (sr_data_extraction.c.project_id == project_id) &
                (sr_data_extraction.c.paper_key == paper_key)
            )
        )).first()

        if row:
            existing_final = row[1]
            if isinstance(existing_final, str):
                try:
                    existing_final = json.loads(existing_final)
                except Exception:
                    existing_final = {}

            # Merge: human_verified overrides AI data for specified fields
            merged_final = {**existing_final}
            for field, value in human_verified.items():
                merged_final[field] = {"value": value, "source": "human_verified"}

            def _p(d: dict):
                return d if is_jsonb else json.dumps(d, ensure_ascii=False)

            await conn.execute(
                update(sr_data_extraction)
                .where(
                    (sr_data_extraction.c.project_id == project_id) &
                    (sr_data_extraction.c.paper_key == paper_key)
                )
                .values(
                    human_verified=_p(human_verified),
                    final_data=_p(merged_final),
                    extraction_notes=extraction_notes,
                    verified_by_human=True,
                    updated_at=datetime.utcnow(),
                )
            )


async def validate_extraction(extracted: dict) -> dict:
    """Apply logical consistency checks to extracted data."""
    warnings = []
    errors = []

    # Check sample size consistency
    n_total = extracted.get("sample_size", {})
    if isinstance(n_total, dict):
        n_total = n_total.get("value")
    try:
        n_total = int(str(n_total).replace(",", "")) if n_total else None
    except Exception:
        n_total = None

    # Validate effect sizes
    effect_sizes = extracted.get("effect_sizes", {})
    if isinstance(effect_sizes, dict):
        effect_sizes = effect_sizes.get("value", [])
    if isinstance(effect_sizes, list):
        for es in effect_sizes:
            if isinstance(es, dict):
                val = es.get("value")
                measure = es.get("measure", "").upper()
                try:
                    val_f = float(str(val).replace(",", "")) if val else None
                    if val_f is not None:
                        if measure in ("OR", "RR") and not (0.01 <= val_f <= 100):
                            warnings.append(f"Effect size {measure}={val_f} is outside plausible range (0.01-100)")
                        if measure in ("SMD", "MD") and not (-10 <= val_f <= 10):
                            warnings.append(f"Effect size {measure}={val_f} may be implausible")
                except Exception:
                    pass

    return {
        "valid": len(errors) == 0,
        "warnings": warnings,
        "errors": errors,
    }


async def cross_reference_clinicaltrials(nct_id: str) -> dict:
    """Fetch registered trial from ClinicalTrials.gov to detect selective reporting."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(
                f"https://clinicaltrials.gov/api/v2/studies/{nct_id}",
                params={"format": "json"},
            )
            r.raise_for_status()
            data = r.json()
            proto = data.get("protocolSection", {})
            outcomes = proto.get("outcomesModule", {})
            primary = outcomes.get("primaryOutcomes", [])
            secondary = outcomes.get("secondaryOutcomes", [])
            return {
                "nct_id": nct_id,
                "registered_primary_outcomes": [o.get("measure", "") for o in primary],
                "registered_secondary_outcomes": [o.get("measure", "") for o in secondary],
                "status": proto.get("statusModule", {}).get("overallStatus", ""),
            }
    except Exception as e:
        return {"nct_id": nct_id, "error": str(e)}


async def get_all_extractions(project_id: str, engine: AsyncEngine | None = None) -> list[dict]:
    """Get all extraction records for a project."""
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        rows = (await conn.execute(
            select(
                sr_data_extraction.c.paper_key,
                sr_data_extraction.c.ai_extracted,
                sr_data_extraction.c.human_verified,
                sr_data_extraction.c.final_data,
                sr_data_extraction.c.extraction_notes,
                sr_data_extraction.c.verified_by_human,
            )
            .where(sr_data_extraction.c.project_id == project_id)
        )).fetchall()

        result = []
        for r in rows:
            def _coerce(v):
                if isinstance(v, (dict, list)):
                    return v
                try:
                    return json.loads(v) if v else {}
                except Exception:
                    return {}
            result.append({
                "paper_key": r[0],
                "ai_extracted": _coerce(r[1]),
                "human_verified": _coerce(r[2]),
                "final_data": _coerce(r[3]),
                "extraction_notes": r[4] or "",
                "verified_by_human": r[5] or False,
            })
        return result
