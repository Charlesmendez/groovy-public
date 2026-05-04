"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Copy,
  Plug,
  BookOpen,
  Terminal,
  Globe,
  Wifi,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="relative group">
      {label && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/[0.02] rounded-t-xl">
          <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">{label}</span>
          <button onClick={handleCopy} className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-cyan-400 transition-colors">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <div className={`relative p-4 bg-black/40 border border-white/5 overflow-x-auto ${label ? "rounded-b-xl" : "rounded-xl"}`}>
        {!label && (
          <button onClick={handleCopy} className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-zinc-500 hover:text-cyan-400 hover:bg-white/5 transition-all opacity-0 group-hover:opacity-100">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <pre className="text-[12px] text-cyan-300/80 font-mono leading-relaxed whitespace-pre-wrap">{code}</pre>
      </div>
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-white/[0.02] transition-colors">
        {open ? <ChevronDown className="w-4 h-4 text-cyan-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />}
        <span className="text-sm font-medium text-white">{title}</span>
      </button>
      {open && <div className="px-5 pb-5 space-y-4">{children}</div>}
    </div>
  );
}

const AI_PROMPT = `You are building a Groovy integration for my product.

I want a production-ready Groovy Extension Pack, not a generic plugin sketch.
You must follow the Groovy integration contract exactly.

================================================================
WHAT GROOVY IS
================================================================

- Groovy is the base AI agent.
- Integrations are not separate agents.
- An integration becomes a set of typed tools that Groovy can call.
- Groovy handles tool routing, JSON Schema validation, approvals, execution, audit logging, usage metering, and runtime traces.
- The integration should fit the existing Groovy dashboard flow. Do not invent custom frontend UI requirements.

================================================================
SUPPORTED GROOVY CONTRACT
================================================================

Use ONLY the supported fields below. Do not invent extra Groovy fields.

Top-level manifest:
{
  "schemaVersion": 1,
  "displayName": "My Product Name",
  "description": "What my product does",
  "capabilityTags": ["tag1", "tag2"],
  "skillInstructions": "Natural language guidance for when/how Groovy should use these tools",
  "tools": [ ...tool definitions... ]
}

Each tool:
{
  "slug": "action_name",
  "name": "Human Readable Name",
  "description": "What this tool does — Groovy reads this to decide when to use it",
  "riskLevel": "read" | "write" | "destructive" | "privileged",
  "authScope": "none" | "end_user" | "shared_org" | "service_identity",
  "inputSchema": { /* JSON Schema for the tool input */ },
  "outputSchema": { /* Optional JSON Schema for the expected response */ },
  "runtimeTarget": "groovy_cloud" | "customer_runner" | "device_connector",
  "promptHint": "Optional extra hint for Groovy on when to prefer this tool",
  "tags": ["optional", "categorization", "tags"],
  "enabled": true,
  "action": { /* One of the supported action types below */ }
}

Supported action kinds:

1. HTTP Action (for REST APIs / SaaS):
{
  "kind": "http_action",
  "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  "url": "{{connection.base_url}}/api/endpoint",
  "headers": { "Authorization": "Bearer {{connection.api_token}}" },
  "query": { "param": "{{arg_name}}" },
  "body": { "field": "{{arg_name}}" },
  "timeoutMs": 15000,
  "maxResponseChars": 12000
}

2. CLI Action (for command-line tools, runs on a Customer Runner):
{
  "kind": "cli_action",
  "argvTemplate": ["mycli", "command", "--flag", "{{arg_name}}"],
  "cwd": "/opt/myapp",
  "env": { "API_KEY": "{{connection.api_key}}" },
  "timeoutMs": 30000,
  "maxOutputChars": 8000
}

3. Connector Action (for local device execution):
{
  "kind": "connector_action",
  "connectorType": "terminal_exec",
  "params": { "command": "mycli status --json" },
  "message": "Checking local status..."
}

================================================================
TEMPLATE SYNTAX
================================================================

Use {{...}} templates in URLs, headers, query params, bodies, CLI argv entries, env vars, and connector params.

Supported references:
- {{arg_name}} or {{args.arg_name}}              = tool input from inputSchema
- {{connection.base_url}}                        = saved connection config
- {{connection.api_token}}                       = saved connection secret
- {{runtime.user_id}}                            = current Groovy user ID
- {{runtime.trace_id}}                           = execution trace ID
- {{runtime.session_id}}                         = orchestrator session ID
- {{runtime.turn_id}}                            = turn ID
- {{runtime.device_id}}                          = paired connector device ID

Important behavior:
- If the entire value is a single {{...}}, the original type is preserved.
- If a template is embedded inside a longer string, the value is stringified.
- Missing template values cause execution-time errors, so only reference fields that actually exist.

================================================================
RISK LEVELS
================================================================

- "read"        = safe, no side effects (list, get, search, status)
- "write"       = creates or modifies data
- "destructive" = deletes, revokes, rotates, archives, resolves, or other irreversible actions
- "privileged"  = admin/elevated access, permissions, org-wide settings

Choose these carefully because Groovy uses them for approvals and read-only branch gating.

================================================================
AUTH SCOPES
================================================================

- "none"             = no auth required
- "end_user"         = each user connects their own credentials
- "shared_org"       = one shared org credential
- "service_identity" = non-human service principal / service account

Use "end_user" unless there is a strong reason to use shared org credentials.

================================================================
RUNTIME TARGET SELECTION
================================================================

Choose the runtime target based on where execution must happen:

- "groovy_cloud"
  Use this for public SaaS APIs or any HTTP API Groovy can call directly.

- "customer_runner"
  Use this for CLIs, private network services, on-prem systems, or anything that must run in the customer's environment.
  IMPORTANT: customer_runner works through an HTTPS runner today.

- "device_connector"
  Use this only if the action truly belongs on the user's local machine / paired connector.

Default preference:
1. Prefer groovy_cloud for ordinary APIs
2. Prefer customer_runner for CLI / on-prem / private-network execution
3. Use device_connector only for truly local workflows

================================================================
DESIGN GUIDELINES
================================================================

Follow these rules when designing the integration:

1. Prefer 3-8 focused tools instead of a giant tool list.
2. Make each tool description specific enough that Groovy can choose it correctly from natural language.
3. Put cross-tool behavior in skillInstructions.
4. Put tool-specific selection hints in promptHint.
5. Prefer narrow, task-oriented tools over giant generic ones.
6. Prefer JSON-returning APIs and CLI commands with --json when possible.
7. For CLI tools, NEVER generate raw shell strings or pipelines. Use argvTemplate only.
8. Set maxResponseChars / maxOutputChars when payloads may be large.
9. Add outputSchema when the response shape is well-known.
10. Use enabled: false for tools that should exist in the manifest but not yet be exposed.
11. Use tags if there is meaningful categorization, but do not invent meaningless tags.
12. Do not invent unsupported Groovy fields or unsupported action kinds.

================================================================
REGISTRATION API
================================================================

Groovy APIs used to register the integration:

- GET  /api/orchestrator/agents
  Use this to find the agentId.

- POST /api/extensions
  Create a new extension or a new version of an existing one.
  Include "activate": true to make the new version active immediately.
  Request shape:
  {
    "agentId": "agent-uuid",
    "slug": "acmeops",
    "name": "AcmeOps",
    "description": "Optional description",
    "versionLabel": "v1",
    "manifest": { ...full manifest json... },
    "activate": true
  }
  Optional extra fields: extensionId, visibility, runtimeTargetDefault, status

- POST /api/extensions/{id}/install
  Install the extension and optionally set approval policy, version pinning, runner assignment, or runtime target override.
  Request shape:
  {
    "enabled": true,
    "versionId": "optional-version-id",
    "runtimeTargetOverride": "groovy_cloud" | "customer_runner" | "device_connector",
    "runnerId": "optional-runner-id"
  }

- POST /api/extensions/{id}/connection
  Save config + secrets for auth. Secrets are encrypted at rest.
  Request shape:
  {
    "authScope": "end_user" | "shared_org" | "service_identity" | "none",
    "status": "connected",
    "config": { ...non-secret connection config... },
    "secrets": { ...secret values... }
  }

- GET /api/extensions/runners
- POST /api/extensions/runners
- POST /api/extensions/runners/{id}/heartbeat
  Use these if the integration needs a Customer Runner.
  Runner create request shape:
  {
    "agentId": "agent-uuid",
    "name": "AcmeOps Runner",
    "runtimeTarget": "customer_runner",
    "transport": "https",
    "endpoint": "https://runner.example.com",
    "authToken": "runner-shared-secret",
    "status": "online"
  }
  Heartbeat request shape:
  POST /api/extensions/runners/{id}/heartbeat
  Authorization: Bearer <runner authToken>
  {
    "status": "online",
    "metadata": { "version": "1.0.0" },
    "lastSeenAt": "2026-04-11T12:00:00.000Z"
  }

================================================================
CUSTOMER RUNNER CONTRACT
================================================================

If you choose runtimeTarget = "customer_runner", Groovy sends a POST to the runner's /v1/execute endpoint.
The request shape looks like this:

{
  "traceId": "trace-abc",
  "turnId": "turn-xyz",
  "sessionId": "session-456",
  "userId": "user-123",
  "extension": {
    "id": "ext-uuid",
    "slug": "acmeops",
    "name": "AcmeOps",
    "versionId": "ver-uuid"
  },
  "tool": {
    "name": "ext_acmeops_rotate_key",
    "slug": "rotate_api_key",
    "description": "Rotate an API key",
    "riskLevel": "destructive",
    "authScope": "shared_org"
  },
  "action": {
    "kind": "cli_action",
    "argv": ["acmectl", "api-keys", "rotate", "--team", "red", "--env", "staging", "--json"],
    "cwd": "/opt/acme",
    "env": {},
    "timeoutMs": 30000,
    "maxOutputChars": null
  },
  "params": { "team": "red", "env": "staging" },
  "connection": {
    "authScope": "shared_org",
    "config": { "region": "us-east-1" },
    "secrets": { "admin_token": "sk-..." }
  },
  "runtime": {
    "deviceId": null,
    "localTimezone": "America/New_York"
  }
}

The runner should respond with either:

Success:
{
  "ok": true,
  "data": { ...structured result... }
}

Error:
{
  "ok": false,
  "error": "Human-readable error"
}

================================================================
ERROR MODES TO ACCOUNT FOR
================================================================

Design the integration expecting these runtime situations:

- Missing connection -> Groovy returns needsConnection metadata
- Approval required -> Groovy returns approvalRequired metadata
- Runner offline / missing -> Groovy returns needsRunner metadata
- Missing template values -> execution-time error naming the missing field
- API non-2xx -> Groovy captures the HTTP status and truncated response body

================================================================
WHAT I WILL GIVE YOU
================================================================

I will provide:
- PRODUCT NAME
- WHAT THE PRODUCT DOES
- WHETHER IT HAS AN API OR CLI (or both)
- AUTH MODEL
- WHAT USERS SHOULD BE ABLE TO ASK GROOVY TO DO
- EXAMPLE API ENDPOINTS OR CLI COMMANDS
- ANY ACTIONS THAT ARE DESTRUCTIVE OR PRIVILEGED

================================================================
YOUR OUTPUT FORMAT
================================================================

Return your answer in these exact sections:

1. Integration design summary
   - Explain which runtime target you chose and why
   - Explain how you split the product into tools

2. Final Extension Pack manifest JSON
   - Return ONE valid JSON object only
   - Do not include comments inside the JSON

3. Registration commands
   - curl to GET /api/orchestrator/agents
   - curl to POST /api/extensions
   - curl to POST /api/extensions/{id}/install
   - curl to POST /api/extensions/{id}/connection

4. If customer_runner is used
   - curl to POST /api/extensions/runners
   - curl to POST /api/extensions/{id}/install with runnerId
   - a minimal runner implementation sketch (Node.js Express or Python FastAPI)
   - the heartbeat example

5. Test prompts
   - 5 natural-language example prompts a user can ask Groovy

6. Assumptions and open questions
   - Call out anything you had to assume

================================================================
MY PRODUCT
================================================================

PRODUCT NAME:
[REPLACE ME]

WHAT IT DOES:
[REPLACE ME]

API OR CLI:
[REPLACE ME]

AUTH MODEL:
[REPLACE ME]

MUST-HAVE OPERATIONS:
[REPLACE ME]

OPTIONAL OPERATIONS:
[REPLACE ME]

DESTRUCTIVE / PRIVILEGED ACTIONS:
[REPLACE ME]

EXAMPLE API ENDPOINTS OR CLI COMMANDS:
[REPLACE ME]`;

export default function IntegrationsDocsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    document.body.style.overflow = "auto";
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = ""; };
  }, []);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] relative overflow-x-hidden">
      <div className="noise-overlay" />
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/3 left-1/3 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[120px] animate-float" />
        <div className="absolute bottom-1/3 right-1/4 w-[500px] h-[500px] bg-violet-500/10 rounded-full blur-[120px] animate-float" style={{ animationDelay: "-5s" }} />
      </div>
      <div className="fixed inset-0 bg-grid opacity-30" />

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 py-2 flex items-center justify-between">
          <motion.div initial={{ opacity: 0, x: -20 }} animate={mounted ? { opacity: 1, x: 0 } : {}} transition={{ duration: 0.6 }}>
            <Link href="/"><Image src="/Groovy_no_bg.png" alt="Groovy" width={400} height={112} className="h-28 w-auto -my-4" unoptimized priority /></Link>
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 20 }} animate={mounted ? { opacity: 1, x: 0 } : {}} transition={{ duration: 0.6 }} className="flex items-center gap-1.5 sm:gap-4">
            <Link href="/integrations" className="px-2 sm:px-5 py-2.5 text-xs sm:text-sm font-medium text-zinc-300 hover:text-white transition-colors">Overview</Link>
            <Link href="/login" className="px-2 sm:px-5 py-2.5 text-xs sm:text-sm font-medium text-zinc-300 hover:text-white transition-colors">Sign in</Link>
            <Link href="/dashboard" className="px-3 sm:px-5 py-2 sm:py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-xs sm:text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all">Dashboard</Link>
          </motion.div>
        </div>
      </header>

      <main className="relative z-10 pt-40 pb-16 px-6">
        <div className="max-w-3xl mx-auto">

          {/* Title */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={mounted ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6 }} className="mb-16">
            <div className="flex items-center gap-2 mb-4">
              <BookOpen className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">Developer Docs</span>
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-white mb-4">Build a Groovy Integration</h1>
            <p className="text-lg text-zinc-400">
              Step-by-step guide to ship an integration in under 10 minutes.
              Use the dashboard UI for manual setup, or the API for scripted setup.
              You can also copy the full AI build prompt below and let your agent generate the manifest for you.
            </p>
          </motion.div>

          <motion.section initial={{ opacity: 0, y: 20 }} animate={mounted ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6, delay: 0.05 }} className="mb-16">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-2 mb-3">
                  <Plug className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-base font-semibold text-white">Path A: Dashboard UI</h2>
                </div>
                <p className="text-sm text-zinc-400 mb-3">
                  Best if you are setting up one integration manually.
                </p>
                <div className="space-y-2 text-sm text-zinc-500">
                  <p>1. Open <Link href="/dashboard" className="text-cyan-400 hover:text-cyan-300">Dashboard</Link> and click <span className="text-zinc-300">Integrations</span>.</p>
                  <p>2. Click <span className="text-zinc-300">Create Integration</span>.</p>
                  <p>3. Fill <span className="text-zinc-300">Slug</span>, <span className="text-zinc-300">Name</span>, choose a runtime target, and paste your manifest JSON.</p>
                  <p>4. Click <span className="text-zinc-300">Create &amp; Activate</span>.</p>
                  <p>5. Open the integration detail, click <span className="text-zinc-300">Install Integration</span>, then paste <span className="text-zinc-300">Config (JSON)</span> and <span className="text-zinc-300">Secrets (JSON)</span> and click <span className="text-zinc-300">Save Connection</span>.</p>
                  <p>6. If you use <code className="text-cyan-400">cli_action</code>, open <span className="text-zinc-300">Runners</span> and click <span className="text-zinc-300">Register Runner</span>.</p>
                </div>
              </div>

              <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-2 mb-3">
                  <Globe className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-base font-semibold text-white">Path B: API / curl</h2>
                </div>
                <p className="text-sm text-zinc-400 mb-3">
                  Best if you want reproducible setup, automation, CI, or generated onboarding scripts.
                </p>
                <div className="space-y-2 text-sm text-zinc-500">
                  <p>1. Generate your manifest JSON.</p>
                  <p>2. Call <code className="text-cyan-400">POST /api/extensions</code>.</p>
                  <p>3. Call <code className="text-cyan-400">POST /api/extensions/{`{id}`}/install</code>.</p>
                  <p>4. Call <code className="text-cyan-400">POST /api/extensions/{`{id}`}/connection</code>.</p>
                  <p>5. If you need a Customer Runner, register it with <code className="text-cyan-400">POST /api/extensions/runners</code>.</p>
                  <p>6. If you need to bind a specific runner to an install, use the API install call with <code className="text-cyan-400">runnerId</code>. The dashboard UI does not expose runner assignment yet.</p>
                </div>
              </div>
            </div>
          </motion.section>

          {/* ============================================================ */}
          {/* AI PROMPT — THE MAIN SHORTCUT                                */}
          {/* ============================================================ */}
          <motion.section initial={{ opacity: 0, y: 20 }} animate={mounted ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6, delay: 0.1 }} className="mb-16">
            <div className="p-6 rounded-2xl border border-cyan-500/30 bg-cyan-500/[0.04]">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                  <Terminal className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Full AI build prompt</h2>
                  <p className="text-xs text-zinc-500">Paste into Claude, ChatGPT, or any AI agent. Open the prompt below only if you want to inspect or copy the full instructions.</p>
                </div>
              </div>
              <Collapsible title="Open full AI agent build prompt">
                <CopyBlock code={AI_PROMPT} label="Full AI Agent Build Prompt" />
              </Collapsible>
              <p className="mt-4 text-xs text-zinc-500">
                After your AI generates the manifest, either paste it into the dashboard <span className="text-zinc-300">Integrations</span> flow or use the API steps below.
              </p>
            </div>
          </motion.section>

          {/* ============================================================ */}
          {/* MANUAL STEP-BY-STEP                                          */}
          {/* ============================================================ */}
          <div className="space-y-12">

            {/* Step 1 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">1</div>
                <h2 className="text-xl font-semibold text-white">Understand the manifest</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                A Groovy integration is an <strong className="text-white">Extension Pack</strong> — a single JSON object
                that declares your tools, how to execute them, and how to describe them to the AI.
              </p>
              <CopyBlock label="Manifest structure" code={`{
  "schemaVersion": 1,
  "displayName": "Your Product Name",
  "description": "One sentence about what your product does",
  "capabilityTags": ["ops", "incidents"],
  "skillInstructions": "Use this integration when the user asks about incidents or on-call.",
  "tools": [
    { /* ...tool definitions... */ }
  ]
}`} />
              <div className="mt-4 space-y-2">
                {[
                  { field: "displayName", desc: "Shown in the Groovy dashboard and chat source chips" },
                  { field: "description", desc: "Short description of your product, shown to admins in the integrations panel" },
                  { field: "capabilityTags", desc: "Help Groovy find your tools when the user asks relevant questions — acts as a pre-routing index" },
                  { field: "skillInstructions", desc: "Natural language guidance injected into the AI prompt — teach Groovy when to prefer your tools over others" },
                ].map((item) => (
                  <div key={item.field} className="flex items-start gap-2 text-sm">
                    <code className="text-[11px] text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5">{item.field}</code>
                    <span className="text-zinc-500">{item.desc}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Step 2 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">2</div>
                <h2 className="text-xl font-semibold text-white">Define your tools</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                Each tool represents one action the AI can take. The AI reads the <code className="text-cyan-400">description</code> to decide when to use it,
                and validates user input against the <code className="text-cyan-400">inputSchema</code> before execution.
              </p>

              <Collapsible title="HTTP Action — for REST APIs" defaultOpen>
                <p className="text-sm text-zinc-500 mb-3">
                  Groovy calls your API server-side. Use <code className="text-cyan-400">{`{{connection.field}}`}</code> for auth
                  and <code className="text-cyan-400">{`{{arg_name}}`}</code> for user-provided values.
                </p>
                <CopyBlock code={`{
  "slug": "list_incidents",
  "name": "List Incidents",
  "description": "List open incidents, optionally filtered by severity",
  "riskLevel": "read",
  "authScope": "end_user",
  "inputSchema": {
    "type": "object",
    "properties": {
      "severity": {
        "type": "string",
        "enum": ["low", "medium", "high", "critical"],
        "description": "Filter by severity level"
      },
      "limit": {
        "type": "integer",
        "description": "Max results to return",
        "minimum": 1,
        "maximum": 100
      }
    }
  },
  "action": {
    "kind": "http_action",
    "method": "GET",
    "url": "{{connection.base_url}}/api/v2/incidents",
    "headers": {
      "Authorization": "Bearer {{connection.api_token}}"
    },
    "query": {
      "severity": "{{severity}}",
      "limit": "{{limit}}"
    },
    "timeoutMs": 10000
  }
}`} />
              </Collapsible>

              <div className="h-3" />

              <Collapsible title="CLI Action — for command-line tools">
                <p className="text-sm text-zinc-500 mb-3">
                  Groovy sends a typed execution request to your <strong className="text-white">Customer Runner</strong>. The runner
                  validates and executes the command. No raw shell — only declared argv templates.
                </p>
                <CopyBlock code={`{
  "slug": "rotate_api_key",
  "name": "Rotate API Key",
  "description": "Rotate an API key for a specific team and environment",
  "riskLevel": "destructive",
  "authScope": "shared_org",
  "inputSchema": {
    "type": "object",
    "properties": {
      "team": { "type": "string", "description": "Team slug" },
      "env": {
        "type": "string",
        "enum": ["staging", "production"],
        "description": "Target environment"
      }
    },
    "required": ["team", "env"]
  },
  "action": {
    "kind": "cli_action",
    "argvTemplate": [
      "acmectl", "api-keys", "rotate",
      "--team", "{{team}}",
      "--env", "{{env}}",
      "--json"
    ],
    "cwd": "/opt/acme",
    "timeoutMs": 30000
  }
}`} />
              </Collapsible>

              <div className="h-3" />

              <Collapsible title="Connector Action — for local device">
                <p className="text-sm text-zinc-500 mb-3">
                  Runs on the user&apos;s paired Groovy Connector. Good for local files, browser automation, or machine-specific commands.
                </p>
                <CopyBlock code={`{
  "slug": "check_local_status",
  "name": "Check Local Status",
  "description": "Check the local service status on the user's machine",
  "riskLevel": "read",
  "authScope": "none",
  "inputSchema": { "type": "object", "properties": {} },
  "action": {
    "kind": "connector_action",
    "connectorType": "terminal_exec",
    "params": {
      "command": "acme status --json"
    }
  }
}`} />
              </Collapsible>

              <div className="mt-4 p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                <h4 className="text-sm font-medium text-white mb-2">Risk levels cheat sheet</h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { level: "read", desc: "Safe, no side effects", color: "text-emerald-400" },
                    { level: "write", desc: "Creates or modifies data", color: "text-amber-400" },
                    { level: "destructive", desc: "Deletes or is irreversible", color: "text-red-400" },
                    { level: "privileged", desc: "Admin / elevated access", color: "text-red-400" },
                  ].map((item) => (
                    <div key={item.level} className="flex items-center gap-2">
                      <code className={`${item.color} font-mono`}>{item.level}</code>
                      <span className="text-zinc-500">{item.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                <h4 className="text-sm font-medium text-white mb-2">Optional tool fields</h4>
                <div className="space-y-2 text-xs">
                  {[
                    { field: "outputSchema", desc: "JSON Schema for the expected response. Not enforced at runtime, but documents your API contract." },
                    { field: "promptHint", desc: "Extra guidance injected per-tool into the AI prompt. Use for nuance like \"prefer this over list_all when the user specifies a filter\"." },
                    { field: "tags", desc: "Categorization tags for the tool (e.g. [\"read-only\", \"billing\"]). Used for future capability routing." },
                    { field: "enabled", desc: "Set to false to include the tool in the manifest but hide it from Groovy at runtime. Defaults to true." },
                    { field: "runtimeTarget", desc: "Override the extension default per-tool. One tool can be groovy_cloud while another is customer_runner." },
                    { field: "maxResponseChars", desc: "(HTTP actions) Truncate response bodies larger than this. Default: 12000 chars." },
                    { field: "maxOutputChars", desc: "(CLI actions) Truncate CLI stdout larger than this. Sent to runner in the request." },
                    { field: "env", desc: "(CLI actions) Environment variables passed to the runner. Supports templates like {{connection.api_key}}." },
                    { field: "message", desc: "(Connector actions) Custom progress message shown in chat while the action runs." },
                  ].map((item) => (
                    <div key={item.field} className="flex items-start gap-2">
                      <code className="text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5">{item.field}</code>
                      <span className="text-zinc-500">{item.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Step 3 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">3</div>
                <h2 className="text-xl font-semibold text-white">Template syntax</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                Use <code className="text-cyan-400">{`{{...}}`}</code> in URLs, headers, query params, request bodies, and CLI args.
                Values are resolved at execution time.
              </p>
              <CopyBlock label="Available scopes" code={`{{arg_name}}              → Tool argument from inputSchema
{{connection.base_url}}   → Saved connection config field
{{connection.api_token}}  → Saved connection secret (decrypted at runtime)
{{runtime.user_id}}       → Current Groovy user ID
{{runtime.trace_id}}      → Current execution trace ID
{{runtime.session_id}}    → Current orchestrator session
{{runtime.turn_id}}       → Current turn (for billing)
{{runtime.device_id}}     → Paired connector device ID

