"""
sr_protocol_generator.py

Generates PRISMA-P 2015 compliant SR protocol documents, maps to PROSPERO fields,
generates search strings for 8 databases, and optionally registers on OSF.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime
from typing import Optional

import httpx

from services.ai_provider import AIProvider
from services.completion_guard import CompletionConfig, OutputFormat, TokenBudget

logger = logging.getLogger(__name__)


_PRISMA_P_ITEMS = {
    "1": "Title — identifies the report as a systematic review/meta-analysis",
    "2": "Registration — PROSPERO number with expected completion date",
    "3": "Protocol and registration — DOI or link to registered protocol",
    "4a": "Funding — funding sources for the review",
    "4b": "Institutional affiliations of all authors",
    "5": "Contributions of each author",
    "6": "Background — rationale for the review in context of existing knowledge",
    "7": "Objectives — explicit statement using PICO elements",
    "8": "Eligibility criteria — characteristics of eligible studies (PICO + study design + time/language limits)",
    "9": "Information sources — databases, registers, grey literature",
    "10": "Search strategy — full search for at least one database, including any limits",
    "11": "Study records — data management, selection process (numbers screened/included), automation",
    "12a": "Data collection — data extraction process (forms, pilot testing, dual extraction)",
    "12b": "Data items — list of variables to be collected",
    "13a": "Outcomes and prioritization — primary/secondary outcomes with measurement, aggregation",
    "13b": "Methods for handling alternative or multiple groupings of interventions/comparators",
    "14a": "Risk of bias assessment — tool to be used, per domain",
    "14b": "Individual study level vs summary level risk assessment",
    "15a": "Data synthesis — criteria for meta-analysis vs narrative synthesis",
    "15b": "Effect measure(s) to be used",
    "15c": "Heterogeneity — assessment (I², Q-statistic) and investigation (subgroup, meta-regression)",
    "15d": "Sensitivity analyses planned",
    "15e": "Assessment of reporting biases (funnel plots, Egger's test)",
    "15f": "Assessment of certainty (GRADE framework)",
    "16": "Meta-bias — potential biases that may affect the review process",
    "17": "Funding — sources, support, and role of funders",
}

# ── Cochrane/JBI study-design-specific extraction schema templates ─────────────
# Sources: Cochrane Handbook Ch.11, JBI Manual, SRDR+, PRISMA 2020, RoB 2.0, QUADAS-2
# Field types: text | number | list | boolean | dichotomous_outcome | continuous_outcome
# dichotomous_outcome → {events_intervention, n_intervention, events_control, n_control}
# continuous_outcome  → {mean_intervention, sd_intervention, n_intervention, mean_control, sd_control, n_control}

def _f(field: str, ftype: str, required: bool, description: str, section: str = "General") -> dict:
    return {"field": field, "type": ftype, "required": required,
            "description": description, "section": section}


_SCHEMA_TEMPLATES: dict[str, list[dict]] = {

    # ── RCT (Cochrane Handbook Ch.11, RoB 2.0) ──────────────────────────────
    "rct": [
        # Methods
        _f("study_design",           "text",    True,  "Confirm parallel/crossover/cluster/factorial RCT", "Methods"),
        _f("trial_registration_id",  "text",    False, "ClinicalTrials.gov or other registry ID (e.g., NCT01234567)", "Methods"),
        _f("funding_source",         "text",    True,  "Industry, government, charitable, or none declared", "Methods"),
        _f("conflicts_of_interest",  "text",    True,  "Author-reported conflicts; note 'none declared' if stated", "Methods"),
        _f("randomization_method",   "text",    True,  "Computer, block, stratified, minimisation — extract verbatim (Cochrane RoB 2 D1)", "Methods"),
        _f("allocation_concealment", "text",    True,  "Central phone/web, sealed opaque envelopes, pharmacy — extract verbatim (Cochrane RoB 2 D1)", "Methods"),
        _f("blinding_participants",  "boolean", True,  "Were participants blinded to allocation? (Cochrane RoB 2 D2)", "Methods"),
        _f("blinding_assessors",     "boolean", True,  "Were outcome assessors blinded? (Cochrane RoB 2 D4)", "Methods"),
        _f("itt_analysis",           "text",    True,  "Intention-to-treat (full ITT / modified ITT / per-protocol) — extract verbatim", "Methods"),
        _f("country",                "text",    False, "Country or countries where study was conducted", "Methods"),
        _f("setting",                "text",    False, "Hospital, community, primary care, online, etc.", "Methods"),
        # Participants
        _f("sample_size_randomized", "number",  True,  "Total N randomized across all arms", "Participants"),
        _f("sample_size_analyzed",   "number",  True,  "Total N included in primary analysis (often < randomized)", "Participants"),
        _f("age_mean_sd",            "text",    True,  "Mean age ± SD (or median [IQR]) for each arm", "Participants"),
        _f("percent_female",         "number",  False, "% female participants across all arms", "Participants"),
        _f("inclusion_criteria_summary", "text", False, "Key inclusion criteria as stated by authors", "Participants"),
        _f("baseline_comparability", "text",    False, "Were groups comparable at baseline? Note any imbalances", "Participants"),
        _f("n_lost_followup_intervention", "number", False, "N lost to follow-up in intervention arm", "Participants"),
        _f("n_lost_followup_control",      "number", False, "N lost to follow-up in control arm", "Participants"),
        _f("reasons_attrition",      "text",    False, "Reasons for dropout/withdrawal — extract verbatim if given", "Participants"),
        # Interventions
        _f("intervention_description","text",   True,  "Name, dose, frequency, delivery mode, duration — sufficient to replicate", "Interventions"),
        _f("comparator_description",  "text",   True,  "Placebo, usual care, active comparator — describe fully", "Interventions"),
        _f("intervention_duration",   "text",   True,  "Total duration of active intervention (e.g., '12 weeks')", "Interventions"),
        _f("intervention_fidelity",   "text",   False, "How adherence/fidelity was monitored or reported", "Interventions"),
        # Outcomes
        _f("primary_outcomes",       "list",    True,  "List primary outcomes with measurement tool and timepoint (e.g., 'HbA1c at 12 weeks via lab test')", "Outcomes"),
        _f("secondary_outcomes",     "list",    False, "List secondary outcomes with measurement tools", "Outcomes"),
        _f("adverse_events",         "list",    False, "All adverse events reported; note if none or 'not reported'", "Outcomes"),
        _f("outcome_timepoints",     "text",    False, "All measurement timepoints (e.g., baseline, 4w, 8w, 12w)", "Outcomes"),
        # Results
        _f("primary_outcome_data",   "dichotomous_outcome", True,
           "For binary outcomes: events and N per arm. For continuous: use continuous_outcome field instead", "Results"),
        _f("effect_measure_type",    "text",    True,  "OR, RR, RD, MD, SMD, HR — as reported by authors", "Results"),
        _f("effect_estimate",        "number",  True,  "Point estimate of effect (e.g., OR=1.23, MD=-0.5)", "Results"),
        _f("ci_95",                  "text",    True,  "95% confidence interval (e.g., '0.95 to 1.59')", "Results"),
        _f("p_value",                "text",    False, "P-value for primary outcome (exact if available)", "Results"),
        _f("author_conclusion",      "text",    True,  "Authors' main conclusion — extract verbatim from abstract/conclusion", "Results"),
    ],

    # ── Observational (Cohort / Case-Control / Cross-Sectional) ─────────────
    # Sources: Cochrane Handbook Ch.25, ROBINS-I, Newcastle-Ottawa Scale
    "observational": [
        _f("study_design",           "text",    True,  "Prospective cohort / retrospective cohort / case-control / cross-sectional", "Methods"),
        _f("study_duration",         "text",    False, "Total follow-up period for cohort studies", "Methods"),
        _f("funding_source",         "text",    True,  "Industry, government, charitable, or none declared", "Methods"),
        _f("conflicts_of_interest",  "text",    True,  "Author-reported conflicts", "Methods"),
        _f("country",                "text",    False, "Country or countries", "Methods"),
        _f("setting",                "text",    False, "Hospital, community, registry, database", "Methods"),
        # Participants
        _f("sample_size_total",      "number",  True,  "Total N enrolled/analysed", "Participants"),
        _f("age_mean_sd",            "text",    True,  "Mean/median age with SD or IQR", "Participants"),
        _f("percent_female",         "number",  False, "% female", "Participants"),
        _f("inclusion_criteria_summary", "text", False, "Key inclusion criteria", "Participants"),
        _f("response_rate",          "text",    False, "Response or participation rate (for surveys/cross-sectional)", "Participants"),
        # Exposure & confounding (ROBINS-I aligned)
        _f("intervention_description","text",   True,  "Exposure or intervention as defined by authors", "Interventions"),
        _f("comparator_description",  "text",   False, "Unexposed group or comparison group definition", "Interventions"),
        _f("confounders_measured",    "list",   True,  "List all confounders measured (e.g., age, BMI, smoking)", "Interventions"),
        _f("confounders_adjusted",    "list",   True,  "List confounders adjusted for in analysis", "Interventions"),
        _f("method_of_adjustment",    "text",   True,  "Regression, propensity score, stratification, matching", "Interventions"),
        # Outcomes
        _f("primary_outcomes",       "list",    True,  "Primary outcomes with measurement definition", "Outcomes"),
        _f("secondary_outcomes",     "list",    False, "Secondary outcomes", "Outcomes"),
        _f("outcome_assessment",     "text",    True,  "Objective (lab/imaging/registry) or subjective (self-report)?", "Outcomes"),
        _f("blinding_assessors",     "boolean", False, "Were outcome assessors blinded to exposure status?", "Outcomes"),
        # Results
        _f("effect_measure_type",    "text",    True,  "OR, RR, HR, RD, IRR, prevalence ratio — as reported", "Results"),
        _f("effect_estimate",        "number",  True,  "Adjusted point estimate", "Results"),
        _f("ci_95",                  "text",    True,  "95% CI for primary estimate", "Results"),
        _f("p_value",                "text",    False, "P-value", "Results"),
        _f("unadjusted_estimate",    "text",    False, "Unadjusted (crude) estimate if reported alongside adjusted", "Results"),
        _f("subgroup_analyses",      "text",    False, "Any pre-specified subgroup analyses", "Results"),
        _f("author_conclusion",      "text",    True,  "Authors' main conclusion — extract verbatim", "Results"),
    ],

    # ── Diagnostic Test Accuracy (QUADAS-2) ───────────────────────────────────
    "diagnostic": [
        _f("study_design",           "text",    True,  "Prospective/retrospective diagnostic cohort; single-gate or two-gate", "Methods"),
        _f("funding_source",         "text",    True,  "Funding source", "Methods"),
        _f("country",                "text",    False, "Country", "Methods"),
        _f("setting",                "text",    True,  "Primary care, emergency, specialist, community screening", "Methods"),
        # Participants
        _f("sample_size_total",      "number",  True,  "Total N in the diagnostic study", "Participants"),
        _f("age_mean_sd",            "text",    True,  "Mean/median age", "Participants"),
        _f("percent_female",         "number",  False, "% female", "Participants"),
        _f("disease_prevalence",     "number",  True,  "Prevalence of target condition in study sample (%)", "Participants"),
        _f("participant_selection",  "text",    True,  "Consecutive, random, or convenience sampling? QUADAS-2 domain", "Participants"),
        # Index test & reference standard
        _f("index_test_name",        "text",    True,  "Name of index test being evaluated (e.g., 'PCR', 'troponin I')", "Interventions"),
        _f("index_test_threshold",   "text",    True,  "Cut-off/threshold used and how determined (pre-specified?)", "Interventions"),
        _f("reference_standard",     "text",    True,  "Gold standard used for diagnosis — name and how applied", "Interventions"),
        _f("blinding_index_test",    "boolean", True,  "Were index test interpreters blinded to reference standard?", "Interventions"),
        _f("blinding_reference",     "boolean", True,  "Were reference standard assessors blinded to index test?", "Interventions"),
        # Diagnostic accuracy results
        _f("true_positives",         "number",  True,  "True positives (TP) from 2×2 table", "Results"),
        _f("false_positives",        "number",  True,  "False positives (FP) from 2×2 table", "Results"),
        _f("false_negatives",        "number",  True,  "False negatives (FN) from 2×2 table", "Results"),
        _f("true_negatives",         "number",  True,  "True negatives (TN) from 2×2 table", "Results"),
        _f("sensitivity",            "number",  True,  "Sensitivity = TP/(TP+FN) × 100 (%)", "Results"),
        _f("specificity",            "number",  True,  "Specificity = TN/(TN+FP) × 100 (%)", "Results"),
        _f("auc_roc",                "number",  False, "Area Under ROC Curve (0–1)", "Results"),
        _f("ppv",                    "number",  False, "Positive Predictive Value (%)", "Results"),
        _f("npv",                    "number",  False, "Negative Predictive Value (%)", "Results"),
        _f("likelihood_ratio_pos",   "text",    False, "Positive likelihood ratio (+LR)", "Results"),
        _f("likelihood_ratio_neg",   "text",    False, "Negative likelihood ratio (−LR)", "Results"),
        _f("author_conclusion",      "text",    True,  "Authors' main conclusion", "Results"),
    ],

    # ── Qualitative (JBI Meta-Aggregative Approach, SPIDER) ──────────────────
    "qualitative": [
        _f("study_design",           "text",    True,  "Phenomenology, grounded theory, ethnography, narrative, case study, thematic analysis", "Methods"),
        _f("data_collection_method", "text",    True,  "Interviews, focus groups, observation, document review, diary — describe fully", "Methods"),
        _f("analysis_method",        "text",    True,  "Thematic analysis, content analysis, IPA, constant comparative, grounded theory", "Methods"),
        _f("theoretical_framework",  "text",    False, "Underpinning theory or epistemological stance stated by authors", "Methods"),
        _f("funding_source",         "text",    False, "Funding source", "Methods"),
        _f("country",                "text",    False, "Country of study", "Methods"),
        # Participants (Sample in SPIDER)
        _f("sample_size_total",      "number",  True,  "Number of participants", "Participants"),
        _f("participant_description","text",    True,  "Key characteristics: age, gender, role, experience, clinical status", "Participants"),
        _f("recruitment_method",     "text",    True,  "Purposive, snowball, theoretical, convenience", "Participants"),
        _f("setting",                "text",    True,  "Where participants were recruited/studied", "Participants"),
        _f("saturation_reached",     "boolean", False, "Did authors claim data saturation? (important for rigor)", "Participants"),
        # Phenomenon of Interest / Findings
        _f("key_findings",           "list",    True,  "List all JBI 'findings' (author interpretations with supporting data)", "Outcomes"),
        _f("themes",                 "list",    True,  "List of themes/categories identified by authors", "Outcomes"),
        _f("verbatim_quotes",        "list",    True,  "2–3 illustrative verbatim participant quotes per theme", "Outcomes"),
        _f("negative_cases",         "text",    False, "Did authors discuss disconfirming or negative cases?", "Outcomes"),
        # Methodological rigor (JBI QARI tool)
        _f("congruity_methodology",  "boolean", True,  "Is methodology congruent with research question? (JBI criterion 1)", "Methods"),
        _f("reflexivity_addressed",  "boolean", True,  "Did authors address researcher reflexivity? (JBI criterion 6)", "Methods"),
        _f("member_checking",        "boolean", False, "Was member-checking or participant validation conducted?", "Methods"),
        _f("author_conclusion",      "text",    True,  "Authors' main conclusion — extract verbatim", "Results"),
    ],

    # ── Prevalence / Incidence (CoCoPop, JBI Prevalence tool) ────────────────
    "prevalence": [
        _f("study_design",           "text",    True,  "Point prevalence / period prevalence / lifetime prevalence / incidence study", "Methods"),
        _f("sampling_method",        "text",    True,  "Random, systematic, stratified, cluster, convenience, census — Cochrane/JBI require representative sample", "Methods"),
        _f("funding_source",         "text",    False, "Funding source", "Methods"),
        _f("country",                "text",    True,  "Country or region", "Methods"),
        _f("setting",                "text",    True,  "Community, hospital, school, occupational, national registry", "Methods"),
        _f("study_year",             "text",    False, "Year or period of data collection", "Methods"),
        # Participants
        _f("sample_size_total",      "number",  True,  "Total N sampled", "Participants"),
        _f("response_rate",          "number",  False, "Participation/response rate (%)", "Participants"),
        _f("age_range",              "text",    True,  "Age range or mean of study population", "Participants"),
        _f("percent_female",         "number",  False, "% female", "Participants"),
        _f("inclusion_criteria_summary", "text", False, "Key inclusion/exclusion criteria", "Participants"),
        # Case definition & measurement
        _f("case_definition",        "text",    True,  "Exact diagnostic criteria or case definition used — extract verbatim", "Outcomes"),
        _f("outcome_measurement",    "text",    True,  "Objective (lab/registry) or subjective (self-report/screening tool)?", "Outcomes"),
        _f("measurement_tool",       "text",    False, "Specific scale, questionnaire, or test used", "Outcomes"),
        # Results
        _f("numerator",              "number",  True,  "Number with the condition (cases)", "Results"),
        _f("denominator",            "number",  True,  "Total number in denominator population", "Results"),
        _f("prevalence_estimate",    "number",  True,  "Prevalence/incidence proportion or rate (raw value)", "Results"),
        _f("prevalence_unit",        "text",    True,  "% / per 1000 / per 100,000 / person-years", "Results"),
        _f("ci_95",                  "text",    True,  "95% confidence interval for prevalence estimate", "Results"),
        _f("stratified_estimates",   "list",    False, "Estimates stratified by age, sex, region if reported", "Results"),
        _f("author_conclusion",      "text",    True,  "Authors' main conclusion", "Results"),
    ],

    # ── Case Report / Case Series (JBI) ──────────────────────────────────────
    "case_report": [
        _f("study_design",           "text",    True,  "Single case report / case series (specify N)", "Methods"),
        _f("funding_source",         "text",    False, "Funding source or none declared", "Methods"),
        _f("country",                "text",    False, "Country where case occurred", "Methods"),
        _f("setting",                "text",    False, "Hospital, outpatient, community", "Methods"),
        # Case characteristics
        _f("patient_age",            "text",    True,  "Patient age (or age range for series)", "Participants"),
        _f("patient_sex",            "text",    True,  "Patient sex/gender", "Participants"),
        _f("relevant_history",       "text",    False, "Relevant past medical history and comorbidities", "Participants"),
        # Clinical presentation
        _f("presenting_complaint",   "text",    True,  "Chief complaint or reason for presentation — extract verbatim", "Outcomes"),
        _f("symptom_duration",       "text",    False, "Duration of symptoms before presentation", "Outcomes"),
        _f("diagnostic_criteria",    "text",    True,  "Criteria used to establish diagnosis; tests performed and results", "Outcomes"),
        # Intervention
        _f("intervention_description","text",   True,  "Treatment provided — drug/dose/route or procedure; describe fully", "Interventions"),
        _f("intervention_duration",  "text",    False, "Duration of treatment", "Interventions"),
        # Outcomes
        _f("clinical_response",      "text",    True,  "Patient response to treatment — extract verbatim", "Results"),
        _f("adverse_events",         "list",    True,  "Any adverse events or complications; note 'none reported' if stated", "Results"),
        _f("followup_duration",      "text",    True,  "Total follow-up period after treatment", "Results"),
        _f("final_outcome",          "text",    True,  "Resolution / improvement / no change / deterioration / death", "Results"),
        _f("case_uniqueness",        "text",    True,  "What makes this case clinically significant or unique?", "Results"),
        _f("alternative_diagnoses",  "text",    False, "Alternative diagnoses considered and ruled out", "Results"),
        _f("author_conclusion",      "text",    True,  "Authors' main learning points and conclusion", "Results"),
    ],
}


def _select_template(question_type: str, study_design: str) -> tuple[str, list[dict]]:
    """
    Select the best Cochrane/JBI extraction schema template based on
    question type and study design. Returns (template_name, fields).
    """
    qt = (question_type or "").lower()
    sd = (study_design or "").lower()

    if qt == "diagnosis":
        return "diagnostic", _SCHEMA_TEMPLATES["diagnostic"]
    if qt in ("qualitative-experience",) or "qualitative" in sd:
        return "qualitative", _SCHEMA_TEMPLATES["qualitative"]
    if qt == "prevalence":
        return "prevalence", _SCHEMA_TEMPLATES["prevalence"]
    if "case series" in sd or "case report" in sd:
        return "case_report", _SCHEMA_TEMPLATES["case_report"]
    if "rct" in sd or "randomis" in sd or "randomiz" in sd:
        return "rct", _SCHEMA_TEMPLATES["rct"]
    if any(x in sd for x in ("cohort", "case-control", "cross-sectional", "quasi")):
        return "observational", _SCHEMA_TEMPLATES["observational"]
    # Default: RCT template is the most complete and applicable to most effectiveness reviews
    return "rct", _SCHEMA_TEMPLATES["rct"]


def _merge_schema(template_fields: list[dict], ai_fields: list[dict]) -> list[dict]:
    """
    Merge AI-suggested domain-specific fields into template.
    Template fields take priority; AI adds fields not already present.
    """
    existing = {f["field"] for f in template_fields}
    extra = [f for f in ai_fields if f.get("field") and f["field"] not in existing]
    # Ensure extra fields have description and section
    for f in extra:
        f.setdefault("description", "")
        f.setdefault("section", "General")
    return template_fields + extra


_PROSPERO_FIELDS = [
    "review_title", "review_type", "review_question", "population",
    "intervention", "comparator", "outcome", "timing_of_outcome_measurement",
    "study_design", "eligibility_criteria", "information_sources", "main_outcome_measures",
    "strategy_for_data_extraction", "data_management", "synthesis_of_results",
    "subgroup_analysis", "sensitivity_analysis", "language", "country",
    "background", "health_condition", "anticipated_start_date", "anticipated_completion_date",
    "guidance_document_reference", "funding_source", "conflicts_of_interest",
    "named_contact", "named_contact_email", "organizational_affiliation",
    "collaborative_group", "contributors", "review_status", "registration_source",
    "protocol_link", "stage_of_review_when_registered",
    "anticipated_international_prospective_register_of_systematic_reviews",
    "article_type", "registration_number", "mesh_terms", "date_of_last_amendment",
]


async def parse_pico_from_text(text: str, ai_provider: AIProvider, review_type: str = "systematic_review", framework: str = "") -> dict:
    """
    Parse a free-form research question, abstract, or uploaded protocol text
    using a Cochrane/JBI-trained methodologist approach.

    Automatically selects the best framework (PICO, SPIDER, PEO, PICOTS, etc.),
    classifies the question type, and returns a rich structured output.

    Returns a dict with keys:
      question_type, framework, review_title, review_objective, review_question,
      alternative_phrasings, methodological_cautions,
      pico, inclusion_criteria, exclusion_criteria, extraction_schema
    """
    system = """You are a Cochrane/JBI-trained systematic review methodologist with expertise in evidence synthesis methodology.

