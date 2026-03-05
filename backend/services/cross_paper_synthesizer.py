"""
cross_paper_synthesizer.py

Synthesises evidence across multiple extracted PaperSummary objects.

Produces:
  1. Evidence Matrix — claims mapped to supporting / contradicting papers
  2. Methods Comparison — sample, tools, outcomes, stats, risk of bias per paper
  3. Contradictions Log — where papers disagree and likely reasons
  4. Gaps List — what is still unknown after the corpus
  5. Fact Bank — citation-ready facts backed by verbatim quotes only

Rules enforced via system prompt:
  - No narrative claims without mapped evidence.
  - All syntheses labelled "inference" unless directly reported.
  - No fabrication of data not present in the extracted summaries.
"""

import json
import logging
from typing import Any

from models import (
    Contradiction,
    EvidenceClaim,
    FactBankEntry,
    MethodsComparisonRow,
    PaperSummary,
    SynthesisResult,
)
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

_SYSTEM = """\
You are a systematic-review methodologist performing cross-paper evidence synthesis.

RULES — violating any is a critical failure:
1. No narrative claims without explicitly mapped evidence from the provided summaries.
2. Label all synthesised statements as "inference" unless they are directly reported facts.
3. Never invent effect sizes, statistics, or quotes not present in the provided data.
4. Every fact_bank entry must include a verbatim_quote from the paper that reports it.
5. Output ONLY valid JSON matching the exact schema below. No prose outside the JSON.
"""

_USER_TMPL = """\
Research question: {query}

You are given {n} structured paper extractions. Each has: paper_key, study_design,
sample_n, primary_outcomes, results (with effect sizes and verbatim quotes),
limitations, evidence_grade, and one_line_takeaway.

--- BEGIN EXTRACTIONS ---
{summaries_json}
--- END EXTRACTIONS ---

Create a cross-paper synthesis. Return a SINGLE JSON object:

{{
  "evidence_matrix": [
    {{
      "claim": "A specific empirical claim that emerges across multiple papers",
      "supporting_papers": ["paper_key_1", "paper_key_2"],
      "contradicting_papers": ["paper_key_3"],
      "study_designs": ["RCT", "cohort"],
      "strength_score": 0.75,
      "consistency": "moderate"
    }}
  ],

  "methods_comparison": [
    {{
      "paper_key": "paper_key_1",
      "sample_n": "N=245",
      "tools": ["PHQ-9", "GAD-7"],
      "outcomes": ["depression remission", "anxiety reduction"],
      "stats": ["ANCOVA", "ITT analysis"],
      "risk_of_bias": "Low — preregistered RCT with allocation concealment"
    }}
  ],

  "contradictions": [
    {{
      "topic": "Effect of X on Y",
      "papers_a": ["key1"],
      "papers_b": ["key2"],
      "finding_a": "X significantly reduces Y (d=0.52, p<0.001)",
      "finding_b": "X shows no effect on Y (d=0.08, p=0.61)",
      "likely_reason": "Difference in population severity — key1 used clinical samples, key2 subclinical"
    }}
  ],

  "gaps": [
    "Long-term follow-up beyond 12 months is absent from all included studies",
    "No studies examined this intervention in low-income country settings"
  ],

  "fact_bank": [
    {{
      "fact": "CBT reduced PHQ-9 scores by a mean of 4.2 points (95% CI [2.8, 5.6])",
      "paper_key": "paper_key_1",
      "verbatim_quote": "CBT participants showed a mean reduction of 4.2 points on the PHQ-9 (95% CI: 2.8 to 5.6, p<0.001)",
      "claim_type": "reported_fact"
    }}
  ]
}}

Generate between 5-15 evidence matrix entries, covering all major themes.
Include ALL papers in the methods_comparison table.
Surface ALL meaningful contradictions you find.
Generate at least 5 gaps.
Generate 10-20 fact bank entries — only facts directly stated in the text with verbatim quotes.
"""


