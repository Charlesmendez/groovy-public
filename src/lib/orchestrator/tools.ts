/**
 * Orchestrator Tool Definitions
 * Tools that the LLM can call to interact with local agents.
 */

import { tool } from "ai";
import { z } from "zod";
import type { AgentType } from "./router";

// Tool execution results will be sent to the connector via relay
export type ToolExecutionRequest = {
  agent: AgentType;
  action: string;
  params: Record<string, unknown>;
  requestId: string;
};

/**
 * Browser Agent Tools
 * 
 * browser_task uses Claude Computer Use - Claude can SEE the screen and click intelligently.
 * Other browser tools are for simple, direct automation.
 */
export const browserTools = {
  // Primary tool - uses Claude Computer Use for intelligent browsing
  browser_task: tool({
    description:
      "Execute a browser task using Claude Computer Use. Claude will see screenshots and intelligently navigate, click, and type. Use this for complex browsing tasks like 'find the first product on Target' or 'search for flights to Paris'.",
    inputSchema: z.object({
      task: z.string().describe("Natural language description of the browsing task to complete"),
      start_url: z.string().optional().describe("Optional URL to start at (e.g., 'google.com')"),
    }),
  }),

  // Simple navigation (doesn't use Computer Use)
  browser_navigate: tool({
    description:
      "Navigate to a URL in the browser. Use this for simple navigation to a known URL.",
    inputSchema: z.object({
      url: z.string().describe("The URL to navigate to (e.g., 'google.com' or 'https://example.com')"),
    }),
  }),

  browser_click: tool({
    description:
      "Click on an element in the browser. Use CSS selectors to identify the element.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector for the element to click (e.g., 'button.submit', '#login-btn')"),
      wait_for_navigation: z.boolean().optional().describe("Wait for page navigation after click"),
    }),
  }),

  browser_type: tool({
    description:
      "Type text into an input field in the browser. Clears existing text by default.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector for the input element"),
      text: z.string().describe("Text to type into the element"),
      clear: z.boolean().optional().describe("Clear existing text before typing (default: true)"),
    }),
  }),

  browser_screenshot: tool({
    description:
      "Take a screenshot of the current page or a specific element.",
    inputSchema: z.object({
      full_page: z.boolean().optional().describe("Capture the full scrollable page"),
      selector: z.string().optional().describe("CSS selector for specific element to screenshot"),
    }),
  }),

  browser_extract: tool({
    description:
      "Extract content from the current page. Can extract text, HTML, links, images, tables, or form fields.",
    inputSchema: z.object({
      type: z.enum(["text", "html", "links", "images", "table", "form"]).describe("Type of content to extract"),
      selector: z.string().optional().describe("CSS selector to limit extraction scope"),
    }),
  }),

  browser_scroll: tool({
    description: "Scroll the page up or down.",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]).describe("Direction to scroll"),
      amount: z.number().optional().describe("Pixels to scroll (default: 500)"),
    }),
  }),

  browser_fill_form: tool({
    description: "Fill out a form with multiple fields at once.",
    inputSchema: z.object({
      form_selector: z.string().describe("CSS selector for the form element"),
      fields: z.record(z.string(), z.string()).describe("Object mapping field names to values"),
    }),
  }),
};

/**
 * Files Agent Tools
 */
export const filesTools = {
  files_read: tool({
    description:
      "Read the contents of a file. Returns the file content as text.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file to read (relative to home or absolute)"),
    }),
  }),

  files_write: tool({
    description:
      "Write content to a file. Creates the file if it doesn't exist.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file to write"),
      content: z.string().describe("Content to write to the file"),
    }),
  }),

  files_list: tool({
    description:
      "List files and folders in a directory.",
    inputSchema: z.object({
      path: z.string().describe("Path to the directory to list"),
      recursive: z.boolean().optional().describe("List subdirectories recursively"),
    }),
  }),

  files_search: tool({
    description:
      "Search for files by name or content in a directory.",
    inputSchema: z.object({
      path: z.string().describe("Root directory to search in"),
      query: z.string().describe("Search query (matches filenames and optionally content)"),
      search_content: z.boolean().optional().describe("Also search inside file contents"),
    }),
  }),

  files_delete: tool({
    description:
      "Delete a file or empty directory.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file or directory to delete"),
    }),
  }),

  files_move: tool({
    description:
      "Move or rename a file or directory.",
    inputSchema: z.object({
      source: z.string().describe("Current path of the file/directory"),
      destination: z.string().describe("New path for the file/directory"),
    }),
  }),

  files_mkdir: tool({
    description:
      "Create a new directory.",
    inputSchema: z.object({
      path: z.string().describe("Path of the directory to create"),
    }),
  }),
};

