export type ClaudeSlashCommandKind =
  | "built_in"
  | "bundled_skill"
  | "mcp_prompt"
  | "runtime_discovered";

export type ClaudeSlashCommandSource = "docs" | "runtime";

export type ClaudeSlashCommand = {
  command: string;
  usage: string;
  summary: string;
  aliases: string[];
  kind: ClaudeSlashCommandKind;
  source: ClaudeSlashCommandSource;
};

type ClaudeSlashCommandRow = [string, string, string, string?, ClaudeSlashCommand["kind"]?];

function buildSlashCommands(rows: ClaudeSlashCommandRow[]): ClaudeSlashCommand[] {
  return rows.map(([command, usage, summary, aliases = "", kind = "built_in"]) => ({
    command,
    usage,
    summary,
    aliases: aliases
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean),
    kind,
    source: "docs",
  }));
}

// Source: Claude Code interactive mode + skills docs (Mar 2026).
const CLAUDE_SLASH_COMMAND_ROWS: ClaudeSlashCommandRow[] = [
  ["/add-dir", "/add-dir <directory>", "Add a new working directory to the current session"],
  ["/agents", "/agents", "Manage Claude Code agent configurations"],
  ["/btw", "/btw <question>", "Ask a side question without adding it to the main conversation"],
  ["/chrome", "/chrome", "Configure Claude in Chrome settings"],
  ["/clear", "/clear", "Clear conversation history and free up context", "/reset,/new"],
  ["/compact", "/compact [instructions]", "Compact the conversation with optional focus instructions"],
  ["/config", "/config", "Open Claude Code settings", "/settings"],
  ["/context", "/context", "Visualize current context usage and optimization hints"],
  ["/copy", "/copy", "Copy the last assistant response to the clipboard"],
  ["/cost", "/cost", "Show token usage statistics"],
  ["/desktop", "/desktop", "Continue this session in Claude Code Desktop", "/app"],
  ["/diff", "/diff", "Open an interactive diff viewer for current changes"],
  ["/doctor", "/doctor", "Diagnose the Claude Code installation and settings"],
  ["/exit", "/exit", "Exit the Claude Code CLI", "/quit"],
  ["/export", "/export [filename]", "Export the current conversation as plain text"],
  ["/extra-usage", "/extra-usage", "Configure extra usage when rate limits are hit"],
  ["/fast", "/fast [on|off]", "Toggle fast mode on or off"],
  ["/feedback", "/feedback [report]", "Submit feedback about Claude Code", "/bug"],
  ["/fork", "/fork [name]", "Create a fork of the current conversation"],
  ["/help", "/help", "Show help and available commands"],
  ["/hooks", "/hooks", "Manage hook configurations for tool events"],
  ["/ide", "/ide", "Manage IDE integrations and show status"],
  ["/init", "/init", "Initialize the project with a CLAUDE.md guide"],
  ["/insights", "/insights", "Generate a report about your Claude Code sessions"],
  ["/install-github-app", "/install-github-app", "Set up the Claude GitHub Actions app"],
  ["/install-slack-app", "/install-slack-app", "Install the Claude Slack app"],
  ["/keybindings", "/keybindings", "Open or create the Claude Code keybindings file"],
  ["/login", "/login", "Sign in to Claude Code"],
  ["/logout", "/logout", "Sign out from Claude Code"],
  ["/mcp", "/mcp", "Manage MCP server connections and OAuth authentication"],
  ["/memory", "/memory", "Edit CLAUDE.md memory files and auto-memory settings"],
  ["/mobile", "/mobile", "Show a QR code to download the Claude mobile app", "/ios,/android"],
  ["/model", "/model [model]", "Select or change the AI model"],
  ["/passes", "/passes", "Share a free week of Claude Code if your account is eligible"],
  ["/permissions", "/permissions", "View or update tool permissions", "/allowed-tools"],
  ["/plan", "/plan", "Enter plan mode directly from the prompt"],
  ["/plugin", "/plugin", "Manage Claude Code plugins"],
  ["/pr-comments", "/pr-comments [PR]", "Fetch comments from a GitHub pull request"],
  ["/privacy-settings", "/privacy-settings", "View or update privacy settings"],
  ["/release-notes", "/release-notes", "View Claude Code release notes"],
  ["/reload-plugins", "/reload-plugins", "Reload all active plugins"],
  ["/remote-control", "/remote-control", "Make this session available for remote control", "/rc"],
  ["/remote-env", "/remote-env", "Configure the default remote environment"],
  ["/rename", "/rename [name]", "Rename the current session"],
  ["/resume", "/resume [session]", "Resume a conversation by ID or name", "/continue"],
  ["/review", "/review", "Deprecated review command kept for compatibility"],
  ["/rewind", "/rewind", "Rewind the conversation or code to a previous point", "/checkpoint"],
  ["/sandbox", "/sandbox", "Toggle sandbox mode"],
  ["/security-review", "/security-review", "Analyze pending changes for security issues"],
  ["/skills", "/skills", "List available Claude Code skills"],
  ["/stats", "/stats", "Visualize usage, session history, and model preferences"],
  ["/status", "/status", "Open the Claude Code status/settings interface"],
  ["/statusline", "/statusline", "Configure the Claude Code status line"],
  ["/stickers", "/stickers", "Order Claude Code stickers"],
  ["/tasks", "/tasks", "List and manage background tasks"],
  ["/terminal-setup", "/terminal-setup", "Configure terminal keybindings for Claude Code"],
  ["/theme", "/theme", "Change the Claude Code color theme"],
  ["/upgrade", "/upgrade", "Open the upgrade page for higher plans"],
  ["/usage", "/usage", "Show plan usage limits and rate limit status"],
  ["/vim", "/vim", "Toggle Vim editing mode"],
  [
    "/claude-api",
    "/claude-api",
    "Load Claude API and Agent SDK reference material for your project",
    "",
    "bundled_skill",
  ],
  [
    "/loop",
    "/loop [interval] <prompt>",
    "Run a prompt repeatedly on a schedule while the session stays open",
    "",
    "bundled_skill",
  ],
  [
    "/debug",
    "/debug [description]",
    "Troubleshoot the current Claude Code session from the debug log",
    "",
    "bundled_skill",
  ],
  [
    "/batch",
    "/batch <change description>",
    "Plan and execute a large multi-part codebase change in parallel",
    "",
    "bundled_skill",
  ],
  [
    "/simplify",
    "/simplify [focus]",
    "Review recent changes for reuse, quality, and efficiency issues, then fix them",
    "",
    "bundled_skill",
  ],
];

