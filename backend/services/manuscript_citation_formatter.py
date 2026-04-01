from __future__ import annotations

import re

from services.journal_style_service import JournalStyle

_REFERENCE_HEADING_RE = re.compile(
    r"(?im)^\s*#{1,6}\s*(references|bibliography|works cited|literature cited)\s*$"
)
_CITE_GROUP_RE = re.compile(
    r"(?P<tags>(?:\[CITE:[^\]]+\]\s*)+)"
    r"(?P<citation>\[[0-9,\-\s]+\]|\([0-9,\-\s]+\)|\^[0-9,\-\s]+|\([A-Z][^)]*?\d{4}[a-z]?\))?"
)

# Evidence purpose tags AND drafting annotation tags injected by the AI.
# These are internal grounding markers that must NOT appear in the final manuscript.
# Includes: citation purpose tags (BKG, GAP, EMP, ...), sentence-bank tags (BG, ME, ...),
# drafting annotations (CK, INF, DEF, LIM, HYP, IMP, ...), and compare-sentiment tags.
_EVIDENCE_PURPOSE_TAG_RE = re.compile(
    r"\[(?:BKG|PREV|THRY|GAP|JUST|METH|ORIG|CMP|EMP|SUP"
    r"|consistent|contradicts|seminal"
    r"|BG|ME|RE|DI|CO"
    r"|CK|INF|DEF|LIM|HYP|IMP|CAV|SIG|NS)\]",
    re.IGNORECASE,
)

# Duplicate adjacent numeric citations: "[1] [1]" or "[2][2]" → keep one
_DUPLICATE_NUMERIC_CITE_RE = re.compile(
    r"(\[(\d+(?:[,\-\s]*\d+)*)\])\s*\[\2\]"
)

# Matches the Abstract heading and everything up to the next ## heading
_ABSTRACT_SECTION_RE = re.compile(
    r"(?P<before>^.*?)"
    r"(?P<heading>^#{1,6}\s*Abstract\b[^\n]*\n)"
    r"(?P<body>.*?)"
    r"(?=^#{1,6}\s|\Z)",
    re.MULTILINE | re.DOTALL | re.IGNORECASE,
)

# All citation forms: [CITE:key], [1], [1,2], (1), ^1, (Author et al., 2023)
_ANY_CITATION_RE = re.compile(
    r"\[CITE:[^\]]+\]\s*"
    r"|\[\d+(?:[,\-\s]*\d+)*\]"
    r"|\(\d+(?:[,\-\s]*\d+)*\)"
    r"|\^\d+(?:[,\s]*\d+)*"
    r"|\([A-Z][a-zA-Z]*(?:\s+(?:et\s+al\.|and\s+[A-Z][a-zA-Z]*))?[,;]\s*\d{4}[a-z]?"
    r"(?:\s*;\s*[A-Z][a-zA-Z]*(?:\s+(?:et\s+al\.|and\s+[A-Z][a-zA-Z]*))?[,;]\s*\d{4}[a-z]?)*\)"
)


def strip_evidence_purpose_tags(text: str) -> str:
    """Strip internal evidence-purpose tags that the AI leaks into the manuscript.

    Tags like [BKG], [GAP], [EMP], [THRY], [PREV], [consistent], [seminal], etc.
    are used in the prompt to guide citation placement but must not appear in the
    final output.  Also deduplicates adjacent numeric citations (e.g. "[1] [1]" → "[1]").
    """
    if not text:
        return text
    cleaned = _EVIDENCE_PURPOSE_TAG_RE.sub("", text)
    # Deduplicate adjacent identical numeric citations: [1] [1] → [1]
    cleaned = _DUPLICATE_NUMERIC_CITE_RE.sub(r"\1", cleaned)
    # Clean up leftover whitespace artifacts
    cleaned = re.sub(r"  +", " ", cleaned)
    cleaned = re.sub(r" ([.,;:)])", r"\1", cleaned)
    return cleaned


