"""
services/manuscript_utils.py

Shared helpers for manuscript processing used by peer_reviewer, revision_writer,
and real_revision_writer.

Public API
----------
number_lines(text) → str
build_section_index(text) → list[dict]
build_section_index_header(section_index) → str
build_full_manuscript_context(text, summary, section_index) → str
build_compact_evidence(summaries, max_papers, max_results, max_limitations) → list[dict]
apply_manuscript_changes(manuscript, all_changes) → tuple[str, list, list]
audit_revision(original, revised) → dict
"""

from __future__ import annotations

import bisect
import json
import logging
import re
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from models import PaperSummary


# ── Line numbering ────────────────────────────────────────────────────────────

def number_lines(text: str, start_line: int = 1) -> str:
    """Prepend 4-digit line numbers so the AI can cite 'Lines 45–52'."""
    return "\n".join(f"{start_line + i:4d}  {line}" for i, line in enumerate(text.splitlines()))


# ── Section index builder ─────────────────────────────────────────────────────

def build_section_index(text: str) -> list[dict]:
    """Scan a markdown manuscript for ## headings and return a section-to-line-range map.

    Returns:
        [{"name": "Introduction", "start_line": 5, "end_line": 42}, ...]
    """
    lines = text.splitlines()
    sections: list[dict] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## "):
            name = stripped.lstrip("# ").strip()
            if sections:
                sections[-1]["end_line"] = i  # previous section ends here
            sections.append({"name": name, "start_line": i + 1, "end_line": len(lines)})
    # Also capture the title (# heading) as first section if present
    if not sections:
        # No ## headings found — treat entire document as one section
        sections.append({"name": "Manuscript", "start_line": 1, "end_line": len(lines)})
    return sections


def build_section_index_header(section_index: list[dict] | None) -> str:
    """Build a compact section-to-line-range map for AI structural awareness."""
    if not section_index:
        return ""
    lines = ["MANUSCRIPT STRUCTURE:"]
    for s in section_index:
        lines.append(f"  {s['name']}: Lines {s['start_line']}–{s['end_line']}")
    return "\n".join(lines)


def build_full_manuscript_context(
    manuscript_text: str,
    manuscript_summary: str = "",
    section_index: list[dict] | None = None,
) -> str:
    """Build the full manuscript context: summary + section index + line-numbered text.

    No truncation — the full manuscript is included.
    """
    if section_index is None:
        section_index = build_section_index(manuscript_text)
    parts: list[str] = []
    if manuscript_summary:
        parts.append(f"MANUSCRIPT SUMMARY:\n{manuscript_summary}")
    idx_header = build_section_index_header(section_index)
    if idx_header:
        parts.append(idx_header)
    numbered = number_lines(manuscript_text)
    parts.append(f"FULL LINE-NUMBERED MANUSCRIPT:\n---\n{numbered}\n---")
    return "\n\n".join(parts)


def manuscript_appears_truncated(text: str) -> bool:
    """Return True only when the manuscript body appears genuinely truncated."""
    if not text or not text.strip():
        return True
    stripped = text.rstrip()

    refs_match = re.search(r"(?im)^\s*#{1,6}\s*(references|bibliography)", stripped)
    if not refs_match:
        return len(stripped.split()) > 500

    body = stripped[:refs_match.start()].rstrip()
    if not body:
        return False

    body_lines = [line for line in body.splitlines() if line.strip()]
    if not body_lines:
        return False

    last_line = body_lines[-1].strip()
    if last_line.startswith("#") or not last_line:
        return False

    cleaned_last = re.sub(r"\[CITE:[^\]]+\]\s*", "", last_line)
    cleaned_last = re.sub(r"\[\d+(?:[,\-\s]*\d+)*\]\s*", "", cleaned_last)
    cleaned_last = re.sub(r"\s+$", "", cleaned_last)
    if not cleaned_last:
        return False

    last_char = cleaned_last[-1]
    if last_char in '.!?):"\'':
        return False

    if last_char == "," or (last_char.isalpha() and not cleaned_last.endswith("etc")):
        return True

    return False