/**
 * Obsidian Agent Tools
 */
export const obsidianTools = {
  obsidian_search: tool({
    description:
      "Search for notes in an Obsidian vault by content, tags, or title.",
    inputSchema: z.object({
      vault_path: z.string().describe("Path to the Obsidian vault"),
      query: z.string().describe("Search query"),
      search_content: z.boolean().optional().describe("Search inside note content"),
      search_tags: z.boolean().optional().describe("Search note tags"),
    }),
  }),

  obsidian_read: tool({
    description:
      "Read the contents of an Obsidian note.",
    inputSchema: z.object({
      vault_path: z.string().describe("Path to the Obsidian vault"),
      note_path: z.string().describe("Path to the note within the vault (without .md extension)"),
    }),
  }),

  obsidian_write: tool({
    description:
      "Create or update an Obsidian note.",
    inputSchema: z.object({
      vault_path: z.string().describe("Path to the Obsidian vault"),
      note_path: z.string().describe("Path for the note within the vault"),
      content: z.string().describe("Markdown content for the note"),
    }),
  }),

  obsidian_list: tool({
    description:
      "List all notes and folders in an Obsidian vault.",
    inputSchema: z.object({
      vault_path: z.string().describe("Path to the Obsidian vault"),
    }),
  }),

  obsidian_daily: tool({
    description:
      "Create or append to today's daily note.",
    inputSchema: z.object({
      vault_path: z.string().describe("Path to the Obsidian vault"),
      content: z.string().optional().describe("Content to add to the daily note"),
      append: z.boolean().optional().describe("Append to existing note (default: true)"),
    }),
  }),

  obsidian_discover: tool({
    description:
      "Discover Obsidian vaults on the local machine.",
    inputSchema: z.object({}),
  }),
};

/**
 * Data Agent Tools
 */
export const dataTools = {
  data_query: tool({
    description:
      "Query marketing data from connected platforms (Google Ads, Facebook, LinkedIn, TikTok).",
    inputSchema: z.object({
      provider: z.enum(["google_ads", "facebook", "instagram", "linkedin_ads", "tiktok"]).describe("Marketing platform to query"),
      query: z.string().describe("Natural language description of what data you want"),
    }),
  }),

  data_list_accounts: tool({
    description:
      "List connected accounts for a marketing platform.",
    inputSchema: z.object({
      provider: z.enum(["google_ads", "facebook", "instagram", "linkedin_ads", "tiktok"]).describe("Marketing platform"),
    }),
  }),

  data_check_connection: tool({
    description:
      "Check if a marketing platform is connected.",
    inputSchema: z.object({
      provider: z.enum(["google_ads", "facebook", "instagram", "linkedin_ads", "tiktok", "google_drive"]).describe("Platform to check"),
    }),
  }),
};

/**
 * Handshake Tools (agent-to-agent communication)
 */
export const handshakeTools = {
  handshake_send: tool({
    description:
      "Send a message to the connected partner agent through the active handshake. Use this to collaborate, share results, or request help from the partner agent.",
    inputSchema: z.object({
      message: z.string().describe("The message to send to the connected partner agent"),
      context: z.string().optional().describe("Optional additional context or data to share with the partner"),
    }),
  }),
};

/**
 * Memory Tools (special - handled directly by orchestrator)
 */