def _strip_citations_from_abstract(text: str) -> str:
    """Remove all citation markers from the Abstract section.

    Universal academic convention: abstracts must be citation-free.
    This enforces the rule programmatically after AI generation.
    """
    m = _ABSTRACT_SECTION_RE.search(text)
    if not m:
        return text

    abstract_body = m.group("body")
    cleaned = _ANY_CITATION_RE.sub("", abstract_body)
    # Clean up double spaces and space before punctuation
    cleaned = re.sub(r"  +", " ", cleaned)
    cleaned = re.sub(r" ([.,;:)])", r"\1", cleaned)

    return text[:m.start("body")] + cleaned + text[m.end("body"):]


def _norm_doi(value: str) -> str:
    """Normalize a DOI for comparison: lowercase, strip URL prefixes, trailing punctuation."""
    d = str(value or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:", "doi "):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d.rstrip("., ;)")


_DOI_IN_TEXT_RE = re.compile(r"(10\.\d{4,9}/\S+)", re.IGNORECASE)


def _extract_doi_from_text(value: str) -> str:
    match = _DOI_IN_TEXT_RE.search(str(value or ""))
    if not match:
        return ""
    return _norm_doi(match.group(1))


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


def _ordered_paper_keys_from_citation_map(stored_citation_map: dict[str, str] | None) -> list[str]:
    if not stored_citation_map:
        return []
    return _unique_preserve_order([
        _norm_key(paper_key)
        for paper_key in stored_citation_map.values()
        if _norm_key(paper_key)
    ])


def _split_references_section_parts(article_text: str) -> tuple[str, str | None, str | None]:
    match = _REFERENCE_HEADING_RE.search(article_text or "")
    if not match:
        return (article_text or "").rstrip(), None, None
    return (
        article_text[:match.start()].rstrip(),
        match.group(0).strip(),
        article_text[match.end():].strip() or None,
    )


def _split_references_section(article_text: str) -> tuple[str, str | None]:
    body_text, heading, _ = _split_references_section_parts(article_text)
    return body_text, heading


def _build_summary_by_key(summaries: list[dict]) -> dict[str, dict]:
    return {
        _norm_key(summary.get("paper_key", "")): summary
        for summary in summaries
        if _norm_key(summary.get("paper_key", ""))
    }


def _first_author_family(name: str) -> str:
    clean = str(name or "").strip()
    if not clean:
        return "Unknown"
    if "," in clean:
        return clean.split(",", 1)[0].strip() or "Unknown"
    parts = clean.split()
    return parts[-1].strip() if parts else "Unknown"


# ── Fuzzy key matching ────────────────────────────────────────────────────────


def _build_fuzzy_key_map(
    cited_keys: list[str],
    summary_by_key: dict[str, dict],
) -> dict[str, str]:
    """Build a mapping from AI-generated cited keys to actual summary paper_keys.

    Tries, in order:
      1. Exact match (already normalised to lowercase)
      2. DOI substring match (cited key appears in a paper_key DOI, or vice versa)
      3. Author+year match (e.g. 'smith2023' → summary whose first author is Smith, year 2023)
      4. Title substring match (cited key appears in the paper title)
    """
    key_map: dict[str, str] = {}
    available_keys = set(summary_by_key.keys())

    for ck in cited_keys:
        # 1. Exact match
        if ck in available_keys:
            key_map[ck] = ck
            continue

        # 2. DOI substring: cited key contains a DOI fragment or a paper_key contains cited key
        matched = False
        for pk in available_keys:
            # If the cited key is a DOI-like string that matches
            if ck in pk or pk in ck:
                key_map[ck] = pk
                matched = True
                break
        if matched:
            continue

        # 3. Author+year match: extract trailing 4-digit year and author prefix
        year_match = re.search(r'(\d{4})', ck)
        if year_match:
            year_str = year_match.group(1)
            author_part = re.sub(r'\d+', '', ck).strip().lower().rstrip('_.- ')
            if author_part:
                for pk, summary in summary_by_key.items():
                    bib = summary.get("bibliography", {}) if isinstance(summary, dict) else {}
                    s_year = str(bib.get("year", "") or "")
                    if s_year != year_str:
                        continue
                    authors = bib.get("authors", []) if isinstance(bib, dict) else []
                    if authors:
                        first_family = _first_author_family(authors[0]).lower()
                        if first_family.startswith(author_part) or author_part.startswith(first_family):
                            key_map[ck] = pk
                            matched = True
                            break
            if matched:
                continue

        # 4. Title substring match
        for pk, summary in summary_by_key.items():
            bib = summary.get("bibliography", {}) if isinstance(summary, dict) else {}
            title = _norm_key(bib.get("title", ""))
            if title and len(ck) >= 6 and ck in title:
                key_map[ck] = pk
                break

    return key_map


