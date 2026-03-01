"""
extract_search_guidelines.py

One-time script: reads systematic-review methodology books and uses AI to
distill actionable search-strategy guidelines, then saves them to
backend/data/search_guidelines.json.

This feeds into services/search_guidelines.py which injects the guidelines
into the query_expander.py system prompt at runtime.

Usage (from backend/ directory, venv active):

    # Auto-reads API key from app DB (no args needed):
    python scripts/extract_search_guidelines.py

    # Or pass key explicitly:
    python scripts/extract_search_guidelines.py --api-key YOUR_GEMINI_KEY

Targeted PDF extractions (smart chunking for large books):
  - Cochrane Handbook (674 pages)  → pages 108–180 (PICO + Searching chapters)
  - Doing a Systematic Review (244 pages) → all pages
  - MECIR (58 pages)               → all pages
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import textwrap
from pathlib import Path

import pdfplumber
from dotenv import load_dotenv
from openai import OpenAI

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

# ── Section keys for search guidelines ────────────────────────────────────────

SECTION_KEYS = [
    "pico",               # PICO/PICOS framework — translating questions to search terms
    "database_selection", # which databases to search, rationale, coverage
    "boolean_strategy",   # AND/OR/NOT logic, wildcards, phrase searching, nesting
    "mesh_and_vocabulary",# controlled vocabulary, MeSH, Emtree, thesaurus terms
    "grey_literature",    # trial registers, conference abstracts, unpublished data
    "study_filters",      # RCT/SR/cohort filters, publication type limits
    "study_selection",    # inclusion/exclusion criteria, screening process, PRISMA
    "risk_of_bias",       # assessment tools, domains, Cochrane RoB tool
    "search_reporting",   # PRISMA flow, documenting search, reproducibility
    "general",            # overarching principles that apply across all the above
]

MAX_CHARS = 70_000   # chars per submission to AI

# ── Book-specific page ranges (PDF 0-indexed) ─────────────────────────────────
# Cochrane: Chap 5 (PICO/eligibility) = pp.105–120, Chap 6 (Searching) = 121–175
# Others: full text

BOOK_CONFIGS = {
    "cochrane": {
        "glob": "cochrane-handbook*",
        "page_range": (104, 180),   # 0-indexed: PDF pages 105–180
        "description": "Cochrane Handbook Ch.5-6 (PICO + Searching for Studies)",
    },
    "doing_sr": {
        "glob": "Doing a systematic*",
        "page_range": (0, 244),
        "description": "Doing a Systematic Review (full book)",
    },
    "mecir": {
        "glob": "MECIR*",
        "page_range": (0, 58),
        "description": "MECIR Standards (full document)",
    },
}

PDF_DIR = Path("/Users/amit/Downloads/How to write")

# ── Prompts ────────────────────────────────────────────────────────────────────

DISTILL_SYSTEM = """\
You are an expert systematic-review methodologist and medical librarian.

Read the following excerpt from a book or guidance document on systematic
review methodology (e.g. Cochrane Handbook, MECIR standards).

Extract ONLY actionable guidelines — specific rules, techniques, or standards
that a researcher should follow when conducting a systematic literature search.

Do NOT include:
- Descriptions of what the book covers
- General summaries
- Obvious advice without operational detail

DO include:
- Specific rules for building Boolean search strings (AND/OR/NOT, wildcards)
- How to use PICO to decompose research questions into search concepts
- Which databases to prioritise and why
- How to handle MeSH terms vs free-text synonyms
- How to find grey literature and unpublished trials
- Study-type and publication-type filters for PubMed/MEDLINE/EMBASE
- Inclusion/exclusion criteria design
- Risk of bias assessment standards (Cochrane RoB tool, domains)
- How to document and report search methods (PRISMA, reproducibility)

