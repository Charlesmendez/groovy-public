/**
 * Tools for the orchestrator
 * 
 * IMPORTANT: Data tools delegate to specialized Datagran agents.
 * Each agent has its own prompts (Google Ads API, Facebook endpoints, etc.)
 * and uses Claude Opus with code execution for analysis/visualization.
 * 
 * Browser/Files/Obsidian tools are executed via the local connector.
 */

import { z } from "zod";
import type { ConnectorClientPlatform } from "@/lib/connector/platform";
import { executeTool, type ToolExecutionContext } from "./toolExecutor";
import { filterToolsByPolicy } from "./toolPolicy";
import type { AgentType } from "./router";
import {
  applySkillStatePatch,
  extractSkillStatePatchFromText,
  type SkillRuntimeTool,
} from "./skillsRuntime";
import { zodSchemaFromJsonSchema } from "@/lib/extensions/jsonSchema";
import { indexExtensionRuntimeTools } from "@/lib/extensions/registry";
import type { ExtensionRuntimeTool } from "@/lib/extensions/types";
import { getAppUrl, getRelayUrl } from "@/lib/config/appConfig";

// ============================================================================
// BROWSER TOOLS - Executed via local connector
// ============================================================================

export const browserNavigateSchema = z.object({
  url: z.string().describe("URL to navigate to (include https://)"),
});

export const browserClickSchema = z.object({
  selector: z.string().describe("CSS selector of element to click"),
  text: z.string().optional().describe("Optional: text content of element to help identify it"),
});

export const browserTypeSchema = z.object({
  selector: z.string().describe("CSS selector of input field"),
  text: z.string().describe("Text to type into the field"),
});

export const browserExtractSchema = z.object({
  instruction: z.string().describe("What content to extract from the page (e.g., 'all product titles and prices', 'the main article text')"),
});

export const browserScreenshotSchema = z.object({
  description: z.string().optional().describe("What to capture in the screenshot"),
});

// Claude Computer Use - main browser automation tool
export const browserTaskSchema = z.object({
  task: z.string().describe("What task to accomplish in the browser. Be specific about URLs to visit and actions to take."),
  startUrl: z.string().optional().describe("Starting URL (if known). If not provided, Claude will figure out where to go."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional timeout in milliseconds for unusually long authenticated browser work."),
});

// Credentials for authenticated browsing (stored locally on connector; never sent via chat)
export const credentialGetSchema = z.object({
  domain: z.string().describe("Domain to check credentials for (e.g. reddit.com)"),
});

export const credentialRequestSchema = z.object({
  domain: z.string().describe("Domain to request credentials for (e.g. reddit.com)"),
  reason: z.string().optional().describe("Short reason shown in the local connector prompt"),
});

// ============================================================================
// OBSIDIAN TOOLS - Executed via local connector
// ============================================================================

export const obsidianDiscoverSchema = z.object({});

export const obsidianSearchSchema = z.object({
  vault_path: z.string().optional().describe("Path to the Obsidian vault (optional; defaults to the selected vault)"),
  query: z.string().describe("Search query"),
  search_content: z.boolean().optional().describe("Search inside note content"),
  search_tags: z.boolean().optional().describe("Search note tags"),
});

export const obsidianReadSchema = z.object({
  vault_path: z.string().optional().describe("Path to the Obsidian vault (optional; defaults to the selected vault)"),
  note_path: z.string().describe("Path to the note within the vault (without .md extension)"),
});

export const obsidianWriteSchema = z.object({
  vault_path: z.string().optional().describe("Path to the Obsidian vault (optional; defaults to the selected vault)"),
  note_path: z.string().describe("Path for the note within the vault"),
  content: z.string().describe("Markdown content for the note"),
});

export const obsidianListSchema = z.object({
  vault_path: z.string().optional().describe("Path to the Obsidian vault (optional; defaults to the selected vault)"),
});

export const obsidianDailySchema = z.object({
  vault_path: z.string().optional().describe("Path to the Obsidian vault (optional; defaults to the selected vault)"),
  content: z.string().optional().describe("Content to add to today's note"),
  append: z.boolean().optional().describe("Append to existing note (default: true)"),
});

// ============================================================================
// CODE (Claude Code CLI) - UI control only (opens a named code session)
// ============================================================================

// ============================================================================
// HANDSHAKE TOOLS - Agent-to-agent communication (server-side)
// ============================================================================

export const handshakeSendSchema = z.object({
  message: z.string().describe("The message to send to the connected partner agent"),
  context: z.string().optional().describe("Optional additional context or data to share with the partner"),
});

export const codeOpenSessionSchema = z.object({
  name: z.string().describe("Name of the Code session to open (matches a configured Claude Code session name)"),
});

// Code (Claude Code PTY relay) - executed via local connector
export const codeTerminalStepSchema = z.object({
  terminal_id: z.string().describe("Terminal id for the Claude Code PTY session (stable per WhatsApp thread)"),
  cwd: z.string().optional().describe("Working directory for the session (used on first spawn)"),
  input: z.string().describe("Text to send into the Claude Code session"),
  max_wait_ms: z.number().int().optional().describe("Max time to wait for output to settle (ms)"),
  quiet_ms: z.number().int().optional().describe("Consider output settled when buffer is unchanged for this long (ms)"),
  capture_max_chars: z.number().int().optional().describe("Max chars of output to return (connector truncates)"),
});

// Terminal (non-interactive shell) - executed via local connector
export const terminalExecSchema = z.object({
  command: z
    .string()
    .describe("Command to run (executed via /bin/bash -lc). Should be non-interactive."),
  cwd: z
    .string()
    .optional()
    .describe("Optional working directory (defaults to $HOME on the connector)."),
  timeout_ms: z
    .number()
    .int()
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
  max_output_chars: z
    .number()
    .int()
    .optional()
    .describe("Max chars to return across stdout+stderr (default: 40000)."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional environment variables to set (small, non-secret)."),
});

const groovyOpsKnowledgeTopics = ["connector", "whatsapp", "relay", "logs", "all"] as const;

type GroovyOpsKnowledgeTopic = (typeof groovyOpsKnowledgeTopics)[number];

export const groovyOpsKnowledgeSchema = z.object({
  topic: z
    .enum(groovyOpsKnowledgeTopics)
    .optional()
    .default("all")
    .describe("Which area to get knowledge about. Defaults to all."),
});

// Claude Code CLI (headless) - executed via local connector using `claude -p`
export const codeCliRunSchema = z.object({
  prompt: z
    .string()
    .describe("The coding task or question to send to Claude Code. Be specific about what files to read/edit."),
  cwd: z
    .string()
    .describe("Working directory (repo root) for the coding task. Must be an absolute path."),
  allowed_tools: z
    .string()
    .optional()
    .describe("Comma-separated list of allowed tools (default: Read,Edit,Bash)."),
  timeout_ms: z
    .number()
    .int()
    .optional()
    .describe("Timeout in ms (default: 5 minutes)."),
  session_id: z
    .string()
    .optional()
    .describe("Session ID from a previous Claude Code response to resume the conversation (uses --resume)."),
});

// ============================================================================
// WHATSAPP (Local WhatsApp Web bridge) - Executed via local connector
// ============================================================================

export const whatsappResolveRecipientSchema = z.object({
  query: z
    .string()
    .describe("Recipient query: contact/group display name or phone number."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max candidates to return (default 10)."),
});

export const whatsappSendTextSchema = z.object({
  chat_id: z
    .string()
    .describe("WhatsApp chat id (serialized), e.g. 12345@c.us (DM) or ...@g.us (group)."),
  recipient_query: z
    .string()
    .optional()
    .describe(
      "Optional recipient display name/query used to verify chat_id before sending (recommended for safety)."
    ),
  text: z.string().describe("Message text to send."),
});

export const whatsappSendMediaSchema = z.object({
  chat_id: z
    .string()
    .describe("WhatsApp chat id (serialized), e.g. 12345@c.us (DM) or ...@g.us (group)."),
  recipient_query: z
    .string()
    .optional()
    .describe(
      "Optional recipient display name/query used to verify chat_id before sending (recommended for safety)."
    ),
  url: z
    .string()
    .optional()
    .describe("Public or signed URL to the media file to send."),
  local_path: z
    .string()
    .optional()
    .describe(
      "Optional absolute local file path on the connector machine (e.g. /tmp/report.xlsx or ~/.groovy/uploads/report.xlsx). Use for connector-generated files that are not in chat_uploads."
    ),
  storage_path: z
    .string()
    .optional()
    .describe(
      "Optional chat_uploads storage path (preferred when URL is unavailable/redacted). The server resolves this to a signed URL."
    ),
  file_id: z
    .string()
    .optional()
    .describe(
      "Optional Anthropic file id fallback. Used to resolve a recent attachment when storage_path is unavailable."
    ),
  filename: z
    .string()
    .optional()
    .describe("Optional filename to show in WhatsApp (falls back to URL/headers)."),
  caption: z
    .string()
    .optional()
    .describe("Optional caption (WhatsApp may truncate long captions)."),
}).refine(
  (v) =>
    (typeof v.url === "string" && v.url.trim().length > 0) ||
    (typeof v.local_path === "string" && v.local_path.trim().length > 0) ||
    (typeof v.storage_path === "string" && v.storage_path.trim().length > 0) ||
    (typeof v.file_id === "string" && v.file_id.trim().length > 0),
  {
    message: "Provide at least one of: url, local_path, storage_path, or file_id",
    path: ["url"],
  }
);

// ============================================================================
// TELEGRAM (Server-side via Telegram Bot API)
// ============================================================================

export const telegramResolveRecipientSchema = z.object({
  query: z
    .string()
    .describe("Recipient query: Telegram username, display name, or group name."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max candidates to return (default 5)."),
});

export const telegramSendTextSchema = z.object({
  chat_id: z
    .string()
    .describe("Telegram chat_id (numeric string) from resolve result."),
  text: z
    .string()
    .describe("Message text to send (max 4096 chars)."),
  message_thread_id: z
    .number()
    .optional()
    .describe("Forum topic ID to send the message to (for forum-enabled groups)."),
  recipient_query: z
    .string()
    .optional()
    .describe("Optional recipient display name/query used for verification."),
});

export const telegramSendMediaSchema = z.object({
  chat_id: z
    .string()
    .describe("Telegram chat_id (numeric string)."),
  url: z
    .string()
    .optional()
    .describe("Public URL to the media file to send."),
  storage_path: z
    .string()
    .optional()
    .describe("Optional chat_uploads storage path. The server resolves this to a signed URL."),
  file_id: z
    .string()
    .optional()
    .describe("Optional file id fallback for resolving a recent attachment."),
  filename: z
    .string()
    .optional()
    .describe("Optional filename for the document."),
  caption: z
    .string()
    .optional()
    .describe("Optional caption for the media."),
  message_thread_id: z
    .number()
    .optional()
    .describe("Forum topic ID (for forum-enabled groups)."),
});

export const telegramCreateTopicSchema = z.object({
  chat_id: z
    .string()
    .describe("Telegram supergroup chat_id (must be a forum-enabled group)."),
  name: z
    .string()
    .describe("Name for the new forum topic/thread."),
});

export const startTwilioCallSchema = z.object({
  to: z
    .string()
    .optional()
    .describe(
      "Destination phone number in E.164 format, e.g. +14155550123. Omit only if a default To is configured upstream."
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Optional From number override in E.164 format. Only pass this if the user explicitly wants to override the configured Twilio sender. Never copy the recipient `to` number into `from`."
    ),
  message: z.string().optional().describe("Optional task/brief for the supervised call."),
  lang: z
    .string()
    .optional()
    .describe("Optional language hint for the supervised call, e.g. en or es."),
});

export const startTwilioSmsSchema = z.object({
  to: z
    .string()
    .optional()
    .describe(
      "Destination phone number in E.164 format, e.g. +14155550123. Omit only if a default To is configured upstream."
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Optional From number override in E.164 format. Only pass this if the user explicitly wants to override the configured Twilio sender. Never copy the recipient `to` number into `from`."
    ),
  message: z.string().describe("SMS body to send."),
  lang: z
    .string()
    .optional()
    .describe("Optional language hint for the supervised SMS flow, e.g. en or es."),
});

export const coachTwilioChildSchema = z.object({
  message: z.string().describe("Coaching instruction to send to the active supervised Twilio child."),
});

export const getTwilioChildStatusSchema = z.object({});

// ============================================================================
// LINK INBOX (SQLite) - Executed via local connector
// ============================================================================

export const linkdbInitSchema = z.object({});

export const linkdbUpsertLinksSchema = z.object({
  links: z
    .array(
      z.object({
        url: z.string().describe("URL to store"),
        title: z.string().optional().describe("Optional title"),
        source: z.string().optional().describe("Optional source metadata (thread/session/etc)"),
      })
    )
    .max(50)
    .describe("Links to upsert"),
});

export const linkdbUpdateSchema = z.object({
  url: z.string().describe("URL to update (primary key)"),
  title: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Tag list (will be normalized)"),
  note: z.string().optional(),
  read: z.boolean().optional().describe("Mark read/unread"),
  source: z.string().optional(),
});

export const linkdbQuerySchema = z.object({
  text: z.string().optional().describe("Search text (matches url/title/summary/note)"),
  tags_any: z.array(z.string()).optional().describe("Match any of these tags"),
  unread_only: z.boolean().optional().describe("Only unread items"),
  limit: z.number().int().optional().describe("Max results (default 50)"),
});

export const linkdbDigestSchema = z.object({
  since_days: z.number().int().optional().describe("Lookback window in days (default 7)"),
  unread_only: z.boolean().optional().describe("Only unread (default true)"),
  limit: z.number().int().optional().describe("Max results (default 50)"),
});

// ============================================================================
// Generic SQLite (multi-project DBs)
// ============================================================================

export const sqliteListSchema = z.object({});

export const sqliteExecSchema = z.object({
  dbKey: z
    .string()
    .describe("Project database key (creates/opens ~/.groovy/sqlite/<dbKey>.sqlite). Use a short slug like 'project-x'."),
  sql: z.string().optional().describe("SQL to execute (single statement or multi-statement)."),
  statements: z.array(z.string()).optional().describe("Optional list of SQL statements to execute (max 50)."),
  timeout_ms: z.number().int().optional().describe("Timeout in ms (default 30s)."),
});

export const sqliteQuerySchema = z.object({
  dbKey: z.string().describe("Project database key (~/.groovy/sqlite/<dbKey>.sqlite)."),
  sql: z.string().describe("SELECT query to run."),
  limit: z.number().int().optional().describe("If append_limit=true and query has no LIMIT, append LIMIT (default 200)."),
  append_limit: z.boolean().optional().describe("If true (default), append LIMIT when query has no LIMIT."),
  timeout_ms: z.number().int().optional().describe("Timeout in ms (default 30s)."),
});

// ============================================================================
// SQLite Project Registry (central)
// ============================================================================

export const sqliteProjectListSchema = z.object({});

export const sqliteProjectGetOrCreateSchema = z.object({
  name: z.string().describe("Human project name (e.g. 'Todos', 'Bookmarks', 'Job Hunt 2026')."),
  description: z.string().optional().describe("Optional project description."),
  tags: z.array(z.string()).optional().describe("Optional tags for organization."),
  preferredDbKey: z
    .string()
    .optional()
    .describe("Optional preferred dbKey slug; if unavailable, Groovy chooses a safe dbKey."),
});

export const sqliteProjectUpdateSchema = z.object({
  dbKey: z.string().describe("Project dbKey to update."),
  name: z.string().optional().describe("Rename project."),
  description: z.string().optional().describe("Update description."),
  tags: z.array(z.string()).optional().describe("Replace tags list."),
});

// ============================================================================
// Site Builder (AI-generated Next.js sites deployed to Vercel)
// ============================================================================

export const siteDevSchema = z.object({
  slug: z
    .string()
    .describe("Site slug (e.g. 'acme-report'). Used as folder name under ~/.groovy/sites/<slug>."),
  action: z
    .enum(["start", "stop"])
    .optional()
    .default("start")
    .describe("Start or stop the local dev server (default: start)."),
});

export const sitePublishSchema = z.object({
  slug: z
    .string()
    .describe("Site slug to deploy to Vercel."),
  siteId: z
    .string()
    .optional()
    .describe("Site ID from generated_sites table (looked up automatically if not provided)."),
});

export const siteAttachDomainSchema = z.object({
  siteId: z
    .string()
    .optional()
    .describe("Site ID from generated_sites table (preferred when available)."),
  slug: z
    .string()
    .optional()
    .describe("Site slug fallback when siteId is unknown (e.g. 'hello-groovy')."),
  domain: z.string().describe("Custom domain to attach (e.g. 'acme-report.com')."),
}).refine((v) => Boolean((v.siteId && v.siteId.trim()) || (v.slug && v.slug.trim())), {
  message: "Provide siteId or slug",
});

export const siteVerifyDomainSchema = z.object({
  siteId: z
    .string()
    .optional()
    .describe("Site ID from generated_sites table (preferred when available)."),
  slug: z
    .string()
    .optional()
    .describe("Site slug fallback when siteId is unknown (e.g. 'hello-groovy')."),
  domain: z.string().describe("Domain to verify."),
}).refine((v) => Boolean((v.siteId && v.siteId.trim()) || (v.slug && v.slug.trim())), {
  message: "Provide siteId or slug",
});

export const siteDeleteSchema = z.object({
  siteId: z.string().describe("Site ID to permanently delete (removes Vercel project + all data)."),
});

export const siteUnpublishSchema = z.object({
  siteId: z.string().describe("Site ID to take offline (keeps project, deletes deployment, can redeploy later)."),
});

// All supported Datagran providers (from src/lib/datagran/prompts.ts)
export const DATAGRAN_PROVIDERS = [
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "postgres",
  "firecrawl",
  "salesforce",
  "web_pixel",
  "gmail",
  "google_calendar",
] as const;

type DatagranProvider = (typeof DATAGRAN_PROVIDERS)[number];

const PROVIDER_DESCRIPTIONS: Record<DatagranProvider, string> = {
  facebook_ads: "Facebook Ads - campaign performance, ad spend, audience insights",
  facebook_leads: "Facebook Lead Ads - lead forms, submissions, lead data",
  instagram: "Instagram Business - followers, engagement, content performance",
  google_ads: "Google Ads - campaigns, keywords, conversions, ad performance",
  linkedin_ads: "LinkedIn Ads - campaigns, leads, professional audience targeting",
  google_drive: "Google Drive - file management, document search, sharing",
  tiktok: "TikTok Ads - video campaigns, audience reach, engagement",
  postgres: "PostgreSQL/Supabase - SQL queries, database analytics",
  firecrawl: "Firecrawl - web scraping, content extraction, site crawling",
  salesforce: "Salesforce - CRM data, leads, opportunities, accounts",
  web_pixel: "Web Pixel Analytics - page views, visitors, user tracking, events",
  gmail: "Gmail - emails, inbox, sent messages, drafts, labels, search",
  google_calendar: "Google Calendar - events, meetings, schedules, calendars",
};

// Data query parameters schema
export const dataQuerySchema = z.object({
  provider: z
    .enum(DATAGRAN_PROVIDERS)
    .describe("Which platform to query"),
  query: z
    .string()
    .describe("Natural language query to send to the specialized agent"),
  agentName: z
    .string()
    .optional()
    .describe(
      "Optional: when multiple connected agents/accounts exist for the same provider, choose one by its displayed agent/account name from data_check_connection."
    ),
  pixelName: z
    .string()
    .optional()
    .describe("For web_pixel: specific pixel name to query (matches against user's configured pixels)"),
});

export const dataUpreadyReadinessSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe("Lookback window in days (default 30)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe("Maximum daily readiness points to return (default 30)"),
});

// Data check connection schema  
export const dataCheckConnectionSchema = z.object({
  provider: z
    .enum(DATAGRAN_PROVIDERS)
    .describe("Which platform to check"),
});

// Memory schemas
export const rememberSchema = z.object({
  content: z.string().describe("The information to remember"),
  label: z
    .string()
    .optional()
    .describe("Optional category/label for the memory"),
  wiki_category: z
    .enum(["entities", "concepts", "projects"])
    .optional()
    .describe("Best private Wiki section for this learning"),
  wiki_page: z
    .string()
    .optional()
    .describe("Stable kebab-case Wiki page name, or an existing Wiki-relative markdown path"),
  wiki_title: z
    .string()
    .optional()
    .describe("Human-readable title if the Wiki page must be created"),
});

export const recallSchema = z.object({
  query: z.string().describe("What to search for in memory"),
});

export const wikiSearchSchema = z.object({
  query: z.string().describe("Named project, entity, decision, preference, or topic to find"),
  limit: z.number().int().min(1).max(8).optional().describe("Maximum matching Wiki pages"),
});

export const wikiReadSchema = z.object({
  path: z
    .string()
    .describe("Wiki-relative path such as index.md, projects/groovy.md, or concepts/user-preferences.md"),
});

export const wikiFileLearningSchema = z.object({
  content: z
    .string()
    .describe("Concise durable learning to add; do not include passwords, tokens, keys, or full account numbers"),
  label: z.string().optional().describe("Optional learning category or tag"),
  category: z
    .enum(["entities", "concepts", "projects"])
    .optional()
    .describe("Best Wiki section for this learning"),
  page: z
    .string()
    .optional()
    .describe("Stable kebab-case page name, or an existing Wiki-relative markdown path"),
  title: z.string().optional().describe("Human-readable title when creating a new page"),
});

// Files Agent request schema (for document creation/analysis without upload)
export const filesAgentRequestSchema = z.object({
  request: z.string().describe("What to ask the Files agent to do. Examples: 'create a pie chart from the data', 'generate an Excel file with these values', 'summarize the document', 'create a bar chart comparing the metrics'"),
});

// AI Agent delegate schema (for calling user-configured AI chat agents)
export const aiAgentDelegateSchema = z.object({
  agentName: z.string().describe("The name of the AI agent to delegate to (must match an agent the user has configured)"),
  message: z.string().describe("The message/request to send to the agent"),
});

export const skillRuntimeInvokeSchema = z.object({
  task: z.string().describe("What the skill should execute for this turn."),
  cwd: z.string().optional().describe("Optional working directory override."),
  timeout_ms: z.number().int().optional().describe("Optional timeout in milliseconds."),
  state_patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional state patch to merge into the skill runtime state after execution."),
});

export const runtimeBranchParallelSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().optional().describe("Short worker label."),
        goal: z.string().describe("Independent server-side subtask for this worker branch."),
      })
    )
    .min(1)
    .max(12)
    .describe("Independent subtasks to execute in parallel worker branches."),
  shared_context: z
    .string()
    .optional()
    .describe("Shared context every worker branch should receive."),
});