def _format_author_year_single(summary: dict, journal_style: JournalStyle) -> str:
    bib = summary.get("bibliography", {}) if isinstance(summary, dict) else {}
    authors = bib.get("authors", []) if isinstance(bib, dict) else []
    year = str((bib.get("year") if isinstance(bib, dict) else None) or "n.d.")

    if not authors:
        lead = str(summary.get("paper_key") or "Unknown")
    elif len(authors) == 1:
        lead = _first_author_family(authors[0])
    elif len(authors) == 2:
        conjunction = " & " if journal_style.citation_style.value == "apa" else " and "
        lead = f"{_first_author_family(authors[0])}{conjunction}{_first_author_family(authors[1])}"
    else:
        lead = f"{_first_author_family(authors[0])} et al."

    return f"{lead}, {year}"


def _format_author_year_group(
    keys: list[str],
    summary_by_key: dict[str, dict],
    journal_style: JournalStyle,
    existing: str = "",
    key_map: dict[str, str] | None = None,
) -> str:
    resolved_keys = [
        (key_map or {}).get(key, key)
        for key in keys
    ]
    citations = [
        _format_author_year_single(summary_by_key[rk], journal_style)
        for rk in resolved_keys
        if rk in summary_by_key
    ]
    if not citations:
        return existing or ""
    return f"({'; '.join(citations)})"


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
    # Strip evidence purpose tags BEFORE any processing so [CITE:key][GAP] [1]
    # becomes [CITE:key] [1] — a clean pattern the regex can handle.
    article_text = strip_evidence_purpose_tags(article_text)

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

    summary_by_key = _build_summary_by_key(summaries)

    # Build fuzzy mapping for keys that don't exactly match
    fuzzy_map = _build_fuzzy_key_map(key_order, summary_by_key)

    # Resolve keys through fuzzy map
    resolved_order = [fuzzy_map.get(k, k) for k in key_order]
    matched_order = [k for k in resolved_order if k in summary_by_key]

    if not matched_order:
        # No keys matched even with fuzzy matching — return unchanged
        return article_text

    # Only assign numbers to keys that resolve to actual summaries
    # so citation count matches reference count
    matched_key_order: list[str] = []
    seen_resolved: set[str] = set()
    for k in key_order:
        rk = fuzzy_map.get(k, k)
        if rk in summary_by_key and rk not in seen_resolved:
            seen_resolved.add(rk)
            matched_key_order.append(k)

    citation_numbers: dict[str, int] = {
        key: idx for idx, key in enumerate(matched_key_order, 1)
    }

    def _replace_group(match: re.Match[str]) -> str:
        keys = _extract_group_keys(match.group("tags"))
        if not keys:
            return match.group(0)
        numbers = [citation_numbers[key] for key in keys if key in citation_numbers]
        if not numbers:
            # Unresolved key — keep the tags but strip trailing number
            return match.group("tags")
        # PRESERVE [CITE:key] markers — only strip at export time
        tags = match.group("tags")
        num_str = _format_numeric_citation(numbers, match.group("citation") or "", journal_style.in_text_format)
        return f"{tags}{num_str}"

    # Build references from matched summaries in order of appearance
    ordered_summaries = [
        summary_by_key[fuzzy_map.get(k, k)] for k in matched_key_order
    ]

    references_text = (journal_style.format_reference_list(ordered_summaries) or "").strip()
    if not references_text:
        return article_text

    normalized_body = _CITE_GROUP_RE.sub(_replace_group, body_text)
    # Clean up artifacts from stripped unresolved markers
    normalized_body = re.sub(r"  +", " ", normalized_body)
    normalized_body = re.sub(r" ([.,;:)])", r"\1", normalized_body).rstrip()
    refs_heading = existing_refs_heading or "## References"
    result = f"{normalized_body}\n\n{refs_heading}\n\n{references_text}\n"
    return _strip_citations_from_abstract(result)