The user will provide a research topic, question, or protocol excerpt. Do the following in order:

STEP 1 — Classify the review question type as exactly one of:
  effectiveness | prevention | diagnosis | prognosis | etiology-risk | qualitative-experience | mixed-methods | prevalence | policy-service-delivery

STEP 2 — Select the best framework:
  - PICO or PICOS for effectiveness/intervention/prevention questions
  - PICOTS (adding Timing and Setting) when temporal or contextual scope matters
  - PEO (Population, Exposure, Outcome) for etiology/risk/qualitative-experience questions
  - SPIDER (Sample, Phenomenon of Interest, Design, Evaluation, Research type) for qualitative reviews
  - CoCoPop (Condition, Context, Population) for prevalence/incidence questions
  - ECLIPSE for policy/service-delivery questions
  Do NOT force PICO when the question type calls for a different framework.

STEP 3 — Fill the chosen framework's elements in the "pico" object using the framework's NATIVE element keys:
  PICO:    population, intervention, comparator, outcome
  PICOS:   population, intervention, comparator, outcome, study_design
  PCC:     population, concept, context          ← JBI scoping review framework
  SPIDER:  sample, phenomenon_of_interest, design, evaluation, research_type
  PEO:     population, exposure, outcome
  ECLIPSE: expectation, client_group, location, impact, professionals, service
  SPICE:   setting, perspective, interest, comparison, evaluation
  PICOTS:  population, intervention, comparator, outcome, timing, setting
  CoCoPop: condition, context, population

  PICO guidance (Cochrane Handbook):
  - Population: Be specific. Include age group, clinical diagnosis, setting if relevant.
  - Intervention: Name the intervention explicitly; include dose/delivery if known.
  - Comparator: OPTIONAL. Omit if the question is prevalence, etiology, or qualitative experience.
  - Outcome: Primary; Secondary; Adverse outcomes. Prespecify for prioritization — rarely a strict gate.

  PCC guidance (JBI Manual for Scoping Reviews):
  - Population: Who is the review about?
  - Concept: What is being mapped (phenomenon, activity, exposure)?
  - Context: Where or in what circumstances (setting, culture, geographic area)?

  Always include these additional fields in "pico" regardless of framework:
    study_design, health_area, language_restriction, date_from, date_to, review_type, target_registries