export const skillRegistryCreateDraftSchema = z.object({
  name: z.string().describe("Human-readable skill name."),
  slug: z.string().optional().describe("Optional stable slug override."),
  description: z.string().optional().describe("Why this skill exists and when to use it."),
  runner: z.enum(["code_cli_run", "terminal_exec"]).describe("Execution backend for the skill."),
  source: z
    .string()
    .describe(
      "Reusable skill source. For terminal_exec this is shell content; for code_cli_run this is the reusable prompt template."
    ),
  default_state: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional default runtime state for the skill."),
});

export const skillRegistryValidateDraftSchema = z.object({
  skill_ref: z.string().describe("Skill slug, name, or id to validate."),
  validation_task: z.string().describe("Concrete test task that proves the draft skill works."),
  cwd: z.string().optional().describe("Optional working directory override for validation."),
  timeout_ms: z.number().int().optional().describe("Optional validation timeout in milliseconds."),
});

export const skillRegistryActivateDraftSchema = z.object({
  skill_ref: z.string().describe("Skill slug, name, or id to activate."),
  validation_output: z
    .string()
    .describe("Raw output from the latest validation run, including the __SKILL_VALIDATION__ marker."),
});

// ============================================================================
// SCHEDULE TOOLS - server-side CRUD; execution happens on connector
// ============================================================================

const scheduleSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    run_at: z
      .string()
      .describe(
        "ISO timestamp. SHOULD include timezone offset when the user specifies a timezone (recommended). Example: 2026-01-26T07:30:00-06:00"
      ),
  }),
  z.object({
    type: z.literal("daily"),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe(
        "Hour in the connector machine's LOCAL timezone (NOT UTC). Do NOT convert to UTC for daily schedules."
      ),
    minute: z
      .number()
      .int()
      .min(0)
      .max(59)
      .describe(
        "Minute in the connector machine's LOCAL timezone (NOT UTC). Do NOT convert to UTC for daily schedules."
      ),
  }),
  z.object({
    type: z.literal("weekly"),
    weekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .describe(
        "Day of week in the connector machine's LOCAL timezone. 0=Sunday, 1=Monday, ... 6=Saturday"
      ),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .describe(
        "Hour in the connector machine's LOCAL timezone (NOT UTC). Do NOT convert to UTC for weekly schedules."
      ),
    minute: z
      .number()
      .int()
      .min(0)
      .max(59)
      .describe(
        "Minute in the connector machine's LOCAL timezone (NOT UTC). Do NOT convert to UTC for weekly schedules."
      ),
  }),
  z.object({
    type: z.literal("interval_minutes"),
    minutes: z.number().int().min(1).max(60 * 24 * 30),
  }),
]);

export const scheduleCreateSchema = z
  .object({
    kind: z
      .enum(["shell", "orchestrator"])
      .describe("Job type: shell (runs /bin/bash -lc) or orchestrator (runs Groovy task at runtime)"),
    name: z.string().optional().describe("Optional job name"),
    // shell
    command: z.string().optional().describe("For kind=shell: command to run (executed via /bin/bash -lc)"),
    cwd: z.string().optional().describe("For kind=shell: optional working directory"),
    // orchestrator
    task: z
      .string()
      .optional()
      .describe(
        "For kind=orchestrator: natural language task for Groovy to execute at runtime (e.g. 'use Firecrawl to crawl target.com and summarize')"
      ),
    agent: z
      .string()
      .optional()
      .describe(
        "For kind=orchestrator: optional worker agent (name or id) that should run the task deterministically. Omit to let the Orchestrator handle it (default). Scheduled worker runs are capped at ~10 minutes."
      ),
    model: z
      .string()
      .optional()
      .describe(
        "For kind=orchestrator: optional model id for this scheduled task (for example gpt-5.6-luna or claude-sonnet-4-6). Omit to use the selected Orchestrator or worker default."
      ),
    provider: z
      .enum(["anthropic", "openai"])
      .optional()
      .describe("Optional model provider; inferred from model when omitted."),
    reasoning_effort: z
      .enum(["none", "low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("Optional reasoning effort when supported by the selected model."),
    schedule: scheduleSpecSchema.describe("When to run"),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "shell") {
      if (!val.command || !val.command.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "command is required for kind=shell",
        });
      }
      return;
    }
    if (val.kind === "orchestrator") {
      if (!val.task || !val.task.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["task"],
          message: "task is required for kind=orchestrator",
        });
      }
    }
  })
  .describe(
    "Create either a shell job (runs locally) or an orchestrator job (runs Groovy task at runtime)"
  );

export const scheduleListSchema = z.object({
  device_id: z.string().optional().describe("Optional: filter by device id"),
  agent_id: z.string().optional().describe("Optional: filter by owner agent id"),
});

export const scheduleIdSchema = z.object({
  job_id: z.string().describe("Scheduled job id (UUID)"),
});

// ---------------------------------------------------------------------------
// Worker-agent delegation tools (harness)
// ---------------------------------------------------------------------------

export const listAgentsSchema = z.object({});

export const listSkillsAndDocsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional name, description, slug, or path search"),
});

const skillAssignmentDestinationSchema = z.enum([
  "orchestrator",
  "all_claude",
  "all_codex",
  "worker",
]);

export const assignSkillOrDocSchema = z.object({
  artifact: z
    .string()
    .min(1)
    .describe("Exact skill/doc name, slug, relative path, or artifact id"),
  destination: skillAssignmentDestinationSchema.describe(
    "Assign to the orchestrator, all Claude agents, all Codex agents, or one worker"
  ),
  agent: z
    .string()
    .optional()
    .describe("Required only when destination=worker: exact worker name or id"),
});

export const removeSkillOrDocAssignmentSchema = assignSkillOrDocSchema;

