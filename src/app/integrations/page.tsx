"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Globe,
  Shield,
  Terminal,
  Zap,
  Plug,
  Code2,
  Server,
  Lock,
  CheckCircle2,
  FileJson,
  Workflow,
  Eye,
  Users,
  Database,
  Clock,
  AlertTriangle,
  BarChart3,
  MessageSquare,
  Wifi,
  Key,
  Layers,
  BookOpen,
  Cpu,
  GitBranch,
  Search,
  Box,
  Menu,
  X,
} from "lucide-react";

function SectionHeading({ eyebrow, eyebrowIcon: EyebrowIcon, title, description }: {
  eyebrow: string;
  eyebrowIcon: typeof Zap;
  title: React.ReactNode;
  description: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="text-center mb-14"
    >
      <div className="flex items-center justify-center gap-2 mb-4">
        <EyebrowIcon className="w-5 h-5 text-cyan-400" />
        <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">
          {eyebrow}
        </span>
      </div>
      <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">{title}</h2>
      <p className="text-lg text-zinc-500 max-w-2xl mx-auto">{description}</p>
    </motion.div>
  );
}

export default function IntegrationsPage() {
  const [mounted, setMounted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    document.body.style.overflow = "auto";
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = "";
    };
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
            <Link href="/"><Image src="/Groovy_no_bg.png" alt="Groovy" width={400} height={112} className="h-20 sm:h-28 w-auto -my-3 sm:-my-4" unoptimized priority /></Link>
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 20 }} animate={mounted ? { opacity: 1, x: 0 } : {}} transition={{ duration: 0.6 }} className="hidden md:flex items-center gap-2 lg:gap-4">
            <Link href="/integrations" className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors">Integrations</Link>
            <Link href="/account/downloads" className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors">Download</Link>
            <Link href="/#pricing" className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors">Pricing</Link>
            <Link href="/setup" className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors">Setup</Link>
            <Link href="/login" className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors">Sign in</Link>
            <Link href="/dashboard" className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all">Get Started</Link>
          </motion.div>

          <div className="md:hidden flex items-center gap-2">
            <Link
              href="/dashboard"
              className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-xs shadow-lg shadow-cyan-500/20"
            >
              Start
            </Link>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
              className="w-10 h-10 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 flex items-center justify-center"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.nav
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="md:hidden border-t border-white/5 bg-zinc-950/95 backdrop-blur-xl"
            >
              <div className="px-4 py-3 grid grid-cols-2 gap-2">
                {[
                  { label: "Integrations", href: "/integrations" },
                  { label: "Download", href: "/account/downloads" },
                  { label: "Pricing", href: "/#pricing" },
                  { label: "Setup", href: "/setup" },
                  { label: "Sign in", href: "/login" },
                ].map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className="px-3 py-3 rounded-lg border border-white/10 bg-white/[0.03] text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* ================================================================ */}
      {/* HERO                                                             */}
      {/* ================================================================ */}
      <main className="relative z-10 pt-40 pb-8 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={mounted ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.7 }}>
            <div className="flex items-center justify-center gap-2 mb-6">
              <Plug className="w-5 h-5 text-cyan-400" />
              <span className="text-sm font-semibold text-cyan-400 uppercase tracking-widest">Enterprise Integration Platform</span>
            </div>
            <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold text-white leading-[0.95] mb-8">
              Build integrations.
              <br />
              <span className="text-gradient">Groovy executes.</span>
            </h1>
            <p className="text-base text-zinc-400 mb-6 max-w-2xl mx-auto leading-relaxed">
              Groovy is the base agent. Your product becomes a capability inside it.
              No forks, no separate chatbots, no custom UIs.
              You define typed tools. Groovy orchestrates, validates, executes, and tracks everything.
            </p>
            <p className="text-sm text-zinc-600 mb-14 max-w-lg mx-auto">
              Works for SaaS APIs, CLIs, on-prem products, and anything with an HTTP endpoint or a command-line interface.
            </p>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={mounted ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.7, delay: 0.2 }} className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-24">
            <Link href="/integrations/docs" className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all">
              Developer Docs <ArrowRight className="w-4 h-4" />
            </Link>
            <a href="mailto:theshop@gmail.com" className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl border border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05] hover:border-white/20 transition-all">
              Contact Sales
            </a>
          </motion.div>
        </div>
      </main>

      {/* ================================================================ */}
      {/* THE CORE IDEA                                                    */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Core Concept" eyebrowIcon={Layers} title="One agent. Many capabilities." description="Groovy stays the single agent the user talks to. Integrations add new tools and behaviors without creating separate agents, dashboards, or chatbots." />
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              { title: "Extensions are not agents", desc: "Your product does not become its own AI assistant. It becomes a set of typed tools inside Groovy. The user never has to choose which agent to talk to." },
              { title: "Skills teach, tools execute", desc: "Skills are natural language instructions that tell Groovy when and how to use your tools. Tools are the actual executable actions with validated schemas." },
              { title: "Groovy handles the rest", desc: "Routing, input validation, approval checks, execution, error handling, audit logging, usage metering, and response formatting are all handled by Groovy." },
            ].map((item, i) => (
              <motion.div key={item.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}
                className="p-6 rounded-2xl border border-white/10 bg-white/[0.02]">
                <h3 className="text-base font-semibold text-white mb-2">{item.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* HOW IT WORKS — STEP BY STEP                                      */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="How It Works" eyebrowIcon={GitBranch} title="Three steps to a live integration." description="From your product to a Groovy capability in minutes, not months." />
          <div className="grid sm:grid-cols-3 gap-6 sm:gap-8">
            {[
              {
                step: "1", title: "Define Your Tools", description: "Create a JSON manifest that declares your tools. Each tool has a slug, description, input schema (JSON Schema), risk level, auth requirements, and an action that tells Groovy how to execute it.",
                code: `{
  "schemaVersion": 1,
  "displayName": "AcmeOps",
  "capabilityTags": ["incidents", "ops"],
  "skillInstructions": "Use for incident
    and deployment workflows.",
  "tools": [{
    "slug": "create_incident",
    "name": "Create Incident",
    "description": "Create a new incident",
    "riskLevel": "write",
    "authScope": "end_user",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "severity": {
          "type": "string",
          "enum": ["low", "medium", "high"]
        }
      },
      "required": ["title", "severity"]
    },
    "action": {
      "kind": "http_action",
      "method": "POST",
      "url": "{{connection.base_url}}/incidents",
      "headers": {
        "Authorization":
          "Bearer {{connection.api_token}}"
      },
      "body": {
        "title": "{{title}}",
        "severity": "{{severity}}"
      }
    }
  }]
}`,
              },
              {
                step: "2", title: "Install & Configure", description: "Install the extension, choose a runtime, configure auth (per-user or org-wide), set approval policies for destructive actions, and optionally assign a customer runner for CLI/on-prem execution.",
                code: `// 1. Create the extension
POST /api/extensions
{ slug, name, manifest, activate: true }

// 2. Install it
POST /api/extensions/{id}/install
{
  "approvalPolicy": {
    "requireApprovalForRiskLevels":
      ["destructive", "privileged"]
  }
}

// 3. Save connection auth
POST /api/extensions/{id}/connection
{
  "config": {
    "base_url": "https://api.acme.com"
  },
  "secrets": {
    "api_token": "sk-acme-..."
  }
}
// secrets are encrypted with AES-256-GCM
// never returned to the client`,
              },
              {
                step: "3", title: "Users Talk to Groovy", description: "Users don't interact with your integration directly. They talk to Groovy in natural language. Groovy picks the right tool, validates inputs against your schema, checks approvals, executes, and responds.",
                code: `User: "Create a high severity incident
       for checkout failures and assign
       it to the on-call team"

Groovy sees:
  → AcmeOps integration installed
  → ext_acmeops_create_incident available
  → riskLevel: write (no approval needed)
  → authScope: end_user (connected)

Groovy executes:
  POST https://api.acme.com/incidents
  { title: "Checkout failures",
    severity: "high" }

Result:
  ✓ Incident INC-4821 created
  ✓ 1.2s · Audited · Metered`,
              },
            ].map((item, index) => (
              <motion.div key={item.step} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.1 }}
                className="p-6 rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-400">{item.step}</div>
                  <h3 className="text-base font-semibold text-white">{item.title}</h3>
                </div>
                <p className="text-sm text-zinc-500 mb-5 leading-relaxed">{item.description}</p>
                <div className="p-3 rounded-lg bg-black/40 border border-white/5 max-h-[340px] overflow-y-auto">
                  <pre className="text-[11px] text-cyan-300/70 font-mono leading-relaxed whitespace-pre-wrap">{item.code}</pre>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* THREE RUNTIME TYPES — DEEP DIVE                                  */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Runtime Targets" eyebrowIcon={Cpu} title="Execute anywhere your product runs." description="Every integration chooses where its tools execute. Three runtime targets cover SaaS, on-prem, and local-device use cases." />
          <div className="space-y-6">
            {[
              {
                icon: Globe, title: "Groovy Cloud", subtitle: "For SaaS APIs and hosted webhooks", color: "cyan",
                items: [
                  "Groovy calls your API directly from the server",
                  "Template-driven URLs, headers, query params, and request bodies",
                  "Supports GET, POST, PUT, PATCH, DELETE",
                  "Connection secrets (API keys, tokens) encrypted at rest with AES-256-GCM",
                  "Configurable timeouts and response size limits",
                  "Automatic JSON parsing and response truncation for large payloads",
                ],
                example: `"action": {
  "kind": "http_action",
  "method": "POST",
  "url": "{{connection.base_url}}/api/v2/incidents",
  "headers": { "Authorization": "Bearer {{connection.api_token}}" },
  "body": { "title": "{{title}}", "severity": "{{severity}}" },
  "timeoutMs": 15000
}`,
              },
              {
                icon: Terminal, title: "Customer Runner", subtitle: "For CLIs, on-prem, and private networks", color: "violet",
                items: [
                  "You deploy a small HTTPS runner in your environment (any server, container, or VM)",
                  "Groovy sends typed execution requests to the runner over HTTPS with bearer auth",
                  "Runner validates and executes approved CLI commands from argv templates",
                  "No raw shell access — only declared command templates can run",
                  "Runner reports health via heartbeats so Groovy knows when it is online",
                  "Auth tokens are encrypted and verified with SHA-256 hash matching",
                ],
                example: `"action": {
  "kind": "cli_action",
  "argvTemplate": [
    "acmectl", "incident", "create",
    "--title", "{{title}}",
    "--severity", "{{severity}}",
    "--json"
  ],
  "cwd": "/opt/acme",
  "timeoutMs": 30000,
  "maxOutputChars": 8000
}`,
              },
              {
                icon: Wifi, title: "Device Connector", subtitle: "For local-device and personal automations", color: "amber",
                items: [
                  "Tool executes on the user's paired Groovy Connector (macOS/Windows)",
                  "Uses the existing connector relay infrastructure",
                  "Good for local file access, browser automation, or device-specific actions",
                  "Same connector round-trip pattern as built-in Groovy tools",
                ],
                example: `"action": {
  "kind": "connector_action",
  "connectorType": "terminal_exec",
  "params": {
    "command": "acme status --json --env {{env}}"
  }
}`,
              },
            ].map((runtime, i) => {
              const Icon = runtime.icon;
              const colorMap: Record<string, { bg: string; border: string; text: string }> = {
                cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400" },
                violet: { bg: "bg-violet-500/10", border: "border-violet-500/20", text: "text-violet-400" },
                amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400" },
              };
              const c = colorMap[runtime.color];
              return (
                <motion.div key={runtime.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}
                  className="p-6 sm:p-8 rounded-2xl border border-white/10 bg-white/[0.02]">
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-10 h-10 rounded-lg ${c.bg} border ${c.border} flex items-center justify-center`}>
                      <Icon className={`w-5 h-5 ${c.text}`} />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white">{runtime.title}</h3>
                      <p className="text-xs text-zinc-500">{runtime.subtitle}</p>
                    </div>
                  </div>
                  <div className="grid md:grid-cols-2 gap-6 mt-5">
                    <ul className="space-y-2">
                      {runtime.items.map((item) => (
                        <li key={item} className="flex items-start gap-2 text-sm text-zinc-400">
                          <CheckCircle2 className={`w-4 h-4 ${c.text} shrink-0 mt-0.5`} />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="p-3 rounded-lg bg-black/40 border border-white/5 self-start">
                      <pre className="text-[11px] text-cyan-300/70 font-mono leading-relaxed whitespace-pre-wrap">{runtime.example}</pre>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* CONTROL PLANE — GOVERNANCE                                       */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Control Plane" eyebrowIcon={Shield} title="Enterprise governance built in." description="Not bolted on later. Every extension tool call goes through permissions, approvals, audit, and metering from day one." />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { icon: Eye, title: "Audit Events", desc: "Immutable log of who triggered what action, through what identity, with what approval outcome. Every tool call, every time.", color: "cyan" },
              { icon: BarChart3, title: "Usage Metering", desc: "Track duration, bytes in/out, cost, runtime target, adapter type, approval state, and error codes per tool call.", color: "emerald" },
              { icon: Activity, title: "Runtime Traces", desc: "Full execution traces with request/response payloads, error messages, and timing for debugging and performance analysis.", color: "violet" },
              { icon: Database, title: "Analytics Events", desc: "Product analytics for adoption tracking: which integrations are used, how often, by whom, and which tools are most popular.", color: "amber" },
              { icon: AlertTriangle, title: "Risk Levels", desc: "Every tool is classified as read, write, destructive, or privileged. Risk drives approval policy and branch-controller behavior.", color: "red" },
              { icon: CheckCircle2, title: "Approval Policies", desc: "Require human approval for specific risk levels. Per-install, per-tool granularity. Blocked tools return structured approval requests.", color: "emerald" },
              { icon: Key, title: "Auth Scopes", desc: "Four auth scopes: none, end_user, shared_org, service_identity. Each tool declares what it needs. Connections match scope.", color: "cyan" },
              { icon: Lock, title: "Encrypted Secrets", desc: "Connection secrets encrypted with AES-256-GCM before storage. Never returned to the client. Decrypted server-side at execution time only.", color: "violet" },
            ].map((item, index) => {
              const Icon = item.icon;
              const colorMap: Record<string, { bg: string; border: string; text: string }> = {
                cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400" },
                emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400" },
                violet: { bg: "bg-violet-500/10", border: "border-violet-500/20", text: "text-violet-400" },
                amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400" },
                red: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-400" },
              };
              const c = colorMap[item.color] || colorMap.cyan;
              return (
                <motion.div key={item.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.04 }}
                  className="p-5 rounded-xl border border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04] transition-all group">
                  <div className={`w-10 h-10 rounded-lg ${c.bg} border ${c.border} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform`}>
                    <Icon className={`w-5 h-5 ${c.text}`} />
                  </div>
                  <h3 className="text-sm font-semibold text-white mb-1">{item.title}</h3>
                  <p className="text-xs text-zinc-500 leading-relaxed">{item.desc}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* WHAT YOU SHIP — EXTENSION PACK ANATOMY                           */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Extension Pack" eyebrowIcon={Box} title="What you actually ship." description="An Extension Pack is a versioned JSON manifest with five parts. No custom UI code, no server infrastructure (unless you use a runner)." />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: FileJson, title: "Manifest", desc: "Schema version, display name, description, capability tags for routing, and the list of tools. This is the root of the extension." },
              { icon: Zap, title: "Tools", desc: "Each tool has a slug, name, description, input/output JSON Schema, risk level, auth scope, runtime target, and an action definition (HTTP, CLI, or connector)." },
              { icon: BookOpen, title: "Skills", desc: "Optional natural-language instructions that teach Groovy when and how to use your tools. Injected into the system prompt when the extension is installed." },
              { icon: Key, title: "Connections", desc: "Auth configuration per install. Supports per-user tokens, shared org credentials, and service identities. Secrets encrypted at rest." },
              { icon: Server, title: "Runners", desc: "For CLI/on-prem: register HTTPS runners with endpoints, bearer auth, and heartbeats. Groovy sends typed execution requests to the runner." },
              { icon: Shield, title: "Policies", desc: "Approval policies per-install. Choose which risk levels require human approval. Groovy blocks execution and returns structured approval requests." },
            ].map((item, index) => {
              const Icon = item.icon;
              return (
                <motion.div key={item.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.05 }}
                  className="p-5 rounded-xl border border-white/5 bg-white/[0.02]">
                  <Icon className="w-5 h-5 text-cyan-400 mb-3" />
                  <div className="text-sm font-semibold text-white mb-1">{item.title}</div>
                  <div className="text-xs text-zinc-500 leading-relaxed">{item.desc}</div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* TEMPLATE ENGINE                                                  */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Template Engine" eyebrowIcon={Code2} title={<>Dynamic values everywhere via <code className="text-cyan-400 text-[0.85em]">{"{{...}}"}</code></>} description="Reference user arguments, connection secrets, and runtime context in URLs, headers, query params, request bodies, and CLI argv templates." />
          <div className="grid md:grid-cols-2 gap-6">
            <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="space-y-4">
              <h3 className="text-base font-semibold text-white">Available scopes</h3>
              {[
                { scope: "args.*", desc: "User-provided tool arguments (from Groovy's tool call)" },
                { scope: "connection.*", desc: "Merged config + decrypted secrets from the saved connection" },
                { scope: "runtime.user_id", desc: "Current Groovy user ID" },
                { scope: "runtime.trace_id", desc: "Current execution trace ID" },
                { scope: "runtime.session_id", desc: "Current orchestrator session ID" },
                { scope: "runtime.turn_id", desc: "Current turn ID (for billing aggregation)" },
                { scope: "runtime.device_id", desc: "Paired device/connector ID (if present)" },
              ].map((item) => (
                <div key={item.scope} className="flex items-start gap-3">
                  <code className="text-[11px] text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded font-mono shrink-0 mt-0.5">{item.scope}</code>
                  <span className="text-sm text-zinc-500">{item.desc}</span>
                </div>
              ))}
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 }}>
              <h3 className="text-base font-semibold text-white mb-4">Example usage</h3>
              <div className="p-4 rounded-lg bg-black/40 border border-white/5">
                <pre className="text-[11px] text-cyan-300/70 font-mono leading-relaxed whitespace-pre-wrap">{`// HTTP action
"url": "{{connection.base_url}}/api/v2/incidents"
"headers": {
  "Authorization": "Bearer {{connection.api_token}}",
  "X-Request-ID": "{{runtime.trace_id}}"
}
"body": {
  "title": "{{title}}",
  "assignee": "{{assignee}}"
}

// CLI action
"argvTemplate": [
  "acmectl", "incident", "create",
  "--title", "{{title}}",
  "--severity", "{{severity}}",
  "--team", "{{connection.default_team}}"
]

// If the entire value is a single {{...}},
// the resolved type is preserved (not stringified).
// "body": "{{args}}" → passes the full object.`}</pre>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* USE CASES                                                        */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Use Cases" eyebrowIcon={Search} title="Built for real enterprise products." description="Any product with an API or CLI can become a Groovy integration. Here are the patterns we see most." />
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              { title: "Incident Management", desc: "Create, update, escalate, and resolve incidents from natural language. Map severity, assign on-call, post updates — all through Groovy.", example: '"Create a P1 for payment failures and page the on-call"' },
              { title: "Infrastructure Ops", desc: "Rotate API keys, check service health, trigger deploys, manage feature flags. CLI runner executes approved commands in your infra.", example: '"Rotate the staging API key for Team Red"' },
              { title: "CRM & Sales Tools", desc: "Look up contacts, create deals, log activities, update pipeline stages. Groovy becomes the natural-language interface for your sales stack.", example: '"Add a note to the Acme deal that they want Q3 pricing"' },
              { title: "Analytics & Reporting", desc: "Query dashboards, fetch metrics, generate summaries. Read-only tools with no approval required — fast and safe.", example: '"What was our conversion rate last week vs the week before?"' },
              { title: "Internal Tools & Admin", desc: "User management, permission changes, config updates. Destructive actions require approval. Audit log captures who did what.", example: '"Disable the staging account for user@example.com"' },
              { title: "Data Pipelines", desc: "Trigger ETL jobs, check pipeline status, query data warehouses. Groovy wraps your data CLI or API with typed schemas.", example: '"Run the daily revenue sync and tell me when it finishes"' },
            ].map((item, index) => (
              <motion.div key={item.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.05 }}
                className="p-5 rounded-xl border border-white/10 bg-white/[0.02]">
                <h3 className="text-base font-semibold text-white mb-1">{item.title}</h3>
                <p className="text-sm text-zinc-500 mb-3">{item.desc}</p>
                <div className="px-3 py-2 rounded-lg bg-black/30 border border-white/5">
                  <p className="text-xs text-cyan-300/60 font-mono italic">{item.example}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* ARCHITECTURE DIAGRAM                                             */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Architecture" eyebrowIcon={Workflow} title="End-to-end execution flow." description="From enterprise product to audited result in a single Groovy conversation turn." />
          <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
            className="p-6 sm:p-8 rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm">
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-2 text-sm mb-8">
              {[
                { label: "Your Product", sub: "API / CLI / Webhook", color: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/20" },
                { label: "Extension Pack", sub: "Manifest + Tools + Auth", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/20" },
                { label: "Groovy Agent", sub: "Orchestrates & Executes", color: "text-white", bg: "bg-white/5", border: "border-white/10" },
                { label: "Control Plane", sub: "Audit · Usage · Approvals", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
              ].map((item, i) => (
                <div key={item.label} className="flex items-center gap-2">
                  <div className={`px-4 py-3 rounded-xl ${item.bg} border ${item.border} text-center min-w-[140px]`}>
                    <div className={`font-medium ${item.color}`}>{item.label}</div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">{item.sub}</div>
                  </div>
                  {i < 3 && <div className="text-zinc-600 hidden sm:block">→</div>}
                </div>
              ))}
            </div>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              {[
                { step: "1", text: "User sends a message in Groovy chat (dashboard or WhatsApp)" },
                { step: "2", text: "Groovy loads installed extension tools alongside built-in tools" },
                { step: "3", text: "Groovy picks the right tool based on capability tags and skill instructions" },
                { step: "4", text: "Policy engine checks install state, permissions, auth scope, and approval policy" },
                { step: "5", text: "Runtime adapter executes: HTTP fetch, runner POST, or connector relay" },
                { step: "6", text: "Control plane writes usage_meter, audit_event, runtime_trace, and analytics_event" },
                { step: "7", text: "Groovy formats the result and responds to the user normally" },
                { step: "8", text: "If connector-backed: result returns via the existing WhatsApp/relay round-trip" },
              ].map((item) => (
                <div key={item.step} className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02]">
                  <div className="w-6 h-6 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-[11px] font-bold text-cyan-400 shrink-0">{item.step}</div>
                  <span className="text-zinc-400 text-sm">{item.text}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* THREE PERSONAS                                                   */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="Who Uses What" eyebrowIcon={Users} title="Three personas, one platform." description="Developers build integrations. Admins install and govern them. End users just talk to Groovy." />
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              {
                icon: Code2, title: "Developer", color: "violet",
                tasks: [
                  "Define tools with JSON Schema inputs",
                  "Choose runtime target (cloud, runner, connector)",
                  "Write skill instructions for Groovy",
                  "Classify tools by risk level",
                  "Publish the extension pack via API",
                ],
              },
              {
                icon: Shield, title: "Admin", color: "cyan",
                tasks: [
                  "Install extensions for their org/workspace",
                  "Configure auth (per-user or shared)",
                  "Set approval policies for destructive tools",
                  "Register and manage customer runners",
                  "Monitor usage, audit logs, and runner health",
                ],
              },
              {
                icon: MessageSquare, title: "End User", color: "emerald",
                tasks: [
                  "Talks to Groovy in natural language",
                  "Never chooses which integration to use",
                  "Sees lightweight source chips (\"Using AcmeOps\")",
                  "Gets inline auth/connection error messages",
                  "Receives normal Groovy responses with results",
                ],
              },
            ].map((persona, i) => {
              const Icon = persona.icon;
              const colorMap: Record<string, { bg: string; border: string; text: string }> = {
                violet: { bg: "bg-violet-500/10", border: "border-violet-500/20", text: "text-violet-400" },
                cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400" },
                emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400" },
              };
              const c = colorMap[persona.color];
              return (
                <motion.div key={persona.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }}
                  className="p-6 rounded-2xl border border-white/10 bg-white/[0.02]">
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-lg ${c.bg} border ${c.border} flex items-center justify-center`}>
                      <Icon className={`w-5 h-5 ${c.text}`} />
                    </div>
                    <h3 className="text-lg font-semibold text-white">{persona.title}</h3>
                  </div>
                  <ul className="space-y-2">
                    {persona.tasks.map((task) => (
                      <li key={task} className="flex items-start gap-2 text-sm text-zinc-400">
                        <CheckCircle2 className={`w-3.5 h-3.5 ${c.text} shrink-0 mt-0.5`} />
                        <span>{task}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* API SURFACE                                                      */}
      {/* ================================================================ */}
      <section className="relative z-10 py-20 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <SectionHeading eyebrow="API" eyebrowIcon={Globe} title="Full REST API." description="Every operation is an API call. Build dashboards, CI/CD hooks, or CLI tools on top." />
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
            className="p-5 rounded-2xl bg-black/40 border border-white/5">
            <pre className="text-[11px] text-cyan-300/70 font-mono leading-[1.8] whitespace-pre-wrap">{`# Extensions
GET    /api/extensions                          List extensions
POST   /api/extensions                          Create or update extension + version

# Installation
POST   /api/extensions/{id}/install             Install or update installation

# Connections
GET    /api/extensions/{id}/connection          List connections for an extension
POST   /api/extensions/{id}/connection          Create or update connection (secrets encrypted)

# Runners
GET    /api/extensions/runners                  List runners
POST   /api/extensions/runners                  Register or update a runner
POST   /api/extensions/runners/{id}/heartbeat   Runner liveness heartbeat (bearer auth supported)

# All endpoints use standard Supabase cookie auth.
# Runner heartbeat also supports bearer token auth for machine-to-machine.`}</pre>
          </motion.div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* FINAL CTA                                                        */}
      {/* ================================================================ */}
      <section className="relative z-10 py-28 px-6">
        <motion.div initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="max-w-3xl mx-auto text-center">
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
            Your product.
            <br />
            <span className="text-gradient">Groovy&apos;s reach.</span>
          </h2>
          <p className="text-xl text-zinc-500 mb-10 max-w-xl mx-auto">
            Ship an integration in hours. Your users get a capability they can talk to in natural language.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/login" className="inline-flex items-center gap-2 px-10 py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold text-lg shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 transition-all">
              Get Started <ArrowRight className="w-5 h-5" />
            </Link>
            <a href="mailto:theshop@gmail.com" className="inline-flex items-center gap-2 px-10 py-4 rounded-2xl border border-white/20 bg-white/[0.03] text-white font-semibold text-lg hover:bg-white/[0.06] hover:border-white/30 transition-all">
              Talk to Us
            </a>
          </div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 py-12 px-6 border-t border-white/5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/"><Image src="/Groovy_no_bg.png" alt="Groovy" width={200} height={56} className="h-14 w-auto" unoptimized /></Link>
          <p className="text-sm text-zinc-600">&copy; {new Date().getFullYear()} Groovy. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
