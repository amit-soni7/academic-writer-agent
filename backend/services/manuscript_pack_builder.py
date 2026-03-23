"""
services/manuscript_pack_builder.py

Builds section-oriented evidence packs from SynthesisResult + PaperSummary data.
These packs bridge the gap between cross-paper synthesis and the article builder,
ensuring that the manuscript is grounded in structured evidence rather than
raw summaries.

Public API
----------
build_manuscript_packs(provider, synthesis, summaries, article_type, sections, query)
    → ManuscriptPack
"""

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from models import (
    ManuscriptPack,
    PaperSummary,
    SectionPack,
    SynthesisResult,
    ThemeCluster,
)
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# Map manuscript section names to sentence_bank use_in values
_SECTION_ALIASES: dict[str, list[str]] = {
    "introduction": ["introduction", "background"],
    "methods":      ["methods"],
    "results":      ["results"],
    "discussion":   ["discussion", "conclusion"],
}

# Purpose ordering within each section (rhetorical flow)
_PURPOSE_ORDER: dict[str, list[str]] = {
    "introduction": [
        "background", "prevalence_epidemiology", "theory",
        "empirical_support", "identify_gap", "justify_study",
        "original_source", "support_claim",
    ],
    "methods": [
        "methodology", "original_source", "empirical_support", "support_claim",
    ],
    "results": [
        "empirical_support", "support_claim",
    ],
    "discussion": [
        "compare_findings", "theory", "original_source",
        "empirical_support", "identify_gap", "support_claim",
    ],
}

_PURPOSE_ABBREV: dict[str, str] = {
    "background": "BKG",
    "prevalence_epidemiology": "PREV",
    "theory": "THRY",
    "identify_gap": "GAP",
    "justify_study": "JUST",
    "methodology": "METH",
    "original_source": "ORIG",
    "compare_findings": "CMP",
    "empirical_support": "EMP",
    "support_claim": "SUP",
}


def _normalise_section(section_name: str) -> str:
    """Map a section header to one of the canonical section keys."""
    lower = section_name.lower().strip()
    for canon, aliases in _SECTION_ALIASES.items():
        for alias in aliases:
            if alias in lower:
                return canon
    # Fallback: check common patterns
    if "abstract" in lower:
        return "introduction"  # abstract sentences go to intro pack
    if "future" in lower or "implication" in lower:
        return "discussion"
    return "discussion"  # default bucket


def _group_sentences_by_section(
    summaries: list[PaperSummary],
) -> dict[str, list[dict[str, Any]]]:
    """Group all sentence_bank entries across papers by target manuscript section."""
    by_section: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for s in summaries:
        for sent in s.sentence_bank:
            section = _normalise_section(sent.use_in or sent.section or "discussion")
            by_section[section].append({
                "paper_key": s.paper_key,
                "text": sent.text,
                "verbatim_quote": sent.verbatim_quote,
                "primary_purpose": sent.primary_purpose,
                "secondary_purposes": sent.secondary_purposes,
                "claim_type": sent.claim_type,
                "stats": sent.stats,
                "importance": sent.importance,
                "evidence_type": sent.evidence_type,
                "is_seminal": sent.is_seminal,
                "compare_sentiment": sent.compare_sentiment,
            })
    return dict(by_section)


def _cluster_by_purpose(
    sentences: list[dict[str, Any]],
    section: str,
) -> list[ThemeCluster]:
    """Group sentences within a section by their primary citation purpose."""
    purpose_order = _PURPOSE_ORDER.get(section, list(_PURPOSE_ABBREV.keys()))
    by_purpose: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for sent in sentences:
        purpose = sent.get("primary_purpose", "support_claim") or "support_claim"
        by_purpose[purpose].append(sent)

    clusters: list[ThemeCluster] = []
    seen_purposes: set[str] = set()

    # First add purposes in rhetorical order
    for purpose in purpose_order:
        if purpose in by_purpose:
            seen_purposes.add(purpose)
            sents = by_purpose[purpose]
            paper_keys = sorted(set(s["paper_key"] for s in sents))
            abbrev = _PURPOSE_ABBREV.get(purpose, purpose.upper()[:3])
            clusters.append(ThemeCluster(
                theme_label=f"[{abbrev}] {purpose.replace('_', ' ').title()}",
                paper_keys=paper_keys,
                sentences=sents,
            ))

    # Then any remaining purposes not in the order list
    for purpose, sents in by_purpose.items():
        if purpose not in seen_purposes:
            paper_keys = sorted(set(s["paper_key"] for s in sents))
            clusters.append(ThemeCluster(
                theme_label=purpose.replace("_", " ").title(),
                paper_keys=paper_keys,
                sentences=sents,
            ))

    return clusters


def _attach_evidence(
    clusters: list[ThemeCluster],
    synthesis: SynthesisResult,
    section: str,
) -> None:
    """Attach relevant evidence_matrix claims, contradictions, and gaps to clusters."""
    # Build a quick lookup of which paper_keys appear in each cluster
    for cluster in clusters:
        cluster_keys = set(cluster.paper_keys)

        # Attach evidence claims that involve any of this cluster's papers
        for ec in synthesis.evidence_matrix:
            overlap = cluster_keys & (set(ec.supporting_papers) | set(ec.contradicting_papers))
            if overlap:
                cluster.evidence_claims.append({
                    "claim": ec.claim,
                    "supporting": ec.supporting_papers,
                    "contradicting": ec.contradicting_papers,
                    "strength": ec.strength_score,
                    "consistency": ec.consistency,
                })

        # Attach contradictions
        for c in synthesis.contradictions:
            overlap = cluster_keys & (set(c.papers_a) | set(c.papers_b))
            if overlap:
                cluster.contradictions.append({
                    "topic": c.topic,
                    "papers_a": c.papers_a,
                    "papers_b": c.papers_b,
                    "finding_a": c.finding_a,
                    "finding_b": c.finding_b,
                    "likely_reason": c.likely_reason,
                })

    # Attach gaps to the discussion section clusters
    if section == "discussion" and clusters and synthesis.gaps:
        clusters[-1].gaps = list(synthesis.gaps)