def extract_section_slices(
    manuscript_text: str,
    section_index: list[dict] | None = None,
) -> list[dict]:
    """Return exact section slices with line and character spans."""
    if section_index is None:
        section_index = build_section_index(manuscript_text)
    line_starts = _line_start_offsets(manuscript_text)
    sections: list[dict] = []
    total_lines = len(manuscript_text.splitlines()) or 1
    for i, sec in enumerate(section_index or []):
        start_line = int(sec.get("start_line", 1) or 1)
        end_line = int(sec.get("end_line", total_lines) or total_lines)
        start_char = _line_start_char(line_starts, start_line)
        end_char = _line_end_char(line_starts, end_line, len(manuscript_text))
        text = manuscript_text[start_char:end_char]
        sections.append({
            "section": str(sec.get("name", "Manuscript") or "Manuscript"),
            "start_line": start_line,
            "end_line": end_line,
            "start_char": start_char,
            "end_char": end_char,
            "text": text,
            "section_index": i,
        })
    return sections


def build_manuscript_chunks(
    manuscript_text: str,
    *,
    section_index: list[dict] | None = None,
    max_chars: int = 12000,
    overlap_paragraphs: int = 1,
) -> list[dict]:
    """Split a manuscript into section-aware chunks without raw prefix truncation.

    Chunking order:
    1. keep full section when it fits;
    2. otherwise split on full paragraphs;
    3. advance in paragraph windows with overlap.
    """
    if section_index is None:
        section_index = build_section_index(manuscript_text)

    chunks: list[dict] = []
    chunk_id = 1
    for section in extract_section_slices(manuscript_text, section_index):
        paragraphs = _build_paragraph_index(section["text"], section_name=section["section"], base_line=section["start_line"], base_char=section["start_char"])
        if not paragraphs:
            continue

        if len(section["text"]) <= max_chars:
            chunks.append(_make_chunk(chunk_id, manuscript_text, section["section"], paragraphs, section["section_index"]))
            chunk_id += 1
            continue

        start_idx = 0
        while start_idx < len(paragraphs):
            end_idx = start_idx + 1
            while end_idx < len(paragraphs):
                candidate_len = paragraphs[end_idx]["end_char"] - paragraphs[start_idx]["start_char"]
                if candidate_len > max_chars:
                    break
                end_idx += 1
            if end_idx == start_idx:
                end_idx = start_idx + 1
            chunk_paragraphs = paragraphs[start_idx:end_idx]
            chunks.append(_make_chunk(chunk_id, manuscript_text, section["section"], chunk_paragraphs, section["section_index"]))
            chunk_id += 1
            if end_idx >= len(paragraphs):
                break
            next_start = max(end_idx - max(1, overlap_paragraphs), start_idx + 1)
            start_idx = next_start

    return chunks


def build_chunk_context(chunk: dict, *, label: str = "MANUSCRIPT CHUNK") -> str:
    """Format one chunk with global line numbers and span metadata."""
    header = (
        f"{label}:\n"
        f"- section: {chunk.get('section', 'Manuscript')}\n"
        f"- lines: {chunk.get('start_line', 1)}-{chunk.get('end_line', 1)}\n"
        f"- paragraphs: {chunk.get('paragraph_start', 1)}-{chunk.get('paragraph_end', 1)}\n"
        f"- chars: {chunk.get('start_char', 0)}-{chunk.get('end_char', 0)}"
    )
    body = number_lines(str(chunk.get("text", "")), start_line=int(chunk.get("start_line", 1) or 1))
    return f"{header}\n---\n{body}\n---"


def locate_text_span(
    manuscript_text: str,
    passage: str,
    *,
    section_index: list[dict] | None = None,
) -> dict | None:
    """Locate an exact passage in the manuscript and return span metadata."""
    if not passage:
        return None
    actual = passage
    pos = manuscript_text.find(actual)
    if pos == -1:
        stripped = _strip_line_numbers(actual)
        if stripped != actual:
            pos = manuscript_text.find(stripped)
            if pos != -1:
                actual = stripped
    if pos == -1:
        return None

    line_starts = _line_start_offsets(manuscript_text)
    start_line = _offset_to_line(line_starts, pos)
    end_line = _offset_to_line(line_starts, pos + len(actual))
    section = _section_for_line(section_index or build_section_index(manuscript_text), start_line)
    return {
        "text": actual,
        "start_char": pos,
        "end_char": pos + len(actual),
        "start_line": start_line,
        "end_line": end_line,
        "section": section,
    }