export const assignTaskSchema = z.object({
  agent: z
    .string()
    .describe("Worker agent to run the task: exact name (preferred) or agent id"),
  task: z
    .string()
    .describe(
      "The full task for the worker agent. Be specific and self-contained — the worker does not see this conversation."
    ),
  context: z
    .string()
    .optional()
    .describe("Optional extra context to prepend to the task (facts, constraints, prior findings)"),
  title: z.string().optional().describe("Optional short title for the task (defaults to a prompt summary)"),
  require_approval: z
    .boolean()
    .optional()
    .describe(
      "Set true for destructive or production-affecting work: the task waits for the user's approval before running"
    ),
  plan_mode: z
    .boolean()
    .optional()
    .describe(
      "Set true when the user wants a plan first: the worker runs in read-only plan mode and returns a plan instead of making changes. The user then approves the plan (it is saved to the workspace's .claude/plans/) and chooses which agent executes it."
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Set true only for very short tasks (<2 min) when the user needs the result in this reply. Default false: the task runs in the background and you are notified on completion."
    ),
});

export const consultAgentSchema = z.object({
  agent: z
    .string()
    .describe("Exact worker agent name (preferred) or agent id whose workspace should be explored"),
  objective: z
    .string()
    .min(1)
    .describe("The project or feature the orchestrator is planning"),
  questions: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe("Targeted repository questions the worker should answer with file evidence"),
  depth: z
    .enum(["quick", "standard", "thorough"])
    .optional()
    .describe("Exploration depth; standard is the default"),
  planning_session_id: z
    .string()
    .optional()
    .describe("Reuse the id returned by an earlier consultation for a follow-up investigation"),
});

export const finalizePlanSchema = z.object({
  planning_session_id: z
    .string()
    .describe("Planning session id returned by consult_agent"),
  title: z.string().min(1).max(160).describe("Short plan title"),
  plan: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "The orchestrator's final evidence-backed markdown plan, including scope, verified architecture, files, ordered steps, tests, risks, and open decisions"
    ),
});

export const checkAgentStatusSchema = z.object({
  agent: z.string().optional().describe("Worker agent name or id (omit for all agents)"),
  task_id: z.string().optional().describe("Specific task id to check"),
});

export const collectResultSchema = z.object({
  task_id: z.string().describe("Task id to collect the result for"),
});

export const usageReportSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Lookback window in days (default 30)"),
});

export const transferContextSchema = z.object({
  from_agent: z
    .string()
    .describe('Source: a worker agent name/id, or "orchestrator" for this conversation'),
  to_agent: z.string().describe("Target worker agent name or id"),
  instructions: z
    .string()
    .optional()
    .describe("Optional handoff instructions appended to the transferred briefing"),
});

/**
 * Tool definitions (schemas only) for the AI SDK
 * Execution is handled separately via executeToolCall
 */
export const toolDefinitions = {
  data_query: {
    description: `Query data from a connected platform. This delegates to a specialized AI agent for that platform.

Available providers:
${DATAGRAN_PROVIDERS.map((p) => `- ${p}: ${PROVIDER_DESCRIPTIONS[p]}`).join("\n")}

The specialized agent will:
1. Use its knowledge of the platform's API
2. Fetch and analyze the data
3. Create visualizations if helpful
4. Return a comprehensive response

Failure handling:
- If data_query returns JSON with blockedForRun=true or retryable=false, do not call data_query again in this run.
- In that case, summarize what was obtained, explain the failure briefly, and suggest the next best provider/query strategy.

Multiple connected accounts:
- If data_check_connection reports multiple active agents for a provider, pass agentName to query a specific account.
- For Gmail sender/thread searches where the account is unknown, query each active Gmail agent by agentName before saying a message was not found.
- Never claim that all Gmail accounts were checked unless each active Gmail agent was queried or the tool result explicitly says all were covered.

Postgres notes:
- For provider=postgres, you may pass raw SQL (including INSERT/UPDATE/DELETE) when the user asked for a DB write/backfill.
- After any mutation, always follow with a verification SELECT (row counts / remaining NULLs).

Examples:
- "What were my top campaigns last week?" → google_ads or facebook_ads
- "Show visitor stats for today" → web_pixel
- "Scrape the homepage of example.com" → firecrawl
- "Find all leads from last month" → salesforce or facebook_leads
- "Query my users table" → postgres`,
    parameters: dataQuerySchema,
  },

  data_upready_readiness: {
    description: `Fetch Upready readiness data for the currently linked user.

Use this when the user asks about readiness score trends, recent daily readiness values, or load changes.

Returns:
- whether Upready is connected
- linked Upready user id/email (when connected)
- daily deduplicated readiness points
- a concise computed summary`,
    parameters: dataUpreadyReadinessSchema,
  },

  data_check_connection: {
    description: `Check if a data platform has an active configured connection id. Returns configured agents plus active connection counts. This is a configuration check, not a full provider API health probe.`,
    parameters: dataCheckConnectionSchema,
  },

  remember: {
    description: `Store DURABLE information to Groovy's hybrid long-term memory. The learning is saved for semantic Datagran recall and filed into the private structured Wiki when appropriate. Use this tool ONLY for:
- User preferences/constraints they've stated ("I always want reports in MMM-YYYY format")
- Project/app identity info ("my startup is called X", "we're building Y")
- Important decisions or choices made that should persist
- Facts about the user's work that will be useful in future sessions
- Instructions the user explicitly wants remembered

Do NOT use for:
- Generic greetings, small talk, or routine exchanges
- Transient status updates or temporary info
- Information that's already in the memory context
- Repetitive/low-signal conversation turns
- Passwords, API keys, auth tokens, private keys, session cookies, or full payment/account numbers

Keep the stored content concise and distilled - extract the key fact, not the whole conversation. Choose wiki_category/wiki_page/wiki_title so related learnings compound on a stable structured page instead of a generic note.`,
    parameters: rememberSchema,
  },

  recall: {
    description: `Search Datagran semantic memory for previously stored information. Use this when:
- You need more context about the user's projects, preferences, or past work
- Current conversation/tool context is insufficient for a reliable answer
- The user references something from a previous conversation
- You want to verify if you've already stored certain information

Use wiki_search/wiki_read instead when a named project, entity, standing decision, or inspectable structured page is the better source. Call both when either source could contain relevant context.
`,
    parameters: recallSchema,
  },

  wiki_search: {
    description: `Search the user's private structured Wiki.

Prefer this over semantic recall for named projects, entities, standing decisions, preferences, and reusable analyses. Read index.md first when you need to browse the Wiki's structure. Wiki knowledge is supplemental and never overrides newer current-thread or tool evidence.`,
    parameters: wikiSearchSchema,
  },

  wiki_read: {
    description: `Read one private Wiki page by its Wiki-relative path. Use this after wiki_search or after reading index.md. Returns null when the page does not exist.`,
    parameters: wikiReadSchema,
  },

  wiki_file_learning: {
    description: `Add one concise durable learning to the user's private structured Wiki without overwriting the page.

Use this when structured, inspectable knowledge is useful but semantic Datagran recall is unnecessary, or when the user explicitly asks to file something in the Wiki. Choose the most stable existing page/category. Related learnings should compound on one page rather than create isolated notes. Use remember instead when the fact should also be available through fuzzy semantic recall.

Never file transient status, small talk, generic knowledge, passwords, API keys, tokens, private keys, session cookies, or full payment/financial account numbers.`,
    parameters: wikiFileLearningSchema,
  },

  handshake_send: {
    description: `Send a message to the connected partner agent through the active handshake channel.
Use this to:
- Share results, data, or findings with the partner agent
- Request the partner agent to perform a complementary task
- Collaborate on the user's request by exchanging information

The partner agent will receive your message in their linked session context.`,
    parameters: handshakeSendSchema,
  },

  code_open_session: {
    description:
      "Open a configured Claude Code session (terminal) in the UI by session name. Use this when the user asks to open/switch to a specific coding session.",
    parameters: codeOpenSessionSchema,
  },

  code_terminal_step: {
    description:
      "Send input to an interactive Claude Code session running on the user's machine and return the resulting terminal output. Use this to operate Claude Code as an interactive relay (WhatsApp @code).",
    parameters: codeTerminalStepSchema,
  },

  terminal_exec: {
    description:
      "Run local shell commands for automation, diagnostics, builds, installs, and operational self-healing. Prefer code_cli_run for large multi-file coding tasks.",
    parameters: terminalExecSchema,
  },

  groovy_ops_knowledge: {
    description:
      "Get operational knowledge about Groovy's infrastructure for diagnosing and fixing issues. Use this BEFORE running terminal commands when the user reports connector problems, WhatsApp disconnections, relay issues, or asks you to check/fix/restart Groovy components. Prefer restart-first recovery and avoid destructive resets unless explicitly needed.",
    parameters: groovyOpsKnowledgeSchema,
  },

  code_cli_run: {
    description:
      "Run Claude Code for complex coding workflows: multi-file edits, refactors, debugging loops, and feature work in a repo. Required params: prompt (what to do), cwd (absolute path to repo).",
    parameters: codeCliRunSchema,
  },

  whatsapp_resolve_recipient: {
    description:
      "Resolve a WhatsApp recipient (DM or group) by display name or phone number using the local WhatsApp Web connector. Returns candidate chats and, when derivable for a direct message, phoneE164/phoneDigits metadata that can be reused for Twilio tools. Do not send messages with this tool.",
    parameters: whatsappResolveRecipientSchema,
  },

  whatsapp_send_text: {
    description:
      "Send a WhatsApp message (text) to a resolved chat_id using the local WhatsApp Web connector. Pass recipient_query when available so the connector can guard against stale/mismatched chat_id sends.",
    parameters: whatsappSendTextSchema,
  },
  whatsapp_send_media: {
    description:
      "Send a WhatsApp media message (image/file) to a chat_id using the local WhatsApp Web connector. Prefer direct URL or storage_path/file_id for session-tracked files; use local_path only for connector-generated local files that were just verified to exist on the connector. `filename` may be a friendly display name, but keep its extension aligned with the actual file type. Pass recipient_query when available so the connector can guard against stale/mismatched chat_id sends.",
    parameters: whatsappSendMediaSchema,
  },

  telegram_resolve_recipient: {
    description:
      "Find a Telegram user or group from known contacts by display name or @username. Returns candidates the bot has previously interacted with. Do not send messages with this tool.",
    parameters: telegramResolveRecipientSchema,
  },
  telegram_send_text: {
    description:
      "Send a Telegram text message to a chat_id. Include message_thread_id when sending to a forum topic. Max 4096 chars.",
    parameters: telegramSendTextSchema,
  },
  telegram_send_media: {
    description:
      "Send a Telegram media message (image/file) to a chat_id. Prefer URL for media source. Include message_thread_id for forum topics.",
    parameters: telegramSendMediaSchema,
  },
  telegram_create_topic: {
    description:
      "Create a new forum topic (thread) in a Telegram supergroup. The group must have forum mode enabled. Returns the message_thread_id for the new topic.",
    parameters: telegramCreateTopicSchema,
  },

  start_twilio_call: {
    description:
      "Start a supervised outbound phone call through Aiyra/Twilio for this orchestrator session. Prefer passing `to` dynamically per turn unless the user explicitly wants the configured default destination. If voicemail answers, leave a voicemail instead of ending silently, and send a brief SMS follow-up too when it would materially help.",
    parameters: startTwilioCallSchema,
  },

  start_twilio_sms: {
    description:
      "Start a supervised outbound SMS thread through Aiyra/Twilio for this orchestrator session. This thread is persistent, so later status/coaching calls refer back to the same session-bound child.",
    parameters: startTwilioSmsSchema,
  },

  coach_twilio_child: {
    description:
      "Send a coaching instruction to the current supervised Twilio child (call or SMS thread) for this orchestrator session.",
    parameters: coachTwilioChildSchema,
  },

  get_twilio_child_status: {
    description:
      "Get the latest supervised Twilio child status for this orchestrator session. Use this for delayed SMS replies and long-lived supervised threads.",
    parameters: getTwilioChildStatusSchema,
  },

  linkdb_init: {
    description:
      "Initialize the local Link Inbox database (SQLite) on the user's machine. Creates the DB and tables if missing.",
    parameters: linkdbInitSchema,
  },
  linkdb_upsert_links: {
    description:
      "Upsert a batch of links into the local Link Inbox database (SQLite). Use this when the user sends links to store.",
    parameters: linkdbUpsertLinksSchema,
  },
  linkdb_update: {
    description:
      "Update a stored link (summary/tags/note/read status) in the local Link Inbox database (SQLite).",
    parameters: linkdbUpdateSchema,
  },
  linkdb_query: {
    description:
      "Search the local Link Inbox database (SQLite) by text and/or tags to find stored links.",
    parameters: linkdbQuerySchema,
  },
  linkdb_digest: {
    description:
      "Fetch a digest of recent/unread links from the local Link Inbox database (SQLite). Useful for weekly reminders.",
    parameters: linkdbDigestSchema,
  },

  sqlite_list: {
    description:
      "List available local SQLite project databases under ~/.groovy/sqlite on the user's machine (via connector).",
    parameters: sqliteListSchema,
  },
  sqlite_exec: {
    description:
      "Execute SQL statements against a local project SQLite database on the user's machine. Use this to create arbitrary schemas/tables for different projects.",
    parameters: sqliteExecSchema,
  },
  sqlite_query: {
    description:
      "Run a SELECT query against a local project SQLite database on the user's machine. Returns either JSON (preferred) or CSV.",
    parameters: sqliteQuerySchema,
  },

  sqlite_project_list: {
    description:
      "List registered SQLite projects (name -> dbKey mapping) from the central registry DB (~/.groovy/sqlite/_registry.sqlite).",
    parameters: sqliteProjectListSchema,
  },
  sqlite_project_get_or_create: {
    description:
      "Resolve a human project name to a stable dbKey, creating a registry entry if missing. Use this BEFORE sqlite_exec/sqlite_query for project workflows.",
    parameters: sqliteProjectGetOrCreateSchema,
  },
  sqlite_project_update: {
    description:
      "Update a project registry entry (rename, description, tags) for a given dbKey in the central registry.",
    parameters: sqliteProjectUpdateSchema,
  },

  files_agent_request: {
    description: `Send a request to the Files agent to create documents, charts, or visualizations. Use this when the user asks to:
- Create an Excel file / spreadsheet
- Generate a chart (pie chart, bar chart, etc.)
- Create a visualization from data
- Export data to a file
- Analyze or transform previously uploaded documents

IMPORTANT LIMITATION:
- Files agent can prepare analysis/mappings/SQL, but it does NOT execute database writes.
- If the user asked to update/backfill a DB, call data_query after files_agent_request to perform the actual mutation and verification.
- After every files_agent_request, run a completion checkpoint against the original user ask:
  if the ask includes DB mutation intent (backfill/update/populate/fix data), do NOT finalize until data_query mutation + verification SELECT are executed.

The Files agent has access to the conversation history including any previously uploaded/analyzed files. It can create new Excel files, charts, and visualizations based on data from earlier in the conversation.`,
    parameters: filesAgentRequestSchema,
  },

  ai_agent_delegate: {
    description: `Delegate a task to one of the user's configured AI chat agents. Use this when:
- The user asks for something a specialized agent can handle (image generation, coding, etc.)
- You know the user has a configured agent with the capability needed
- The task matches an agent's specialty (check the agent list in system prompt)

The agent will process the request and return a response.`,
    parameters: aiAgentDelegateSchema,
  },

  runtime_branch_parallel: {
    description: `Spawn hidden parallel worker branches for independent subtasks, including local connector work, then return all worker summaries in one result.

Use this only when the work naturally decomposes into separate subtasks that can run in parallel.

Important:
- This tool is controlled by Branch Controller settings.
- maxBranches limits how many workers can run at once.
- maxTurnsPerBranch becomes the per-worker execution budget.
- mode=read_only still allows analysis branches, but write-like tool calls inside those workers will be blocked.
- This requires the local Groovy Connector to be online.
- Worker branches can use connector-local browser/files/terminal/code tools; the runtime will queue and resume those local steps automatically.`,
    parameters: runtimeBranchParallelSchema,
  },

  skill_registry_list: {
    description:
      "List draft and live reusable skills for the current orchestrator agent so you can reuse or update them instead of creating duplicates.",
    parameters: z.object({}),
  },

  skill_registry_create_draft: {
    description: `Create or update a reusable skill draft.

Lifecycle rule:
- Drafts are NOT live tools yet.
- After creating a draft, you must validate it with skill_registry_validate_draft.
- Only after validation succeeds should you call skill_registry_activate_draft.`,
    parameters: skillRegistryCreateDraftSchema,
  },

  skill_registry_validate_draft: {
    description: `Run a concrete validation task against a draft skill.

The validation output MUST include the __SKILL_VALIDATION__ marker appended by the validator.
Do not activate the skill unless validation clearly passes.`,
    parameters: skillRegistryValidateDraftSchema,
  },

  skill_registry_activate_draft: {
    description: `Activate the latest draft version of a skill only after validation output shows PASS.

This promotes the skill to a live canary tool for future turns.`,
    parameters: skillRegistryActivateDraftSchema,
  },

  list_agents: {
    description:
      "List the user's worker agents (name, harness claude/codex, model, workspace, device online state, open task count). Use when you need the roster before assigning work.",
    parameters: listAgentsSchema,
  },

  list_skills_and_docs: {
    description:
      "List the shared Skills & Docs library and its current orchestrator/worker assignments. Use this before assigning when the artifact name is not exact.",
    parameters: listSkillsAndDocsSchema,
  },

  assign_skill_or_doc: {
    description:
      "Persistently assign one shared skill or Markdown instruction doc to the orchestrator, all Claude agents, all Codex agents, or one named worker. The assignment applies on the next run and is also visible in Skills & Docs.",
    parameters: assignSkillOrDocSchema,
  },

  remove_skill_or_doc_assignment: {
    description:
      "Remove a persisted Skills & Docs assignment from the orchestrator, a harness group, or one named worker. Resolve the exact artifact and destination before calling.",
    parameters: removeSkillOrDocAssignmentSchema,
  },

  assign_task: {
    description: `Assign a task to one of the user's worker agents (a Claude Code or Codex CLI harness running on their machine). Workers have full file access, terminals, and repo context in their configured workspace.

Use this whenever work should happen in a workspace: coding, refactors, file edits, running commands, repo analysis. The task runs in the background; you get the task id immediately and the completion result arrives as a follow-up event. Mention the worker by the user's @mention when they named one; otherwise pick the best-suited worker from the roster.`,
    parameters: assignTaskSchema,
  },

  consult_agent: {
    description: `Consult a specific worker agent in read-only mode so the orchestrator can inspect that agent's real workspace before writing a plan. The worker explores files, symbols, architecture, tests, and repository state and returns a structured evidence brief inline. Use planning_session_id for targeted follow-up consultations. After enough evidence is collected, the orchestrator must write the final plan and call finalize_plan.`,
    parameters: consultAgentSchema,
  },

  finalize_plan: {
    description:
      "Persist the orchestrator's synthesized plan as the approvable plan for a consult_agent planning session. Call this after repository consultation and before presenting the final plan to the user.",
    parameters: finalizePlanSchema,
  },

  check_agent_status: {
    description:
      "Check worker agents' current state: running/queued tasks, last results, device online state. Use before assigning to a busy agent or when the user asks what agents are doing.",
    parameters: checkAgentStatusSchema,
  },

  collect_result: {
    description:
      "Fetch the full result of a completed task by id (use after assign_task when you need the details).",
    parameters: collectResultSchema,
  },

  transfer_context: {
    description:
      'Move a summarized briefing of one agent\'s work into another agent. Source can be a worker agent or "orchestrator" (this conversation). The receiving agent gets the briefing prepended to its next task.',
    parameters: transferContextSchema,
  },

  usage_report: {
    description:
      "Read-only usage & cost report grouped by agent (tokens, spend per model, task outcomes). Use when the user asks about spend, wants to compare agents/models, or asks to optimize costs. Base recommendations on cost vs. task success — e.g. suggest a cheaper model for an agent whose tasks succeed regardless.",
    parameters: usageReportSchema,
  },

  schedule_create: {
    description:
      "Create a scheduled job that will run through the user's Groovy Connector. For kind=orchestrator, pass agent when the user names a worker (for example Scout); omit agent only when the Orchestrator should run it. When the user names a model or reasoning effort, pass model/provider/reasoning_effort explicitly instead of only mentioning it in task text. Use for requests like 'every day at 7:30 have Scout triage new issues using gpt-5.6-luna', 'tomorrow at 9 run ...', or 'every 15 minutes run ...'.",
    parameters: scheduleCreateSchema,
  },

  schedule_list: {
    description: "List scheduled jobs for the current user (optionally filtered by device).",
    parameters: scheduleListSchema,
  },

  schedule_pause: {
    description: "Pause/disable a scheduled job (it will not run until resumed).",
    parameters: scheduleIdSchema,
  },

  schedule_resume: {
    description: "Resume/enable a paused scheduled job.",
    parameters: scheduleIdSchema,
  },

  schedule_cancel_next: {
    description:
      "Cancel the next scheduled run of a job (skip once), but keep the job.",
    parameters: scheduleIdSchema,
  },

  schedule_delete: {
    description: "Delete a scheduled job permanently.",
    parameters: scheduleIdSchema,
  },

  // Site Builder tools
  site_dev: {
    description:
      "Start or stop a local Next.js dev server for a generated site. The site is accessible via a live-preview iframe in the dashboard. Files in ~/.groovy/sites/<slug>/ are served with HMR.",
    parameters: siteDevSchema,
  },
  site_publish: {
    description:
      "Deploy a generated site to Vercel (production). Reads files from the local site folder, sanitizes them (enforces static export, strips secrets), uploads to Vercel, and polls build logs. Returns the live URL on success or build errors on failure.",
    parameters: sitePublishSchema,
  },
  site_attach_domain: {
    description:
      "Attach a custom domain to a deployed site. Returns DNS instructions (TXT verification + A/CNAME records) the user needs to add at their registrar.",
    parameters: siteAttachDomainSchema,
  },
  site_verify_domain: {
    description:
      "Verify a custom domain after the user has added DNS records. Returns verified=true if successful.",
    parameters: siteVerifyDomainSchema,
  },
  site_delete: {
    description:
      "Permanently delete a generated site. Removes the Vercel project, all deployments, custom domains, and the database record. This cannot be undone.",
    parameters: siteDeleteSchema,
  },
  site_unpublish: {
    description:
      "Take a site offline without deleting it. Removes the live Vercel deployment but keeps the project and local files so the user can redeploy later.",
    parameters: siteUnpublishSchema,
  },
};

