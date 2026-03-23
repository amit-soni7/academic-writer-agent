// Mirrors the Pydantic models in backend/models.py

export type ArticleMode = 'novel' | 'revision';

export type WritingType =
  | 'original_research'
  | 'systematic_review'
  | 'scoping_review'
  | 'narrative_review'
  | 'meta_analysis'
  | 'case_report'
  | 'brief_report'
  | 'short_communication'
  | 'letter'
  | 'editorial'
  | 'opinion'
  | 'study_protocol'
  | 'review';        // generic / legacy

export interface IntentRequest {
  mode: ArticleMode;
  writing_type: WritingType;
  key_idea: string;
  target_journal?: string;
}

export interface IntentResponse {
  status: string;
  message: string;
  received: IntentRequest;
}
