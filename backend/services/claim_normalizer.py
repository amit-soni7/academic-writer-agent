"""
services/claim_normalizer.py

Stages 2-3 of the deep synthesis pipeline:
  Stage 2 — Extract and normalize claims from PaperSummary results into canonical form
  Stage 3 — Cluster semantically equivalent claims

Public API
----------
normalize_claims(provider, summaries, query) → list[NormalizedClaim]
cluster_claims(provider, claims, query) → list[ClaimCluster]
"""

import json
import logging
import uuid
from typing import Any

from models import ClaimCluster, NormalizedClaim, PaperSummary
from services.ai_provider import AIProvider
from services.llm_errors import LLMError

logger = logging.getLogger(__name__)

# ── Stage 1: Evidence object extraction (no LLM) ────────────────────────────

def extract_evidence_objects(summaries: list[PaperSummary]) -> list[dict[str, Any]]:
    """Stage 1: Pull ResultItem + SentenceCitation data into flat evidence objects.

    This is a pure restructuring step — no LLM call needed.
    Each evidence object carries: paper_key, text, stats, claim_type, source_type.
    """
    objects: list[dict[str, Any]] = []

    for s in summaries:
        # From results (structured findings with effect sizes)
        for r in s.results:
            objects.append({
                "paper_key": s.paper_key,
                "text": f"{r.outcome}: {r.finding}".strip(": "),
                "effect_size": r.effect_size,
                "ci_95": r.ci_95,
                "p_value": r.p_value,
                "supporting_quote": r.supporting_quote,
                "claim_type": r.claim_type,
                "source_type": "result",
                "study_design": s.methods.study_design,
                "sample_n": s.methods.sample_n,
                "evidence_grade": s.critical_appraisal.evidence_grade,
            })

        # From sentence_bank (empirical_support and support_claim purposes)
        for sent in s.sentence_bank:
            if sent.primary_purpose in (
                "empirical_support", "support_claim", "compare_findings",
                "prevalence_epidemiology",
            ):
                objects.append({
                    "paper_key": s.paper_key,
                    "text": sent.text,
                    "effect_size": "",
                    "ci_95": "",
                    "p_value": "",
                    "supporting_quote": sent.verbatim_quote,
                    "claim_type": sent.claim_type,
                    "source_type": "sentence_bank",
                    "study_design": s.methods.study_design,
                    "sample_n": s.methods.sample_n,
                    "evidence_grade": s.critical_appraisal.evidence_grade,
                    "primary_purpose": sent.primary_purpose,
                    "compare_sentiment": sent.compare_sentiment,
                })

        # From introduction_claims (background facts)
        for ic in s.introduction_claims:
            objects.append({
                "paper_key": s.paper_key,
                "text": ic.claim,
                "effect_size": "",
                "ci_95": "",
                "p_value": "",
                "supporting_quote": ic.verbatim_quote,
                "claim_type": ic.claim_type,
                "source_type": "introduction_claim",
                "study_design": s.methods.study_design,
                "sample_n": "",
                "evidence_grade": "",
            })

    return objects


# ── Stage 2: Normalize claims (LLM) ─────────────────────────────────────────

_NORMALIZE_SYSTEM = """\
You are a systematic-review methodologist. Given a batch of raw evidence \
objects extracted from academic papers, normalize each into a canonical \
claim with structured metadata.

RULES:
1. Merge evidence objects that describe the SAME finding into ONE normalized claim.
2. Each normalized claim must have: canonical_text, population, outcome, \
   effect_direction (positive|negative|null|mixed), effect_magnitude, evidence_grade.
3. Keep verbatim_quotes from all contributing papers.
4. Do NOT fabricate data not present in the input.
5. Output ONLY valid JSON — an array of normalized claim objects."""

_NORMALIZE_USER = """\
Research question: {query}

Raw evidence objects ({n} items from {n_papers} papers):
{evidence_json}

Normalize these into canonical claims. Merge duplicates. Return JSON array:
[
  {{
    "canonical_text": "Clear statement of the claim",
    "source_paper_keys": ["key1", "key2"],
    "population": "adults aged 18-65",
    "outcome": "depression severity",
    "effect_direction": "negative",
    "effect_magnitude": "d=0.52 [0.31, 0.73]",
    "evidence_grade": "Moderate",
    "verbatim_quotes": ["exact quote from paper 1", "exact quote from paper 2"]
  }}
]"""


