"""
services/deep_synthesizer.py

Multi-stage deep evidence synthesis pipeline.

Orchestrates 7 stages with SSE progress events:
  1. Extract evidence objects (no LLM)
  2. Normalize claims (batched LLM)
  3. Evidence gap auto-fetch (search + summarize)
  4. Cluster claims (LLM)
  5. Within-cluster synthesis (parallel LLM)
  6. Theory detection (LLM)
  7. Build manuscript packs (parallel LLM)

Public API
----------
deep_synthesize(provider, summaries, query, article_type, sections, ...)
    → AsyncGenerator[dict, None]  # yields SSE events, final event has result
"""

import logging
import time
import uuid
from typing import AsyncGenerator, Optional

from models import (
    ClaimCluster,
    DeepSynthesisResult,
    NormalizedClaim,
    PaperSummary,
)
from services.ai_provider import AIProvider
from services.llm_errors import LLMError

logger = logging.getLogger(__name__)


def _truncate(text: str, max_len: int = 100) -> str:
    """Truncate text for display in progress events."""
    if len(text) <= max_len:
        return text
    return text[:max_len - 1] + "\u2026"


def _elapsed_label(start: float) -> str:
    """Human-readable elapsed time."""
    secs = time.monotonic() - start
    if secs < 60:
        return f"{secs:.1f}s"
    return f"{secs / 60:.1f}m"


# ── Fallback functions (when LLM is unavailable) ─────────────────────────────

def _fallback_claims_from_evidence(summaries: list[PaperSummary]) -> list[NormalizedClaim]:
    """Stage 2 fallback: convert evidence objects directly into NormalizedClaims without LLM."""
    from services.claim_normalizer import extract_evidence_objects

    evidence_objects = extract_evidence_objects(summaries)
    seen: set[str] = set()
    claims: list[NormalizedClaim] = []

    for eo in evidence_objects:
        text = eo.get("text", "").strip()
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())

        # Simple heuristic for effect direction
        low = text.lower()
        if any(w in low for w in ("increase", "higher", "positive", "improve", "enhance")):
            direction = "positive"
        elif any(w in low for w in ("decrease", "lower", "negative", "reduce", "decline")):
            direction = "negative"
        elif any(w in low for w in ("no significant", "no difference", "null", "non-significant")):
            direction = "null"
        else:
            direction = "mixed"

        claims.append(NormalizedClaim(
            claim_id=f"NC-{uuid.uuid4().hex[:8]}",
            canonical_text=text,
            source_paper_keys=[eo.get("paper_key", "")],
            population="",
            outcome="",
            effect_direction=direction,
            effect_magnitude=eo.get("effect_size", ""),
            evidence_grade=eo.get("evidence_grade", ""),
            verbatim_quotes=[eo.get("supporting_quote", "")] if eo.get("supporting_quote") else [],
        ))

    return claims


def _fallback_cluster_by_paper(claims: list[NormalizedClaim]) -> list[ClaimCluster]:
    """Stage 4 fallback: group claims by shared paper_key overlap."""
    if not claims:
        return []

    # Group claims by their first paper key
    groups: dict[str, list[NormalizedClaim]] = {}
    for c in claims:
        key = c.source_paper_keys[0] if c.source_paper_keys else "unknown"
        groups.setdefault(key, []).append(c)

    clusters: list[ClaimCluster] = []
    for key, group_claims in groups.items():
        label = _truncate(group_claims[0].canonical_text, 60) if group_claims else key
        clusters.append(ClaimCluster(
            cluster_id=f"CC-{uuid.uuid4().hex[:8]}",
            cluster_label=label,
            claims=group_claims,
            synthesis_statement="Synthesis unavailable (LLM error)",
            overall_direction="mixed",
            strength=0.5,
        ))

    return clusters