export const memoryTools = {
  remember: tool({
    description:
      "Store something important to long-term memory. Use when the user asks you to remember something.",
    inputSchema: z.object({
      content: z.string().describe("What to remember"),
      label: z.string().optional().describe("A short label for this memory"),
    }),
  }),

  recall: tool({
    description:
      "Search memory for relevant information about a topic.",
    inputSchema: z.object({
      query: z.string().describe("What to search for in memory"),
    }),
  }),
};

/**
 * Get tools for specific agents
 */
export function getToolsForAgents(agents: AgentType[]) {
  const tools: Record<string, ReturnType<typeof tool>> = {};

  if (agents.includes("browser")) {
    Object.assign(tools, browserTools);
  }

  if (agents.includes("files")) {
    Object.assign(tools, filesTools);
  }

  if (agents.includes("obsidian")) {
    Object.assign(tools, obsidianTools);
  }

  if (agents.includes("data")) {
    Object.assign(tools, dataTools);
  }

  // Always include memory tools
  Object.assign(tools, memoryTools);

  return tools;
}

/**
 * Map tool name to agent type
 */
export function toolToAgent(toolName: string): AgentType | "memory" | "handshake" | "telegram" | null {
  if (toolName.startsWith("runtime_branch_")) return "chat";
  if (toolName.startsWith("skill_")) return "code";
  if (toolName.startsWith("code_")) return "code";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("files_")) return "files";
  // WhatsApp tools are executed via the local connector (same execution bucket as files/linkdb/sqlite)
  if (toolName.startsWith("whatsapp_")) return "files";
  // Telegram tools are executed server-side (no connector needed)
  if (toolName.startsWith("telegram_")) return "telegram";
  if (toolName === "files_agent_request") return "files";
  if (toolName === "terminal_exec") return "files";
  if (toolName.startsWith("linkdb_")) return "files";
  if (toolName.startsWith("sqlite_")) return "files";
  if (toolName.startsWith("obsidian_")) return "obsidian";
  if (toolName.startsWith("data_")) return "data";
  if (toolName.startsWith("schedule_")) return "schedule";
  if (toolName.startsWith("site_")) return "pages";
  if (
    toolName === "start_twilio_call" ||
    toolName === "start_twilio_sms" ||
    toolName === "coach_twilio_child" ||
    toolName === "get_twilio_child_status"
  ) {
    return "chat";
  }
  if (toolName === "remember" || toolName === "recall") return "memory";
  if (toolName === "handshake_send") return "handshake";
  return null;
}

/**
 * Map tool name to connector message type
 */