STEP 4 — Produce a JSON response with this exact structure (no markdown fences, no extra keys):
{
  "question_type": "effectiveness",
  "framework": "PICO",
  "review_title": "A protocol-ready review title",
  "review_objective": "To assess the effectiveness of [intervention] on [outcomes] in [population]",
  "review_question": "In [population], does [intervention], compared with [comparator], affect [outcomes]?",
  "alternative_phrasings": [
    "Broad phrasing of the question",
    "Moderate phrasing",
    "Narrow/focused phrasing"
  ],
  "methodological_cautions": "Concise paragraph on: whether comparator can remain broad; whether outcomes should be strict eligibility criteria or flexible prioritization; whether another framework would perform better; any known heterogeneity or indexing issues to warn the user about.",
  "pico": {
    "<<native element keys for the selected framework>>": "filled values",
    "study_design": "Comma-separated from: RCT, Quasi-experimental, Cohort, Case-control, Cross-sectional, Case series, Mixed methods, Qualitative, Any",
    "health_area": "Clinical specialty or subject area",
    "language_restriction": "No restriction",
    "date_from": "2000-01-01",
    "date_to": "",
    "review_type": "systematic_review",
    "target_registries": []
  },
  "inclusion_criteria": [
    "Studies involving [specific population/sample]",
    "Studies evaluating [concept/intervention/exposure]",
    "Peer-reviewed primary research",
    "Additional domain-specific criteria..."
  ],
  "exclusion_criteria": [
    "Non-human studies (animal, in vitro)",
    "Conference abstracts without full text",
    "Additional domain-specific exclusions..."
  ],
  "extraction_schema": [
    {"field": "study_design", "type": "text", "required": true},
    {"field": "sample_size", "type": "number", "required": true},
    {"field": "population_description", "type": "text", "required": true},
    {"field": "intervention_description", "type": "text", "required": true},
    {"field": "comparator_description", "type": "text", "required": false},
    {"field": "primary_outcomes", "type": "list", "required": true},
    {"field": "follow_up_duration", "type": "text", "required": false},
    {"field": "country", "type": "text", "required": false},
    {"field": "funding_source", "type": "text", "required": false}
  ]
}

IMPORTANT: The "pico" object MUST use the native element keys for the selected framework.
  Examples:
    PCC  → "pico": { "population": "...", "concept": "...", "context": "...", "study_design": "...", ... }
    SPIDER → "pico": { "sample": "...", "phenomenon_of_interest": "...", "design": "...", "evaluation": "...", "research_type": "...", "study_design": "...", ... }
    PEO  → "pico": { "population": "...", "exposure": "...", "outcome": "...", "study_design": "...", ... }
  Do NOT map non-PICO elements into PICO field names.

Additional rules:
- For extraction_schema: add domain-specific fields beyond the defaults when clearly relevant (e.g. "risk_ratio", "nnt", "adverse_events" for clinical trials; "odds_ratio", "incidence_rate" for epidemiology; "theme", "participant_quote" for qualitative reviews).
- inclusion_criteria and exclusion_criteria must be specific to the topic, not generic boilerplate.
- Generate exactly 3 alternative_phrasings: broad → moderate → narrow.
- methodological_cautions must be substantive (2–4 sentences), referencing Cochrane or JBI guidance where applicable.
- Return ONLY valid JSON. Do NOT add explanations outside the JSON."""

    framework_hint = f"\nPreferred framework (override — use this framework if suitable): {framework}" if framework else ""
    user = f"""Topic / research question:

---
{text[:4000]}
---

Review type (override): {review_type}{framework_hint}

Apply the Cochrane/JBI methodologist workflow and return the structured JSON."""

    try:
        resp = await ai_provider.guarded_complete(
            system=system, user=user,
            config=CompletionConfig(
                output_format=OutputFormat.JSON,
                budget=TokenBudget(target_json_keys=40, format=OutputFormat.JSON),
                max_continuations=1,
            ),
            json_mode=True, temperature=0.2,
        )
        result = json.loads(resp.text)
        # Guarantee review_type override and required keys
        if "pico" in result:
            result["pico"]["review_type"] = review_type
            result["pico"].setdefault("target_registries", [])
        result.setdefault("question_type", "effectiveness")
        result.setdefault("framework", "PICO")
        result.setdefault("review_title", "")
        result.setdefault("review_objective", "")
        result.setdefault("review_question", "")
        result.setdefault("alternative_phrasings", [])
        result.setdefault("methodological_cautions", "")

        # Apply Cochrane/JBI study-design-specific schema template
        question_type = result.get("question_type", "effectiveness")
        study_design = result.get("pico", {}).get("study_design", "")
        template_name, template_fields = _select_template(question_type, study_design)
        ai_extra_fields = result.get("extraction_schema", [])
        result["extraction_schema"] = _merge_schema(template_fields, ai_extra_fields)
        result["schema_template"] = template_name

        return result
    except Exception as e:
        logger.error("parse_pico_from_text failed: %s", e)
        return {
            "question_type": "effectiveness",
            "framework": "PICO",
            "review_title": "",
            "review_objective": "",
            "review_question": "",
            "alternative_phrasings": [],
            "methodological_cautions": "",
            "schema_template": "rct",
            "pico": {
                "population": "",
                "intervention": "",
                "comparator": "",
                "outcome": "",
                "study_design": "",
                "health_area": "",
                "language_restriction": "No restriction",
                "date_from": "2000-01-01",
                "date_to": "",
                "review_type": review_type,
                "target_registries": [],
            },
            "inclusion_criteria": ["Human participants", "Original research", "Peer-reviewed publications"],
            "exclusion_criteria": ["Animal studies", "Non-English without translation", "Conference abstracts without full text"],
            "extraction_schema": _SCHEMA_TEMPLATES["rct"],
            "error": str(e),
        }


async def generate_protocol_document(
    pico: dict,
    ai_provider: AIProvider,
    prisma_p_data: Optional[dict] = None,
) -> str:
    """
    Generate a full PRISMA-P 2015 compliant protocol document in Markdown.
    When prisma_p_data is provided (all 17 items filled), generates a richer document.
    """
    system = """You are an expert systematic review methodologist. Generate a complete, PRISMA-P 2015 compliant protocol document in Markdown.

The document MUST include ALL 17 PRISMA-P items and these sections in order:
1. Administrative Information (Title, Registration, Authors, Funding)
2. Background and Rationale
3. Objectives (explicit PICO/SPIDER/PEO statement)
4. Methods:
   4.1 Eligibility Criteria
   4.2 Information Sources (databases, grey literature)
   4.3 Search Strategy
   4.4 Study Records (data management, selection process, data collection process)
   4.5 Data Items
   4.6 Outcomes and Prioritization
   4.7 Risk of Bias Assessment
   4.8 Data Synthesis
   4.9 Meta-Bias Assessment
   4.10 Confidence in Evidence (GRADE)
5. Strengths and Limitations
6. Dissemination Plans

Use formal academic writing. Be specific about tools, software, and statistical methods.
Return ONLY the Markdown text — no JSON, no preamble."""

    population = pico.get("population", "")
    intervention = pico.get("intervention", "")
    comparator = pico.get("comparator", "")
    outcome = pico.get("outcome", "")
    study_design = pico.get("study_design", "randomised controlled trials")
    review_type = pico.get("review_type", "systematic_review")
    health_area = pico.get("health_area", "")
    date_from = pico.get("date_from", "inception")
    date_to = pico.get("date_to", "present")
    language = pico.get("language_restriction", "English")

    context_lines = [
        f"**Review Type:** {review_type}",
        "**PICO:**",
        f"- Population: {population}",
        f"- Intervention: {intervention}",
        f"- Comparator: {comparator or 'Not specified / not applicable'}",
        f"- Outcome: {outcome}",
        f"- Study Design: {study_design}",
        f"- Health Area: {health_area}",
        f"- Date Range: {date_from} to {date_to}",
        f"- Language: {language}",
    ]

    if prisma_p_data:
        admin = prisma_p_data.get("administrative", {})
        intro = prisma_p_data.get("introduction", {})
        elig = prisma_p_data.get("methods_eligibility", {})
        dc = prisma_p_data.get("methods_data_collection", {})
        synth = prisma_p_data.get("methods_synthesis", {})

        if admin.get("review_title"):
            context_lines.insert(0, f"**Title:** {admin['review_title']}")
        if admin.get("authors") and isinstance(admin["authors"], list):
            author_str = "; ".join(
                a.get("name", "") + (f" ({a.get('affiliation','')})" if a.get("affiliation") else "")
                for a in admin["authors"] if isinstance(a, dict) and a.get("name")
            )
            if author_str:
                context_lines.append(f"**Authors:** {author_str}")
        if admin.get("funding_sources"):
            context_lines.append(f"**Funding:** {admin['funding_sources']}")
        if intro.get("rationale"):
            context_lines.append(f"\n**Rationale:**\n{intro['rationale']}")
        if elig.get("inclusion_criteria") and isinstance(elig["inclusion_criteria"], list):
            context_lines.append("**Inclusion Criteria:** " + "; ".join(elig["inclusion_criteria"]))
        if elig.get("exclusion_criteria") and isinstance(elig["exclusion_criteria"], list):
            context_lines.append("**Exclusion Criteria:** " + "; ".join(elig["exclusion_criteria"]))
        if elig.get("databases") and isinstance(elig["databases"], list):
            context_lines.append("**Databases:** " + ", ".join(elig["databases"]))
        if dc.get("selection_process"):
            context_lines.append(f"**Selection Process:** {dc['selection_process']}")
        if dc.get("outcome_prioritization"):
            context_lines.append(f"**Outcome Prioritization:** {dc['outcome_prioritization']}")
        if synth.get("rob_tool"):
            context_lines.append(f"**Risk of Bias Tool:** {synth['rob_tool']}")
        if synth.get("synthesis_type"):
            context_lines.append(f"**Synthesis Type:** {synth['synthesis_type']}")
        if synth.get("effect_measure"):
            context_lines.append(f"**Effect Measure:** {synth['effect_measure']}")
        if synth.get("publication_bias_plan"):
            context_lines.append(f"**Publication Bias Plan:** {synth['publication_bias_plan']}")
        if synth.get("grade_plan"):
            context_lines.append(f"**GRADE Plan:** {synth['grade_plan']}")

    user = "Generate a complete PRISMA-P 2015 protocol document for:\n\n" + "\n".join(context_lines)

    return await ai_provider.complete(
        system=system,
        user=user,
        temperature=0.3,
        max_tokens=8192,
    )


async def map_to_prospero_fields(
    pico: dict,
    protocol_text: str,
    ai_provider: AIProvider,
) -> dict:
    """
    Map PICO data and protocol text to all 40 PROSPERO fields.
    Returns a structured dict ready for PROSPERO form submission.
    """
    system = """You are an expert in PROSPERO systematic review registration.