function isSignedUrl(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    const path = url.pathname.toLowerCase();
    if (path.includes("/storage/v1/object/sign/")) return true;
    const sensitiveKeys = [
      "token",
      "sig",
      "signature",
      "expires",
      "expiry",
      "x-amz-signature",
      "x-amz-credential",
      "x-amz-security-token",
      "x-goog-signature",
      "x-goog-credential",
      "x-goog-expires",
    ];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some((s) => lower.includes(s))) return true;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

function sanitizeFilesForModel(files: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(files)) return [];
  return files
    .map((raw) => {
      const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      if (!f) return null;
      const name =
        (typeof f.name === "string" && f.name) ||
        (typeof f.filename === "string" && f.filename) ||
        "output";
      const mediaType =
        (typeof f.mediaType === "string" && f.mediaType) ||
        (typeof f.mime_type === "string" && f.mime_type) ||
        "application/octet-stream";
      const storagePath =
        typeof f.storage_path === "string" && f.storage_path.trim()
          ? f.storage_path.trim()
          : undefined;
      const fileId =
        typeof f.file_id === "string" && f.file_id.trim()
          ? f.file_id.trim()
          : undefined;
      const url =
        typeof f.url === "string" && f.url.trim() && !isSignedUrl(f.url)
          ? f.url.trim()
          : undefined;

      const safe: Record<string, unknown> = {
        name,
        mediaType,
      };
      if (storagePath) safe.storage_path = storagePath;
      if (fileId) safe.file_id = fileId;
      // Keep URL only if it is not token-bearing/signed.
      if (url) safe.url = url;
      return safe;
    })
    .filter((f): f is Record<string, unknown> => !!f);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDataQueryReauthPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...raw,
    needsReauth: true,
  };
  const provider = toOptionalString(raw.provider);
  const agentId = toOptionalString(raw.agentId);
  const linkToken = toOptionalString(raw.linkToken);
  if (provider) normalized.provider = provider;
  if (agentId) normalized.agentId = agentId;
  if (linkToken) normalized.linkToken = linkToken;
  return normalized;
}

function normalizeSessionUnauthorizedPayload(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...raw,
    sessionUnauthorized: true,
    blockedForRun: true,
  };
  const provider = toOptionalString(raw.provider);
  const agentId = toOptionalString(raw.agentId);
  const message =
    toOptionalString(raw.message) ||
    "Data agent request is unauthorized for this session. Refresh/re-login, then retry.";
  if (provider) normalized.provider = provider;
  if (agentId) normalized.agentId = agentId;
  normalized.message = message;
  return normalized;
}

function normalizeDataQueryNonRetryablePayload(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...raw,
    dataQueryBlocked: true,
    reason: "non_retryable_error",
    retryable: false,
    blockedForRun: true,
  };
  const provider = toOptionalString(raw.provider);
  const agentId = toOptionalString(raw.agentId);
  const message =
    toOptionalString(raw.message) ||
    "The data provider returned repeated non-retryable API errors. Do not retry data_query again in this run.";
  const answerRaw =
    toOptionalString(raw.answer) || toOptionalString(raw.agentResponse) || "";
  const answer = answerRaw ? answerRaw.slice(0, 2000) : undefined;
  if (provider) normalized.provider = provider;
  if (agentId) normalized.agentId = agentId;
  normalized.message = message;
  if (answer) normalized.answer = answer;
  return normalized;
}

