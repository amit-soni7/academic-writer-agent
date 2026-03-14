"""
sr_synthesis_service.py

Meta-analysis and narrative synthesis for systematic reviews.

Meta-analysis: pure-Python implementation using the inverse-variance method.
Supports MD, SMD, OR (log-scale), RR (log-scale).
Returns forest plot JSON suitable for D3/SVG rendering in React.

Narrative synthesis: reuses AIProvider.complete() with GRADE-aware prompting,
injecting structured extraction data + RoB summary.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from services.ai_provider import AIProvider
from services.db import create_engine_async, sr_data_extraction, sr_risk_of_bias, sr_screenings
from services.sr_audit import log_ai_decision

logger = logging.getLogger(__name__)


# ── Meta-analysis engine (inverse-variance, no external deps) ─────────────────

def _safe_log(x: float) -> float:
    if x <= 0:
        raise ValueError(f"Cannot take log of non-positive value: {x}")
    return math.log(x)


def _pooled_mean_difference(data: list[dict]) -> dict:
    """
    Fixed/random effects MA for continuous outcomes (Mean Difference).
    Each study needs: mean_t, sd_t, n_t, mean_c, sd_c, n_c, study_id.
    """
    studies = []
    for s in data:
        try:
            mean_t = float(s["mean_t"])
            sd_t = float(s["sd_t"])
            n_t = float(s["n_t"])
            mean_c = float(s["mean_c"])
            sd_c = float(s["sd_c"])
            n_c = float(s["n_c"])

            md = mean_t - mean_c
            se = math.sqrt((sd_t**2 / n_t) + (sd_c**2 / n_c))
            w = 1.0 / (se**2) if se > 0 else 0.0
            studies.append({"study_id": s.get("study_id", "?"), "md": md, "se": se, "w": w,
                            "n": int(n_t + n_c), "ci_lower": md - 1.96 * se, "ci_upper": md + 1.96 * se})
        except (KeyError, ValueError, ZeroDivisionError) as e:
            logger.warning("Skipping study %s for MD: %s", s.get("study_id"), e)

    return _combine_studies(studies, "MD")


def _pooled_odds_ratio(data: list[dict]) -> dict:
    """
    OR on log scale. Each study needs: events_t, n_t, events_c, n_c, study_id.
    """
    studies = []
    for s in data:
        try:
            a = float(s["events_t"])
            b = float(s["n_t"]) - a
            c = float(s["events_c"])
            d = float(s["n_c"]) - c
            # Add 0.5 continuity correction to cells with zero
            if a == 0 or b == 0 or c == 0 or d == 0:
                a += 0.5; b += 0.5; c += 0.5; d += 0.5
            log_or = _safe_log(a * d / (b * c))
            se = math.sqrt(1/a + 1/b + 1/c + 1/d)
            w = 1.0 / (se**2) if se > 0 else 0.0
            studies.append({
                "study_id": s.get("study_id", "?"),
                "log_or": log_or, "se": se, "w": w,
                "n": int(float(s["n_t"]) + float(s["n_c"])),
                "ci_lower": log_or - 1.96 * se,
                "ci_upper": log_or + 1.96 * se,
            })
        except (KeyError, ValueError, ZeroDivisionError) as e:
            logger.warning("Skipping study %s for OR: %s", s.get("study_id"), e)

    result = _combine_studies(studies, "OR")
    # Exponentiate back from log scale
    for key in ("pooled_estimate", "ci_lower", "ci_upper"):
        if result.get(key) is not None:
            result[key] = math.exp(result[key])
    for study in result.get("forest_plot_data", []):
        study["effect"] = math.exp(study.get("log_or", study.get("effect", 0)))
        study["ci_lower"] = math.exp(study["ci_lower"])
        study["ci_upper"] = math.exp(study["ci_upper"])
    return result


def _pooled_risk_ratio(data: list[dict]) -> dict:
    """
    RR on log scale. Each study needs: events_t, n_t, events_c, n_c.
    """
    studies = []
    for s in data:
        try:
            a = float(s["events_t"])
            n_t = float(s["n_t"])
            c = float(s["events_c"])
            n_c = float(s["n_c"])
            if a == 0: a = 0.5
            if c == 0: c = 0.5
            rr = (a / n_t) / (c / n_c)
            log_rr = _safe_log(rr)
            se = math.sqrt((1/a) - (1/n_t) + (1/c) - (1/n_c))
            w = 1.0 / (se**2) if se > 0 else 0.0
            studies.append({
                "study_id": s.get("study_id", "?"),
                "log_rr": log_rr, "se": se, "w": w,
                "n": int(n_t + n_c),
                "ci_lower": log_rr - 1.96 * se,
                "ci_upper": log_rr + 1.96 * se,
            })
        except (KeyError, ValueError, ZeroDivisionError) as e:
            logger.warning("Skipping study %s for RR: %s", s.get("study_id"), e)

    result = _combine_studies(studies, "RR")
    for key in ("pooled_estimate", "ci_lower", "ci_upper"):
        if result.get(key) is not None:
            result[key] = math.exp(result[key])
    for study in result.get("forest_plot_data", []):
        study["effect"] = math.exp(study.get("log_rr", study.get("effect", 0)))
        study["ci_lower"] = math.exp(study["ci_lower"])
        study["ci_upper"] = math.exp(study["ci_upper"])
    return result


def _combine_studies(studies: list[dict], effect_measure: str) -> dict:
    """
    Inverse-variance pooling. Fixed + random effects (DerSimonian-Laird).
    Returns full results including I², tau², Q, forest plot JSON.
    """
    if not studies:
        return {
            "effect_measure": effect_measure, "n_studies": 0, "n_participants": 0,
            "pooled_estimate": None, "ci_lower": None, "ci_upper": None,
            "i_squared": None, "tau_squared": None, "q_statistic": None, "q_p_value": None,
            "model": "none", "forest_plot_data": [],
            "heterogeneity_interpretation": "No data",
        }

    n = len(studies)
    # Use the appropriate effect field
    effect_key = {"MD": "md", "SMD": "smd", "OR": "log_or", "RR": "log_rr"}.get(effect_measure, "md")
    for s in studies:
        if effect_key not in s:
            # Fallback for MD
            s[effect_key] = s.get("md", 0.0)

    # Fixed-effects pooled estimate
    W = sum(s["w"] for s in studies)
    if W == 0:
        return {
            "effect_measure": effect_measure, "n_studies": n, "n_participants": sum(s.get("n",0) for s in studies),
            "pooled_estimate": None, "ci_lower": None, "ci_upper": None,
            "i_squared": None, "tau_squared": None, "q_statistic": None, "q_p_value": None,
            "model": "none", "forest_plot_data": studies,
            "heterogeneity_interpretation": "Cannot compute (zero weight)",
        }

    theta_FE = sum(s["w"] * s[effect_key] for s in studies) / W
    se_FE = math.sqrt(1.0 / W)

    # Cochran's Q and I²
    Q = sum(s["w"] * (s[effect_key] - theta_FE)**2 for s in studies)
    df = n - 1
    # I² = max(0, (Q - df) / Q)
    i_sq = max(0.0, (Q - df) / Q) * 100 if Q > 0 else 0.0

    # DerSimonian-Laird tau²
    c_factor = W - (sum(s["w"]**2 for s in studies) / W)
    tau_sq = max(0.0, (Q - df) / c_factor) if c_factor > 0 else 0.0

    # Random-effects pooled estimate
    w_re = [1.0 / (s["se"]**2 + tau_sq) for s in studies] if tau_sq > 0 else [s["w"] for s in studies]
    W_re = sum(w_re)
    theta_RE = sum(w_re[i] * studies[i][effect_key] for i in range(n)) / W_re if W_re > 0 else theta_FE
    se_RE = math.sqrt(1.0 / W_re) if W_re > 0 else se_FE

    # Use random effects if tau² > 0 (heterogeneity present)
    model = "random" if tau_sq > 0 else "fixed"
    theta = theta_RE if model == "random" else theta_FE
    se = se_RE if model == "random" else se_FE

    # Q p-value (chi-squared distribution approximation)
    try:
        import math
        # Simple chi-squared CDF approximation for p-value
        q_p = _chi2_pvalue(Q, df)
    except Exception:
        q_p = None

    # Per-study weights (%) for forest plot
    total_w = sum(w_re) if model == "random" else W
    forest_data = []
    for i, s in enumerate(studies):
        w_pct = (w_re[i] if model == "random" else s["w"]) / total_w * 100 if total_w > 0 else 0
        forest_data.append({
            "study_id": s["study_id"],
            "effect": s[effect_key],
            "ci_lower": s["ci_lower"],
            "ci_upper": s["ci_upper"],
            "weight_pct": round(w_pct, 1),
            "n": s.get("n", 0),
        })

    # Heterogeneity interpretation
    if i_sq < 25:
        het_interp = "Low heterogeneity (I² < 25%)"
    elif i_sq < 50:
        het_interp = "Moderate heterogeneity (I² 25–50%)"
    elif i_sq < 75:
        het_interp = "Substantial heterogeneity (I² 50–75%)"
    else:
        het_interp = "Considerable heterogeneity (I² > 75%) — interpret pooled estimate cautiously"

    return {
        "effect_measure": effect_measure,
        "model": model,
        "n_studies": n,
        "n_participants": sum(s.get("n", 0) for s in studies),
        "pooled_estimate": round(theta, 4),
        "ci_lower": round(theta - 1.96 * se, 4),
        "ci_upper": round(theta + 1.96 * se, 4),
        "se": round(se, 4),
        "i_squared": round(i_sq, 1),
        "tau_squared": round(tau_sq, 4),
        "q_statistic": round(Q, 3),
        "q_df": df,
        "q_p_value": round(q_p, 4) if q_p is not None else None,
        "theta_fe": round(theta_FE, 4),
        "theta_re": round(theta_RE, 4),
        "heterogeneity_interpretation": het_interp,
        "forest_plot_data": forest_data,
    }


def _chi2_pvalue(q: float, df: int) -> float:
    """
    Approximate p-value for chi-squared distribution using Wilson-Hilferty.
    """
    if df <= 0:
        return 1.0
    # Normal approximation for chi-squared
    x = (q / df) ** (1.0 / 3.0)
    mu = 1.0 - (2.0 / (9.0 * df))
    sigma = math.sqrt(2.0 / (9.0 * df))
    z = (x - mu) / sigma if sigma > 0 else 0.0
    # Approximate 1 - CDF of standard normal
    return _standard_normal_survival(z)


def _standard_normal_survival(z: float) -> float:
    """P(Z > z) for standard normal using Abramowitz & Stegun 26.2.17."""
    if z > 6.0:
        return 0.0
    if z < -6.0:
        return 1.0
    # Use math.erfc for accuracy
    return 0.5 * math.erfc(z / math.sqrt(2))


def run_meta_analysis(
    data: list[dict],
    effect_measure: str = "MD",
    model: str = "random",
    subgroups: list[str] | None = None,
) -> dict:
    """
    Public entry point. Dispatches to the appropriate effect measure calculator.

    Args:
        data: List of study data dicts (fields depend on effect_measure)
        effect_measure: MD | SMD | OR | RR | RD
        model: 'random' (DerSimonian-Laird) or 'fixed'
        subgroups: Optional list of subgroup variable names to stratify by

    Returns:
        Full meta-analysis results dict with forest_plot_data.
    """
    if effect_measure == "MD":
        result = _pooled_mean_difference(data)
    elif effect_measure == "SMD":
        # Standardize first, then pool as MD
        for s in data:
            try:
                n_t = float(s.get("n_t", 0))
                n_c = float(s.get("n_c", 0))
                sd_pooled = math.sqrt(
                    ((n_t - 1) * float(s.get("sd_t", 1))**2 +
                     (n_c - 1) * float(s.get("sd_c", 1))**2) /
                    (n_t + n_c - 2)
                ) if n_t + n_c > 2 else 1.0
                s["mean_t"] = float(s.get("mean_t", 0)) / sd_pooled
                s["mean_c"] = float(s.get("mean_c", 0)) / sd_pooled
                s["sd_t"] = 1.0
                s["sd_c"] = 1.0
            except Exception:
                pass
        result = _pooled_mean_difference(data)
        result["effect_measure"] = "SMD"
    elif effect_measure == "OR":
        result = _pooled_odds_ratio(data)
    elif effect_measure == "RR":
        result = _pooled_risk_ratio(data)
    else:
        result = {"error": f"Unsupported effect measure: {effect_measure}"}

    # Force model label in result
    if "model" in result and model == "fixed":
        result["model"] = "fixed"

    # Subgroup analysis (stratify and run separately per subgroup value)
    if subgroups:
        result["subgroup_analyses"] = {}
        for sg_field in subgroups:
            groups: dict[str, list[dict]] = {}
            for s in data:
                val = str(s.get(sg_field, "Unknown"))
                groups.setdefault(val, []).append(s)
            sg_results = {}
            for val, sg_data in groups.items():
                sg_results[val] = run_meta_analysis(sg_data, effect_measure, model)
            result["subgroup_analyses"][sg_field] = sg_results

    return result


# ── Data preparation from DB ──────────────────────────────────────────────────

async def prepare_meta_analysis_data(
    project_id: str,
    outcome_field: str,
    engine: AsyncEngine | None = None,
) -> list[dict]:
    """
    Query sr_data_extraction for all included papers.
    Extracts effect size data for the specified outcome field.
    """
    eng = engine or create_engine_async()
    async with eng.connect() as conn:
        result = await conn.execute(
            select(sr_data_extraction.c.paper_key, sr_data_extraction.c.final_data,
                   sr_data_extraction.c.ai_extracted)
            .where(sr_data_extraction.c.project_id == project_id)
        )
        rows = [dict(r._mapping) for r in result]

    ma_data = []
    for row in rows:
        final = row.get("final_data") or {}
        if isinstance(final, str):
            try:
                final = json.loads(final)
            except json.JSONDecodeError:
                final = {}

        ai_ext = row.get("ai_extracted") or {}
        if isinstance(ai_ext, str):
            try:
                ai_ext = json.loads(ai_ext)
            except json.JSONDecodeError:
                ai_ext = {}

        # Merge final (human-verified) over AI extracted
        merged = {**ai_ext, **final}

        # Try to extract standard effect size fields
        study_entry = {
            "study_id": row["paper_key"],
            "paper_key": row["paper_key"],
        }

        # Common numeric fields
        for field in ["n_t", "n_c", "mean_t", "mean_c", "sd_t", "sd_c",
                      "events_t", "events_c", "effect_size", "ci_lower", "ci_upper"]:
            val = merged.get(field) or merged.get(f"{field}.value")
            if isinstance(val, dict):
                val = val.get("value")
            if val is not None:
                try:
                    study_entry[field] = float(val)
                except (ValueError, TypeError):
                    pass

        # Sample size from extracted data
        n = merged.get("sample_size") or merged.get("sample_size.value")
        if isinstance(n, dict):
            n = n.get("value")
        if n:
            try:
                total_n = float(str(n).replace(",", ""))
                if "n_t" not in study_entry and "n_c" not in study_entry:
                    study_entry["n_t"] = total_n / 2
                    study_entry["n_c"] = total_n / 2
            except ValueError:
                pass

        # Subgroup variables
        for key in merged:
            if key not in study_entry and isinstance(merged[key], (str, int, float, bool)):
                val = merged[key]
                if isinstance(val, dict):
                    val = val.get("value")
                study_entry[key] = val

        if len(study_entry) > 2:  # Has more than just study_id + paper_key
            ma_data.append(study_entry)

    return ma_data


# ── Narrative synthesis ───────────────────────────────────────────────────────

_SYNTHESIS_SYSTEM = """\
You are an expert systematic review methodologist writing the synthesis section of a
PRISMA 2020 compliant systematic review manuscript.