def build_citation_map(article_text: str, summaries: list[dict]) -> dict[str, str]:
    """Build a {cited_key: paper_key} mapping from the manuscript text.

    Used to persist alongside the article so the sidebar can resolve
    references even after [CITE:key] markers are stripped.
    """
    body_text, _ = _split_references_section(article_text)
    summary_by_key = _build_summary_by_key(summaries)
    cited_keys = _collect_cited_keys(article_text)
    if not cited_keys:
        return {}
    fuzzy_map = _build_fuzzy_key_map(cited_keys, summary_by_key)
    # Only include keys that actually resolved
    return {ck: rk for ck, rk in fuzzy_map.items() if rk in summary_by_key}


def _collect_cited_keys(article_text: str) -> list[str]:
    body_text, _ = _split_references_section(article_text)
    key_order: list[str] = []
    seen_keys: set[str] = set()
    for match in _CITE_GROUP_RE.finditer(body_text):
        for key in _extract_group_keys(match.group("tags")):
            if key not in seen_keys:
                seen_keys.add(key)
                key_order.append(key)
    return key_order


def finalize_manuscript_for_export(
    article_text: str,
    journal_style: JournalStyle,
    summaries: list[dict],
) -> str:
    """
    Return an export-ready manuscript:
    - resolve numeric citations/reference ordering where supported
    - strip internal [CITE:key] grounding markers
    - rebuild / preserve a References section from cited summaries
    """
    if not article_text.strip():
        return article_text

    # Strip any leaked evidence purpose tags before export
    article_text = strip_evidence_purpose_tags(article_text)

    body_text, existing_refs_heading, existing_refs_body = _split_references_section_parts(article_text)
    cited_keys = _collect_cited_keys(article_text)
    summary_by_key = _build_summary_by_key(summaries)

    # Build fuzzy mapping for keys that don't exactly match
    fuzzy_map = _build_fuzzy_key_map(cited_keys, summary_by_key) if cited_keys else {}

    # Build the list of keys that actually resolve (for numbering)
    matched_key_order: list[str] = []
    seen_matched: set[str] = set()
    for ck in cited_keys:
        rk = fuzzy_map.get(ck, ck)
        if rk in summary_by_key and rk not in seen_matched:
            seen_matched.add(rk)
            matched_key_order.append(ck)

    resolved_body = body_text
    if cited_keys:
        if journal_style.in_text_format == "author_year":
            def _replace_author_year_group(match: re.Match[str]) -> str:
                keys = _extract_group_keys(match.group("tags"))
                result = _format_author_year_group(
                    keys=keys,
                    summary_by_key=summary_by_key,
                    journal_style=journal_style,
                    existing=(match.group("citation") or "").strip(),
                    key_map=fuzzy_map,
                )
                # If none resolved, strip the marker entirely
                return result if result else ""

            resolved_body = _CITE_GROUP_RE.sub(_replace_author_year_group, body_text).rstrip()
        else:
            # Only number keys that resolve to summaries
            citation_numbers = {key: idx for idx, key in enumerate(matched_key_order, 1)}

            def _replace_numeric_group(match: re.Match[str]) -> str:
                keys = _extract_group_keys(match.group("tags"))
                numbers = [citation_numbers[key] for key in keys if key in citation_numbers]
                if not numbers:
                    # Unresolved key — strip marker + trailing number
                    return ""
                return _format_numeric_citation(
                    numbers,
                    match.group("citation") or "",
                    journal_style.in_text_format,
                )

            resolved_body = _CITE_GROUP_RE.sub(_replace_numeric_group, body_text).rstrip()

    cleaned_body = re.sub(r"\[CITE:[^\]]+\]\s*", "", resolved_body)
    # Clean up double spaces left after stripping unresolved markers
    cleaned_body = re.sub(r"  +", " ", cleaned_body)
    # Clean up space before punctuation (e.g. "text ." → "text.")
    cleaned_body = re.sub(r" ([.,;:)])", r"\1", cleaned_body).rstrip()

    # Determine the best references text to use
    refs_text_final: str | None = None

    if cited_keys:
        cited_summaries = [
            summary_by_key[fuzzy_map.get(k, k)] for k in matched_key_order
        ]
        if cited_summaries:
            refs_text_final = (journal_style.format_reference_list(cited_summaries) or "").strip() or None

    # Fall back to existing references if we couldn't build new ones
    if not refs_text_final and existing_refs_body:
        refs_text_final = existing_refs_body

    if refs_text_final:
        refs_heading = existing_refs_heading or "## References"
        result = f"{cleaned_body}\n\n{refs_heading}\n\n{refs_text_final}\n"
    else:
        result = cleaned_body

    # Universal rule: abstracts must be citation-free
    return _strip_citations_from_abstract(result)


