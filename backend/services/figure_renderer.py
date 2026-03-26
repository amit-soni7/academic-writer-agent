"""
services/figure_renderer.py

Handles figure and table generation for visual recommendations:

- Figure generation: AI produces Python/matplotlib code → executed in a
  sandboxed subprocess → PNG (+ PDF) saved to project storage.
- Table generation: AI returns structured JSON → rendered as APA-formatted
  HTML (no subprocess needed).
- Edit iteration: re-generates code based on chat instructions.

Public API
----------
generate_figure_code(provider, item, article_context) -> str
    AI call to produce Python/matplotlib source code for a figure.

generate_table_data(provider, item, article_context) -> dict
    AI call to produce structured table data {headers, rows, footnotes}.

render_table_html(table_data, number, title) -> str
    Pure-function: builds APA-formatted HTML table string.

execute_figure_code(source_code, item_id, storage_dir, timeout=30) -> dict
    Runs matplotlib code in restricted subprocess, saves PNG/PDF,
    returns {image_path, pdf_path, error}.

edit_visual_code(provider, item, message, chat_history, current_code) -> dict
    One chat turn of iterative editing. Returns {new_code, explanation}.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import uuid
from typing import Optional

from openai import AsyncOpenAI

from models import (
    CandidateScore,
    FigureBrief,
    FigureBuilderRequest,
    IllustrationCandidate,
    IllustrationStyleControls,
    PanelPlan,
    PromptPackage,
    GeneratedVisual,
    VisualItem,
)
from services.ai_provider import AIProvider

logger = logging.getLogger(__name__)

# ── Allowed imports in generated figure code ─────────────────────────────────

_ALLOWED_IMPORTS = frozenset([
    "matplotlib", "seaborn", "numpy", "pandas",
    "scipy", "statsmodels", "forestplot", "statannotations",
    "lifelines", "math", "collections", "itertools", "textwrap",
])

_FORBIDDEN_PATTERNS = [
    r"\bos\b", r"\bsys\b", r"\bsubprocess\b", r"\bshutil\b",
    r"\bsocket\b", r"\bopen\(", r"\beval\(", r"\bexec\(",
    r"\b__import__\b", r"\bimportlib\b",
]

# ── APA theme preamble prepended to every figure script ──────────────────────

_APA_THEME_PREAMBLE = """\
import matplotlib as mpl
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.patches as patches
import numpy as np

_COLORBLIND_SAFE = [
    '#0072B2', '#D55E00', '#009E73', '#E69F00',
    '#56B4E9', '#CC79A7', '#F0E442', '#000000',
]
mpl.rcParams.update({
    'font.family': 'serif',
    'font.serif': ['DejaVu Serif', 'Times New Roman', 'serif'],
    'font.size': 11,
    'axes.linewidth': 1.0,
    'axes.edgecolor': 'black',
    'axes.facecolor': 'white',
    'axes.grid': False,
    'axes.spines.top': False,
    'axes.spines.right': False,
    'axes.prop_cycle': mpl.cycler(color=_COLORBLIND_SAFE),
    'xtick.direction': 'out',
    'ytick.direction': 'out',
    'xtick.major.size': 4,
    'ytick.major.size': 4,
    'lines.linewidth': 1.5,
    'lines.markersize': 6,
    'figure.dpi': 150,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'savefig.pad_inches': 0.1,
    'legend.frameon': False,
    'legend.fontsize': 9,
})
"""

# ── Code validation ───────────────────────────────────────────────────────────

def _validate_code(source_code: str) -> Optional[str]:
    """Return an error string if code contains forbidden patterns, else None."""
    for pattern in _FORBIDDEN_PATTERNS:
        if re.search(pattern, source_code):
            return f"Forbidden pattern found in generated code: {pattern}"
    return None


def _inject_output_path(source_code: str, output_path: str) -> str:
    """
    Ensure the script saves to `output_path`.
    Replace any plt.savefig(...) call with the correct path,
    or append the savefig call at the end.
    """
    escaped = output_path.replace("\\", "\\\\")
    save_call = f'plt.savefig("{escaped}", dpi=300, bbox_inches="tight")'

    # Replace existing savefig calls
    new_code = re.sub(
        r'plt\.savefig\([^)]*\)',
        save_call,
        source_code,
    )
    # If no savefig was present, append it
    if 'plt.savefig' not in source_code:
        new_code = source_code.rstrip() + f"\n{save_call}\nplt.close('all')\n"
    else:
        new_code = new_code.rstrip() + "\nplt.close('all')\n"
    return new_code


# ── Figure code generation ────────────────────────────────────────────────────

_FIGURE_SYSTEM = """\
You are a scientific figure generation assistant. Generate Python/matplotlib
code for a publication-quality figure destined for a peer-reviewed journal.

══ ALLOWED IMPORTS ════════════════════════════════════════════════════════════
matplotlib, seaborn, numpy, pandas, scipy, statsmodels, math,
collections, itertools, textwrap
FORBIDDEN: os, sys, subprocess, shutil, socket, open(), eval(), exec()

══ OUTPUT ═════════════════════════════════════════════════════════════════════
- End with: plt.savefig("output.png", dpi=300, bbox_inches="tight")
- Use placeholder/representative data with clear variable names and comments.

══ COLOR DISCIPLINE ═══════════════════════════════════════════════════════════
- Maximum 3 colors total (including black/white).
- Primary palette: #2C3E50 (dark slate) for borders/arrows,
  #F7F9FC (near-white) for default box fills, #4A90D9 (muted blue) as ONE accent.
- NEVER use red, orange, pink, bright green, or yellow as fill colors.
- For grayscale distinction, use LINESTYLE ONLY (solid / dashed / dotted border).
  NEVER use hatch patterns ('///', '...', '|||', 'xxx', etc.) — they are visually
  noisy, not semantically intuitive, and distract from the content.
- If a legend is needed, include one; do NOT use color without defining it.

══ TYPOGRAPHY HIERARCHY ═══════════════════════════════════════════════════════
- Figure title (if any): 11 pt bold, centered above.
- Panel labels (A, B, C): 10 pt bold, top-left of each panel.
- Main box text: 9 pt, ≤ 5 words per line, max 3 lines per box.
  Wrap with: textwrap.fill(text, width=22)
- Annotation/secondary text: 8 pt, italic.
- Footer/takeaway: 8 pt, centered, italic, separated by a thin rule.
- DO NOT mix font weights arbitrarily — use the hierarchy above consistently.

══ LAYOUT & SPACING ═══════════════════════════════════════════════════════════
- Figure size: (8, 6) for single-panel; (12, 7) for two-panel side-by-side.
- Compute box positions PROGRAMMATICALLY using lists/loops — never hardcode
  each box individually, as that causes misalignment.
- All boxes in the same column MUST share identical x coordinates.
- All boxes in the same row MUST share identical y coordinates.
- Minimum gap between adjacent boxes: 0.18 (in axes units [0,1]).
- Minimum margin from axes edge to any element: 0.06.
- For multi-panel: use plt.subplots() or gridspec. Each panel must be
  independently balanced — do NOT let elements spill across panel borders.
