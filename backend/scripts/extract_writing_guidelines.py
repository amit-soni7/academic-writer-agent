"""
extract_writing_guidelines.py

One-time script: reads every PDF in a folder of academic writing books,
uses AI (Gemini or OpenAI) to distill actionable writing guidelines by
article section, then merges and saves the result to
backend/data/writing_guidelines.json.

Usage (from backend/ directory, with venv active):

    # With Gemini (recommended — fast, cheap):
    python scripts/extract_writing_guidelines.py --api-key YOUR_GEMINI_KEY

    # With OpenAI:
    python scripts/extract_writing_guidelines.py --api-key sk-... --provider openai

    # Custom PDF folder or output:
    python scripts/extract_writing_guidelines.py \\
        --api-key YOUR_KEY \\
        --pdf-dir "/Users/amit/Downloads/How to write" \\
        --output data/writing_guidelines.json

    # Rerun and merge with existing (add new books without reprocessing old ones):
    python scripts/extract_writing_guidelines.py --api-key YOUR_KEY --skip-existing
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

# ── Constants ─────────────────────────────────────────────────────────────────

SECTION_KEYS = [
    "general",
    "title",
    "abstract",
    "introduction",
    "methods",
    "results",
    "discussion",
    "conclusion",
    "style",
]

# Maximum characters to send to the AI per book (≈ 40–50k tokens for Gemini)
MAX_CHARS_PER_BOOK = 60_000

# Max pages to extract from each PDF
MAX_PAGES = 80

DISTILL_SYSTEM = """\
You are an expert academic writing consultant.

Read the following excerpt from a book about academic and scientific writing.
Extract ONLY actionable writing guidelines — specific rules, techniques, or
advice that a researcher should follow when writing a scientific manuscript.

Do NOT include:
- Descriptions of what the book covers
- General summaries or paraphrases of chapters
- Vague advice (e.g. "write clearly")

DO include:
- Concrete structural advice (e.g. "Start the Introduction with the broad \
context, then narrow to the gap, then state your aim in the final paragraph")
- Language/style rules (e.g. "Avoid nominalizations: prefer 'we measured' \
over 'measurement was performed'")
- Section-specific techniques sourced from the actual book text

Organize guidelines into these category keys:
  general      — applies to the whole paper
  title        — writing effective titles
  abstract     — writing effective abstracts
  introduction — writing the Introduction section
  methods      — writing the Methods section
  results      — presenting Results clearly
  discussion   — writing the Discussion section
  conclusion   — writing the Conclusion / Summary section
  style        — language, sentence structure, clarity, avoiding junk English

Return ONLY valid JSON with exactly these keys (omit any key you found no
content for). Each value is a list of strings. Each guideline must be a
single, concise, actionable sentence or two (max). Extract 4–10 per category.

Example format:
{
  "introduction": [
    "Open with the broad context of the field before narrowing to the specific problem.",
    "State the knowledge gap explicitly before announcing the aim of the study."
  ],
  "style": [
    "Prefer active voice: 'We measured' not 'Measurements were taken'."
  ]
}
"""

DISTILL_USER = """\
Book / document: {name}

--- BEGIN TEXT ---
{text}
--- END TEXT ---

Return the JSON guidelines now.
"""

PAPERS_DISTILL_SYSTEM = """\
You are an expert academic writing consultant analyzing a published research paper.
Extract actionable writing patterns and conventions that characterize high-quality
academic writing in this field.

Focus ONLY on structural/stylistic patterns — not subject matter content:
- How the Introduction is structured (broad context → knowledge gap → aim → contribution)
- How citations support claims (frequency, placement, hedging language e.g. "suggests", "indicates")
- How Results are narrated alongside statistics
- How the Discussion reframes findings (restate → interpret → compare with literature → limitations)
- Sentence-level style: active vs passive, hedging phrases, transition words between paragraphs
- Abstract density and structure

