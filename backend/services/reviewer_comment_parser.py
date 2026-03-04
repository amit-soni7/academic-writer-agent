"""
services/reviewer_comment_parser.py

Parse raw journal reviewer comments into a structured list of RealReviewerComment
objects grouped by reviewer number.

Uses an AI call in JSON mode to handle the wide variety of formats found in
journal decision letters (numbered lists, "Reviewer 1:", "Comment #2:", etc.).
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

_ALLOWED_SEVERITY = {"major", "minor", "editorial"}
_ALLOWED_DOMAIN = {"writing", "methodology", "results", "references", "ethics", "statistics", "other"}
_ALLOWED_REQUIREMENT = {"mandatory", "optional", "unclear"}


def _normalize_comment(item: dict, default_idx: int) -> dict:
    comment_text = str(item.get("original_comment", "")).strip()
    category = str(item.get("category") or item.get("severity") or "major").strip().lower()
    if category not in _ALLOWED_SEVERITY:
        category = "major"

    severity = str(item.get("severity") or category).strip().lower()
    if severity not in _ALLOWED_SEVERITY:
        severity = category

    domain = str(item.get("domain") or "other").strip().lower()
    if domain not in _ALLOWED_DOMAIN:
        domain = "other"

    requirement_level = str(item.get("requirement_level") or "unclear").strip().lower()
    if requirement_level not in _ALLOWED_REQUIREMENT:
        requirement_level = "unclear"

    ambiguity_flag = bool(item.get("ambiguity_flag", False))
    ambiguity_question = str(item.get("ambiguity_question") or "").strip()
    intent_interpretation = str(item.get("intent_interpretation") or "").strip()

    return {
        "reviewer_number": int(item.get("reviewer_number", 1)),
        "comment_number": int(item.get("comment_number", default_idx)),
        "original_comment": comment_text,
        "category": category,
        "severity": severity,
        "domain": domain,
        "requirement_level": requirement_level,
        "ambiguity_flag": ambiguity_flag,
        "ambiguity_question": ambiguity_question,
        "intent_interpretation": intent_interpretation,
    }

_SYSTEM = """You are an expert scientific editor who parses journal peer-review decision letters.

Your task: extract EVERY individual reviewer comment into a structured JSON array. Do NOT miss any.

Rules:
1. Identify each reviewer as Reviewer 1, 2, 3, etc. Look for headings like "Reviewer 1:", "#1", "Referee 1", "Reviewer A", etc.
2. Number comments sequentially within each reviewer (1, 2, 3 …).
3. A "comment" is any distinct concern, question, request, or suggestion raised by a reviewer. Split them even if they appear in the same paragraph when they address different topics.
4. Classify each comment:
   - severity: "major" = requires new experiments/analyses/substantial rewrite
   - severity: "minor" = wording/formatting/small clarifications
   - severity: "editorial" = typo/grammar/reference formatting only
   - domain: writing | methodology | results | references | ethics | statistics | other
   - requirement_level: mandatory | optional | unclear
5. Include the FULL verbatim text of each comment in "original_comment". Do NOT truncate, paraphrase, or summarise.
6. Add "intent_interpretation" (1 concise sentence) explaining what reviewer really asks.
7. Add ambiguity fields:
   - ambiguity_flag: true if the reviewer ask is ambiguous/incomplete
   - ambiguity_question: one clarification question for the author (empty if not ambiguous)
8. Skip editor preamble / meta-text that is not a specific comment (e.g. "We received two reviews…", "Please address the following…"). Only skip text that is purely administrative.
9. If the letter has no clear reviewer numbering, assign all comments to Reviewer 1.
10. If a numbered item contains multiple sub-points (a, b, c), split them into separate comment entries.

CRITICAL: Return ALL comments. A typical review letter has 5–20 comments. If you find fewer than 3, re-read the letter carefully.

