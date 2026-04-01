"""
services/real_revision_writer.py

Generate AI-drafted point-by-point responses to real journal peer-review comments.

Call 1 (JSON, temp 0.15): per-comment responses grounded in the manuscript.
Call 2 (temp 0.20):        full revised manuscript incorporating all changes.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from services.manuscript_utils import (
    number_lines as _number_lines,
    build_section_index_header as _build_section_index_header,
    build_full_manuscript_context as _build_full_context,
)

if TYPE_CHECKING:
    from services.ai_provider import AIProvider


# ── Prompts ────────────────────────────────────────────────────────────────────

_RESPONSE_SYSTEM = """You are an expert scientific author responding to peer-review comments from a journal.

Your task is to write a detailed, scholarly point-by-point response to each reviewer comment.

═══════════════════════════════════════════════════════════════════════════════
MANDATORY PRESERVATION RULES — violating ANY of these is a critical error:
═══════════════════════════════════════════════════════════════════════════════
1. TITLE: Do NOT change the manuscript title unless the reviewer explicitly requests it.
2. HEADINGS: Keep ALL section/subsection headings identical unless reviewer asks to rename/add/remove.
3. FIGURES & ILLUSTRATIONS: Do NOT add, remove, or modify figure/illustration references, captions,
   image markdown, illustration placeholders, or any figure/illustration block unless reviewer asks.
4. TABLES: Do NOT add, remove, or modify table references, table captions, or the actual table
   content/block unless reviewer asks.
5. CITATIONS & REFERENCES: Do NOT add, remove, rewrite, or renumber citations or reference entries
   unless reviewer explicitly asks. Preserve the full References section unless a requested change requires it.
6. WORD COUNT: Keep changes minimal — total word count must stay within ±5% of original.
7. SCOPE: Only propose changes that directly address a reviewer comment. Nothing else.
8. NO UNSOLICITED IMPROVEMENTS: Do NOT fix grammar, rephrase for "clarity", or "improve" any text
   outside the targeted region. If the reviewer didn't flag it, don't touch it.
═══════════════════════════════════════════════════════════════════════════════

For each comment you will produce:
1. "author_response" — a thorough, respectful response that:
   - Directly addresses the reviewer's concern
   - Cites specific evidence from the manuscript (using the line numbers provided)
   - States whether you agree or politely disagree (with justification)
   - Describes exactly what changes were/will be made
2. "action_taken" — a precise location string like:
   "Introduction, paragraph 2, Lines 23–28 of the revised manuscript: [brief description of change]"
   Use "No change required" if the existing text already addresses the concern.
3. "manuscript_diff" — a JSON string: {"deleted": "original text snippet (≤ 30 words)", "added": "replacement text (≤ 30 words)"}
   Use {} if no text was changed.

Key rules:
- Be respectful and professional. Thank reviewers for their time.
- Ground every response in the manuscript text.
- Be specific about line numbers and section names.
- If a reviewer raises a valid concern, acknowledge it fully and describe the revision.

Output: a JSON array in this exact format:
[
  {
    "reviewer_number": 1,
    "comment_number": 1,
    "original_comment": "The exact reviewer comment text",
    "author_response": "Our detailed response...",
    "action_taken": "Methods, paragraph 3, Lines 112–118 of the revised manuscript: ...",
    "manuscript_diff": "{\"deleted\": \"old text\", \"added\": \"new text\"}"
  },
  ...
]"""

_RESPONSE_USER_TMPL = """Manuscript summary: {manuscript_summary}
Journal: {journal_name}

LINE-NUMBERED MANUSCRIPT:
---
{numbered_manuscript}
---

REVIEWER COMMENTS (JSON):
{comments_json}

Generate the point-by-point response array. Return ONLY the JSON array."""


_REVISED_SYSTEM = """You are an expert scientific author. You have received peer-review responses
and must now produce the full revised manuscript incorporating all described changes.

