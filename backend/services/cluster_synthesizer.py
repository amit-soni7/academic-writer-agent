"""
services/cluster_synthesizer.py

Stages 5-6 of the deep synthesis pipeline:
  Stage 5 — Within-cluster synthesis with contradiction decomposition
  Stage 6 — Theory detection across papers

Public API
----------
synthesize_clusters(provider, clusters, summaries, query) → list[ClaimCluster]
detect_theories(provider, summaries, query) → list[TheoryReference]
"""

import asyncio
import json
import logging
from typing import Any

from models import (
    ClaimCluster,
    ContradictionDetail,
    PaperSummary,
    TheoryReference,
)
from services.ai_provider import AIProvider
from services.llm_errors import LLMError

logger = logging.getLogger(__name__)

# ── Stage 5: Within-cluster synthesis ─────────────────────────────────────────

_SYNTH_SYSTEM = """\
You are a systematic-review methodologist performing within-cluster \
evidence synthesis with contradiction decomposition.

RULES:
1. Synthesize the claims in each cluster into a coherent evidence summary.
2. When findings conflict, decompose WHY they conflict across dimensions: \
   population | method | measurement | timeframe | context.
3. Propose resolution hypotheses for contradictions.
4. Never fabricate data not present in the claims.
5. Output ONLY valid JSON matching the schema."""

_SYNTH_USER = """\
Research question: {query}

Cluster: "{cluster_label}"
Overall direction: {direction}
Claims in this cluster:
{claims_json}

Synthesize this cluster. Return JSON:
{{
  "synthesis_statement": "Comprehensive synthesis of what the evidence shows",
  "overall_direction": "consistent|mixed|contradictory",
  "strength": 0.75,
  "contradiction_details": [
    {{
      "dimension": "population",
      "description": "Studies in clinical vs. community samples show different effects",
      "papers_a": ["key1"],
      "papers_b": ["key2"],
      "resolution_hypothesis": "Effect may be moderated by baseline severity"
    }}
  ]
}}"""


async def _synthesize_one_cluster(
    provider: AIProvider,
    cluster: ClaimCluster,
    query: str,
) -> ClaimCluster:
    """Synthesize a single cluster with contradiction decomposition."""
    claims_compact = [
        {
            "claim_id": c.claim_id,
            "canonical_text": c.canonical_text,
            "source_paper_keys": c.source_paper_keys,
            "population": c.population,
            "outcome": c.outcome,
            "effect_direction": c.effect_direction,
            "effect_magnitude": c.effect_magnitude,
            "evidence_grade": c.evidence_grade,
        }
        for c in cluster.claims
    ]

    user_prompt = _SYNTH_USER.format(
        query=query,
        cluster_label=cluster.cluster_label,
        direction=cluster.overall_direction,
        claims_json=json.dumps(claims_compact, indent=2),
    )

    try:
        raw = await provider.complete(
            system=_SYNTH_SYSTEM,
            user=user_prompt,
            json_mode=True,
            temperature=0.1,
        )
        data = _parse_json_object(raw)

        cluster.synthesis_statement = str(data.get("synthesis_statement", cluster.synthesis_statement))

        direction = str(data.get("overall_direction", cluster.overall_direction)).lower()
        if direction in ("consistent", "mixed", "contradictory"):
            cluster.overall_direction = direction

        strength = data.get("strength", cluster.strength)
        try:
            cluster.strength = max(0.0, min(1.0, float(strength)))
        except (ValueError, TypeError):
            pass

        # Parse contradiction details
        for cd in data.get("contradiction_details", []):
            if not isinstance(cd, dict):
                continue
            dim = str(cd.get("dimension", "")).lower()
            if dim not in ("population", "method", "measurement", "timeframe", "context"):
                dim = "context"
            cluster.contradiction_details.append(ContradictionDetail(
                dimension=dim,
                description=str(cd.get("description", "")),
                papers_a=[str(p) for p in cd.get("papers_a", [])],
                papers_b=[str(p) for p in cd.get("papers_b", [])],
                resolution_hypothesis=str(cd.get("resolution_hypothesis", "")),
            ))

    except LLMError:
        raise
    except Exception as e:
        logger.warning("Cluster synthesis failed for '%s': %s", cluster.cluster_label, e)

    return cluster


