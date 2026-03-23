# Design System Strategy: The Intelligent Manuscript

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Digital Curator."**

Unlike standard productivity tools that feel like rigid spreadsheets, this system is designed to feel like a high-end editorial atelier. It moves away from the "boxy" nature of traditional SaaS by embracing **Intentional Asymmetry** and **Tonal Depth**. We prioritize the "AI-first" experience not through robotic neon glows, but through a sophisticated, calm interface that recedes when the user is in "flow state" and comes forward with "intelligence" when the AI is active.

By utilizing a "Paper-on-Glass" metaphor, we create a workspace that feels expensive, curated, and profoundly quiet. We break the template look by using generous white space (the "breathing" effect) and overlapping elements that suggest a multi-dimensional workspace rather than a flat screen.
backend/services/paper_summarizer.py
---

## 2. Colors & Surface Philosophy
The palette is built on a foundation of "Atmospheric Neutrals" punctuated by a "Vibrant Intelligence" accent.

### The "No-Line" Rule
**Strict Mandate:** Designers are prohibited from using 1px solid borders for sectioning or containment. Structural boundaries must be defined solely through:
1. **Background Color Shifts:** Placing a `surface-container-low` (#f3f4f5) section against a `surface` (#f8f9fa) background.
2. **Tonal Transitions:** Using subtle shifts in the surface-container tiers to define the workspace.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers—stacked sheets of fine vellum or frosted glass.
* **Base Layer:** `surface` (#f8f9fa) for the main canvas.
* **The Workspace:** `surface-container-lowest` (#ffffff) for the actual writing area to provide maximum contrast for readability.
* **The Utility Layer:** `surface-container` (#edeeef) for sidebars or navigation, creating a natural "recessed" look.

### The "Glass & Gradient" Rule
To elevate the "AI" features beyond a standard UI, use **Glassmorphism** for floating AI suggestion cards. Use semi-transparent `surface` colors with a `backdrop-blur` of 12px–20px.
* **Signature Textures:** For primary CTAs (like "Generate Citations" or "Deep Research"), use a subtle linear gradient transitioning from `primary` (#3632b7) to `primary_container` (#504ed0) at a 135-degree angle. This adds a "soul" to the interface that flat colors lack.

---

## 3. Typography: The Editorial Contrast
We use a high-contrast pairing to distinguish between the **Tool** (UI) and the **Craft** (Content).

* **The Interface (Manrope):** A sharp, geometric sans-serif used for all functional elements.
* *Usage:* `display-lg` for impactful landing moments; `label-md` for metadata and tooltips.
* **The Content (Newsreader):** A sophisticated, high-readability serif designed for the intellectual rigors of research writing.
* *Usage:* All `body` and `title` tokens. The `body-lg` (1rem) is the gold standard for the writing experience, ensuring the eye doesn't fatigue during long-form sessions.

**Hierarchy Tip:** Use `headline-lg` in Manrope to frame a section, but keep the core research titles in `title-lg` Newsreader. This creates a "Documentary" aesthetic that feels authoritative and timeless.

---

## 4. Elevation & Depth
Depth is achieved through **Tonal Layering** rather than traditional structural lines.

* **The Layering Principle:** Stack `surface-container-lowest` cards on `surface-container-low` backgrounds to create a soft, natural lift. This mimics the way paper sits on a desk.
* **Ambient Shadows:** When an element must "float" (e.g., a context menu or AI bubble), use a shadow with a blur of `32px` or higher at an opacity of `4%–8%`. The shadow color should be a tinted version of `on-surface` (#191c1d) to ensure it feels like natural light, not a digital drop shadow.
* **The "Ghost Border" Fallback:** If a border is essential for accessibility, use a "Ghost Border": the `outline-variant` (#c7c4d8) token at **15% opacity**. Never use a 100% opaque border.

---

## 5. Components

### Writing Surface (The Canvas)
* **Style:** `surface-container-lowest` (#ffffff).
* **Constraint:** No borders. Use the `20` (7rem) spacing scale for lateral margins to create a focused, "columnar" writing experience.

### Buttons (The Action primitives)
* **Primary:** Gradient of `primary` to `primary_container`. `xl` (1.5rem) roundedness. No shadow unless hovered.
* **Secondary:** `secondary_container` (#d5e3fd) background with `on_secondary_container` (#57657b) text.
* **Tertiary:** Ghost style. No background, `primary` text. Use for low-emphasis actions like "Cancel" or "Archive."

### AI Insight Cards
* **Style:** Glassmorphic. `surface` at 80% opacity with `backdrop-blur`.
* **Accent:** A `2px` left-side highlight using `primary` (#3632b7) to signify "Intelligence."

### Input Fields & Search
* **Style:** Minimalist. No bottom line or box. Use `surface-container-high` (#e7e8e9) as a subtle background pill.
* **Focus State:** A soft `2px` glow of `surface_tint` (#4e4cce) at 20% opacity.

### Lists & Research Feeds
* **Forbid Dividers:** Do not use line separators. Use `spacing-4` (1.4rem) to separate list items.
* **Selection:** Use `primary_fixed` (#e2dfff) with `md` (0.75rem) corner radius to highlight selected research papers.

---

## 6. Do’s and Don’ts

### Do:
* **Do** use asymmetrical margins. A wider left margin for navigation and a tighter right margin for AI comments creates a "Modern Editorial" feel.
* **Do** lean into `surface-dim` (#d9dadb) for inactive or background states to keep the focus on the active writing.
* **Do** use the `full` (9999px) roundedness for small chips and tags, but stick to `md` (0.75rem) for large containers.

### Don’t:
* **Don’t** use pure black (#000000) for text. Use `on_surface` (#191c1d) to maintain the "Soft Minimalist" sophistication.
* **Don’t** use standard "Modal" popups that block the whole screen. Use "Floating Sheets" that utilize the Glassmorphism rules to keep the user's research visible underneath.
* **Don’t** crowd the interface. If a feature isn't needed for the current sentence, it should fade to a lower `on_surface_variant` opacity.