═══════════════════════════════════════════════════════════════════════════════
MANDATORY PRESERVATION RULES — violating ANY of these is a critical error:
═══════════════════════════════════════════════════════════════════════════════
1. TITLE: Keep the EXACT same title unless a reviewer change explicitly modifies it.
2. HEADINGS: Keep ALL section/subsection headings IDENTICAL to the original.
3. FIGURES & ILLUSTRATIONS: Keep ALL figure/illustration references, captions, image markdown,
   illustration placeholders, and figure/illustration blocks exactly as-is.
4. TABLES: Keep ALL table references, captions, legends, and full table blocks exactly as-is.
5. CITATIONS & REFERENCES: Keep ALL citations, reference entries, and the full References section.
   Do NOT add, remove, rewrite, or renumber any unless explicitly described in the changes below.
6. WORD COUNT: The revised manuscript must be within ±5% word count of the original.
   Do NOT pad, expand, or shorten text beyond what the changes require.
7. SCOPE: Apply ONLY the changes described below. Do NOT make any other modifications.
   If text is not mentioned in the changes, copy it VERBATIM from the original.
8. NO UNSOLICITED IMPROVEMENTS: Do NOT fix grammar, rephrase, or "improve" ANY text
   that is not part of an explicit change. Leave untouched text character-for-character identical.
═══════════════════════════════════════════════════════════════════════════════

