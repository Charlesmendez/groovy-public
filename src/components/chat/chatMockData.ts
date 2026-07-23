// Mock data for the /chat UI prototype. No backend — everything here is
// stand-in content so we can evaluate the feel of the surface before wiring
// harness profiles, channels, and realtime (see plan phases 1-2).

export type MindEffort = "low" | "medium" | "high";
export type ToolPolicy = "everything" | "standard" | "restricted";

export type Mind = {
  id: string;
  name: string;
  color: string;
  model: string;
  effort: MindEffort;
  tagline: string;
  soul: string;
  toolPolicy: ToolPolicy;
  roster: string[]; // agent ids this mind may delegate to
  memory: "workspace" | "mind";
};

export type Person = {
  id: string;
  name: string;
  initials: string;
  hue: number;
  online: boolean;
  you?: boolean;
  role: "admin" | "member";
};

export type Agent = {
  id: string;
  name: string;
  kind: string;
  emoji: string;
  status: "idle" | "working";
  statusLine?: string;
  // Agents are workspace citizens hosted by a device — never anonymous.
  host: string;
  online: boolean;
  contributedBy: string; // person id
};

export type WorkStatus = "queued" | "running" | "approval" | "done" | "declined";

export type Work = {
  id: string;
  title: string;
  agentId: string;
  status: WorkStatus;
  steps: string[];
  stepIndex: number;
  approvalText?: string;
  result?: string;
  duration?: string;
  log?: string[];
};

export type ChatItem =
  | { kind: "divider"; id: string; label: string }
  | {
      kind: "message";
      id: string;
      author: { type: "person" | "mind" | "agent"; id: string };
      text: string;
      time: string;
      workingTrace?: string[];
    }
  | { kind: "work"; id: string; work: Work; time: string };

export type Attention = "listening" | "mention" | "off";
export type MemoryScope = "workspace" | "channel" | "off";

export type Schedule = {
  id: string;
  label: string;
  cadence: string;
  nextRun: string;
};

export type MemoryPage = {
  title: string;
  updated: string;
  excerpt: string;
};

export type Room = {
  id: string;
  kind: "room" | "dm" | "agent";
  name: string;
  topic?: string;
  mindId: string;
  attention: Attention;
  visibility: "public" | "private";
  memoryScope: MemoryScope;
  people: string[];
  agents: string[];
  items: ChatItem[];
  schedules: Schedule[];
  memoryPages: MemoryPage[];
  unread?: number;
};

export type Invite = { email: string; role: "admin" | "member"; status: "pending" | "accepted" };

export const INITIAL_MINDS: Record<string, Mind> = {
  support: {
    id: "support",
    name: "Support Mind",
    color: "#00f0ff",
    model: "Opus 4.6",
    effort: "high",
    tagline: "Calm, precise, customer-first. Never guesses about billing.",
    soul: "You are the Support Mind for Groovy HQ. You are calm, precise, and customer-first. You never guess about billing or refunds — you check. You draft replies for human sign-off unless told to send. You escalate anything legal or security-related to a human immediately.",
    toolPolicy: "standard",
    roster: ["kiko", "scout"],
    memory: "workspace",
  },
  groovy: {
    id: "groovy",
    name: "Groovy",
    color: "#10b981",
    model: "Opus 4.6",
    effort: "medium",
    tagline: "The default mind. Playful, blunt, gets things shipped.",
    soul: "You are Groovy — playful, blunt, allergic to corporate speak. You get things shipped. You propose a plan before touching anything risky, and you keep receipts for everything you do.",
    toolPolicy: "everything",
    roster: ["kiko", "atlas", "scout"],
    memory: "workspace",
  },
  ops: {
    id: "ops",
    name: "Ops Mind",
    color: "#a855f7",
    model: "Sonnet 5",
    effort: "low",
    tagline: "Terse. Loves runbooks, hates surprises.",
    soul: "You are the Ops Mind. Terse and disciplined. You follow runbooks, log every action, and never run destructive operations without explicit human approval in the room.",
    toolPolicy: "restricted",
    roster: ["atlas"],
    memory: "mind",
  },
};

export const PEOPLE: Record<string, Person> = {
  you: { id: "you", name: "Carlos", initials: "CM", hue: 168, online: true, you: true, role: "admin" },
  ana: { id: "ana", name: "Ana", initials: "AV", hue: 330, online: true, role: "member" },
  leo: { id: "leo", name: "Leo", initials: "LR", hue: 42, online: false, role: "member" },
};

export const AGENTS: Record<string, Agent> = {
  kiko: {
    id: "kiko",
    name: "Kiko",
    kind: "Claude Code · api repo",
    emoji: "⚡",
    status: "working",
    statusLine: "replaying webhook payloads…",
    host: "Carlos's MacBook",
    online: true,
    contributedBy: "you",
  },
  atlas: {
    id: "atlas",
    name: "Atlas",
    kind: "Data agent · warehouse",
    emoji: "📊",
    status: "idle",
    host: "hq-server-1 · always on",
    online: true,
    contributedBy: "you",
  },
  scout: {
    id: "scout",
    name: "Scout",
    kind: "Browser agent",
    emoji: "🔎",
    status: "idle",
    host: "Ana's MacBook",
    online: false,
    contributedBy: "ana",
  },
};