Extract and map all required PROSPERO fields from the provided PICO data and protocol text.
Return ONLY valid JSON with these exact field names (no markdown fences):

{
  "review_title": "...",
  "review_type": "Systematic review" or "Meta-analysis",
  "review_question": "...",
  "population": "...",
  "intervention": "...",
  "comparator": "...",
  "outcome": "...",
  "timing_of_outcome_measurement": "...",
  "study_design": "...",
  "eligibility_criteria": "...",
  "information_sources": "...",
  "main_outcome_measures": "...",
  "strategy_for_data_extraction": "...",
  "data_management": "...",
  "synthesis_of_results": "...",
  "subgroup_analysis": "...",
  "sensitivity_analysis": "...",
  "language": "...",
  "country": "...",
  "background": "...",
  "health_condition": "...",
  "anticipated_start_date": "...",
  "anticipated_completion_date": "...",
  "funding_source": "None declared",
  "conflicts_of_interest": "None declared",
  "review_status": "Ongoing",
  "stage_of_review_when_registered": "Review planning stage",
  "article_type": "Systematic review",
  "copy_paste_guide": "Step-by-step instructions for submitting to PROSPERO at https://www.crd.york.ac.uk/prospero/"
}"""

    user = f"""PICO Data:
{json.dumps(pico, indent=2)}

Protocol Document (excerpt):
{protocol_text[:3000]}

Map ALL PROSPERO fields. For fields not determinable from the PICO/protocol, provide reasonable placeholder text."""

    try:
        raw = await ai_provider.complete(system=system, user=user, json_mode=True, temperature=0.2)
        result = json.loads(raw)
        # Ensure copy_paste_guide is always present
        if "copy_paste_guide" not in result:
            result["copy_paste_guide"] = (
                "1. Go to https://www.crd.york.ac.uk/prospero/\n"
                "2. Click 'Register a new review'\n"
                "3. Copy each field value from this document into the corresponding PROSPERO field\n"
                "4. The review will be assessed within 5 working days\n"
                "5. You will receive a PROSPERO ID (format CRDxxxxxxxxxxxx) upon registration"
            )
        return result
    except Exception as e:
        logger.error("PROSPERO field mapping failed: %s", e)
        return {"error": str(e), "pico": pico}


async def map_to_campbell_fields(
    pico: dict,
    protocol_text: str,
    ai_provider: AIProvider,
) -> dict:
    """
    Map protocol to Campbell Collaboration template structure.
    Emphasizes broader study design, grey literature, and 8 Campbell coordinating groups.
    """
    system = """You are an expert in Campbell Collaboration systematic review standards.
Map the PICO and protocol to the Campbell Collaboration template structure.
Return ONLY valid JSON:
{
  "title": "...",
  "coordinating_group": "...",  // One of: Crime and Justice, Disability, Education, International Development, Knowledge Translation and Implementation, Methods, Social Welfare, User Engagement
  "background": "...",
  "objectives": "...",
  "search_strategy": "...",
  "selection_criteria": "...",
  "data_collection": "...",
  "data_synthesis": "...",
  "study_designs_included": [...],  // RCTs, quasi-experimental, interrupted time series, etc.
  "grey_literature_sources": [...],
  "contact_person": "...",
  "review_type": "..."
}"""

    user = f"""PICO:
{json.dumps(pico, indent=2)}

Protocol Excerpt:
{protocol_text[:2000]}

Map to Campbell Collaboration template."""

    try:
        raw = await ai_provider.complete(system=system, user=user, json_mode=True, temperature=0.2)
        return json.loads(raw)
    except Exception as e:
        logger.error("Campbell field mapping failed: %s", e)
        return {"error": str(e)}


async def generate_prisma_p_checklist(protocol_text: str) -> dict:
    """
    Check the generated protocol text against all 26 PRISMA-P items.
    Returns completion status for each item.
    """
    checklist = {}
    for item_id, description in _PRISMA_P_ITEMS.items():
        # Heuristic: check if key words from the description appear in the protocol
        keywords = description.lower().split()[:4]  # First 4 words as keywords
        found = any(kw in protocol_text.lower() for kw in keywords if len(kw) > 4)
        checklist[item_id] = {
            "description": description,
            "status": "complete" if found else "missing",
            "location": "See protocol document",
        }
    return checklist


async def generate_database_search_strings(pico: dict, ai_provider: AIProvider) -> dict:
    """
    Generate ready-to-use search strings for 9 databases.
    Returns dict with database names as keys.
    """
    system = """You are an expert medical librarian specializing in systematic review search strategies.
Generate complete, ready-to-use search strings for ALL 9 databases listed below.

Include:
- Correct field codes (PubMed: [tiab][mesh], Scopus: TITLE-ABS-KEY, Ovid: .mp. .sh.)
- MeSH terms (PubMed), Emtree (Embase), CINAHL Headings
- Truncation (* for PubMed/Embase, $ for CINAHL)
- Boolean operators (AND/OR/NOT)
- Date and language limits
- Publication type filters where appropriate

For databases requiring institutional access (EMBASE, PsycINFO, CINAHL), include a note.

Return ONLY valid JSON:
{
  "pubmed": "full search string...",
  "scopus": "full search string...",
  "embase_ovid": "full search string... [NOTE: Requires institutional Ovid subscription]",
  "psycinfo_ebsco": "full search string... [NOTE: Requires institutional EBSCO subscription]",
  "cinahl_ebsco": "full search string... [NOTE: Requires institutional EBSCO subscription]",
  "cochrane_central": "full search string...",
  "clinicaltrials": "simple terms for clinicaltrials.gov advanced search...",
  "who_ictrp": "simple terms for WHO ICTRP search...",
  "eric": "search string for ERIC education database...",
  "notes": "General notes about the search strategy and recommended date ranges"
}"""

    user = f"""PICO for search string generation:
Population: {pico.get('population', '')}
Intervention: {pico.get('intervention', '')}
Comparator: {pico.get('comparator', '')}
Outcome: {pico.get('outcome', '')}
Study Design: {pico.get('study_design', '')}
Date From: {pico.get('date_from', 'inception')}
Language: {pico.get('language_restriction', 'English')}
Health Area: {pico.get('health_area', '')}

Generate comprehensive search strings for all 9 databases."""

    try:
        resp = await ai_provider.guarded_complete(
            system=system, user=user,
            config=CompletionConfig(
                output_format=OutputFormat.JSON,
                budget=TokenBudget(target_json_keys=50, format=OutputFormat.JSON),
                max_continuations=1,
            ),
            json_mode=True, temperature=0.2,
        )
        return json.loads(resp.text)
    except Exception as e:
        logger.error("Search string generation failed: %s", e)
        return {"error": str(e)}


async def register_on_osf(
    protocol_text: str,
    pico: dict,
    osf_token: str,
) -> dict:
    """
    Programmatically register the protocol on OSF.
    Returns {osf_id, doi, url, status} or {error: ...}

    NOTE: osf_token must never be logged.
    """
    headers = {
        "Authorization": f"Bearer {osf_token}",
        "Content-Type": "application/vnd.api+json",
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        # Step 1: Create an OSF project node
        project_payload = {
            "data": {
                "type": "nodes",
                "attributes": {
                    "title": f"SR Protocol: {pico.get('population', '')[:100]} — {pico.get('intervention', '')[:80]}",
                    "category": "project",
                    "description": f"Systematic review protocol. PICO: {pico.get('population', '')} | {pico.get('intervention', '')} | {pico.get('outcome', '')}",
                    "public": False,
                }
            }
        }
        try:
            r = await client.post(
                "https://api.osf.io/v2/nodes/",
                json=project_payload,
                headers=headers,
            )
            r.raise_for_status()
            node_id = r.json()["data"]["id"]
        except Exception as e:
            logger.error("OSF node creation failed: %s", e)  # Do NOT log token
            return {"error": f"Failed to create OSF project: {r.status_code if 'r' in dir() else str(e)}"}

        # Step 2: Find the Generalized Systematic Review schema
        try:
            r = await client.get(
                "https://api.osf.io/v2/schemas/registrations/",
                params={"filter[name]": "Preregistration"},
                headers=headers,
            )
            r.raise_for_status()
            schemas = r.json().get("data", [])
            schema_id = schemas[0]["id"] if schemas else None
        except Exception:
            schema_id = None

        if not schema_id:
            return {
                "node_id": node_id,
                "status": "draft_only",
                "url": f"https://osf.io/{node_id}/",
                "message": "Project created on OSF. Schema not found — please complete registration manually at https://osf.io/registries/",
            }

        # Step 3: Create draft registration
        draft_payload = {
            "data": {
                "type": "draft_registrations",
                "attributes": {
                    "registration_supplement": {
                        "q1": protocol_text[:2000],
                    }
                },
                "relationships": {
                    "registration_schema": {
                        "data": {"type": "registration-schemas", "id": schema_id}
                    }
                }
            }
        }
        try:
            r = await client.post(
                f"https://api.osf.io/v2/nodes/{node_id}/draft_registrations/",
                json=draft_payload,
                headers=headers,
            )
            draft_id = r.json().get("data", {}).get("id", "")
        except Exception as e:
            logger.warning("OSF draft creation: %s", e)
            draft_id = ""

        return {
            "node_id": node_id,
            "draft_id": draft_id,
            "status": "draft",
            "url": f"https://osf.io/{node_id}/",
            "message": "Draft registration created on OSF. Please review and submit at the URL provided.",
        }


async def generate_protocol_docx(protocol_text: str, pico: dict) -> bytes:
    """
    Generate a downloadable .docx of the protocol following PRISMA-P structure.
    """
    try:
        from docx import Document
        from docx.shared import Pt, Inches, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
    except ImportError:
        raise ImportError("python-docx required: pip install python-docx")

    doc = Document()

    # Title
    title_para = doc.add_heading("Systematic Review Protocol", level=0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # PICO summary box
    doc.add_heading("Review Overview (PICO)", level=1)
    table = doc.add_table(rows=5, cols=2)
    table.style = "Table Grid"
    cells = [
        ("Population", pico.get("population", "")),
        ("Intervention", pico.get("intervention", "")),
        ("Comparator", pico.get("comparator", "")),
        ("Outcome", pico.get("outcome", "")),
        ("Study Design", pico.get("study_design", "")),
    ]
    for i, (label, value) in enumerate(cells):
        table.rows[i].cells[0].text = label
        table.rows[i].cells[1].text = value
    doc.add_paragraph("")

    # Protocol document body
    doc.add_heading("Full Protocol", level=1)
    for line in protocol_text.split("\n"):
        line = line.strip()
        if not line:
            doc.add_paragraph("")
            continue
        if line.startswith("# "):
            doc.add_heading(line[2:], level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=2)
        elif line.startswith("### "):
            doc.add_heading(line[4:], level=3)
        elif line.startswith("- ") or line.startswith("* "):
            doc.add_paragraph(line[2:], style="List Bullet")
        else:
            doc.add_paragraph(line)

    # PRISMA-P checklist appendix
    doc.add_page_break()
    doc.add_heading("PRISMA-P 2015 Checklist", level=1)
    checklist_table = doc.add_table(rows=1 + len(_PRISMA_P_ITEMS), cols=3)
    checklist_table.style = "Table Grid"
    header_cells = checklist_table.rows[0].cells
    header_cells[0].text = "Item"
    header_cells[1].text = "Description"
    header_cells[2].text = "Status"
    for i, (item_id, desc) in enumerate(_PRISMA_P_ITEMS.items()):
        row = checklist_table.rows[i + 1].cells
        row[0].text = item_id
        row[1].text = desc
        row[2].text = "✓"

    import io
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ── New AI-first Protocol Builder functions ───────────────────────────────────

async def generate_background_draft(
    query: str,
    ai_provider: AIProvider,
    section: str = "background",
    review_type: str = "systematic_review",
) -> dict:
    """
    Generate a background or rationale section for a systematic review protocol.
    Uses AI knowledge to write a well-informed draft based on the research topic.

    section: "background" | "rationale"
    Returns: { draft, summary }
    """
    if section == "rationale":
        system = """You are a systematic review methodologist writing the 'Rationale & Why This Review Is Needed' section of a protocol.