Organise guidelines into these category keys:
  pico               — PICO/PICOS framework; translating questions to search concepts
  database_selection — which databases to search (MEDLINE, EMBASE, CENTRAL, etc.) and why
  boolean_strategy   — AND/OR/NOT logic, wildcards (*), phrase quoting, field tags
  mesh_and_vocabulary— MeSH terms, Emtree, controlled vocabulary vs free-text
  grey_literature    — trial registers, conference abstracts, unpublished data sources
  study_filters      — RCT/SR/cohort publication-type and study-design filters
  study_selection    — inclusion/exclusion criteria, duplicate screening, PRISMA
  risk_of_bias       — Cochrane RoB tool, domains, GRADE, quality assessment
  search_reporting   — PRISMA flow diagram, documenting search for reproducibility
  general            — overarching principles that apply across all the above

Return ONLY valid JSON. Each key maps to a list of strings. Each guideline
should be a single concise actionable sentence (max 2 sentences). 4–10 per
category. Omit keys you found no content for.

Example:
{
  "pico": [
    "Decompose the review question into Population, Intervention, Comparator, and Outcome (PICO) before building search terms.",
    "Translate each PICO element into both MeSH descriptors and free-text synonyms, then combine elements with AND."
  ],
  "boolean_strategy": [
    "Use OR to combine synonyms within a concept cluster; use AND to combine clusters.",
    "Apply truncation (*) to capture word variants (e.g. random* retrieves randomized, randomised, randomization)."
  ]
}
"""

DISTILL_USER = """\
Source: {name}
Section: {description}

--- BEGIN TEXT ---
{text}
--- END TEXT ---