If the entire value is a single {{...}}, the resolved
type is preserved (object/array stays an object/array).
Inside a larger string, it's stringified.`} />
            </section>

            {/* Step 4 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">4</div>
                <h2 className="text-xl font-semibold text-white">Register with Groovy</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                You have two valid options here.
                Use the dashboard if you are doing this manually, or use the API if you want automation or CI.
              </p>

              <div className="mb-6 p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04]">
                <div className="text-sm font-medium text-white mb-2">Dashboard path</div>
                <div className="space-y-2 text-sm text-zinc-400">
                  <p>Open <Link href="/dashboard" className="text-cyan-400 hover:text-cyan-300">Dashboard</Link> and click <span className="text-zinc-300">Integrations</span> in the header.</p>
                  <p>Create the integration, then open its detail page to install it and save the connection.</p>
                  <p>If the integration uses <code className="text-cyan-400">cli_action</code>, register a runner from the <span className="text-zinc-300">Runners</span> view.</p>
                  <p>If you need to bind a specific runner to the installation, use the API install call with <code className="text-cyan-400">runnerId</code> for now.</p>
                </div>
              </div>

              <div className="space-y-4">
                <CopyBlock label="Step 4a — Create extension" code={`curl -X POST https://your-groovy-url/api/extensions \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "agentId": "YOUR_AGENT_ID",
    "slug": "acmeops",
    "name": "AcmeOps",
    "description": "Incident management for AcmeOps",
    "runtimeTargetDefault": "groovy_cloud",
    "manifest": { ... your manifest JSON ... },
    "activate": true
  }'

# Response includes: { extension: { id: "EXT_ID" }, version: { id: "..." } }`} />

                <CopyBlock label="Step 4b — Install it" code={`curl -X POST https://your-groovy-url/api/extensions/EXT_ID/install \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "approvalPolicy": {
      "requireApprovalForRiskLevels": ["destructive", "privileged"]
    }
  }'`} />

                <CopyBlock label="Step 4c — Save connection auth" code={`curl -X POST https://your-groovy-url/api/extensions/EXT_ID/connection \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "config": {
      "base_url": "https://api.acme.com"
    },
    "secrets": {
      "api_token": "sk-acme-your-token-here"
    }
  }'

# Secrets are encrypted with AES-256-GCM before storage.
# They are never returned to the client.`} />
              </div>
            </section>

            {/* Step 5 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">5</div>
                <h2 className="text-xl font-semibold text-white">Test it</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                Go to the Groovy dashboard and ask something that should trigger your integration.
                Groovy will show a source chip like <code className="text-cyan-400">Using AcmeOps</code> when it uses your tool.
              </p>
              <div className="p-5 rounded-2xl border border-white/10 bg-white/[0.02] space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-zinc-400 shrink-0 mt-0.5">U</div>
                  <p className="text-sm text-zinc-300 italic">&quot;List all high severity incidents&quot;</p>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-cyan-500/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Plug className="w-3 h-3 text-cyan-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">Using AcmeOps</span>
                      <span className="text-[10px] text-zinc-600">ext_acmeops_list_incidents</span>
                    </div>
                    <p className="text-sm text-zinc-300">Found 3 high severity incidents: INC-4821 (Checkout failures), INC-4819 (API latency spike), INC-4815 (Database connection pool exhausted).</p>
                  </div>
                </div>
              </div>
            </section>

            {/* CLI Runner setup */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-sm font-bold text-violet-400">+</div>
                <h2 className="text-xl font-semibold text-white">Optional: Set up a Customer Runner</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                If your integration uses <code className="text-cyan-400">cli_action</code>, you need a runner in your environment.
                The runner is a small HTTPS server that receives typed execution requests from Groovy.
              </p>

              <CopyBlock label="Register a runner" code={`curl -X POST https://your-groovy-url/api/extensions/runners \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "agentId": "YOUR_AGENT_ID",
    "name": "production-east",
    "endpoint": "https://runner.internal.acme.com:8443",
    "authToken": "runner-secret-token-here",
    "status": "online"
  }'

# Response: { runner: { id: "RUNNER_ID" } }`} />

              <div className="mt-4" />

              <CopyBlock label="Install extension with runner" code={`curl -X POST https://your-groovy-url/api/extensions/EXT_ID/install \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "runtimeTargetOverride": "customer_runner",
    "runnerId": "RUNNER_ID"
  }'`} />

              <div className="mt-4" />

              <Collapsible title="Runner request/response format">
                <p className="text-sm text-zinc-500 mb-3">
                  Groovy sends a POST to your runner&apos;s <code className="text-cyan-400">/v1/execute</code> endpoint:
                </p>
                <CopyBlock code={`// Request from Groovy → Runner
POST /v1/execute
Authorization: Bearer runner-secret-token-here
Content-Type: application/json

{
  "traceId": "trace-abc",
  "turnId": "turn-xyz",
  "sessionId": "session-456",
  "userId": "user-123",
  "extension": {
    "id": "ext-uuid",
    "slug": "acmeops",
    "name": "AcmeOps",
    "versionId": "ver-uuid"
  },
  "tool": {
    "name": "ext_acmeops_rotate_key",
    "slug": "rotate_api_key",
    "description": "Rotate an API key for a team",
    "riskLevel": "destructive",
    "authScope": "shared_org"
  },
  "action": {
    "kind": "cli_action",
    "argv": ["acmectl", "api-keys", "rotate",
             "--team", "red", "--env", "staging", "--json"],
    "cwd": "/opt/acme",
    "env": {},
    "timeoutMs": 30000,
    "maxOutputChars": null
  },
  "params": { "team": "red", "env": "staging" },
  "connection": {
    "authScope": "shared_org",
    "config": { "region": "us-east-1" },
    "secrets": { "admin_token": "sk-..." }
  },
  "runtime": {
    "deviceId": null,
    "localTimezone": "America/New_York"
  }
}

// Success response
{
  "ok": true,
  "data": {
    "keyId": "key_123",
    "rotatedAt": "2026-04-11T18:20:00Z"
  }
}

// Error response
{
  "ok": false,
  "error": "Permission denied: requires admin role"
}`} />
              </Collapsible>

              <div className="mt-4" />

              <Collapsible title="Runner heartbeat">
                <p className="text-sm text-zinc-500 mb-3">
                  Your runner should POST a heartbeat periodically so Groovy knows it&apos;s alive.
                  Supports both cookie auth and bearer token auth.
                </p>
                <CopyBlock code={`# Heartbeat from runner (bearer auth)
curl -X POST https://your-groovy-url/api/extensions/runners/RUNNER_ID/heartbeat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer runner-secret-token-here" \\
  -d '{
    "status": "online",
    "metadata": {
      "version": "1.2.0",
      "uptime_seconds": 86400
    }
  }'`} />
              </Collapsible>
            </section>

            {/* Error handling */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-sm font-bold text-amber-400">!</div>
                <h2 className="text-xl font-semibold text-white">Error handling</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                Groovy returns structured errors to the AI so it can explain failures to the user clearly.
              </p>
              <div className="space-y-3">
                {[
                  { error: "Missing template value", when: "A {{...}} reference resolves to undefined", ai_sees: "Template resolution error with the missing field name" },
                  { error: "Connection required", when: "Tool has authScope ≠ \"none\" but no connection is saved or the connection status is not \"connected\"", ai_sees: "{ needsConnection: true, extension: \"slug\", authScope: \"end_user\" }" },
                  { error: "Approval required", when: "The install's approval policy includes the tool's riskLevel", ai_sees: "{ approvalRequired: true, extension: \"slug\", riskLevel: \"destructive\" }" },
                  { error: "Runner not online", when: "CLI action with a registered runner that is offline or missing", ai_sees: "{ needsRunner: true, runnerId: \"...\", runnerStatus: \"offline\" }" },
                  { error: "API error", when: "Your API returns a non-2xx status", ai_sees: "The HTTP status code and response body (truncated)" },
                ].map((item) => (
                  <div key={item.error} className="p-3 rounded-xl border border-white/5 bg-white/[0.02]">
                    <div className="text-sm font-medium text-white mb-1">{item.error}</div>
                    <div className="text-xs text-zinc-500 mb-1"><strong className="text-zinc-400">When:</strong> {item.when}</div>
                    <div className="text-xs text-zinc-500"><strong className="text-zinc-400">AI sees:</strong> <code className="text-cyan-400/70">{item.ai_sees}</code></div>
                  </div>
                ))}
              </div>
            </section>

            {/* Versioning & updating */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-sm font-bold text-violet-400">~</div>
                <h2 className="text-xl font-semibold text-white">Updating an extension</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                To ship a new version, POST to the same endpoint with the existing <code className="text-cyan-400">extensionId</code>.
                A new version is created automatically. Set <code className="text-cyan-400">activate: true</code> to make it live immediately.
              </p>
              <CopyBlock label="Update an existing extension" code={`curl -X POST https://your-groovy-url/api/extensions \\
  -H "Content-Type: application/json" \\
  -b "your-session-cookie" \\
  -d '{
    "extensionId": "EXISTING_EXT_ID",
    "agentId": "YOUR_AGENT_ID",
    "slug": "acmeops",
    "name": "AcmeOps",
    "manifest": { ... updated manifest ... },
    "activate": true
  }'

# A new version is created.
# If activate: true, it becomes the active version immediately.
# If activate: false, the previous version stays live.
# Existing installations automatically use the active version.`} />
              <p className="mt-3 text-xs text-zinc-500">
                You can also pin an installation to a specific version by passing <code className="text-cyan-400">versionId</code> in the install call.
                If not pinned, installations always use the extension&apos;s active version.
              </p>
            </section>

            {/* Finding your agentId */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">?</div>
                <h2 className="text-xl font-semibold text-white">Finding your agentId</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                Every Groovy user has an orchestrator agent. The <code className="text-cyan-400">agentId</code> is needed for all extension API calls.
              </p>
              <CopyBlock label="List your agents" code={`curl https://your-groovy-url/api/orchestrator/agents \\
  -b "your-session-cookie"

# Response: [{ "id": "YOUR_AGENT_ID", "name": "...", "type": "..." }, ...]
# Use the id of your main orchestrator agent.`} />
              <p className="mt-3 text-xs text-zinc-500">
                You can also find it in the dashboard: open the Integrations panel and the agent ID is used automatically.
              </p>
            </section>

            {/* Full example */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-sm font-bold text-emerald-400">*</div>
                <h2 className="text-xl font-semibold text-white">Complete example: AcmeOps</h2>
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                A full working manifest with 3 tools: list, create, and close incidents.
              </p>

              <CopyBlock label="Full AcmeOps manifest" code={`{
  "schemaVersion": 1,
  "displayName": "AcmeOps",
  "description": "Incident management for Acme operations teams",
  "capabilityTags": ["incidents", "ops", "on-call"],
  "skillInstructions": "Use AcmeOps tools when the user asks about incidents, outages, on-call, or operational issues. For severity, map urgency words: 'urgent'/'critical'/'P1' → high, 'important' → medium, default → low.",
  "tools": [
    {
      "slug": "list_incidents",
      "name": "List Incidents",
      "description": "List incidents from AcmeOps, optionally filtered by severity or status",
      "riskLevel": "read",
      "authScope": "end_user",
      "inputSchema": {
        "type": "object",
        "properties": {
          "severity": { "type": "string", "enum": ["low", "medium", "high"] },
          "status": { "type": "string", "enum": ["open", "resolved", "all"] }
        }
      },
      "action": {
        "kind": "http_action",
        "method": "GET",
        "url": "{{connection.base_url}}/api/v2/incidents",
        "headers": { "Authorization": "Bearer {{connection.api_token}}" },
        "query": { "severity": "{{severity}}", "status": "{{status}}" }
      }
    },
    {
      "slug": "create_incident",
      "name": "Create Incident",
      "description": "Create a new incident in AcmeOps",
      "riskLevel": "write",
      "authScope": "end_user",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "Short incident title" },
          "severity": { "type": "string", "enum": ["low", "medium", "high"] },
          "description": { "type": "string", "description": "Detailed description" }
        },
        "required": ["title", "severity"]
      },
      "action": {
        "kind": "http_action",
        "method": "POST",
        "url": "{{connection.base_url}}/api/v2/incidents",
        "headers": {
          "Authorization": "Bearer {{connection.api_token}}",
          "Content-Type": "application/json"
        },
        "body": {
          "title": "{{title}}",
          "severity": "{{severity}}",
          "description": "{{description}}"
        }
      }
    },
    {
      "slug": "close_incident",
      "name": "Close Incident",
      "description": "Resolve and close an incident by its ID",
      "riskLevel": "write",
      "authScope": "end_user",
      "inputSchema": {
        "type": "object",
        "properties": {
          "incident_id": { "type": "string", "description": "Incident ID (e.g. INC-4821)" },
          "resolution": { "type": "string", "description": "Resolution summary" }
        },
        "required": ["incident_id"]
      },
      "action": {
        "kind": "http_action",
        "method": "POST",
        "url": "{{connection.base_url}}/api/v2/incidents/{{incident_id}}/resolve",
        "headers": { "Authorization": "Bearer {{connection.api_token}}" },
        "body": { "resolution": "{{resolution}}" }
      }
    }
  ]
}`} />
            </section>

          </div>

          {/* Bottom CTA */}
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="mt-20 text-center">
            <p className="text-sm text-zinc-500 mb-6">
              Need help? Questions about the platform?
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/integrations" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05] hover:border-white/20 transition-all text-sm">
                Platform Overview
              </Link>
              <a href="mailto:theshop@gmail.com" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all text-sm">
                Contact Us <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </motion.div>

        </div>
      </main>

      <footer className="relative z-10 py-12 px-6 border-t border-white/5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/"><Image src="/Groovy_no_bg.png" alt="Groovy" width={200} height={56} className="h-14 w-auto" unoptimized /></Link>
          <p className="text-sm text-zinc-600">&copy; {new Date().getFullYear()} Groovy. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