_NARRATIVE_ARC_SYSTEM = """\
You are an academic writing strategist. Given a set of evidence themes for a manuscript \
section, produce a concise narrative arc — a 1-3 sentence guide describing the rhetorical \
flow the author should follow when drafting this section.

Output ONLY the narrative arc text. No JSON, no bullet points, no preamble."""

_NARRATIVE_ARC_USER = """\
Manuscript section: {section}
Article type: {article_type}
Research question: {query}

Evidence themes in this section:
{themes_summary}

Write a narrative arc (1-3 sentences) describing the optimal rhetorical flow for this section."""


async def _generate_narrative_arc(
    provider: AIProvider,
    section: str,
    clusters: list[ThemeCluster],
    article_type: str,
    query: str,
) -> str:
    """Generate a narrative arc for one section via LLM."""
    if not clusters:
        return ""

    themes_lines = []
    for c in clusters:
        n_papers = len(c.paper_keys)
        n_sents = len(c.sentences)
        themes_lines.append(
            f"- {c.theme_label}: {n_papers} papers, {n_sents} citable sentences"
        )
        # Add first 2 sentence texts as examples
        for sent in c.sentences[:2]:
            themes_lines.append(f"    \"{sent.get('text', '')[:120]}...\"")

    user_prompt = _NARRATIVE_ARC_USER.format(
        section=section.title(),
        article_type=article_type.replace("_", " ").title(),
        query=query,
        themes_summary="\n".join(themes_lines),
    )

    try:
        arc = await provider.complete(
            system=_NARRATIVE_ARC_SYSTEM,
            user=user_prompt,
            temperature=0.3,
        )
        return arc.strip()
    except Exception as e:
        logger.warning("Narrative arc generation failed for %s: %s", section, e)
        return ""


async def build_manuscript_packs(
    provider: AIProvider,
    synthesis: SynthesisResult,
    summaries: list[PaperSummary],
    article_type: str,
    sections: list[str],
    query: str,
) -> ManuscriptPack:
    """
    Build section-oriented evidence packs from synthesis output + paper summaries.

    Steps:
    1. Group all sentence_bank entries by target manuscript section
    2. Within each section, cluster by primary citation purpose
    3. Attach relevant evidence_matrix claims, contradictions, gaps
    4. Generate narrative arc per section (parallelized LLM calls)
    5. Assemble into ManuscriptPack

    Returns ManuscriptPack with section_packs, central_argument, evidence_strength_summary.
    """
    if not summaries:
        return ManuscriptPack()

    # Step 1: Group sentences by section
    sentences_by_section = _group_sentences_by_section(summaries)

    # Determine canonical sections from the section list
    canonical_sections = set()
    for sec in sections:
        canon = _normalise_section(sec)
        canonical_sections.add(canon)
    # Always include the big 4 if we have any content
    for default_sec in ["introduction", "methods", "results", "discussion"]:
        if default_sec in sentences_by_section:
            canonical_sections.add(default_sec)

    # Step 2-3: Cluster and attach evidence per section
    section_packs: dict[str, SectionPack] = {}
    arc_tasks = []

    for section in sorted(canonical_sections):
        sents = sentences_by_section.get(section, [])
        clusters = _cluster_by_purpose(sents, section)
        _attach_evidence(clusters, synthesis, section)

        # Collect all paper_keys used in this section
        all_keys = sorted(set(
            key for c in clusters for key in c.paper_keys
        ))

        section_packs[section] = SectionPack(
            section_name=section,
            theme_clusters=clusters,
            key_citations=all_keys,
        )

        # Prepare narrative arc generation task
        arc_tasks.append((section, clusters))

    # Step 4: Generate narrative arcs in parallel
    if arc_tasks and provider:
        arc_coros = [
            _generate_narrative_arc(provider, sec, clusters, article_type, query)
            for sec, clusters in arc_tasks
        ]
        arcs = await asyncio.gather(*arc_coros, return_exceptions=True)
        for (sec, _), arc in zip(arc_tasks, arcs):
            if isinstance(arc, str) and arc:
                section_packs[sec].narrative_arc = arc

    # Step 5: Build central argument from evidence matrix
    central_argument = ""
    if synthesis.evidence_matrix:
        # Use the strongest claim as the central argument seed
        strongest = max(synthesis.evidence_matrix, key=lambda e: e.strength_score)
        central_argument = strongest.claim

    # Evidence strength summary
    if synthesis.evidence_matrix:
        high = sum(1 for e in synthesis.evidence_matrix if e.strength_score >= 0.7)
        mod = sum(1 for e in synthesis.evidence_matrix if 0.4 <= e.strength_score < 0.7)
        low = sum(1 for e in synthesis.evidence_matrix if e.strength_score < 0.4)
        strength_summary = (
            f"{len(synthesis.evidence_matrix)} evidence claims: "
            f"{high} strong, {mod} moderate, {low} weak. "
            f"{len(synthesis.contradictions)} contradictions identified. "
            f"{len(synthesis.gaps)} gaps noted."
        )
    else:
        strength_summary = "No structured evidence available."

    return ManuscriptPack(
        section_packs=section_packs,
        central_argument=central_argument,
        evidence_strength_summary=strength_summary,
    )
