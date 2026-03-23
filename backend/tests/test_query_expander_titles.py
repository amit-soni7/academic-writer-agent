from services.query_expander import (
    heuristic_tentative_title,
    looks_like_low_quality_title,
)


def test_heuristic_title_uses_focus_phrase_for_abstract_queries() -> None:
    query = (
        "Most psychological research is conducted within the framework of a single theoretical perspective, "
        "testing hypotheses in isolation. Adversarial testing—a collaborative research approach for directly "
        "contrasting competing theoretical predictions—offers a promising path toward resolving such debates."
    )

    title = heuristic_tentative_title(query, "original_research")

    assert title == "Adversarial Testing in Psychology: An Evidence Review"


def test_heuristic_title_preserves_explicit_title_prefix() -> None:
    query = (
        "Risk Behaviors and Psychological Impacts of Dating App Use in Emerging Adults\n\n"
        "Dating app use in emerging adults is consistently associated with elevated sexual risk behaviors."
    )

    title = heuristic_tentative_title(query, "systematic_review")

    assert title == "Risk Behaviors and Psychological Impacts of Dating App Use in Emerging Adults"


def test_low_quality_title_detector_catches_malformed_model_output() -> None:
    assert looks_like_low_quality_title("Advancing Psychological Science Andmental Health Research Through Adversarial Collaboration")
    assert looks_like_low_quality_title("Emerging Adults Including: A Systematic Review")
