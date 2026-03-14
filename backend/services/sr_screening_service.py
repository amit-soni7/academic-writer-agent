"""
sr_screening_service.py

Dual-reviewer AI screening for systematic reviews.
AI reviewer1: structured JSON screening with confidence scores.
Human reviewer2: UI-driven decisions stored in sr_screenings table.
Conflict resolution: AI-suggested, human-confirmed.

Sensitivity tuned high: confidence < 0.85 → human review queue.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from services.ai_provider import AIProvider
from services.db import create_engine_async, sr_screenings, papers as papers_table, summaries as summaries_table
from services.sr_audit import log_ai_decision

logger = logging.getLogger(__name__)

_SCREEN_SYSTEM_TA = """You are an expert systematic review screener for title/abstract screening.
Your task: assess whether a paper should be included in the systematic review based on the inclusion/exclusion criteria.

CRITICAL RULES:
- Err on the side of INCLUSION when uncertain (maximize recall, minimize missed relevant papers)
- Confidence threshold: only use "include" or "exclude" if confidence ≥ 0.85; otherwise use "uncertain"
- Base decisions ONLY on the provided title and abstract
- Return ONLY valid JSON

Response format:
{
  "decision": "include" | "exclude" | "uncertain",
  "confidence": 0.0-1.0,
  "criteria_scores": {"IC1": true/false, "IC2": true/false, "EC1": true/false},
  "reason": "One sentence explaining the decision",
  "key_quote": "Direct quote from abstract supporting decision (or empty string)"
}"""

_SCREEN_SYSTEM_FT = """You are an expert systematic review screener for full-text eligibility assessment.
Your task: assess whether a paper meets ALL inclusion criteria based on its full text.

CRITICAL RULES:
- Be more precise than title/abstract screening — this is the final eligibility gate
- For each criterion, cite specific text from the paper
- Confidence threshold: only "include"/"exclude" if confidence ≥ 0.85
- If full text is unavailable (abstract only), set confidence ≤ 0.70 and decision to "uncertain"
- Return ONLY valid JSON

Response format:
{
  "decision": "include" | "exclude" | "uncertain",
  "confidence": 0.0-1.0,
  "criteria_scores": {"IC1": true/false, "EC1": true/false},
  "reason": "One sentence explanation",
  "key_quote": "Specific quote supporting decision",
  "exclusion_reason_category": "wrong population|wrong intervention|wrong comparator|wrong outcome|wrong study design|not full RCT|duplicate|other" (only if excluding)
}"""


async def screen_single_paper_ai(
    paper: dict,
    inclusion_criteria: list[str],
    exclusion_criteria: list[str],
    stage: str,
    ai_provider: AIProvider,
    project_id: str = "",
) -> dict:
    """Screen a single paper with AI. Returns structured screening result."""
    system = _SCREEN_SYSTEM_TA if stage == "title_abstract" else _SCREEN_SYSTEM_FT

    # Build criteria list
    ic_lines = "\n".join(f"IC{i+1}: {c}" for i, c in enumerate(inclusion_criteria))
    ec_lines = "\n".join(f"EC{i+1}: {c}" for i, c in enumerate(exclusion_criteria))

    title = paper.get("title", "")
    abstract = paper.get("abstract", "") or paper.get("data", {}).get("abstract", "")
    authors = paper.get("authors", [])
    year = paper.get("year", "")
    journal = paper.get("journal", "")

    user = f"""Paper to screen:
Title: {title}
Authors: {', '.join(authors[:3]) if authors else 'Unknown'}
Journal: {journal} ({year})
Abstract: {abstract or '[No abstract available]'}

Inclusion Criteria:
{ic_lines or 'IC1: Relevant to the research topic'}

Exclusion Criteria:
{ec_lines or 'EC1: Not relevant to the research topic'}

Stage: {stage.replace('_', ' ').title()}

