from types import SimpleNamespace

import pytest

from services.sr_protocol_generator import (
    build_evidence_pack,
    generate_phase_content,
    _parse_tagged_text_phase_response,
    write_background_from_pack,
)


class _FakeProvider:
    async def guarded_complete(self, **kwargs):
        return SimpleNamespace(text=(
            "## The Problem, Condition, or Issue\n"
            "Young adults increasingly report app-mediated partner seeking (see [SRC1]).\n\n"
            "## The Intervention (or Exposure / Phenomenon of Interest)\n"
            "Dating app use has become a common social exposure in this population [SRC1].\n\n"
            "## How the Intervention Could Work\n"
            "Repeated exposure may influence sexual decision-making and psychosocial outcomes [SRC1].\n\n"
            "## Why It Is Important to Do This Review\n"
            "Prior evidence remains fragmented and justifies a focused synthesis [SRC1].\n"
        ))

    async def complete(self, **kwargs):
        return self.guarded_complete(**kwargs)


@pytest.mark.asyncio
async def test_build_evidence_pack_uses_papers_stream_event_and_summaries(monkeypatch):
    paper = {
        "title": "Dating app use and psychosocial outcomes in young adults",
        "authors": ["Smith, Jane", "Jones, Bob", "Taylor, Chris"],
        "abstract": "Background abstract.",
        "doi": "10.1000/dating-apps",
        "year": 2024,
        "journal": "Journal of Digital Health",
        "source": "openalex",
        "citation_count": 12,
        "oa_pdf_url": "https://example.org/full.pdf",
    }

    class _FakeEngine:
        async def search_all_streaming(self, queries, total_limit, pubmed_queries=None):
            yield {"type": "papers", "papers": [paper]}
            yield {"type": "complete", "papers": [paper]}

    async def _fake_expand_query(provider, query, article_type=""):
        return SimpleNamespace(
            queries=[query],
            pubmed_queries=[f"{query}[tiab]"],
        )

    async def _fake_summarize_paper(provider, paper_obj, query, fetch_settings=None, session_id=""):
        return SimpleNamespace(model_dump=lambda: {
            "paper_key": "10.1000/dating-apps",
            "bibliography": {
                "title": paper_obj.title,
                "authors": paper_obj.authors,
                "year": paper_obj.year,
                "journal": paper_obj.journal,
                "doi": paper_obj.doi,
            },
            "methods": {"study_design": "Cross-sectional survey", "sample_n": "N=412"},
            "results": [{"finding": "Higher dating app use was associated with greater sexual risk behavior."}],
            "critical_appraisal": {"evidence_grade": "Moderate"},
            "one_line_takeaway": "Dating app exposure was associated with psychosocial and behavioral outcomes.",
            "sentence_bank": [
                {
                    "text": "Dating app use was associated with greater odds of recent sexual risk-taking among young adults.",
                    "stats": "OR=1.8 [1.2, 2.7]",
                    "importance": "high",
                    "use_in": "introduction",
                    "section": "results",
                }
            ],
            "full_text_used": True,
            "text_source": "full_pdf",
        })

    monkeypatch.setattr("services.query_expander.expand_query", _fake_expand_query)
    monkeypatch.setattr("services.literature_engine.LiteratureEngine", _FakeEngine)
    monkeypatch.setattr("services.paper_summarizer.summarize_paper", _fake_summarize_paper)

    pack = await build_evidence_pack(
        query="dating app use and psychosocial outcomes",
        ai_provider=SimpleNamespace(),
        n_articles=5,
        pico_context={"population": "young adults", "exposure": "dating app use"},
        fetch_settings=None,
    )

    assert pack["deduplicated_count"] == 1
    assert pack["summary_count"] == 1
    assert pack["summaries"][0]["paper_key"] == "10.1000/dating-apps"
    assert pack["summaries"][0]["sentence_bank"][0]["importance"] == "high"