# ── Citation analysis (for sidebar / integrity checks) ───────────────────────

_SECTION_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)", re.MULTILINE)


def _detect_section(article_text: str, position: int) -> str:
    """Return the section heading that contains the given character position."""
    last_heading = "Body"
    for m in _SECTION_HEADING_RE.finditer(article_text):
        if m.start() > position:
            break
        last_heading = m.group(1).strip()
    return last_heading


_NUMERIC_CITE_RE = re.compile(r"\[(\d+(?:\s*[,;\-]\s*\d+)*)\]")
_INLINE_NUMERIC_CITATION_RE = re.compile(
    r"\[(\d+(?:\s*[,;\-\u2013]\s*\d+)*)\]"
    r"|\((\d+(?:\s*[,;\-\u2013]\s*\d+)*)\)"
    r"|\^(\d+(?:\s*[,;\-\u2013]\s*\d+)*)"
)
_REF_LINE_RE = re.compile(r"^\s*(\d+)\.\s*(.+)", re.MULTILINE)


def _parse_numeric_citation_numbers(raw_numbers: str) -> list[int]:
    numbers: list[int] = []
    for part in re.split(r"[,;]\s*", raw_numbers or ""):
        part = part.strip()
        if not part:
            continue
        range_m = re.match(r"(\d+)\s*[-\u2013]\s*(\d+)", part)
        if range_m:
            start = int(range_m.group(1))
            end = int(range_m.group(2))
            if start <= end:
                numbers.extend(range(start, end + 1))
            else:
                numbers.extend(range(start, end - 1, -1))
        elif part.isdigit():
            numbers.append(int(part))
    return numbers


def reinject_citation_markers(
    article_text: str,
    stored_citation_map: dict[str, str] | None = None,
) -> str:
    """Restore [CITE:key] markers into numeric-only manuscripts using a stored citation map."""
    if not article_text.strip() or "[CITE:" in article_text or not stored_citation_map:
        return article_text

    body_text, refs_heading, refs_body = _split_references_section_parts(article_text)
    ordered_pks = _ordered_paper_keys_from_citation_map(stored_citation_map)
    if not ordered_pks:
        return article_text

    changed = False

    def _replace_numeric(match: re.Match[str]) -> str:
        nonlocal changed
        raw_numbers = next((group for group in match.groups() if group), "")
        mapped_keys = _unique_preserve_order([
            ordered_pks[number - 1]
            for number in _parse_numeric_citation_numbers(raw_numbers)
            if 0 < number <= len(ordered_pks)
        ])
        if not mapped_keys:
            return match.group(0)
        changed = True
        tags = " ".join(f"[CITE:{paper_key}]" for paper_key in mapped_keys)
        return f"{tags} {match.group(0)}"

    reinjected_body = _INLINE_NUMERIC_CITATION_RE.sub(_replace_numeric, body_text)
    if not changed:
        return article_text

    if not refs_heading:
        return reinjected_body

    if refs_body:
        return f"{reinjected_body}\n\n{refs_heading}\n\n{refs_body}\n"
    return f"{reinjected_body}\n\n{refs_heading}\n"


