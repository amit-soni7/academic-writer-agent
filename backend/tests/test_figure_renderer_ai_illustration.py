from models import FigureBuilderRequest, VisualItem
from services.figure_renderer import (
    build_editable_prompt,
    build_figure_brief,
    build_prompt_package,
    build_refined_prompt_package,
    detect_figure_category,
    hydrate_visual_prompt_state,
    score_candidate,
)


def test_detect_figure_category_respects_override():
    category = detect_figure_category(
        "Ambiguous scientific figure",
        "General purpose",
        override="medical",
    )
    assert category == "medical"


def test_build_figure_brief_routes_text_heavy_requests_to_composition_reference():
    brief = build_figure_brief(
        request=FigureBuilderRequest(
            title="Study Flow",
            figure_type="PRISMA flowchart",
            purpose="Show article screening and exclusions",
            key_message="The evidence set narrows in ordered stages.",
            panel_count=1,
            candidate_count=1,
            labels_needed=True,
            text_in_image_allowed=False,
        ),
        article_context="The review followed staged screening with multiple exclusion reasons.",
        article_type="systematic_review",
    )
    assert brief.output_mode == "composition_reference"


def test_build_prompt_package_contains_five_layers():
    item = VisualItem(
        id="F1",
        type="figure",
        title="Emotion Dysregulation Model",
        purpose="Show how childhood neglect predicts adult interpersonal withdrawal.",
        suggested_structure=["Left panel: neglect exposure", "Center: emotion dysregulation", "Right panel: adult withdrawal"],
        data_to_include=["childhood emotional neglect", "emotion dysregulation", "interpersonal withdrawal"],
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Emotion dysregulation mediates later withdrawal.", article_type="psychology")
    prompt_package = build_prompt_package(brief)
    assert "Goal:" in prompt_package.layer1_content
    assert prompt_package.layer2_style
    assert "composition rules" in prompt_package.final_prompt.lower()
    assert "Avoid:" in prompt_package.final_prompt
    assert "Output purpose:" in prompt_package.final_prompt


def test_build_prompt_package_hardens_comparison_diagram_rules():
    item = VisualItem(
        id="F4",
        type="figure",
        title="Conventional versus adversarial pathway",
        purpose="Compare two pathways for theory testing.",
        suggested_structure=["Panel A conventional pathway", "Panel B adversarial pathway"],
        data_to_include=["rival theories", "joint method agreement", "shared data collection", "theory narrowing"],
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Two panels compare conventional and adversarial workflows.", article_type="editorial")
    brief.panel_count = 2
    prompt_package = build_prompt_package(brief)
    prompt_text = prompt_package.final_prompt.lower()
    assert "avoid hatch" in prompt_text or "avoid hatch, dot, stripe" in prompt_text
    assert "symmetry and parallelism across panels" in prompt_text
    assert "presentation-tool aesthetics" in prompt_text


def test_build_editable_prompt_includes_panel_specific_draw_instructions():
    item = VisualItem(
        id="F6",
        type="figure",
        title="Adversarial collaboration framework",
        purpose="Show branching theories, isolated camps, and adversarial collaboration as a shared test platform.",
        suggested_structure=[
            "Panel A branching tree of subtheories",
            "Panel B isolated camps with recursive reinterpretation loops",
            "Panel C shared testing platform with joint method agreement and narrower conclusions",
        ],
        data_to_include=["branching tree", "isolated research camps", "shared testing platform", "joint method agreement"],
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Three panels compare proliferation, isolated testing, and adversarial collaboration.", article_type="editorial")
    prompt_package = build_prompt_package(brief)
    editable = build_editable_prompt(brief, prompt_package, palette="muted slate and blue palette")
    lowered = editable.lower()
    assert "panel a should depict" in lowered
    assert "panel b should depict" in lowered
    assert "panel c should depict" in lowered
    assert "required components to draw" in lowered


def test_hydrate_visual_prompt_state_populates_prompt_fields():
    item = VisualItem(
        id="F7",
        type="figure",
        title="Conceptual comparison",
        purpose="Compare two conceptual pathways.",
        render_mode="ai_illustration",
    )
    hydrated = hydrate_visual_prompt_state(item, article_context="Two conceptual pathways are compared.", article_type="editorial")
    assert hydrated.figure_brief is not None
    assert hydrated.prompt_package is not None
    assert hydrated.editable_prompt
    assert hydrated.style_controls is not None


def test_refined_prompt_appends_instruction():
    item = VisualItem(
        id="F2",
        type="figure",
        title="Neural Circuit Overview",
        purpose="Show focal cortical and limbic regions.",
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Amygdala-prefrontal coupling is the focal relationship.", article_type="neuroscience")
    original = build_prompt_package(brief)
    refined = build_refined_prompt_package(brief, original, "Reduce clutter and strengthen the focal hierarchy.")
    assert "Reduce clutter" in refined.final_prompt
    assert "Refinement:" in refined.layer3_composition


def test_score_candidate_flags_accessibility_note():
    item = VisualItem(
        id="F3",
        type="figure",
        title="Clinical pathway",
        purpose="Show how treatment decisions branch after diagnosis.",
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Treatment pathway figure.", article_type="medical")
    prompt_package = build_prompt_package(brief)
    score = score_candidate(brief, prompt_package, output_mode=brief.output_mode)
    assert 1 <= score.overall <= 5
    assert any("Accessibility mode enabled" in note for note in score.notes)


def test_score_candidate_adds_panel_symmetry_note_for_multi_panel_diagrams():
    item = VisualItem(
        id="F5",
        type="figure",
        title="Parallel conceptual pathways",
        purpose="Compare two conceptual pathways with aligned steps.",
        suggested_structure=["Panel A", "Panel B"],
        render_mode="ai_illustration",
    )
    brief = build_figure_brief(item=item, article_context="Two-panel comparison.", article_type="editorial")
    brief.panel_count = 2
    prompt_package = build_prompt_package(brief)
    score = score_candidate(brief, prompt_package, output_mode=brief.output_mode)
    assert any("panel symmetry" in note.lower() for note in score.notes)
