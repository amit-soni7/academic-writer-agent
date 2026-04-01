"""
peer_reviewer.py

Generates a rigorous, role-conditioned peer-review report with:
  - Dynamic reviewer specialization matched to manuscript topic
  - Structured rubric scoring (10 dimensions, 1–5)
  - Evidence-anchored concerns with problem types and satisfaction criteria
  - Claims audit (overclaiming, under-support, imprecision)
  - Section-by-section assessment with revision advice
  - Revision priority ranking
  - Editor-facing decision note

Each concern includes:
  - severity: high | medium
  - problem_type: conceptual | evidentiary | methodological | structural | rhetorical | journal_fit
  - location: section + line range
  - confidence: high | medium | low
  - satisfaction_criterion: what would count as an adequate fix
  - resolvable: whether the concern is likely fixable in revision
"""

import json
import logging
from typing import TYPE_CHECKING

from models import (
    ClaimAuditItem,
    PeerReviewReport,
    ReviewConcern,
    RubricScore,
    SectionAssessment,
)
from services.manuscript_utils import (
    build_compact_evidence,
    build_full_manuscript_context,
    build_section_index,
)

if TYPE_CHECKING:
    from models import PaperSummary
    from services.ai_provider import AIProvider
    from services.journal_style_service import JournalStyle

logger = logging.getLogger(__name__)


# ── Article-type evaluation guidance ─────────────────────────────────────────

_ARTICLE_TYPE_GUIDANCE: dict[str, str] = {
    "opinion": (
        "This is an opinion/perspective article. Evaluate accordingly:\n"
        "- Emphasize conceptual precision, fairness to opposing positions, accurate use of examples,\n"
        "  restraint in claims, adequacy of historical framing, and practicality of recommendations.\n"
        "- Do NOT demand empirical proof that is impossible for this article type.\n"
        "- Do NOT request excessive citation padding or impose rigid IMRAD expectations.\n"
        "- DO require accurate use of evidence and disciplined claims."
    ),
    "editorial": (
        "This is an editorial. Evaluate for clarity of argument, appropriateness of scope,\n"
        "fairness in presenting evidence, and whether the editorial voice is appropriate."
    ),
    "letter": (
        "This is a letter/correspondence. Evaluate for conciseness, accuracy of claims,\n"
        "and whether it makes a clear, well-supported point within its constrained format."
    ),
    "short_communication": (
        "This is a short communication. Evaluate for clarity, conciseness,\n"
        "and whether the key finding is adequately supported within the word limit."
    ),
    "case_report": (
        "This is a case report. Evaluate against CARE guidelines: completeness of clinical\n"
        "timeline, diagnostic assessment, therapeutic intervention, outcomes, and patient perspective."
    ),
    "systematic_review": (
        "This is a systematic review. Evaluate against PRISMA 2020: search strategy completeness,\n"
        "inclusion/exclusion criteria, risk of bias assessment, data synthesis, and GRADE certainty."
    ),
    "meta_analysis": (
        "This is a meta-analysis. Evaluate statistical methodology: effect measure choice,\n"
        "pooling model, heterogeneity assessment (I²), publication bias, sensitivity analyses."
    ),
}

# Default for empirical / review types
_DEFAULT_ARTICLE_GUIDANCE = (
    "Evaluate the manuscript according to what this article type can reasonably achieve.\n"
    "Do not judge an opinion paper as though it were an empirical trial, but do require\n"
    "accurate use of evidence and disciplined claims."
)


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM = """\
You are conducting a top-tier scholarly peer review for a journal-quality manuscript.

Your task is not to merely summarize. Your task is to determine whether this manuscript
is persuasive, adequately supported, appropriately framed for the article type, and
genuinely improved by your feedback.

Review principles:
- Be fair, specific, constructive, and scientifically demanding.
- Distinguish clearly between evidentiary problems, conceptual problems, structural problems,
  rhetoric/overclaiming, and journal-fit issues.
- Do not request citations or revisions unless you can explain why they are needed.
- Avoid vague comments. Every substantial concern must be tied to a specific section
  and paragraph, with the exact problematic text quoted verbatim in "quoted_passage".
- For each criticism, state what would count as an adequate revision (satisfaction_criterion).
- Preserve strong writing where it is already strong; do not suggest unnecessary weakening.
- Calibrate the recommendation conservatively: reject only for major non-remediable problems;
  otherwise distinguish major vs minor revision based on what is required for publishability.
- Do not merely restate the manuscript.
- Do not inflate criticism.
- Do not ask for additional literature unless it would materially improve validity or context.
- Be willing to say that a claim should be softened rather than burdening the manuscript
  with unnecessary citations.
- Prefer precise, discriminating critique over generic "add more detail" language.

Evidence policy — for each concern, determine the correct fix type:
- "needs_citation" — only if a specific factual claim lacks support
- "needs_qualification" — the claim is too strong for the evidence
- "needs_definition" — a core term is used without adequate definition
- "needs_scope_narrowing" — the claim applies more broadly than the evidence supports
- "needs_counterargument" — a relevant opposing view is ignored
- "needs_restructuring" — the organization hinders comprehension

Return ONLY valid JSON. No markdown fences, no prose outside the JSON.
"""