export const MOCK_LOG: string[] = [
  "09:49:02 task accepted · context: #support (14 messages) + memory (2 pages)",
  "09:49:04 $ gh api /repos/groovy/api/deployments --jq '.[0]'",
  "09:49:11 deploy 4c19f · yesterday 6:12 PM · 'rename webhook signature header'",
  "09:49:15 $ curl -s staging/webhooks/replay --data @failed_payload_1.json",
  "09:49:22 → 401 invalid_signature (header X-Meridian-Sig not found)",
  "09:49:30 replayed 3/3 failed payloads — all 401 on the same header",
  "09:49:41 diffing 4c19f against Friday's build…",
  "09:50:58 root cause confirmed: X-Signature → X-Meridian-Sig rename",
  "09:51:12 drafted fix: restore legacy header alongside new one (1 line)",
  "09:52:07 receipt written · handing back to Support Mind",
];

export const INITIAL_ROOMS: Room[] = [
  {
    id: "r-support",
    kind: "room",
    name: "support",
    topic: "Customer escalations & triage",
    mindId: "support",
    attention: "listening",
    visibility: "public",
    memoryScope: "workspace",
    people: ["you", "ana", "leo"],
    agents: ["kiko", "scout"],
    schedules: [
      { id: "s1", label: "Morning ticket digest", cadence: "Weekdays · 9:00 AM", nextRun: "tomorrow 9:00 AM" },
      { id: "s2", label: "Weekly escalation review", cadence: "Fridays · 4:00 PM", nextRun: "Fri 4:00 PM" },
    ],
    memoryPages: [
      {
        title: "entities/meridian.md",
        updated: "9:52 AM",
        excerpt: "Enterprise customer, checkout webhooks. Incident 7/23: signature header rename broke deliveries — fixed same morning (PR #418).",
      },
      {
        title: "concepts/webhook-signatures.md",
        updated: "9:51 AM",
        excerpt: "We send X-Signature AND X-Meridian-Sig since 7/23. Never rename without a deprecation window.",
      },
    ],
    items: [
      { kind: "divider", id: "d1", label: "Today" },
      {
        kind: "message",
        id: "m1",
        author: { type: "person", id: "ana" },
        text: "Heads up — Meridian's checkout webhooks started failing around 9:40. Three tickets already.",
        time: "9:47 AM",
      },
      {
        kind: "message",
        id: "m2",
        author: { type: "person", id: "you" },
        text: "@Support can you triage? Check if it's on our side before we reply.",
        time: "9:48 AM",
      },
      {
        kind: "message",
        id: "m3",
        author: { type: "mind", id: "support" },
        text: "On it. Pulling the last two hours of webhook deliveries and yesterday's deploy diff — Kiko is replaying the failed payloads against staging.",
        time: "9:48 AM",
        workingTrace: [
          "recalled entities/meridian.md — enterprise, checkout webhooks",
          "checked ticket queue — 3 open, same error signature",
          "picked Kiko (has the api repo warm) → assign_task",
        ],
      },
      {
        kind: "work",
        id: "w1",
        time: "9:49 AM",
        work: {
          id: "w1",
          title: "Trace Meridian webhook failures",
          agentId: "kiko",
          status: "done",
          steps: [
            "Fetch delivery logs (last 2h)",
            "Replay failed payloads on staging",
            "Diff deploy 4c19f against Friday",
          ],
          stepIndex: 3,
          result: "Root cause: signature header renamed in yesterday's deploy. One-line fix drafted.",
          duration: "3m 12s",
          log: MOCK_LOG,
        },
      },
      {
        kind: "message",
        id: "m4",
        author: { type: "mind", id: "support" },
        text: "It's ours — yesterday's deploy renamed the signature header. Kiko drafted the fix and I wrote replies for all three tickets. Want me to open the PR and send them?",
        time: "9:52 AM",
        workingTrace: [
          "read Kiko's receipt + full log",
          "drafted 3 ticket replies (held for sign-off per my soul)",
          "filed concepts/webhook-signatures.md to memory",
        ],
      },
      {
        kind: "message",
        id: "m5",
        author: { type: "person", id: "ana" },
        text: "ship it 🚀",
        time: "9:53 AM",
      },
      {
        kind: "work",
        id: "w2",
        time: "9:53 AM",
        work: {
          id: "w2",
          title: "Open fix PR + reply to 3 tickets",
          agentId: "kiko",
          status: "done",
          steps: ["Open PR against api repo", "Send ticket replies", "Watch CI"],
          stepIndex: 3,
          result: "PR #418 opened and CI is green. All three tickets answered with the workaround.",
          duration: "2m 40s",
          log: MOCK_LOG,
        },
      },
    ],
  },
  {
    id: "r-eng",
    kind: "room",
    name: "engineering",
    topic: "Build things, break things",
    mindId: "groovy",
    attention: "mention",
    visibility: "public",
    memoryScope: "workspace",
    people: ["you", "leo"],
    agents: ["kiko", "atlas"],
    schedules: [],
    memoryPages: [],
    unread: 2,
    items: [
      { kind: "divider", id: "d1", label: "Today" },
      {
        kind: "message",
        id: "m1",
        author: { type: "person", id: "leo" },
        text: "Reminder: schema migration review at 3. @Groovy is only summoned here — no backseat driving 😄",
        time: "11:02 AM",
      },
    ],
  },
  {
    id: "r-data",
    kind: "room",
    name: "data",
    topic: "Pipelines & dashboards",
    mindId: "ops",
    attention: "listening",
    visibility: "private",
    memoryScope: "channel",
    people: ["you", "ana"],
    agents: ["atlas"],
    schedules: [{ id: "s3", label: "Nightly sync report", cadence: "Daily · 6:00 AM", nextRun: "tomorrow 6:00 AM" }],
    memoryPages: [
      {
        title: "projects/orders-v2-migration.md",
        updated: "yesterday",
        excerpt: "Migration 60% done. Two schema drifts patched 7/22. Backfill pending approval — locks table ~45 min.",
      },
    ],
    items: [
      { kind: "divider", id: "d1", label: "Today" },
      {
        kind: "message",
        id: "m1",
        author: { type: "mind", id: "ops" },
        text: "Nightly sync finished. Two schema drifts in orders_v2, patched and logged. One thing needs a human call:",
        time: "6:12 AM",
      },
      {
        kind: "work",
        id: "w3",
        time: "6:12 AM",
        work: {
          id: "w3",
          title: "Backfill orders_v2 from the fixed schema",
          agentId: "atlas",
          status: "approval",
          approvalText:
            "This locks the orders_v2 table for ~45 minutes. Runbook says: run before 8 AM or after 10 PM. I need a yes from an admin.",
          steps: ["Snapshot current table", "Run backfill (est. 45 min)", "Verify row counts + unlock"],
          stepIndex: 0,
          log: [
            "06:11:48 drift check: orders_v2 vs warehouse schema",
            "06:11:59 2 drifts found · patched columns: discount_type, currency",
            "06:12:04 backfill required for rows before 7/20 · est 45m · TABLE LOCK",
            "06:12:05 runbook ops/backfills.md → requires admin approval in-room",
          ],
        },
      },
    ],
  },
  {
    id: "dm-ana",
    kind: "dm",
    name: "Ana",
    mindId: "groovy",
    attention: "off",
    visibility: "private",
    memoryScope: "off",
    people: ["you", "ana"],
    agents: [],
    schedules: [],
    memoryPages: [],
    items: [
      { kind: "divider", id: "d1", label: "Today" },
      {
        kind: "message",
        id: "m1",
        author: { type: "person", id: "ana" },
        text: "The new chat surface is looking good 👀",
        time: "10:15 AM",
      },
    ],
  },
  {
    id: "agent-kiko",
    kind: "agent",
    name: "Kiko",
    mindId: "groovy",
    attention: "listening",
    visibility: "private",
    memoryScope: "workspace",
    people: ["you"],
    agents: ["kiko"],
    schedules: [],
    memoryPages: [],
    items: [
      { kind: "divider", id: "d1", label: "Today" },
      {
        kind: "message",
        id: "m1",
        author: { type: "agent", id: "kiko" },
        text: "PR #412 is green. I left the deploy for you — say the word.",
        time: "9:58 AM",
      },
    ],
  },
];