Return the JSON search guidelines now.
"""


# ── PDF extraction ─────────────────────────────────────────────────────────────

def extract_pages(path: Path, page_range: tuple[int, int]) -> str:
    start, end = page_range
    parts = []
    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages[start:end]:
                text = page.extract_text(x_tolerance=2, y_tolerance=2)
                if text and text.strip():
                    parts.append(text.strip())
    except Exception as exc:
        log.warning("pdfplumber error on %s: %s", path.name, exc)
    return "\n\n".join(parts)


# ── AI ─────────────────────────────────────────────────────────────────────────

def build_client(api_key: str, provider: str = "gemini") -> tuple[OpenAI, str]:
    if not api_key:
        raise RuntimeError("API key required.")
    if provider == "openai":
        return OpenAI(api_key=api_key), "gpt-4o-mini"
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    return (
        OpenAI(
            api_key=api_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
        model,
    )


def distill(client: OpenAI, model: str, name: str, description: str, text: str) -> dict:
    trimmed = text[:MAX_CHARS]
    if len(text) > MAX_CHARS:
        log.info("  Trimmed from %d → %d chars", len(text), MAX_CHARS)
    try:
        response = client.chat.completions.create(
            model=model,
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": DISTILL_SYSTEM},
                {"role": "user",   "content": DISTILL_USER.format(
                    name=name, description=description, text=trimmed
                )},
            ],
        )
        raw = response.choices[0].message.content or "{}"
    except Exception as exc:
        log.error("  AI call failed: %s", exc)
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        s, e = raw.find("{"), raw.rfind("}") + 1
        try:
            data = json.loads(raw[s:e]) if s != -1 else {}
        except Exception:
            log.warning("  Could not parse JSON response")
            return {}

    return {
        key: [str(i).strip() for i in data.get(key, []) if str(i).strip()]
        for key in SECTION_KEYS
        if isinstance(data.get(key), list)
    }


# ── Merge ──────────────────────────────────────────────────────────────────────

def merge(all_results: list[dict]) -> dict:
    merged: dict[str, list[str]] = {k: [] for k in SECTION_KEYS}
    seen: dict[str, set] = {k: set() for k in SECTION_KEYS}
    for result in all_results:
        for key in SECTION_KEYS:
            for item in result.get(key, []):
                fp = item[:60].lower()
                if fp not in seen[key]:
                    seen[key].add(fp)
                    merged[key].append(item)
    return {k: v for k, v in merged.items() if v}


# ── DB key lookup ──────────────────────────────────────────────────────────────

def get_key_from_db() -> tuple[str, str]:
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from services.secure_settings import get_user_ai_settings
        from services.db import create_engine_async
        from sqlalchemy import text

        async def _fetch():
            eng = create_engine_async()
            async with eng.connect() as conn:
                row = (await conn.execute(
                    text("SELECT user_id FROM user_settings LIMIT 1")
                )).fetchone()
            if not row:
                return "", "gemini"
            cfg = await get_user_ai_settings(row[0])
            return (cfg.api_key or ""), (cfg.provider or "gemini")

        return asyncio.run(_fetch())
    except Exception as exc:
        log.warning("Could not read key from DB: %s", exc)
        return "", "gemini"


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Distill search methodology guidelines from systematic review books"
    )
    parser.add_argument("--api-key", default="", help="Gemini/OpenAI API key (auto from DB if omitted)")
    parser.add_argument("--provider", default="", choices=["gemini", "openai", ""], help="AI provider")
    parser.add_argument("--pdf-dir", default=str(PDF_DIR), help="Folder with the PDFs")
    parser.add_argument("--output", default="data/search_guidelines.json", help="Output path (relative to backend/)")
    parser.add_argument("--skip-existing", action="store_true", help="Merge with existing file")
    args = parser.parse_args()

    load_dotenv(Path(__file__).parent.parent / ".env")

    api_key = args.api_key or os.getenv("GEMINI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    provider = args.provider or "gemini"

    if not api_key:
        log.info("No API key provided — reading from app database...")
        api_key, db_provider = get_key_from_db()
        if not args.provider:
            provider = db_provider

    pdf_dir = Path(args.pdf_dir)
    output_path = Path(__file__).parent.parent / args.output

    if not pdf_dir.exists():
        log.error("PDF directory not found: %s", pdf_dir)
        sys.exit(1)

    existing: dict = {}
    if args.skip_existing and output_path.exists():
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        log.info("Loaded existing search guidelines")

    client, model = build_client(api_key, provider)
    log.info("Model: %s", model)

    all_results: list[dict] = []
    if existing:
        all_results.append(existing)

    for key, cfg in BOOK_CONFIGS.items():
        matches = sorted(pdf_dir.glob(cfg["glob"]))
        if not matches:
            log.warning("No PDF found for pattern: %s", cfg["glob"])
            continue

        pdf_path = matches[0]
        log.info("Processing [%s]: %s", key, pdf_path.name)
        log.info("  Pages %d–%d | %s", cfg["page_range"][0]+1, cfg["page_range"][1], cfg["description"])

        text = extract_pages(pdf_path, cfg["page_range"])
        if not text.strip():
            log.warning("  No text extracted — skipping")
            continue

        log.info("  Extracted %d chars", len(text))
        guidelines = distill(client, model, pdf_path.name, cfg["description"], text)
        total = sum(len(v) for v in guidelines.values())
        log.info("  Got %d guidelines across %d categories", total, len(guidelines))

        if guidelines:
            all_results.append(guidelines)

    if not all_results:
        log.error("No guidelines extracted.")
        sys.exit(1)

    merged = merge(all_results)
    total = sum(len(v) for v in merged.values())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    log.info("Saved %d search guidelines across %d categories → %s", total, len(merged), output_path)

    print("\n=== SEARCH GUIDELINES SUMMARY ===")
    for k in SECTION_KEYS:
        items = merged.get(k, [])
        if items:
            print(f"\n[{k.upper()}] ({len(items)} guidelines)")
            for item in items[:3]:
                print(f"  • {textwrap.shorten(item, 92, placeholder='...')}")
            if len(items) > 3:
                print(f"  ... and {len(items) - 3} more")


if __name__ == "__main__":
    main()
