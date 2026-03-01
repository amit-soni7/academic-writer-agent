# Journal-Aware Writing Pipeline

This document describes how the academic writer app discovers and applies each journal's writing, citation, and referencing style when generating a manuscript.

---

## Overview

Every academic journal has its own requirements for:

| Dimension | Examples |
|-----------|---------|
| In-text citation format | Numbered [1], Superscript¹, Author-Year (Smith, 2023) |
| Reference list format | Vancouver, AMA, APA, Nature, Cell, Science, IEEE |
| Reference sort order | Order of appearance vs. alphabetical |
| Accepted article types | Original research, Review, Case report, Short communication … |
| Section structure | Order and names of manuscript sections per article type |
| Word limits | Per article type (e.g. 3 500 w for NEJM original research) |
| Abstract structure | Structured (PICO headings) vs. unstructured (single paragraph) |
| Abstract word limit | 125–350 words depending on journal |
| Maximum references | 30 (Science) to unlimited (eLife) |

The journal-aware pipeline resolves all these dimensions automatically and injects them into the AI writing prompt.

---

## Architecture: 4-Tier Style Resolution

`JournalStyleService.get_style(journal_name, provider, publisher)` resolves a `JournalStyle` object through four tiers, stopping at the first hit:

```
Tier 1 — Curated table          confidence 1.0
  backend/data/journal_styles.json
  Exact match → alias match → fuzzy word-overlap match
  45+ journals hand-coded with complete metadata

Tier 2 — Publisher default      confidence 0.8
  publisher_defaults map in journal_styles.json
  Maps publisher name → citation style
  Handles all Elsevier, Nature Portfolio, Cell Press, etc.

Tier 3 — LLM inference          confidence 0.6
  Asks the user's configured AI provider for the journal's full profile
  Returns: citation style, in-text format, accepted article types,
           sections per type, word limits, abstract structure,
           abstract word limit, max references
  Result cached in journal_style_cache DB table (90-day TTL)

Tier 4 — Universal fallback     confidence 0.5
  AMA/NLM numbered format, no specific sections or word limits
```

### Data Model

```python
@dataclass
class JournalStyle:
    journal_name: str
    citation_style: CitationStyle          # ama | vancouver | nlm | nature | cell | apa | harvard | science | ieee | default
    in_text_format: str                    # "numbered" | "superscript" | "author_year"
    reference_sort_order: str             # "order_of_appearance" | "alphabetical"
    accepted_article_types: list[str]     # e.g. ["original_research", "review", "case_report"]
    max_references: int | None
    abstract_structure: str | None        # "structured" | "unstructured"
    abstract_word_limit: int | None
    word_limits: dict[str, int | None]    # by article type
    sections_by_type: dict[str, list[str]]# section list per article type
    reference_format_name: str            # human name: "AMA", "Vancouver", "Nature" …
    source: str                           # tier that resolved it
    confidence: float                     # 0.5 – 1.0
```

---

## Supported Article Types

| Type | `article_type` value | Typical word limit |
|------|---------------------|-------------------|
| Original Research | `original_research` | 3 000–6 000 |
| Systematic Review | `review` | 4 000–8 000 |
| Meta-Analysis | `meta_analysis` | 3 500–5 000 |
| Case Report | `case_report` | 1 500–3 000 |
| Brief Report | `brief_report` | 2 000–3 000 |
| Short Communication | `short_communication` | 1 500–2 500 |
| Editorial | `editorial` | 1 000–2 000 |
| Letter to the Editor | `letter` | 400–800 |

Default sections when the journal has no specific sections are defined in `_DEFAULT_SECTIONS_BY_TYPE` inside `journal_style_service.py`.

---

## How Styles Are Applied During Article Generation

When `POST /api/sessions/{id}/write_article` is called:

```
1. Resolve journal style via 4-tier lookup
   ↓
2. Build system prompt
   a. Base CEILS writing rules
   b. Journal-specific citation instructions (replaces hardcoded example)
   c. Abstract structure instructions
      - Structured: "Write a structured abstract with these headings: Background, Objective, Methods, Results, Conclusions. Total abstract: ≤250 words."
      - Unstructured: "Write an unstructured (single-paragraph) abstract. Keep it ≤150 words."
   d. Max references constraint (if journal specifies)
   e. Section-specific writing guidelines (Introduction, Methods, Results, Discussion…)
   ↓
3. Build user message
   a. Approved manuscript title (gate: must be set via approve_title before write_article)
   b. Research topic
   c. Target journal
   d. Article type (human-readable)
   e. Effective word limit
      - Journal limit overrides user slider if journal specifies one
      - User's selection used otherwise
   f. Required sections list
   g. Condensed paper summaries (max 30 papers with evidence grades)
   h. Pre-formatted reference list in journal style (prevents hallucination)
```

### Pre-formatted Reference List — CSL-Powered

`JournalStyle.format_reference_list(summaries)` generates references server-side using the
[Citation Style Language](https://github.com/citation-style-language/styles) (CSL) standard.

**Architecture:**

```
JournalStyle.format_reference_list(summaries)
  │
  ├─ csl_id resolved (from journal data or STYLE_TO_CSL_ID mapping)
  │    e.g. "american-medical-association", "nature", "bmj", "elife" …
  │
  ├─ services/csl_formatter.py
  │    ├─ bib_to_csl_item()     — converts our bibliography dict → CSL-JSON
  │    ├─ _parse_author()       — parses "Smith AB" → {family: "Smith", given: "A.B."}
  │    └─ format_references_csl() — renders via citeproc-py + bundled CSL file
  │
  └─ Fallback: hand-coded formatter (if CSL file unavailable)
```

**Bundled CSL style files** (`backend/csl_styles/`):

| CSL File | Journals |
|----------|---------|
| `american-medical-association.csl` | JAMA, AHA, JNCI, JACC, Cancer, JAMIA … |
| `elsevier-vancouver.csl` | Lancet, Gut, Annals of Oncology … |
| `nature.csl` | Nature, Nature Medicine, Nature Communications, Scientific Reports … |
| `cell.csl` | Cell, Molecular Cell, Cell Reports, Neuron … |
| `apa.csl` | Brain, PLOS, Psychological Science, JMIR … |
| `science.csl` | Science, Science Advances |
| `bmj.csl` | BMJ, Thorax, Gut |
| `elife.csl` | eLife |
| `frontiers.csl` | Frontiers in Medicine, Frontiers in Neuroscience |
| `ieee.csl` | IEEE journals |
| `elsevier-harvard.csl` | European Heart Journal, Elsevier Harvard-style |
| `harvard-cite-them-right.csl` | Harvard author-date |
| `chest.csl` | CHEST |

The reference list is passed verbatim in the user message with the instruction: "Copy this VERBATIM into your References section."

---

## Fallback Behavior for Incomplete Metadata

Each field degrades gracefully:

| Field | Fallback behaviour |
|-------|-------------------|
| `sections_by_type` empty | Use `_DEFAULT_SECTIONS_BY_TYPE[article_type]` |
| `word_limits` has no entry for article type | Use user's word limit slider value |
| `abstract_structure` is `null` | No abstract structure instruction in prompt |
| `max_references` is `null` | No max references constraint in prompt |
| LLM inference fails | Fall through to Tier 4 default |
| Publisher not in defaults | Fall through to Tier 4 default |

---

## Journal Catalog

The curated table (`backend/data/journal_styles.json`) covers 45+ high-impact journals:

**Clinical / Medical**
Nature Medicine, NEJM, JAMA, JAMA Psychiatry, The Lancet, Lancet Oncology, Lancet Digital Health, BMJ, Annals of Internal Medicine, CHEST, Gut, Thorax, JACC, European Heart Journal, Circulation, Clinical Infectious Diseases, Journal of Clinical Oncology, Annals of Oncology, JNCI, Cancer

**Basic Science**
Nature, Nature Communications, Nature Biotechnology, Nature Climate Change, Scientific Reports, Cell, Molecular Cell, Cell Reports, Cell Host & Microbe, Neuron

**Neuroscience / Psychology**
Brain, Journal of Neuroscience, Psychological Science

**Multidisciplinary / Open Access**
Science, Science Advances, PNAS, eLife, PLOS ONE, PLOS Biology, PLOS Medicine, PLOS Computational Biology, F1000Research

**Informatics / Digital Health**
JAMIA, Journal of Medical Internet Research

**Frontiers Series**
Frontiers in Medicine, Frontiers in Neuroscience

**Bioinformatics**
Bioinformatics

**Environmental**
Environmental Science & Technology

---

## API Reference

### `GET /api/journal-style`

```
?name=JAMA&publisher=American+Medical+Association
```

Returns `JournalStyleResponse` with all metadata. No LLM call — Tier 1–2 only from this endpoint.

### `POST /api/sessions/{id}/write_article`

Accepts `WriteArticleRequest`:

```json
{
  "session_id": "abc123",
  "selected_journal": "JAMA",
  "article_type": "case_report",
  "word_limit": 1500
}
```

The `word_limit` field is the user's preference but may be overridden by the journal's own word limit for that article type.

### `POST /api/sessions/{id}/write_article_sync`

Same as above but returns `{ article, word_count }` as JSON (non-streaming).

---

## Frontend Behaviour

When a journal is selected (`JournalsDashboard` → `ArticleWriter`):

1. `GET /api/journal-style?name=<journal>` is called automatically.
2. The **Article Type** dropdown is filtered to only accepted types for that journal.
3. If the journal specifies a word limit for the current article type, the **Word Limit** slider auto-updates.
4. Badges show: citation style, abstract structure, max references limit.
5. When the article type changes, the word limit auto-updates from the journal's `word_limits` map.

---

## Adding a New Journal to the Curated Table

Edit `backend/data/journal_styles.json` and add an entry to the `"journals"` array:

```json
{
  "name": "Exact Journal Name",
  "aliases": ["Abbrev", "ISSN alias"],
  "publisher": "Publisher Name",
  "citation_style": "ama",
  "in_text_format": "numbered",
  "reference_sort_order": "order_of_appearance",
  "accepted_article_types": ["original_research", "review", "case_report"],
  "max_references": 40,
  "abstract_structure": "structured",
  "abstract_word_limit": 250,
  "word_limits": {
    "original_research": 3500,
    "review": 5000,
    "case_report": 1500
  },
  "sections_by_type": {
    "original_research": ["Abstract", "Introduction", "Methods", "Results", "Discussion", "References"],
    "review": ["Abstract", "Introduction", "Methods", "Results", "Discussion", "Conclusions", "References"],
    "case_report": ["Abstract", "Introduction", "Case Report", "Discussion", "References"]
  },
  "reference_format_name": "AMA"
}
```

No code changes are needed — the service loads the file at startup.

Also add the publisher to `publisher_defaults` if it's new:

```json
"publisher_defaults": {
  "New Publisher Name": "ama"
}
```

---

## Running the Tests

```bash
cd backend
pip install pytest pytest-asyncio citeproc-py
pytest tests/test_journal_style_service.py -v
pytest tests/test_article_prompt.py -v
```

Both test files use only in-process mocks and do not require a database or running server.

### CSL Style Files

Bundled CSL files live in `backend/csl_styles/`. Unknown styles are fetched on demand
from `https://github.com/citation-style-language/styles` and cached in `backend/csl_styles/_cache/`.

To add a new bundled style:
```bash
cd backend/csl_styles
curl -O https://raw.githubusercontent.com/citation-style-language/styles/master/my-journal.csl
```

Then set `"csl_id": "my-journal"` in `backend/data/journal_styles.json`.