export const INITIAL_INVITES: Invite[] = [
  { email: "maria@datagran.io", role: "member", status: "pending" },
];

export const ATTENTION_META: Record<Attention, { label: string; hint: string }> = {
  listening: { label: "listening", hint: "The mind follows everything and joins in when useful." },
  mention: { label: "on mention", hint: "The mind only speaks when someone @mentions it." },
  off: { label: "off", hint: "Humans only. The mind stays out of this room." },
};

export const TOOL_POLICY_META: Record<ToolPolicy, { label: string; hint: string }> = {
  everything: {
    label: "Everything",
    hint: "Full kernel: terminal, browser, files, data, messaging, scheduling. For trusted internal rooms.",
  },
  standard: {
    label: "Standard",
    hint: "Web, data, files, memory, delegation. No terminal or computer control.",
  },
  restricted: {
    label: "Restricted",
    hint: "Read + answer + delegate only. Every side effect needs in-room approval. Required for external-facing minds.",
  },
};

export const MEMORY_SCOPE_META: Record<MemoryScope, { label: string; hint: string }> = {
  workspace: { label: "Workspace", hint: "Reads and writes the shared workspace memory." },
  channel: { label: "This channel only", hint: "A private notebook — pages live under this channel and never leak out." },
  off: { label: "Off", hint: "The mind remembers nothing from this room." },
};

export const MODEL_OPTIONS = ["Opus 4.6", "Sonnet 5", "GPT-5.2", "Gemini 3 Pro"];