/**
 * Execute a tool call and return the result
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<string> {
  if (toolName === "data_query" && context.dataQueryReauthState?.blocked) {
    const blockedReason = context.dataQueryReauthState.reason || "session_unauthorized";
    if (blockedReason === "provider_reauth") {
      return JSON.stringify({
        needsReauth: true,
        provider: context.dataQueryReauthState.provider,
        agentId: context.dataQueryReauthState.agentId,
        linkToken: context.dataQueryReauthState.linkToken,
        blockedForRun: true,
        message:
          context.dataQueryReauthState.message ||
          "Data agent re-authorization is required. Additional data_query calls are blocked for this run.",
      });
    }
    if (blockedReason === "session_unauthorized") {
      return JSON.stringify({
        sessionUnauthorized: true,
        provider: context.dataQueryReauthState.provider,
        agentId: context.dataQueryReauthState.agentId,
        blockedForRun: true,
        message:
          context.dataQueryReauthState.message ||
          "Data agent request is unauthorized for this session. Refresh/re-login, then retry.",
      });
    }
    if (blockedReason === "non_retryable_error") {
      return JSON.stringify({
        dataQueryBlocked: true,
        reason: "non_retryable_error",
        retryable: false,
        provider: context.dataQueryReauthState.provider,
        agentId: context.dataQueryReauthState.agentId,
        blockedForRun: true,
        message:
          context.dataQueryReauthState.message ||
          "A prior data_query call returned non-retryable provider errors. Do not call data_query again in this run.",
      });
    }
    return JSON.stringify({
      dataQueryBlocked: true,
      reason: blockedReason,
      provider: context.dataQueryReauthState.provider,
      agentId: context.dataQueryReauthState.agentId,
      blockedForRun: true,
      message:
        context.dataQueryReauthState.message ||
        "Additional data_query calls are blocked for this run.",
    });
  }

  const result = await executeTool(toolName, args, context);

  if (!result.success) {
    if (toolName === "data_query" && result.result && typeof result.result === "object") {
      const dataError = result.result as Record<string, unknown>;
      if (dataError.needsReauth === true) {
        const normalized = normalizeDataQueryReauthPayload(dataError);
        context.dataQueryReauthState = {
          blocked: true,
          reason: "provider_reauth",
          provider: toOptionalString(normalized.provider),
          agentId: toOptionalString(normalized.agentId),
          linkToken: toOptionalString(normalized.linkToken),
          message: toOptionalString(normalized.message),
        };
        return JSON.stringify(normalized);
      }
      if (dataError.sessionUnauthorized === true) {
        const normalized = normalizeSessionUnauthorizedPayload(dataError);
        context.dataQueryReauthState = {
          blocked: true,
          reason: "session_unauthorized",
          provider: toOptionalString(normalized.provider),
          agentId: toOptionalString(normalized.agentId),
          message: toOptionalString(normalized.message),
        };
        return JSON.stringify(normalized);
      }
      if (dataError.nonRetryable === true || dataError.retryable === false) {
        const normalized = normalizeDataQueryNonRetryablePayload(dataError);
        context.dataQueryReauthState = {
          blocked: true,
          reason: "non_retryable_error",
          provider: toOptionalString(normalized.provider),
          agentId: toOptionalString(normalized.agentId),
          message: toOptionalString(normalized.message),
        };
        return JSON.stringify(normalized);
      }
    }
    return `Error: ${result.error}`;
  }

  // Format result based on tool type

  // files_agent_request is a PREP tool. The sub-agent has NO database/network access.
  // Its output often says "I don't have DB access" which can confuse the orchestrator
  // into thinking the whole system lacks DB access. Summarize the actionable parts and
  // inject a hard continuation directive.
  if (toolName === "files_agent_request") {
    const raw = result.result as { response?: string; generatedFiles?: unknown[]; files?: unknown[] } | null;
    const responseText = typeof raw?.response === "string" ? raw.response : "";
    const files = Array.isArray(raw?.generatedFiles)
      ? raw.generatedFiles
      : Array.isArray(raw?.files)
        ? raw.files
        : [];
    const modelSafeFiles = sanitizeFilesForModel(files);

    const MAX_RESPONSE = 4000;
    const trimmedResponse = responseText.length > MAX_RESPONSE
      ? "...(earlier analysis omitted)\n" + responseText.slice(-MAX_RESPONSE)
      : responseText;

    const summary: Record<string, unknown> = {
      filesAgentResponse: trimmedResponse,
    };
    if (modelSafeFiles.length > 0) summary.generatedFiles = modelSafeFiles;

    return (
      JSON.stringify(summary) +
      "\n\n[SYSTEM DIRECTIVE — READ CAREFULLY]\n" +
      "The Files agent above is a sandboxed sub-agent with NO database access.\n" +
      "Any statement like 'I don't have DB access' describes the sub-agent's limitation, NOT yours.\n" +
      "YOU (the orchestrator) DO have database access via the data_query tool.\n" +
      "Review the user's ORIGINAL request now:\n" +
      "- If they asked to UPDATE/INSERT/DELETE/backfill rows → call data_query(provider='postgres', query='<the SQL from above>').\n" +
      "- If they asked for anything else beyond file creation → call the appropriate tool.\n" +
      "- Only stop if the user ONLY asked for file creation/analysis and nothing more.\n" +
      "Do NOT repeat the sub-agent's limitations to the user. Execute the next step."
    );
  }

  if (toolName === "data_query") {
    // Always return structured JSON for data_query so continuation rounds (and the model)
    // reliably get complete context. Returning only agentResponse as a string causes
    // downstream truncation/partial-context issues when combined with connector tools.
    const raw = result.result;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.needsReauth === true) {
        const normalized = normalizeDataQueryReauthPayload(obj);
        context.dataQueryReauthState = {
          blocked: true,
          reason: "provider_reauth",
          provider: toOptionalString(normalized.provider),
          agentId: toOptionalString(normalized.agentId),
          linkToken: toOptionalString(normalized.linkToken),
          message: toOptionalString(normalized.message),
        };
        return JSON.stringify(normalized);
      }
      const safe: Record<string, unknown> = { ...obj };
      if (Array.isArray(obj.files)) {
        safe.files = sanitizeFilesForModel(obj.files);
      }
      if (Array.isArray(obj.generatedFiles)) {
        safe.generatedFiles = sanitizeFilesForModel(obj.generatedFiles);
      }
      return JSON.stringify(safe);
    }
    return JSON.stringify(raw);
  }

  if (toolName === "remember") {
    const params = args as z.infer<typeof rememberSchema>;
    const stored =
      result.result && typeof result.result === "object"
        ? (result.result as Record<string, unknown>)
        : {};
    const wikiPath =
      typeof stored.wikiPath === "string" && stored.wikiPath
        ? ` Wiki: ${stored.wikiPath}.`
        : stored.wikiReason
          ? ` Wiki filing: ${String(stored.wikiReason)}.`
          : "";
    const datagranStatus =
      stored.datagranStored === false
        ? " Datagran semantic storage did not complete."
        : "";
    return `Remembered: "${params.content}"${params.label ? ` (${params.label})` : ""}.${wikiPath}${datagranStatus}`;
  }

  if (toolName === "recall") {
    const memories = result.result;
    if (!memories || (Array.isArray(memories) && memories.length === 0)) {
      return "No relevant memories found.";
    }

    // queryMemoryDirect returns { context, data }. The `context` string is already
    // built from `data` (answer + short/mid/long-term + evidence), so returning both
    // duplicates everything. Return only `context` and let the orchestrator LLM
    // interpret dates, trace IDs, agents, etc.
    if (typeof memories === "object" && memories !== null && !Array.isArray(memories)) {
      const mem = memories as { context?: string; data?: { answer?: string } | null };
      const ctx = mem.context;
      if (ctx && typeof ctx === "string" && ctx.trim()) {
        const MAX = 6000;
        return ctx.length > MAX ? ctx.slice(0, MAX) + "\n...(truncated)" : ctx;
      }
      // No context but maybe an answer directly on data
      const answer = mem.data?.answer;
      if (answer && typeof answer === "string" && answer.trim()) {
        return answer.trim();
      }
    }

    // Fallback: stringify but cap size to prevent prompt explosion.
    const raw = JSON.stringify(memories);
    const MAX = 6000;
    return raw.length > MAX ? raw.slice(0, MAX) + "\n...(truncated)" : raw;
  }

  return JSON.stringify(result.result);
}

function getOpsPlaybook(
  topic: GroovyOpsKnowledgeTopic,
  connectorPlatform: ConnectorClientPlatform = "unknown"
): string {
  const isWindows = connectorPlatform === "windows";
  const isMac = connectorPlatform === "macos";
  const platformLabel = isWindows ? "windows" : isMac ? "macos" : "unknown";
  let configuredAppUrl = "<GROOVY_APP_URL>";
  try {
    configuredAppUrl = getAppUrl();
  } catch {
    // Deployment configuration is intentionally shown as a required placeholder.
  }
  const configuredRelayUrl = getRelayUrl() || "<GROOVY_RELAY_URL>";

  const connector = isWindows
    ? `## CONNECTOR (Windows)
- Main process: connector.mjs, usually managed by Task Scheduler ("Groovy Connector")
- Single-instance lock: %USERPROFILE%\\.groovy\\connector.lock
- Core config: %USERPROFILE%\\.groovy\\connector.json
- Common conflict: stale node process or stale lock file blocks startup

Diagnostics:
- schtasks /query /tn "Groovy Connector" /fo list
- type "%USERPROFILE%\\.groovy\\connector.lock"
- tasklist | findstr /I node

Fixes:
- Clean restart:
  - taskkill /f /im node.exe 2>nul
  - del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul
  - schtasks /run /tn "Groovy Connector"
- Manual foreground run (debug):
  - taskkill /f /im node.exe 2>nul
  - del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul
  - cd "%LOCALAPPDATA%\\GroovyConnector" && node connector.mjs --whatsapp --whatsapp-group "Groovy"`
    : isMac
      ? `## CONNECTOR (macOS)
- Main process: connector.mjs, usually managed by LaunchAgent with KeepAlive
- Single-instance lock: ~/.groovy/connector.lock
- Core config: ~/.groovy/connector.json
- Common conflict: manual connector run + LaunchAgent auto-restart causes lock churn

CRITICAL: The connector calls installLaunchAgent() on startup which re-creates and re-loads
the plist. This means even after "launchctl unload", a manual run will re-install the
LaunchAgent, which spawns an /Applications/ instance that kills your manual run.
To prevent this, ALWAYS pass --no-autostart when running from the repo.

Diagnostics:
- ps aux | grep connector.mjs
- cat ~/.groovy/connector.lock
- launchctl list | grep gogroovy

Fixes:
- Let LaunchAgent own process: pkill -f "connector.mjs"
- Dev restart from repo (full clean restart):
  - First read the group name: cat ~/.groovy/connector.json | grep whatsapp_group_name
    (it will be "Groovy" for personal WhatsApp or "Kapso" or other name for company mode)
  - launchctl unload ~/Library/LaunchAgents/ai.gogroovy.connector.plist 2>/dev/null
  - rm -f ~/Library/LaunchAgents/ai.gogroovy.connector.plist
  - pkill -f "connector.mjs" || true
  - pkill -f "whatsapp-web-session" || true
  - sleep 2
  - cd apps/connector && WHATSAPP_GROUP_NAME="<group_name_from_config>" GROOVY_APP_URL="${configuredAppUrl}" node connector.mjs --relay "${configuredRelayUrl}" --whatsapp --kill-others --no-autostart
- To go back to LaunchAgent-managed mode:
  - pkill -f "connector.mjs"
  - open /Applications/Groovy\\ Connector.app
- Clear stale lock only if no connector process is running:
  - rm -f ~/.groovy/connector.lock`
      : `## CONNECTOR (Unknown platform)
- Platform was not provided in tool context.
- Determine platform first:
  - macOS check: sw_vers
  - Windows check: ver
- Restart templates:
  - macOS: pkill -f "connector.mjs" && rm -f ~/.groovy/connector.lock
  - Windows: taskkill /f /im node.exe 2>nul && del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul && schtasks /run /tn "Groovy Connector"`;

  const whatsapp = isWindows
    ? `## WHATSAPP WEB BRIDGE
- Session dir: %USERPROFILE%\\.groovy\\whatsapp-web-session
- Bridge state/welcome tracking: %USERPROFILE%\\.groovy\\whatsapp-bridge.json
- Uses whatsapp-web.js + Puppeteer; if Chrome is missing, Edge fallback is used
- Group selected by WHATSAPP_GROUP_NAME

Diagnostics:
- powershell -NoProfile -Command "Get-Content \\"$env:USERPROFILE\\\\.groovy\\\\connector.log\\" -Tail 120"
- Verify WhatsApp flags/config: whatsapp_enabled + whatsapp_group_name

Fixes:
- Restart without deleting WhatsApp session (first):
  - taskkill /f /im node.exe 2>nul
  - del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul
  - schtasks /run /tn "Groovy Connector"
- Force WhatsApp re-link (last resort; requires QR scan):
  - rmdir /s /q "%USERPROFILE%\\.groovy\\whatsapp-web-session"
  - taskkill /f /im node.exe 2>nul
  - schtasks /run /tn "Groovy Connector"
- Reset bridge state:
  - del "%USERPROFILE%\\.groovy\\whatsapp-bridge.json" /f /q 2>nul`
    : isMac
      ? `## WHATSAPP WEB BRIDGE
- Session dir: ~/.groovy/whatsapp-web-session
- Bridge state/welcome tracking: ~/.groovy/whatsapp-bridge.json
- Uses whatsapp-web.js + Puppeteer; group selected by WHATSAPP_GROUP_NAME
- If session breaks, re-auth by deleting session dir and rescanning QR

Symptom: WhatsApp stuck at "pinning WhatsApp Web version" and never reaches "authenticated"
  -> This means Chrome launched but the WhatsApp session is corrupted/stale.
  -> Fix: nuke session dir, kill stale Chrome processes, restart. User must re-scan QR.

Diagnostics:
- tail -n 120 ~/.groovy/connector.log | grep -Ei "whatsapp|qr|session|group|bridge|pinning|authenticated|ready"
- ps aux | grep whatsapp-web-session  (check for stale Chrome processes)
- Check env/config for group name mismatch (WHATSAPP_GROUP_NAME)

Fixes:
- Restart without deleting WhatsApp session (try first):
  - pkill -f "connector.mjs"  (LaunchAgent will restart)
- If stuck at "pinning WhatsApp Web version" (session corrupted):
  - pkill -f "connector.mjs" || true
  - pkill -f "whatsapp-web-session" || true
  - sleep 2
  - rm -rf ~/.groovy/whatsapp-web-session
  - Then restart connector (see CONNECTOR section for dev vs LaunchAgent restart)
  - User must re-scan QR code from WhatsApp mobile (Settings > Linked Devices)
- Reset bridge state if welcome messages are stale:
  - rm -f ~/.groovy/whatsapp-bridge.json`
      : `## WHATSAPP WEB BRIDGE (Unknown platform)
- Session dirs:
  - macOS: ~/.groovy/whatsapp-web-session
  - Windows: %USERPROFILE%\\.groovy\\whatsapp-web-session
- Restart-first templates:
  - macOS: pkill -f "connector.mjs"
  - Windows: taskkill /f /im node.exe 2>nul && del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul && schtasks /run /tn "Groovy Connector"
- Re-link templates (last resort; forces QR scan):
  - macOS: rm -rf ~/.groovy/whatsapp-web-session && pkill -f "connector.mjs"
  - Windows: rmdir /s /q "%USERPROFILE%\\.groovy\\whatsapp-web-session" && taskkill /f /im node.exe 2>nul && schtasks /run /tn "Groovy Connector"`;

  const relay = isWindows
    ? `## RELAY / SERVER CONNECTIVITY
- Connector pairs with relay and receives device_token
- Symptoms: online/offline flapping, repeated reconnects, tool calls timing out

Diagnostics:
- powershell -NoProfile -Command "Get-Content \\"$env:USERPROFILE\\\\.groovy\\\\connector.log\\" -Tail 120 | Select-String -Pattern 'relay|websocket|1006|device_token|pair'"
- Verify APP URL / relay URL in connector config

Fixes:
- Restart connector:
  - taskkill /f /im node.exe 2>nul
  - del "%USERPROFILE%\\.groovy\\connector.lock" /f /q 2>nul
  - schtasks /run /tn "Groovy Connector"
- If pairing is broken, re-pair connector from dashboard pairing flow`
    : isMac
      ? `## RELAY / SERVER CONNECTIVITY
- Connector pairs with relay and receives device_token
- API bridge calls require RELAY_JWT_SECRET compatibility on server
- Symptoms: connector online/offline flapping, repeated reconnects, tool calls timing out

Diagnostics:
- tail -n 120 ~/.groovy/connector.log | grep -Ei "relay|websocket|1006|device_token|pair"
- Verify app URL and relay URL settings in connector config/env

Fixes:
- Restart connector:
  - pkill -f "connector.mjs"
- If pairing state is broken, re-pair connector (regenerate pairing code and pair again)
- If LaunchAgent points to stale path, reload or reinstall agent:
  - launchctl unload ~/Library/LaunchAgents/ai.gogroovy.connector.plist
  - launchctl load ~/Library/LaunchAgents/ai.gogroovy.connector.plist`
      : `## RELAY / SERVER CONNECTIVITY (Unknown platform)
- Check logs for relay errors (websocket, 1006, device_token, pair)
- Restart templates:
  - macOS: pkill -f "connector.mjs"
  - Windows: taskkill /f /im node.exe 2>nul && schtasks /run /tn "Groovy Connector"
- If pairing is broken, re-pair connector from dashboard`;

  const logs = isWindows
    ? `## LOGS / TRIAGE
Key files:
- %USERPROFILE%\\.groovy\\connector.log
- %USERPROFILE%\\.groovy\\connector.json

Useful commands:
- powershell -NoProfile -Command "Get-Content \\"$env:USERPROFILE\\\\.groovy\\\\connector.log\\" -Tail 200"
- powershell -NoProfile -Command "Select-String -Path \\"$env:USERPROFILE\\\\.groovy\\\\connector.log\\" -Pattern 'error|exception|another connector instance|1006'"
- schtasks /query /tn "Groovy Connector" /fo list

Common issue mapping:
- "another connector instance is already running" -> lock/process conflict
- Frequent 1006 close codes -> relay/network instability
- QR keeps returning -> WhatsApp session dir invalid or expired
- Connector works but group commands fail -> wrong group name or missing bridge state`
    : isMac
      ? `## LOGS / TRIAGE
Key files:
- ~/.groovy/connector.log
- ~/.groovy/connector.json
- ~/Library/LaunchAgents/ai.gogroovy.connector.plist

Useful commands:
- tail -n 200 ~/.groovy/connector.log
- grep -En "error|exception|another connector instance|Execution context was destroyed|1006" ~/.groovy/connector.log
- launchctl list | grep gogroovy
- plutil -p ~/Library/LaunchAgents/ai.gogroovy.connector.plist

Common issue mapping:
- "another connector instance is already running" -> lock/process conflict
- Frequent 1006 close codes -> relay/network instability
- QR keeps returning -> WhatsApp session dir invalid or expired
- Connector works but group commands fail -> wrong group name or missing bridge state`
      : `## LOGS / TRIAGE (Unknown platform)
- Common log file locations:
  - macOS: ~/.groovy/connector.log
  - Windows: %USERPROFILE%\\.groovy\\connector.log
- Search for: error, exception, another connector instance, 1006, websocket`;

  if (topic === "connector") {
    return connector;
  }
  if (topic === "whatsapp") {
    return whatsapp;
  }
  if (topic === "relay") {
    return relay;
  }
  if (topic === "logs") {
    return logs;
  }

  return `# Groovy Ops Playbook
Detected connector platform: ${platformLabel}

Use this operational guide before terminal actions when debugging connector/WhatsApp/relay issues.

${connector}

${whatsapp}

${relay}

${logs}

## Execution Pattern
1) Run diagnostics first and collect evidence
2) Prefer minimal-impact fix (restart process before deleting state)
3) Treat WhatsApp session deletion (whatsapp-web-session) as last resort and state it will force QR re-link
4) Re-check logs after each fix
5) Report exactly what was run and what changed`;
}

/**
 * Create tools object for AI SDK streamText
 * This returns tool definitions compatible with the AI SDK v6
 * Using inputSchema instead of parameters per SDK requirements
 */
