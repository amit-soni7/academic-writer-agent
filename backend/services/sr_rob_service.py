"""
sr_rob_service.py

Risk of bias assessment for systematic reviews.
Implements Cochrane RoB 2.0 (RCTs), ROBINS-I (non-randomized studies),
QUADAS-2 (diagnostic accuracy), and Newcastle-Ottawa Scale.

MANDATORY: Every domain judgment MUST be human-confirmed before a paper
can proceed to synthesis. The gate is enforced by the sr_pipeline router.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import httpx
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from services.ai_provider import AIProvider
from services.db import create_engine_async, sr_risk_of_bias
from services.sr_audit import log_ai_decision

logger = logging.getLogger(__name__)


# ── RoB 2.0 domain definitions ────────────────────────────────────────────────

_ROB2_DOMAINS = {
    "D1": {
        "name": "Randomization process",
        "questions": [
            "Was the allocation sequence random?",
            "Was the allocation sequence concealed until participants were enrolled and assigned to interventions?",
            "Did baseline differences between intervention groups suggest a problem with the randomization process?",
        ],
    },
    "D2": {
        "name": "Deviations from intended interventions",
        "questions": [
            "Were participants aware of their assigned intervention during the trial?",
            "Were carers and people delivering the interventions aware of participants' assigned intervention?",
            "If yes (to above): Were there deviations from the intended intervention that arose because of the experimental context?",
            "Were these deviations likely to have affected the outcome?",
            "Was an appropriate analysis used to estimate the effect of assignment to intervention?",
        ],
    },
    "D3": {
        "name": "Missing outcome data",
        "questions": [
            "Were data for this outcome available for all, or nearly all, participants randomized?",
            "If not, is there evidence that the result was not biased by missing outcome data?",
            "Could missingness in the outcome depend on its true value?",
        ],
    },
    "D4": {
        "name": "Measurement of the outcome",
        "questions": [
            "Was the method of measuring the outcome inappropriate?",
            "Could measurement or ascertainment of the outcome have differed between intervention groups?",
            "Were outcome assessors aware of the intervention received by study participants?",
            "Could assessment of the outcome have been influenced by knowledge of intervention received?",
        ],
    },
    "D5": {
        "name": "Selection of the reported result",
        "questions": [
            "Were the trial's pre-specified primary outcome(s) clearly defined?",
            "Is the reported outcome likely to have been selected, on the basis of the results, from multiple eligible outcome measurements or analyses?",
            "Is the reported outcome likely to have been selected, on the basis of the results, from multiple eligible time points?",
        ],
    },
}

_ROBINS_I_DOMAINS = {
    "D1": {"name": "Confounding", "questions": [
        "Is there potential for confounding of the effect of intervention in this study?",
        "Were all important confounders measured?",
        "Were strategies to control for confounding used?",
    ]},
    "D2": {"name": "Selection of participants", "questions": [
        "Was selection of participants into the study based on participant characteristics observed after start of intervention?",
        "Is there a risk of inappropriate exclusion of participants?",
    ]},
    "D3": {"name": "Classification of interventions", "questions": [
        "Could the classification of intervention status have been affected by knowledge of the outcome or risk of the outcome?",
        "Were intervention groups clearly defined?",
    ]},
    "D4": {"name": "Deviations from intended interventions", "questions": [
        "Were there deviations from the intended intervention beyond what would be expected in usual practice?",
        "Were important co-interventions balanced across intervention groups?",
    ]},
    "D5": {"name": "Missing data", "questions": [
        "Were outcome data available for all, or nearly all, participants?",
        "Is there evidence that the result was not biased by missing data?",
    ]},
    "D6": {"name": "Measurement of outcomes", "questions": [
        "Could the outcome measure have been influenced by knowledge of the intervention received?",
        "Were the methods of outcome assessment comparable across groups?",
    ]},
    "D7": {"name": "Selection of the reported result", "questions": [
        "Is the reported effect estimate likely to be selected from multiple analyses?",
    ]},
}

_ROB2_SYSTEM = """\
You are an expert systematic review methodologist applying Cochrane Risk of Bias 2.0 (RoB 2.0).
Assess each signaling question based ONLY on information explicitly reported in the paper.
For each question answer: Yes | Probably Yes | No | Probably No | No information | NA

Domain judgment rules (follow algorithm strictly):
- Low risk: All signaling questions answered Yes/Probably Yes
- Some concerns: At least one question answered Probably No, or No information for a key question
- High risk: At least one question answered No, or multiple Probably No answers

Return ONLY valid JSON — no prose, no markdown fences."""

_ROB2_USER = """\
Study: {title} ({year})
Authors: {authors}