# ── User prompt template ──────────────────────────────────────────────────────

_USER_TMPL = """\
Research topic: {query}
Article type: {article_type}
{journal_context}
{methodology_notes}
{article_type_guidance}

{manuscript_context}

Evidence extraction corpus ({n} papers, IDs are globally unique as {{paper_key}}::result_{{i}}):
--- BEGIN EVIDENCE ---
{evidence_json}
--- END EVIDENCE ---

{evidence_packs}

STEP 1: Adopt the stance of a domain expert. First, infer and state your reviewer expertise
based on the manuscript topic. Your expertise panel should include 4-5 highly specific
specializations (not generic labels like "subject expert").

STEP 2: Score the manuscript on the following rubric (1-5 each):
1. Originality/contribution
2. Conceptual clarity
3. Accuracy of framing
4. Support for claims
5. Argument coherence
6. Use of evidence/examples
7. Definition of core terms
8. Calibration of conclusions
9. Suitability for article type
10. Journal/publisher readiness

STEP 3: Conduct the full review.

Return a SINGLE JSON object:

{{
  "reviewer_expertise": [
    "specific expertise domain 1 (e.g., adversarial collaboration and theory adjudication)",
    "specific expertise domain 2",
    "specific expertise domain 3",
    "specific expertise domain 4"
  ],

  "rubric_scores": [
    {{
      "dimension": "Originality/contribution",
      "score": 4,
      "rationale": "Brief justification for this score"
    }}
  ],

  "manuscript_summary": "2-3 sentence summary of the manuscript's thesis, contribution, and article type (120-180 words)",

  "strengths": [
    "Specific strength 1 naming the relevant manuscript section and explaining why it strengthens publishability",
    "Specific strength 2"
  ],

  "section_assessments": [
    {{
      "section": "Introduction",
      "rating": "strong | adequate | weak | missing",
      "strengths": ["What this section does well"],
      "weaknesses": ["What needs improvement — quote the problematic text"],
      "suggestions": ["Actionable suggestion referencing the specific text"],
      "revision_advice": "Exact revision advice for this section"
    }}
  ],

  "major_concerns": [
    {{
      "concern": "Specific concern title",
      "severity": "high | medium",
      "problem_type": "conceptual | evidentiary | methodological | structural | rhetorical | journal_fit",
      "basis": "manuscript_only | evidence_only | both",
      "location": "Section name, paragraph N",
      "quoted_passage": "Copy 50-150 characters of the EXACT problematic text verbatim from the manuscript. This must be character-for-character accurate — it will be used for exact string matching during revision.",
      "confidence": "high | medium | low",
      "evidence_ids": ["paper_key::result_0"],
      "paper_ids": ["paper_key"],
      "scientific_importance": "Why this matters — consequences of not addressing it",
      "revision_request": "Exact actionable revision: what the authors must do",
      "resolvable": true,
      "satisfaction_criterion": "This concern would be adequately addressed if the manuscript..."
    }}
  ],

  "minor_concerns": [
    {{
      "concern": "Minor concern with specific location and concrete suggestion",
      "severity": "medium",
      "problem_type": "conceptual | evidentiary | methodological | structural | rhetorical | journal_fit",
      "basis": "manuscript_only | evidence_only | both",
      "location": "Section name, paragraph N",
      "quoted_passage": "Copy 50-150 characters of the EXACT problematic text verbatim from the manuscript.",
      "confidence": "high | medium | low",
      "evidence_ids": [],
      "paper_ids": [],
      "scientific_importance": "Why this matters for reproducibility or clarity",
      "revision_request": "Specific minor revision requested",
      "resolvable": true,
      "satisfaction_criterion": "This concern would be adequately addressed if..."
    }}
  ],

  "claims_audit": [
    {{
      "claim": "Quoted or paraphrased claim from the manuscript",
      "location": "Section, paragraph N",
      "problem": "overgeneralized | under-supported | imprecise | historically under-specified | overclaimed",
      "fix": "supported | narrowed | rephrased | defined | removed",
      "explanation": "Why this fix is appropriate and what it should look like"
    }}
  ],

  "revision_priorities": [
    "1. Most important revision that would most improve the manuscript",
    "2. Second most important",
    "3. Third",
    "4. Fourth",
    "5. Fifth"
  ],

  "required_revisions": [
    "1. [Numbered actionable revision derived from major concerns]"
  ],

  "decision": "accept | minor_revision | major_revision | reject",

  "decision_rationale": "2-3 sentences explaining the decision based on the evidence quality, concerns, and the manuscript's contribution.",

  "editor_note": "Concise editor-facing note (2-3 sentences) explaining why this recommendation was reached, what the key strengths are, and what must change for publishability."
}}

IMPORTANT:
- The decision must follow logically from both the rubric scores AND the concerns.
- Return only substantiated concerns. A strong manuscript may have 0 major concerns.
- Assess EVERY section listed in the manuscript structure above.
- Every major concern MUST include a satisfaction_criterion.
- The claims_audit should identify 0-10 claims depending on manuscript quality.
- Do NOT pad with generic criticism or inflate the number of concerns.
"""


