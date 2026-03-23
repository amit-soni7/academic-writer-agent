from services.literature_engine import LiteratureEngine


def test_build_arxiv_search_query_quotes_plain_queries_and_deduplicates():
    engine = LiteratureEngine()

    query = engine._build_arxiv_search_query([
        "machine learning",
        "deep learning",
        "machine learning",
        "ti:transformer",
    ])

    assert query == (
        '(all:"machine learning") OR (all:"deep learning") OR (ti:transformer)'
    )


def test_arxiv_multi_collapses_expanded_queries_into_one_request(monkeypatch):
    engine = LiteratureEngine()
    captured: list[tuple[str, int]] = []

    async def _fake_search_arxiv(client, query, max_results):
        captured.append((query, max_results))
        return []

    monkeypatch.setattr(engine, "_search_arxiv", _fake_search_arxiv)

    import asyncio
    asyncio.run(engine._arxiv_multi(None, ["machine learning", "deep learning", "transformers"], 20))

    assert len(captured) == 1
    assert captured[0][1] == 20
    assert '(all:"machine learning")' in captured[0][0]
    assert '(all:"deep learning")' in captured[0][0]
