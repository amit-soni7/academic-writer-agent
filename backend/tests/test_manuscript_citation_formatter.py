from services.manuscript_citation_formatter import normalize_numbered_citation_order


class _FakeStyle:
    def __init__(self, *, in_text_format: str = "numbered", reference_sort_order: str = "order_of_appearance"):
        self.in_text_format = in_text_format
        self.reference_sort_order = reference_sort_order

    def format_reference_list(self, summaries: list[dict]) -> str:
        lines = []
        for idx, summary in enumerate(summaries, 1):
            title = summary.get("bibliography", {}).get("title") or summary.get("paper_key")
            lines.append(f"{idx}. {title}")
        return "\n".join(lines)


def _summary(paper_key: str, title: str) -> dict:
    return {
        "paper_key": paper_key,
        "bibliography": {
            "title": title,
        },
    }


def test_normalize_numbered_citation_order_renumbers_body_and_references():
    article = """# Title

## Introduction

First claim [CITE:beta] [9] [BKG].
Second claim [CITE:alpha] [4] [EMP].
Repeat claim [CITE:beta] [9] [SUP].

## References

4. Alpha Study
9. Beta Study
"""
    normalized = normalize_numbered_citation_order(
        article,
        _FakeStyle(),
        [_summary("alpha", "Alpha Study"), _summary("beta", "Beta Study")],
    )

    assert "First claim [CITE:beta] [1] [BKG]." in normalized
    assert "Second claim [CITE:alpha] [2] [EMP]." in normalized
    assert "Repeat claim [CITE:beta] [1] [SUP]." in normalized
    assert "## References\n\n1. Beta Study\n2. Alpha Study" in normalized


def test_normalize_numbered_citation_order_leaves_author_year_styles_unchanged():
    article = """# Title

## Introduction

First claim [CITE:beta] (Beta et al., 2024).
"""
    normalized = normalize_numbered_citation_order(
        article,
        _FakeStyle(in_text_format="author_year"),
        [_summary("beta", "Beta Study")],
    )

    assert normalized == article


def test_normalize_numbered_citation_order_skips_when_summary_key_is_missing():
    article = """# Title

## Introduction

First claim [CITE:missing] [9] [BKG].

## References

9. Missing Study
"""
    normalized = normalize_numbered_citation_order(
        article,
        _FakeStyle(),
        [_summary("alpha", "Alpha Study")],
    )

    assert normalized == article