Return ONLY valid JSON with these keys (omit any you found no content for).
Each value: 4–8 concise, actionable guideline strings.
{
  "introduction": [...], "methods": [...], "results": [...],
  "discussion": [...], "abstract": [...], "style": [...], "general": [...]
}
"""


# ── PDF extraction ─────────────────────────────────────────────────────────────

def extract_pdf_text(path: Path, max_pages: int = MAX_PAGES) -> str:
    """Extract plain text from a PDF, up to max_pages pages."""
    parts = []
    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages[:max_pages]:
                text = page.extract_text(x_tolerance=2, y_tolerance=2)
                if text and text.strip():
                    parts.append(text.strip())
    except Exception as exc:
        log.warning("pdfplumber error on %s: %s", path.name, exc)
    return "\n\n".join(parts)


# ── AI distillation ───────────────────────────────────────────────────────────

def build_client(api_key: str, provider: str) -> tuple[OpenAI, str]:
    """Return an OpenAI-compatible client + model string."""
    if not api_key:
        raise RuntimeError(
            "API key required. Pass --api-key YOUR_KEY or set GEMINI_API_KEY "
            "in backend/.env"
        )
    if provider == "openai":
        log.info("Using OpenAI (gpt-4o-mini)")
        return OpenAI(api_key=api_key), "gpt-4o-mini"

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    log.info("Using Gemini (%s)", model)
    return (
        OpenAI(
            api_key=api_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
        model,
    )


def distill_guidelines(client: OpenAI, model: str, name: str, text: str, system_prompt: str = DISTILL_SYSTEM) -> dict:
    """Call the AI and return { section_key: [guideline, ...] }."""
    trimmed = text[:MAX_CHARS_PER_BOOK]
    if len(text) > MAX_CHARS_PER_BOOK:
        log.info("  Trimmed from %d → %d chars", len(text), MAX_CHARS_PER_BOOK)

    try:
        response = client.chat.completions.create(
            model=model,
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": DISTILL_USER.format(name=name, text=trimmed)},
            ],
        )
        raw = response.choices[0].message.content or "{}"
    except Exception as exc:
        log.error("  AI call failed for %s: %s", name, exc)
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}") + 1
        try:
            data = json.loads(raw[start:end]) if start != -1 else {}
        except Exception:
            log.warning("  Could not parse JSON response for %s", name)
            return {}

    # Keep only known keys with list values
    return {
        key: [str(i).strip() for i in data.get(key, []) if str(i).strip()]
        for key in SECTION_KEYS
        if isinstance(data.get(key), list)
    }


# ── Merge ──────────────────────────────────────────────────────────────────────

def merge_guidelines(all_results: list[dict]) -> dict:
    """Merge guidelines from multiple books, deduplicating by first 60 chars."""
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


# ── Main ───────────────────────────────────────────────────────────────────────

def _get_key_from_db() -> tuple[str, str]:
    """Read the first user's API key + provider from the app's Postgres DB."""
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from services.secure_settings import get_user_ai_settings
        from sqlalchemy import text
        from services.db import create_engine_async

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


def main():
    parser = argparse.ArgumentParser(
        description="Distill writing guidelines from academic writing PDFs"
    )
    parser.add_argument(
        "--api-key",
        default="",
        help="Gemini or OpenAI API key. Omit to auto-read from the app DB.",
    )
    parser.add_argument(
        "--provider",
        default="",
        choices=["gemini", "openai", ""],
        help="AI provider (default: auto-detect from DB or 'gemini')",
    )
    parser.add_argument(
        "--pdf-dir",
        default="/Users/amit/Downloads/How to write",
        help="Folder containing the writing-guide PDFs",
    )
    parser.add_argument(
        "--output",
        default="data/writing_guidelines.json",
        help="Output JSON file path (relative to backend/)",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Load existing output and merge new books into it",
    )
    parser.add_argument(
        "--mode",
        default="books",
        choices=["books", "papers"],
        help="'books'=writing guide books (default); 'papers'=extract style from research papers",
    )
    args = parser.parse_args()

    # Load .env
    env_path = Path(__file__).parent.parent / ".env"
    load_dotenv(env_path)

    # Resolve API key: CLI arg > env var > app DB
    api_key = args.api_key or os.getenv("GEMINI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "")
    provider = args.provider or "gemini"

    if not api_key:
        log.info("No API key provided — reading from app database...")
        api_key, db_provider = _get_key_from_db()
        if not args.provider:
            provider = db_provider

    pdf_dir = Path(args.pdf_dir)
    output_path = Path(__file__).parent.parent / args.output

    if not pdf_dir.exists():
        log.error("PDF directory not found: %s", pdf_dir)
        sys.exit(1)

    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        log.error("No PDF files found in %s", pdf_dir)
        sys.exit(1)

    log.info("Found %d PDF files in %s", len(pdfs), pdf_dir)

    existing: dict = {}
    if args.skip_existing and output_path.exists():
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        log.info("Loaded existing guidelines from %s", output_path)

    client, model = build_client(api_key, provider)

    system = PAPERS_DISTILL_SYSTEM if args.mode == "papers" else DISTILL_SYSTEM
    log.info("Mode: %s", args.mode)

    all_results: list[dict] = []
    if existing:
        all_results.append(existing)

    for pdf_path in pdfs:
        log.info("Processing: %s", pdf_path.name)
        text = extract_pdf_text(pdf_path)
        if not text.strip():
            log.warning("  No text extracted — skipping")
            continue

        log.info("  Extracted %d chars (~%d pages)", len(text), len(text) // 500)
        guidelines = distill_guidelines(client, model, pdf_path.name, text, system_prompt=system)

        total = sum(len(v) for v in guidelines.values())
        log.info("  Got %d guidelines across %d categories", total, len(guidelines))

        if guidelines:
            all_results.append(guidelines)

    if not all_results:
        log.error("No guidelines extracted. Check your API key and PDF content.")
        sys.exit(1)

    merged = merge_guidelines(all_results)
    total_guidelines = sum(len(v) for v in merged.values())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")

    log.info(
        "Saved %d guidelines across %d sections → %s",
        total_guidelines, len(merged), output_path,
    )

    print("\n=== GUIDELINES SUMMARY ===")
    for key in SECTION_KEYS:
        items = merged.get(key, [])
        if items:
            print(f"\n[{key.upper()}] ({len(items)} guidelines)")
            for item in items[:3]:
                print(f"  • {textwrap.shorten(item, width=90, placeholder='...')}")
            if len(items) > 3:
                print(f"  ... and {len(items) - 3} more")


if __name__ == "__main__":
    main()