def _analyze_numeric_fallback(
    body_text: str,
    article_text: str,
    summaries: list[dict],
    summary_by_key: dict[str, dict],
    *,
    stored_citation_map: dict[str, str] | None = None,
) -> dict:
    """Fallback analysis for manuscripts with only numeric [N] citations (no [CITE:key] markers).

    Extracts citation numbers from the body, parses the References section,
    and matches references to paper summaries by DOI or title.
    """
    # Collect all numeric citation numbers from body
    all_numbers: set[int] = set()
    number_occurrences: dict[int, int] = {}
    number_positions: dict[int, int] = {}

    for m in _NUMERIC_CITE_RE.finditer(body_text):
        for n in _parse_numeric_citation_numbers(m.group(1)):
            all_numbers.add(n)
            number_occurrences[n] = number_occurrences.get(n, 0) + 1
            if n not in number_positions:
                number_positions[n] = m.start()

    if not all_numbers:
        all_keys = set(summary_by_key.keys())
        return {
            "citations": [],
            "summary": {
                "total": 0, "resolved": 0, "fuzzy_matched": 0, "unresolved": 0,
                "uncited_count": len(all_keys), "uncited_keys": sorted(all_keys)[:50],
            },
        }

    # Parse References section to get ref_number → text mapping
    _, refs_heading, refs_body = _split_references_section_parts(article_text)
    ref_texts: dict[int, str] = {}
    if refs_body:
        for m in _REF_LINE_RE.finditer(refs_body):
            ref_texts[int(m.group(1))] = m.group(2).strip()

    # Match references to summaries by stored map, DOI, title, or author+year
    ref_to_summary: dict[int, str] = {}

    # Strategy 0: Use stored citation_map if available
    # The stored map has {cite_key: paper_key} in order of first appearance
    # ref 1 = first unique cite_key, ref 2 = second, etc.
    if stored_citation_map:
        ordered_pks = _ordered_paper_keys_from_citation_map(stored_citation_map)
        for ref_num in sorted(all_numbers):
            idx = ref_num - 1  # 1-indexed → 0-indexed
            if 0 <= idx < len(ordered_pks) and ordered_pks[idx] in summary_by_key:
                ref_to_summary[ref_num] = ordered_pks[idx]

    # Build lookup helpers from summaries
    doi_to_pk: dict[str, str] = {}
    for pk, s in summary_by_key.items():
        bib = s.get("bibliography", {}) if isinstance(s, dict) else {}
        doi = _norm_doi(bib.get("doi") or pk)
        if doi:
            doi_to_pk[doi] = pk

    for ref_num, ref_line in ref_texts.items():
        ref_lower = ref_line.lower()

        # Strategy 1: DOI match (normalized)
        ref_doi = _extract_doi_from_text(ref_line)
        if ref_doi:
            if ref_doi in doi_to_pk:
                ref_to_summary[ref_num] = doi_to_pk[ref_doi]
                continue
            # Substring fallback for DOI
            for norm_doi, pk in doi_to_pk.items():
                if ref_doi in norm_doi or norm_doi in ref_doi:
                    ref_to_summary[ref_num] = pk
                    break
        if ref_num in ref_to_summary:
            continue

        # Strategy 2: Title match (first 30+ chars)
        for pk, s in summary_by_key.items():
            bib = s.get("bibliography", {}) if isinstance(s, dict) else {}
            title = (bib.get("title") or "").lower().strip()
            if title and len(title) > 10:
                # Check multiple title fragments
                if title[:30] in ref_lower or ref_lower[:80].find(title[:25]) >= 0:
                    ref_to_summary[ref_num] = pk
                    break
        if ref_num in ref_to_summary:
            continue

        # Strategy 3: Author + year match
        for pk, s in summary_by_key.items():
            if pk in ref_to_summary.values():
                continue  # already matched
            bib = s.get("bibliography", {}) if isinstance(s, dict) else {}
            authors = bib.get("authors", []) if isinstance(bib, dict) else []
            year = str(bib.get("year", ""))
            if not year or not authors:
                continue
            first_family = _first_author_family(authors[0]).lower()
            if len(first_family) >= 3 and first_family in ref_lower and year in ref_line:
                ref_to_summary[ref_num] = pk
                break

    # Build citation entries
    citations: list[dict] = []
    matched_pks: set[str] = set()

    for n in sorted(all_numbers):
        pk = ref_to_summary.get(n)
        if pk and pk in summary_by_key:
            matched_pks.add(pk)
            bib = summary_by_key[pk].get("bibliography", {})
            citations.append({
                "cited_key": f"[{n}]",
                "resolved_key": pk,
                "ref_number": n,
                "status": "resolved",
                "match_method": "reference_section",
                "occurrences": number_occurrences.get(n, 1),
                "first_section": _detect_section(body_text, number_positions.get(n, 0)),
                "bibliography": dict(bib),
            })
        elif n in ref_texts:
            # Reference exists in list but couldn't match to a summary — show ref text
            citations.append({
                "cited_key": f"[{n}]",
                "resolved_key": None,
                "ref_number": n,
                "status": "fuzzy_matched",
                "match_method": "reference_text_only",
                "occurrences": number_occurrences.get(n, 1),
                "first_section": _detect_section(body_text, number_positions.get(n, 0)),
                "bibliography": _parse_ref_line_to_bib(ref_texts[n]),
            })
        else:
            citations.append({
                "cited_key": f"[{n}]",
                "resolved_key": None,
                "ref_number": n,
                "status": "unresolved",
                "match_method": None,
                "occurrences": number_occurrences.get(n, 1),
                "first_section": _detect_section(body_text, number_positions.get(n, 0)),
                "bibliography": None,
            })

    uncited_keys = sorted(k for k in summary_by_key if k not in matched_pks)
    resolved = sum(1 for c in citations if c["status"] == "resolved")
    fuzzy = sum(1 for c in citations if c["status"] == "fuzzy_matched")
    unresolved = sum(1 for c in citations if c["status"] == "unresolved")

    return {
        "citations": citations,
        "summary": {
            "total": len(citations), "resolved": resolved,
            "fuzzy_matched": fuzzy, "unresolved": unresolved,
            "uncited_count": len(uncited_keys), "uncited_keys": uncited_keys[:50],
        },
    }