export function toolToConnectorMessage(
  toolName: string,
  params: Record<string, unknown>
): { type: string; params: Record<string, unknown> } | null {
  // Code (Claude Code PTY) relay
  if (toolName === "code_terminal_step") {
    return {
      type: "terminal_step",
      params: {
        terminal_id: params.terminal_id,
        cwd: params.cwd,
        input: params.input,
        max_wait_ms: params.max_wait_ms,
        quiet_ms: params.quiet_ms,
        capture_max_chars: params.capture_max_chars,
      },
    };
  }

  // Non-interactive shell execution (local bash)
  if (toolName === "terminal_exec") {
    const commandText = String(params.command || "");
    const requestedTimeout = Number(params.timeout_ms);
    const looksLikeInstall = /\b(npm|pnpm|yarn)\s+install\b/i.test(commandText);
    const looksLikeNextBuild = /\bnext\s+build\b/i.test(commandText);
    const isLongRunning = looksLikeInstall || looksLikeNextBuild;
    const defaultTimeoutMs = isLongRunning ? 5 * 60 * 1000 : requestedTimeout;
    const boundedTimeoutMs = Number.isFinite(requestedTimeout)
      ? Math.trunc(requestedTimeout)
      : defaultTimeoutMs;
    const timeoutMs = isLongRunning
      ? Math.max(2 * 60 * 1000, Math.min(boundedTimeoutMs, 15 * 60 * 1000))
      : params.timeout_ms;

    return {
      type: "terminal_exec",
      params: {
        command: params.command,
        cwd: params.cwd,
        timeout_ms: timeoutMs,
        max_output_chars: params.max_output_chars,
        env: params.env,
      },
    };
  }

  // Claude Code CLI (headless) - runs claude -p for coding tasks
  // Supports --resume via session_id for multi-turn conversations
  // Supports cli_token (CLAUDE_CODE_OAUTH_TOKEN) as alternative to api_key
  if (toolName === "code_cli_run") {
    const timeoutMs = 10 * 60 * 1000;

    return {
      type: "claude_run",
      params: {
        prompt: params.prompt,
        cwd: params.cwd,
        api_key: params.api_key,
        cli_token: params.cli_token, // OAuth token from `claude setup-token`
        allowed_tools: params.allowed_tools,
        timeout_ms: timeoutMs,
        session_id: params.session_id, // For --resume (follow-up questions)
        billing_billable: params.billing_billable,
        billing_charge_type: params.billing_charge_type,
        billing_auth_origin: params.billing_auth_origin,
        billing_auth_method: params.billing_auth_method,
      },
    };
  }

  // Link Inbox (SQLite) tools
  if (toolName === "linkdb_init") {
    return { type: "linkdb_init", params: {} };
  }
  if (toolName === "linkdb_upsert_links") {
    return { type: "linkdb_upsert_links", params: { links: params.links } };
  }
  if (toolName === "linkdb_update") {
    return {
      type: "linkdb_update",
      params: {
        url: params.url,
        title: params.title,
        summary: params.summary,
        tags: params.tags,
        note: params.note,
        read: params.read,
        source: params.source,
      },
    };
  }
  if (toolName === "linkdb_query") {
    return {
      type: "linkdb_query",
      params: {
        text: params.text,
        tags_any: params.tags_any,
        unread_only: params.unread_only,
        limit: params.limit,
      },
    };
  }
  if (toolName === "linkdb_digest") {
    return {
      type: "linkdb_digest",
      params: {
        since_days: params.since_days,
        unread_only: params.unread_only,
        limit: params.limit,
      },
    };
  }

  // Generic SQLite (multi-project DBs)
  if (toolName === "sqlite_list") {
    return { type: "sqlite_list", params: {} };
  }
  if (toolName === "sqlite_exec") {
    return {
      type: "sqlite_exec",
      params: {
        dbKey: params.dbKey,
        sql: params.sql,
        statements: params.statements,
        timeout_ms: params.timeout_ms,
      },
    };
  }
  if (toolName === "sqlite_query") {
    return {
      type: "sqlite_query",
      params: {
        dbKey: params.dbKey,
        sql: params.sql,
        limit: params.limit,
        append_limit: params.append_limit,
        timeout_ms: params.timeout_ms,
      },
    };
  }

  // SQLite project registry
  if (toolName === "sqlite_project_list") {
    return { type: "sqlite_project_list", params: {} };
  }
  if (toolName === "sqlite_project_get_or_create") {
    return {
      type: "sqlite_project_get_or_create",
      params: {
        name: params.name,
        description: params.description,
        tags: params.tags,
        preferredDbKey: params.preferredDbKey,
      },
    };
  }
  if (toolName === "sqlite_project_update") {
    return {
      type: "sqlite_project_update",
      params: {
        dbKey: params.dbKey,
        name: params.name,
        description: params.description,
        tags: params.tags,
      },
    };
  }

  // Claude Computer Use action - special handling
  if (toolName === "computer_use_action") {
    return {
      type: "computer_use_action",
      params: {
        action: params.action,
        coordinate: params.coordinate,
        text: params.text,
        key: params.key,
        scroll_direction: params.scrollDirection || params.scroll_direction,
        scroll_amount: params.scrollAmount || params.scroll_amount,
      },
    };
  }

  // Browser task - delegates to browser-agent API (handled separately)
  // Run the Computer Use loop on the connector
  if (toolName === "browser_task") {
    return {
      type: "browser_task_run",
      params: {
        task: params.task,
        start_url: params.start_url,
        app_url: params.app_url,
        profile_name: params.profile_name || "default",
      },
    };
  }

  // Browser tools
  if (toolName === "browser_navigate") {
    return { type: "browser_navigate", params: { url: params.url } };
  }
  if (toolName === "browser_click") {
    return {
      type: "browser_click",
      params: { selector: params.selector, wait_for_nav: params.wait_for_navigation },
    };
  }
  if (toolName === "browser_type") {
    return {
      type: "browser_type",
      params: { selector: params.selector, text: params.text, clear: params.clear },
    };
  }
  if (toolName === "browser_screenshot") {
    return {
      type: "browser_screenshot",
      params: { full_page: params.full_page, selector: params.selector },
    };
  }
  if (toolName === "browser_extract") {
    return {
      type: "browser_extract",
      params: { extract_type: params.type, selector: params.selector },
    };
  }
  if (toolName === "browser_scroll") {
    return {
      type: "browser_scroll",
      params: { direction: params.direction, amount: params.amount },
    };
  }
  if (toolName === "browser_fill_form") {
    return {
      type: "browser_fill_form",
      params: { form_selector: params.form_selector, fields: params.fields },
    };
  }

  // Files tools
  if (toolName === "files_read") {
    return { type: "file_read", params: { path: params.path } };
  }
  if (toolName === "files_write") {
    return { type: "file_write", params: { path: params.path, content: params.content } };
  }
  if (toolName === "files_list") {
    return { type: "file_list", params: { path: params.path, recursive: params.recursive } };
  }
  if (toolName === "files_search") {
    return {
      type: "file_search",
      params: { root: params.path, query: params.query, search_content: params.search_content },
    };
  }
  if (toolName === "files_delete") {
    return { type: "file_delete", params: { path: params.path } };
  }
  if (toolName === "files_move") {
    return { type: "file_move", params: { source: params.source, destination: params.destination } };
  }
  if (toolName === "files_mkdir") {
    return { type: "file_mkdir", params: { path: params.path } };
  }

  // WhatsApp tools (local WhatsApp Web bridge)
  if (toolName === "whatsapp_resolve_recipient") {
    return {
      type: "whatsapp_resolve_recipient",
      params: { query: params.query, limit: params.limit },
    };
  }
  if (toolName === "whatsapp_send_text") {
    return {
      type: "whatsapp_send_text",
      params: {
        chat_id: params.chat_id,
        recipient_query: params.recipient_query,
        text: params.text,
      },
    };
  }
  if (toolName === "whatsapp_send_media") {
    return {
      type: "whatsapp_send_media",
      params: {
        chat_id: params.chat_id,
        recipient_query: params.recipient_query,
        url: params.url,
        local_path: params.local_path,
        storage_path: params.storage_path,
        file_id: params.file_id,
        orchestrator_session_id: params.orchestrator_session_id,
        filename: params.filename,
        caption: params.caption,
      },
    };
  }

  // Obsidian tools
  if (toolName === "obsidian_search") {
    return {
      type: "obsidian_search",
      params: {
        vault_path: params.vault_path,
        query: params.query,
        search_content: params.search_content,
        search_tags: params.search_tags,
      },
    };
  }
  if (toolName === "obsidian_read") {
    return {
      type: "obsidian_read",
      params: { vault_path: params.vault_path, note_path: params.note_path },
    };
  }
  if (toolName === "obsidian_write") {
    return {
      type: "obsidian_write",
      params: { vault_path: params.vault_path, note_path: params.note_path, content: params.content },
    };
  }
  if (toolName === "obsidian_list") {
    return { type: "obsidian_list", params: { vault_path: params.vault_path } };
  }
  if (toolName === "obsidian_daily") {
    return {
      type: "obsidian_daily",
      params: { vault_path: params.vault_path, content: params.content, append: params.append },
    };
  }
  if (toolName === "obsidian_discover") {
    return { type: "obsidian_discover", params: {} };
  }

  // Site Builder tools
  if (toolName === "site_dev") {
    const action = typeof params.action === "string" ? params.action : "start";
    return {
      type: action === "stop" ? "site_dev_stop" : "site_dev_start",
      params: {
        slug: params.slug,
        site_path: params.site_path,
      },
    };
  }
  if (toolName === "site_read_files") {
    return {
      type: "site_read_files",
      params: {
        slug: params.slug,
        site_path: params.site_path,
      },
    };
  }

  return null;
}