Write a comprehensive, GRADE-aware narrative synthesis covering:
1. Summary of included studies (designs, populations, settings)
2. Primary outcome results with effect sizes and CIs
3. Heterogeneity discussion (I², tau², possible sources)
4. Risk of bias impact on evidence certainty
5. Subgroup findings (if any)
6. GRADE certainty assessment (High/Moderate/Low/Very low) per outcome with justification
7. AI transparency note (PRISMA-trAIce: which stages used AI, models used, human oversight)

Write in formal academic prose. Use past tense. Cite studies by first-author year.
Do NOT include a title header. Start directly with the synthesis text."""


async def generate_narrative_synthesis(
    project_id: str,
    pico: dict,
    extraction_data: list[dict],
    rob_summary: dict,
    meta_results: dict | None,
    ai_provider: AIProvider,
    engine: AsyncEngine | None = None,
) -> str:
    """
    Generate GRADE-aware narrative synthesis.
    Reuses the AIProvider.complete() pattern from cross_paper_synthesizer.py.
    """
    # Build context for the prompt
    n_included = len(extraction_data)
    rob_counts = rob_summary.get("counts", {})
    rob_summary_text = (
        f"Risk of Bias: Low={rob_counts.get('Low',0)}, "
        f"Some concerns={rob_counts.get('Some concerns',0)}, "
        f"High={rob_counts.get('High',0)}"
    )

    # Build study summaries from extraction data
    study_lines = []
    for i, study in enumerate(extraction_data[:30]):  # Cap at 30 for context length
        final = study.get("final_data") or study.get("ai_extracted") or {}
        if isinstance(final, str):
            try:
                final = json.loads(final)
            except json.JSONDecodeError:
                final = {}
        design = _get_field_value(final, "study_design") or "not reported"
        n = _get_field_value(final, "sample_size") or "n.r."
        pop = _get_field_value(final, "population_description") or ""
        effect = _get_field_value(final, "effect_sizes") or ""
        study_lines.append(f"- {study.get('paper_key','?')}: design={design}, n={n}, pop={pop[:80]}, effects={str(effect)[:100]}")

    studies_text = "\n".join(study_lines) if study_lines else "No extraction data available."

    meta_text = ""
    if meta_results and meta_results.get("n_studies", 0) > 0:
        meta_text = (
            f"\nMeta-analysis results ({meta_results.get('effect_measure','?')}):\n"
            f"  N studies: {meta_results.get('n_studies')}\n"
            f"  Pooled estimate: {meta_results.get('pooled_estimate')} "
            f"[95% CI: {meta_results.get('ci_lower')}–{meta_results.get('ci_upper')}]\n"
            f"  I²: {meta_results.get('i_squared')}% ({meta_results.get('heterogeneity_interpretation','')})\n"
            f"  tau²: {meta_results.get('tau_squared')}\n"
            f"  Q({meta_results.get('q_df')}): {meta_results.get('q_statistic')}, p={meta_results.get('q_p_value')}"
        )

    user_prompt = (
        f"Systematic Review PICO:\n"
        f"Population: {pico.get('population','')}\n"
        f"Intervention: {pico.get('intervention','')}\n"
        f"Comparator: {pico.get('comparator','')}\n"
        f"Outcome: {pico.get('outcome','')}\n\n"
        f"Included studies (N={n_included}):\n{studies_text}\n\n"
        f"{rob_summary_text}\n"
        f"{meta_text}\n\n"
        f"Write a complete narrative synthesis section for this systematic review."
    )

    raw = await ai_provider.complete(
        system=_SYNTHESIS_SYSTEM,
        user=user_prompt,
        temperature=0.3,
        max_tokens=6000,
    )

    await log_ai_decision(
        project_id=project_id,
        stage="synthesis",
        action="ai_synthesis",
        ai_model=ai_provider.config.model,
        prompt=user_prompt[:1000],
        response=raw,
        engine=engine or create_engine_async(),
    )

    return raw


def _get_field_value(data: dict, field: str):
    """Extract value from nested extraction format ({value, quote, confidence})."""
    val = data.get(field)
    if isinstance(val, dict):
        return val.get("value")
    return val


# ── PRISMA flow helpers ───────────────────────────────────────────────────────

async def compute_prisma_flow(
    project_id: str,
    engine: AsyncEngine | None = None,
) -> dict:
    """
    Compute live PRISMA 2020 flow counts by querying all relevant tables.
    """
    from services.db import sr_search_runs, papers as papers_table
    eng = engine or create_engine_async()

    async with eng.connect() as conn:
        # Total identified: from latest search run
        run_result = await conn.execute(
            select(sr_search_runs.c.total_retrieved, sr_search_runs.c.after_dedup,
                   sr_search_runs.c.prisma_counts)
            .where(sr_search_runs.c.project_id == project_id)
            .order_by(sr_search_runs.c.run_date.desc())
            .limit(1)
        )
        run_row = run_result.fetchone()

        identified = 0
        after_dedup = 0
        if run_row:
            identified = run_row.total_retrieved or 0
            after_dedup = run_row.after_dedup or 0

        # Count papers in DB
        paper_count_result = await conn.execute(
            select(papers_table).where(papers_table.c.project_id == project_id)
        )
        paper_count = len(paper_count_result.fetchall())

        # Title/abstract screening
        ta_result = await conn.execute(
            select(
                sr_screenings.c.final_decision,
                sr_screenings.c.exclusion_reason_category,
            )
            .where(sr_screenings.c.project_id == project_id)
            .where(sr_screenings.c.screening_stage == "title_abstract")
        )
        ta_rows = ta_result.fetchall()
        ta_screened = len(ta_rows)
        ta_excluded = sum(1 for r in ta_rows if r.final_decision == "exclude")

        # Full-text screening
        ft_result = await conn.execute(
            select(
                sr_screenings.c.final_decision,
                sr_screenings.c.exclusion_reason_category,
            )
            .where(sr_screenings.c.project_id == project_id)
            .where(sr_screenings.c.screening_stage == "full_text")
        )
        ft_rows = ft_result.fetchall()
        ft_assessed = len(ft_rows)
        ft_excluded = sum(1 for r in ft_rows if r.final_decision == "exclude")

        # Exclusion reasons for full-text
        ft_exclusion_reasons: dict[str, int] = {}
        for r in ft_rows:
            if r.final_decision == "exclude":
                reason = r.exclusion_reason_category or "Not stated"
                ft_exclusion_reasons[reason] = ft_exclusion_reasons.get(reason, 0) + 1

        # Included (passed FT screening)
        included = sum(1 for r in ft_rows if r.final_decision == "include")
        if included == 0:
            # Fall back to TA screening if no FT screening done yet
            included = sum(1 for r in ta_rows if r.final_decision == "include")

    screened = after_dedup if after_dedup > 0 else paper_count
    return {
        "identified": identified if identified > 0 else paper_count,
        "duplicates_removed": max(0, identified - after_dedup) if after_dedup > 0 else 0,
        "screened": screened,
        "excluded_screening": ta_excluded,
        "sought_retrieval": screened - ta_excluded,
        "not_retrieved": 0,  # Unknown without retrieval tracking
        "assessed_eligibility": ft_assessed if ft_assessed > 0 else (screened - ta_excluded),
        "excluded_fulltext": ft_excluded,
        "excluded_fulltext_reasons": ft_exclusion_reasons,
        "included": included,
    }