export function createExecutableTools(
  context: ToolExecutionContext,
  dynamicSkillTools: SkillRuntimeTool[] = [],
  dynamicExtensionTools: ExtensionRuntimeTool[] = []
) {
  // Create tools with execute handlers
  // The AI SDK will automatically call these when the model uses a tool
  
  const hasConnector = !!context.deviceId;
  // Agent mentions are routing hints, not tool locks.
  // Only explicit code-mode keeps a strict lock to code tools.
  const directAgent = (context.directAgent === "code" ? context.directAgent : null) as AgentType | null;
  
  // Explicit "computer use / visible browser" requests should keep the full toolset
  // but hide the legacy DOM browser tools so the model must use browser_task.
  const forceBrowserTaskOnly =
    hasConnector && (context.forceVisibleBrowserTask === true || directAgent === "browser");
  const forceObsidianOnly = hasConnector && directAgent === "obsidian";
  const forceDataOnly = directAgent === "data";
  const forceScheduleOnly = directAgent === "schedule";
  const forceCodeOnly = directAgent === "code";
  const forceFilesOrNoDirect = !directAgent;
  const forceFilesOrScheduleOrNoDirect =
    !directAgent || forceScheduleOnly;

  if (Array.isArray(dynamicExtensionTools) && dynamicExtensionTools.length > 0) {
    context.extensionToolsByName = indexExtensionRuntimeTools(dynamicExtensionTools);
  }

  const tools: Record<string, {
    description: string;
    inputSchema: z.ZodType<unknown>;
    execute: (args: unknown) => Promise<string>;
  }> = {};

  // Data tools - only when no directAgent, or directAgent is "data"
  if (!directAgent || forceDataOnly) {
    tools.data_query = {
      description: toolDefinitions.data_query.description,
      inputSchema: dataQuerySchema,
      execute: async (args: unknown) => {
        return executeToolCall("data_query", args as Record<string, unknown>, context);
      },
    };
    tools.data_upready_readiness = {
      description: toolDefinitions.data_upready_readiness.description,
      inputSchema: dataUpreadyReadinessSchema,
      execute: async (args: unknown) => {
        return executeToolCall("data_upready_readiness", args as Record<string, unknown>, context);
      },
    };
    tools.data_check_connection = {
      description: toolDefinitions.data_check_connection.description,
      inputSchema: dataCheckConnectionSchema,
      execute: async (args: unknown) => {
        return executeToolCall("data_check_connection", args as Record<string, unknown>, context);
      },
    };
  }

  // Worker-agent delegation tools (harness) — the orchestrator's core toolset.
  if (!directAgent) {
    tools.list_agents = {
      description: toolDefinitions.list_agents.description,
      inputSchema: listAgentsSchema,
      execute: async (args: unknown) => {
        return executeToolCall("list_agents", args as Record<string, unknown>, context);
      },
    };
    tools.list_skills_and_docs = {
      description: toolDefinitions.list_skills_and_docs.description,
      inputSchema: listSkillsAndDocsSchema,
      execute: async (args: unknown) => {
        return executeToolCall("list_skills_and_docs", args as Record<string, unknown>, context);
      },
    };
    tools.assign_skill_or_doc = {
      description: toolDefinitions.assign_skill_or_doc.description,
      inputSchema: assignSkillOrDocSchema,
      execute: async (args: unknown) => {
        return executeToolCall("assign_skill_or_doc", args as Record<string, unknown>, context);
      },
    };
    tools.remove_skill_or_doc_assignment = {
      description: toolDefinitions.remove_skill_or_doc_assignment.description,
      inputSchema: removeSkillOrDocAssignmentSchema,
      execute: async (args: unknown) => {
        return executeToolCall(
          "remove_skill_or_doc_assignment",
          args as Record<string, unknown>,
          context
        );
      },
    };
    tools.assign_task = {
      description: toolDefinitions.assign_task.description,
      inputSchema: assignTaskSchema,
      execute: async (args: unknown) => {
        return executeToolCall("assign_task", args as Record<string, unknown>, context);
      },
    };
    tools.consult_agent = {
      description: toolDefinitions.consult_agent.description,
      inputSchema: consultAgentSchema,
      execute: async (args: unknown) => {
        return executeToolCall("consult_agent", args as Record<string, unknown>, context);
      },
    };
    tools.finalize_plan = {
      description: toolDefinitions.finalize_plan.description,
      inputSchema: finalizePlanSchema,
      execute: async (args: unknown) => {
        return executeToolCall("finalize_plan", args as Record<string, unknown>, context);
      },
    };
    tools.check_agent_status = {
      description: toolDefinitions.check_agent_status.description,
      inputSchema: checkAgentStatusSchema,
      execute: async (args: unknown) => {
        return executeToolCall("check_agent_status", args as Record<string, unknown>, context);
      },
    };
    tools.collect_result = {
      description: toolDefinitions.collect_result.description,
      inputSchema: collectResultSchema,
      execute: async (args: unknown) => {
        return executeToolCall("collect_result", args as Record<string, unknown>, context);
      },
    };
    tools.transfer_context = {
      description: toolDefinitions.transfer_context.description,
      inputSchema: transferContextSchema,
      execute: async (args: unknown) => {
        return executeToolCall("transfer_context", args as Record<string, unknown>, context);
      },
    };
    tools.usage_report = {
      description: toolDefinitions.usage_report.description,
      inputSchema: usageReportSchema,
      execute: async (args: unknown) => {
        return executeToolCall("usage_report", args as Record<string, unknown>, context);
      },
    };
  }

  // Schedule tools - server-side, require connector for execution but CRUD can still be done.
  // Only shown when no directAgent, or directAgent is "schedule".
  if (!directAgent || forceScheduleOnly) {
    tools.schedule_create = {
      description: toolDefinitions.schedule_create.description,
      inputSchema: scheduleCreateSchema,
      execute: async (args: unknown) => {
        return executeToolCall("schedule_create", args as Record<string, unknown>, context);
      },
    };
    tools.schedule_list = {
      description: toolDefinitions.schedule_list.description,
      inputSchema: scheduleListSchema,
      execute: async (args: unknown) => {
        return executeToolCall("schedule_list", args as Record<string, unknown>, context);
      },
    };
    tools.schedule_pause = {
      description: toolDefinitions.schedule_pause.description,
      inputSchema: scheduleIdSchema,
      execute: async (args: unknown) => {
        return executeToolCall("schedule_pause", args as Record<string, unknown>, context);
      },
    };
    tools.schedule_resume = {
      description: toolDefinitions.schedule_resume.description,
      inputSchema: scheduleIdSchema,
      execute: async (args: unknown) => {
        return executeToolCall("schedule_resume", args as Record<string, unknown>, context);
      },
    };
    tools.schedule_cancel_next = {
      description: toolDefinitions.schedule_cancel_next.description,
      inputSchema: scheduleIdSchema,
      execute: async (args: unknown) => {
        return executeToolCall(
          "schedule_cancel_next",
          args as Record<string, unknown>,
          context
        );
      },
    };
    tools.schedule_delete = {
      description: toolDefinitions.schedule_delete.description,
      inputSchema: scheduleIdSchema,
      execute: async (args: unknown) => {
        return executeToolCall("schedule_delete", args as Record<string, unknown>, context);
      },
    };
  }

  // Site Builder tools
  // - `site_dev` + `site_publish` require a local connector.
  // - Domain/delete/unpublish tools are currently cookie-auth only.
  //   (WhatsApp/device-token flow exposes build/deploy via site_dev + site_publish.)
  const pagesScope = !directAgent || directAgent === "pages";
  const hasCookieAuth = Boolean(context.cookies);
  const hasDeviceTokenAuth = Boolean(context.deviceToken);
  if (pagesScope) {
    if (context.deviceId && (hasCookieAuth || hasDeviceTokenAuth)) {
      tools.site_dev = {
        description: toolDefinitions.site_dev.description,
        inputSchema: siteDevSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_dev", args as Record<string, unknown>, context);
        },
      };
      tools.site_publish = {
        description: toolDefinitions.site_publish.description,
        inputSchema: sitePublishSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_publish", args as Record<string, unknown>, context);
        },
      };
    }

    if (hasCookieAuth) {
      tools.site_attach_domain = {
        description: toolDefinitions.site_attach_domain.description,
        inputSchema: siteAttachDomainSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_attach_domain", args as Record<string, unknown>, context);
        },
      };
      tools.site_verify_domain = {
        description: toolDefinitions.site_verify_domain.description,
        inputSchema: siteVerifyDomainSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_verify_domain", args as Record<string, unknown>, context);
        },
      };
      tools.site_delete = {
        description: toolDefinitions.site_delete.description,
        inputSchema: siteDeleteSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_delete", args as Record<string, unknown>, context);
        },
      };
      tools.site_unpublish = {
        description: toolDefinitions.site_unpublish.description,
        inputSchema: siteUnpublishSchema,
        execute: async (args: unknown) => {
          return executeToolCall("site_unpublish", args as Record<string, unknown>, context);
        },
      };
    }
  }

  // Handshake tool - only available when an active handshake is set on the context
  if (context.activeHandshakeId && context.handshakePartnerSessionId) {
    tools.handshake_send = {
      description: toolDefinitions.handshake_send.description,
      inputSchema: handshakeSendSchema,
      execute: async (args: unknown) => {
        return executeToolCall("handshake_send", args as Record<string, unknown>, context);
      },
    };
  }

  // Memory tools - always available (useful across all agents)
  tools.remember = {
    description: toolDefinitions.remember.description,
    inputSchema: rememberSchema,
    execute: async (args: unknown) => {
      return executeToolCall("remember", args as Record<string, unknown>, context);
    },
  };
  tools.recall = {
    description: toolDefinitions.recall.description,
    inputSchema: recallSchema,
    execute: async (args: unknown) => {
      return executeToolCall("recall", args as Record<string, unknown>, context);
    },
  };
  tools.wiki_search = {
    description: toolDefinitions.wiki_search.description,
    inputSchema: wikiSearchSchema,
    execute: async (args: unknown) => {
      return executeToolCall("wiki_search", args as Record<string, unknown>, context);
    },
  };
  tools.wiki_read = {
    description: toolDefinitions.wiki_read.description,
    inputSchema: wikiReadSchema,
    execute: async (args: unknown) => {
      return executeToolCall("wiki_read", args as Record<string, unknown>, context);
    },
  };
  tools.wiki_file_learning = {
    description: toolDefinitions.wiki_file_learning.description,
    inputSchema: wikiFileLearningSchema,
    execute: async (args: unknown) => {
      return executeToolCall("wiki_file_learning", args as Record<string, unknown>, context);
    },
  };

  if (!directAgent) {
    tools.start_twilio_call = {
      description: toolDefinitions.start_twilio_call.description,
      inputSchema: startTwilioCallSchema,
      execute: async (args: unknown) => {
        return executeToolCall("start_twilio_call", args as Record<string, unknown>, context);
      },
    };
    tools.start_twilio_sms = {
      description: toolDefinitions.start_twilio_sms.description,
      inputSchema: startTwilioSmsSchema,
      execute: async (args: unknown) => {
        return executeToolCall("start_twilio_sms", args as Record<string, unknown>, context);
      },
    };
    tools.coach_twilio_child = {
      description: toolDefinitions.coach_twilio_child.description,
      inputSchema: coachTwilioChildSchema,
      execute: async (args: unknown) => {
        return executeToolCall("coach_twilio_child", args as Record<string, unknown>, context);
      },
    };
    tools.get_twilio_child_status = {
      description: toolDefinitions.get_twilio_child_status.description,
      inputSchema: getTwilioChildStatusSchema,
      execute: async (args: unknown) => {
        void args;
        return executeToolCall("get_twilio_child_status", {}, context);
      },
    };
  }

  // Code PTY relay tool - only when code terminal context exists.
  // Only shown when no directAgent, or directAgent is "code".
  if (context.codeTerminalId && (!directAgent || forceCodeOnly)) {
    tools.code_terminal_step = {
      description: toolDefinitions.code_terminal_step.description,
      inputSchema: codeTerminalStepSchema,
      execute: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const terminal_id =
          typeof a.terminal_id === "string" && a.terminal_id.trim()
            ? a.terminal_id.trim()
            : String(context.codeTerminalId || "");
        const cwd =
          typeof a.cwd === "string" && a.cwd.trim()
            ? a.cwd.trim()
            : typeof context.codeWorkspaceRootPath === "string" && context.codeWorkspaceRootPath.trim()
              ? context.codeWorkspaceRootPath.trim()
              : undefined;
        return executeToolCall(
          "code_terminal_step",
          {
            ...a,
            terminal_id,
            cwd,
          },
          context
        );
      },
    };
  }

  // Non-interactive terminal exec - requires connector.
  // Shown when no directAgent, or directAgent is "files" (local ops).
  if (hasConnector && forceFilesOrNoDirect && !context.disableTerminalExec) {
    tools.terminal_exec = {
      description: toolDefinitions.terminal_exec.description,
      inputSchema: terminalExecSchema,
      execute: async (args: unknown) => {
        return executeToolCall("terminal_exec", args as Record<string, unknown>, context);
      },
    };
    tools.groovy_ops_knowledge = {
      description: toolDefinitions.groovy_ops_knowledge.description,
      inputSchema: groovyOpsKnowledgeSchema,
      execute: async (args: unknown) => {
        const { topic } = groovyOpsKnowledgeSchema.parse(args ?? {});
        return getOpsPlaybook(topic, context.connectorPlatform || "unknown");
      },
    };
  }

  // Claude Code CLI (headless) - require connector and (API key OR CLI token)
  // Shown when no directAgent, or directAgent is "code" (coding ops).
  const forceCodeOrNoDirect = !directAgent || directAgent === "code";
  const hasCliAuth = !!(context.claudeCliToken || context.apiKeys?.anthropic);
  if (hasConnector && forceCodeOrNoDirect && hasCliAuth) {
    tools.code_cli_run = {
      description: toolDefinitions.code_cli_run.description,
      inputSchema: codeCliRunSchema,
      execute: async (args: unknown) => {
        // Determine auth: prefer CLI token (OAuth) over API key
        const useCliToken = !!context.claudeCliToken;
        const authSource = useCliToken
          ? "cli_token"
          : "api_key";
        const authOrigin = useCliToken
          ? "user"
          : context.apiKeys?.anthropic === process.env.ANTHROPIC_API_KEY
            ? "groovy"
            : "user";

        console.log("[code_cli_run] auth resolved", {
          method: authSource,
          source: authOrigin,
          hasCliToken: !!context.claudeCliToken,
          hasApiKey: !!context.apiKeys?.anthropic,
        });

        const params = args as Record<string, unknown>;
        const originalPrompt = typeof params.prompt === "string" ? params.prompt : "";

        const normalizeSiteSlug = (input: string) => {
          return input
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60);
        };

        const extractGroovySiteSlug = (text: string) => {
          if (!text) return null;
          const m = text.match(
            /(?:~|\/Users\/[^\s/]+)?\/\.groovy\/sites\/([a-z0-9][a-z0-9-]{0,80})/i
          );
          if (!m) return null;
          const slug = normalizeSiteSlug(m[1]);
          return slug ? slug : null;
        };

        const rawCwdFromArgs =
          typeof params.cwd === "string" && params.cwd.trim()
            ? params.cwd.trim()
            : undefined;
        const rawCwdFromContext =
          typeof context.codeWorkspaceRootPath === "string" && context.codeWorkspaceRootPath.trim()
            ? context.codeWorkspaceRootPath.trim()
            : undefined;

        let rawCwd = rawCwdFromArgs || rawCwdFromContext;

        // If the prompt references a Groovy site workspace, force cwd to that site path.
        // This prevents "cwd hallucinations" like /Users/jt/... or other usernames.
        const siteSlugFromPrompt = extractGroovySiteSlug(originalPrompt);
        const siteSlugFromCwd = rawCwd ? extractGroovySiteSlug(rawCwd) : null;
        const siteSlug = siteSlugFromPrompt || siteSlugFromCwd;
        if (siteSlug) {
          rawCwd = `~/.groovy/sites/${siteSlug}`;
        }

        const isSiteWorkspace = !!(
          rawCwd &&
          (rawCwd.includes("/.groovy/sites/") || rawCwd.includes("~/.groovy/sites/"))
        );
        const sitePathGuard =
          isSiteWorkspace && !originalPrompt.includes("CRITICAL WORKSPACE CONSTRAINT:")
            ? `\n\nCRITICAL WORKSPACE CONSTRAINT:\n` +
              `- ONLY read/write/edit files under: ${rawCwd}\n` +
              `- NEVER edit files outside that directory\n` +
              `- Use app/* as the ONLY Next.js app-router root (do NOT create/use src/app/*)\n` +
              `- If package.json is missing, scaffold once using Next.js template via Bash:\n` +
              `  npx create-next-app@latest . --js --app --use-npm --eslint --yes --no-tailwind --no-src-dir\n` +
              `- After scaffolding, do one primary edit pass for requested UI/content\n` +
              `- Avoid repeated file listing/verification loops; at most one quick verification read\n` +
              `- Do not touch unrelated repos or home-level project folders`
            : "";
        // For Groovy site workspaces, always allow a full coding toolset
        // so Claude can scaffold from Next.js and then edit files.
        const enforcedAllowedTools = isSiteWorkspace
          ? "Read,Edit,Bash,Write"
          : typeof params.allowed_tools === "string" && params.allowed_tools.trim()
            ? params.allowed_tools.trim()
            : undefined;
        const enrichedParams = {
          ...params,
          prompt: `${originalPrompt}${sitePathGuard}`,
          // When CLI token is available, send it as cli_token and omit api_key
          // so the connector sets CLAUDE_CODE_OAUTH_TOKEN instead of ANTHROPIC_API_KEY
          ...(useCliToken
            ? { cli_token: context.claudeCliToken, api_key: undefined }
            : { api_key: context.apiKeys?.anthropic }),
          // Default cwd to codeWorkspaceRootPath if available and not specified
          cwd: rawCwd,
          allowed_tools: enforcedAllowedTools,
          billing_billable: true,
          billing_charge_type: authOrigin === "groovy" ? "groovy_key" : "external_key_fee",
          billing_auth_origin: authOrigin,
          billing_auth_method: authSource,
        };
        return executeToolCall("code_cli_run", enrichedParams, context);
      },
    };
  }

  // WhatsApp tools - require connector (and WhatsApp bridge enabled on that connector).
  // Shown when no directAgent, or directAgent is "files"/"schedule" because scheduling
  // workflows frequently need recipient resolution + send in the same request.
  if (hasConnector && forceFilesOrScheduleOrNoDirect) {
    tools.whatsapp_resolve_recipient = {
      description: toolDefinitions.whatsapp_resolve_recipient.description,
      inputSchema: whatsappResolveRecipientSchema,
      execute: async (args: unknown) => {
        return executeToolCall("whatsapp_resolve_recipient", args as Record<string, unknown>, context);
      },
    };
    tools.whatsapp_send_text = {
      description: toolDefinitions.whatsapp_send_text.description,
      inputSchema: whatsappSendTextSchema,
      execute: async (args: unknown) => {
        return executeToolCall("whatsapp_send_text", args as Record<string, unknown>, context);
      },
    };
    tools.whatsapp_send_media = {
      description: toolDefinitions.whatsapp_send_media.description,
      inputSchema: whatsappSendMediaSchema,
      execute: async (args: unknown) => {
        return executeToolCall("whatsapp_send_media", args as Record<string, unknown>, context);
      },
    };
  }

  // Telegram tools - server-side execution via Telegram Bot API.
  // Available when user has a Telegram bot configured.
  const hasTelegram = !!context.telegramBotToken;
  if (hasTelegram && forceFilesOrScheduleOrNoDirect) {
    tools.telegram_resolve_recipient = {
      description: toolDefinitions.telegram_resolve_recipient.description,
      inputSchema: telegramResolveRecipientSchema,
      execute: async (args: unknown) => {
        return executeToolCall("telegram_resolve_recipient", args as Record<string, unknown>, context);
      },
    };
    tools.telegram_send_text = {
      description: toolDefinitions.telegram_send_text.description,
      inputSchema: telegramSendTextSchema,
      execute: async (args: unknown) => {
        return executeToolCall("telegram_send_text", args as Record<string, unknown>, context);
      },
    };
    tools.telegram_send_media = {
      description: toolDefinitions.telegram_send_media.description,
      inputSchema: telegramSendMediaSchema,
      execute: async (args: unknown) => {
        return executeToolCall("telegram_send_media", args as Record<string, unknown>, context);
      },
    };
    tools.telegram_create_topic = {
      description: toolDefinitions.telegram_create_topic.description,
      inputSchema: telegramCreateTopicSchema,
      execute: async (args: unknown) => {
        return executeToolCall("telegram_create_topic", args as Record<string, unknown>, context);
      },
    };
  }

  // Link Inbox (SQLite) tools - require connector.
  if (hasConnector && forceFilesOrNoDirect) {
    tools.linkdb_init = {
      description: toolDefinitions.linkdb_init.description,
      inputSchema: linkdbInitSchema,
      execute: async (args: unknown) => {
        return executeToolCall("linkdb_init", args as Record<string, unknown>, context);
      },
    };
    tools.linkdb_upsert_links = {
      description: toolDefinitions.linkdb_upsert_links.description,
      inputSchema: linkdbUpsertLinksSchema,
      execute: async (args: unknown) => {
        return executeToolCall("linkdb_upsert_links", args as Record<string, unknown>, context);
      },
    };
    tools.linkdb_update = {
      description: toolDefinitions.linkdb_update.description,
      inputSchema: linkdbUpdateSchema,
      execute: async (args: unknown) => {
        return executeToolCall("linkdb_update", args as Record<string, unknown>, context);
      },
    };
    tools.linkdb_query = {
      description: toolDefinitions.linkdb_query.description,
      inputSchema: linkdbQuerySchema,
      execute: async (args: unknown) => {
        return executeToolCall("linkdb_query", args as Record<string, unknown>, context);
      },
    };
    tools.linkdb_digest = {
      description: toolDefinitions.linkdb_digest.description,
      inputSchema: linkdbDigestSchema,
      execute: async (args: unknown) => {
        return executeToolCall("linkdb_digest", args as Record<string, unknown>, context);
      },
    };

    tools.sqlite_list = {
      description: toolDefinitions.sqlite_list.description,
      inputSchema: sqliteListSchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_list", args as Record<string, unknown>, context);
      },
    };
    tools.sqlite_exec = {
      description: toolDefinitions.sqlite_exec.description,
      inputSchema: sqliteExecSchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_exec", args as Record<string, unknown>, context);
      },
    };
    tools.sqlite_query = {
      description: toolDefinitions.sqlite_query.description,
      inputSchema: sqliteQuerySchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_query", args as Record<string, unknown>, context);
      },
    };

    tools.sqlite_project_list = {
      description: toolDefinitions.sqlite_project_list.description,
      inputSchema: sqliteProjectListSchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_project_list", args as Record<string, unknown>, context);
      },
    };
    tools.sqlite_project_get_or_create = {
      description: toolDefinitions.sqlite_project_get_or_create.description,
      inputSchema: sqliteProjectGetOrCreateSchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_project_get_or_create", args as Record<string, unknown>, context);
      },
    };
    tools.sqlite_project_update = {
      description: toolDefinitions.sqlite_project_update.description,
      inputSchema: sqliteProjectUpdateSchema,
      execute: async (args: unknown) => {
        return executeToolCall("sqlite_project_update", args as Record<string, unknown>, context);
      },
    };
  }

  // Code session UI tool (only if sessions exist and not forced to specific agent)
  if (Array.isArray(context.codeSessions) && context.codeSessions.length > 0 && !directAgent) {
    tools.code_open_session = {
      description: toolDefinitions.code_open_session.description,
      inputSchema: codeOpenSessionSchema,
      execute: async (args: unknown) => {
        const { name } = args as { name: string };
        const wanted = (name || "").trim().toLowerCase();
        const match = context.codeSessions!.find((s) => s.name.trim().toLowerCase() === wanted);
        const fallback = context.codeSessions![0];
        const selected = match || fallback;
        return JSON.stringify({
          __ui_open_code__: true,
          agentId: selected?.id,
          name: selected?.name,
          requestedName: name,
        });
      },
    };
  }

  // Files agent request tool - available whenever routing is not locked to another direct agent.
  if (context.filesAgent && !directAgent) {
    tools.files_agent_request = {
      description: toolDefinitions.files_agent_request.description,
      inputSchema: filesAgentRequestSchema,
      execute: async (args: unknown) => {
        return executeToolCall("files_agent_request", args as Record<string, unknown>, context);
      },
    };
  }

  // AI agent delegate tool - only when user has AI chat agents configured
  if (context.aiChatAgents && context.aiChatAgents.length > 0 && !directAgent) {
    const agentList = context.aiChatAgents.map((a) => `- ${a.name}`).join("\n");
    tools.ai_agent_delegate = {
      description: `${toolDefinitions.ai_agent_delegate.description}\n\nAvailable AI agents:\n${agentList}`,
      inputSchema: aiAgentDelegateSchema,
      execute: async (args: unknown) => {
        return executeToolCall("ai_agent_delegate", args as Record<string, unknown>, context);
      },
    };
  }

  if (
    !directAgent &&
    context.supabase &&
    context.orchestratorAgentId &&
    context.runtimeEpochId &&
    context.runtimeBranchId &&
    context.deviceId &&
    context.branchRole !== "worker" &&
    Number(context.branchControllerMaxBranches) > 1
  ) {
    tools.runtime_branch_parallel = {
      description: toolDefinitions.runtime_branch_parallel.description,
      inputSchema: runtimeBranchParallelSchema,
      execute: async (args: unknown) => {
        return executeToolCall("runtime_branch_parallel", args as Record<string, unknown>, context);
      },
    };
  }

  const allowSkillRegistry = !!context.supabase && !!context.orchestratorAgentId && (!directAgent || directAgent === "code");
  if (allowSkillRegistry) {
    tools.skill_registry_list = {
      description: toolDefinitions.skill_registry_list.description,
      inputSchema: z.object({}),
      execute: async () => {
        return executeToolCall("skill_registry_list", {}, context);
      },
    };
    tools.skill_registry_create_draft = {
      description: toolDefinitions.skill_registry_create_draft.description,
      inputSchema: skillRegistryCreateDraftSchema,
      execute: async (args: unknown) => {
        return executeToolCall(
          "skill_registry_create_draft",
          args as Record<string, unknown>,
          context
        );
      },
    };
    tools.skill_registry_activate_draft = {
      description: toolDefinitions.skill_registry_activate_draft.description,
      inputSchema: skillRegistryActivateDraftSchema,
      execute: async (args: unknown) => {
        return executeToolCall(
          "skill_registry_activate_draft",
          args as Record<string, unknown>,
          context
        );
      },
    };
    if (hasConnector) {
      tools.skill_registry_validate_draft = {
        description: toolDefinitions.skill_registry_validate_draft.description,
        inputSchema: skillRegistryValidateDraftSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "skill_registry_validate_draft",
            args as Record<string, unknown>,
            context
          );
        },
      };
    }
  }

  // Add Obsidian tools only if connector is available AND (no directAgent OR directAgent is "obsidian")
  if (hasConnector && (!directAgent || forceObsidianOnly)) {
    tools.obsidian_discover = {
      description:
        "Discover Obsidian vaults on the local machine. Use this if you don't know which vault to use.",
      inputSchema: obsidianDiscoverSchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_discover", args as Record<string, unknown>, context);
      },
    };

    tools.obsidian_search = {
      description:
        "Search for notes in the selected Obsidian vault. Use this to find notes by content, tags, or title.",
      inputSchema: obsidianSearchSchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_search", args as Record<string, unknown>, context);
      },
    };

    tools.obsidian_read = {
      description: "Read a note from the selected Obsidian vault.",
      inputSchema: obsidianReadSchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_read", args as Record<string, unknown>, context);
      },
    };

    tools.obsidian_write = {
      description:
        "Create or update a note in the selected Obsidian vault. Use wikilinks ([[like this]]) to create connections.",
      inputSchema: obsidianWriteSchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_write", args as Record<string, unknown>, context);
      },
    };

    tools.obsidian_daily = {
      description:
        "Create or append to today's daily note in the selected Obsidian vault.",
      inputSchema: obsidianDailySchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_daily", args as Record<string, unknown>, context);
      },
    };

    tools.obsidian_list = {
      description:
        "List notes and folders in the selected Obsidian vault.",
      inputSchema: obsidianListSchema,
      execute: async (args: unknown) => {
        return executeToolCall("obsidian_list", args as Record<string, unknown>, context);
      },
    };
  }

  // If user explicitly addressed @obsidian, we're done - don't add browser tools
  if (forceObsidianOnly) {
    return stripRetiredHarnessTools(tools);
  }

  // Credentials tools (browser-auth). Only show when browser is relevant.
  if (hasConnector && (!directAgent || forceBrowserTaskOnly)) {
    tools.credential_get = {
      description:
        "Check whether credentials for a domain are already stored locally on the user's connector. Never returns the password.",
      inputSchema: credentialGetSchema,
      execute: async (args: unknown) => {
        const { domain } = args as { domain: string };
        return JSON.stringify({
          __connector_execute__: true,
          type: "browser_credential_get",
          params: { domain },
          toolName: "credential_get",
          agent: "browser",
          message: "Checking local credential vault…",
        });
      },
    };

    tools.credential_request = {
      description:
        "Request credentials for a domain via a local connector prompt. Stores them locally in an encrypted vault. Never ask the user to paste passwords in chat.",
      inputSchema: credentialRequestSchema,
      execute: async (args: unknown) => {
        const { domain, reason } = args as { domain: string; reason?: string };
        return JSON.stringify({
          __connector_execute__: true,
          type: "browser_credential_request",
          params: { domain, reason },
          toolName: "credential_request",
          agent: "browser",
          message: "Requesting credentials via local connector prompt…",
        });
      },
    };
  }

  // Add browser tools only if connector is available AND (no directAgent OR directAgent is "browser")
  // Browser tasks run on the connector so they work in both webapp and WhatsApp.
  if (hasConnector && (!directAgent || forceBrowserTaskOnly) && !context.disableBrowserTask) {
    // PRIMARY: Playwright MCP browser tasks (executed on connector via claude -p)
    tools.browser_task = {
      description: `Perform a browser task using Playwright MCP (via Claude Code CLI). The browser agent will autonomously control a browser to complete the task.

USE THIS for:
- Searching websites and finding information
- Navigating complex sites with multiple steps
- Filling out forms
- Any task requiring visual understanding of the page

IMPORTANT:
- This runs on the user's local connector (claude -p + Playwright MCP).
- If the task needs a login, credentials will be requested via a local connector prompt. Do NOT ask the user to paste passwords in chat.

Examples:
- "Search Google for 'best coffee shops in SF' and tell me the top 3"
- "Go to news.ycombinator.com and find today's top story"`,
      inputSchema: browserTaskSchema,
      execute: async (args: unknown) => {
        const { task, startUrl, timeout_ms } = args as {
          task: string;
          startUrl?: string;
          timeout_ms?: number;
        };
        // Always run browser tasks on the connector via Playwright MCP (claude -p).
        // This is more reliable than the old Computer Use screenshot-based approach.
        // Pass API key / CLI token so the connector can spawn claude -p.
        const useCliToken = !!context.claudeCliToken;
        const authOrigin = useCliToken
          ? "user"
          : context.apiKeys?.anthropic === process.env.ANTHROPIC_API_KEY
            ? "groovy"
            : "user";
        return JSON.stringify({
          __connector_execute__: true,
          type: "browser_task_run",
          params: {
            task,
            start_url: startUrl,
            timeout_ms,
            app_url: context.appBaseUrl || "",
            profile_name: "default",
            ...(useCliToken
              ? { cli_token: context.claudeCliToken }
              : { api_key: context.apiKeys?.anthropic }),
            billing_billable: true,
            billing_charge_type: authOrigin === "groovy" ? "groovy_key" : "external_key_fee",
            billing_auth_origin: authOrigin,
            billing_auth_method: useCliToken ? "cli_token" : "api_key",
          },
          toolName: "browser_task",
          agent: "browser",
          message: "Browsing the web…",
        });
      },
    };

    // Legacy tools (still available for simple operations)
    // IMPORTANT: If the user explicitly addressed @browser, force Computer Use
    // by *not exposing* the legacy tools. Otherwise the model often chooses
    // browser_extract (DOM text) which yields no live screenshots in the UI.
    if (!forceBrowserTaskOnly) {
      tools.browser_navigate = {
        description:
          "Navigate the browser to a URL. Opens the page and waits for it to load. Returns a description of what's on the page.",
        inputSchema: browserNavigateSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "browser_navigate",
            args as Record<string, unknown>,
            context
          );
        },
      };
      tools.browser_click = {
        description:
          "Click an element on the current page. Specify a CSS selector and optionally the text content to help identify the element.",
        inputSchema: browserClickSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "browser_click",
            args as Record<string, unknown>,
            context
          );
        },
      };
      tools.browser_type = {
        description:
          "Type text into an input field on the page. Specify the CSS selector and the text to type.",
        inputSchema: browserTypeSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "browser_type",
            args as Record<string, unknown>,
            context
          );
        },
      };
      tools.browser_extract = {
        description:
          "Extract content from the current page. Describe what you want to extract (e.g., 'all product names and prices', 'the article headline and body text').",
        inputSchema: browserExtractSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "browser_extract",
            args as Record<string, unknown>,
            context
          );
        },
      };
      tools.browser_screenshot = {
        description:
          "Take a screenshot of the current page. Returns a visual description of what's visible.",
        inputSchema: browserScreenshotSchema,
        execute: async (args: unknown) => {
          return executeToolCall(
            "browser_screenshot",
            args as Record<string, unknown>,
            context
          );
        },
      };
    }
  }

  const allowsSkillTools = !directAgent || directAgent === "code" || directAgent === "files";
  if (allowsSkillTools && Array.isArray(dynamicSkillTools) && dynamicSkillTools.length > 0) {
    const hasSkillTerminalSupport = hasConnector && !context.disableTerminalExec;
    const hasSkillCodeSupport = hasConnector && hasCliAuth;
    for (const skill of dynamicSkillTools) {
      if (skill.runner === "terminal_exec" && !hasSkillTerminalSupport) continue;
      if (skill.runner === "code_cli_run" && !hasSkillCodeSupport) continue;
      const toolName =
        typeof skill.toolName === "string" && skill.toolName.trim()
          ? skill.toolName.trim()
          : "";
      if (!toolName || tools[toolName]) continue;

      tools[toolName] = {
        description:
          `Run skill "${skill.name}" (${skill.lifecycle}, v${skill.versionId.slice(0, 8)}). ` +
          `${skill.description || "Reusable agent workflow."}`,
        inputSchema: skillRuntimeInvokeSchema,
        execute: async (args: unknown) => {
          const parsed = skillRuntimeInvokeSchema.parse(args ?? {});
          const explicitCwd =
            typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : undefined;
          const defaultCwd =
            typeof context.codeWorkspaceRootPath === "string" && context.codeWorkspaceRootPath.trim()
              ? context.codeWorkspaceRootPath.trim()
              : undefined;
          const cwd = explicitCwd || defaultCwd;

          const stateForPrompt =
            skill.state && typeof skill.state === "object" ? skill.state : {};
          let output = "";

          if (skill.runner === "terminal_exec") {
            const source = String(skill.source || "");
            const command = source.includes("{{task}}")
              ? source
                  .replaceAll("{{task}}", parsed.task)
                  .replaceAll("{{state_json}}", JSON.stringify(stateForPrompt))
              : `${source}\n# TASK\n${parsed.task}`;
            output = await executeToolCall(
              "terminal_exec",
              {
                command,
                cwd,
                timeout_ms: parsed.timeout_ms,
              },
              context
            );
          } else {
            if (!cwd) {
              return "Error: Skill requires a workspace cwd. Configure a code workspace first.";
            }
            const prompt = [
              `You are executing reusable skill "${skill.name}" (slug: ${skill.slug}).`,
              `SKILL SOURCE:\n${skill.source}`,
              `CURRENT_SKILL_STATE_JSON:\n${JSON.stringify(stateForPrompt)}`,
              `TASK:\n${parsed.task}`,
              "If state must change, append exactly one final line: __SKILL_STATE_PATCH__:{...json...}",
            ].join("\n\n");
            output = await executeToolCall(
              "code_cli_run",
              {
                prompt,
                cwd,
                timeout_ms: parsed.timeout_ms,
                allowed_tools: "Read,Edit,Bash,Write",
              },
              context
            );
          }

          const patchFromArgs =
            parsed.state_patch && typeof parsed.state_patch === "object"
              ? (parsed.state_patch as Record<string, unknown>)
              : null;
          const patchFromOutput = extractSkillStatePatchFromText(output);
          const patch = patchFromArgs || patchFromOutput;
          if (patch && context.supabase && context.orchestratorAgentId) {
            await applySkillStatePatch({
              supabase: context.supabase,
              userId: context.userId,
              agentId: context.orchestratorAgentId,
              skillVersionId: skill.versionId,
              epochId: context.runtimeEpochId || null,
              branchId: context.runtimeBranchId || null,
              currentState: stateForPrompt,
              patch,
            }).catch(() => undefined);
          }

          return output;
        },
      };
    }
  }

  const allowsExtensionTools = !directAgent;
  if (allowsExtensionTools && Array.isArray(dynamicExtensionTools) && dynamicExtensionTools.length > 0) {
    for (const extensionTool of dynamicExtensionTools) {
      const toolName =
        typeof extensionTool.toolName === "string" && extensionTool.toolName.trim()
          ? extensionTool.toolName.trim()
          : "";
      if (!toolName || tools[toolName]) continue;

      const capabilityTags =
        Array.isArray(extensionTool.capabilityTags) && extensionTool.capabilityTags.length > 0
          ? ` Tags: ${extensionTool.capabilityTags.join(", ")}.`
          : "";
      const toolTags =
        Array.isArray(extensionTool.tags) && extensionTool.tags.length > 0
          ? ` Tool tags: ${extensionTool.tags.join(", ")}.`
          : "";
      const skillInstructions = extensionTool.extensionSkillInstructions
        ? ` Extension guidance: ${extensionTool.extensionSkillInstructions}`
        : "";
      const promptHint = extensionTool.promptHint ? ` Tool guidance: ${extensionTool.promptHint}` : "";

      tools[toolName] = {
        description:
          `Use installed integration "${extensionTool.extensionName}". ` +
          `${extensionTool.description}${capabilityTags}${toolTags}${skillInstructions}${promptHint}`,
        inputSchema: zodSchemaFromJsonSchema(extensionTool.inputSchema),
        execute: async (args: unknown) => {
          const parsed =
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {};
          return executeToolCall(toolName, parsed, context);
        },
      };
    }
  }

  return filterToolsByPolicy(stripRetiredHarnessTools(tools), context.toolPolicy);
}

/**
 * Cutover safety boundary. The old single-view capabilities intentionally no
 * longer exist in the harness product, so never expose their tools even while
 * the remaining implementation is removed mechanically from this large file.
 */
function stripRetiredHarnessTools<T extends Record<string, unknown>>(tools: T): T {
  for (const name of Object.keys(tools)) {
    if (
      (name.startsWith("browser_") && name !== "browser_task") ||
      name.startsWith("files_") ||
      name.startsWith("obsidian_") ||
      name.startsWith("credential_") ||
      name === "computer_use_action" ||
      name === "handshake_send" ||
      name === "code_open_session" ||
      name === "ai_agent_delegate"
    ) {
      delete tools[name];
    }
  }
  return tools;
}

/**
 * Get provider descriptions for the system prompt
 */
export function getProviderDescriptions(): string {
  return DATAGRAN_PROVIDERS.map((p) => `- **${p}**: ${PROVIDER_DESCRIPTIONS[p]}`).join("\n");
}

/**
 * Get list of all providers
 */
export function getAllProviders(): string[] {
  return [...DATAGRAN_PROVIDERS];
}
