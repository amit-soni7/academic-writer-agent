"""
services/csl_formatter.py

Industry-standard reference formatting using Citation Style Language (CSL).
Replaces hand-coded formatters with official CSL style files from:
  https://github.com/citation-style-language/styles

CSL style files are bundled at backend/csl_styles/ for offline use.
Unknown styles are fetched from the CSL styles GitHub repo and cached.

Public API
----------
STYLE_TO_CSL_ID : dict[str, str]
    Maps internal CitationStyle names → CSL style file IDs.

format_references_csl(summaries, csl_id, sort_order) → str
    Render a numbered reference list using the given CSL style.

bib_to_csl_item(summary) → dict
    Convert a paper summary dict to a CSL-JSON item.
"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Bundled CSL directory ──────────────────────────────────────────────────────
# Files in this directory ship with the repo — no network needed.
_CSL_DIR = Path(__file__).parent.parent / "csl_styles"

# Cache directory for on-demand fetched styles (not in repo)
_CACHE_DIR = _CSL_DIR / "_cache"

# Base URL for fetching CSL files at runtime
_CSL_BASE_URL = (
    "https://raw.githubusercontent.com/citation-style-language/styles/master/"
)

# ── Internal style name → CSL file ID ─────────────────────────────────────────
# Each key is a CitationStyle.value; each value is the CSL filename without .csl
STYLE_TO_CSL_ID: dict[str, str] = {
    "ama":       "american-medical-association",
    "vancouver": "elsevier-vancouver",
    "nlm":       "american-medical-association",   # NLM numeric ≈ AMA
    "nature":    "nature",
    "cell":      "cell",
    "apa":       "apa",
    "harvard":   "harvard-cite-them-right",
    "science":   "science",
    "ieee":      "ieee",
    "default":   "american-medical-association",   # universal fallback
}


# ── Author name parsing ────────────────────────────────────────────────────────

def _parse_author(name_str: str) -> dict:
    """
    Parse a raw author string into a CSL-JSON author object.

    Handles three input formats:
      "Smith AB"         → {"family": "Smith",   "given": "A.B."}
      "Smith, A. B."     → {"family": "Smith",   "given": "A. B."}
      "John Smith"       → {"family": "Smith",   "given": "John"}
      "Smith"            → {"family": "Smith"}
    """
    name = name_str.strip()
    if not name:
        return {"literal": "Unknown"}

    # ── "LastName, Given" format ──────────────────────────────────────────────
    if "," in name:
        last, rest = name.split(",", 1)
        return {"family": last.strip(), "given": rest.strip()}

    parts = name.split()
    if len(parts) == 1:
        return {"family": parts[0]}

    # ── Detect "LastName Initials" format (e.g. "Smith AB", "Wang X") ─────────
    # Initials: trailing token that is all-uppercase alpha, 1–4 chars.
    last_part = parts[-1]
    if (
        1 <= len(last_part) <= 4
        and last_part.isalpha()
        and last_part.isupper()
    ):
        family = " ".join(parts[:-1])
        # Expand "AB" → "A.B."
        given = ".".join(last_part) + "."
        return {"family": family, "given": given}

    # ── "FirstName … LastName" format ─────────────────────────────────────────
    family = parts[-1]
    given = " ".join(parts[:-1])
    return {"family": family, "given": given}


# ── Bibliography dict → CSL-JSON conversion ────────────────────────────────────

def bib_to_csl_item(summary: dict) -> dict:
    """
    Convert a paper summary dict (with nested 'bibliography' key) to a
    CSL-JSON reference object suitable for citeproc rendering.

    Prefers CrossRef-enriched ``_csl_authors`` (set by doi_metadata_fetcher)
    over AI-extracted author strings, which often have missing or malformed
    family names.
    """
    bib        = summary.get("bibliography", {})
    paper_key  = summary.get("paper_key", "unknown")

    # Use CrossRef-supplied author objects when available (family + given separated)
    csl_authors_direct = bib.get("_csl_authors")
    if csl_authors_direct and isinstance(csl_authors_direct, list):
        csl_authors = [
            a for a in csl_authors_direct
            if isinstance(a, dict) and (a.get("family") or a.get("literal"))
        ]
    else:
        authors_raw = bib.get("authors", [])
        csl_authors = [_parse_author(a) for a in authors_raw if a]

    item: dict = {
        "id":   paper_key,
        "type": "article-journal",
        "title": bib.get("title") or paper_key,
    }

    if csl_authors:
        item["author"] = csl_authors

    year = bib.get("year")
    if year:
        try:
            item["issued"] = {"date-parts": [[int(year)]]}
        except (TypeError, ValueError):
            pass

    if bib.get("journal"):
        item["container-title"] = bib["journal"]

    for field, key in [("volume", "volume"), ("issue", "issue")]:
        if bib.get(key):
            item[field] = str(bib[key])

    if bib.get("pages"):
        item["page"] = bib["pages"]

    if bib.get("doi"):
        item["DOI"] = bib["doi"]

    return item


# ── CSL file resolution ────────────────────────────────────────────────────────

def _resolve_csl_file(csl_id: str) -> Optional[Path]:
    """
    Return the path to the CSL file for the given ID.

    Search order:
      1. Bundled file: backend/csl_styles/{csl_id}.csl
      2. Cache:        backend/csl_styles/_cache/{csl_id}.csl
      3. Fetch from GitHub CSL styles repo and cache (network call)
    """
    # 1. Bundled
    bundled = _CSL_DIR / f"{csl_id}.csl"
    if bundled.exists():
        return bundled

    # 2. Cache
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _CACHE_DIR / f"{csl_id}.csl"
    if cached.exists():
        return cached

    # 3. Fetch from GitHub
    url = _CSL_BASE_URL + f"{csl_id}.csl"
    try:
        logger.info("Fetching CSL style from %s", url)
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "academic-writer-agent/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
        cached.write_bytes(content)
        logger.info("Cached CSL style: %s", cached)
        return cached
    except Exception as exc:
        logger.warning("Failed to fetch CSL style %s: %s", csl_id, exc)
        return None


# ── Main rendering function ────────────────────────────────────────────────────

def format_references_csl(
    summaries: list[dict],
    csl_id: str,
    sort_order: str = "order_of_appearance",
) -> str:
    """
    Render a numbered reference list using an official CSL style.

    Args:
        summaries:  List of paper summary dicts (with 'bibliography' sub-dict).
        csl_id:     CSL style ID, e.g. "american-medical-association", "nature".
        sort_order: "order_of_appearance" | "alphabetical".

    Returns:
        Plain-text reference list (one ref per line), or "" on failure.
    """
    if not summaries:
        return ""

    csl_path = _resolve_csl_file(csl_id)
    if csl_path is None:
        logger.warning("CSL style not available: %s — using fallback formatter", csl_id)
        return ""

    try:
        from citeproc import (
            Citation,
            CitationItem,
            CitationStylesBibliography,
            CitationStylesStyle,
        )
        from citeproc import formatter
        from citeproc.source.json import CiteProcJSON

        csl_items = [bib_to_csl_item(s) for s in summaries[:60]]

        # For alphabetical styles, pre-sort items so citeproc sees them in order
        if sort_order == "alphabetical":
            csl_items.sort(
                key=lambda x: (
                    x.get("author", [{}])[0].get("family", "").lower()
                    if x.get("author") else ""
                )
            )

        style      = CitationStylesStyle(str(csl_path), validate=False)
        bib_source = CiteProcJSON(csl_items)
        bibliography = CitationStylesBibliography(style, bib_source, formatter.plain)

        for item in csl_items:
            bibliography.register(Citation([CitationItem(item["id"])]))

        bibliography.sort()

        refs = []
        for i, ref in enumerate(bibliography.bibliography(), 1):
            ref_str = str(ref).strip()
            # citeproc-py may omit the number for author-year styles.
            # Only prepend when there's no leading digit or bracket already.
            if ref_str and not (ref_str[0].isdigit() or ref_str[0] == "["):
                ref_str = f"{i}. {ref_str}"
            refs.append(ref_str)

        return "\n".join(refs)

    except ImportError:
        logger.error("citeproc-py not installed; install with: pip install citeproc-py")
        return ""
    except Exception as exc:
        logger.error("CSL rendering failed for style %s: %s", csl_id, exc, exc_info=True)
        return ""