- The "takeaway" or footer box must have at least 0.18 axes-unit clearance
  above the last content row.

══ BOX SIZING RULES ═══════════════════════════════════════════════════════════
- EVERY box must be wide enough and tall enough that its text label fits
  comfortably with clear internal padding (pad_x ≥ 0.04, pad_y ≥ 0.03 in axes units).
- Outcome / result boxes at the bottom of a panel MUST be the same size as
  main flow boxes — NEVER shrink them to squeeze them into the remaining space.
- If a bottom row has 3+ outcome boxes side by side, widen the figure or reduce
  font size to 8pt before making the boxes smaller.
- When laying out a bottom row of N boxes, calculate:
    box_w = (panel_width - (N+1)*gap) / N
  and verify box_w ≥ 0.22 (axes units). If not, use 2 rows instead.
- NEVER stack so many boxes that any box height < 0.08 axes units.

══ ARROW & CONNECTION RULES ═══════════════════════════════════════════════════
- Use ONE primary arrow style: solid black, arrowstyle='->', lw=1.2.
- If a second arrow type is needed (e.g. bidirectional, optional path),
  use dashed (linestyle='--') and define its meaning in the legend or caption.
- Arrows MUST start from the center-bottom of the source box and terminate
  at the center-top of the target box (never diagonal unless required by layout).
- Never mix arrowhead sizes within a figure.