async def normalize_claims(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
) -> list[NormalizedClaim]:
    """Stage 2: Normalize raw evidence into canonical claims via batched LLM calls."""
    evidence_objects = extract_evidence_objects(summaries)
    if not evidence_objects:
        return []

    # Batch into chunks of ~40 to stay within context limits
    BATCH_SIZE = 40
    all_claims: list[NormalizedClaim] = []

    for batch_start in range(0, len(evidence_objects), BATCH_SIZE):
        batch = evidence_objects[batch_start:batch_start + BATCH_SIZE]
        paper_keys = set(e["paper_key"] for e in batch)

        user_prompt = _NORMALIZE_USER.format(
            query=query or "general academic research",
            n=len(batch),
            n_papers=len(paper_keys),
            evidence_json=json.dumps(batch, indent=2),
        )

        try:
            raw = await provider.complete(
                system=_NORMALIZE_SYSTEM,
                user=user_prompt,
                json_mode=True,
                temperature=0.1,
            )
            claims_data = _parse_json_array(raw)
            for item in claims_data:
                all_claims.append(NormalizedClaim(
                    claim_id=f"NC-{uuid.uuid4().hex[:8]}",
                    canonical_text=str(item.get("canonical_text", "")),
                    source_paper_keys=[str(k) for k in item.get("source_paper_keys", [])],
                    population=str(item.get("population", "")),
                    outcome=str(item.get("outcome", "")),
                    effect_direction=_validate_direction(item.get("effect_direction", "")),
                    effect_magnitude=str(item.get("effect_magnitude", "")),
                    evidence_grade=str(item.get("evidence_grade", "")),
                    verbatim_quotes=[str(q) for q in item.get("verbatim_quotes", [])],
                ))
        except LLMError:
            raise  # let orchestrator handle with fallback
        except Exception as e:
            logger.warning("Claim normalization batch failed: %s", e)

    return all_claims


# ── Stage 4: Cluster claims (LLM) ────────────────────────────────────────────

_CLUSTER_SYSTEM = """\
You are a systematic-review methodologist. Given a list of normalized \
evidence claims, group them into thematic clusters.

RULES:
1. Each cluster groups claims about the SAME topic/relationship.
2. Assign a descriptive cluster_label (e.g. "Dating app use and psychosocial wellbeing").
3. Determine overall_direction: consistent | mixed | contradictory.
4. Assign a strength score (0.0-1.0) based on evidence volume and consistency.
5. Output ONLY valid JSON — an array of cluster objects."""

_CLUSTER_USER = """\
Research question: {query}

Normalized claims ({n} claims):
{claims_json}

Group into thematic clusters. Return JSON array:
[
  {{
    "cluster_label": "Descriptive label for this evidence theme",
    "claim_ids": ["NC-abc123", "NC-def456"],
    "overall_direction": "consistent",
    "strength": 0.75,
    "synthesis_statement": "Brief synthesis of what the evidence shows"
  }}
]"""


async def cluster_claims(
    provider: AIProvider,
    claims: list[NormalizedClaim],
    query: str,
) -> list[ClaimCluster]:
    """Stage 4: Group normalized claims into thematic clusters."""
    if not claims:
        return []

    # Build compact claim data for the LLM
    claims_compact = [
        {
            "claim_id": c.claim_id,
            "canonical_text": c.canonical_text,
            "source_paper_keys": c.source_paper_keys,
            "effect_direction": c.effect_direction,
            "evidence_grade": c.evidence_grade,
        }
        for c in claims
    ]

    user_prompt = _CLUSTER_USER.format(
        query=query or "general academic research",
        n=len(claims),
        claims_json=json.dumps(claims_compact, indent=2),
    )

    try:
        raw = await provider.complete(
            system=_CLUSTER_SYSTEM,
            user=user_prompt,
            json_mode=True,
            temperature=0.1,
        )
        clusters_data = _parse_json_array(raw)
    except LLMError:
        raise
    except Exception as e:
        logger.warning("Claim clustering failed: %s", e)
        return []

    # Build claim lookup
    claim_by_id = {c.claim_id: c for c in claims}

    clusters: list[ClaimCluster] = []
    for item in clusters_data:
        claim_ids = item.get("claim_ids", [])
        cluster_claims_list = [
            claim_by_id[cid] for cid in claim_ids if cid in claim_by_id
        ]
        if not cluster_claims_list:
            continue

        strength = item.get("strength", 0.5)
        try:
            strength = max(0.0, min(1.0, float(strength)))
        except (ValueError, TypeError):
            strength = 0.5

        direction = str(item.get("overall_direction", "mixed")).lower()
        if direction not in ("consistent", "mixed", "contradictory"):
            direction = "mixed"

        clusters.append(ClaimCluster(
            cluster_id=f"CC-{uuid.uuid4().hex[:8]}",
            cluster_label=str(item.get("cluster_label", "Unnamed cluster")),
            claims=cluster_claims_list,
            synthesis_statement=str(item.get("synthesis_statement", "")),
            overall_direction=direction,
            strength=strength,
        ))

    return clusters


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_json_array(raw: str) -> list[dict]:
    """Parse LLM output as a JSON array, with fallback extraction."""
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            # Sometimes LLM wraps in {"claims": [...]} or {"clusters": [...]}
            for key in ("claims", "clusters", "normalized_claims", "results"):
                if isinstance(data.get(key), list):
                    return data[key]
            return [data]
    except json.JSONDecodeError:
        pass

    # Fallback: extract array from response
    start = raw.find("[")
    end = raw.rfind("]") + 1
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end])
        except json.JSONDecodeError:
            pass

    logger.warning("Failed to parse JSON array from LLM output")
    return []


def _validate_direction(val: Any) -> str:
    """Validate effect_direction value."""
    s = str(val).lower().strip()
    if s in ("positive", "negative", "null", "mixed"):
        return s
    return "mixed"