Assess this paper and return your JSON decision."""

    try:
        raw = await ai_provider.complete(
            system=system,
            user=user,
            json_mode=True,
            temperature=0.1,
        )

        # Log AI decision
        if project_id:
            paper_key = (paper.get("doi") or (title or "")[:60]).lower().strip()
            await log_ai_decision(
                project_id=project_id,
                stage=f"screening_{stage}",
                action="ai_screen",
                ai_model=getattr(ai_provider, "config", type("c", (), {"model": "unknown"})()).model if hasattr(ai_provider, "config") else "unknown",
                prompt=user,
                response=raw,
                paper_key=paper_key,
            )

        data = json.loads(raw)
        decision = data.get("decision", "uncertain")
        confidence = float(data.get("confidence", 0.5))

        # Enforce confidence threshold: low confidence → uncertain
        if confidence < 0.85 and decision in ("include", "exclude"):
            decision = "uncertain"

        return {
            "decision": decision,
            "confidence": confidence,
            "criteria_scores": data.get("criteria_scores", {}),
            "reason": data.get("reason", ""),
            "key_quote": data.get("key_quote", ""),
            "exclusion_reason_category": data.get("exclusion_reason_category", ""),
        }
    except Exception as e:
        logger.error("AI screening error for paper '%s': %s", title[:40], e)
        return {
            "decision": "uncertain",
            "confidence": 0.0,
            "criteria_scores": {},
            "reason": f"Screening error: {e}",
            "key_quote": "",
            "exclusion_reason_category": "",
        }


async def screen_batch_ai(
    papers: list[dict],
    inclusion_criteria: list[str],
    exclusion_criteria: list[str],
    stage: str,
    ai_provider: AIProvider,
    project_id: str,
    engine: AsyncEngine | None = None,
) -> list[dict]:
    """
    Screen a batch of papers with AI. Saves results to sr_screenings table.
    Returns list of screening result dicts.

    High-confidence decisions saved as reviewer1 with final_decision set.
    Low-confidence → saved as uncertain, goes to human review queue.
    """
    eng = engine or create_engine_async()
    results = []

    # Process in batches of 20 concurrently
    batch_size = 20
    for i in range(0, len(papers), batch_size):
        batch = papers[i:i + batch_size]
        tasks = [
            screen_single_paper_ai(p, inclusion_criteria, exclusion_criteria, stage, ai_provider, project_id)
            for p in batch
        ]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)

        async with eng.begin() as conn:
            for paper, result in zip(batch, batch_results):
                if isinstance(result, Exception):
                    result = {"decision": "uncertain", "confidence": 0.0,
                              "criteria_scores": {}, "reason": str(result),
                              "key_quote": "", "exclusion_reason_category": ""}

                paper_key = (paper.get("doi") or (paper.get("title") or "")[:60]).lower().strip()
                decision = result["decision"]
                confidence = result["confidence"]
                # High-confidence → set final_decision; uncertain → leave for human
                final_decision = decision if confidence >= 0.85 else None

                is_jsonb = sr_screenings.c.reviewer1_criteria_scores.type.__class__.__name__.lower() == "jsonb"
                criteria_scores = result["criteria_scores"]
                criteria_payload = criteria_scores if is_jsonb else json.dumps(criteria_scores)

                now = datetime.utcnow()
                try:
                    await conn.execute(
                        insert(sr_screenings).values(
                            project_id=project_id,
                            paper_key=paper_key,
                            screening_stage=stage,
                            reviewer1_decision=decision,
                            reviewer1_type="ai",
                            reviewer1_reason=result["reason"],
                            reviewer1_confidence=confidence,
                            reviewer1_criteria_scores=criteria_payload,
                            final_decision=final_decision,
                            exclusion_reason_category=result.get("exclusion_reason_category", ""),
                            created_at=now,
                        ).on_conflict_do_update(
                            index_elements=["project_id", "paper_key", "screening_stage"],  # not exact syntax for raw SQL
                            set_={
                                "reviewer1_decision": decision,
                                "reviewer1_type": "ai",
                                "reviewer1_reason": result["reason"],
                                "reviewer1_confidence": confidence,
                                "reviewer1_criteria_scores": criteria_payload,
                                "final_decision": final_decision,
                                "exclusion_reason_category": result.get("exclusion_reason_category", ""),
                                "updated_at": now,
                            }
                        )
                    )
                except Exception:
                    # Fallback: try plain insert, ignore conflict
                    try:
                        await conn.execute(
                            insert(sr_screenings).values(
                                project_id=project_id,
                                paper_key=paper_key,
                                screening_stage=stage,
                                reviewer1_decision=decision,
                                reviewer1_type="ai",
                                reviewer1_reason=result["reason"],
                                reviewer1_confidence=confidence,
                                reviewer1_criteria_scores=criteria_payload,
                                final_decision=final_decision,
                                exclusion_reason_category=result.get("exclusion_reason_category", ""),
                                created_at=now,
                            )
                        )
                    except Exception as e2:
                        logger.warning("Insert sr_screenings failed: %s", e2)

                results.append({
                    "paper_key": paper_key,
                    "title": paper.get("title", "")[:80],
                    **result,
                    "needs_human_review": final_decision is None,
                })

    return results


async def save_human_screening_decision(
    project_id: str,
    paper_key: str,
    stage: str,
    decision: str,
    reason: str,
    exclusion_reason_category: str = "",
    engine: AsyncEngine | None = None,
) -> None:
    """Save a human reviewer's screening decision."""
    eng = engine or create_engine_async()
    now = datetime.utcnow()

    async with eng.begin() as conn:
        # Check if AI decision exists
        existing = (await conn.execute(
            select(sr_screenings.c.id, sr_screenings.c.reviewer1_decision)
            .where(
                (sr_screenings.c.project_id == project_id) &
                (sr_screenings.c.paper_key == paper_key) &
                (sr_screenings.c.screening_stage == stage)
            )
        )).first()

        if existing:
            ai_decision = existing[1]
            conflict = ai_decision and ai_decision != decision
            await conn.execute(
                update(sr_screenings)
                .where(
                    (sr_screenings.c.project_id == project_id) &
                    (sr_screenings.c.paper_key == paper_key) &
                    (sr_screenings.c.screening_stage == stage)
                )
                .values(
                    reviewer2_decision=decision,
                    reviewer2_type="human",
                    reviewer2_reason=reason,
                    # If no conflict, human decision is final
                    final_decision=decision if not conflict else None,
                    conflict_resolved_by="human" if not conflict else None,
                    exclusion_reason_category=exclusion_reason_category,
                    updated_at=now,
                )
            )
        else:
            # No AI decision yet — human screened first
            await conn.execute(
                insert(sr_screenings).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    screening_stage=stage,
                    reviewer2_decision=decision,
                    reviewer2_type="human",
                    reviewer2_reason=reason,
                    final_decision=decision,
                    conflict_resolved_by="human",
                    exclusion_reason_category=exclusion_reason_category,
                    created_at=now,
                )
            )


