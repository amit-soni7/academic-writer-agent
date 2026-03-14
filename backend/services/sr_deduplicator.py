"""
sr_deduplicator.py

Four-stage deduplication for systematic review search results.
Stage 1: Exact identifier matching (DOI, PMID)
Stage 2: Title + year blocking with fuzzy match (rapidfuzz)
Stage 3: Weighted composite matching
Stage 4: Ambiguous queue for human review
"""

from __future__ import annotations
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

try:
    from rapidfuzz import fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:
    _HAS_RAPIDFUZZ = False
    logger.warning("rapidfuzz not installed; deduplication will use exact matching only. pip install rapidfuzz")


def _normalize_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    doi = doi.lower().strip()
    doi = re.sub(r'^https?://doi\.org/', '', doi)
    doi = re.sub(r'^doi:', '', doi)
    return doi.strip() or None


def _normalize_title(title: str | None) -> str:
    if not title:
        return ""
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', title.lower())).strip()


def _first_author_surname(record: dict) -> str:
    authors = record.get("authors", [])
    if not authors:
        return ""
    first = authors[0] if isinstance(authors[0], str) else str(authors[0])
    # Take last word of "First Last" or "Last, First"
    parts = first.replace(",", "").split()
    return parts[-1].lower() if parts else ""


def _normalize_journal(journal: str | None) -> str:
    if not journal:
        return ""
    j = journal.lower().strip()
    j = re.sub(r'[^\w\s]', ' ', j)
    j = re.sub(r'\s+', ' ', j).strip()
    # Remove common noise
    for noise in ['the journal of', 'journal of', 'the', 'an', 'a']:
        if j.startswith(noise + ' '):
            j = j[len(noise):].strip()
    return j


def _merge_records(keep: dict, dup: dict) -> dict:
    """Merge source labels from duplicate into the kept record."""
    keep = dict(keep)
    keep_sources = keep.get("sources", [keep.get("source", "unknown")])
    if not isinstance(keep_sources, list):
        keep_sources = [keep_sources]
    dup_source = dup.get("source", dup.get("sources", ["unknown"]))
    if isinstance(dup_source, str):
        dup_source = [dup_source]
    merged_sources = list(dict.fromkeys(keep_sources + dup_source))
    keep["sources"] = merged_sources
    keep["source"] = merged_sources[0] if merged_sources else "unknown"
    # Keep richer metadata: prefer non-None values from dup
    for field in ["abstract", "doi", "pmid", "year", "journal", "volume", "pages", "citation_count"]:
        if not keep.get(field) and dup.get(field):
            keep[field] = dup[field]
    return keep