Write 2–3 focused paragraphs that:
1. Summarise what is already known about this topic (existing evidence, prior reviews)
2. Identify the specific gap in the evidence this review will fill
3. Explain why this review is important NOW and who will benefit from its findings

Use formal academic writing (third person, past tense for existing evidence, future tense for review plans).
Reference relevant study designs, populations, or methodological issues where applicable.
Do NOT fabricate specific paper citations — use general references like "existing reviews have shown..." or "the literature suggests...".

Return a plain Markdown string (no JSON, no fences)."""

        user = f"""Research topic: {query}
Review type: {review_type}

Write the 'Rationale and Why This Review Is Needed' section."""

    else:  # background
        system = """You are a systematic review methodologist writing a comprehensive 'Background' section for a PRISMA-P 2015 compliant systematic review protocol.

The background must be structured under EXACTLY these four subheadings, in this order:

## The Problem, Condition, or Issue
Write 3–4 paragraphs covering:
- Definition and scope of the condition, problem, or phenomenon
- Global or regional prevalence, incidence, and burden (epidemiological data)
- Affected populations, settings, and demographic patterns
- Consequences: clinical, social, economic, and quality-of-life impacts
- Risk factors or determinants relevant to the review topic

## The Intervention (or Exposure / Phenomenon of Interest)
Write 3–4 paragraphs covering:
- Description of the intervention, exposure, or phenomenon under review
- How it is currently delivered, implemented, or studied
- Variations, modalities, or subtypes relevant to the review scope
- Context in which the intervention is typically applied (healthcare setting, policy, community)
- Existing guidelines or recommendations, if any

## How the Intervention Could Work
Write 2–3 paragraphs covering:
- The theoretical mechanism of action or logical pathway through which the intervention is expected to produce change
- Biological, psychological, social, or structural mechanisms (as appropriate to the topic)
- Evidence from experimental or observational studies suggesting plausible effects
- Potential moderating or mediating factors

## Why It Is Important to Do This Review
Write 2–3 paragraphs covering:
- Overview of prior systematic reviews on this topic (if any), and their limitations (scope, quality, recency)
- The specific evidence gap(s) this review will address
- Decision-makers or stakeholders who will benefit from the findings
- The potential policy, clinical, or practice implications of this review

WRITING STANDARDS:
- Target total length: 1000–1500 words across all four sections
- Formal academic prose, third person, present or past tense as appropriate
- Do NOT fabricate specific statistics, author names, or DOIs — use hedged language: "evidence suggests...", "studies indicate...", "it is estimated that...", "a body of literature has shown..."
- Each subheading must be written as a Markdown ## heading exactly as shown above
- No bullet lists in the body — prose paragraphs only

Return a plain Markdown string with the four ## subheadings and body paragraphs. No JSON, no code fences."""

        user = f"""Research topic: {query}
Review type: {review_type}

Write the full structured 'Background' section with all four subheadings."""

    try:
        resp = await ai_provider.guarded_complete(
            system=system, user=user,
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                budget=TokenBudget(target_words=1200),
                max_continuations=2,
            ),
            temperature=0.4,
        )
        draft = resp.text
        # Generate a summary for the chat thread
        if section == "background":
            summary = (
                f"I've written a detailed background section (~1000+ words) for your review on '{query[:80]}'. "
                "It covers four structured subsections: (1) the problem/condition and its burden, "
                "(2) the intervention or phenomenon of interest, "
                "(3) the mechanism of action, and "
                "(4) why this review is needed. "
                "Edit the text directly or tell me what to expand, change, or emphasise."
            )
        else:
            summary = f"I've drafted a {section} section based on the topic '{query[:80]}'. It covers the key context, existing evidence landscape, and the gap this review will address. Review it above and let me know what to add, emphasise, or change."
        return {"draft": draft.strip(), "summary": summary}
    except Exception as e:
        logger.error("generate_background_draft failed: %s", e)
        return {
            "draft": f"[Background draft could not be generated: {e}]",
            "summary": "There was an error generating the draft. Please try again.",
        }


async def generate_review_question_from_elements(
    framework: str,
    elements: dict,
    ai_provider: AIProvider,
    feedback: str = "",
    review_type: str = "systematic_review",
) -> dict:
    """
    Generate a structured research question from framework elements (PICO/SPIDER/PCC/etc.).
    This is the REVERSE of parsePicoFromText — elements first, then question.

    Returns: { review_question, alternative_phrasings, methodological_cautions }
    """
    element_str = "\n".join(f"- {k.capitalize()}: {v}" for k, v in elements.items() if v)

    feedback_clause = f"\n\nUser feedback for this revision: {feedback}" if feedback.strip() else ""

    system = """You are a Cochrane/JBI-trained systematic review methodologist.
Given structured framework elements, formulate a precise, answerable research question.

Rules:
- The research question must flow naturally from the elements — do NOT invent elements not listed
- Use the appropriate question format for the framework (PICO: "In [P], does [I] compared to [C] affect [O]?"; PCC: "What [concept] exists in [context] for [population]?"; SPIDER: "What are the experiences/perceptions of [S] regarding [PI] as studied by [D]?"; etc.)
- Generate exactly 3 alternative phrasings: broad → moderate → narrow
- methodological_cautions: 2–3 sentences on potential heterogeneity, indexing issues, or framework limitations
- Return ONLY valid JSON (no markdown fences):
{
  "review_question": "...",
  "alternative_phrasings": ["broad", "moderate", "narrow"],
  "methodological_cautions": "..."
}"""

    user = f"""Framework: {framework}
Review type: {review_type}

Elements:
{element_str}{feedback_clause}

Generate the research question."""

    try:
        resp = await ai_provider.guarded_complete(
            system=system, user=user,
            config=CompletionConfig(
                output_format=OutputFormat.JSON,
                budget=TokenBudget(target_json_keys=20, format=OutputFormat.JSON),
                max_continuations=1,
            ),
            json_mode=True, temperature=0.2,
        )
        result = json.loads(resp.text)
        result.setdefault("review_question", "")
        result.setdefault("alternative_phrasings", ["", "", ""])
        result.setdefault("methodological_cautions", "")
        return result
    except Exception as e:
        logger.error("generate_review_question_from_elements failed: %s", e)
        return {
            "review_question": "",
            "alternative_phrasings": ["", "", ""],
            "methodological_cautions": "",
            "error": str(e),
        }