async def deep_synthesize(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
    article_type: str = "review",
    sections: list[str] | None = None,
    project_id: str = "",
    auto_fetch_enabled: bool = True,
    fetch_settings: Optional[object] = None,
) -> AsyncGenerator[dict, None]:
    """
    Run the full 7-stage deep synthesis pipeline.

    Yields SSE-ready dicts with progress information at each stage.
    The final event has type="complete" and includes the full DeepSynthesisResult.
    """
    from services.claim_normalizer import (
        cluster_claims,
        extract_evidence_objects,
        normalize_claims,
    )
    from services.cluster_synthesizer import detect_theories, synthesize_clusters
    from services.evidence_gap_fetcher import fetch_evidence_gaps, identify_thin_claims
    from services.manuscript_pack_builder import build_manuscript_packs

    result = DeepSynthesisResult()
    pipeline_start = time.monotonic()

    if not summaries:
        yield {"type": "complete", "result": result.model_dump()}
        return

    # Collect paper titles for display
    paper_titles = {
        s.paper_key: _truncate(s.bibliography.title or s.paper_key, 80)
        for s in summaries
    }
    total_papers = len(summaries)

    # ── Stage 1: Extract evidence objects (no LLM) ───────────────────────────
    yield {
        "type": "stage_start",
        "stage": 1,
        "stage_name": "extract_evidence",
        "message": f"Scanning {total_papers} papers for evidence objects\u2026",
    }

    # Progress: what we're scanning
    yield {
        "type": "progress",
        "stage": 1,
        "stage_name": "extract_evidence",
        "message": f"Reading results, sentence banks, and introduction claims from {total_papers} papers",
        "detail": {
            "substep": "scanning",
            "papers": list(paper_titles.values())[:8],
            "total_papers": total_papers,
        },
    }

    evidence_objects = extract_evidence_objects(summaries)

    # Count by source type
    source_counts: dict[str, int] = {}
    for eo in evidence_objects:
        src = eo.get("source_type", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1

    # Show sample evidence objects
    samples = []
    for eo in evidence_objects[:5]:
        samples.append(_truncate(eo.get("text", ""), 120))

    yield {
        "type": "progress",
        "stage": 1,
        "stage_name": "extract_evidence",
        "message": f"Found {len(evidence_objects)} evidence objects across {total_papers} papers",
        "detail": {
            "substep": "complete",
            "evidence_objects": len(evidence_objects),
            "by_source": source_counts,
            "samples": samples,
        },
    }

    result.stages_completed.append("extract_evidence")
    yield {
        "type": "stage_complete",
        "stage": 1,
        "stage_name": "extract_evidence",
        "message": f"Extracted {len(evidence_objects)} evidence objects ({_elapsed_label(pipeline_start)})",
        "detail": {
            "evidence_objects": len(evidence_objects),
            "by_source": source_counts,
        },
    }

    # ── Stage 2: Normalize claims (LLM) ──────────────────────────────────────
    stage2_start = time.monotonic()
    yield {
        "type": "stage_start",
        "stage": 2,
        "stage_name": "normalize_claims",
        "message": f"AI is normalizing {len(evidence_objects)} evidence objects into canonical claims\u2026",
    }

    # Show what normalization does
    yield {
        "type": "progress",
        "stage": 2,
        "stage_name": "normalize_claims",
        "message": "Merging duplicate findings, standardizing effect directions, and tagging populations",
        "detail": {
            "substep": "preparing",
            "batch_size": 40,
            "total_batches": max(1, (len(evidence_objects) + 39) // 40),
            "total_evidence": len(evidence_objects),
        },
    }

    stage2_fallback = False
    try:
        normalized = await normalize_claims(provider, summaries, query)
    except LLMError as e:
        logger.warning("Stage 2 LLM failed — using fallback: %s", e.raw_message[:200])
        normalized = _fallback_claims_from_evidence(summaries)
        stage2_fallback = True
        warning_entry = {"stage": "normalize_claims", "error_type": e.error_type, "message": e.raw_message}
        result.warnings.append(warning_entry)
        yield {
            "type": "warning",
            "stage": 2,
            "stage_name": "normalize_claims",
            "message": f"AI normalization failed ({e.error_type}) — using direct extraction fallback",
            "error": e.to_dict(),
        }
    result.normalized_claims = normalized

    # Categorize claims by effect direction
    direction_counts: dict[str, int] = {}
    for nc in normalized:
        direction_counts[nc.effect_direction] = direction_counts.get(nc.effect_direction, 0) + 1

    # Sample normalized claims
    claim_samples = []
    for nc in normalized[:6]:
        claim_samples.append({
            "text": _truncate(nc.canonical_text, 120),
            "direction": nc.effect_direction,
            "papers": len(nc.source_paper_keys),
            "grade": nc.evidence_grade,
        })

    yield {
        "type": "progress",
        "stage": 2,
        "stage_name": "normalize_claims",
        "message": f"Produced {len(normalized)} canonical claims from {len(evidence_objects)} raw evidence objects",
        "detail": {
            "substep": "normalized",
            "claims_count": len(normalized),
            "by_direction": direction_counts,
            "samples": claim_samples,
        },
    }

    result.stages_completed.append("normalize_claims")
    yield {
        "type": "stage_complete",
        "stage": 2,
        "stage_name": "normalize_claims",
        "message": f"Normalized into {len(normalized)} claims ({_elapsed_label(stage2_start)})",
        "detail": {
            "normalized_claims": len(normalized),
            "by_direction": direction_counts,
        },
    }

    # ── Stage 3: Evidence gap auto-fetch ─────────────────────────────────────
    stage3_start = time.monotonic()
    if auto_fetch_enabled and normalized:
        # First check for thin claims
        thin_claims = identify_thin_claims(normalized)
        thin_count = len(thin_claims)

        yield {
            "type": "stage_start",
            "stage": 3,
            "stage_name": "auto_fetch",
            "message": f"Scanning {len(normalized)} claims for evidence gaps\u2026",
        }

        if thin_count > 0:
            # Show which claims are thin
            thin_samples = []
            for tc in thin_claims[:4]:
                thin_samples.append({
                    "text": _truncate(tc.canonical_text, 100),
                    "papers": len(tc.source_paper_keys),
                    "grade": tc.evidence_grade,
                })

            yield {
                "type": "progress",
                "stage": 3,
                "stage_name": "auto_fetch",
                "message": f"Found {thin_count} thin claims (supported by \u22641 paper) \u2014 searching for additional evidence",
                "detail": {
                    "substep": "thin_claims_found",
                    "thin_claims": thin_count,
                    "samples": thin_samples,
                },
            }
        else:
            yield {
                "type": "progress",
                "stage": 3,
                "stage_name": "auto_fetch",
                "message": "All claims have sufficient evidence support \u2014 skipping auto-fetch",
                "detail": {
                    "substep": "no_thin_claims",
                    "thin_claims": 0,
                },
            }

        async def _auto_fetch_progress(event: dict) -> None:
            pass  # Progress captured in main stream

        auto_result, new_summaries = await fetch_evidence_gaps(
            provider=provider,
            claims=normalized,
            existing_summaries=summaries,
            query=query,
            project_id=project_id,
            fetch_settings=fetch_settings,
            progress_cb=_auto_fetch_progress,
        )
        result.auto_fetch_result = auto_result

        if auto_result.queries_generated:
            yield {
                "type": "progress",
                "stage": 3,
                "stage_name": "auto_fetch",
                "message": f"Generated {len(auto_result.queries_generated)} search queries for thin claims",
                "detail": {
                    "substep": "queries_generated",
                    "queries": [_truncate(q, 100) for q in auto_result.queries_generated],
                },
            }

        if auto_result.papers_found > 0:
            yield {
                "type": "progress",
                "stage": 3,
                "stage_name": "auto_fetch",
                "message": f"Found {auto_result.papers_found} new papers, summarizing {min(auto_result.papers_found, 25)}\u2026",
                "detail": {
                    "substep": "papers_found",
                    "papers_found": auto_result.papers_found,
                    "skipped_duplicate": auto_result.skipped_duplicate,
                },
            }

        # If new papers were found, re-normalize and merge
        if new_summaries:
            summaries = list(summaries) + new_summaries
            new_normalized = await normalize_claims(provider, new_summaries, query)
            existing_texts = {c.canonical_text.lower() for c in normalized}
            for nc in new_normalized:
                if nc.canonical_text.lower() not in existing_texts:
                    normalized.append(nc)
                    existing_texts.add(nc.canonical_text.lower())
                else:
                    for existing in normalized:
                        if existing.canonical_text.lower() == nc.canonical_text.lower():
                            for key in nc.source_paper_keys:
                                if key not in existing.source_paper_keys:
                                    existing.source_paper_keys.append(key)
                            break

            result.normalized_claims = normalized

            yield {
                "type": "progress",
                "stage": 3,
                "stage_name": "auto_fetch",
                "message": f"Summarized {auto_result.papers_summarized} new papers and merged into evidence base",
                "detail": {
                    "substep": "merged",
                    "new_paper_keys": auto_result.new_paper_keys,
                    "total_claims_now": len(normalized),
                },
            }

        result.stages_completed.append("auto_fetch")
        yield {
            "type": "stage_complete",
            "stage": 3,
            "stage_name": "auto_fetch",
            "message": (
                f"Auto-fetched {auto_result.papers_summarized} papers for {auto_result.thin_claims_detected} thin claims ({_elapsed_label(stage3_start)})"
                if auto_result.papers_summarized > 0
                else f"No additional papers needed ({_elapsed_label(stage3_start)})"
            ),
            "detail": {
                "thin_claims": auto_result.thin_claims_detected,
                "papers_found": auto_result.papers_found,
                "papers_summarized": auto_result.papers_summarized,
                "new_paper_keys": auto_result.new_paper_keys,
            },
        }
    else:
        result.stages_completed.append("auto_fetch_skipped")
        yield {
            "type": "stage_complete",
            "stage": 3,
            "stage_name": "auto_fetch",
            "message": "Auto-fetch skipped",
            "detail": {"skipped": True},
        }

    # ── Stage 4: Cluster claims (LLM) ────────────────────────────────────────
    stage4_start = time.monotonic()
    yield {
        "type": "stage_start",
        "stage": 4,
        "stage_name": "cluster_claims",
        "message": f"AI is grouping {len(normalized)} claims into thematic clusters\u2026",
    }

    yield {
        "type": "progress",
        "stage": 4,
        "stage_name": "cluster_claims",
        "message": "Identifying semantically related claims and grouping by topic/relationship",
        "detail": {
            "substep": "clustering",
            "claims_to_cluster": len(normalized),
            "unique_papers": len(set(
                pk for nc in normalized for pk in nc.source_paper_keys
            )),
        },
    }

    try:
        clusters = await cluster_claims(provider, normalized, query)
    except LLMError as e:
        logger.warning("Stage 4 LLM failed — using fallback: %s", e.raw_message[:200])
        clusters = _fallback_cluster_by_paper(normalized)
        warning_entry = {"stage": "cluster_claims", "error_type": e.error_type, "message": e.raw_message}
        result.warnings.append(warning_entry)
        yield {
            "type": "warning",
            "stage": 4,
            "stage_name": "cluster_claims",
            "message": f"AI clustering failed ({e.error_type}) — using paper-based grouping fallback",
            "error": e.to_dict(),
        }
    result.claim_clusters = clusters

    # Show cluster summary
    cluster_info = []
    for cl in clusters:
        cluster_info.append({
            "label": cl.cluster_label,
            "claims": len(cl.claims),
            "direction": cl.overall_direction,
            "strength": round(cl.strength, 2),
        })

    yield {
        "type": "progress",
        "stage": 4,
        "stage_name": "cluster_claims",
        "message": f"Formed {len(clusters)} thematic clusters from {len(normalized)} claims",
        "detail": {
            "substep": "clustered",
            "clusters": cluster_info,
        },
    }

    result.stages_completed.append("cluster_claims")
    yield {
        "type": "stage_complete",
        "stage": 4,
        "stage_name": "cluster_claims",
        "message": f"Formed {len(clusters)} clusters ({_elapsed_label(stage4_start)})",
        "detail": {"clusters": len(clusters)},
    }

    # ── Stage 5: Within-cluster synthesis (parallel LLM) ─────────────────────
    stage5_start = time.monotonic()
    total_claims_in_clusters = sum(len(c.claims) for c in clusters)
    yield {
        "type": "stage_start",
        "stage": 5,
        "stage_name": "synthesize_clusters",
        "message": f"AI is synthesizing {len(clusters)} clusters with contradiction analysis\u2026",
    }

    yield {
        "type": "progress",
        "stage": 5,
        "stage_name": "synthesize_clusters",
        "message": f"Running {len(clusters)} parallel AI calls \u2014 synthesizing evidence and decomposing contradictions across 5 dimensions",
        "detail": {
            "substep": "synthesizing",
            "cluster_labels": [cl.cluster_label for cl in clusters],
            "total_claims": total_claims_in_clusters,
            "dimensions": ["population", "method", "measurement", "timeframe", "context"],
        },
    }

    try:
        synthesized = await synthesize_clusters(provider, clusters, query)
    except LLMError as e:
        logger.warning("Stage 5 LLM failed — returning clusters as-is: %s", e.raw_message[:200])
        synthesized = clusters  # return un-synthesized clusters
        for cl in synthesized:
            if not cl.synthesis_statement:
                cl.synthesis_statement = "Synthesis unavailable (LLM error)"
        warning_entry = {"stage": "synthesize_clusters", "error_type": e.error_type, "message": e.raw_message}
        result.warnings.append(warning_entry)
        yield {
            "type": "warning",
            "stage": 5,
            "stage_name": "synthesize_clusters",
            "message": f"AI synthesis failed ({e.error_type}) — clusters returned without deep synthesis",
            "error": e.to_dict(),
        }
    result.claim_clusters = synthesized

    total_contradictions = sum(len(c.contradiction_details) for c in synthesized)

    # Show synthesis results per cluster
    synth_details = []
    for cl in synthesized:
        synth_details.append({
            "label": cl.cluster_label,
            "synthesis": _truncate(cl.synthesis_statement, 150),
            "direction": cl.overall_direction,
            "contradictions": len(cl.contradiction_details),
            "strength": round(cl.strength, 2),
        })

    yield {
        "type": "progress",
        "stage": 5,
        "stage_name": "synthesize_clusters",
        "message": (
            f"Synthesis complete \u2014 {total_contradictions} contradictions found across {len(synthesized)} clusters"
            if total_contradictions > 0
            else f"Synthesis complete \u2014 evidence is largely consistent across {len(synthesized)} clusters"
        ),
        "detail": {
            "substep": "synthesized",
            "clusters": synth_details,
            "total_contradictions": total_contradictions,
        },
    }

    result.stages_completed.append("synthesize_clusters")
    yield {
        "type": "stage_complete",
        "stage": 5,
        "stage_name": "synthesize_clusters",
        "message": f"Synthesized {len(synthesized)} clusters, {total_contradictions} contradictions ({_elapsed_label(stage5_start)})",
        "detail": {
            "clusters_synthesized": len(synthesized),
            "contradictions_found": total_contradictions,
        },
    }

    # ── Stage 6: Theory detection (LLM) ──────────────────────────────────────
    stage6_start = time.monotonic()

    # Count theory-related sentences for display
    theory_sentence_count = 0
    for s in summaries:
        for sent in s.sentence_bank:
            if sent.primary_purpose in ("theory", "original_source") or (
                getattr(sent, "is_seminal", False) and sent.primary_purpose == "background"
            ):
                theory_sentence_count += 1

    yield {
        "type": "stage_start",
        "stage": 6,
        "stage_name": "detect_theories",
        "message": f"Scanning {theory_sentence_count} theory-related sentences across papers\u2026",
    }

    yield {
        "type": "progress",
        "stage": 6,
        "stage_name": "detect_theories",
        "message": "Identifying theoretical frameworks, mapping seminal vs. applying papers, and assessing support levels",
        "detail": {
            "substep": "scanning",
            "theory_sentences": theory_sentence_count,
            "total_papers": total_papers,
        },
    }

    try:
        theories = await detect_theories(provider, summaries, query)
    except LLMError as e:
        logger.warning("Stage 6 LLM failed — returning empty: %s", e.raw_message[:200])
        theories = []
        warning_entry = {"stage": "detect_theories", "error_type": e.error_type, "message": e.raw_message}
        result.warnings.append(warning_entry)
        yield {
            "type": "warning",
            "stage": 6,
            "stage_name": "detect_theories",
            "message": f"Theory detection failed ({e.error_type}) — skipped",
            "error": e.to_dict(),
        }
    result.theory_map = theories

    # Show detected theories
    theory_info = []
    for t in theories:
        theory_info.append({
            "name": t.theory_name,
            "support": t.support_level,
            "seminal_count": len(t.seminal_paper_keys),
            "applying_count": len(t.applying_paper_keys),
            "description": _truncate(t.description, 120),
        })

    yield {
        "type": "progress",
        "stage": 6,
        "stage_name": "detect_theories",
        "message": (
            f"Detected {len(theories)} theoretical frameworks across the corpus"
            if theories
            else "No explicit theoretical frameworks detected in the corpus"
        ),
        "detail": {
            "substep": "detected",
            "theories": theory_info,
        },
    }

    result.stages_completed.append("detect_theories")
    yield {
        "type": "stage_complete",
        "stage": 6,
        "stage_name": "detect_theories",
        "message": f"Found {len(theories)} theories ({_elapsed_label(stage6_start)})",
        "detail": {"theories_detected": len(theories)},
    }

    # ── Stage 7: Build manuscript packs (parallel LLM) ───────────────────────
    stage7_start = time.monotonic()
    yield {
        "type": "stage_start",
        "stage": 7,
        "stage_name": "build_packs",
        "message": "Building section-oriented manuscript evidence packs\u2026",
    }

    # Build a quick SynthesisResult-like object for the pack builder
    from models import SynthesisResult, EvidenceClaim, Contradiction
    evidence_matrix = []
    contradictions_list = []
    gaps_list = []

    for cluster in synthesized:
        for claim in cluster.claims:
            evidence_matrix.append(EvidenceClaim(
                claim=claim.canonical_text,
                supporting_papers=claim.source_paper_keys,
                contradicting_papers=[],
                study_designs=[],
                strength_score=cluster.strength,
                consistency=cluster.overall_direction,
            ))
        for cd in cluster.contradiction_details:
            contradictions_list.append(Contradiction(
                topic=cluster.cluster_label,
                papers_a=cd.papers_a,
                papers_b=cd.papers_b,
                finding_a=cd.description,
                finding_b="",
                likely_reason=cd.resolution_hypothesis,
            ))

    synthesis_proxy = SynthesisResult(
        evidence_matrix=evidence_matrix,
        contradictions=contradictions_list,
        gaps=gaps_list,
    )

    target_sections = sections or ["introduction", "methods", "results", "discussion"]
    yield {
        "type": "progress",
        "stage": 7,
        "stage_name": "build_packs",
        "message": f"Organizing evidence into {len(target_sections)} manuscript sections with narrative arcs",
        "detail": {
            "substep": "organizing",
            "sections": target_sections,
            "evidence_claims": len(evidence_matrix),
            "contradictions": len(contradictions_list),
        },
    }

    try:
        packs = await build_manuscript_packs(
            provider=provider,
            synthesis=synthesis_proxy,
            summaries=summaries,
            article_type=article_type,
            sections=sections or [],
            query=query,
        )
    except LLMError as e:
        from models import ManuscriptPack
        logger.warning("Stage 7 LLM failed — returning empty packs: %s", e.raw_message[:200])
        packs = ManuscriptPack()
        warning_entry = {"stage": "build_packs", "error_type": e.error_type, "message": e.raw_message}
        result.warnings.append(warning_entry)
        yield {
            "type": "warning",
            "stage": 7,
            "stage_name": "build_packs",
            "message": f"Manuscript pack building failed ({e.error_type}) — skipped",
            "error": e.to_dict(),
        }
    result.manuscript_packs = packs

    # Show pack summary
    pack_details = []
    for sec_key, sp in packs.section_packs.items():
        pack_details.append({
            "section": sp.section_name,
            "themes": len(sp.theme_clusters),
            "citations": len(sp.key_citations),
            "narrative_arc": _truncate(sp.narrative_arc, 120) if sp.narrative_arc else "",
        })

    yield {
        "type": "progress",
        "stage": 7,
        "stage_name": "build_packs",
        "message": f"Manuscript packs ready \u2014 {len(packs.section_packs)} sections with evidence-backed narrative arcs",
        "detail": {
            "substep": "packed",
            "sections": pack_details,
            "central_argument": _truncate(packs.central_argument, 150) if packs.central_argument else "",
        },
    }

    result.stages_completed.append("build_packs")
    yield {
        "type": "stage_complete",
        "stage": 7,
        "stage_name": "build_packs",
        "message": f"Built {len(packs.section_packs)} section packs ({_elapsed_label(stage7_start)})",
        "detail": {
            "sections_packed": len(packs.section_packs),
            "central_argument": packs.central_argument[:100] if packs.central_argument else "",
        },
    }

    # ── Done ─────────────────────────────────────────────────────────────────
    total_time = _elapsed_label(pipeline_start)
    yield {
        "type": "complete",
        "stages_completed": result.stages_completed,
        "message": f"Deep synthesis complete in {total_time}",
        "summary": {
            "normalized_claims": len(result.normalized_claims),
            "clusters": len(result.claim_clusters),
            "theories": len(result.theory_map),
            "sections_packed": len(result.manuscript_packs.section_packs),
            "auto_fetched": (
                result.auto_fetch_result.papers_summarized
                if result.auto_fetch_result else 0
            ),
            "total_time": total_time,
        },
        "result": result.model_dump(),
    }
