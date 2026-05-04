/**
 * Hybrid Router for Orchestrator
 * Handles @ mentions for direct addressing and LLM-based routing.
 */

export type AgentType =
  | "browser"
  | "files"
  | "pages"
  | "obsidian"
  | "data"
  | "chat"
  | "schedule"
  | "code";

export interface ParsedInput {
  message: string;
  directAgent: AgentType | null;
  mentionedAgents: AgentType[];
  isRememberCommand: boolean;
  rememberContent: string | null;
}

const AGENT_ALIASES: Record<string, AgentType> = {
  // Browser agent
  browser: "browser",
  web: "browser",
  browse: "browser",
  search: "browser",
  google: "browser",
  scrape: "browser",
  crawl: "browser",

  // Files agent
  files: "files",
  file: "files",
  fs: "files",
  filesystem: "files",
  folder: "files",
  directory: "files",

  // Pages agent (site builder)
  pages: "pages",
  page: "pages",
  site: "pages",
  sites: "pages",
  website: "pages",
  websites: "pages",
  landing: "pages",
  landingpage: "pages",
  vercel: "pages",

  // Obsidian agent
  obsidian: "obsidian",
  notes: "obsidian",
  vault: "obsidian",
  markdown: "obsidian",
  md: "obsidian",

  // Data agent
  data: "data",
  analytics: "data",
  datagran: "data",
  ads: "data",
  google_ads: "data",
  facebook: "data",
  linkedin: "data",
  tiktok: "data",

  // Chat agent
  chat: "chat",
  ai: "chat",
  assistant: "chat",
  llm: "chat",

  // Schedule agent
  schedule: "schedule",
  scheduler: "schedule",
  cron: "schedule",
  remind: "schedule",

  // Code agent (WhatsApp @code relay mode)
  code: "code",
};

/**
 * Parse user input for @ mentions and commands
 */
export function parseInput(rawMessage: string): ParsedInput {
  let message = rawMessage.trim();
  const mentionedAgents: AgentType[] = [];
  const directAgent: AgentType | null = null;
  let isRememberCommand = false;
  let rememberContent: string | null = null;

  // Support "at <agent> ..." as a mention-style shortcut.
  // IMPORTANT: mentions are hints, not hard tool locks.
  const atPrefix = message.match(/^at\s+(\w+)(?:\s+|$)/i);
  if (atPrefix?.[1]) {
    const alias = atPrefix[1].toLowerCase();
    const agent = AGENT_ALIASES[alias];
    if (agent) {
      mentionedAgents.push(agent);
      message = message.replace(/^at\s+\w+(?:\s+|$)/i, "").trim();
    }
  }

  // Heuristic schedule detection remains a hint, not a lock.
  const scheduleLead = message.match(/^schedule\b[:\s]*/i);
  const scheduleIntent =
    scheduleLead ||
    /\b(schedule|scheduled|cron)\b/i.test(message) &&
      /\b(every|daily|weekly|tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}:\d{2})\b/i.test(
        message
      );
  if (scheduleIntent) {
    if (!mentionedAgents.includes("schedule")) mentionedAgents.push("schedule");
    if (scheduleLead) {
      message = message.replace(/^schedule\b[:\s]*/i, "").trim();
    }
  }

  // Check for explicit remember command (STRICT).
  // IMPORTANT: Do NOT treat generic verbs like "store" as memory writes — that collides with Link Inbox
  // ("store these links...") and other workflows. Memory writes should be opt-in and unambiguous.
  const rememberMatch = message.match(
    /^(?:remember(?:\s+that)?|save\s+(?:this|that)\s+to\s+memory|add\s+to\s+memory)\s*[:\-–—,]?\s*(.+)$/i
  );
  if (rememberMatch?.[1]) {
    isRememberCommand = true;
    rememberContent = rememberMatch[1].trim();
  }

  // Check for @ mentions
  const mentionRegex = /@(\w+)/g;
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    const alias = match[1].toLowerCase();
    const agent = AGENT_ALIASES[alias];
    if (agent && !mentionedAgents.includes(agent)) {
      mentionedAgents.push(agent);
    }
  }

  // Remove ONLY recognized @mentions from the message for cleaner prompts.
  // Leave unknown mentions intact (e.g. "@code") so the orchestrator can handle them.
  message = message
    .replace(/@(\w+)(?:\([^)]*\)|:[^\s]+)?\s*/g, (full, rawAlias: string) => {
      const alias = String(rawAlias || "").toLowerCase();
      return AGENT_ALIASES[alias] ? "" : full;
    })
    .trim();

  return {
    message,
    directAgent,
    mentionedAgents,
    isRememberCommand,
    rememberContent,
  };
}