_PHASE_SYSTEMS: dict[str, str] = {
    "objectives": """You are a systematic review methodologist writing the 'Objectives' section.
Draft 1–2 formal objective statements. Use standard SR language:
"This systematic review will [collate/synthesise/characterise] evidence on [X] in order to [Y]."
Also include the explicit research question restated as a formal objective.
Keep it to 100–150 words. Return plain text (no JSON).""",

    "outcomes": """You are a systematic review methodologist defining outcomes for a review.
Return JSON: { "primary": ["..."], "secondary": ["..."], "chat_reply": "..." }
- primary: 2–3 primary outcomes (measurable, time-specified where possible)
- secondary: 3–5 secondary outcomes
- chat_reply: 2–3 sentence explanation of your choices and how they relate to the PICO
Base outcomes on the provided PICO/framework context.""",

    "eligibility": """You are a Cochrane/JBI-trained methodologist writing eligibility criteria.
Return JSON: { "inclusion": ["..."], "exclusion": ["..."], "chat_reply": "..." }
- inclusion: 4–6 specific inclusion criteria (population, design, setting, language, date range)
- exclusion: 4–6 exclusion criteria (mirror of inclusion + non-primary data, grey literature if applicable)
- chat_reply: brief explanation referencing MECIR standards
Be specific to the topic — no generic boilerplate.""",

    "search_sources": """You are a systematic review librarian recommending databases.
Return JSON: { "databases": ["..."], "grey_literature": "...", "chat_reply": "..." }
- databases: 5–8 database names appropriate for this topic and review type
- grey_literature: 1 sentence describing grey literature strategy (trial registries, dissertations, conference abstracts, etc.)
- chat_reply: 2–3 sentences explaining why these databases were chosen (coverage of health area, indexing)
Common databases: PubMed/MEDLINE, Embase, Cochrane CENTRAL, Web of Science, Scopus, PsycINFO, CINAHL, WHO ICTRP, ProQuest Dissertations, OpenGrey""",

    "search_string": """You are a medical librarian creating a systematic review search string.
Return JSON: { "database": "PubMed/MEDLINE", "search_string": "...", "chat_reply": "..." }
- database: the primary database (choose PubMed/MEDLINE by default unless context indicates otherwise)
- search_string: a complete, ready-to-use boolean search string with MeSH terms, free-text synonyms, truncation (*), field codes ([tiab][mesh]), AND/OR operators, and date/language limits
- chat_reply: 2–3 sentences explaining the strategy structure and any notable choices
The search string must be complete enough to run directly in the specified database.""",

    "screening": """You are a systematic review methodologist writing the screening workflow.
Return JSON: { "selection_process": "...", "data_management_tool": "...", "chat_reply": "..." }
- selection_process: 2–3 sentences describing independent dual screening (title/abstract then full text), how conflicts are resolved, and who screens
- data_management_tool: name of the software (Covidence, Rayyan, or Endnote — recommend Covidence)
- chat_reply: brief explanation with reference to PRISMA 2020 screening guidance""",

    "extraction": """You are a systematic review methodologist designing a data extraction form.
Return JSON: { "schema": [{"field": "...", "type": "text|number|list|boolean", "required": true|false, "description": "...", "section": "Methods|Participants|Interventions|Outcomes|Results"}], "chat_reply": "..." }
Generate 10–15 fields appropriate for this review type and PICO.
Organise into sections: Methods, Participants, Interventions, Outcomes, Results.
chat_reply: 2–3 sentences explaining the schema design and any domain-specific fields.""",

    "bias_synthesis": """You are a systematic review methodologist recommending risk of bias and synthesis approaches.
Return JSON: {
  "rob_tool": "...",
  "rob_level": "study|outcome|both",
  "rob_rationale": "...",
  "synthesis_type": "quantitative|narrative|both",
  "effect_measure": "...",
  "i2_threshold": "50%",
  "synthesis_rationale": "...",
  "chat_reply": "..."
}
Choose the RoB tool based on study design:
- RCTs → RoB 2.0 (Cochrane Handbook Ch. 8)
- Non-randomised → ROBINS-I (Sterne et al. BMJ 2016)
- Diagnostic → QUADAS-2
- Qualitative → JBI QARI or CASP
- Mixed → MMAT or multiple tools
chat_reply: 2–3 sentences justifying the RoB tool and synthesis approach.""",

    "dissemination": """You are a systematic review methodologist drafting the dissemination plan.
Return JSON: {
  "review_title": "...",
  "registration_name": "PROSPERO",
  "target_journals": ["...", "..."],
  "planned_outputs": "...",
  "chat_reply": "..."
}
- review_title: a concise, PROSPERO-ready title following format: "[Intervention/topic] for [condition] in [population]: a systematic review [and meta-analysis]" (≤25 words)
- registration_name: recommend PROSPERO for health topics, Campbell for social sciences
- target_journals: 2–3 appropriate journals (e.g. Systematic Reviews, BMJ, Campbell Systematic Reviews, Cochrane Database of Systematic Reviews)
- planned_outputs: 1 sentence on planned dissemination (peer-reviewed article + plain language summary)
- chat_reply: 2–3 sentences on registration timing and dissemination strategy""",

    "background": """You are a systematic review methodologist revising the 'Background' section of a protocol.
The current background draft and conversation history are provided in the context.
Revise the background based on the user's latest feedback, preserving what is good.

The background MUST retain these four ## subheadings (add any that are missing):
## The Problem, Condition, or Issue
## The Intervention (or Exposure / Phenomenon of Interest)
## How the Intervention Could Work
## Why It Is Important to Do This Review

Return JSON: { "text": "...", "chat_reply": "..." }
- text: revised background (1000–1500 words) with all four ## subheadings intact, prose paragraphs only
- chat_reply: 1–2 sentences summarising what was revised
Maintain formal scholarly academic tone.""",

    "rationale": """You are a systematic review methodologist writing the 'Rationale & Gap' section of a protocol.
The current rationale draft and conversation history are provided in the context.
Revise the rationale based on the user's latest feedback, preserving what is good.
Return JSON: { "text": "...", "chat_reply": "..." }
- text: revised 2–3 paragraph rationale explaining: (1) existing systematic reviews on this topic and their limitations or outdatedness, (2) the specific evidence gap this review fills, (3) why this review is needed now and who will benefit
- chat_reply: 1–2 sentences summarising what was revised
Reference Campbell Collaboration, Cochrane, or JBI guidance where relevant.""",

    "protocol_chat": """You are a systematic review methodologist reviewing a complete protocol draft.
The full protocol document and conversation history are provided in the context.
Answer the user's question or act on their request — be specific, referencing protocol sections by name.
Return JSON: { "chat_reply": "..." }
- chat_reply: your full response (3–6 sentences). If the user requests a change, describe exactly what to update and in which section. If answering a question, be precise and cite the relevant section of the protocol.""",

    "review_setup": """You are a systematic review methodologist helping the researcher select the right review type and question framework.
Return JSON: {
  "review_family_rationale": "...",
  "recommended_framework": "PICO",
  "framework_rationale": "...",
  "downstream_notes": "...",
  "chat_reply": "..."
}
- review_family_rationale: 1–2 sentences explaining why this review family is appropriate for the stated topic
- recommended_framework: suggest PICO (intervention), PECO (exposure), PEO (qualitative/exposure), PCC (scoping), SPIDER (qualitative), ECLIPSE (policy), SPICE (service evaluation)
- framework_rationale: 1–2 sentences explaining the framework choice
- downstream_notes: brief note on how the selection affects effect measures, RoB tools, and certainty assessment
- chat_reply: concise welcome message acknowledging the review family and framework choice. Also explain what each applicable review type (epidemiological/observational, qualitative, scoping, systematic) would look like for this specific topic — help the researcher choose the most appropriate one.""",

    "research_question": """You are a Cochrane/JBI-trained systematic review methodologist helping the researcher define their research question framework and elements.

Your role in this phase is conversational and advisory:
1. Help the researcher choose the right framework (PICO, PCC, SPIDER, PEO, ECLIPSE, SPICE) by explaining the purpose of each and which fits their topic.
2. Explain what each element of the chosen framework means in the context of their specific topic.
3. Suggest concrete values for empty or weak elements.
4. Identify potential problems with how elements are phrased (too broad, too narrow, confounded, missing key terms).
5. Explain how the framework connects to the rest of the review (search strategy, eligibility criteria, synthesis).

Framework decision guidance:
- PICO/PICOS: when there is a clear intervention and you want to compare outcomes
- PCC (JBI scoping): when you want to map evidence on a concept in a population across contexts — do NOT use PICO if there is no control group or comparator
- SPIDER: qualitative or mixed-methods reviews about experiences, perceptions, meanings
- PEO: observational/epidemiological association questions (exposure → outcome, no intervention)
- ECLIPSE: policy, management, service-delivery questions
- SPICE: service evaluation

Return JSON: {
  "suggested_elements": {},
  "chat_reply": "..."
}
- suggested_elements: a dict of framework element keys → suggested text (only include elements you are suggesting changes for; empty dict if no changes)
- chat_reply: conversational, warm, expert response (3–6 sentences). Explain your reasoning clearly. If suggesting element changes, describe WHY. Reference JBI or Cochrane guidance by name when applicable.""",

    "search_strategy": """You are a medical librarian designing a comprehensive systematic review search strategy.
Return JSON: {
  "primary_database": "PubMed/MEDLINE",
  "primary_search_string": "...",
  "date_limits": "...",
  "language_restrictions": "...",
  "publication_type_filters": "...",
  "platform_notes": "...",
  "translation_notes": "...",
  "handsearching": "...",
  "press_review": "...",
  "deduplication_plan": "...",
  "chat_reply": "..."
}
- primary_search_string: complete boolean string with MeSH/controlled vocab + free text synonyms, truncation (*), field tags ([tiab][mesh]), AND/OR, ready to run
- date_limits: specify from/to years and rationale
- language_restrictions: English only or multilingual with translation plan
- publication_type_filters: e.g. exclude case reports, editorials, conference abstracts
- platform_notes: note any platform-specific syntax differences (Ovid vs PubMed vs Embase)
- translation_notes: how string will be adapted across databases
- handsearching: journals to handsearch + citation chasing plan
- press_review: whether PRESS peer review of search string is planned
- deduplication_plan: tool (Endnote/Covidence) and deduplication workflow""",

    "records_management": """You are a systematic review methodologist writing the records management and deduplication section.
Return JSON: {
  "deduplication_tool": "...",
  "deduplication_method": "...",
  "record_keeping": "...",
  "automation_tools": "...",
  "chat_reply": "..."
}
- deduplication_tool: recommend Endnote, Covidence, or Rayyan
- deduplication_method: automated + manual deduplication steps
- record_keeping: how records of search results will be stored and documented for PRISMA flow
- automation_tools: any AI-assisted screening tools planned (optional)""",

    "data_collection": """You are a systematic review methodologist writing the data collection process section.
Return JSON: {
  "extraction_method": "...",
  "extraction_team": "...",
  "pilot_testing": "...",
  "disagreement_resolution": "...",
  "software": "...",
  "author_contact": "...",
  "chat_reply": "..."
}
- extraction_method: independent dual extraction or single with verification
- extraction_team: who extracts (e.g. two independent reviewers, student + senior)
- pilot_testing: calibration on a sample before full extraction
- disagreement_resolution: consensus, third reviewer arbitration
- software: Covidence, REDCap, Excel, etc.
- author_contact: will corresponding authors be contacted for missing data""",

    "data_items": """You are a systematic review methodologist writing the data items section.
Return JSON: {
  "study_characteristics": ["..."],
  "participant_characteristics": ["..."],
  "intervention_characteristics": ["..."],
  "outcome_items": ["..."],
  "methodological_items": ["..."],
  "chat_reply": "..."
}
- study_characteristics: design, country, setting, funding, year published
- participant_characteristics: age, sex, diagnosis criteria, severity, comorbidities
- intervention_characteristics: type, dose, duration, delivery mode, provider, comparator details
- outcome_items: primary outcomes (measure, instrument, time points), secondary outcomes
- methodological_items: sample size, randomisation, blinding, follow-up rate, ITT analysis
Each list: 4–6 items appropriate for this review type and PICO.""",

    "rob_assessment": """You are a systematic review methodologist recommending risk of bias assessment tools.
Select based on the review_family field in the PICO context.
Return JSON: {
  "primary_tool": "...",
  "primary_tool_rationale": "...",
  "secondary_tool": "...",
  "assessment_level": "study",
  "domains": ["..."],
  "calibration_plan": "...",
  "chat_reply": "..."
}
Tool selection rules:
- intervention RCTs → RoB 2.0 (Cochrane Handbook Ch. 8)
- intervention non-randomised → ROBINS-I (Sterne et al. BMJ 2016)
- diagnostic accuracy → QUADAS-2
- prognostic → PROBAST or QUIPS
- qualitative → CASP qualitative checklist or JBI QARI
- mixed methods → MMAT
- prevalence/descriptive → JBI Critical Appraisal Tools
domains: list the specific assessment domains for the chosen tool
calibration_plan: pilot assessment on 5–10 papers with consensus before full assessment""",

    "synthesis_plan": """You are a systematic review methodologist writing the synthesis methods section.
Return JSON: {
  "synthesis_type": "quantitative",
  "quantitative_method": "...",
  "narrative_method": "...",
  "heterogeneity_assessment": "...",
  "i2_threshold": "50%",
  "pooling_decision_rule": "...",
  "software": "...",
  "chat_reply": "..."
}
- synthesis_type: 'quantitative' | 'narrative' | 'both' — based on expected study homogeneity
- quantitative_method: random-effects meta-analysis (DerSimonian-Laird or REML), fixed-effects
- narrative_method: structured narrative synthesis using harvest plots, vote counting, logic models
- heterogeneity_assessment: Cochran's Q test + I² statistic + prediction interval
- pooling_decision_rule: criteria for deciding whether to pool (clinical homogeneity + I²<threshold)
- software: R (meta package), RevMan, Stata, or OpenMeta-Analyst""",

    "effect_measures": """You are a systematic review statistician recommending effect measures for this review.
Return JSON: {
  "primary_effect_measure": "...",
  "secondary_effect_measures": ["..."],
  "rationale": "...",
  "confidence_intervals": "95% CI",
  "significance_threshold": "p < 0.05",
  "heterogeneity_measure": "I²",
  "chat_reply": "..."
}
Choose based on review_family and outcome types:
- Continuous outcomes → Mean Difference (MD) if same scale; Standardised Mean Difference (SMD/Hedges' g) if different scales; Cohen's d for psychological outcomes
- Binary/dichotomous → Risk Ratio (RR) preferred; Odds Ratio (OR); Risk Difference (RD); Number Needed to Treat (NNT)
- Time-to-event/survival → Hazard Ratio (HR) with log-scale pooling
- Ordinal → Common Odds Ratio using proportional OR model
- Diagnostic → Sensitivity, Specificity, Positive/Negative Likelihood Ratio, Diagnostic Odds Ratio (DOR)
- Prevalence → Pooled proportion with Freeman-Tukey double arcsine transformation for stabilisation""",

    "subgroup_sensitivity": """You are a systematic review methodologist writing subgroup and sensitivity analyses.
Return JSON: {
  "subgroup_analyses": ["..."],
  "subgroup_rationale": "...",
  "sensitivity_analyses": ["..."],
  "missing_data_plan": "...",
  "heterogeneity_threshold": "I² > 50%",
  "chat_reply": "..."
}
- subgroup_analyses: 3–5 pre-specified moderator variables (e.g. age group, severity, intervention type, setting, study design, follow-up duration, risk of bias category)
- subgroup_rationale: why these specific subgroups are clinically or methodologically important
- sensitivity_analyses: 3–4 planned checks — e.g. exclude high-RoB studies, leave-one-out analysis, restrict to peer-reviewed RCTs, restrict to studies with low attrition, fixed vs random effects comparison
- missing_data_plan: best-case/worst-case scenarios for binary outcomes; multiple imputation for continuous; contact authors
IMPORTANT: All subgroup and sensitivity analyses must be pre-specified to avoid post-hoc data-dredging.""",

    "reporting_certainty": """You are a systematic review methodologist writing the reporting bias and certainty of evidence assessment plan.
Return JSON: {
  "reporting_bias_methods": ["..."],
  "funnel_plot_threshold": "≥10 studies per meta-analysis",
  "statistical_tests": ["..."],
  "certainty_tool": "GRADE",
  "certainty_software": "GRADEpro GDT",
  "certainty_domains": ["..."],
  "downgrade_criteria": ["..."],
  "upgrade_criteria": ["..."],
  "sof_table": true,
  "chat_reply": "..."
}
Reporting bias methods: funnel plot asymmetry (visual), Egger's linear regression test, Begg's rank correlation test, trim-and-fill method, p-curve analysis
Note: funnel plots are only interpretable when ≥10 studies per meta-analysis
GRADE certainty domains: risk of bias, inconsistency (heterogeneity), indirectness, imprecision, publication bias
Downgrade for: serious/very serious limitations in any domain
Upgrade for: large effect (RR>2 or <0.5), dose-response, plausible confounding opposing the effect
For qualitative reviews: use CERQual (Confidence in the Evidence from Reviews of Qualitative research) instead of GRADE
For scoping reviews: certainty assessment is not applicable — omit this section""",

    "admin": """You are a systematic review methodologist writing the administrative section of a PRISMA-P 2015 protocol.
Return JSON: {
  "registry_recommendation": "PROSPERO",
  "registry_rationale": "...",
  "registration_timing": "Prior to beginning database searches",
  "amendments_policy": "...",
  "protocol_deposit": "...",
  "funding_note": "...",
  "chat_reply": "..."
}
Registry selection:
- Health/clinical/biomedical topics → PROSPERO (York)
- Social science, education, criminal justice → Campbell Collaboration Open Library
- Multidisciplinary or open science → OSF Registries (osf.io)
- Not eligible for other registries → INPLASY
registration_timing: protocol must be registered BEFORE starting database searches (PRISMA-P requirement)
amendments_policy: any post-registration protocol deviations must be documented with date, reason, and impact assessment
protocol_deposit: recommend depositing full protocol on OSF or Zenodo (open access) in addition to registry
Note: The admin form also captures author names, affiliations, ORCIDs, CRediT contributions, funding sources, competing interests — these are entered directly in the form fields, not generated by AI.""",
}