Output format — JSON array ONLY, no markdown fences, no explanation:
[
  {
    "reviewer_number": 1,
    "comment_number": 1,
    "original_comment": "Full verbatim comment text here...",
    "category": "major",
    "severity": "major",
    "domain": "methodology",
    "requirement_level": "mandatory",
    "ambiguity_flag": false,
    "ambiguity_question": "",
    "intent_interpretation": "Reviewer asks us to justify sample size and power assumptions."
  },
  ...
]"""

_USER_TMPL = (
    "Parse ALL reviewer comments from the following peer-review decision letter into the JSON array.\n"
    "Remember: extract EVERY comment — do not merge separate concerns into one entry.\n\n"
    "---\n{raw_comments}\n---\n\n"
    "Return ONLY the JSON array, starting with [ and ending with ]."
)


def _try_recover_partial_json(raw: str) -> list[dict] | None:
    """
    Try to salvage a truncated JSON array by closing it and parsing what we have.
    Returns a list of valid comment dicts, or None if unrecoverable.
    """
    raw = raw.strip()
    if not raw.startswith('['):
        return None

    # Find the last complete object by looking for the last "}," or "}"
    last_complete = max(raw.rfind('},'), raw.rfind('}\n'))
    if last_complete < 0:
        return None

    attempt = raw[:last_complete + 1].rstrip(',').strip() + ']'
    try:
        result = json.loads(attempt)
        if isinstance(result, list) and result:
            logger.warning("Recovered %d comments from truncated JSON", len(result))
            return result
    except Exception:
        pass
    return None


def _fallback_parse(raw: str) -> list[dict]:
    """
    Regex fallback when the AI call fails or returns invalid JSON.
    Splits on Reviewer N headings and numbers each block.
    """
    result: list[dict] = []

    # Try to split on reviewer sections
    reviewer_blocks = re.split(
        r'\n\s*(?:Reviewer|Referee|#)\s*(\d+)\s*[:\-]?\s*\n',
        raw, flags=re.IGNORECASE
    )
    if len(reviewer_blocks) > 1:
        # Alternating: preamble, [num, text, num, text, ...]
        i = 1
        while i < len(reviewer_blocks) - 1:
            rev_num = int(reviewer_blocks[i])
            block = reviewer_blocks[i + 1]
            # Split block into individual comments by numbered lines
            comments = re.split(r'\n\s*(?:\d+[\.\):]|\[?\d+\]?)\s+', block)
            for j, c in enumerate(comments, start=1):
                c = c.strip()
                if c and len(c) > 20:
                    result.append({
                        "reviewer_number": rev_num,
                        "comment_number": j,
                        "original_comment": c,
                        "category": "major",
                        "severity": "major",
                        "domain": "other",
                        "requirement_level": "unclear",
                        "ambiguity_flag": False,
                        "ambiguity_question": "",
                        "intent_interpretation": "",
                    })
            i += 2
    else:
        # No reviewer sections — split by numbered items
        comments = re.split(r'\n\s*(?:\d+[\.\):]|\[?\d+\]?)\s+', raw)
        for j, c in enumerate(comments, start=1):
            c = c.strip()
            if c and len(c) > 20:
                result.append({
                    "reviewer_number": 1,
                    "comment_number": j,
                    "original_comment": c,
                    "category": "major",
                    "severity": "major",
                    "domain": "other",
                    "requirement_level": "unclear",
                    "ambiguity_flag": False,
                    "ambiguity_question": "",
                    "intent_interpretation": "",
                })

    # Last resort: return whole text as one comment rather than losing all content
    return result or [{
        "reviewer_number": 1,
        "comment_number": 1,
        "original_comment": raw.strip(),
        "category": "major",
        "severity": "major",
        "domain": "other",
        "requirement_level": "unclear",
        "ambiguity_flag": False,
        "ambiguity_question": "",
        "intent_interpretation": "",
    }]


async def parse_reviewer_comments(
    provider: "AIProvider",
    raw_comments: str,
) -> list[dict]:
    """
    Parse raw reviewer comment text into a list of RealReviewerComment dicts.
    Falls back to regex parsing if the AI call fails.
    """
    if not provider:
        return _fallback_parse(raw_comments)

    try:
        raw_json = await provider.complete(
            system=_SYSTEM,
            user=_USER_TMPL.format(raw_comments=raw_comments),
            temperature=0.05,
            json_mode=True,
            max_tokens=16000,   # large budget: many comments × full verbatim text
        )

        # Strip markdown code fences if present (some models ignore json_mode)
        raw_json = re.sub(r'^```(?:json)?\s*', '', raw_json.strip())
        raw_json = re.sub(r'\s*```$', '', raw_json.strip())

        # If wrapped in an object like {"comments": [...]}, unwrap
        if raw_json.startswith('{'):
            try:
                obj = json.loads(raw_json)
                for key in ("comments", "reviewer_comments", "data", "result", "items"):
                    if key in obj and isinstance(obj[key], list):
                        raw_json = json.dumps(obj[key])
                        break
            except Exception:
                pass

        parsed = json.loads(raw_json)

        if not isinstance(parsed, list):
            raise ValueError(f"Expected JSON array, got {type(parsed).__name__}")

        # Normalise and validate fields
        result = []
        for item in parsed:
            norm = _normalize_comment(item, len(result) + 1)
            if not norm["original_comment"]:
                continue
            result.append(norm)

        if not result:
            raise ValueError("AI returned empty comment list")

        logger.info("Parsed %d reviewer comments via AI", len(result))
        return result

    except json.JSONDecodeError as exc:
        # Try to recover a partial truncated array before falling back
        recovered = _try_recover_partial_json(raw_json if 'raw_json' in dir() else "")
        if recovered:
            return [
                _normalize_comment(item, i + 1)
                for i, item in enumerate(recovered)
                if str(item.get("original_comment", "")).strip()
            ]
        logger.warning("JSON parse failed (%s), using regex fallback", exc)
        return _fallback_parse(raw_comments)

    except Exception as exc:
        logger.warning("Comment parse failed (%s), using regex fallback", exc)
        return _fallback_parse(raw_comments)