def _compact_summary(s: PaperSummary) -> dict[str, Any]:
    """Convert a full PaperSummary into a compact dict for the prompt."""
    compact: dict[str, Any] = {
        "paper_key": s.paper_key,
        "triage_category": s.triage.category,
        "study_design": s.methods.study_design,
        "setting": s.methods.setting,
        "sample_n": s.methods.sample_n,
        "primary_outcomes": s.methods.primary_outcomes,
        "statistical_methods": s.methods.statistical_methods,
        "results": [
            {
                "outcome":    r.outcome,
                "finding":    r.finding,
                "effect_size": r.effect_size,
                "ci_95":      r.ci_95,
                "p_value":    r.p_value,
                "quote":      r.supporting_quote,
                "claim_type": r.claim_type,
            }
            for r in s.results
        ],
        "limitations": s.limitations,
        "evidence_grade": s.critical_appraisal.evidence_grade,
        "selection_bias": s.critical_appraisal.selection_bias,
        "methodological_strengths": s.critical_appraisal.methodological_strengths,
        "one_line_takeaway": s.one_line_takeaway,
    }
    # Include sentence bank when present — gives synthesis LLM sentence-level citable data
    if s.sentence_bank:
        compact["sentence_bank"] = [
            {
                "section":    sent.section,
                "text":       sent.text,
                "stats":      sent.stats,
                "claim_type": sent.claim_type,
            }
            for sent in s.sentence_bank
        ]
    return compact


def _parse_evidence_matrix(raw: list) -> list[EvidenceClaim]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        score = item.get("strength_score", 0.5)
        try:
            score = max(0.0, min(1.0, float(score)))
        except (ValueError, TypeError):
            score = 0.5
        consistency = str(item.get("consistency", "unknown")).lower()
        if consistency not in ("high", "moderate", "low", "mixed", "unknown"):
            consistency = "unknown"
        out.append(EvidenceClaim(
            claim=str(item.get("claim", "")).strip(),
            supporting_papers=[str(p) for p in item.get("supporting_papers", [])],
            contradicting_papers=[str(p) for p in item.get("contradicting_papers", [])],
            study_designs=[str(d) for d in item.get("study_designs", [])],
            strength_score=score,
            consistency=consistency,
        ))
    return out


def _parse_methods_comparison(raw: list) -> list[MethodsComparisonRow]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        out.append(MethodsComparisonRow(
            paper_key=str(item.get("paper_key", "")),
            sample_n=str(item.get("sample_n", "NR")),
            tools=[str(t) for t in item.get("tools", [])],
            outcomes=[str(o) for o in item.get("outcomes", [])],
            stats=[str(s) for s in item.get("stats", [])],
            risk_of_bias=str(item.get("risk_of_bias", "NR")),
        ))
    return out


def _parse_contradictions(raw: list) -> list[Contradiction]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        out.append(Contradiction(
            topic=str(item.get("topic", "")),
            papers_a=[str(p) for p in item.get("papers_a", [])],
            papers_b=[str(p) for p in item.get("papers_b", [])],
            finding_a=str(item.get("finding_a", "")),
            finding_b=str(item.get("finding_b", "")),
            likely_reason=str(item.get("likely_reason", "")),
        ))
    return out


def _parse_fact_bank(raw: list) -> list[FactBankEntry]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        claim_type = str(item.get("claim_type", "reported_fact"))
        if claim_type not in ("reported_fact", "author_interpretation"):
            claim_type = "reported_fact"
        out.append(FactBankEntry(
            fact=str(item.get("fact", "")),
            paper_key=str(item.get("paper_key", "")),
            verbatim_quote=str(item.get("verbatim_quote", "")),
            claim_type=claim_type,
        ))
    return out


async def synthesize(
    provider: AIProvider,
    summaries: list[PaperSummary],
    query: str,
) -> SynthesisResult:
    """
    Run cross-paper evidence synthesis over a list of extracted PaperSummary objects.
    Returns a structured SynthesisResult.
    """
    if not summaries:
        return SynthesisResult()

    compact = [_compact_summary(s) for s in summaries]
    summaries_json = json.dumps(compact, indent=2)

    user_prompt = _USER_TMPL.format(
        query=query or "general academic research",
        n=len(summaries),
        summaries_json=summaries_json,
    )

    raw = await provider.complete(
        system=_SYSTEM,
        user=user_prompt,
        json_mode=True,
        temperature=0.1,
    )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse synthesis JSON")
            data = {}

    return SynthesisResult(
        evidence_matrix=_parse_evidence_matrix(data.get("evidence_matrix", [])),
        methods_comparison=_parse_methods_comparison(data.get("methods_comparison", [])),
        contradictions=_parse_contradictions(data.get("contradictions", [])),
        gaps=data.get("gaps", []) if isinstance(data.get("gaps"), list) else [],
        fact_bank=_parse_fact_bank(data.get("fact_bank", [])),
    )