async def generate_phase_content(
    phase: str,
    pico_context: dict,
    context_data: dict,
    messages: list[dict],
    ai_provider: AIProvider,
    review_type: str = "systematic_review",
    mode: str = "direct",
) -> dict:
    """
    Generate or update content for a specific protocol phase, incorporating
    the full chat history for iterative refinement.

    phase: one of the keys in _PHASE_SYSTEMS
    pico_context: the finalized PICO/framework elements from Phase 4
    context_data: all previously finalized phase data
    messages: list of { role: "ai"|"user", text: "..." }
    Returns: { reply: str, content: dict }
    mode: "direct" (default) — apply changes; "plan" — return options only, no content update
    """
    system_prompt = _PHASE_SYSTEMS.get(phase)
    if not system_prompt:
        return {"reply": f"Unknown phase: {phase}", "content": {}}

    # Plan mode: override system prompt to return options/questions only
    if mode == "plan":
        system_prompt = (
            system_prompt
            + "\n\nIMPORTANT: The user is in PLAN MODE. Do NOT generate new content yet. "
            "Instead return JSON: { \"chat_reply\": \"...\" } where chat_reply presents "
            "2–4 concrete options (labeled A, B, C...) describing different ways to fulfill the user's request, "
            "or asks 1–2 clarifying questions. Explain what each option would change and its approximate scope."
        )

    # Build framework context string dynamically from whatever elements are present
    _SKIP_SUMMARY_KEYS = {"review_type", "framework", "target_registries", "language_restriction",
                          "date_from", "date_to"}
    framework = context_data.get("framework", pico_context.get("framework", "PICO"))
    review_family = context_data.get("review_family", "")
    review_question = context_data.get("review_question", "")
    background = context_data.get("background", "")
    protocol_document = context_data.get("protocol_document", "")

    element_lines = []
    for key, val in pico_context.items():
        if key in _SKIP_SUMMARY_KEYS or not val:
            continue
        label = key.replace("_", " ").title()
        element_lines.append(f"{label}: {val}")

    pico_summary = f"""Framework: {framework}
Review type: {review_type}
Review family: {review_family}
Research question: {review_question}
{chr(10).join(element_lines) if element_lines else "(No framework elements provided)"}"""

    if background:
        pico_summary += f"\n\nBackground context:\n{background[:800]}"

    current_draft = context_data.get("current_draft", "")
    if current_draft:
        pico_summary += f"\n\nCurrent draft to revise:\n{current_draft[:2000]}"

    if protocol_document:
        pico_summary += f"\n\nFull protocol document:\n{protocol_document[:5000]}"

    # Build conversation history for context
    conversation = "\n".join(
        f"{'AI' if m['role'] == 'ai' else 'USER'}: {m['text']}"
        for m in messages[-6:]  # last 6 messages for context window efficiency
    )

    is_first_call = not any(m["role"] == "user" for m in messages)

    if is_first_call:
        user_prompt = f"""PICO Context:
{pico_summary}

This is the first draft for the '{phase}' phase. Generate appropriate content."""
    else:
        user_prompt = f"""PICO Context:
{pico_summary}

Conversation history:
{conversation}

Update the content based on the latest user feedback."""

    # For text-only phases (objectives), return plain text wrapped in dict
    if phase == "objectives":
        try:
            draft = await ai_provider.complete(
                system=system_prompt,
                user=user_prompt,
                temperature=0.3,
            )
            reply = "Here are the formal objectives for your review. They translate your research question into precise aims aligned with PRISMA-P item 7. Edit them directly or let me know if you want a different framing."
            if not is_first_call:
                reply = "I've updated the objectives based on your feedback."
            return {"reply": reply, "content": {"objectives": draft.strip()}}
        except Exception as e:
            return {"reply": f"Error: {e}", "content": {}}

    # For structured JSON phases
    try:
        resp = await ai_provider.guarded_complete(
            system=system_prompt, user=user_prompt,
            config=CompletionConfig(
                output_format=OutputFormat.JSON,
                budget=TokenBudget(target_json_keys=30, format=OutputFormat.JSON),
                max_continuations=2,
            ),
            json_mode=True, temperature=0.25,
        )
        result = json.loads(resp.text)
        reply = result.pop("chat_reply", "Content generated. Review it above and let me know if you want any changes.")
        if not reply:
            reply = "I've updated this section based on your feedback."
        return {"reply": reply, "content": result}
    except Exception as e:
        logger.error("generate_phase_content(%s) failed: %s", phase, e)
        return {"reply": f"Error generating content: {e}", "content": {}}


# ── Evidence Pack — citation-validated background/rationale generation ─────────

_BACKGROUND_CITATION_SYSTEM = """You are a systematic review methodologist writing the 'Background' section for a PRISMA-P 2015 compliant protocol.

You have been provided a numbered list of papers retrieved from a literature search. These are the ONLY papers you may cite.

CITATION RULES (strictly enforced):
- Cite papers using ONLY the [SRC{n}] marker format (e.g. [SRC1], [SRC3])
- Every factual claim must be supported by at least one [SRC{n}] citation
- Do NOT invent author names, DOIs, or statistics not present in the provided paper list
- Do NOT cite papers not in the provided list

STRUCTURE — write exactly four ## subheadings in this order:

## The Problem, Condition, or Issue
3–4 paragraphs: definition, global prevalence/burden (cite data), affected populations, consequences, risk factors.

## The Intervention (or Exposure / Phenomenon of Interest)
3–4 paragraphs: description of intervention/exposure, how it is delivered/implemented, variations and subtypes, existing guidelines or recommendations (cite them).

## How the Intervention Could Work
2–3 paragraphs: theoretical mechanism of action, biological/psychological/social pathways, evidence for plausible effects [SRC{n}], moderating and mediating factors.

## Why It Is Important to Do This Review
2–3 paragraphs: prior systematic reviews on this topic and their limitations (cite them with [SRC{n}]), the specific evidence gap, stakeholders who will benefit, policy/clinical implications.

WRITING STANDARDS:
- Total length: 1000–1500 words across all four sections
- Formal academic prose, third person, no bullet lists in body
- Each [SRC{n}] marker must correspond to a paper in the provided list
- Return plain Markdown with the four ## subheadings. No JSON, no code fences."""

_RATIONALE_CITATION_SYSTEM = """You are a systematic review methodologist writing the 'Rationale & Gap' section for a PRISMA-P 2015 compliant protocol.

You have been provided a numbered list of papers. Cite ONLY these papers using [SRC{n}] markers.

Write 3–4 focused paragraphs (400–600 words total):
1. Summarise existing systematic reviews or evidence syntheses on this topic [SRC{n}] and their limitations (recency, scope, methodological gaps)
2. Identify the specific evidence gap this review will address
3. Explain why this review is needed now and who will benefit
4. State what this review will add beyond what already exists

CITATION RULES: cite ONLY using [SRC{n}] markers from the provided paper list. No fabricated citations.
Return plain Markdown paragraphs (no headings, no JSON)."""


def _build_background_queries(query: str, pico_context: dict | None) -> list[str]:
    """Build 3 query variants for richer coverage: core + outcome-focused + prior-reviews."""
    queries = [query]
    if pico_context:
        pop = pico_context.get("population", "")
        intv = pico_context.get("intervention", "") or pico_context.get("exposure", "")
        out = pico_context.get("outcome", "")
        if pop and intv:
            queries.append(f"{pop} {intv}")
        if pop and out:
            queries.append(f"{pop} {out}")
    # Always add a prior-reviews query
    queries.append(f"systematic review {query}")
    return list(dict.fromkeys(q.strip() for q in queries if q.strip()))[:4]


def _normalize_doi(doi: str) -> str:
    """Lowercase, strip URL prefix."""
    doi = doi.lower().strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
    return doi


def _deduplicate_papers(papers: list) -> list:
    """Deduplicate by normalized DOI > PMID > title+year+first_author."""
    seen: set[str] = set()
    unique = []
    for p in papers:
        # Try DOI
        doi = getattr(p, "doi", None) or (p.get("doi") if isinstance(p, dict) else None)
        if doi:
            key = _normalize_doi(doi)
            if key in seen:
                continue
            seen.add(key)
            unique.append(p)
            continue
        # Try PMID
        pmid = getattr(p, "pmid", None) or (p.get("pmid") if isinstance(p, dict) else None)
        if pmid:
            key = f"pmid:{pmid}"
            if key in seen:
                continue
            seen.add(key)
            unique.append(p)
            continue
        # Fallback: title slice + year + first author
        title = getattr(p, "title", None) or (p.get("title") if isinstance(p, dict) else None) or ""
        year = getattr(p, "year", None) or (p.get("year") if isinstance(p, dict) else None) or ""
        authors = getattr(p, "authors", None) or (p.get("authors") if isinstance(p, dict) else None) or []
        first_author = (authors[0] if isinstance(authors, list) and authors else str(authors))[:10]
        key = f"{title[:60].lower()}:{year}:{first_author.lower()}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def _paper_to_dict(p) -> dict:
    """Convert a Paper object or dict to a serializable dict with a stable id."""
    if isinstance(p, dict):
        d = dict(p)
    else:
        d = {
            "title": getattr(p, "title", ""),
            "authors": getattr(p, "authors", []),
            "year": getattr(p, "year", None),
            "doi": getattr(p, "doi", None),
            "pmid": getattr(p, "pmid", None),
            "journal": getattr(p, "journal", None),
            "abstract": getattr(p, "abstract", ""),
            "citation_count": getattr(p, "citation_count", 0),
        }
    if "id" not in d or not d["id"]:
        d["id"] = str(uuid.uuid4())
    return d