// Source: OpenAI Codex CLI slash-command docs + CLI features docs (Apr 2026).
const CODEX_SLASH_COMMAND_ROWS: ClaudeSlashCommandRow[] = [
  ["/permissions", "/permissions", "Set what Codex can do without asking first", "/approvals"],
  ["/sandbox-add-read-dir", "/sandbox-add-read-dir <directory>", "Grant sandbox read access to an extra directory on Windows"],
  ["/agent", "/agent", "Switch the active agent thread"],
  ["/apps", "/apps", "Browse apps and insert them into your prompt"],
  ["/plugins", "/plugins", "Browse installed and discoverable plugins"],
  ["/clear", "/clear", "Clear the terminal and start a fresh chat"],
  ["/compact", "/compact", "Summarize the visible conversation to free tokens"],
  ["/copy", "/copy", "Copy the latest completed Codex output"],
  ["/diff", "/diff", "Show the Git diff, including untracked files"],
  ["/exit", "/exit", "Exit the CLI", "/quit"],
  ["/experimental", "/experimental", "Toggle experimental features"],
  ["/feedback", "/feedback", "Send logs to Codex maintainers"],
  ["/init", "/init", "Generate an AGENTS.md scaffold in the current directory"],
  ["/logout", "/logout", "Sign out of Codex"],
  ["/mcp", "/mcp", "List configured MCP tools"],
  ["/mention", "/mention <path>", "Attach a file or folder to the conversation"],
  ["/model", "/model [model]", "Choose the active model and reasoning effort"],
  ["/fast", "/fast [on|off|status]", "Toggle or inspect Fast mode for supported models"],
  ["/plan", "/plan [prompt]", "Switch to plan mode and optionally send a prompt"],
  ["/personality", "/personality [style]", "Choose a communication style for responses"],
  ["/ps", "/ps", "Show experimental background terminals and recent output"],
  ["/stop", "/stop", "Stop all background terminals", "/clean"],
  ["/fork", "/fork", "Fork the current conversation into a new thread"],
  ["/resume", "/resume", "Resume a saved conversation from your session list"],
  ["/new", "/new", "Start a new conversation inside the same CLI session"],
  ["/quit", "/quit", "Exit the CLI", "/exit"],
  ["/review", "/review", "Ask Codex to review your working tree"],
  ["/status", "/status", "Display session configuration and token usage"],
  ["/debug-config", "/debug-config", "Print config layer and requirements diagnostics"],
  ["/statusline", "/statusline", "Configure TUI status-line fields interactively"],
  ["/title", "/title", "Configure terminal window or tab title fields interactively"],
  ["/theme", "/theme", "Preview and save a preferred TUI theme"],
];