/**
 * Get the appropriate tools based on routing
 */
export function getToolsForRouting(directAgent: AgentType | null): AgentType[] {
  // Mentions are hints, not tool locks. Keep the full toolset available.
  // The only strict mode today is explicit code-mode (set by server-side flow, not mentions).
  if (directAgent === "code") return ["code"];
  return ["browser", "files", "pages", "obsidian", "data", "chat", "schedule"];
}

/**
 * Determine if a message seems to need a specific agent
 * Used for UI suggestions while typing
 */
export function suggestAgents(message: string): AgentType[] {
  const lower = message.toLowerCase();
  const suggestions: AgentType[] = [];

  // Browser hints
  if (
    /\b(website|web|url|browse|google|search online|scrape|crawl|download page|open site)\b/.test(
      lower
    )
  ) {
    suggestions.push("browser");
  }

  // Files hints - includes document creation, charts, Excel generation
  if (
    /\b(file|folder|directory|create file|read file|write|save to|delete file|move file|list files|find file|excel|spreadsheet|chart|pie chart|bar chart|visualization|pdf|docx|pptx|powerpoint|word doc|create.*excel|generate.*file|export.*excel|make.*chart)\b/.test(
      lower
    )
  ) {
    suggestions.push("files");
  }

  // Pages hints - website creation/publishing
  if (
    /\b(page|pages|site|website|landing page|publish|deploy|custom domain|vercel|microsite)\b/.test(
      lower
    )
  ) {
    suggestions.push("pages");
  }

  // Obsidian hints
  if (
    /\b(note|notes|obsidian|vault|markdown|daily note|search notes|create note)\b/.test(
      lower
    )
  ) {
    suggestions.push("obsidian");
  }

  // Data hints
  if (
    /\b(analytics|data|dashboard|ads|google ads|facebook ads|linkedin|tiktok|campaign|metrics|spend|impressions|clicks|conversions)\b/.test(
      lower
    )
  ) {
    suggestions.push("data");
  }

  // Chat hints
  if (
    /\b(chat|conversation|talk|discuss|explain|help me understand|tell me|what is|how does)\b/.test(
      lower
    )
  ) {
    suggestions.push("chat");
  }

  // Schedule hints
  if (
    /\b(schedule|scheduled|cron|remind|every day|daily|weekly|every week|every month|at \d{1,2}:\d{2}|tomorrow|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/.test(
      lower
    )
  ) {
    suggestions.push("schedule");
  }

  return suggestions;
}

/**
 * Build system prompt based on active agents
 */
export type HandshakeContext = {
  handshakeId: string;
  partnerSessionTitle: string;
  partnerSessionId: string;
} | null;

export function buildSystemPrompt(
  memoryContext: string,
  activeAgents: AgentType[],
  handshakeContext?: HandshakeContext
): string {
  const agentDescriptions: Record<AgentType, string> = {
    browser: `**Browser Agent**: Navigate websites, click elements, fill forms, take screenshots, extract content. Use for web browsing, research, scraping, and automation.`,
    files: `**Files Agent**: Analyze and process documents (Excel, PowerPoint, Word, PDF). **Can create new files**: generate Excel spreadsheets, create charts/visualizations, build reports. When the user asks to "create an Excel file", "make a chart", "generate a pie chart", "export to Excel", or similar document creation tasks, route to the Files agent. The user uploads files via the chat input, then the Files agent processes them.`,
    pages: `**Pages Agent**: Build and manage generated Next.js websites. Use for creating site files, running local site preview/dev, publishing to Vercel, custom domain attach/verify, and delete/unpublish operations.`,
    obsidian: `**Obsidian Agent**: Search, read, and write notes in Obsidian vaults. Use for knowledge management, note-taking, and searching the user's personal notes.`,
    data: `**Data Agent**: Connect to marketing platforms (Google Ads, Facebook, LinkedIn, TikTok) and analyze data. Use for analytics, reporting, and insights.`,
    chat: `**AI Chat Agent**: A dedicated conversational AI for open-ended discussion, brainstorming, explanations, and general assistance. Use when the user wants a conversation, needs explanations, or wants to discuss ideas without using specific tools.`,
    schedule: `**Schedule Agent**: Create, list, pause, cancel-next-run, and delete scheduled tasks that run locally on the user's machine. Use when the user asks to run something at a certain time, periodically, or wants to manage scheduled jobs.`,
    code: `**Code Agent**: Relay to a local interactive Claude Code session running on the user's machine. Use for coding tasks that should be executed inside Claude Code.`,
  };

  const activeDescriptions = activeAgents
    .map((agent) => agentDescriptions[agent])
    .join("\n\n");

  let systemPrompt = `You are Groovy, a personal AI assistant. You help users by coordinating specialized agents.

STYLE RULES:
- NEVER use emoticons or emojis
- Be concise and direct
- Do not create tables or elaborate formatting

## CRITICAL: When users ask "how do I use Groovy?", "how can I start using you?", or similar help questions, you MUST respond with this EXACT text (no changes, no additions):

Welcome to Groovy!

This main chat is your Orchestrator. You can ask it to perform a task from any of the agents (the bubbles above) and it will direct the right agent to do it.

How to use:
- Use @ to reference an agent directly. Example: @browser search for..., @files create an Excel...
- Use / to find AI Chat agents you've created and reference them by name
- Use /session to find sessions within agents you want to work on

Before you begin, we recommend:
1. Create AI Chat agents with your favorite models - like a photo agent (using Gemini image pro), a grammar agent using GPT-4o, a writing agent, etc. Go to the AI Chat bubble and click "New agent"
2. Create Data agents for things like Firecrawl (web scraping), Salesforce, etc. Data agents use Claude Opus by default. Find the Data bubble and click to set up.
3. For coding: You'll need Claude Code installed locally with an API key

That's it! Just type what you want to do and I'll help you get it done.

END OF REQUIRED RESPONSE - do not add anything else for help questions.

## Your Capabilities

${activeDescriptions}

## Guidelines

1. **Be concise**: Give direct, actionable answers.
2. **Use tools**: When a task matches an agent's capabilities, use the appropriate tool.
3. **Handle errors gracefully**: If a tool fails, explain what went wrong and suggest alternatives.
`;

  if (handshakeContext) {
    systemPrompt += `
## Active Handshake

You are connected to another agent session: "${handshakeContext.partnerSessionTitle}".
You have a \`handshake_send\` tool available. Use it when you need to:
- Send results, data, or findings to the partner agent
- Ask the partner agent for information or help
- Collaborate on the user's request by exchanging information

The partner agent may also send you messages. Always acknowledge received handshake messages and act on them as instructed by the user.
`;
  }

  if (memoryContext) {
    systemPrompt += `
## Memory Context

The following is relevant context from previous conversations:

${memoryContext}

Use this context to provide personalized responses. Reference previous conversations when relevant.
`;
  }

  return systemPrompt;
}

/**
 * Format agent response for display
 */
export function formatAgentResponse(
  agent: AgentType,
  action: string
): string {
  const agentNames: Record<AgentType, string> = {
    browser: "Browser",
    files: "Files",
    pages: "Pages",
    obsidian: "Obsidian",
    data: "Data",
    chat: "AI Chat",
    schedule: "Schedule",
    code: "Code",
  };

  return `**${agentNames[agent]}**: ${action}`;
}