@pytest.mark.asyncio
async def test_write_background_from_pack_uses_summary_backed_sources():
    pack = {
        "ranked_papers": [],
        "summaries": [
            {
                "source_id": "source-1",
                "paper_key": "10.1000/dating-apps",
                "bibliography": {
                    "title": "Dating app use and psychosocial outcomes in young adults",
                    "authors": ["Smith, Jane", "Jones, Bob", "Taylor, Chris"],
                    "year": 2024,
                    "journal": "Journal of Digital Health",
                    "doi": "10.1000/dating-apps",
                },
                "methods": {"study_design": "Cross-sectional survey", "sample_n": "N=412"},
                "results": [{"finding": "Higher dating app use was associated with greater sexual risk behavior."}],
                "critical_appraisal": {"evidence_grade": "Moderate"},
                "one_line_takeaway": "Dating app exposure was associated with psychosocial and behavioral outcomes.",
                "sentence_bank": [
                    {
                        "text": "Dating app use was associated with greater odds of recent sexual risk-taking among young adults.",
                        "stats": "OR=1.8 [1.2, 2.7]",
                        "importance": "high",
                        "use_in": "introduction",
                        "section": "results",
                    }
                ],
                "full_text_used": True,
                "text_source": "full_pdf",
            }
        ],
        "warnings": [],
        "deduplicated_count": 1,
        "cited_ids": [],
        "background_draft": "",
        "rationale_draft": "",
        "references_md": "",
        "references_json": [],
        "bibtex": "",
    }

    result = await write_background_from_pack(
        pack=pack,
        query="dating app use and psychosocial outcomes",
        ai_provider=_FakeProvider(),
        review_type="systematic_review",
    )

    assert "(Smith et al., 2024)" in result["pack"]["background_draft"]
    assert "## References" in result["pack"]["references_md"]
    assert "Dating app use and psychosocial outcomes in young adults" in result["pack"]["references_md"]


@pytest.mark.asyncio
async def test_write_background_from_pack_resolves_combined_markers_in_order():
    class _CombinedProvider:
        async def guarded_complete(self, **kwargs):
            return SimpleNamespace(
                text=(
                    "## The Problem, Condition, or Issue\n"
                    "Existing evidence is inconsistent across populations [SRC2, SRC1].\n\n"
                    "## The Intervention (or Exposure / Phenomenon of Interest)\n"
                    "Exposure patterns differ across platforms [SRC1].\n\n"
                    "## How the Intervention Could Work\n"
                    "Mechanisms remain plausible but under-tested [SRC2].\n\n"
                    "## Why It Is Important to Do This Review\n"
                    "A focused synthesis is still required [SRC2, SRC1].\n"
                )
            )

    pack = {
        "ranked_papers": [],
        "summaries": [
            {
                "source_id": "source-1",
                "paper_key": "10.1000/source-1",
                "bibliography": {
                    "title": "First source",
                    "authors": ["Smith, Jane", "Jones, Bob", "Taylor, Chris"],
                    "year": 2024,
                    "journal": "Journal A",
                    "doi": "10.1000/source-1",
                },
            },
            {
                "source_id": "source-2",
                "paper_key": "10.1000/source-2",
                "bibliography": {
                    "title": "Second source",
                    "authors": ["Doe, Alex"],
                    "year": 2021,
                    "journal": "Journal B",
                    "doi": "10.1000/source-2",
                },
            },
        ],
        "warnings": [],
        "deduplicated_count": 2,
        "cited_ids": [],
        "background_draft": "",
        "rationale_draft": "",
        "references_md": "",
        "references_json": [],
        "bibtex": "",
    }

    result = await write_background_from_pack(
        pack=pack,
        query="dating app use and psychosocial outcomes",
        ai_provider=_CombinedProvider(),
        review_type="systematic_review",
    )

    assert "(Doe, 2021; Smith et al., 2024)" in result["pack"]["background_draft"]
    assert result["pack"]["cited_ids"] == ["source-2", "source-1"]
    second_idx = result["pack"]["references_md"].find("Doe")
    first_idx = result["pack"]["references_md"].find("Smith")
    assert second_idx != -1 and first_idx != -1 and second_idx < first_idx


@pytest.mark.asyncio
async def test_generate_phase_content_tolerates_control_chars_in_json_response():
    class _ChatProvider:
        async def guarded_complete(self, **kwargs):
            return SimpleNamespace(
                text='{"text":"## The Problem\nLine 1\nLine 2","chat_reply":"Updated background section."}'
            )

    result = await generate_phase_content(
        phase="background",
        pico_context={"population": "Young adults", "exposure": "dating app use"},
        context_data={"review_question": "What is known about dating app use and psychosocial outcomes?"},
        current_content={"text": "Old draft"},
        messages=[{"role": "user", "text": "Revise the background using a tighter narrative."}],
        ai_provider=_ChatProvider(),
        review_type="systematic_review",
        mode="direct",
    )

    assert result["reply"] == "Updated background section."
    assert "Line 1\nLine 2" in result["content"]["text"]