# ── Parsing helpers ───────────────────────────────────────────────────────────

def _parse_concerns(raw: list) -> list[ReviewConcern]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        out.append(ReviewConcern(
            concern=str(item.get("concern", "")),
            basis=str(item.get("basis", "both")),
            location=str(item.get("location", "")),
            quoted_passage=str(item.get("quoted_passage", "")),
            confidence=str(item.get("confidence", "high")),
            evidence_ids=[str(x) for x in item.get("evidence_ids", [])],
            paper_ids=[str(x) for x in item.get("paper_ids", [])],
            scientific_importance=str(item.get("scientific_importance", "")),
            revision_request=str(item.get("revision_request", "")),
            severity=str(item.get("severity", "high")),
            problem_type=str(item.get("problem_type", "")),
            resolvable=bool(item.get("resolvable", True)),
            satisfaction_criterion=str(item.get("satisfaction_criterion", "")),
        ))
    return out


def _parse_section_assessments(raw: list) -> list[SectionAssessment]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        rating = str(item.get("rating", "adequate")).lower()
        if rating not in ("strong", "adequate", "weak", "missing"):
            rating = "adequate"
        out.append(SectionAssessment(
            section=str(item.get("section", "")),
            rating=rating,
            strengths=[str(s) for s in item.get("strengths", []) if s],
            weaknesses=[str(s) for s in item.get("weaknesses", []) if s],
            suggestions=[str(s) for s in item.get("suggestions", []) if s],
            revision_advice=str(item.get("revision_advice", "")),
        ))
    return out


def _parse_rubric(raw: list) -> list[RubricScore]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        score = item.get("score", 3)
        try:
            score = int(score)
        except (ValueError, TypeError):
            score = 3
        score = max(1, min(5, score))
        out.append(RubricScore(
            dimension=str(item.get("dimension", "")),
            score=score,
            rationale=str(item.get("rationale", "")),
        ))
    return out