Instructions:
- Apply every change described in the "action_taken" and "manuscript_diff" fields.
- For all text NOT targeted by a change, copy it EXACTLY from the original — word for word.
- Output the complete revised manuscript in markdown format (# for title, ## for sections).
- Do NOT include the point-by-point response — only the revised manuscript text."""

_REVISED_USER_TMPL = """ORIGINAL MANUSCRIPT:
---
{manuscript}
---

REVIEWER RESPONSES (with changes to apply):
{responses_summary}

Now output the complete revised manuscript."""


# ── Main function ──────────────────────────────────────────────────────────────

async def generate_real_revision(
    provider: "AIProvider",
    manuscript: str,
    manuscript_summary: str,
    parsed_comments: list[dict],
    journal_name: str = "",
    round_number: int = 1,
) -> dict:
    """
    Generate a full revision round including per-comment responses and revised manuscript.

    Returns a dict matching RevisionRound:
      round_number, journal_name, parsed_comments, responses,
      revised_article, point_by_point_md, created_at
    """
    numbered_ms = _number_lines(manuscript)
    comments_json = json.dumps(parsed_comments, indent=2, ensure_ascii=False)

    # ── AI Call 1: per-comment responses ──────────────────────────────────────
    responses: list[dict] = []
    try:
        raw = await provider.complete(
            system=_RESPONSE_SYSTEM,
            user=_RESPONSE_USER_TMPL.format(
                manuscript_summary=manuscript_summary or "(not provided)",
                journal_name=journal_name or "the journal",
                numbered_manuscript=numbered_ms,
                comments_json=comments_json,
            ),
            temperature=0.15,
        )
        raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
        raw = re.sub(r'\s*```$', '', raw.strip())
        parsed_resp = json.loads(raw)
        if isinstance(parsed_resp, list):
            responses = parsed_resp
    except Exception as exc:
        # Fallback: create stub responses for each comment
        for c in parsed_comments:
            responses.append({
                "reviewer_number": c["reviewer_number"],
                "comment_number": c["comment_number"],
                "original_comment": c["original_comment"],
                "author_response": f"(Response generation failed: {exc}). We thank the reviewer for this comment and will address it in the revised manuscript.",
                "action_taken": "To be completed by the authors.",
                "manuscript_diff": "{}",
            })

    # ── AI Call 2: full revised manuscript ────────────────────────────────────
    responses_summary = "\n\n".join(
        f"Reviewer {r.get('reviewer_number')}, Comment {r.get('comment_number')}:\n"
        f"Action: {r.get('action_taken', '')}\n"
        f"Diff: {r.get('manuscript_diff', '{}')} "
        for r in responses
    )

    revised_article = manuscript  # fallback: return unchanged
    try:
        revised_article = await provider.complete(
            system=_REVISED_SYSTEM,
            user=_REVISED_USER_TMPL.format(
                manuscript=manuscript,
                responses_summary=responses_summary,
            ),
            temperature=0.20,
        )
    except Exception:
        pass  # keep original manuscript as fallback

    # ── Build point-by-point markdown ─────────────────────────────────────────
    point_by_point_md = _build_point_by_point_md(
        journal_name=journal_name,
        parsed_comments=parsed_comments,
        responses=responses,
    )

    return {
        "round_number": round_number,
        "journal_name": journal_name,
        "raw_comments": "",  # filled by caller
        "parsed_comments": parsed_comments,
        "responses": responses,
        "revised_article": revised_article,
        "point_by_point_md": point_by_point_md,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Per-comment discussion service ────────────────────────────────────────────

_DISCUSS_SYSTEM = """You are an expert academic peer-review coach with deep knowledge of how top journals and reviewers operate.

You help authors plan precise, effective responses to each reviewer comment.

## Your expertise includes:
- Distinguishing comment types: methodological flaw, statistical concern, interpretation gap, literature gap, clarity/writing issue, scope concern, reproducibility request
- Understanding reviewer psychology: what reviewers actually need vs. what they literally say
- Knowing when to agree fully, agree partially (with caveats), or respectfully disagree with evidence
- Drafting responses that are diplomatic but not sycophantic, firm but not defensive
- Identifying exactly where in the manuscript a change belongs (section, paragraph, line range)

## For each comment you will:
1. Briefly identify the comment TYPE and its validity (valid concern / partially valid / phrasing issue)
2. Propose a RESPONSE STRATEGY: full agreement + change / partial agreement / respectful rebuttal with evidence
3. Draft a specific CHANGE PLAN: what text to add, rewrite, or remove, and exactly where
4. If the comment asks for new data or analysis you cannot provide, suggest how to acknowledge the limitation honestly
5. Avoid redundancy with already finalized comments/changes provided in context

## Response diplomacy rules:
- Always open by acknowledging the reviewer's expertise or insight (genuine, not formulaic)
- For changes: be specific ("We added a paragraph in the Limitations section, lines X–Y")
- For rebuttals: cite evidence or literature, never just assert disagreement
- Avoid "we apologize" — use "we clarify" or "we now address"

## Critical constraints:
- DOI references are for this specific active comment only. Do NOT force DOI citations for every comment.
- If prior finalized changes already address part of the active comment, reuse/cross-reference them and avoid duplicated edits.
- Do NOT generate a clean manuscript or track-changes manuscript in this step.
- In updated_plan, include a strict "Manuscript Change Instructions (what · where · exact text)" block using explicit operations:
  - CHANGE <section/location>
  - DELETE: "<exact old text>"
  - ADD: "<exact new text>"
  Use CHANGE/DELETE/ADD only when text edits are needed.

## Output format (JSON only, no markdown fences):
{"ai_response": "...", "updated_plan": "..."}

- ai_response: conversational explanation of your thinking (1–3 paragraphs)
- updated_plan: concrete change plan — what to add/remove/rewrite, where, how (be specific with section and paragraph references)"""

_DISCUSS_USER_TMPL = """REVIEWER COMMENT:
{original_comment}

CURRENT CHANGE PLAN:
{current_plan}

{doi_block}{finalized_block}CONVERSATION HISTORY:
{history_text}

USER MESSAGE:
{user_message}

Return JSON only."""


async def discuss_comment(
    provider: "AIProvider",
    original_comment: str,
    user_message: str,
    history: list[dict],
    current_plan: str,
    doi_refs: list[str],
    manuscript_text: str,
    finalized_context: list[dict] | None = None,
    manuscript_summary: str = "",
    section_index: list[dict] | None = None,
) -> dict:
    """
    One turn of the per-comment discussion.
    Returns {ai_response: str, updated_plan: str}.
    """
    # Fetch DOI metadata for any provided DOIs
    doi_block = ""
    if doi_refs:
        try:
            from services.doi_metadata_fetcher import fetch_doi_metadata
            meta_lines: list[str] = []
            for doi in doi_refs[:5]:  # limit to 5 DOIs
                try:
                    meta = await fetch_doi_metadata(doi)
                    if meta:
                        authors = meta.get("author", [])
                        author_str = ", ".join(
                            f"{a.get('family', '')} {a.get('given', '')[:1]}".strip()
                            for a in authors[:3]
                        )
                        if len(authors) > 3:
                            author_str += " et al."
                        year = (meta.get("issued", {}).get("date-parts") or [[""]])[0][0]
                        title = (meta.get("title") or [""])[0]
                        journal = meta.get("container-title", [""])[0] if meta.get("container-title") else ""
                        meta_lines.append(f"- DOI {doi}: {author_str} ({year}). {title}. {journal}.")
                except Exception:
                    meta_lines.append(f"- DOI {doi}: (metadata unavailable)")
            if meta_lines:
                doi_block = "DOI REFERENCES PROVIDED BY AUTHOR:\n" + "\n".join(meta_lines) + "\n\n"
        except ImportError:
            pass

    full_ctx = _build_full_context(manuscript_text, manuscript_summary, section_index) if manuscript_text else "(manuscript not provided)"

    finalized_block = ""
    if finalized_context:
        ctx_lines: list[str] = []
        for c in finalized_context[:10]:
            ctx_lines.append(
                f"- Reviewer {c.get('reviewer_number')}, Comment {c.get('comment_number')}: "
                f"{c.get('action_taken', '')} | Changes: {c.get('manuscript_changes', '{}')}"
            )
        if ctx_lines:
            finalized_block = "ALREADY FINALIZED CHANGES (avoid redundancy):\n" + "\n".join(ctx_lines) + "\n\n"

    history_text = ""
    if history:
        history_text = "\n".join(
            f"{'Author' if h.get('role') == 'user' else 'AI'}: {h.get('content', '')}"
            for h in history
        )
    else:
        history_text = "(no prior conversation)"

    raw = await provider.complete_cached(
        cacheable_context=full_ctx,
        system=_DISCUSS_SYSTEM,
        user=_DISCUSS_USER_TMPL.format(
            original_comment=original_comment,
            current_plan=current_plan or "(none yet — please propose an initial plan)",
            doi_block=doi_block,
            finalized_block=finalized_block,
            history_text=history_text,
            user_message=user_message,
        ),
        temperature=0.3,
    )
    raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
    raw = re.sub(r'\s*```$', '', raw.strip())
    try:
        result = json.loads(raw)
        return {
            "ai_response": result.get("ai_response", ""),
            "updated_plan": result.get("updated_plan", current_plan),
        }
    except Exception:
        # Fallback: treat entire response as ai_response
        return {"ai_response": raw, "updated_plan": current_plan}


# ── Finalize comment response ──────────────────────────────────────────────────

_FINALIZE_SYSTEM = """You are an expert scientific author. The author has agreed on a final change plan for a peer-review comment.

═══════════════════════════════════════════════════════════════════════════════
MANDATORY PRESERVATION RULES — violating ANY of these is a critical error:
═══════════════════════════════════════════════════════════════════════════════
1. TITLE: Do NOT change the manuscript title unless the change plan explicitly says to.
2. HEADINGS: Do NOT rename, add, or remove any section/subsection headings.
3. FIGURES & TABLES: Do NOT add, remove, or modify figure/table references, captions, image blocks,
   illustration blocks, or table blocks.
4. CITATIONS & REFERENCES: Do NOT add, remove, rewrite, or renumber citations/references unless the
   plan explicitly says to. Preserve the References section exactly otherwise.
5. SCOPE: Only produce manuscript_changes that implement the agreed plan. Nothing extra.
6. NO UNSOLICITED IMPROVEMENTS: Do NOT fix grammar, rephrase, or "improve" anything outside the plan scope.
═══════════════════════════════════════════════════════════════════════════════

Write:
1. A formal, respectful author response letter paragraph (scholarly, professional tone)
2. A precise action-taken location string
3. A JSON array of manuscript edit operations

Return ONLY valid JSON (no markdown fences):
{
  "author_response": "We thank Reviewer X for this insightful comment...",
  "action_taken": "Introduction, paragraph 2, Lines 23-28: [description]",
  "manuscript_changes": [
    {"type": "replace", "find": "<EXACT text from manuscript>", "replace_with": "<new text>"},
    {"type": "insert_after", "anchor": "<EXACT text of paragraph to insert after>", "text": "<new text>"},
    {"type": "delete", "find": "<EXACT text to remove>"}
  ]
}

Rules:
- author_response: 2-4 paragraphs. Acknowledge the comment, explain the change, cite the plan.
- action_taken: be precise. If no text change, write "No change required: [reason]".
- manuscript_changes: JSON array of edit operations. CRITICAL RULES:
  1. "find" and "anchor" values MUST be copied character-for-character from the manuscript TEXT. Do NOT paraphrase.
     IMPORTANT: Do NOT include line numbers in "find" or "anchor" — line numbers are reference only, not part of the text.
  2. "find"/"anchor" text must be at least 50 characters long to ensure uniqueness in the document.
  3. For REPLACE (changing existing text): {"type": "replace", "find": "exact old text", "replace_with": "new text"}
  4. For INSERT (adding new text after an existing paragraph): {"type": "insert_after", "anchor": "exact text of the paragraph to insert after (50+ chars)", "text": "new content"}
  5. For DELETE (removing text without replacement): {"type": "delete", "find": "exact text to remove"}
  6. If no text changes needed: return an empty array []
  7. Multiple operations per comment are supported - list them all in the array.
  8. Each operation must target a specific, locatable piece of text in the manuscript."""

_FINALIZE_USER_TMPL = """REVIEWER COMMENT (Reviewer {reviewer_number}, Comment {comment_number}):
{original_comment}

FINALIZED CHANGE PLAN:
{finalized_plan}

Write the formal author response. For manuscript_changes, copy EXACT text from the manuscript for "find" and "anchor" fields. Return JSON only."""


async def finalize_comment_response(
    provider: "AIProvider",
    original_comment: str,
    finalized_plan: str,
    manuscript_text: str,
    reviewer_number: int,
    comment_number: int,
    manuscript_summary: str = "",
    section_index: list[dict] | None = None,
) -> dict:
    """
    Write formal author_response and action_taken from an agreed change plan.
    Returns {author_response: str, action_taken: str, manuscript_changes: str}.
    """
    full_ctx = _build_full_context(manuscript_text, manuscript_summary, section_index) if manuscript_text else "(manuscript not provided)"

    raw = await provider.complete_cached(
        cacheable_context=full_ctx,
        system=_FINALIZE_SYSTEM,
        user=_FINALIZE_USER_TMPL.format(
            reviewer_number=reviewer_number,
            comment_number=comment_number,
            original_comment=original_comment,
            finalized_plan=finalized_plan or "(no specific plan — respond gracefully)",
        ),
        temperature=0.15,
    )
    raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
    raw = re.sub(r'\s*```$', '', raw.strip())
    try:
        result = json.loads(raw)
        # manuscript_changes: store as JSON string if it's a list (new format)
        mc = result.get("manuscript_changes", [])
        if isinstance(mc, list):
            mc_str = json.dumps(mc)
        elif isinstance(mc, str):
            mc_str = mc  # legacy format or already stringified
        else:
            mc_str = "[]"
        return {
            "author_response": result.get("author_response", ""),
            "action_taken": result.get("action_taken", ""),
            "manuscript_changes": mc_str,
        }
    except Exception:
        return {
            "author_response": raw,
            "action_taken": "See response.",
            "manuscript_changes": "[]",
        }


# ── Generate revision from finalized plans ────────────────────────────────────

_PLANS_REVISED_SYSTEM = """You are an expert scientific author applying agreed-upon changes to a manuscript.

You have a list of finalized reviewer-response plans. Each plan specifies exactly what to change and where.

═══════════════════════════════════════════════════════════════════════════════
MANDATORY PRESERVATION RULES — violating ANY of these is a critical error:
═══════════════════════════════════════════════════════════════════════════════
1. TITLE: Keep the EXACT same title unless a finalized plan explicitly changes it.
2. HEADINGS: Keep ALL section/subsection headings IDENTICAL to the original.
3. FIGURES & ILLUSTRATIONS: Keep ALL figure/illustration references, captions, image markdown,
   illustration placeholders, and full figure/illustration blocks exactly as-is.
4. TABLES: Keep ALL table references, captions, legends, and full table blocks exactly as-is.
5. CITATIONS & REFERENCES: Keep ALL citations, reference entries, and the full References section.
   Do NOT add, remove, rewrite, or renumber any unless explicitly described in the finalized plans below.
6. WORD COUNT: The revised manuscript must be within ±5% word count of the original.
7. SCOPE: Apply ONLY the changes from the finalized plans. NOTHING else.
   If text is not mentioned in any plan, copy it VERBATIM from the original.
8. NO UNSOLICITED IMPROVEMENTS: Do NOT fix grammar, rephrase, or "improve" ANY text
   that is not part of a finalized plan. Leave untouched text character-for-character identical.
═══════════════════════════════════════════════════════════════════════════════

Instructions:
- Apply ONLY the changes described in the finalized plans. Do not improvise.
- For all text NOT targeted by a change, copy it EXACTLY from the original — word for word.
- Output the complete revised manuscript in markdown format (# for title, ## for sections)."""

_PLANS_REVISED_USER_TMPL = """ORIGINAL MANUSCRIPT:
---
{manuscript}
---

FINALIZED CHANGES TO APPLY:
{changes_summary}

Apply these changes and output the complete revised manuscript."""


async def generate_revision_from_plans(
    provider: "AIProvider",
    manuscript_text: str,
    finalized_plans: list[dict],
    journal_name: str = "",
    round_number: int = 1,
) -> dict:
    """
    Generate a full revision round from pre-finalized per-comment plans.

    Takes already-finalized author_response/action_taken from each plan.
    AI only writes the revised manuscript; point_by_point_md is built from plans.

    Returns a dict matching RevisionRound.
    """
    # Build the changes summary for the AI
    changes_lines: list[str] = []
    responses: list[dict] = []

    for plan in finalized_plans:
        rev = plan.get("reviewer_number", 1)
        cnum = plan.get("comment_number", 1)
        changes_lines.append(
            f"Reviewer {rev}, Comment {cnum}:\n"
            f"  Action: {plan.get('action_taken', '')}\n"
            f"  Changes: {plan.get('manuscript_changes', '{}')}"
        )
        responses.append({
            "reviewer_number": rev,
            "comment_number": cnum,
            "original_comment": plan.get("original_comment", ""),
            "change_plan": plan.get("current_plan", ""),
            "author_response": plan.get("author_response", ""),
            "action_taken": plan.get("action_taken", ""),
            "manuscript_diff": plan.get("manuscript_changes", "{}"),
        })

    changes_summary = "\n\n".join(changes_lines) if changes_lines else "(no changes specified)"

    # AI Call: produce revised manuscript
    revised_article = manuscript_text  # fallback
    try:
        revised_article = await provider.complete(
            system=_PLANS_REVISED_SYSTEM,
            user=_PLANS_REVISED_USER_TMPL.format(
                manuscript=manuscript_text,
                changes_summary=changes_summary,
            ),
            temperature=0.15,
        )
    except Exception:
        pass  # keep original as fallback

    # Build point-by-point markdown from the finalized plans (no extra AI call)
    point_by_point_md = _build_point_by_point_md(
        journal_name=journal_name,
        parsed_comments=[
            {
                "reviewer_number": p.get("reviewer_number"),
                "comment_number": p.get("comment_number"),
                "original_comment": p.get("original_comment", ""),
            }
            for p in finalized_plans
        ],
        responses=responses,
    )

    parsed_comments_out = [
        {
            "reviewer_number": p.get("reviewer_number"),
            "comment_number": p.get("comment_number"),
            "original_comment": p.get("original_comment", ""),
            "category": p.get("category", "major"),
        }
        for p in finalized_plans
    ]

    return {
        "round_number": round_number,
        "journal_name": journal_name,
        "raw_comments": "",
        "parsed_comments": parsed_comments_out,
        "responses": responses,
        "revised_article": revised_article,
        "point_by_point_md": point_by_point_md,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def _build_point_by_point_md(
    journal_name: str,
    parsed_comments: list[dict],
    responses: list[dict],
) -> str:
    """Build a markdown-formatted point-by-point reply document."""
    lines: list[str] = [
        "# Point-by-Point Reply and Changes Made in the Manuscript",
        "",
    ]
    if journal_name:
        lines += [f"**Journal:** {journal_name}", ""]

    lines += [
        "We sincerely thank all reviewers for their time and constructive comments. "
        "We have carefully addressed each point below. Reviewer comments are shown in "
        "normal text, our responses in **bold**, and actions taken are noted in *italics*.",
        "",
    ]

    # Group responses by reviewer
    resp_by_reviewer: dict[int, list[dict]] = {}
    for r in responses:
        rev = r.get("reviewer_number", 1)
        resp_by_reviewer.setdefault(rev, []).append(r)

    reviewers = sorted(resp_by_reviewer.keys())
    for rev_num in reviewers:
        lines += [f"---", f"## Reviewer #{rev_num}", ""]
        for r in sorted(resp_by_reviewer[rev_num], key=lambda x: x.get("comment_number", 0)):
            lines += [
                f"**Comment {r.get('comment_number', '')}:** {r.get('original_comment', '')}",
                "",
                f"**Response:** {r.get('author_response', '')}",
                "",
                f"*Action taken: {r.get('action_taken', 'N/A')}*",
                "",
            ]

    return "\n".join(lines)


_SUGGEST_SYSTEM = """You are an expert academic revision strategist.
Generate comment-wise change suggestions for authors after peer review.

═══════════════════════════════════════════════════════════════════════════════
PRESERVATION BIAS — keep the manuscript as close to the original as possible:
═══════════════════════════════════════════════════════════════════════════════
- Do NOT suggest changing the title, headings, figure/table references, figure/illustration blocks,
  table blocks, or citation/reference numbering/content unless the reviewer EXPLICITLY asks for it.
- Prefer NO change over any change. The original manuscript is the baseline.
- Suggest MINIMAL edits — the smallest text change that addresses the concern.
═══════════════════════════════════════════════════════════════════════════════

Return ONLY JSON array. For each comment include:
- reviewer_number, comment_number, original_comment
- interpretation (what reviewer actually asks)
- action_type: no_change|clarify|reframe_claim|add_limitation|add_citation|add_analysis|rewrite_text|rebuttal|other
- target_section
- target_line_hint
- copy_paste_text (clear rewritten sentence/paragraph authors can paste)
- citation_needed (true/false)
- citation_suggestions (short list, may be empty)
- evidence_check_status: supported|unsupported|needs_external_evidence|needs_new_experiment|unclear
- response_snippet (formal rebuttal sentence/mini-paragraph)
- ambiguity_flag (true/false)
- ambiguity_question (empty when not ambiguous)

Rules:
- PREFER conservative actions. Use this priority order:
  no_change > clarify > reframe_claim > add_limitation > add_citation
  before rewrite_text or add_analysis.
- Only use rewrite_text when the existing text is factually wrong or misleading.
- A strong manuscript that already addresses the concern should get action_type: no_change.
- Do NOT suggest rewrites for stylistic preferences or minor phrasing differences.
- Do not fabricate numeric results.
- If ambiguity is high, set ambiguity_flag=true and keep copy_paste_text conservative.
- Suggestions are advisory only; authors will edit manuscript manually.
"""


async def suggest_comment_changes(
    provider: "AIProvider",
    manuscript_text: str,
    parsed_comments: list[dict],
    journal_name: str = "",
    manuscript_summary: str = "",
    section_index: list[dict] | None = None,
) -> list[dict]:
    if not parsed_comments:
        return []

    # Deterministic fallback if no provider.
    if not provider:
        out = []
        for c in parsed_comments:
            out.append({
                "reviewer_number": c.get("reviewer_number", 1),
                "comment_number": c.get("comment_number", 1),
                "original_comment": c.get("original_comment", ""),
                "interpretation": c.get("intent_interpretation", "Clarify and address reviewer concern."),
                "action_type": "clarify",
                "target_section": "",
                "target_line_hint": "",
                "copy_paste_text": "We have clarified this point in the revised manuscript.",
                "citation_needed": False,
                "citation_suggestions": [],
                "evidence_check_status": "unclear",
                "response_snippet": "We thank the reviewer for this insightful comment and have clarified the manuscript accordingly.",
                "ambiguity_flag": bool(c.get("ambiguity_flag", False)),
                "ambiguity_question": c.get("ambiguity_question", ""),
            })
        return out

    full_ctx = _build_full_context(manuscript_text, manuscript_summary, section_index)
    user_msg = (
        f"Journal: {journal_name or 'N/A'}\n\n"
        f"Parsed reviewer comments JSON:\n{json.dumps(parsed_comments, ensure_ascii=False, indent=2)}\n\n"
        "Return JSON array only."
    )

    raw = await provider.complete_cached(
        cacheable_context=full_ctx,
        system=_SUGGEST_SYSTEM,
        user=user_msg,
        json_mode=True,
        temperature=0.1,
        max_tokens=12000,
    )
    raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
    raw = re.sub(r'\s*```$', '', raw.strip())

    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        parsed = parsed.get("suggestions", [])
    if not isinstance(parsed, list):
        return []

    norm = []
    for i, s in enumerate(parsed, start=1):
        norm.append({
            "reviewer_number": int(s.get("reviewer_number", 1)),
            "comment_number": int(s.get("comment_number", i)),
            "original_comment": str(s.get("original_comment", "")).strip(),
            "interpretation": str(s.get("interpretation", "")).strip(),
            "action_type": str(s.get("action_type", "other")).strip() or "other",
            "target_section": str(s.get("target_section", "")).strip(),
            "target_line_hint": str(s.get("target_line_hint", "")).strip(),
            "copy_paste_text": str(s.get("copy_paste_text", "")).strip(),
            "citation_needed": bool(s.get("citation_needed", False)),
            "citation_suggestions": [str(x) for x in (s.get("citation_suggestions", []) or [])][:8],
            "evidence_check_status": str(s.get("evidence_check_status", "unclear")).strip() or "unclear",
            "response_snippet": str(s.get("response_snippet", "")).strip(),
            "ambiguity_flag": bool(s.get("ambiguity_flag", False)),
            "ambiguity_question": str(s.get("ambiguity_question", "")).strip(),
        })
    return norm