async def resolve_conflict(
    paper_key: str,
    ai_decision: str,
    human_decision: str,
    ai_reason: str,
    human_reason: str,
    inclusion_criteria: list[str],
    exclusion_criteria: list[str],
    ai_provider: AIProvider,
) -> dict:
    """
    When AI and human disagree, use AI to suggest resolution.
    Final decision MUST be confirmed by human — this only provides a suggestion.
    """
    ic_text = "\n".join(f"- {c}" for c in inclusion_criteria)
    ec_text = "\n".join(f"- {c}" for c in exclusion_criteria)

    system = """You are a systematic review adjudicator. Two reviewers disagree on whether to include a paper.
Analyze both decisions with their reasons and the inclusion/exclusion criteria.
Suggest a resolution and explain your reasoning.
Return ONLY valid JSON:
{"suggested_resolution": "include"|"exclude"|"uncertain", "rationale": "...", "key_consideration": "..."}
IMPORTANT: The human reviewer makes the final decision — you are providing a recommendation only."""

    user = f"""Paper key: {paper_key}

AI Reviewer decision: {ai_decision}
AI Reason: {ai_reason}

Human Reviewer decision: {human_decision}
Human Reason: {human_reason}

Inclusion Criteria:
{ic_text}

Exclusion Criteria:
{ec_text}

Suggest resolution (human will make final decision):"""

    try:
        raw = await ai_provider.complete(system=system, user=user, json_mode=True, temperature=0.2)
        return json.loads(raw)
    except Exception as e:
        return {"suggested_resolution": "uncertain", "rationale": f"Resolution failed: {e}", "key_consideration": ""}