def deduplicate(records: list[dict]) -> dict:
    """
    Four-stage deduplication of SR search records.

    Returns:
        {
            "unique_records": list[dict],
            "duplicate_pairs": list[dict],   # audit trail
            "potential_duplicates": list[dict],  # score 0.80-0.92, for human review
            "stats": {"before": int, "after": int, "removed": int, "flagged": int}
        }
    """
    before = len(records)
    duplicates = []      # confirmed dups (audit trail)
    potential = []       # ambiguous (0.80-0.92)

    # ── Stage 1: Exact identifier matching ─────────────────────────────────────
    doi_groups: dict[str, int] = {}   # normalized_doi → index in unique list
    pmid_groups: dict[str, int] = {}
    unique: list[dict] = []

    for rec in records:
        ndoi = _normalize_doi(rec.get("doi"))
        pmid = str(rec.get("pmid", "")).strip() or None

        merged = False
        if ndoi and ndoi in doi_groups:
            idx = doi_groups[ndoi]
            unique[idx] = _merge_records(unique[idx], rec)
            duplicates.append({"kept": unique[idx].get("doi"), "removed": rec.get("doi"), "stage": 1, "reason": "doi_match"})
            merged = True
        elif pmid and pmid in pmid_groups:
            idx = pmid_groups[pmid]
            unique[idx] = _merge_records(unique[idx], rec)
            duplicates.append({"kept": unique[idx].get("pmid"), "removed": rec.get("pmid"), "stage": 1, "reason": "pmid_match"})
            merged = True

        if not merged:
            idx = len(unique)
            unique.append(dict(rec))
            if ndoi:
                doi_groups[ndoi] = idx
            if pmid:
                pmid_groups[pmid] = idx

    if not _HAS_RAPIDFUZZ:
        return {
            "unique_records": unique,
            "duplicate_pairs": duplicates,
            "potential_duplicates": [],
            "stats": {"before": before, "after": len(unique), "removed": before - len(unique), "flagged": 0},
        }

    # ── Stage 2: Title + year blocking with fuzzy match ─────────────────────────
    # Build blocks: year + first 6 chars of normalized title
    blocks: dict[str, list[int]] = {}
    for i, rec in enumerate(unique):
        nt = _normalize_title(rec.get("title", ""))
        year = str(rec.get("year", "")) or "0000"
        block_key = f"{year}_{nt[:6]}"
        blocks.setdefault(block_key, []).append(i)

    to_remove: set[int] = set()
    for block_indices in blocks.values():
        if len(block_indices) < 2:
            continue
        for a in range(len(block_indices)):
            for b in range(a + 1, len(block_indices)):
                ia, ib = block_indices[a], block_indices[b]
                if ia in to_remove or ib in to_remove:
                    continue
                ta = _normalize_title(unique[ia].get("title", ""))
                tb = _normalize_title(unique[ib].get("title", ""))
                score = fuzz.token_sort_ratio(ta, tb) / 100.0
                if score >= 0.95:
                    unique[ia] = _merge_records(unique[ia], unique[ib])
                    to_remove.add(ib)
                    duplicates.append({
                        "kept": unique[ia].get("title", "")[:60],
                        "removed": unique[ib].get("title", "")[:60],
                        "stage": 2, "score": score, "reason": "title_year_fuzzy",
                    })

    unique = [r for i, r in enumerate(unique) if i not in to_remove]

    # ── Stage 3: Weighted composite matching ────────────────────────────────────
    # Blocking: year + first 4 chars of first author surname
    comp_blocks: dict[str, list[int]] = {}
    for i, rec in enumerate(unique):
        surname = _first_author_surname(rec)[:4]
        year = str(rec.get("year", "")) or "0000"
        block_key = f"{year}_{surname}"
        comp_blocks.setdefault(block_key, []).append(i)

    to_remove2: set[int] = set()
    for block_indices in comp_blocks.values():
        if len(block_indices) < 2:
            continue
        for a in range(len(block_indices)):
            for b in range(a + 1, len(block_indices)):
                ia, ib = block_indices[a], block_indices[b]
                if ia in to_remove2 or ib in to_remove2:
                    continue

                ra, rb = unique[ia], unique[ib]
                ta = _normalize_title(ra.get("title", ""))
                tb = _normalize_title(rb.get("title", ""))
                title_sim = fuzz.token_sort_ratio(ta, tb) / 100.0

                sa = _first_author_surname(ra)
                sb = _first_author_surname(rb)
                author_sim = 1.0 if sa == sb else fuzz.ratio(sa, sb) / 100.0

                ja = _normalize_journal(ra.get("journal", ""))
                jb = _normalize_journal(rb.get("journal", ""))
                journal_sim = fuzz.token_set_ratio(ja, jb) / 100.0 if (ja and jb) else 0.5

                ya, yb = str(ra.get("year", "")), str(rb.get("year", ""))
                year_match = 1.0 if ya == yb else 0.0

                va = str(ra.get("volume", "")).strip()
                vb = str(rb.get("volume", "")).strip()
                pa_str = str(ra.get("pages", "")).strip()
                pb_str = str(rb.get("pages", "")).strip()
                volpage_sim = 0.5
                if va and vb:
                    volpage_sim = 1.0 if va == vb else 0.0
                if pa_str and pb_str and volpage_sim > 0:
                    volpage_sim = (volpage_sim + (1.0 if pa_str == pb_str else 0.0)) / 2

                composite = (
                    title_sim * 0.45 +
                    author_sim * 0.20 +
                    journal_sim * 0.15 +
                    volpage_sim * 0.10 +
                    year_match * 0.10
                )

                if composite >= 0.92:
                    unique[ia] = _merge_records(unique[ia], unique[ib])
                    to_remove2.add(ib)
                    duplicates.append({
                        "kept": ra.get("title", "")[:60],
                        "removed": rb.get("title", "")[:60],
                        "stage": 3, "score": round(composite, 3), "reason": "composite_match",
                    })
                elif composite >= 0.80:
                    potential.append({
                        "record_a": {"title": ra.get("title", "")[:80], "year": ra.get("year"), "doi": ra.get("doi")},
                        "record_b": {"title": rb.get("title", "")[:80], "year": rb.get("year"), "doi": rb.get("doi")},
                        "composite_score": round(composite, 3),
                        "title_similarity": round(title_sim, 3),
                    })

    unique = [r for i, r in enumerate(unique) if i not in to_remove2]

    return {
        "unique_records": unique,
        "duplicate_pairs": duplicates,
        "potential_duplicates": potential,
        "stats": {
            "before": before,
            "after": len(unique),
            "removed": before - len(unique),
            "flagged": len(potential),
        },
    }
