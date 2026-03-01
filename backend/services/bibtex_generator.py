"""
bibtex_generator.py

Generate BibTeX entries from PaperSummary objects and append them
to a per-session .bib file on disk.

File naming: {save_path}/{session_id}.bib
BibTeX key:  {FirstAuthorSurname}{Year}{FirstTitleWord}
"""

from __future__ import annotations

import logging
import os
import re
from typing import Optional

from models import PaperSummary

logger = logging.getLogger(__name__)


def _sanitize_key(s: str, max_len: int = 20) -> str:
    """Remove non-alphanumeric characters and truncate for BibTeX keys."""
    s = re.sub(r"[^\w]", "", s or "")
    return s[:max_len]


def _escape_bib(s: str) -> str:
    """Escape BibTeX special characters in field values."""
    return (
        s.replace("&", r"\&")
         .replace("%", r"\%")
         .replace("$", r"\$")
         .replace("#", r"\#")
         .replace("_", r"\_")
         .replace("{", r"\{")
         .replace("}", r"\}")
         .replace("~", r"\~")
         .replace("^", r"\^")
    )


def make_bibtex_key(summary: PaperSummary) -> str:
    bib = summary.bibliography
    # First author surname (before comma or space)
    first_author = ""
    if bib.authors:
        raw = bib.authors[0]
        # "Surname, Given" or "Surname Given"
        first_author = re.split(r"[,\s]", raw)[0]
    first_author = _sanitize_key(first_author, 15)

    year = str(bib.year or "")[:4]

    first_word = ""
    if bib.title:
        words = re.findall(r"[A-Za-z]+", bib.title)
        # Skip very short/common words
        stop = {"a", "an", "the", "of", "in", "on", "and", "or", "for", "to", "is"}
        for w in words:
            if w.lower() not in stop and len(w) > 2:
                first_word = w
                break

    first_word = _sanitize_key(first_word, 10)
    return f"{first_author}{year}{first_word}" or f"ref_{summary.paper_key[:8]}"


def make_bibtex_entry(summary: PaperSummary, key: Optional[str] = None) -> str:
    """
    Generate a BibTeX @article entry from a PaperSummary.
    Returns the entry string (without trailing newline).
    """
    bib = summary.bibliography
    cite_key = key or make_bibtex_key(summary)

    # Format author list as "Surname, Given and Surname2, Given2"
    authors_bib = " and ".join(
        _escape_bib(a) for a in bib.authors
    ) if bib.authors else "Unknown"

    fields: list[tuple[str, str]] = [
        ("author",  authors_bib),
        ("title",   _escape_bib(bib.title or "")),
        ("journal", _escape_bib(bib.journal or "")),
        ("year",    str(bib.year or "")),
    ]
    if bib.volume:
        fields.append(("volume", _escape_bib(bib.volume)))
    if bib.issue:
        fields.append(("number", _escape_bib(bib.issue)))
    if bib.pages:
        fields.append(("pages", _escape_bib(bib.pages)))
    if bib.doi:
        fields.append(("doi", bib.doi))
        fields.append(("url", f"https://doi.org/{bib.doi}"))
    if bib.pmid:
        fields.append(("note", f"PMID: {bib.pmid}"))

    field_lines = ",\n  ".join(f"{k} = {{{v}}}" for k, v in fields)
    return f"@article{{{cite_key},\n  {field_lines}\n}}"


def append_to_project_bib(project_id: str, project_folder: str, summary: PaperSummary) -> None:
    """
    Append a BibTeX entry to {project_folder}/{project_name}.bib.
    The project_name is derived from the folder basename.
    Skips if an entry with the same cite key is already present.
    Creates the file and directory if they do not exist.
    """
    try:
        os.makedirs(project_folder, exist_ok=True)
        project_name = os.path.basename(project_folder.rstrip("/")) or project_id
        bib_path = os.path.join(project_folder, f"{project_name}.bib")
        key = make_bibtex_key(summary)

        # Read existing entries to avoid duplicates
        existing_keys: set[str] = set()
        if os.path.exists(bib_path):
            with open(bib_path, "r", encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"@\w+\{([^,]+),", line.strip())
                    if m:
                        existing_keys.add(m.group(1))

        if key in existing_keys:
            logger.debug("BibTeX key %r already in %s — skipping", key, bib_path)
            return

        entry = make_bibtex_entry(summary, key=key)
        with open(bib_path, "a", encoding="utf-8") as f:
            f.write("\n" + entry + "\n")
        logger.debug("BibTeX entry %r written to %s", key, bib_path)
    except Exception as exc:
        logger.warning("Failed to write BibTeX for %r: %s", summary.bibliography.title[:40], exc)


def append_to_session_bib(session_id: str, save_path: str, summary: PaperSummary) -> None:
    """Legacy alias: delegates to append_to_project_bib using session_id as project_name."""
    append_to_project_bib(session_id, save_path, summary)