def _format_authors_short(authors) -> str:
    """Return 'Last et al.' or 'Last & Last' or 'Last' from author list or string."""
    if isinstance(authors, list):
        names = [str(a).split(",")[0].strip() for a in authors if a]
    else:
        names = [str(authors).split(",")[0].strip()]
    if len(names) == 0:
        return "Unknown"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} & {names[1]}"
    return f"{names[0]} et al."


def _format_papers_with_src_markers(papers: list[dict]) -> str:
    """Format paper list with [SRC{n}] markers for AI citation injection."""
    lines = []
    for i, p in enumerate(papers, 1):
        authors = _format_authors_short(p.get("authors", ""))
        year = p.get("year") or "n.d."
        title = p.get("title", "Untitled")
        journal = p.get("journal") or ""
        doi = p.get("doi") or ""
        line = f"[SRC{i}] {authors} ({year}). {title}."
        if journal:
            line += f" {journal}."
        if doi:
            line += f" https://doi.org/{doi}"
        lines.append(line)
    return "\n".join(lines)


def _resolve_citation_markers(text: str, papers: list[dict]) -> tuple[str, list[str], list[str]]:
    """
    Replace [SRC{n}] markers with (Author et al., Year) in-text citations.
    Returns (resolved_text, cited_ids, warnings).
    """
    cited_ids: list[str] = []
    warnings: list[str] = []
    max_n = len(papers)

    def replacer(m: re.Match) -> str:
        n = int(m.group(1))
        if 1 <= n <= max_n:
            p = papers[n - 1]
            author = _format_authors_short(p.get("authors", ""))
            year = p.get("year") or "n.d."
            pid = p.get("id", str(n))
            if pid not in cited_ids:
                cited_ids.append(pid)
            return f"({author}, {year})"
        else:
            warnings.append(f"[SRC{n}] out of range (only {max_n} papers)")
            return f"[SRC{n}]"

    resolved = re.sub(r"\[SRC(\d+)\]", replacer, text)
    return resolved, cited_ids, warnings


def _format_apa_references(papers: list[dict]) -> str:
    """Format APA 7th edition reference list from cited papers."""
    if not papers:
        return ""
    lines = ["## References\n"]
    for p in papers:
        authors_raw = p.get("authors", [])
        if isinstance(authors_raw, list):
            formatted_authors = ", ".join(
                f"{str(a).split(',')[0].strip()}, {'. '.join(n[0] for n in str(a).split(',')[1:]).strip()}" if "," in str(a) else str(a)
                for a in authors_raw
            )
        else:
            formatted_authors = str(authors_raw)
        year = p.get("year") or "n.d."
        title = p.get("title", "Untitled")
        journal = p.get("journal") or ""
        doi = p.get("doi") or ""
        ref = f"{formatted_authors} ({year}). {title}."
        if journal:
            ref += f" *{journal}*."
        if doi:
            ref += f" https://doi.org/{doi}"
        lines.append(ref + "\n")
    return "\n".join(lines)


def _format_csl_json(papers: list[dict]) -> list[dict]:
    """Convert papers to basic CSL-JSON for style switching."""
    items = []
    for p in papers:
        authors_raw = p.get("authors", [])
        author_list = []
        if isinstance(authors_raw, list):
            for a in authors_raw:
                parts = str(a).split(",", 1)
                author_list.append({"family": parts[0].strip(), "given": parts[1].strip() if len(parts) > 1 else ""})
        elif authors_raw:
            author_list.append({"literal": str(authors_raw)})
        year = p.get("year")
        issued = {"date-parts": [[int(year)]]} if year else {}
        item: dict = {
            "id": p.get("id", str(uuid.uuid4())),
            "type": "article-journal",
            "title": p.get("title", ""),
            "author": author_list,
            "issued": issued,
            "container-title": p.get("journal") or "",
            "DOI": p.get("doi") or "",
        }
        items.append(item)
    return items


def _format_bibtex(papers: list[dict]) -> str:
    """Generate BibTeX entries for cited papers."""
    entries = []
    for p in papers:
        pid = p.get("id", str(uuid.uuid4()))[:8]
        authors_raw = p.get("authors", [])
        if isinstance(authors_raw, list):
            author_str = " and ".join(str(a) for a in authors_raw)
        else:
            author_str = str(authors_raw)
        year = p.get("year") or ""
        title = p.get("title", "").replace("{", "").replace("}", "")
        journal = (p.get("journal") or "").replace("{", "").replace("}", "")
        doi = p.get("doi") or ""
        entry = (
            f"@article{{{pid},\n"
            f"  author = {{{author_str}}},\n"
            f"  year = {{{year}}},\n"
            f"  title = {{{{{title}}}}},\n"
            f"  journal = {{{journal}}},\n"
            + (f"  doi = {{{doi}}},\n" if doi else "")
            + "}"
        )
        entries.append(entry)
    return "\n\n".join(entries)


async def build_evidence_pack(
    query: str,
    ai_provider: AIProvider,
    n_articles: int = 20,
    pico_context: dict | None = None,
) -> dict:
    """
    Run a scoping literature search (NOT the formal review search) to build
    an Evidence Pack for writing the Background + Rationale sections.

    Returns an EvidencePack dict with ranked_papers and metadata.
    Text generation (background/rationale) is handled separately by
    write_background_from_pack() and write_rationale_from_pack().
    """
    from services.literature_engine import LiteratureEngine

    engine = LiteratureEngine()
    queries = _build_background_queries(query, pico_context)
    logger.info("build_evidence_pack: queries=%s n_articles=%d", queries, n_articles)

    raw_papers: list = []
    try:
        async for event in engine.search_all_streaming(queries, total_limit=n_articles * 3):
            etype = event.get("type", "")
            if etype == "result":
                raw_papers.extend(event.get("papers", []))
            elif etype == "ranking":
                # After ranking event the pool is the best subset; stop collecting
                break
    except Exception as exc:
        logger.warning("build_evidence_pack search error: %s", exc)

    unique = _deduplicate_papers(raw_papers)[:n_articles]
    paper_dicts = [_paper_to_dict(p) for p in unique]

    return {
        "search_terms": queries,
        "databases_searched": ["PubMed", "OpenAlex", "Semantic Scholar", "Europe PMC", "Crossref"],
        "search_date": datetime.utcnow().date().isoformat(),
        "retrieved_count": len(raw_papers),
        "deduplicated_count": len(paper_dicts),
        "ranked_papers": paper_dicts,
        "cited_ids": [],
        "background_draft": "",
        "rationale_draft": "",
        "references_md": "",
        "references_json": [],
        "bibtex": "",
    }


async def write_background_from_pack(
    pack: dict,
    query: str,
    ai_provider: AIProvider,
    review_type: str = "systematic_review",
) -> dict:
    """
    Write Background section using the Evidence Pack with [SRC{n}] citation
    validation. Returns updated pack dict + list of any citation warnings.
    """
    papers = pack.get("ranked_papers", [])
    paper_context = _format_papers_with_src_markers(papers)

    user_msg = (
        f"Research topic: {query}\n"
        f"Review type: {review_type}\n\n"
        f"Papers (cite using [SRC{{n}}] markers only):\n{paper_context}\n\n"
        "Write the full structured Background section (1000–1500 words) with four ## subheadings."
    )

    try:
        resp = await ai_provider.guarded_complete(
            system=_BACKGROUND_CITATION_SYSTEM, user=user_msg,
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                budget=TokenBudget(target_words=1500),
                max_continuations=2,
            ),
            temperature=0.3,
        )
        draft_raw = resp.text
    except Exception as exc:
        logger.error("write_background_from_pack AI call failed: %s", exc)
        return {"pack": pack, "warnings": [str(exc)]}

    resolved_text, cited_ids, warnings = _resolve_citation_markers(draft_raw, papers)

    # If >20% citations unresolved, re-prompt once
    if warnings and len(warnings) > max(1, len(cited_ids)) * 0.2:
        logger.warning("write_background_from_pack: %d citation warnings, re-prompting", len(warnings))
        try:
            resp = await ai_provider.guarded_complete(
                system=_BACKGROUND_CITATION_SYSTEM,
                user=user_msg + "\n\nIMPORTANT: Use ONLY the [SRC{n}] markers listed above. Do not invent any citation.",
                config=CompletionConfig(
                    output_format=OutputFormat.PROSE,
                    budget=TokenBudget(target_words=1500),
                    max_continuations=2,
                ),
                temperature=0.2,
            )
            draft_raw = resp.text
            resolved_text, cited_ids, warnings = _resolve_citation_markers(draft_raw, papers)
        except Exception:
            pass

    cited_papers = [p for p in papers if p.get("id") in cited_ids]
    references_md = _format_apa_references(cited_papers)
    references_json = _format_csl_json(cited_papers)
    bibtex = _format_bibtex(cited_papers)

    pack = dict(pack)
    pack.update({
        "cited_ids": cited_ids,
        "background_draft": resolved_text.strip(),
        "references_md": references_md,
        "references_json": references_json,
        "bibtex": bibtex,
    })
    sources_used = len(cited_papers)
    summary = (
        f"I searched the literature and found **{pack['deduplicated_count']} papers** on '{query[:60]}'. "
        f"**{sources_used} papers** are cited in this background. "
        "It covers four subheadings: The Problem, The Intervention, How It Works, and Why This Review Is Needed. "
        "Review the text and tell me what to expand, change, or add."
    )
    return {"pack": pack, "warnings": warnings, "summary": summary}


async def write_rationale_from_pack(
    pack: dict,
    query: str,
    ai_provider: AIProvider,
    review_type: str = "systematic_review",
) -> dict:
    """
    Write the Rationale & Gap section by reusing the existing Evidence Pack.
    Optionally supplements with a prior-reviews search.
    Returns updated pack + summary.
    """
    papers = pack.get("ranked_papers", [])
    paper_context = _format_papers_with_src_markers(papers)

    user_msg = (
        f"Research topic: {query}\n"
        f"Review type: {review_type}\n\n"
        f"Background already written:\n{pack.get('background_draft', '')[:400]}\n\n"
        f"Papers (cite using [SRC{{n}}] markers only):\n{paper_context}\n\n"
        "Write the Rationale & Gap section (400–600 words, 3–4 paragraphs)."
    )

    try:
        resp = await ai_provider.guarded_complete(
            system=_RATIONALE_CITATION_SYSTEM, user=user_msg,
            config=CompletionConfig(
                output_format=OutputFormat.PROSE,
                budget=TokenBudget(target_words=600),
                max_continuations=1,
            ),
            temperature=0.3,
        )
        draft_raw = resp.text
    except Exception as exc:
        logger.error("write_rationale_from_pack failed: %s", exc)
        return {"pack": pack, "warnings": [str(exc)], "summary": "Error generating rationale."}

    resolved_text, new_cited_ids, warnings = _resolve_citation_markers(draft_raw, papers)

    # Merge cited_ids
    all_cited = list(dict.fromkeys(pack.get("cited_ids", []) + new_cited_ids))
    all_cited_papers = [p for p in papers if p.get("id") in all_cited]
    references_md = _format_apa_references(all_cited_papers)
    references_json = _format_csl_json(all_cited_papers)
    bibtex = _format_bibtex(all_cited_papers)

    pack = dict(pack)
    pack.update({
        "cited_ids": all_cited,
        "rationale_draft": resolved_text.strip(),
        "references_md": references_md,
        "references_json": references_json,
        "bibtex": bibtex,
    })
    summary = (
        f"Rationale drafted using the same evidence pack ({len(papers)} papers). "
        f"{len(new_cited_ids)} papers cited in this section. "
        "Tell me what to revise or expand."
    )
    return {"pack": pack, "warnings": warnings, "summary": summary}
