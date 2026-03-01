"""
conftest.py — shared pytest fixtures for backend tests.
"""
import pytest


class _MockProvider:
    """Minimal AI provider mock that returns configurable JSON responses."""

    def __init__(self, response_dict: dict = None):
        self._response = response_dict or {}
        self.calls: list[dict] = []

    async def complete(self, system: str, user: str, json_mode: bool = False, temperature: float = 0.7) -> str | dict:
        import json
        self.calls.append({"system": system, "user": user})
        if json_mode:
            return self._response
        return json.dumps(self._response)


@pytest.fixture
def mock_provider_ama():
    return _MockProvider({
        "citation_style": "ama",
        "in_text_format": "numbered",
        "reference_sort_order": "order_of_appearance",
        "accepted_article_types": ["original_research", "review"],
        "reference_format_name": "AMA",
        "max_references": None,
        "abstract_structure": None,
        "abstract_word_limit": None,
        "word_limits": {},
        "sections_by_type": {},
    })


@pytest.fixture
def mock_provider_apa():
    return _MockProvider({
        "citation_style": "apa",
        "in_text_format": "author_year",
        "reference_sort_order": "alphabetical",
        "accepted_article_types": ["original_research", "review"],
        "reference_format_name": "APA",
        "max_references": None,
        "abstract_structure": "unstructured",
        "abstract_word_limit": 300,
        "word_limits": {},
        "sections_by_type": {},
    })


@pytest.fixture
def mock_provider_full():
    """
    Full-metadata mock: AMA, structured abstract, 40 max refs,
    original_research + review + case_report, word limits, sections.
    """
    return _MockProvider({
        "citation_style": "ama",
        "in_text_format": "numbered",
        "reference_sort_order": "order_of_appearance",
        "reference_format_name": "AMA",
        "accepted_article_types": ["original_research", "review", "case_report"],
        "max_references": 40,
        "abstract_structure": "structured",
        "abstract_word_limit": 250,
        "word_limits": {
            "original_research": 4000,
            "review": 5000,
            "case_report": 1500,
        },
        "sections_by_type": {
            "original_research": [
                "Abstract", "Introduction", "Methods",
                "Results", "Discussion", "Conclusions", "References",
            ],
            "review": [
                "Abstract", "Introduction", "Methods (Literature Search)",
                "Results", "Discussion", "Conclusions", "References",
            ],
            "case_report": [
                "Abstract", "Introduction", "Case Report",
                "Discussion", "References",
            ],
        },
    })


@pytest.fixture
def sample_summaries():
    """Two minimal paper summaries for reference formatting tests."""
    return [
        {
            "paper_key": "smith2020",
            "bibliography": {
                "authors": ["Smith AB", "Jones CD"],
                "year": 2020,
                "title": "Cognitive Therapy Outcomes",
                "journal": "J Psychiatry",
                "volume": "34",
                "issue": "5",
                "pages": "123-130",
                "doi": "10.1234/jpsy.2020.123",
            },
            "one_line_takeaway": "CBT reduces PHQ-9 scores significantly.",
            "results": [{"finding": "PHQ-9 reduced by 5.2 points", "effect_size": "d=0.52"}],
            "methods": {"study_design": "RCT", "sample_n": "120"},
            "critical_appraisal": {"evidence_grade": "High"},
        },
        {
            "paper_key": "wang2019",
            "bibliography": {
                "authors": ["Wang X", "Lee Y", "Chen Z"],
                "year": 2019,
                "title": "Mindfulness-Based Stress Reduction",
                "journal": "Psychol Med",
                "volume": "49",
                "issue": "3",
                "pages": "400-412",
                "doi": "10.1017/psych.2019.45",
            },
            "one_line_takeaway": "MBSR shows moderate effect on anxiety.",
            "results": [{"finding": "GAD-7 reduced by 3.1 points", "effect_size": "d=0.38"}],
            "methods": {"study_design": "RCT", "sample_n": "85"},
            "critical_appraisal": {"evidence_grade": "Moderate"},
        },
    ]
