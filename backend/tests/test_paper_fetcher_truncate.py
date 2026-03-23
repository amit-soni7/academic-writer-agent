from services.paper_fetcher import MAX_CHARS, _truncate


def test_truncate_preserves_results_and_discussion_sections():
    text = (
        "Abstract\n"
        + ("Introductory context. " * 900)
        + "\nMethods\n"
        + ("Method detail. " * 900)
        + "\nResults\n"
        + ("Result detail with OR=1.8 and p=0.01. " * 900)
        + "\nDiscussion\n"
        + ("Important discussion insight about interpretation and implications. " * 900)
    )

    truncated = _truncate(text)

    assert len(truncated) <= MAX_CHARS
    assert "Abstract" in truncated
    assert "Results" in truncated
    assert "Discussion" in truncated
    assert "Important discussion insight" in truncated
