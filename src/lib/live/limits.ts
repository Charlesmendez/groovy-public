export const MAX_TEXT_LEN = 4000;
export const MAX_SOURCE_TEXT_LEN = 64_000;
export const MAX_FORM_FIELDS = 16;
export const MAX_WIKI_FILE_BYTES = 100 * 1024;
export const MAX_RAW_SOURCE_BYTES = 256 * 1024;
export const MAX_COLLECTED_HTML_BYTES = MAX_WIKI_FILE_BYTES;
export const MAX_CANVAS_OUTPUT_TOKENS = 12000;
export const MAX_CANVAS_REPAIR_HTML_CHARS = 40_000;
export const LOG_TAIL_LINES = 10;
export const CANVAS_REVISION_CAP = 50;
export const WIKI_UPDATE_STEP_BUDGET = 8;

export const INTENTS = [
  "user_message",
  "query",
  "ingest_source",
  "lint_wiki",
  "set_preference",
  "save_note",
  "open_page",
  "retry",
  "form_submit",
] as const;
export type Intent = (typeof INTENTS)[number];
export const INTENT_SET: ReadonlySet<string> = new Set<string>(INTENTS);