def test_parse_tagged_text_phase_response_extracts_reply_and_text():
    reply, text = _parse_tagged_text_phase_response(
        "CHAT_REPLY:\nUpdated the background for clarity.\n\nTEXT:\n<<<\n## The Problem\nParagraph one.\n>>>\n"
    )

    assert reply == "Updated the background for clarity."
    assert text == "## The Problem\nParagraph one."


@pytest.mark.asyncio
async def test_generate_phase_content_background_uses_tagged_text_mode():
    class _TaggedProvider:
        async def guarded_complete(self, **kwargs):
            return SimpleNamespace(
                text=(
                    "CHAT_REPLY:\nTightened the background and preserved the four required headings.\n\n"
                    "TEXT:\n<<<\n"
                    "## The Problem, Condition, or Issue\nParagraph one.\n\n"
                    "## The Intervention (or Exposure / Phenomenon of Interest)\nParagraph two.\n\n"
                    "## How the Intervention Could Work\nParagraph three.\n\n"
                    "## Why It Is Important to Do This Review\nParagraph four.\n"
                    ">>>"
                )
            )

    result = await generate_phase_content(
        phase="background",
        pico_context={"population": "Young adults", "exposure": "dating app use"},
        context_data={"review_question": "What is known about dating app use and psychosocial outcomes?"},
        current_content={"text": "Old draft"},
        messages=[{"role": "user", "text": "Revise the background using a tighter narrative."}],
        ai_provider=_TaggedProvider(),
        review_type="systematic_review",
        mode="direct",
    )

    assert result["reply"] == "Tightened the background and preserved the four required headings."
    assert result["content"]["text"].startswith("## The Problem, Condition, or Issue")


@pytest.mark.asyncio
async def test_generate_phase_content_background_refreshes_evidence_pack_references():
    class _TaggedCitationProvider:
        async def guarded_complete(self, **kwargs):
            return SimpleNamespace(
                text=(
                    "CHAT_REPLY:\nUpdated the background and preserved citations.\n\n"
                    "TEXT:\n<<<\n"
                    "## The Problem, Condition, or Issue\nEvidence remains fragmented [SRC2, SRC1].\n\n"
                    "## The Intervention (or Exposure / Phenomenon of Interest)\nExposure differs across apps [SRC1].\n\n"
                    "## How the Intervention Could Work\nMechanisms are still uncertain [SRC2].\n\n"
                    "## Why It Is Important to Do This Review\nA focused review is justified [SRC2, SRC1].\n"
                    ">>>"
                )
            )

    evidence_pack = {
        "ranked_papers": [],
        "summaries": [
            {
                "source_id": "source-1",
                "paper_key": "10.1000/source-1",
                "bibliography": {
                    "title": "First source",
                    "authors": ["Smith, Jane", "Jones, Bob", "Taylor, Chris"],
                    "year": 2024,
                    "journal": "Journal A",
                    "doi": "10.1000/source-1",
                },
            },
            {
                "source_id": "source-2",
                "paper_key": "10.1000/source-2",
                "bibliography": {
                    "title": "Second source",
                    "authors": ["Doe, Alex"],
                    "year": 2021,
                    "journal": "Journal B",
                    "doi": "10.1000/source-2",
                },
            },
        ],
        "cited_ids": [],
        "background_draft": "",
        "rationale_draft": "",
        "references_md": "",
        "references_json": [],
        "bibtex": "",
    }

    result = await generate_phase_content(
        phase="background",
        pico_context={"population": "Young adults", "exposure": "dating app use"},
        context_data={
            "review_question": "What is known about dating app use and psychosocial outcomes?",
            "evidence_pack": evidence_pack,
        },
        current_content={"text": "Old draft"},
        messages=[{"role": "user", "text": "Revise the background using the evidence pack."}],
        ai_provider=_TaggedCitationProvider(),
        review_type="systematic_review",
        mode="direct",
    )

    assert result["content"]["text"].startswith("## The Problem, Condition, or Issue")
    assert "(Doe, 2021; Smith et al., 2024)" in result["content"]["text"]
    assert result["content"]["cited_ids"] == ["source-2", "source-1"]
    assert "## References" in result["content"]["references_md"]
    assert "@article{" in result["content"]["bibtex"]