async def get_prisma_flow_counts(project_id: str, engine: AsyncEngine | None = None) -> dict:
    """Query all relevant tables to compute live PRISMA 2020 flow counts."""
    from services.db import sr_search_runs
    eng = engine or create_engine_async()

    async with eng.connect() as conn:
        # Get latest search run
        run = (await conn.execute(
            select(sr_search_runs.c.total_retrieved, sr_search_runs.c.after_dedup, sr_search_runs.c.prisma_counts)
            .where(sr_search_runs.c.project_id == project_id)
            .order_by(sr_search_runs.c.run_date.desc())
            .limit(1)
        )).first()

        identified = run[0] if run else 0
        after_dedup = run[1] if run else 0
        duplicates_removed = identified - after_dedup

        # Count T/A screening decisions
        ta_all = (await conn.execute(
            select(sr_screenings.c.final_decision)
            .where(
                (sr_screenings.c.project_id == project_id) &
                (sr_screenings.c.screening_stage == "title_abstract") &
                (sr_screenings.c.final_decision.isnot(None))
            )
        )).fetchall()

        ta_include = sum(1 for r in ta_all if r[0] == "include")
        ta_exclude = sum(1 for r in ta_all if r[0] == "exclude")

        # Count FT screening decisions
        ft_all = (await conn.execute(
            select(sr_screenings.c.final_decision, sr_screenings.c.exclusion_reason_category)
            .where(
                (sr_screenings.c.project_id == project_id) &
                (sr_screenings.c.screening_stage == "full_text") &
                (sr_screenings.c.final_decision.isnot(None))
            )
        )).fetchall()

        ft_include = sum(1 for r in ft_all if r[0] == "include")
        ft_exclude = sum(1 for r in ft_all if r[0] == "exclude")

        # Exclusion reasons breakdown
        ft_reasons: dict = {}
        for r in ft_all:
            if r[0] == "exclude" and r[1]:
                ft_reasons[r[1]] = ft_reasons.get(r[1], 0) + 1

        return {
            "identified": identified,
            "duplicates_removed": duplicates_removed,
            "screened": after_dedup,
            "excluded_screening": ta_exclude,
            "sought_retrieval": ta_include,
            "not_retrieved": 0,  # Would need full-text retrieval tracking
            "assessed_eligibility": len(ft_all),
            "excluded_fulltext": ft_exclude,
            "excluded_fulltext_reasons": ft_reasons,
            "included": ft_include,
        }


async def get_screening_queue(
    project_id: str,
    stage: str,
    status: str = "all",
    engine: AsyncEngine | None = None,
) -> list[dict]:
    """
    Get papers for the screening queue.
    status: 'pending' = needs human review, 'conflict' = AI/human disagree, 'all' = everything
    """
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        q = select(
            sr_screenings.c.paper_key,
            sr_screenings.c.reviewer1_decision,
            sr_screenings.c.reviewer1_confidence,
            sr_screenings.c.reviewer1_reason,
            sr_screenings.c.reviewer2_decision,
            sr_screenings.c.final_decision,
            sr_screenings.c.exclusion_reason_category,
        ).where(
            (sr_screenings.c.project_id == project_id) &
            (sr_screenings.c.screening_stage == stage)
        )

        rows = (await conn.execute(q)).fetchall()
        results = []
        for r in rows:
            ai_dec = r[1]
            human_dec = r[4]
            final_dec = r[5]
            is_conflict = ai_dec and human_dec and ai_dec != human_dec
            needs_human = final_dec is None

            if status == "pending" and not needs_human:
                continue
            if status == "conflict" and not is_conflict:
                continue

            results.append({
                "paper_key": r[0],
                "ai_decision": ai_dec,
                "ai_confidence": r[2],
                "ai_reason": r[3],
                "human_decision": human_dec,
                "final_decision": final_dec,
                "exclusion_reason": r[6],
                "is_conflict": is_conflict,
                "needs_human_review": needs_human,
            })
        return results