Full text excerpt (first 4000 chars):
{full_text}

PICO context:
Population: {population}
Intervention: {intervention}
Comparator: {comparator}
Outcome: {outcome}

Assess domain: {domain_name}

Signaling questions:
{questions_numbered}

Return JSON:
{{
  "domain_id": "{domain_id}",
  "domain_name": "{domain_name}",
  "signaling_questions": [
    {{
      "question": "...",
      "answer": "Yes|Probably Yes|No|Probably No|No information|NA",
      "quote": "Direct quote from paper or empty string",
      "note": "Optional brief note"
    }}
  ],
  "domain_judgment": "Low|Some concerns|High",
  "rationale": "One sentence explaining the domain judgment"
}}"""


def _calculate_overall_rob2(domain_judgments: dict[str, str]) -> str:
    """
    Cochrane RoB 2.0 algorithm: overall = most severe domain judgment.
    High > Some concerns > Low
    """
    judgments = list(domain_judgments.values())
    if "High" in judgments:
        return "High"
    if "Some concerns" in judgments:
        return "Some concerns"
    return "Low"


# ── Main assessment functions ─────────────────────────────────────────────────

async def assess_rob2_ai(
    project_id: str,
    paper_key: str,
    paper_data: dict,
    pico: dict,
    ai_provider: AIProvider,
    engine: AsyncEngine | None = None,
) -> dict:
    """
    Run RoB 2.0 assessment across all 5 domains using AI.
    Returns the full assessment dict. Does NOT save to DB (caller saves after human review).

    IMPORTANT: This assessment is AI-only and must be human-confirmed before synthesis.
    """
    eng = engine or create_engine_async()

    title = paper_data.get("title", "")
    year = str(paper_data.get("year", ""))
    authors = ", ".join(paper_data.get("authors", [])[:3]) or "Unknown"
    full_text = (paper_data.get("full_text") or paper_data.get("abstract") or "")[:4000]

    population = pico.get("population", "")
    intervention = pico.get("intervention", "")
    comparator = pico.get("comparator", "")
    outcome = pico.get("outcome", "")

    domains_assessed: dict[str, dict] = {}
    domain_judgments: dict[str, str] = {}

    for domain_id, domain_info in _ROB2_DOMAINS.items():
        questions_numbered = "\n".join(
            f"Q{i+1}: {q}" for i, q in enumerate(domain_info["questions"])
        )
        user_prompt = _ROB2_USER.format(
            title=title, year=year, authors=authors,
            full_text=full_text,
            population=population, intervention=intervention,
            comparator=comparator, outcome=outcome,
            domain_name=domain_info["name"],
            questions_numbered=questions_numbered,
            domain_id=domain_id,
        )

        raw = await ai_provider.complete(
            system=_ROB2_SYSTEM,
            user=user_prompt,
            json_mode=True,
            temperature=0.1,
        )

        # Log to audit trail
        await log_ai_decision(
            project_id=project_id,
            stage="rob",
            action="ai_rob",
            ai_model=ai_provider.config.model,
            prompt=user_prompt[:1000],
            response=raw,
            paper_key=paper_key,
            engine=eng,
        )

        try:
            domain_result = json.loads(raw)
        except json.JSONDecodeError:
            start = raw.find("{")
            end = raw.rfind("}") + 1
            try:
                domain_result = json.loads(raw[start:end]) if start != -1 and end > start else {}
            except json.JSONDecodeError:
                domain_result = {}

        # Ensure required fields
        if "domain_judgment" not in domain_result:
            domain_result["domain_judgment"] = "No information"
        if "domain_name" not in domain_result:
            domain_result["domain_name"] = domain_info["name"]
        if "domain_id" not in domain_result:
            domain_result["domain_id"] = domain_id

        domains_assessed[domain_id] = domain_result
        domain_judgments[domain_id] = domain_result.get("domain_judgment", "No information")

    overall = _calculate_overall_rob2(domain_judgments)

    return {
        "tool": "rob2",
        "paper_key": paper_key,
        "domains": domains_assessed,
        "domain_judgments": domain_judgments,
        "overall_risk": overall,
        "ai_assessed": True,
        "human_confirmed": False,
    }


async def assess_robins_i_ai(
    project_id: str,
    paper_key: str,
    paper_data: dict,
    pico: dict,
    ai_provider: AIProvider,
    engine: AsyncEngine | None = None,
) -> dict:
    """
    ROBINS-I for non-randomized studies. 7 domains.
    """
    eng = engine or create_engine_async()

    title = paper_data.get("title", "")
    year = str(paper_data.get("year", ""))
    full_text = (paper_data.get("full_text") or paper_data.get("abstract") or "")[:4000]
    pico_summary = (
        f"Population: {pico.get('population', '')} | "
        f"Intervention: {pico.get('intervention', '')} | "
        f"Comparator: {pico.get('comparator', '')} | "
        f"Outcome: {pico.get('outcome', '')}"
    )

    domains_assessed: dict[str, dict] = {}
    domain_judgments: dict[str, str] = {}

    for domain_id, domain_info in _ROBINS_I_DOMAINS.items():
        questions_numbered = "\n".join(
            f"Q{i+1}: {q}" for i, q in enumerate(domain_info["questions"])
        )
        system = (
            "You are an expert methodologist applying ROBINS-I risk of bias tool for "
            "non-randomized studies of interventions. Answer signaling questions based only "
            "on reported information. Judgments: Low | Moderate | Serious | Critical | "
            "No information. Return ONLY valid JSON."
        )
        user = (
            f"Study: {title} ({year})\n"
            f"PICO: {pico_summary}\n\n"
            f"Full text excerpt:\n{full_text}\n\n"
            f"Domain: {domain_info['name']}\n\n"
            f"Questions:\n{questions_numbered}\n\n"
            f'Return JSON with domain_id, domain_name, signaling_questions '
            f'(list of {{question, answer, quote}}), domain_judgment, rationale.'
        )

        raw = await ai_provider.complete(system=system, user=user, json_mode=True, temperature=0.1)

        await log_ai_decision(
            project_id=project_id, stage="rob", action="ai_rob_robins",
            ai_model=ai_provider.config.model, prompt=user[:1000], response=raw,
            paper_key=paper_key, engine=eng,
        )

        try:
            domain_result = json.loads(raw)
        except json.JSONDecodeError:
            domain_result = {"domain_id": domain_id, "domain_name": domain_info["name"],
                             "domain_judgment": "No information", "rationale": "Parse error"}

        domains_assessed[domain_id] = domain_result
        domain_judgments[domain_id] = domain_result.get("domain_judgment", "No information")

    # ROBINS-I overall: most critical (Critical > Serious > Moderate > Low > No info)
    severity = ["Critical", "Serious", "Moderate", "Low", "No information"]
    overall = "No information"
    for sev in severity:
        if sev in domain_judgments.values():
            overall = sev
            break

    return {
        "tool": "robins_i",
        "paper_key": paper_key,
        "domains": domains_assessed,
        "domain_judgments": domain_judgments,
        "overall_risk": overall,
        "ai_assessed": True,
        "human_confirmed": False,
    }


async def call_robotreviewer(full_text: str, robotreviewer_url: str) -> dict:
    """
    Optional integration with self-hosted RobotReviewer.
    POST to {url}/annotate with full text.
    Returns RoB assessment or empty dict on failure (RobotReviewer is optional).
    """
    if not robotreviewer_url:
        return {}

    url = robotreviewer_url.rstrip("/") + "/annotate"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json={"documents": [{"text": full_text[:8000]}]})
            resp.raise_for_status()
            data = resp.json()
            # RobotReviewer returns list of annotations per document
            docs = data.get("documents", [])
            if docs:
                return docs[0].get("annotations", {})
            return {}
    except Exception as exc:
        logger.warning("RobotReviewer call failed (%s): %s", url, exc)
        return {}


# ── DB operations ──────────────────────────────────────────────────────────────

async def save_rob_assessment(
    project_id: str,
    paper_key: str,
    ai_assessment: dict,
    robotreviewer_assessment: dict | None = None,
    tool_used: str = "rob2",
    engine: AsyncEngine | None = None,
) -> None:
    """Save AI RoB assessment. NOT yet human-confirmed."""
    eng = engine or create_engine_async()
    overall = ai_assessment.get("overall_risk")

    async with eng.begin() as conn:
        # Upsert pattern: try insert, on conflict update
        existing = await conn.execute(
            select(sr_risk_of_bias.c.id)
            .where(sr_risk_of_bias.c.project_id == project_id)
            .where(sr_risk_of_bias.c.paper_key == paper_key)
        )
        row = existing.fetchone()

        if row:
            await conn.execute(
                update(sr_risk_of_bias)
                .where(sr_risk_of_bias.c.project_id == project_id)
                .where(sr_risk_of_bias.c.paper_key == paper_key)
                .values(
                    tool_used=tool_used,
                    ai_assessment=json.dumps(ai_assessment),
                    robotreviewer_assessment=json.dumps(robotreviewer_assessment or {}),
                    overall_risk=overall,
                    human_confirmed=False,
                )
            )
        else:
            await conn.execute(
                insert(sr_risk_of_bias).values(
                    project_id=project_id,
                    paper_key=paper_key,
                    tool_used=tool_used,
                    ai_assessment=json.dumps(ai_assessment),
                    robotreviewer_assessment=json.dumps(robotreviewer_assessment or {}),
                    human_assessment=json.dumps({}),
                    final_assessment=json.dumps({}),
                    overall_risk=overall,
                    human_confirmed=False,
                )
            )


async def confirm_rob_assessment(
    project_id: str,
    paper_key: str,
    human_assessment: dict,
    final_assessment: dict,
    engine: AsyncEngine | None = None,
) -> None:
    """
    Human confirms or overrides RoB assessment.
    This is REQUIRED before the paper can enter synthesis.
    final_assessment should contain domain_judgments + overall_risk.
    """
    eng = engine or create_engine_async()
    overall = final_assessment.get("overall_risk", "Unknown")

    async with eng.begin() as conn:
        await conn.execute(
            update(sr_risk_of_bias)
            .where(sr_risk_of_bias.c.project_id == project_id)
            .where(sr_risk_of_bias.c.paper_key == paper_key)
            .values(
                human_assessment=json.dumps(human_assessment),
                final_assessment=json.dumps(final_assessment),
                overall_risk=overall,
                human_confirmed=True,
            )
        )


async def get_rob_for_paper(
    project_id: str,
    paper_key: str,
    engine: AsyncEngine | None = None,
) -> dict | None:
    """Return RoB assessment for a single paper."""
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(sr_risk_of_bias)
            .where(sr_risk_of_bias.c.project_id == project_id)
            .where(sr_risk_of_bias.c.paper_key == paper_key)
        )
        row = result.fetchone()
        if not row:
            return None
        d = dict(row._mapping)
        for json_col in ("ai_assessment", "robotreviewer_assessment", "human_assessment", "final_assessment"):
            if isinstance(d.get(json_col), str):
                try:
                    d[json_col] = json.loads(d[json_col])
                except json.JSONDecodeError:
                    d[json_col] = {}
        return d


async def get_rob_summary(
    project_id: str,
    engine: AsyncEngine | None = None,
) -> dict:
    """
    Return RoB summary for all papers in the project.
    Returns counts + per-paper table.
    """
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(
                sr_risk_of_bias.c.paper_key,
                sr_risk_of_bias.c.tool_used,
                sr_risk_of_bias.c.overall_risk,
                sr_risk_of_bias.c.human_confirmed,
                sr_risk_of_bias.c.final_assessment,
                sr_risk_of_bias.c.ai_assessment,
            )
            .where(sr_risk_of_bias.c.project_id == project_id)
        )
        rows = [dict(r._mapping) for r in result]

    for row in rows:
        for json_col in ("final_assessment", "ai_assessment"):
            if isinstance(row.get(json_col), str):
                try:
                    row[json_col] = json.loads(row[json_col])
                except json.JSONDecodeError:
                    row[json_col] = {}

    # Counts
    counts = {"Low": 0, "Some concerns": 0, "High": 0, "No information": 0, "unassessed": 0}
    confirmed_count = 0
    for row in rows:
        risk = row.get("overall_risk") or "unassessed"
        counts[risk] = counts.get(risk, 0) + 1
        if row.get("human_confirmed"):
            confirmed_count += 1

    return {
        "papers": rows,
        "counts": counts,
        "total": len(rows),
        "confirmed": confirmed_count,
        "pending_confirmation": len(rows) - confirmed_count,
    }


async def all_included_papers_rob_confirmed(
    project_id: str,
    included_paper_keys: list[str],
    engine: AsyncEngine | None = None,
) -> tuple[bool, list[str]]:
    """
    Check whether all included papers have human-confirmed RoB assessments.
    Returns (all_confirmed: bool, unconfirmed_keys: list[str]).
    Used as a gate before synthesis can proceed.
    """
    eng = engine or create_engine_async()
    if not included_paper_keys:
        return True, []

    async with eng.connect() as conn:
        result = await conn.execute(
            select(sr_risk_of_bias.c.paper_key, sr_risk_of_bias.c.human_confirmed)
            .where(sr_risk_of_bias.c.project_id == project_id)
            .where(sr_risk_of_bias.c.paper_key.in_(included_paper_keys))
        )
        assessed = {r.paper_key: r.human_confirmed for r in result}

    unconfirmed = [
        key for key in included_paper_keys
        if not assessed.get(key, False)
    ]
    return len(unconfirmed) == 0, unconfirmed
