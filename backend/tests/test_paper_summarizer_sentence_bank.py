from models import DiscussionInsight, ExtractionMethods, IntroductionClaim, ResultItem, Triage
from services.paper_summarizer import _parse_sentence_bank, _select_writing_evidence


def test_parse_sentence_bank_keeps_source_metadata_without_early_capping():
    raw = []
    for idx in range(25):
        raw.append({
            "section": "background" if idx % 2 == 0 else "results",
            "text": f"Important statement {idx}",
            "verbatim_quote": f"Quoted sentence {idx}",
            "claim_type": "reported_fact",
            "stats": f"n={idx}",
            "importance": "high" if idx < 5 else "medium",
            "use_in": "introduction" if idx % 2 == 0 else "results",
            "source_kind": "cited_reference_claim" if idx % 3 == 0 else "paper_text",
            "cited_ref_ids": [str(idx), str(idx + 1)],
        })

    parsed = _parse_sentence_bank(raw)

    assert len(parsed) == 25
    assert parsed[0].source_kind in {"paper_text", "cited_reference_claim"}
    assert parsed[0].cited_ref_ids


def test_select_writing_evidence_caps_at_20():
    raw = []
    for idx in range(25):
        raw.append({
            "section": "results",
            "text": f"Digital intervention improved outcome marker{idx} subgroup{idx}",
            "verbatim_quote": f"Outcome marker{idx} subgroup{idx} improved with OR={idx + 1}.0 and p=0.00{idx % 9 + 1}.",
            "claim_type": "reported_fact",
            "stats": f"OR={idx + 1}.0 p=0.00{idx % 9 + 1}",
            "importance": "high",
            "use_in": "results",
            "source_kind": "paper_text",
            "cited_ref_ids": [],
        })

    selected, meta = _select_writing_evidence(
        query="digital mental health intervention outcomes",
        text_source="full_pdf",
        triage=Triage(category="cross-sectional"),
        methods=ExtractionMethods(study_design="Cross-sectional survey"),
        results=[],
        parsed_sentence_bank=_parse_sentence_bank(raw),
        introduction_claims=[],
        discussion_insights=[],
    )

    assert len(selected) == 20
    assert meta.selected_count == 20
    assert meta.max_count == 20


def test_select_writing_evidence_prioritises_results_for_empirical_paper():
    parsed = _parse_sentence_bank([
        {
            "section": "background",
            "text": "Young adults frequently report anxiety symptoms when using social media.",
            "verbatim_quote": "Young adults frequently report anxiety symptoms when using social media [4].",
            "claim_type": "reported_fact",
            "stats": "",
            "importance": "high",
            "use_in": "introduction",
            "source_kind": "cited_reference_claim",
            "cited_ref_ids": ["4"],
        },
        {
            "section": "discussion",
            "text": "The intervention may improve adherence by reducing friction during self-monitoring.",
            "verbatim_quote": "The intervention may improve adherence by reducing friction during self-monitoring.",
            "claim_type": "author_interpretation",
            "stats": "",
            "importance": "medium",
            "use_in": "discussion",
            "source_kind": "paper_text",
            "cited_ref_ids": [],
        },
    ])
    results = [
        ResultItem(
            outcome="Depression score",
            finding="Participants receiving the intervention had lower depression scores at 12 weeks.",
            effect_size="MD=-3.2",
            ci_95="[-4.8, -1.6]",
            p_value="p<0.001",
            supporting_quote="Participants receiving the intervention had lower depression scores at 12 weeks (MD -3.2, 95% CI -4.8 to -1.6; p<0.001).",
            claim_type="reported_fact",
        ),
        ResultItem(
            outcome="Remission",
            finding="Remission was more common in the intervention group.",
            effect_size="OR=1.9",
            ci_95="[1.3, 2.8]",
            p_value="p=0.002",
            supporting_quote="Remission was more common in the intervention group (OR 1.9, 95% CI 1.3-2.8; p=0.002).",
            claim_type="reported_fact",
        ),
    ]

    selected, meta = _select_writing_evidence(
        query="digital mental health intervention depression outcomes in young adults",
        text_source="full_pdf",
        triage=Triage(category="RCT"),
        methods=ExtractionMethods(study_design="Randomized controlled trial"),
        results=results,
        parsed_sentence_bank=parsed,
        introduction_claims=[],
        discussion_insights=[],
    )

    result_count = sum(1 for item in selected if item.section == "results")
    assert result_count >= 2
    assert meta.dominant_sections[0] == "results"


def test_select_writing_evidence_allows_background_discussion_skew_for_review_paper():
    intro_claims = [
        IntroductionClaim(
            claim="Dating app use is common among emerging adults.",
            verbatim_quote="Dating app use is common among emerging adults (Smith et al. 2021).",
            cited_ref_ids=["Smith et al. 2021"],
            claim_type="reported_fact",
        ),
        IntroductionClaim(
            claim="Dating app users report higher exposure to casual sexual encounters.",
            verbatim_quote="Dating app users report higher exposure to casual sexual encounters (Patel et al. 2020).",
            cited_ref_ids=["Patel et al. 2020"],
            claim_type="reported_fact",
        ),
        IntroductionClaim(
            claim="Prior studies have linked frequent swiping with poorer body image.",
            verbatim_quote="Prior studies have linked frequent swiping with poorer body image (Nguyen 2019).",
            cited_ref_ids=["Nguyen 2019"],
            claim_type="reported_fact",
        ),
    ]
    discussion_insights = [
        DiscussionInsight(
            insight_type="comparison",
            text="The review suggests that psychological harms and sexual-risk behaviors frequently co-occur in the same user groups.",
            verbatim_quote="Psychological harms and sexual-risk behaviors frequently co-occur in the same user groups.",
            cited_ref_ids=["Lopez et al. 2022"],
        ),
        DiscussionInsight(
            insight_type="implication",
            text="Future interventions should address both mental health and sexual health rather than either domain alone.",
            verbatim_quote="Future interventions should address both mental health and sexual health rather than either domain alone.",
            cited_ref_ids=[],
        ),
    ]

    selected, meta = _select_writing_evidence(
        query="dating app use sexual risk behavior and mental health among emerging adults",
        text_source="full_pdf",
        triage=Triage(category="SR/MA"),
        methods=ExtractionMethods(study_design="Systematic review"),
        results=[],
        parsed_sentence_bank=[],
        introduction_claims=intro_claims,
        discussion_insights=discussion_insights,
    )

    assert selected
    assert meta.dominant_sections[0] in {"background", "discussion"}
    assert any(item.source_kind == "cited_reference_claim" and item.cited_ref_ids for item in selected)


def test_select_writing_evidence_reports_limiting_factors_for_abstract_only():
    parsed = _parse_sentence_bank([
        {
            "section": "results",
            "text": "Dating app users reported a higher number of casual partners than non-users.",
            "verbatim_quote": "",
            "claim_type": "reported_fact",
            "stats": "IRR=1.4 p=0.01",
            "importance": "high",
            "use_in": "results",
            "source_kind": "paper_text",
            "cited_ref_ids": [],
        }
    ])

    selected, meta = _select_writing_evidence(
        query="dating app casual partners sexual risk",
        text_source="abstract_only",
        triage=Triage(category="cross-sectional"),
        methods=ExtractionMethods(study_design="Cross-sectional survey"),
        results=[],
        parsed_sentence_bank=parsed,
        introduction_claims=[],
        discussion_insights=[],
    )

    assert selected
    assert "abstract_only" in meta.limiting_factors