══ BOX CONTENT RULES ══════════════════════════════════════════════════════════
- Box text ≤ 5 words per line, ≤ 3 lines total. Move excess to caption.
- Annotation boxes (side comments) must be visually smaller and lighter
  than the main process boxes: use a dashed border, 8pt italic text,
  lighter fill (#EEF2F7), and position them outside the main flow column.
- Avoid boxes that are nearly identical in appearance but encode different
  conceptual categories — differentiate with border linestyle ONLY (never hatch).

══ DIAGRAM-SPECIFIC RULES ═════════════════════════════════════════════════════
- PRISMA / CONSORT flowcharts: strict top-to-bottom flow, no diagonal
  arrows, exclusion boxes to the right with dashed horizontal connector.
- Forest plots: horizontal CI lines, vertical zero line (dashed), diamond
  for pooled estimate. Grayscale only. Include axis labels and n sizes.
- KM survival curves: maximum 4 curves, distinct linestyles, at-risk table
  below x-axis. No grid.
- Conceptual diagrams: prefer ≤ 6 main boxes. If more are needed, group
  related boxes with a subtle rectangular background (alpha=0.08, no border).

Return ONLY the Python code. No markdown fences. No explanation.
""".strip()


async def generate_figure_code(
    provider: AIProvider,
    item: VisualItem,
    article_context: str = "",
) -> str:
    """AI call to produce Python/matplotlib source code for a figure item."""
    structure = "\n".join(f"  - {s}" for s in item.suggested_structure)
    data_items = "\n".join(f"  - {d}" for d in item.data_to_include)

    user_msg = (
        f"Generate a figure:\n"
        f"Title: {item.title}\n"
        f"Type: {item.type} — render mode: {item.render_mode}\n"
        f"Purpose: {item.purpose}\n"
        f"Suggested structure:\n{structure}\n"
        f"Data to include:\n{data_items}\n"
        f"Reporting guideline: {item.reporting_guideline or 'None'}\n"
        f"Target section: {item.target_section}\n\n"
        f"CRITICAL REMINDERS:\n"
        f"- Compute ALL box positions using loops/lists — never hardcode per-box coordinates.\n"
        f"- Maximum 3 colors. NO hatch/pattern fills — they are distracting and not semantic.\n"
        f"- Use border linestyle (solid vs dashed) as the ONLY way to distinguish box categories.\n"
        f"- Box text ≤ 5 words per line, ≤ 3 lines per box. Use textwrap.fill(text, 22).\n"
        f"- Bottom outcome boxes must be the SAME size as main flow boxes — never shrink them.\n"
        f"- For N boxes in a bottom row: box_w = (panel_width-(N+1)*gap)/N, min 0.22 units.\n"
        f"- If box_w < 0.22, use 2 rows instead of cramming N boxes into one row.\n"
        f"- One arrow style (solid black). Use dashed only for secondary paths + legend.\n"
        f"- Minimum 0.18 axes-unit gap between adjacent boxes; 0.18 clearance above footer.\n"
        f"Generate publication-quality Python/matplotlib code."
    )

    code = await provider.complete(
        system=_FIGURE_SYSTEM,
        user=user_msg,
        json_mode=False,
        temperature=0.3,
        max_tokens=3000,
    )
    # Strip markdown fences if present
    code = re.sub(r"^```[^\n]*\n?", "", code.strip())
    code = re.sub(r"\n?```$", "", code.strip())
    return code


# ── Table data generation ─────────────────────────────────────────────────────

_TABLE_SYSTEM = """\
You are a scientific table generation assistant. Given a table recommendation
for an academic manuscript, return structured data for an APA 7th edition table.

Return ONLY valid JSON with this schema (no markdown fences):
{
  "headers": ["Column 1", "Column 2", ...],
  "rows": [
    ["cell", "cell", ...],
    ...
  ],
  "footnotes": ["Note. Any explanatory notes about the table data."]
}

Use representative/placeholder data with clear variable names.
Include 3–8 rows of example data.
""".strip()


async def generate_table_data(
    provider: AIProvider,
    item: VisualItem,
    article_context: str = "",
) -> dict:
    """AI call to produce structured table data for a table item."""
    structure = "\n".join(f"  - {s}" for s in item.suggested_structure)
    data_items = "\n".join(f"  - {d}" for d in item.data_to_include)

    user_msg = (
        f"Generate table data:\n"
        f"Title: {item.title}\n"
        f"Purpose: {item.purpose}\n"
        f"Suggested columns/structure:\n{structure}\n"
        f"Data to include:\n{data_items}\n"
        f"Target section: {item.target_section}\n\n"
        f"Return structured JSON with headers, rows, and footnotes."
    )

    raw = await provider.complete(
        system=_TABLE_SYSTEM,
        user=user_msg,
        json_mode=True,
        temperature=0.3,
        max_tokens=2000,
    )
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[^\n]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    data = json.loads(raw)
    return {
        "headers": data.get("headers", []),
        "rows": data.get("rows", []),
        "footnotes": data.get("footnotes", []),
    }


# ── Table HTML rendering ──────────────────────────────────────────────────────

def render_table_html(table_data: dict, number: int, title: str) -> str:
    """
    Build APA 7th edition HTML table from structured data.
    Returns a complete HTML block ready for the manuscript view.
    """
    headers = table_data.get("headers", [])
    rows = table_data.get("rows", [])
    footnotes = table_data.get("footnotes", [])

    # Caption (above table in APA)
    caption_html = (
        f'<div class="table-caption" style="margin-bottom:6px;">'
        f'<strong>Table {number}</strong><br>'
        f'<em>{html.escape(title)}</em>'
        f'</div>'
    )

    # Header row
    header_cells = "".join(
        f'<th style="font-weight:normal;font-style:italic;padding:4px 8px;text-align:left;vertical-align:top;">'
        f'{html.escape(str(h))}</th>'
        for h in headers
    )
    header_row = f'<tr style="border-top:2px solid black;border-bottom:1px solid black;">{header_cells}</tr>'

    # Data rows
    data_rows_html = []
    for r_idx, row in enumerate(rows):
        is_last = r_idx == len(rows) - 1
        bottom_border = "border-bottom:2px solid black;" if is_last else ""
        cells = "".join(
            f'<td style="padding:4px 8px;text-align:left;vertical-align:top;{bottom_border}">'
            f'{html.escape(str(cell))}</td>'
            for cell in row
        )
        data_rows_html.append(f"<tr>{cells}</tr>")

    body_html = "".join(data_rows_html)

    table_html = (
        f'<table style="width:100%;border-collapse:collapse;font-family:serif;font-size:11pt;line-height:1.5;">'
        f'<thead>{header_row}</thead>'
        f'<tbody>{body_html}</tbody>'
        f'</table>'
    )

    # Footnotes
    footnote_html = ""
    if footnotes:
        note_text = " ".join(footnotes)
        footnote_html = (
            f'<div class="table-footnotes" style="margin-top:6px;font-size:10pt;">'
            f'<em>Note.</em> {html.escape(note_text)}'
            f'</div>'
        )

    return caption_html + table_html + footnote_html


# ── Figure execution ──────────────────────────────────────────────────────────

def execute_figure_code(
    source_code: str,
    item_id: str,
    storage_dir: str,
    timeout: int = 30,
) -> dict:
    """
    Execute matplotlib Python code in a sandboxed subprocess.

    Returns:
        {image_path: str, pdf_path: str, error: str | None}
    """
    # Validate code for forbidden patterns
    error = _validate_code(source_code)
    if error:
        return {"image_path": None, "pdf_path": None, "error": error}

    os.makedirs(storage_dir, exist_ok=True)
    png_path = os.path.join(storage_dir, f"{item_id}.png")
    pdf_path = os.path.join(storage_dir, f"{item_id}.pdf")

    # Build the full script: preamble + user code + output save
    full_code = _APA_THEME_PREAMBLE + "\n\n" + source_code
    full_code = _inject_output_path(full_code, png_path)
    # Also save PDF (replace .png with .pdf for the pdf save)
    pdf_save = f'plt.savefig("{pdf_path.replace(chr(92), "/")}",dpi=300,bbox_inches="tight")\n'
    full_code = full_code.rstrip() + "\n" + pdf_save

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as f:
        f.write(full_code)
        script_path = f.name

    # Build subprocess env: inherit parent (so venv site-packages are found),
    # force non-interactive matplotlib backend, strip sensitive secrets.
    _STRIP_KEYS = {
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
        "DATABASE_URL", "JWT_SECRET", "SETTINGS_ENCRYPTION_KEY",
        "GOOGLE_CLIENT_SECRET",
    }
    sub_env = {k: v for k, v in os.environ.items() if k not in _STRIP_KEYS}
    sub_env["MPLBACKEND"] = "Agg"

    try:
        result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=storage_dir,
            env=sub_env,
        )
        if result.returncode != 0:
            stderr = result.stderr[-1000:] if result.stderr else "unknown error"
            return {
                "image_path": None,
                "pdf_path": None,
                "error": f"Figure generation failed: {stderr}",
            }

        if not os.path.exists(png_path):
            return {
                "image_path": None,
                "pdf_path": None,
                "error": "Figure script ran but produced no PNG output.",
            }

        return {
            "image_path": png_path,
            "pdf_path": pdf_path if os.path.exists(pdf_path) else None,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "image_path": None,
            "pdf_path": None,
            "error": f"Figure generation timed out after {timeout}s.",
        }
    except Exception as e:
        return {"image_path": None, "pdf_path": None, "error": str(e)}
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


# ── AI illustration system ────────────────────────────────────────────────────

_SYSTEM_INTENT = (
    "Create a publication-quality scientific illustration in a refined editorial style. "
    "The image should look like a high-end medical or scientific journal figure: elegant, precise, minimal, and visually calm. "
    "Use realistic but hand-painted rendering, soft airbrushed shading, subtle linework, muted academic colors, and excellent structural clarity. "
    "Composition should be modular and uncluttered with generous negative space. "
    "This is a scientific communication artifact for journal submission — not decorative artwork. "
    "Style reference: premium scientific editorial illustration, between natural-history plate and modern medical journal figure; "
    "hand-painted digital watercolor/gouache; soft airbrush shading; subtle ink outlines; muted elegant palette; "
    "white or ivory background; isolated elements; sophisticated, calm, publication-ready."
)

_CATEGORY_PRIORITY = ["medical", "neuroscience", "cell_bio", "psychology", "technical", "generic"]

_CATEGORY_KEYWORDS = {
    "psychology": {
        "psychology", "psycholog", "cognitive", "behavior", "behaviour", "emotion", "affect",
        "social", "memory", "attention", "decision", "bias", "theory", "framework", "adversarial",
    },
    "neuroscience": {
        "brain", "neuroscience", "neural", "neuron", "cortex", "hippocampus", "synapse",
        "fmri", "eeg", "amygdala", "prefrontal", "circuit",
    },
    "medical": {
        "clinical", "medical", "patient", "disease", "treatment", "diagnosis", "anatomy",
        "tumor", "cancer", "cardiovascular", "immune", "trial", "pathology",
    },
    "cell_bio": {
        "cell", "protein", "gene", "dna", "rna", "bacteria", "virus", "microbe",
        "membrane", "enzyme", "receptor", "pathway", "organelle", "biomarker",
    },
    "technical": {
        "method", "technical", "workflow", "apparatus", "device", "instrument", "assay",
        "pipeline", "setup", "sensor", "microscope", "algorithm", "process",
    },
}

_STYLE_TEMPLATES = {
    "psychology": (
        "Refined editorial scientific illustration, realistic but symbolically interpretable. "
        "Hand-painted digital rendering with watercolor-gouache softness, subtle pencil or ink outlines, "
        "muted academic palette (gray-blue, warm ochre, ivory), white background. "
        "Elegant and minimal, sophisticated and publication-ready. Not cartoonish or promotional."
    ),
    "neuroscience": (
        "Editorial neuroscience illustration, realistic but softly painted. "
        "Watercolor-gouache digital finish, muted anatomical colors, white background, "
        "clean modular composition with isolated neural or brain elements, selective detail at focal regions. "
        "Resembles a premium medical journal figure or high-end textbook illustration."
    ),
    "medical": (
        "Premium editorial medical illustration, realistic painted anatomy. "
        "White background, muted professional palette, soft airbrushed shading, subtle ink outlines. "
        "Isolated modular components, minimal embedded text, publication-ready for a high-impact journal. "
        "Style: natural-history plate meets modern medical journal figure."
    ),
    "cell_bio": (
        "Hand-painted microbiology illustration, soft watercolor-gouache shading, subtle outlines. "
        "Delicate translucent cellular textures, biologically plausible microstructures. "
        "White background, isolated composition, museum-quality scientific plate aesthetic. "
        "Elegant and visually calm, publication-ready."
    ),
    "technical": (
        "Journal-quality technical illustration, clean editorial scientific rendering. "
        "Subtle cutaway visibility, soft painted shadows, realistic but simplified materials, "
        "isolated object or diagram on white background, precise structure. "
        "Resembles a figure from a modern scientific methods paper — not engineering catalog graphics."
    ),
    "generic": (
        "Publication-quality scientific illustration in a refined editorial style. "
        "Realistic but hand-painted digital rendering, watercolor-gouache finish, soft airbrushed shading, "
        "subtle linework, muted academic colors, white or warm off-white background. "
        "Excellent structural clarity, modular uncluttered composition with generous negative space. "
        "Style reference: premium scientific editorial illustration between natural-history plate and modern medical journal figure."
    ),
}

_COMPOSITION_RULES = (
    "CRITICAL CANVAS RULE: Every visual element — every label, box, arrow, icon, and character of text — must be fully contained within the canvas. "
    "Nothing may be clipped, cropped, or cut off at any edge. Apply a minimum 6% safe-margin inset on all four sides (left, right, top, bottom) before placing any content. "
    "The leftmost element must start no closer than 6% from the left edge. The rightmost element must end no closer than 6% from the right edge. "
    "For multi-panel figures, distribute panels evenly within the safe area and centre the entire composition horizontally so no panel drifts to the canvas boundary. "
    "Titles placed above panels must be fully visible with top-padding of at least 4%. "
    "Global composition rules: clear left-to-right or top-to-bottom reading flow; generous whitespace; "
    "no unnecessary objects; consistent arrow style if arrows are present; one major focal region per panel; "
    "background/context elements quieter than focal elements; maximum 3-5 dominant visual elements per panel; "
    "avoid decorative icons unless they aid understanding; avoid overcrowding; multi-panel figures balanced; "
    "grayscale readability acceptable; if labels are present, keep them minimal and external when possible. "
    "Use strong visual hierarchy: core process boxes must look intentional and dominant, secondary notes must be visibly subordinate, "
    "and outcome boxes must still feel important rather than decorative. "
    "For comparison figures with two or more panels, keep the panels conceptually parallel: similar grid, similar step count where possible, "
    "aligned outcomes, mirrored spacing, and matching internal heading weight. "
    "Do not leave key concepts floating at the periphery if they are central to the causal or procedural logic; place core steps in the main sequence or tightly grouped with it. "
    "Prefer clean flat fills and restrained linework over textures. Avoid hatch, dot, stripe, or patterned fills because they create clutter and shrink poorly. "
    "Reduce text density inside boxes: short labels, fewer words per node, and more breathing room around outcome boxes. "
    "Arrow grammar must be disciplined: primary flow should dominate, secondary connectors should be sparse, and awkward diagonal arrows should be avoided unless absolutely necessary. "
    "Do not add a legend unless the visual language truly cannot be understood without one. "
    "For graphical abstracts and visual abstracts, optimize for at-a-glance readability and a concise visual narrative."
)

_NEGATIVE_BLOCK = (
    "NEVER clip, crop, or cut off any text, label, box, or visual element at any canvas edge — all content must be fully visible inside the canvas boundary. "
    "NEVER place the leftmost element flush with the left edge; always leave a clear inset margin. "
    "NEVER let a panel title, figure title, or column header extend beyond the canvas or get cut by the frame. "
    "Avoid cartoonish style, comic-book style, corporate flat icons, glossy 3D infographic look, neon colors, "
    "decorative clutter, random symbols, gibberish text, heavy gradients, inconsistent arrow weights, "
    "photoreal stock-image composition, distorted anatomy, ambiguous process flow, unnecessary repeated elements, "
    "label-heavy layouts, watermarks, fake UI elements unless intentionally requested. "
    "Avoid slide-deck or presentation-tool aesthetics, including default SmartArt style layouts, boxed clip-art compositions, unnecessary legends, "
    "floating side annotations with weak anchoring, visually peripheral core concepts, cramped bottom-row outcomes, overuse of dashed boxes, "
    "and decorative hatch, dot, stripe, or texture patterns."
)

_TEXT_HEAVY_FIGURE_TYPES = {
    "prisma", "consort", "sem", "path diagram", "workflow", "participant flow", "flowchart", "table",
}

# Type-specific draw instructions: explicit visual object descriptions, not just concept labels.
# These are injected into PanelPlan.draw_instructions so the prompt leads with WHAT TO DRAW.
_FIGURE_TYPE_DRAW_TEMPLATES: dict[str, list[str]] = {
    "conceptual framework": [
        "Draw a central concept box at the top, labeled with the key construct or theory name.",
        "Below it, draw 3–4 rectangular boxes connected by downward arrows showing sub-components or mechanisms.",
        "Use solid single-weight lines, no shadows, no gradients.",
        "If there is a feedback arrow, draw a thin dashed return arrow on the right side.",
    ],
    "comparison diagram": [
        "Draw two symmetric columns side by side separated by a thin vertical dividing line.",
        "Label each column at the top with a bold category header.",
        "List 3–5 parallel items row by row; align rows horizontally across columns.",
        "No color fills in cells; use light shading only for the header row.",
    ],
    "process funnel": [
        "Draw a top-down funnel shape with 4–6 horizontal bands narrowing toward the bottom.",
        "Label each band with the stage name on the left and an n= count on the right margin.",
        "Arrows point straight downward between bands.",
        "Excluded items exit to the right with a small horizontal bracket and a short label.",
    ],
    "branching conceptual framework": [
        "Draw a single root node at top center.",
        "Branch into 2–3 intermediate level nodes using clean orthogonal connectors (no diagonal curves).",
        "Terminal leaf nodes at the bottom show outcomes or sub-categories.",
        "No icons or decorative shapes — clean rectangular nodes only.",
    ],
    "comparative process diagram": [
        "Draw two separated rectangular areas (camps or conditions) side by side.",
        "Inside each camp, show a short process flow of 2–3 steps with downward arrows.",
        "A bidirectional arrow or contrast bar sits between the two camps at the midpoint.",
        "Label each camp at the top. Use a very light background tint to distinguish them.",
    ],
    "shared platform": [
        "Draw a wide horizontal base platform bar spanning the full width at the bottom.",
        "Draw 3–4 uniform vertical pillars rising from the platform, each labeled at its top.",
        "Place a shared outcome or consensus label above all pillars, centered.",
        "Use clean rectangular shapes with uniform pillar widths and no decorative fills.",
    ],
    "conceptual scientific illustration": [
        "Draw the primary concept as a central dominant element occupying the visual center.",
        "Surround it with 2–4 satellite elements connected by clean labeled arrows.",
        "Maintain strong visual hierarchy: the central element must be visibly larger or bolder.",
        "Use minimal text labels; prefer short noun phrases over full sentences.",
    ],
}


def _slugify_token(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-") or uuid.uuid4().hex[:8]


def detect_figure_category(*parts: str, override: Optional[str] = None) -> str:
    if override and override in _CATEGORY_PRIORITY:
        return override
    text = " ".join(parts).lower()
    words = set(re.findall(r"\b[a-z0-9_]+\b", text))
    scores = {cat: len(words & keywords) for cat, keywords in _CATEGORY_KEYWORDS.items()}
    for cat in _CATEGORY_PRIORITY:
        if scores.get(cat, 0) > 0:
            return cat
    return "generic"


def _get_draw_instructions_for_type(figure_type: str) -> list[str]:
    """Return type-specific draw instructions, matching by substring for flexibility."""
    ft = figure_type.lower()
    for key, instructions in _FIGURE_TYPE_DRAW_TEMPLATES.items():
        if key in ft or ft in key:
            return instructions
    return _FIGURE_TYPE_DRAW_TEMPLATES["conceptual scientific illustration"]


def _build_panel_plan(
    panel_count: int,
    panels: list[dict],
    fallback_structure: list[str],
    figure_type: str = "",
) -> list[PanelPlan]:
    type_draw = _get_draw_instructions_for_type(figure_type) if figure_type else []
    if panels:
        out: list[PanelPlan] = []
        for idx, panel in enumerate(panels, 1):
            # Prefer explicit draw_instructions from the panel dict; fall back to type template
            draw = [str(v) for v in panel.get("draw_instructions", [])] or (
                type_draw if idx == 1 else []
            )
            out.append(PanelPlan(
                id=str(panel.get("id") or f"panel_{idx}"),
                title=panel.get("title"),
                goal=str(panel.get("goal") or panel.get("title") or ""),
                main_subjects=[str(v) for v in panel.get("main_subjects", [])],
                secondary_subjects=[str(v) for v in panel.get("secondary_subjects", [])],
                arrows=list(panel.get("arrows", [])),
                inset=panel.get("inset"),
                layout_notes=[str(v) for v in panel.get("layout_notes", [])],
                draw_instructions=draw,
            ))
        return out
    fallback = [s for s in fallback_structure if s][:max(1, panel_count)]
    return [
        PanelPlan(
            id=f"panel_{idx + 1}",
            goal=entry,
            main_subjects=[entry],
            layout_notes=["Keep the panel visually balanced and uncluttered."],
            draw_instructions=type_draw if idx == 0 else [],
        )
        for idx, entry in enumerate(fallback or ["Single clear focal composition"])
    ]


def _guess_figure_type(item: VisualItem | None, article_context: str = "") -> str:
    text = " ".join([
        item.title if item else "",
        item.purpose if item else "",
        article_context,
    ]).lower()
    if any(token in text for token in {"compare", "comparison", "versus", "vs.", "vs "}):
        return "comparison diagram"
    if any(token in text for token in {"branch", "proliferation", "tree"}):
        return "branching conceptual framework"
    if any(token in text for token in {"funnel", "channel", "pipeline"}):
        return "process funnel"
    if any(token in text for token in {"loop", "recursive", "reinterpretation", "camp"}):
        return "comparative process diagram"
    return "conceptual scientific illustration"


def _build_panel_instruction_lines(brief: FigureBrief) -> list[str]:
    lines: list[str] = []
    for idx, panel in enumerate(brief.panel_plan[:4], 1):
        label = panel.title or f"Panel {chr(64 + idx)}"
        goal = panel.goal or ", ".join(panel.main_subjects[:4]) or "the core concept"
        components = panel.main_subjects[:6]
        secondaries = panel.secondary_subjects[:4]
        component_text = ", ".join(components) if components else "the main conceptual elements"
        line = f"{label} should depict {goal.rstrip('.')}."
        line += f" Include {component_text}."
        if secondaries:
            line += f" Supporting elements may include {', '.join(secondaries)}."
        if panel.layout_notes:
            line += f" Layout notes: {'; '.join(panel.layout_notes[:3])}."
        lines.append(line)
        # Append explicit draw instructions (what visual objects to draw) immediately after
        for instr in panel.draw_instructions[:4]:
            lines.append(f"  • {instr}")
    return lines


def build_editable_prompt(
    brief: FigureBrief,
    prompt_package: PromptPackage,
    *,
    palette: Optional[str] = None,
    background: str = "opaque",
) -> str:
    panel_lines = _build_panel_instruction_lines(brief)
    components = ", ".join(brief.must_include[:10]) if brief.must_include else "the core scientific components implied by the manuscript"
    avoid_text = ", ".join(brief.must_avoid[:8]) if brief.must_avoid else "clutter, decorative textures, unnecessary legends, and text-heavy labels"
    palette_text = palette or "muted academic palette with restrained contrast and clean white background"
    background_text = "transparent background for later composition" if brief.transparent_background or background == "transparent" else "white background"

    # Content-first: lead with WHAT TO DRAW before any style instructions
    prompt_lines = [
        f"Figure type: {brief.figure_type or 'conceptual scientific illustration'}.",
        f"Goal: {brief.key_message}",
        "",
        "WHAT TO DRAW:",
    ]
    prompt_lines.extend(panel_lines or [f"Depict {brief.purpose or brief.key_message}."])
    prompt_lines.append(f"\nRequired components: {components}.")
    prompt_lines.append(f"\nCreate a {brief.panel_count}-panel scientific editorial illustration for a {brief.category} paper.")
    prompt_lines.append(
        f"Visual style: {prompt_package.layer2_style} "
        f"Use {palette_text}, {background_text}, strong hierarchy, minimal labels, and no clutter."
    )
    prompt_lines.append(f"Avoid: {avoid_text}.")
    prompt_lines.append(
        "IMPORTANT: All content — every label, box, arrow, title, and character — must be fully inside the canvas. "
        "Apply a minimum 6% inset margin on all four sides. Nothing may be clipped or cut off at any edge."
    )
    return "\n".join(prompt_lines)


# ── LLM-powered illustration brief ───────────────────────────────────────────

_ILLUSTRATION_BRIEF_SYSTEM = """
You are a scientific illustrator briefing an AI image generator.
Given a figure brief and manuscript context, write a detailed image generation prompt.

Structure your output in this exact order:
1. What to draw (figure type + core scientific message)
2. Panel descriptions (one per panel): visual metaphor, what to show, exact labels, shapes, arrows
3. Style block (rendering, colors, background — follow the guide)
4. Composition rules
5. Negative block
6. Output use

Rules:
- Be specific about what OBJECTS and SHAPES to draw in each panel (tree, funnel, columns, platform, etc.)
- Use exact label names from the manuscript
- Specify visual metaphors clearly (e.g. "branching tree = theoretical proliferation")
- Keep the style: hand-painted editorial, watercolor-gouache, muted academic palette, white background
- No cartoon, no 3D render, no corporate icons
- Output ONLY the image generation prompt text, no headers, no explanation
""".strip()


async def generate_illustration_prompt_via_llm(
    provider: "AIProvider",
    brief: FigureBrief,
    article_context: str = "",
) -> str:
    """
    Use the text LLM to expand a FigureBrief into a detailed panel-by-panel
    image generation prompt at the level of a professional illustrator brief.
    Falls back to build_editable_prompt() if the LLM call fails.
    """
    panel_lines = []
    for idx, panel in enumerate(brief.panel_plan[:4], 1):
        label = panel.title or f"Panel {chr(64 + idx)}"
        subjects = ", ".join(panel.main_subjects[:6]) or panel.goal
        draw = " ".join(panel.draw_instructions[:3])
        panel_lines.append(
            f"Panel {idx} ({label}): goal={panel.goal}; subjects={subjects}"
            + (f"; draw hints={draw}" if draw else "")
        )

    user_msg = (
        f"Figure type: {brief.figure_type}\n"
        f"Key message: {brief.key_message}\n"
        f"Panel count: {brief.panel_count}\n"
        + "\n".join(panel_lines)
        + f"\nMust include: {', '.join(brief.must_include[:8])}\n"
        f"Category: {brief.category}\n"
        f"Output context: {brief.output_context}\n\n"
        f"Manuscript context (excerpt):\n{article_context[:600]}\n\n"
        "Write the image generation prompt."
    )

    try:
        result = await provider.complete(
            system=_ILLUSTRATION_BRIEF_SYSTEM,
            user=user_msg,
            json_mode=False,
            temperature=0.4,
            max_tokens=1200,
        )
        return result.strip()
    except Exception:
        logger.warning("LLM illustration brief failed — falling back to static template")
        pkg = build_prompt_package(brief)
        return build_editable_prompt(brief, pkg)


def build_figure_brief(
    *,
    item: VisualItem | None = None,
    request: FigureBuilderRequest | None = None,
    article_context: str = "",
    article_type: str = "",
    selected_journal: str = "",
) -> FigureBrief:
    source_title = request.title if request else (item.title if item else "")
    source_purpose = request.purpose if request else (item.purpose if item else "")
    source_figure_type = request.figure_type if request else _guess_figure_type(item, article_context)
    source_panel_count = request.panel_count if request else max(1, len(item.suggested_structure[:3]) if item else 1)
    must_include = request.must_include if request else list((item.data_to_include if item else []))
    must_avoid = request.must_avoid if request else []
    discipline = request.discipline if request else article_type
    output_context = request.output_context if request else "graphical_abstract"
    labels_needed = request.labels_needed if request else False
    text_in_image_allowed = request.text_in_image_allowed if request else False
    transparent_background = request.transparent_background if request else False
    audience = request.audience if request else selected_journal
    key_message = request.key_message if request else (source_purpose or article_context[:240])
    category_override = request.category_override if request else None
    category = detect_figure_category(
        source_title,
        source_purpose,
        source_figure_type,
        discipline,
        " ".join(must_include),
        article_context,
        override=category_override,
    )
    panel_plan = _build_panel_plan(
        source_panel_count,
        request.panels if request else [],
        item.suggested_structure if item else [],
        figure_type=source_figure_type,
    )
    brief = FigureBrief(
        title=source_title,
        figure_type=source_figure_type,
        category=category,
        purpose=source_purpose,
        key_message=key_message,
        panel_count=max(1, source_panel_count),
        panel_plan=panel_plan,
        must_include=list(must_include),
        must_avoid=list(must_avoid),
        output_context=output_context,
        labels_needed=labels_needed,
        text_in_image_allowed=text_in_image_allowed,
        accessibility_mode=request.accessibility_mode if request else True,
        transparent_background=transparent_background,
        discipline=discipline,
        audience=audience,
        output_mode=request.output_mode if request else ("transparent_asset" if transparent_background else "full_figure"),
        aspect_ratio=request.aspect_ratio if request else "landscape",
        target_journal_style=request.target_journal_style if request else selected_journal,
        reference_images=request.reference_images if request else [],
        category_override=category_override,
    )
    if _should_use_composition_reference(brief):
        brief.output_mode = "composition_reference"
    return brief


def _should_use_composition_reference(brief: FigureBrief) -> bool:
    figure_type = (brief.figure_type or "").lower()
    if any(token in figure_type for token in _TEXT_HEAVY_FIGURE_TYPES):
        return True
    if brief.labels_needed and not brief.text_in_image_allowed:
        return True
    if brief.text_in_image_allowed and len(brief.must_include) + sum(len(p.main_subjects) for p in brief.panel_plan) > 10:
        return True
    return False


def build_prompt_package(brief: FigureBrief) -> PromptPackage:
    subjects = "\n".join(f"- {subject}" for subject in brief.must_include[:8]) or "- scientific subjects inferred from the brief"
    panel_desc = _build_panel_instruction_lines(brief)
    layout = " ".join(panel_desc) or "Single balanced panel with one dominant focal region."

    layer1 = (
        f"Create a publication-quality scientific illustration for {brief.output_context}. "
        f"Goal: {brief.key_message}. "
        f"Figure type: {brief.figure_type or 'scientific graphical abstract'}. "
        f"Title/internal title: {brief.title}. "
        f"Layout: {layout}. "
        f"Main subjects:\n{subjects}"
    )
    layer2 = _STYLE_TEMPLATES.get(brief.category, _STYLE_TEMPLATES["generic"])
    layer3 = (
        f"{_COMPOSITION_RULES} "
        f"Background preference: {'transparent' if brief.transparent_background else 'white or very light neutral'}. "
        f"Aspect ratio: {brief.aspect_ratio}. "
        f"Output mode: {brief.output_mode}. "
        f"Accessibility mode: {'enabled' if brief.accessibility_mode else 'standard'}. "
    )
    if brief.panel_count >= 2:
        layer3 += (
            "This is a multi-panel comparison figure, so enforce symmetry and parallelism across panels: "
            "same visual grammar, comparable node sizes, consistent vertical rhythm, aligned outcomes, and clear contrast between the two pathways without changing the underlying layout logic. "
        )
    if brief.category in {"technical", "generic"}:
        layer3 += (
            "For schematic or conceptual diagrams, use a rigorous editorial-science layout rather than a business infographic: "
            "tight alignment, uniform spacing, restrained typography, minimal side notes, and no decorative textures. "
        )
    layer4 = _NEGATIVE_BLOCK + (" Additional avoid list: " + "; ".join(brief.must_avoid[:8]) + "." if brief.must_avoid else "")
    layer5 = (
        f"Designed for {brief.output_context} in {brief.target_journal_style or 'a peer-reviewed journal'}; "
        f"clear at reduced size; publication-ready; text minimized; "
        f"{'transparent background asset workflow' if brief.transparent_background else 'clean white background workflow'}."
    )
    final_prompt = (
        f"{_SYSTEM_INTENT}\n\n"
        f"{layer1}\n\n"
        f"Render style: {layer2}\n\n"
        f"Composition rules: {layer3}\n\n"
        f"Avoid: {layer4}\n\n"
        f"Output purpose: {layer5}"
    )
    return PromptPackage(
        system_intent=_SYSTEM_INTENT,
        layer1_content=layer1,
        layer2_style=layer2,
        layer3_composition=layer3,
        layer4_negative=layer4,
        layer5_output_purpose=layer5,
        final_prompt=final_prompt,
    )


def hydrate_visual_prompt_state(
    item: VisualItem,
    *,
    article_context: str = "",
    article_type: str = "",
    selected_journal: str = "",
) -> VisualItem:
    if item.render_mode != "ai_illustration":
        return item
    brief = item.figure_brief or build_figure_brief(
        item=item,
        article_context=article_context,
        article_type=article_type,
        selected_journal=selected_journal,
    )
    prompt_package = PromptPackage(**item.prompt_package) if item.prompt_package else build_prompt_package(brief)
    style_controls = item.style_controls or IllustrationStyleControls(
        background="transparent" if brief.transparent_background else "opaque",
        transparent_background=brief.transparent_background,
        palette="muted academic palette with restrained contrast",
    )
    editable_prompt = item.editable_prompt or build_editable_prompt(
        brief,
        prompt_package,
        palette=style_controls.palette,
        background=style_controls.background,
    )
    return item.model_copy(update={
        "figure_brief": brief,
        "prompt_package": prompt_package.model_dump(),
        "editable_prompt": editable_prompt,
        "style_controls": style_controls,
    })


def score_candidate(
    brief: FigureBrief,
    prompt_package: PromptPackage,
    *,
    output_mode: str,
) -> CandidateScore:
    notes: list[str] = []
    text_risk = 5 if not brief.text_in_image_allowed else 3
    if output_mode == "composition_reference":
        notes.append("Routed to composition reference mode because the figure is text-heavy or layout-sensitive.")
    if brief.accessibility_mode:
        notes.append("Accessibility mode enabled: palette and contrast should avoid red-green dependence.")
    if brief.transparent_background:
        notes.append("Transparent-background output requested for downstream figure assembly.")
    if len(brief.must_include) > 8:
        notes.append("High subject density may increase clutter risk.")
    if brief.panel_count >= 2:
        notes.append("Multi-panel figure: panel symmetry and parallel visual logic must be enforced.")
    if brief.category in {"technical", "generic"}:
        notes.append("Diagram should avoid presentation-tool aesthetics and use a tighter editorial layout.")
    rejected = bool(re.search(r"cartoon|corporate flat icon|neon", prompt_package.final_prompt, re.I))
    overall = round((4 + 4 + 4 + (3 if len(brief.must_include) > 8 else 4) + 4 + 4 + text_risk + 4) / 8, 2)
    return CandidateScore(
        message_clarity=4,
        hierarchy=4,
        plausibility=4,
        composition=3 if len(brief.must_include) > 8 else 4,
        accessibility=4 if brief.accessibility_mode else 3,
        publication_fit=4,
        text_risk=text_risk,
        category_style_fit=4,
        overall=overall,
        notes=notes,
        rejected=rejected,
    )


def _candidate_output_stem(storage_dir: str, prefix: str) -> str:
    os.makedirs(storage_dir, exist_ok=True)
    return os.path.join(storage_dir, prefix)


async def _generate_openai_candidate(
    api_key: str,
    prompt: str,
    storage_dir: str,
    prefix: str,
    *,
    model: str,
    background: str,
    quality: str,
    size: str,
) -> IllustrationCandidate:
    client = AsyncOpenAI(api_key=api_key)
    kwargs = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality if quality != "auto" else "high",
    }
    if background in {"opaque", "transparent"}:
        kwargs["background"] = background
    try:
        response = await client.images.generate(**kwargs)
    except TypeError:
        response = await client.images.generate(**{k: v for k, v in kwargs.items() if k != "background"})

    datum = response.data[0]
    image_bytes: bytes
    if getattr(datum, "b64_json", None):
        image_bytes = base64.b64decode(datum.b64_json)
    elif getattr(datum, "url", None):
        import httpx
        async with httpx.AsyncClient(timeout=60) as http:
            image_bytes = (await http.get(datum.url)).content
    else:
        raise RuntimeError("OpenAI image generation returned no image payload.")

    stem = _candidate_output_stem(storage_dir, prefix)
    png_path = f"{stem}.png"
    with open(png_path, "wb") as f:
        f.write(image_bytes)
    return IllustrationCandidate(
        id=prefix,
        image_url=png_path,
        file_path=png_path,
        backend="openai",
        model=model,
        output_format="png",
        background=background,
        quality=quality,
    )


async def _generate_imagen_candidate(
    api_key: str,
    prompt: str,
    storage_dir: str,
    prefix: str,
    *,
    model: str,
) -> IllustrationCandidate:
    try:
        from google import genai as _genai
        from google.genai import types as _gtypes
    except ImportError as exc:
        raise RuntimeError("google-genai package not installed") from exc

    client = _genai.Client(api_key=api_key)
    response = await asyncio.to_thread(
        client.models.generate_images,
        model=model,
        prompt=prompt,
        config=_gtypes.GenerateImagesConfig(
            number_of_images=1,
            output_mime_type="image/png",
            aspect_ratio="4:3",
        ),
    )
    image_bytes = response.generated_images[0].image.image_bytes
    stem = _candidate_output_stem(storage_dir, prefix)
    png_path = f"{stem}.png"
    with open(png_path, "wb") as f:
        f.write(image_bytes)
    return IllustrationCandidate(
        id=prefix,
        image_url=png_path,
        file_path=png_path,
        backend="gemini_imagen",
        model=model,
        output_format="png",
        background="opaque",
        quality="high",
    )


async def generate_illustration_candidates(
    *,
    api_key: str,
    backend: str,
    model: str,
    brief: FigureBrief,
    prompt_package: PromptPackage,
    storage_dir: str,
    candidate_count: int = 1,
    background: str = "opaque",
    quality: str = "high",
    custom_prompt: Optional[str] = None,
    provider: Optional["AIProvider"] = None,
    article_context: str = "",
) -> list[IllustrationCandidate]:
    # If no custom prompt provided and a text LLM is available, generate a
    # panel-by-panel brief via LLM (falls back to static template on failure)
    if custom_prompt is None and provider is not None:
        custom_prompt = await generate_illustration_prompt_via_llm(provider, brief, article_context)
    size = "1536x1024" if brief.aspect_ratio == "landscape" else "1024x1536"
    prompts = [custom_prompt or prompt_package.final_prompt]
    if candidate_count > 1:
        prompts.extend(
            [
                (custom_prompt or prompt_package.final_prompt) + "\n\nVariation: conservative, journal-safe composition.",
                (custom_prompt or prompt_package.final_prompt) + "\n\nVariation: slightly more editorial, stronger focal hierarchy.",
                (custom_prompt or prompt_package.final_prompt) + "\n\nVariation: isolated assets or cleaner visual-abstract composition.",
            ][:candidate_count - 1]
        )
    out: list[IllustrationCandidate] = []
    for idx, prompt in enumerate(prompts[:candidate_count], 1):
        candidate_id = _slugify_token(f"{brief.title}-{backend}-c{idx}")
        if backend == "gemini_imagen":
            candidate = await _generate_imagen_candidate(
                api_key,
                prompt,
                storage_dir,
                candidate_id,
                model=model,
            )
        else:
            candidate = await _generate_openai_candidate(
                api_key,
                prompt,
                storage_dir,
                candidate_id,
                model=model,
                background=background,
                quality=quality,
                size=size,
            )
        candidate.prompt = prompt
        candidate.prompt_package = prompt_package
        candidate.output_mode = brief.output_mode
        candidate.score = score_candidate(brief, prompt_package, output_mode=brief.output_mode)
        out.append(candidate)
    return out


def public_candidate_payload(project_id: str, candidate: IllustrationCandidate) -> IllustrationCandidate:
    public = candidate.model_copy(deep=True)
    public.image_url = f"/api/projects/{project_id}/figure_builder/candidates/{candidate.id}/image"
    return public


def generated_visual_from_candidate(
    project_id: str,
    candidate: IllustrationCandidate,
    *,
    caption: str,
    style_preset: str,
) -> GeneratedVisual:
    return GeneratedVisual(
        image_url=f"/api/projects/{project_id}/figure_builder/candidates/{candidate.id}/image",
        pdf_url=None,
        table_html=None,
        table_data=None,
        caption=caption,
        source_code="",
        style_preset=style_preset,
        candidate_id=candidate.id,
        score=candidate.score.model_dump() if candidate.score else None,
    )


def build_refined_prompt_package(
    brief: FigureBrief,
    original: PromptPackage,
    instruction: str,
) -> PromptPackage:
    refined = original.model_copy(deep=True)
    extra = instruction.strip()
    if not extra:
        return refined
    refined.layer3_composition = f"{refined.layer3_composition} Refinement: {extra}"
    refined.final_prompt = f"{original.final_prompt}\n\nRefinement instructions:\n- {extra}"
    return refined


async def generate_imagen_figure(
    api_key: str,
    item: VisualItem,
    storage_dir: str,
    *,
    model: str = "imagen-3.0-generate-002",
) -> dict:
    brief = build_figure_brief(item=item)
    prompt_package = build_prompt_package(brief)
    try:
        candidate = await _generate_imagen_candidate(
            api_key,
            prompt_package.final_prompt,
            storage_dir,
            item.id,
            model=model,
        )
    except Exception as e:
        logger.error("Imagen generation failed for %s: %s", item.id, e)
        return {"image_path": None, "error": str(e), "candidate": None, "prompt_package": prompt_package.model_dump()}
    return {
        "image_path": candidate.file_path,
        "error": None,
        "candidate": candidate.model_dump(),
        "prompt_package": prompt_package.model_dump(),
    }


# ── Chat-based visual editing ─────────────────────────────────────────────────

_EDIT_SYSTEM = """\
You are editing a matplotlib figure or data table for an academic manuscript.
The user will describe a change they want to make. Apply the change and return
the updated code or table data.

For figures (matplotlib code):
- Return ONLY the updated Python code, no markdown fences, no explanation
- Preserve the plt.savefig("output.png", ...) call at the end
- Only make the requested change; keep everything else the same

For tables (structured JSON):
- Return ONLY valid JSON with {headers, rows, footnotes}
- Apply the requested change to columns, rows, or footnotes
- Keep all other data intact

After the code/JSON, on a new line starting with "# EXPLANATION:", write one
sentence describing what you changed.
""".strip()


async def edit_visual_code(
    provider: AIProvider,
    item: VisualItem,
    message: str,
    chat_history: list[dict],
    current_code: Optional[str] = None,
) -> dict:
    """
    One turn of iterative editing for a generated visual.

    Returns {new_code: str, explanation: str}
    """
    if current_code is None and item.generated:
        current_code = item.generated.source_code

    if item.render_mode == "table" and item.generated and item.generated.table_data:
        current_repr = json.dumps(item.generated.table_data, indent=2)
        context = f"Current table data (JSON):\n```json\n{current_repr}\n```\n"
    else:
        context = f"Current code:\n```python\n{current_code or ''}\n```\n"

    # Build multi-turn history for the AI
    messages_for_ai = []
    for turn in chat_history[-6:]:  # limit history
        role = turn.get("role", "user")
        content = turn.get("content", "")
        messages_for_ai.append({"role": role, "content": content})

    user_content = f"{context}\nUser request: {message}"

    raw = await provider.complete(
        system=_EDIT_SYSTEM,
        user=user_content,
        json_mode=False,
        temperature=0.3,
        max_tokens=3000,
    )

    # Split code from explanation
    explanation = ""
    if "# EXPLANATION:" in raw:
        parts = raw.split("# EXPLANATION:", 1)
        new_code = parts[0].strip()
        explanation = parts[1].strip()
    else:
        new_code = raw.strip()

    # Strip markdown fences
    new_code = re.sub(r"^```[^\n]*\n?", "", new_code)
    new_code = re.sub(r"\n?```$", "", new_code.strip())

    return {"new_code": new_code, "explanation": explanation}


# ── Caption generation ────────────────────────────────────────────────────────

_CAPTION_SYSTEM = """\
Generate an APA 7th edition caption for this figure or table.

For figures: caption goes below. Format:
Figure N
Descriptive Title in Title Case

Note. [Optional note explaining symbols, abbreviations, data source.]

For tables: caption goes above. Format:
Table N
Descriptive Title in Title Case

Note. [Optional note.]

Return ONLY the caption text, no extra commentary.
""".strip()


async def generate_caption(
    provider: AIProvider,
    item: VisualItem,
    number: int,
) -> str:
    """Generate an APA 7th edition caption for a generated visual."""
    label = "Table" if item.type == "table" else "Figure"
    structure = ", ".join(item.suggested_structure[:3])

    user_msg = (
        f"{label} {number}\n"
        f"Title: {item.title}\n"
        f"Purpose: {item.purpose}\n"
        f"Structure/columns: {structure}\n"
        f"Reporting guideline: {item.reporting_guideline or 'None'}\n\n"
        f"Generate the APA caption."
    )

    caption = await provider.complete(
        system=_CAPTION_SYSTEM,
        user=user_msg,
        json_mode=False,
        temperature=0.3,
        max_tokens=200,
    )
    return caption.strip()
