/**
 * Dynamic label maps for search strategy frameworks.
 *
 * Maps framework_used → { element_key: "Human Label" } for both
 * framework_elements and facets rendering.
 */

export const FRAMEWORK_ELEMENT_LABELS: Record<string, Record<string, string>> = {
  // Clinical / evidence-based
  PICO: {
    population: 'Population',
    intervention: 'Intervention',
    comparator: 'Comparator',
    outcome: 'Outcome',
  },
  PECO: {
    population: 'Population',
    exposure: 'Exposure',
    comparator: 'Comparator',
    outcome: 'Outcome',
  },
  PEO: {
    population: 'Population',
    exposure: 'Exposure/Issue',
    outcome: 'Outcome',
  },
  SPIDER: {
    sample: 'Sample',
    phenomenon: 'Phenomenon of Interest',
    design: 'Design',
    evaluation: 'Evaluation',
    research_type: 'Research Type',
  },
  // Non-clinical / academic writing
  CONCEPT_BASED: {
    core_concepts: 'Core Concepts',
    related_concepts: 'Related Concepts',
    key_theories: 'Key Theories/Frameworks',
    seminal_authors: 'Seminal Authors',
    schools_of_thought: 'Schools of Thought',
    historical_roots: 'Historical Roots',
    current_debates: 'Current Debates/Applications',
  },
  THEMATIC: {
    main_themes: 'Main Themes',
    sub_themes: 'Sub-themes',
    contextual_factors: 'Contextual Factors',
    populations_settings: 'Populations/Settings',
    time_trends: 'Time Trends',
    emerging_issues: 'Emerging Issues',
    contrasting_positions: 'Contrasting Positions',
  },
  METHODOLOGY_FOCUSED: {
    method_name: 'Method/Approach',
    variants: 'Variants/Related Methods',
    applications: 'Applications/Use Cases',
    limitations: 'Limitations/Bias',
    competing_methods: 'Competing Methods',
    domains: 'Domains of Application',
    evaluation_criteria: 'Evaluation Criteria',
  },
  INTERDISCIPLINARY: {
    core_concept: 'Core Cross-disciplinary Concept',
    discipline_a: 'Discipline A Terms',
    discipline_b: 'Discipline B Terms',
    equivalences: 'Equivalent Terms Across Fields',
    bridge_concepts: 'Bridge Concepts',
    disciplinary_lenses: 'Disciplinary Lenses',
    applied_contexts: 'Applied Contexts',
  },
};

/** Human-friendly framework display names. */
export const FRAMEWORK_DISPLAY_NAMES: Record<string, string> = {
  PICO: 'PICO',
  PECO: 'PECO',
  PEO: 'PEO',
  SPIDER: 'SPIDER',
  CONCEPT_BASED: 'Concept-Based',
  THEMATIC: 'Thematic',
  METHODOLOGY_FOCUSED: 'Methodology-Focused',
  INTERDISCIPLINARY: 'Interdisciplinary',
  Heuristic: 'Heuristic',
};

/**
 * Humanize a raw snake_case key into a readable label.
 * Falls back to this when the key isn't in the known label map.
 */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get the display label for a framework element key.
 * Uses the known label map first, falls back to humanizeKey.
 */
export function getElementLabel(frameworkUsed: string, key: string): string {
  return FRAMEWORK_ELEMENT_LABELS[frameworkUsed]?.[key] ?? humanizeKey(key);
}