def _parse_claims_audit(raw: list) -> list[ClaimAuditItem]:
    out = []
    for item in (raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        out.append(ClaimAuditItem(
            claim=str(item.get("claim", "")),
            location=str(item.get("location", "")),
            problem=str(item.get("problem", "")),
            fix=str(item.get("fix", "")),
            explanation=str(item.get("explanation", "")),
        ))
    return out


# ── Main function ─────────────────────────────────────────────────────────────

async def generate_peer_review(
    provider: "AIProvider",
    summaries: list["PaperSummary"],
    query: str,
    article: str,
    *,
    article_type: str = "review",
    journal_style: "JournalStyle | None" = None,
    manuscript_packs: dict | None = None,
) -> PeerReviewReport:
    """
    Generate a peer-review report with role-conditioning, rubric scoring,
    claims audit, and satisfaction criteria for each concern.
    """
    # ── Build manuscript context with line numbers and section index ──────
    section_index = build_section_index(article) if article else []
    manuscript_context = build_full_manuscript_context(
        manuscript_text=article or "(No draft provided — review the evidence corpus only)",
        section_index=section_index,
    )

    # ── Build journal context block ──────────────────────────────────────
    journal_lines: list[str] = []
    if journal_style:
        if journal_style.citation_style:
            journal_lines.append(f"Citation style: {journal_style.citation_style}")
        word_limits = journal_style.word_limits or {}
        wl = word_limits.get(article_type) or word_limits.get("default")
        if wl:
            journal_lines.append(f"Word limit for {article_type}: {wl}")
        if journal_style.max_references:
            journal_lines.append(f"Max references: {journal_style.max_references}")
        abstract_struct = journal_style.abstract_structure
        if abstract_struct:
            journal_lines.append(f"Abstract structure: {abstract_struct}")
    journal_context = (
        "Journal context:\n" + "\n".join(f"  {l}" for l in journal_lines)
        if journal_lines else ""
    )

    # ── Article-type methodology notes ───────────────────────────────────
    methodology_notes = ""
    try:
        from services.article_builder import _REVIEW_METHODOLOGY_NOTES
        note = _REVIEW_METHODOLOGY_NOTES.get(article_type, "")
        if note:
            methodology_notes = f"Article-type methodology requirements:\n{note}"
    except ImportError:
        pass

    # ── Article-type evaluation guidance ──────────────────────────────────
    at_key = article_type.lower().replace(" ", "_")
    guidance = _ARTICLE_TYPE_GUIDANCE.get(at_key, _DEFAULT_ARTICLE_GUIDANCE)
    article_type_guidance = f"Article-type evaluation guidance:\n{guidance}"

    # ── Evidence packs from deep synthesis ───────────────────────────────
    evidence_packs_block = ""
    if manuscript_packs:
        try:
            from services.article_builder import build_evidence_blocks
            evidence_packs_block = build_evidence_blocks(manuscript_packs)
        except ImportError:
            pass

    # ── Compact evidence with globally unique IDs ────────────────────────
    evidence = build_compact_evidence(
        summaries, max_papers=30, max_results=6, max_limitations=5,
    )

    user_prompt = _USER_TMPL.format(
        query=query or "general academic research",
        article_type=article_type.replace("_", " ").title(),
        journal_context=journal_context,
        methodology_notes=methodology_notes,
        article_type_guidance=article_type_guidance,
        manuscript_context=manuscript_context,
        n=len(evidence),
        evidence_json=json.dumps(evidence, indent=2),
        evidence_packs=evidence_packs_block,
    )

    raw = await provider.complete(
        system=_SYSTEM,
        user=user_prompt,
        json_mode=True,
        temperature=0.15,
    )

    # ── Parse response ───────────────────────────────────────────────────
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 and end > start else {}
        except json.JSONDecodeError:
            logger.warning("Failed to parse peer review JSON")
            data = {}

    decision = str(data.get("decision", "major_revision")).lower()
    if decision not in ("accept", "minor_revision", "major_revision", "reject"):
        decision = "major_revision"

    revisions = data.get("required_revisions", [])
    if not isinstance(revisions, list):
        revisions = []

    strengths = data.get("strengths", [])
    if not isinstance(strengths, list):
        strengths = []

    revision_priorities = data.get("revision_priorities", [])
    if not isinstance(revision_priorities, list):
        revision_priorities = []

    reviewer_expertise = data.get("reviewer_expertise", [])
    if not isinstance(reviewer_expertise, list):
        reviewer_expertise = []

    return PeerReviewReport(
        manuscript_summary=str(data.get("manuscript_summary", "")),
        reviewer_expertise=[str(e) for e in reviewer_expertise],
        strengths=[str(s) for s in strengths],
        section_assessments=_parse_section_assessments(data.get("section_assessments", [])),
        major_concerns=_parse_concerns(data.get("major_concerns", [])),
        minor_concerns=_parse_concerns(data.get("minor_concerns", [])),
        claims_audit=_parse_claims_audit(data.get("claims_audit", [])),
        rubric_scores=_parse_rubric(data.get("rubric_scores", [])),
        revision_priorities=[str(r) for r in revision_priorities],
        required_revisions=[str(r) for r in revisions],
        decision=decision,
        decision_rationale=str(data.get("decision_rationale", "")),
        editor_note=str(data.get("editor_note", "")),
    )