def validate_change_operations(
    manuscript_text: str,
    operations: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Split edit operations into safe and unsafe sets.

    Unsafe operations are exact-match failures or partial-span matches that cut
    through a token boundary in the live manuscript.
    """
    safe_ops: list[dict] = []
    unsafe_ops: list[dict] = []
    for op in operations:
        op_type = str(op.get("type", "")).strip()
        target = str(op.get("find", "") or op.get("anchor", "")).strip()
        if op_type not in {"replace", "insert_after", "delete"} or not target:
            unsafe_ops.append({**op, "reason": "invalid operation"})
            continue
        span = locate_text_span(manuscript_text, target)
        if not span:
            unsafe_ops.append({**op, "reason": "target not found"})
            continue
        if not is_complete_match_span(manuscript_text, span["start_char"], span["end_char"]):
            unsafe_ops.append({**op, "reason": "target is an unsafe partial-span match"})
            continue
        safe_ops.append(op)
    return safe_ops, unsafe_ops


def is_complete_match_span(manuscript_text: str, start_char: int, end_char: int) -> bool:
    """Return False when a span clearly cuts through a word token."""
    if start_char < 0 or end_char < start_char or end_char > len(manuscript_text):
        return False
    prev_char = manuscript_text[start_char - 1] if start_char > 0 else ""
    next_char = manuscript_text[end_char] if end_char < len(manuscript_text) else ""
    first_char = manuscript_text[start_char] if start_char < len(manuscript_text) else ""
    last_char = manuscript_text[end_char - 1] if end_char > 0 else ""
    if prev_char.isalnum() and first_char.isalnum():
        return False
    if next_char.isalnum() and last_char.isalnum():
        return False
    return True


def build_relevant_passage_context(
    manuscript_text: str,
    passages: list[str],
    *,
    section_index: list[dict] | None = None,
    neighbor_paragraphs: int = 1,
    heading: str = "RELEVANT MANUSCRIPT EXCERPTS",
) -> str:
    """Build global-line-numbered excerpts around relevant passages."""
    paragraph_index = _build_paragraph_index(manuscript_text, section_name="", base_line=1, base_char=0, section_index=section_index)
    if not paragraph_index:
        return f"{heading}:\n(not available)"

    ranges: list[tuple[int, int]] = []
    for passage in passages:
        span = locate_text_span(manuscript_text, passage, section_index=section_index)
        if not span:
            continue
        para_idx = _paragraph_index_for_char(paragraph_index, span["start_char"])
        start_idx = max(0, para_idx - max(0, neighbor_paragraphs))
        end_idx = min(len(paragraph_index), para_idx + neighbor_paragraphs + 1)
        ranges.append((start_idx, end_idx))

    if not ranges:
        return build_full_manuscript_context(manuscript_text, section_index=section_index)

    merged = _merge_ranges(ranges)
    parts = [heading]
    for start_idx, end_idx in merged:
        excerpt = paragraph_index[start_idx:end_idx]
        start_char = excerpt[0]["start_char"]
        end_char = excerpt[-1]["end_char"]
        start_line = excerpt[0]["start_line"]
        end_line = excerpt[-1]["end_line"]
        section_name = excerpt[0]["section"] or "Manuscript"
        chunk_text = manuscript_text[start_char:end_char]
        parts.append(
            f"SECTION: {section_name}\n"
            f"LINES: {start_line}-{end_line}\n"
            f"CHARS: {start_char}-{end_char}\n"
            "---\n"
            f"{number_lines(chunk_text, start_line=start_line)}\n"
            "---"
        )
    return "\n\n".join(parts)


def build_manuscript_chunk_coverage_context(
    manuscript_text: str,
    *,
    section_index: list[dict] | None = None,
    max_chars: int = 12000,
    overlap_paragraphs: int = 1,
) -> list[str]:
    """Return formatted contexts for full-manuscript chunk coverage."""
    return [
        build_chunk_context(chunk)
        for chunk in build_manuscript_chunks(
            manuscript_text,
            section_index=section_index,
            max_chars=max_chars,
            overlap_paragraphs=overlap_paragraphs,
        )
    ]


# ── Compact evidence builder ─────────────────────────────────────────────────

def build_compact_evidence(
    summaries: list,
    max_papers: int = 30,
    max_results: int = 6,
    max_limitations: int = 5,
) -> list[dict]:
    """Build a compact evidence representation for prompts.

    Uses globally unique evidence IDs: {paper_key}::result_{i}
    """
    evidence = []
    for s in summaries[:max_papers]:
        # Handle both PaperSummary objects and dicts
        if hasattr(s, "paper_key"):
            paper_key = s.paper_key
            study_design = s.methods.study_design
            sample_n = s.methods.sample_n
            evidence_grade = s.critical_appraisal.evidence_grade
            selection_bias = s.critical_appraisal.selection_bias
            results = s.results[:max_results]
            limitations = s.limitations[:max_limitations]
            missing_info = s.missing_info[:max_limitations]
        else:
            paper_key = s.get("paper_key", "")
            methods = s.get("methods", {})
            study_design = methods.get("study_design", "")
            sample_n = methods.get("sample_n", "")
            ca = s.get("critical_appraisal", {})
            evidence_grade = ca.get("evidence_grade", "")
            selection_bias = ca.get("selection_bias", "")
            results = s.get("results", [])[:max_results]
            limitations = s.get("limitations", [])[:max_limitations]
            missing_info = s.get("missing_info", [])[:max_limitations]

        result_items = []
        for i, r in enumerate(results):
            if hasattr(r, "outcome"):
                result_items.append({
                    "id": f"{paper_key}::result_{i}",
                    "outcome": r.outcome,
                    "finding": getattr(r, "finding", ""),
                    "effect_size": r.effect_size,
                    "ci_95": r.ci_95,
                    "p_value": r.p_value,
                    "claim_type": r.claim_type,
                    "quote": r.supporting_quote,
                })
            else:
                result_items.append({
                    "id": f"{paper_key}::result_{i}",
                    "outcome": r.get("outcome", ""),
                    "finding": r.get("finding", ""),
                    "effect_size": r.get("effect_size", ""),
                    "ci_95": r.get("ci_95", ""),
                    "p_value": r.get("p_value", ""),
                    "claim_type": r.get("claim_type", ""),
                    "quote": r.get("supporting_quote", ""),
                })

        evidence.append({
            "paper_key": paper_key,
            "study_design": study_design,
            "sample_n": sample_n,
            "evidence_grade": evidence_grade,
            "selection_bias": selection_bias,
            "results": result_items,
            "limitations": limitations if isinstance(limitations, list) else [],
            "missing_info": missing_info if isinstance(missing_info, list) else [],
        })

    return evidence


# ── Manuscript packs extraction ───────────────────────────────────────────────

def extract_manuscript_packs(session: dict) -> dict | None:
    """Extract manuscript packs from a project/session dict.

    Checks synthesis_result then deep_synthesis_result for manuscript_packs.
    This logic was previously inlined in article_builder.build_article_prompt().
    """
    manuscript_packs = None

    synthesis_result = session.get("synthesis_result")
    if isinstance(synthesis_result, str):
        try:
            synthesis_result = json.loads(synthesis_result)
        except (ValueError, TypeError):
            synthesis_result = None
    if isinstance(synthesis_result, dict):
        manuscript_packs = synthesis_result.get("manuscript_packs")

    deep_result = session.get("deep_synthesis_result")
    if isinstance(deep_result, str):
        try:
            deep_result = json.loads(deep_result)
        except (ValueError, TypeError):
            deep_result = None
    if isinstance(deep_result, dict) and deep_result.get("manuscript_packs"):
        manuscript_packs = deep_result["manuscript_packs"]

    return manuscript_packs


# ── Deterministic manuscript change application ──────────────────────────────

def apply_manuscript_changes(
    manuscript: str,
    all_changes: list[dict],
) -> tuple[str, list[dict], list[dict]]:
    """Apply manuscript_changes operations deterministically.

    Each operation is one of:
      {"type": "replace", "find": "exact text", "replace_with": "new text"}
      {"type": "insert_after", "anchor": "exact text", "text": "new text"}
      {"type": "delete", "find": "exact text"}

    Operations are sorted by position (bottom-to-top) to prevent earlier edits
    from shifting the positions of later ones. Fuzzy matching is NOT used —
    only exact match and line-number-stripped match.

    Returns:
        (revised_manuscript, applied_ops, failed_ops)
    """
    applied: list[dict] = []
    failed: list[dict] = []

    # ── Phase 1: Locate each operation's position in the manuscript ──────
    positioned: list[tuple[int, dict]] = []  # (position, op)
    for op in all_changes:
        op_type = op.get("type", "")
        find_text = op.get("find", "") or op.get("anchor", "")
        if not find_text:
            failed.append({**op, "reason": "empty find/anchor text"})
            continue
        if op_type not in ("replace", "insert_after", "delete"):
            failed.append({**op, "reason": f"unknown operation type: {op_type}"})
            continue

        # Try exact match → line-number-stripped → whitespace-normalized
        pos = manuscript.find(find_text)
        actual_find = find_text
        if pos == -1:
            stripped = _strip_line_numbers(find_text)
            if stripped != find_text:
                pos = manuscript.find(stripped)
                if pos != -1:
                    actual_find = stripped
        if pos == -1:
            # Whitespace-normalized match: collapse all whitespace to single space
            # Only accept if there's exactly ONE match (no ambiguity)
            norm_find = _normalize_whitespace(find_text)
            if len(norm_find) >= 30:  # Only for substantial text
                match_pos = _find_unique_normalized_match(manuscript, norm_find)
                if match_pos is not None:
                    actual_find_start, actual_find_end = match_pos
                    actual_find = manuscript[actual_find_start:actual_find_end]
                    pos = actual_find_start
                    logger.debug("Whitespace-normalized match for: %.60s...", find_text[:60])
        if pos == -1:
            logger.warning("Edit failed — text not found: %.80s...", find_text[:80])
            failed.append({**op, "reason": "find text not found in manuscript"})
            continue

        positioned.append((pos, {**op, "_actual_find": actual_find, "_pos": pos, "_end": pos + len(actual_find)}))

    # ── Phase 2: Detect and remove overlapping operations ────────────────
    positioned.sort(key=lambda x: x[0])
    non_overlapping: list[dict] = []
    last_end = -1
    for _pos, op in positioned:
        op_start = op["_pos"]
        op_end = op["_end"]
        if op_start < last_end:
            failed.append({**op, "reason": "overlaps with a prior operation"})
            continue
        non_overlapping.append(op)
        last_end = op_end

    # ── Phase 3: Apply operations bottom-to-top ──────────────────────────
    # Sort by position descending so earlier text positions are unaffected
    non_overlapping.sort(key=lambda op: op["_pos"], reverse=True)

    result = manuscript
    for op in non_overlapping:
        op_type = op.get("type", "")
        actual_find = op["_actual_find"]

        if op_type == "replace":
            replace_text = op.get("replace_with", "")
            if actual_find in result:
                result = result.replace(actual_find, replace_text, 1)
                applied.append(op)
            else:
                failed.append({**op, "reason": "find text no longer present after prior edits"})

        elif op_type == "insert_after":
            new_text = op.get("text", "")
            idx = result.find(actual_find)
            if idx != -1:
                end_of_anchor = idx + len(actual_find)
                next_para = result.find("\n\n", end_of_anchor)
                insert_at = next_para if next_para != -1 else len(result)
                result = result[:insert_at] + "\n\n" + new_text + result[insert_at:]
                applied.append(op)
            else:
                failed.append({**op, "reason": "anchor text no longer present after prior edits"})

        elif op_type == "delete":
            if actual_find in result:
                result = result.replace(actual_find, "", 1)
                applied.append(op)
            else:
                failed.append({**op, "reason": "find text no longer present after prior edits"})

    # Clean internal tracking keys from returned ops
    for op in applied + failed:
        op.pop("_actual_find", None)
        op.pop("_pos", None)
        op.pop("_end", None)

    # Clean up any triple+ newlines created by deletions
    result = re.sub(r'\n{3,}', '\n\n', result)

    return result, applied, failed


def _strip_line_numbers(text: str) -> str:
    """Strip leading line-number prefixes (e.g., '   1  ', '  42  ') that the AI
    may have copied from the line-numbered manuscript context."""
    lines = text.splitlines()
    stripped = []
    for line in lines:
        # Match pattern: optional whitespace, digits, two+ spaces (e.g., "   1  ")
        m = re.match(r'^\s*\d{1,5}\s{2,}', line)
        if m:
            stripped.append(line[m.end():])
        else:
            stripped.append(line)
    result = "\n".join(stripped)
    # Only return stripped version if it meaningfully differs (i.e., had line numbers)
    return result if result != text else text


def _line_start_offsets(text: str) -> list[int]:
    starts = [0]
    running = 0
    for line in text.splitlines(keepends=True):
        running += len(line)
        starts.append(running)
    return starts


def _line_start_char(line_starts: list[int], line_no: int) -> int:
    if not line_starts:
        return 0
    idx = max(0, min(line_no - 1, len(line_starts) - 1))
    return line_starts[idx]


def _line_end_char(line_starts: list[int], line_no: int, default_end: int) -> int:
    if not line_starts:
        return default_end
    idx = max(0, min(line_no, len(line_starts) - 1))
    return line_starts[idx] if idx < len(line_starts) else default_end


def _offset_to_line(line_starts: list[int], offset: int) -> int:
    if not line_starts:
        return 1
    idx = bisect.bisect_right(line_starts, offset) - 1
    return max(1, idx + 1)


def _section_for_line(section_index: list[dict], line_no: int) -> str:
    for sec in section_index:
        start_line = int(sec.get("start_line", 1) or 1)
        end_line = int(sec.get("end_line", line_no) or line_no)
        if start_line <= line_no <= end_line:
            return str(sec.get("name", "Manuscript") or "Manuscript")
    return "Manuscript"


def _build_paragraph_index(
    manuscript_text: str,
    *,
    section_name: str,
    base_line: int,
    base_char: int,
    section_index: list[dict] | None = None,
) -> list[dict]:
    paragraphs: list[dict] = []
    line_starts = _line_start_offsets(manuscript_text)
    pattern = re.compile(r'\S[\s\S]*?(?=(?:\n\s*\n)|\Z)')
    para_no = 1
    for match in pattern.finditer(manuscript_text):
        start = match.start()
        end = match.end()
        start_line = base_line + _offset_to_line(line_starts, start) - 1
        end_line = base_line + _offset_to_line(line_starts, max(start, end - 1)) - 1
        resolved_section = section_name or _section_for_line(section_index or build_section_index(manuscript_text), start_line)
        paragraphs.append({
            "section": resolved_section,
            "paragraph_index": para_no,
            "start_char": base_char + start,
            "end_char": base_char + end,
            "start_line": start_line,
            "end_line": end_line,
            "text": manuscript_text[start:end],
        })
        para_no += 1
    return paragraphs


def _make_chunk(chunk_id: int, manuscript_text: str, section_name: str, paragraphs: list[dict], section_order: int) -> dict:
    start_char = paragraphs[0]["start_char"]
    end_char = paragraphs[-1]["end_char"]
    start_line = paragraphs[0]["start_line"]
    end_line = paragraphs[-1]["end_line"]
    return {
        "chunk_id": chunk_id,
        "section": section_name or "Manuscript",
        "section_order": section_order,
        "start_char": start_char,
        "end_char": end_char,
        "start_line": start_line,
        "end_line": end_line,
        "paragraph_start": paragraphs[0]["paragraph_index"],
        "paragraph_end": paragraphs[-1]["paragraph_index"],
        "text": manuscript_text[start_char:end_char],
    }


def _paragraph_index_for_char(paragraphs: list[dict], char_pos: int) -> int:
    for i, paragraph in enumerate(paragraphs):
        if paragraph["start_char"] <= char_pos < paragraph["end_char"]:
            return i
    return max(0, len(paragraphs) - 1)


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ranges:
        return []
    ordered = sorted(ranges)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _normalize_whitespace(text: str) -> str:
    """Collapse all whitespace runs to single spaces for fuzzy matching."""
    return re.sub(r'\s+', ' ', text.strip())


def _find_unique_normalized_match(text: str, normalized_find: str) -> tuple[int, int] | None:
    """Find a UNIQUE whitespace-normalized match. Returns None if 0 or 2+ matches."""
    matches = _find_fuzzy_matches(text, normalized_find)
    if len(matches) == 1:
        return matches[0]
    return None


def _find_fuzzy_matches(text: str, normalized_find: str) -> list[tuple[int, int]]:
    """Find positions in text where a whitespace-normalized version matches."""
    # Slide a window over the text and compare normalized versions
    find_len = len(normalized_find)
    if find_len < 10:
        return []

    matches = []
    # Window must be larger than normalized length to account for real whitespace
    window_chars = int(find_len * 2.5)
    skip_until = 0
    for start in range(0, len(text) - find_len // 2):
        if start < skip_until:
            continue
        chunk = text[start:start + window_chars]
        if _normalize_whitespace(chunk).startswith(normalized_find):
            # Find the actual end position — start from minimum plausible length
            for end in range(start + find_len, min(start + window_chars + 20, len(text) + 1)):
                if _normalize_whitespace(text[start:end]) == normalized_find:
                    matches.append((start, end))
                    skip_until = end  # Don't re-match inside this span
                    break
            # Do NOT break early — continue scanning for additional matches
            # so _find_unique_normalized_match can reject ambiguous multi-matches
    return matches


# ── Post-revision quality audit ──────────────────────────────────────────────

def audit_revision(original: str, revised: str) -> dict:
    """Compare original vs revised manuscript for quality regressions.

    Returns {"warnings": [...], "stats": {...}, "passed": bool}
    """
    warnings: list[str] = []
    revised_placeholder_cites = _count_placeholder_citations(revised)
    original_placeholder_cites = _count_placeholder_citations(original)
    export_normalized_references = revised_placeholder_cites > 0 and _count_references(revised) == 0

    # 1. Section preservation
    orig_sections = _extract_headings(original)
    rev_sections = _extract_headings(revised)
    missing_sections = orig_sections - rev_sections
    if missing_sections:
        warnings.append(f"Missing sections in revision: {', '.join(sorted(missing_sections))}")

    # 2. Citation count
    orig_cites = _count_citations(original)
    rev_cites = _count_citations(revised)
    if rev_cites < orig_cites:
        diff = orig_cites - rev_cites
        warnings.append(f"Citation count dropped: {orig_cites} → {rev_cites} (lost {diff})")

    # 3. Reference count
    orig_refs = _count_references(original)
    rev_refs = _count_references(revised)
    if rev_refs < orig_refs:
        diff = orig_refs - rev_refs
        if export_normalized_references:
            warnings.append(
                "Formatted reference entries are deferred to export via [CITE:key] placeholders; "
                "verify bibliography rendering on export."
            )
        else:
            warnings.append(f"Reference count dropped: {orig_refs} → {rev_refs} (lost {diff})")

    # 4. Heading count preservation
    orig_heading_count = len(orig_sections)
    rev_heading_count = len(rev_sections)
    new_sections = rev_sections - orig_sections
    if new_sections:
        warnings.append(f"New sections added (not in original): {', '.join(sorted(new_sections))}")
    if rev_heading_count != orig_heading_count:
        warnings.append(f"Heading count changed: {orig_heading_count} → {rev_heading_count}")

    # 5. Title preservation
    orig_title = _extract_title(original)
    rev_title = _extract_title(revised)
    if orig_title and rev_title and orig_title != rev_title:
        warnings.append(f"Title changed: '{orig_title[:60]}...' → '{rev_title[:60]}...'")

    # 6. Figure/table reference counts
    orig_figs = len(re.findall(r'(?:Figure|Fig\.?)\s*\d+', original, re.IGNORECASE))
    rev_figs = len(re.findall(r'(?:Figure|Fig\.?)\s*\d+', revised, re.IGNORECASE))
    if orig_figs != rev_figs:
        warnings.append(f"Figure reference count changed: {orig_figs} → {rev_figs}")

    orig_tables = len(re.findall(r'Table\s*\d+', original, re.IGNORECASE))
    rev_tables = len(re.findall(r'Table\s*\d+', revised, re.IGNORECASE))
    if orig_tables != rev_tables:
        warnings.append(f"Table reference count changed: {orig_tables} → {rev_tables}")

    # 6b. Figure/illustration/table block preservation
    orig_image_blocks = _count_image_blocks(original)
    rev_image_blocks = _count_image_blocks(revised)
    if orig_image_blocks != rev_image_blocks:
        warnings.append(f"Image/illustration block count changed: {orig_image_blocks} → {rev_image_blocks}")

    orig_table_blocks = _count_table_blocks(original)
    rev_table_blocks = _count_table_blocks(revised)
    if orig_table_blocks != rev_table_blocks:
        warnings.append(f"Table block count changed: {orig_table_blocks} → {rev_table_blocks}")

    orig_ref_section_wc = _references_section_word_count(original)
    rev_ref_section_wc = _references_section_word_count(revised)
    if orig_ref_section_wc and rev_ref_section_wc == 0:
        if not export_normalized_references:
            warnings.append("References section content was removed from the revision.")
    elif orig_ref_section_wc and rev_ref_section_wc:
        ref_drift = abs(rev_ref_section_wc - orig_ref_section_wc) / orig_ref_section_wc * 100
        if ref_drift > 10:
            warnings.append(
                f"References section word count drift: {orig_ref_section_wc} → {rev_ref_section_wc} ({ref_drift:.0f}%, limit ±10%)"
            )

    # 7. Total word count drift (tightened: ±5%)
    orig_wc = len(original.split())
    rev_wc = len(revised.split())
    if orig_wc > 0:
        drift_pct = abs(rev_wc - orig_wc) / orig_wc * 100
        if drift_pct > 5:
            warnings.append(
                f"Word count drift: {orig_wc} → {rev_wc} ({drift_pct:.0f}% change, limit ±5%)"
            )

    # 8. Per-section word count drift (tightened: ±10%)
    orig_sec_wc = _section_word_counts(original)
    rev_sec_wc = _section_word_counts(revised)
    for sec_name, owc in orig_sec_wc.items():
        rwc = rev_sec_wc.get(sec_name, 0)
        if owc > 50 and rwc > 0:  # only check non-trivial sections
            sec_drift = abs(rwc - owc) / owc * 100
            if sec_drift > 10:
                warnings.append(
                    f"Section '{sec_name}' word count drift: {owc} → {rwc} ({sec_drift:.0f}%, limit ±10%)"
                )

    return {
        "warnings": warnings,
        "stats": {
            "original_word_count": orig_wc,
            "revised_word_count": rev_wc,
            "original_citations": orig_cites,
            "revised_citations": rev_cites,
            "original_references": orig_refs,
            "revised_references": rev_refs,
            "original_placeholder_citations": original_placeholder_cites,
            "revised_placeholder_citations": revised_placeholder_cites,
            "missing_sections": list(missing_sections),
            "new_sections": list(new_sections),
            "original_figures": orig_figs,
            "revised_figures": rev_figs,
            "original_tables": orig_tables,
            "revised_tables": rev_tables,
            "original_image_blocks": orig_image_blocks,
            "revised_image_blocks": rev_image_blocks,
            "original_table_blocks": orig_table_blocks,
            "revised_table_blocks": rev_table_blocks,
            "original_references_section_words": orig_ref_section_wc,
            "revised_references_section_words": rev_ref_section_wc,
        },
        "passed": len(warnings) == 0,
    }


def _extract_title(text: str) -> str:
    """Extract the # level title (first H1) from markdown."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            return stripped.lstrip("# ").strip()
    return ""


def _extract_headings(text: str) -> set[str]:
    """Extract all ## level headings from markdown."""
    headings = set()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            headings.add(stripped.lstrip("# ").strip())
    return headings


def _count_citations(text: str) -> int:
    """Count citation tags: [CITE:key], [1], [2], etc."""
    cite_tags = len(re.findall(r'\[CITE:[^\]]+\]', text))
    numbered = len(re.findall(r'\[(?:X?\d+)\]', text))
    return cite_tags + numbered


def _count_placeholder_citations(text: str) -> int:
    """Count [CITE:key] grounding markers only."""
    return len(re.findall(r'\[CITE:[^\]]+\]', text))


def _count_references(text: str) -> int:
    """Count entries in the References section."""
    ref_match = re.search(r'(?:^|\n)##?\s*References?\s*\n', text, re.IGNORECASE)
    if not ref_match:
        return 0
    ref_text = text[ref_match.end():]
    # Count non-empty lines that look like reference entries
    count = 0
    for line in ref_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("## "):
            break  # hit next section
        # Reference lines typically start with number, author name, or [X]
        if re.match(r'^\d+\.|^\[', stripped) or len(stripped) > 30:
            count += 1
    return count


def _section_word_counts(text: str) -> dict[str, int]:
    """Return word count per ## section."""
    sections: dict[str, int] = {}
    current_section = "_preamble"
    current_text: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            if current_text:
                sections[current_section] = len(" ".join(current_text).split())
            current_section = stripped.lstrip("# ").strip()
            current_text = []
        else:
            current_text.append(stripped)

    if current_text:
        sections[current_section] = len(" ".join(current_text).split())

    return sections


def _count_image_blocks(text: str) -> int:
    """Count markdown image blocks and common illustration placeholders."""
    markdown_images = len(re.findall(r'!\[[^\]]*\]\([^)]+\)', text))
    html_images = len(re.findall(r'<img\b[^>]*>', text, re.IGNORECASE))
    illustration_labels = len(re.findall(r'^\s*(?:Figure|Fig\.?|Illustration)\s+\d+\s*[:.-]', text, re.IGNORECASE | re.MULTILINE))
    return markdown_images + html_images + illustration_labels


def _count_table_blocks(text: str) -> int:
    """Count markdown and HTML table blocks."""
    markdown_tables = 0
    lines = text.splitlines()
    i = 0
    while i < len(lines) - 1:
        if "|" in lines[i] and re.match(r'^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$', lines[i + 1]):
            markdown_tables += 1
            i += 2
            while i < len(lines) and "|" in lines[i]:
                i += 1
            continue
        i += 1

    html_tables = len(re.findall(r'<table\b', text, re.IGNORECASE))
    return markdown_tables + html_tables


def _references_section_word_count(text: str) -> int:
    """Count words in the References section only."""
    ref_match = re.search(r'(?:^|\n)##?\s*References?\s*\n', text, re.IGNORECASE)
    if not ref_match:
        return 0
    ref_text = text[ref_match.end():]
    lines: list[str] = []
    for line in ref_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            break
        lines.append(stripped)
    return len(" ".join(lines).split())