async def synthesize_clusters(
    provider: AIProvider,
    clusters: list[ClaimCluster],
    query: str,
) -> list[ClaimCluster]:
    """Stage 5: Synthesize each cluster in parallel with contradiction decomposition."""
    if not clusters:
        return []

    tasks = [
        _synthesize_one_cluster(provider, cluster, query)
        for cluster in clusters
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    synthesized: list[ClaimCluster] = []
    for r in results:
        if isinstance(r, ClaimCluster):
            synthesized.append(r)
        elif isinstance(r, Exception):
            logger.warning("Cluster synthesis task failed: %s", r)

    return synthesized


# ── Stage 6: Theory detection ─────────────────────────────────────────────────

_THEORY_SYSTEM = """\
You are a systematic-review methodologist identifying theoretical frameworks \
across a corpus of papers.

RULES:
1. Detect theories mentioned in sentence banks with purpose="theory" or "original_source".
2. Map which papers cite each theory as seminal vs. which apply it.
3. Assess support level: strong | moderate | weak | mixed.
4. Only include theories actually mentioned in the data — never fabricate.
5. Output ONLY valid JSON — an array of theory objects."""

_THEORY_USER = """\
Research question: {query}

Theory-related sentences from {n_papers} papers:
{theory_json}

Identify theoretical frameworks. Return JSON array:
[
  {{
    "theory_name": "Social Cognitive Theory (Bandura, 1986)",
    "seminal_paper_keys": ["bandura1986"],
    "applying_paper_keys": ["smith2020", "jones2021"],
    "support_level": "strong",
    "description": "Brief description of how the theory is used in this corpus"
  }}
]"""


async def detect_theories(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
) -> list[TheoryReference]:
    """Stage 6: Scan sentence banks for theory mentions and map across papers."""
    # Collect theory-related sentences
    theory_data: list[dict[str, Any]] = []
    for s in summaries:
        for sent in s.sentence_bank:
            if sent.primary_purpose in ("theory", "original_source") or (
                sent.is_seminal and sent.primary_purpose == "background"
            ):
                theory_data.append({
                    "paper_key": s.paper_key,
                    "text": sent.text,
                    "purpose": sent.primary_purpose,
                    "is_seminal": sent.is_seminal,
                    "evidence_type": sent.evidence_type,
                })

    if not theory_data:
        return []

    paper_keys = set(t["paper_key"] for t in theory_data)
    user_prompt = _THEORY_USER.format(
        query=query or "general academic research",
        n_papers=len(paper_keys),
        theory_json=json.dumps(theory_data, indent=2),
    )

    try:
        raw = await provider.complete(
            system=_THEORY_SYSTEM,
            user=user_prompt,
            json_mode=True,
            temperature=0.1,
        )
        theories_data = _parse_json_array(raw)
    except LLMError:
        raise
    except Exception as e:
        logger.warning("Theory detection failed: %s", e)
        return []

    theories: list[TheoryReference] = []
    for item in theories_data:
        if not isinstance(item, dict):
            continue
        support = str(item.get("support_level", "mixed")).lower()
        if support not in ("strong", "moderate", "weak", "mixed"):
            support = "mixed"
        theories.append(TheoryReference(
            theory_name=str(item.get("theory_name", "")),
            seminal_paper_keys=[str(k) for k in item.get("seminal_paper_keys", [])],
            applying_paper_keys=[str(k) for k in item.get("applying_paper_keys", [])],
            support_level=support,
            description=str(item.get("description", "")),
        ))

    return theories


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_json_object(raw: str) -> dict:
    """Parse LLM output as a JSON object."""
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end])
        except json.JSONDecodeError:
            pass

    logger.warning("Failed to parse JSON object from LLM output")
    return {}


def _parse_json_array(raw: str) -> list[dict]:
    """Parse LLM output as a JSON array."""
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("theories", "theory_map", "results"):
                if isinstance(data.get(key), list):
                    return data[key]
    except json.JSONDecodeError:
        pass

    start = raw.find("[")
    end = raw.rfind("]") + 1
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end])
        except json.JSONDecodeError:
            pass

    return []
