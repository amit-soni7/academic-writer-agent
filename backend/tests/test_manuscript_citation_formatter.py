from services.manuscript_citation_formatter import (
    analyze_citation_status,
    normalize_numbered_citation_order,
    reinject_citation_markers,
)


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


def _summary(
    paper_key: str,
    title: str,
    *,
    authors: list[str] | None = None,
    year: int | None = None,
    doi: str | None = None,
) -> dict:
    return {
        "paper_key": paper_key,
        "bibliography": {
            "title": title,
            "authors": authors or [],
            "year": year,
            "doi": doi,
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

    # [CITE:key] tags are preserved; only numeric citations are renumbered
    assert "First claim [CITE:beta] [1]" in normalized
    assert "Second claim [CITE:alpha] [2]" in normalized
    assert "Repeat claim [CITE:beta] [1]" in normalized
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
    # Evidence purpose tags like [BKG] are stripped, duplicate numbers deduplicated
    expected = """# Title

## Introduction

First claim [CITE:missing] [9].

## References

9. Missing Study
"""
    normalized = normalize_numbered_citation_order(
        article,
        _FakeStyle(),
        [_summary("alpha", "Alpha Study")],
    )

    assert normalized == expected


def test_analyze_citation_status_numeric_fallback_matches_doi_and_author_year():
    article = """# Title

## Introduction

First claim [1].
Second claim [2].

## References

1. Smith AB. Alpha Study. J Test. 2020;1(1):1-2. https://doi.org/10.1146/annurev-clinpsy-032816-045244.
2. Jones CD. Another beta finding. J Test. 2021;2(1):3-4.
"""
    status = analyze_citation_status(
        article,
        [
            _summary(
                "10.1146/annurev-clinpsy-032816-045244",
                "Alpha Study",
                authors=["Smith, A. B."],
                year=2020,
                doi="10.1146/annurev-clinpsy-032816-045244",
            ),
            _summary(
                "10.1000/beta",
                "Beta Result",
                authors=["Jones, C. D."],
                year=2021,
                doi="10.1000/beta",
            ),
        ],
    )

    assert status["summary"]["resolved"] == 2
    assert status["summary"]["unresolved"] == 0
    assert [c["resolved_key"] for c in status["citations"]] == [
        "10.1146/annurev-clinpsy-032816-045244",
        "10.1000/beta",
    ]


def test_analyze_citation_status_uses_stored_citation_map_for_numeric_only_manuscript():
    article = """# Title

## Introduction

First claim [1].
Second claim [2].

## References

1. Legacy Ref One.
2. Legacy Ref Two.
"""
    stored_map = {
        "alpha2020": "alpha",
        "beta2021": "beta",
    }
    status = analyze_citation_status(
        article,
        [
            _summary("alpha", "Alpha Study", authors=["Alpha, A."], year=2020),
            _summary("beta", "Beta Study", authors=["Beta, B."], year=2021),
        ],
        stored_citation_map=stored_map,
    )

    assert status["summary"]["resolved"] == 2
    assert [c["resolved_key"] for c in status["citations"]] == ["alpha", "beta"]


def test_reinject_citation_markers_restores_numeric_only_manuscript_from_saved_map():
    article = """# Title

## Introduction

First claim [1, 2].
Second claim [2-3].

## References

1. Alpha Study.
2. Beta Study.
3. Gamma Study.
"""
    restored = reinject_citation_markers(
        article,
        {
            "alpha2020": "alpha",
            "beta2021": "beta",
            "gamma2022": "gamma",
        },
    )

    assert "First claim [CITE:alpha] [CITE:beta] [1, 2]." in restored
    assert "Second claim [CITE:beta] [CITE:gamma] [2-3]." in restored
    assert "## References\n\n1. Alpha Study." in restored