export const CLAUDE_SLASH_COMMANDS: ClaudeSlashCommand[] =
  buildSlashCommands(CLAUDE_SLASH_COMMAND_ROWS);

export const CODEX_SLASH_COMMANDS: ClaudeSlashCommand[] =
  buildSlashCommands(CODEX_SLASH_COMMAND_ROWS);

export function commandAcceptsArguments(usage: string): boolean {
  return usage.includes(" [") || usage.includes(" <");
}

const DOCS_COMMANDS_BY_NAME = new Map(
  CLAUDE_SLASH_COMMANDS.map((command) => [command.command.toLowerCase(), command])
);

export function normalizeClaudeSlashCommandName(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function dedupeClaudeSlashCommands(commands: ClaudeSlashCommand[]): ClaudeSlashCommand[] {
  const seen = new Set<string>();
  const deduped: ClaudeSlashCommand[] = [];

  for (const command of commands) {
    const name = normalizeClaudeSlashCommandName(command.command);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    deduped.push(command);
  }

  return deduped;
}

function inferRuntimeCommandKind(commandName: string): ClaudeSlashCommandKind {
  if (commandName.startsWith("/mcp__")) return "mcp_prompt";
  return "runtime_discovered";
}

function buildRuntimeCommand(commandName: string): ClaudeSlashCommand {
  const normalized = normalizeClaudeSlashCommandName(commandName);
  const fromDocs = DOCS_COMMANDS_BY_NAME.get(normalized);
  if (fromDocs) {
    return {
      ...fromDocs,
      source: "runtime",
    };
  }

  const kind = inferRuntimeCommandKind(normalized);
  return {
    command: normalized,
    usage: `${normalized} [args]`,
    summary:
      kind === "mcp_prompt"
        ? "MCP prompt exposed by a connected Claude runtime server."
        : "Discovered from the installed Claude runtime on this connector.",
    aliases: [],
    kind,
    source: "runtime",
  };
}

export function buildRuntimeClaudeSlashCommands(commands: string[]): ClaudeSlashCommand[] {
  const normalized = Array.from(
    new Set(
      (Array.isArray(commands) ? commands : [])
        .map((command) => normalizeClaudeSlashCommandName(command))
        .filter(Boolean)
    )
  );
  return normalized.map(buildRuntimeCommand);
}

function matchRank(command: ClaudeSlashCommand, rawQuery: string): number | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;

  const commandName = command.command.slice(1).toLowerCase();
  const usage = command.usage.toLowerCase();
  const summary = command.summary.toLowerCase();
  const aliases = command.aliases.map((alias) => alias.slice(1).toLowerCase());

  if (commandName === query) return 0;
  if (aliases.includes(query)) return 1;
  if (commandName.startsWith(query)) return 2;
  if (aliases.some((alias) => alias.startsWith(query))) return 3;
  if (usage.includes(query)) return 4;
  if (summary.includes(query)) return 5;
  return null;
}

const KIND_ORDER: Record<ClaudeSlashCommandKind, number> = {
  built_in: 0,
  bundled_skill: 1,
  mcp_prompt: 2,
  runtime_discovered: 3,
};

export function filterClaudeSlashCommands(
  commands: ClaudeSlashCommand[],
  query: string
): ClaudeSlashCommand[] {
  return dedupeClaudeSlashCommands(commands)
    .map((command) => ({ command, rank: matchRank(command, query) }))
    .filter((entry): entry is { command: ClaudeSlashCommand; rank: number } => entry.rank !== null)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.command.kind !== b.command.kind) {
        return KIND_ORDER[a.command.kind] - KIND_ORDER[b.command.kind];
      }
      return a.command.command.localeCompare(b.command.command);
    })
    .map((entry) => entry.command);
}
