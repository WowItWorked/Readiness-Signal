// Data-model enums (SPEC §3). Order matters where noted.

/** Section order also drives id numbering within an edition. */
export const SECTIONS = Object.freeze(['executive_visibility', 'capability_shift', 'regulatory_trajectory']);

export const DOMAINS = Object.freeze(['cyber', 'fraud', 'ai', 'data', 'resilience', 'third_party', 'risk_quantification']);

export const SOURCE_CLASSES = Object.freeze([
  'news', 'regulator', 'standards_body', 'industry_trade', 'vendor_threat_research', 'research_analysis',
]);

/** Mechanism order also drives id numbering within a section. */
export const MECHANISMS = Object.freeze(['candidate_issue', 'kri_kpi', 'praf_coverage', 'awareness_only']);

export const RUN_STATUSES = Object.freeze(['published', 'silent', 'failed']);

export const VERDICTS = Object.freeze(['pass', 'drop']);

export const DEDUP_OUTCOMES = Object.freeze(['new', 'cluster_merged', 'same_story_dropped', 'material_update']);

export const SEEN_VERDICTS = Object.freeze(['published', 'dropped', 'duplicate']);

export const SOURCE_TYPES = Object.freeze(['feed', 'cisa-kev', 'page']);

export const REGIONS = Object.freeze(['US', 'UK', 'EU', 'INTL']);

export const THRESHOLD_LEVELS = Object.freeze(['high', 'medium', 'low']);

export const FUNNEL_KEYS = Object.freeze([
  'sources_ok', 'sources_failed', 'fetched', 'in_window', 'unseen',
  'stage1_pass', 'stage2_pass', 'dedup_dropped', 'published',
]);

export const ITEM_ID_RE = /^RS-\d{6}-\d{4}-\d{2}$/;
export const CANDIDATE_ID_RE = /^c-[0-9a-f]{10}$/;
export const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;

export const ITEM_KEYS = Object.freeze([
  'id', 'timestamp', 'section', 'claim', 'domains', 'source_class', 'mechanism', 'interpretation',
  'validation_question', 'candidate_issue_statement', 'awareness_rationale', 'sources', 'backfilled', 'update_of',
]);

export const SOURCE_KEYS = Object.freeze(['publication', 'url', 'headline', 'published', 'source_class']);

export const GENERATED_TEXT_FIELDS = Object.freeze([
  'claim', 'interpretation[].text', 'validation_question', 'candidate_issue_statement', 'awareness_rationale',
]);
