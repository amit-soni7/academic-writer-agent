from __future__ import annotations

import re

from services.journal_style_service import JournalStyle

_REFERENCE_HEADING_RE = re.compile(
    r"(?im)^\s*#{1,6}\s*(references|bibliography|works cited|literature cited)\s*$"
)
_CITE_GROUP_RE = re.compile(
    r"(?P<tags>(?:\[CITE:[^\]]+\]\s*)+)"
    r"(?P<citation>\[[0-9,\-\s]+\]|\([0-9,\-\s]+\)|\^[0-9,\-\s]+)?"
)


def _norm_key(value: str) -> str:
    return str(value or "").strip().lower()


def _unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _extract_group_keys(tag_block: str) -> list[str]:
    return _unique_preserve_order([
        _norm_key(match)
        for match in re.findall(r"\[CITE:([^\]]+)\]", tag_block or "")
    ])


def _split_references_section(article_text: str) -> tuple[str, str | None]:
    match = _REFERENCE_HEADING_RE.search(article_text or "")
    if not match:
        return (article_text or "").rstrip(), None
    return article_text[:match.start()].rstrip(), match.group(0).strip()


def _format_numeric_citation(numbers: list[int], existing: str, in_text_format: str) -> str:
    joined = ", ".join(str(number) for number in numbers)
    if existing.startswith("("):
        return f"({joined})"
    if existing.startswith("^"):
        return f"^{joined}"
    if existing.startswith("["):
        return f"[{joined}]"
    if in_text_format == "superscript":
        return f"^{joined}"
    return f"[{joined}]"


def normalize_numbered_citation_order(
    article_text: str,
    journal_style: JournalStyle,
    summaries: list[dict],
) -> str:
    """
    Re-number numeric citations by first manuscript appearance and rebuild the
    References section in that same order.

    This only applies to numeric journals that require order-of-appearance.
    Author-year styles are returned unchanged.
    """
    if not article_text.strip():
        return article_text
    if journal_style.in_text_format == "author_year":
        return article_text
    if journal_style.reference_sort_order != "order_of_appearance":
        return article_text

    body_text, existing_refs_heading = _split_references_section(article_text)
    key_order: list[str] = []
    seen_keys: set[str] = set()

    for match in _CITE_GROUP_RE.finditer(body_text):
        for key in _extract_group_keys(match.group("tags")):
            if key not in seen_keys:
                seen_keys.add(key)
                key_order.append(key)

    if not key_order:
        return article_text

    summary_by_key = {
        _norm_key(summary.get("paper_key", "")): summary
        for summary in summaries
        if _norm_key(summary.get("paper_key", ""))
    }
    missing_keys = [key for key in key_order if key not in summary_by_key]
    if missing_keys:
        return article_text

    citation_numbers = {key: idx for idx, key in enumerate(key_order, 1)}

    def _replace_group(match: re.Match[str]) -> str:
        citation = match.group("citation")
        if not citation:
            return match.group(0)
        keys = _extract_group_keys(match.group("tags"))
        if not keys:
            return match.group(0)
        tags = match.group("tags").rstrip()
        numbers = [citation_numbers[key] for key in keys if key in citation_numbers]
        if not numbers:
            return match.group(0)
        new_citation = _format_numeric_citation(numbers, citation, journal_style.in_text_format)
        separator = "" if new_citation.startswith("^") else " "
        return f"{tags}{separator}{new_citation}"

    ordered_summaries = [summary_by_key[key] for key in key_order]
    references_text = (journal_style.format_reference_list(ordered_summaries) or "").strip()
    if not references_text:
        return article_text

    normalized_body = _CITE_GROUP_RE.sub(_replace_group, body_text).rstrip()
    refs_heading = existing_refs_heading or "## References"
    return f"{normalized_body}\n\n{refs_heading}\n\n{references_text}\n"