def _parse_ref_line_to_bib(ref_line: str) -> dict:
    """Best-effort parse of a reference line into bibliography fields."""
    bib: dict = {"title": "", "authors": [], "year": None, "journal": None, "doi": None}
    # Extract year
    year_m = re.search(r"((?:19|20)\d{2})", ref_line)
    if year_m:
        bib["year"] = int(year_m.group(1))
    # Extract DOI
    doi = _extract_doi_from_text(ref_line)
    if doi:
        bib["doi"] = doi
    # Title is usually the longest segment — rough heuristic: text after authors, before journal
    # Just store the whole line as title for display
    bib["title"] = ref_line[:120]
    return bib


def analyze_citation_status(
    article_text: str,
    summaries: list[dict],
    *,
    stored_citation_map: dict[str, str] | None = None,
) -> dict:
    """Analyse the citation status of a manuscript.

    Returns a dict with:
      citations — per-key detail (status, match method, occurrences, bibliography)
      summary   — aggregate counts (total, resolved, fuzzy, unresolved, uncited)
    """
    if not article_text.strip():
        return {"citations": [], "summary": _empty_summary()}

    body_text, _ = _split_references_section(article_text)
    summary_by_key = _build_summary_by_key(summaries)

    # Collect all cited keys in order with occurrence counts and first position
    key_order: list[str] = []
    seen_keys: set[str] = set()
    occurrence_count: dict[str, int] = {}
    first_position: dict[str, int] = {}

    for m in _CITE_GROUP_RE.finditer(body_text):
        for key in _extract_group_keys(m.group("tags")):
            occurrence_count[key] = occurrence_count.get(key, 0) + 1
            if key not in seen_keys:
                seen_keys.add(key)
                key_order.append(key)
                first_position[key] = m.start()

    if not key_order:
        # Fallback: parse numeric [N] citations from manuscripts that already lost [CITE:key] markers
        return _analyze_numeric_fallback(
            body_text, article_text, summaries, summary_by_key,
            stored_citation_map=stored_citation_map,
        )

    # Build fuzzy map with match-method tracking
    fuzzy_map: dict[str, str] = {}
    match_methods: dict[str, str] = {}
    available_keys = set(summary_by_key.keys())

    for ck in key_order:
        if ck in available_keys:
            fuzzy_map[ck] = ck
            match_methods[ck] = "exact"
            continue

        # DOI substring
        matched = False
        for pk in available_keys:
            if ck in pk or pk in ck:
                fuzzy_map[ck] = pk
                match_methods[ck] = "doi_substring"
                matched = True
                break
        if matched:
            continue

        # Author+year
        year_match = re.search(r"(\d{4})", ck)
        if year_match:
            year_str = year_match.group(1)
            author_part = re.sub(r"\d+", "", ck).strip().lower().rstrip("_.- ")
            if author_part:
                for pk, s in summary_by_key.items():
                    bib = s.get("bibliography", {}) if isinstance(s, dict) else {}
                    if str(bib.get("year", "")) != year_str:
                        continue
                    authors = bib.get("authors", []) if isinstance(bib, dict) else []
                    if authors:
                        ff = _first_author_family(authors[0]).lower()
                        if ff.startswith(author_part) or author_part.startswith(ff):
                            fuzzy_map[ck] = pk
                            match_methods[ck] = "author_year"
                            matched = True
                            break
            if matched:
                continue

        # Title substring
        for pk, s in summary_by_key.items():
            bib = s.get("bibliography", {}) if isinstance(s, dict) else {}
            title = _norm_key(bib.get("title", ""))
            if title and len(ck) >= 6 and ck in title:
                fuzzy_map[ck] = pk
                match_methods[ck] = "title_substring"
                break

    # Build citation entries
    resolved_paper_keys: set[str] = set()
    citations: list[dict] = []
    ref_number = 0

    for ck in key_order:
        rk = fuzzy_map.get(ck)
        if rk and rk in summary_by_key:
            if rk not in resolved_paper_keys:
                ref_number += 1
                resolved_paper_keys.add(rk)
            status = "resolved" if match_methods.get(ck) == "exact" else "fuzzy_matched"
            bib = summary_by_key[rk].get("bibliography", {})
        else:
            status = "unresolved"
            bib = None

        citations.append({
            "cited_key": ck,
            "resolved_key": rk if rk and rk in summary_by_key else None,
            "ref_number": ref_number if status != "unresolved" else None,
            "status": status,
            "match_method": match_methods.get(ck),
            "occurrences": occurrence_count.get(ck, 1),
            "first_section": _detect_section(body_text, first_position.get(ck, 0)),
            "bibliography": dict(bib) if bib else None,
        })

    # Find uncited summaries
    cited_paper_keys = set(fuzzy_map.values())
    uncited_keys = sorted(k for k in summary_by_key if k not in cited_paper_keys)

    resolved_count = sum(1 for c in citations if c["status"] == "resolved")
    fuzzy_count = sum(1 for c in citations if c["status"] == "fuzzy_matched")
    unresolved_count = sum(1 for c in citations if c["status"] == "unresolved")

    return {
        "citations": citations,
        "summary": {
            "total": len(citations),
            "resolved": resolved_count,
            "fuzzy_matched": fuzzy_count,
            "unresolved": unresolved_count,
            "uncited_count": len(uncited_keys),
            "uncited_keys": uncited_keys[:50],
        },
    }


def _empty_summary() -> dict:
    return {
        "total": 0,
        "resolved": 0,
        "fuzzy_matched": 0,
        "unresolved": 0,
        "uncited_count": 0,
        "uncited_keys": [],
    }
