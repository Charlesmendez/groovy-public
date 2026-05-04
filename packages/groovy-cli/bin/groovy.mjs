#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const SUPPORTED_DATA_INTEGRATIONS = [
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
];

const MODEL_PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
];

const SETUP_PROMPT_FALLBACK = `# Groovy AI-Agent CLI Setup Instructions

Use this prompt for developer source setup, enterprise self-hosting, or advanced local setup.

This is not the normal personal-user install path. Personal users usually buy or receive a license, sign in to the Groovy account portal, download the connector/current source snapshot they are entitled to, install the connector, and add their own provider keys. They do not need their own Vercel, Supabase, or Fly.io account just to use Groovy.

Ask the user whether this is normal personal use, developer source setup, or enterprise self-hosting. If it is normal personal use, focus on account portal, connector, license activation, provider keys, and optional Datagran setup. If it is developer or enterprise setup, ask which deployment target they want: local, Vercel/Supabase/Fly, Docker, or other.

Use CLI commands first. Store secrets only in .env.local or the target platform secret manager. Never commit secrets.

Run:

\`\`\`bash
groovy doctor --json --env-file .env.local
groovy provider-keys status --json --env-file .env.local
groovy memory status --json --env-file .env.local
groovy integrations list --json
\`\`\`

Configure customer-owned model provider keys for OpenAI, Anthropic, Google, Azure OpenAI, AWS Bedrock, Groq, Mistral, xAI, or the providers the user chooses.

If Groovy Memory or Datagran-backed Data Integrations are enabled, require a Datagran account and DATAGRAN_API_KEY:

\`\`\`bash
groovy memory setup --env-file .env.local --datagran-api-key "$DATAGRAN_API_KEY" --datagran-chat-model "\${DATAGRAN_CHAT_MODEL:-claude-opus-4-6}" --json
groovy memory status --env-file .env.local --json
\`\`\`

Activate the user's Groovy license:

\`\`\`bash
groovy license activate --app "$GROOVY_APP_URL" --license-key "$GROOVY_LICENSE_KEY" --json
\`\`\`

Print connector commands:

\`\`\`bash
groovy connector command --json
\`\`\`

For the full repo version of this prompt, use docs/ai-agent-setup.md.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      args[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function print(data, args) {
  if (args.json) printJson(data);
  else if (typeof data === "string") process.stdout.write(`${data}\n`);
  else printJson(data);
}

function fail(message, args, code = 1) {
  if (args?.json) printJson({ ok: false, error: message });
  else process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function readEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function updateEnvFile(file, updates) {
  const resolved = path.resolve(file);
  const existingText = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
  const seen = new Set();
  const lines = existingText.split(/\r?\n/).map((line) => {
    const idx = line.indexOf("=");
    if (idx < 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, idx);
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(resolved, `${lines.filter((line, index) => index < lines.length - 1 || line.trim()).join("\n")}\n`);
  return resolved;
}

function mergedEnv(args) {
  return { ...readEnvFile(args["env-file"]), ...process.env };
}

function appUrl(args) {
  const env = mergedEnv(args);
  return String(args.app || env.GROOVY_APP_URL || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

async function fetchJson(url, options, args) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    fail(json?.error || `Request failed with ${res.status}`, args, res.status >= 500 ? 2 : 1);
  }
  return json;
}

function localDeviceHash() {
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function help() {
  return `Groovy CLI

Usage:
  groovy doctor [--json] [--env-file .env.local]
  groovy license status --app https://... [--session-cookie "..."] [--json]
  groovy license activate --license-key ... [--app https://...] [--device-name ...] [--json]
  groovy memory status [--env-file .env.local] [--json]
  groovy memory setup --datagran-api-key ... [--env-file .env.local] [--datagran-chat-model claude-opus-4-6]
  groovy integrations list [--json]
  groovy integrations test --provider gmail [--env-file .env.local] [--json]
  groovy provider-keys status [--env-file .env.local] [--json]
  groovy connector command
  groovy setup prompt [--file docs/ai-agent-setup.md]

AI-agent friendly flags:
  --json, --yes, --non-interactive, --env-file <path>
`;
}

async function commandLicenseStatus(args) {
  const headers = {};
  if (args["session-cookie"]) headers.cookie = String(args["session-cookie"]);
  const json = await fetchJson(`${appUrl(args)}/api/licenses/status`, { headers }, args);
  print(json, args);
}

async function commandLicenseActivate(args) {
  const licenseKey = args["license-key"] || args.licenseKey;
  if (!licenseKey) fail("Missing --license-key", args);
  const payload = {
    licenseKey,
    deviceHash: args["device-hash"] || localDeviceHash(),
    deviceName: args["device-name"] || os.hostname(),
    platform: os.platform(),
    appVersion: args["app-version"] || "cli",
  };
  const json = await fetchJson(`${appUrl(args)}/api/licenses/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, args);
  print(json, args);
}

function commandMemoryStatus(args) {
  const env = mergedEnv(args);
  const result = {
    ok: true,
    datagranApiKeyConfigured: !!env.DATAGRAN_API_KEY,
    datagranChatModel: env.DATAGRAN_CHAT_MODEL || "claude-opus-4-6",
    memoryEnabled: !!env.DATAGRAN_API_KEY,
    notes: [
      "Groovy durable memory uses Datagran Brain when DATAGRAN_API_KEY is configured.",
      "Do not place raw keys in docs or logs.",
    ],
  };
  print(result, args);
}

function commandMemorySetup(args) {
  const key = args["datagran-api-key"] || args.key;
  if (!key) fail("Missing --datagran-api-key", args);
  const envFile = args["env-file"] || ".env.local";
  const written = updateEnvFile(envFile, {
    DATAGRAN_API_KEY: key,
    DATAGRAN_CHAT_MODEL: args["datagran-chat-model"] || "claude-opus-4-6",
  });
  print({ ok: true, envFile: written, configured: ["DATAGRAN_API_KEY", "DATAGRAN_CHAT_MODEL"] }, args);
}

function commandIntegrationsList(args) {
  print({
    ok: true,
    providers: SUPPORTED_DATA_INTEGRATIONS,
    setupModes: ["datagran_oauth", "existing_datagran_connection", "web_pixel"],
  }, args);
}

function commandIntegrationsTest(args) {
  const provider = args.provider;
  if (!provider) fail("Missing --provider", args);
  if (!SUPPORTED_DATA_INTEGRATIONS.includes(provider)) fail(`Unsupported integration provider: ${provider}`, args);
  const env = mergedEnv(args);
  print({
    ok: !!env.DATAGRAN_API_KEY,
    provider,
    datagranApiKeyConfigured: !!env.DATAGRAN_API_KEY,
    message: env.DATAGRAN_API_KEY
      ? "Datagran key is configured. Use the portal OAuth/link-token flow for live connection authorization."
      : "DATAGRAN_API_KEY is missing. Run groovy memory setup or set it in your env file.",
  }, args);
}

function commandProviderKeysStatus(args) {
  const env = mergedEnv(args);
  const providers = MODEL_PROVIDER_ENV.map((name) => ({
    env: name,
    configured: !!env[name],
  }));
  print({
    ok: true,
    providers,
    message: "Customer-owned provider keys are the default. Configure only the providers you intend to use.",
  }, args);
}

function commandDoctor(args) {
  const env = mergedEnv(args);
  const checks = [
    ["NEXT_PUBLIC_SUPABASE_URL", !!env.NEXT_PUBLIC_SUPABASE_URL],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", !!env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", !!(env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_SUPABASE_SERVICE_ROLE_KEY)],
    ["RELAY_JWT_SECRET", !!env.RELAY_JWT_SECRET],
    ["LLM_KEY_ENCRYPTION_KEY", !!env.LLM_KEY_ENCRYPTION_KEY],
    ["DATAGRAN_API_KEY", !!env.DATAGRAN_API_KEY],
    ["STRIPE_SECRET_KEY", !!env.STRIPE_SECRET_KEY],
    [
      "STRIPE_GROOVY_PERSONAL_PRICE_ID",
      !!(env.STRIPE_GROOVY_PERSONAL_PRICE_ID || env.STRIPE_PERSONAL_PRICE_ID || env.STRIPE_PRICE_GROOVY_PERSONAL_YEARLY),
    ],
    ["GROOVY_LICENSE_PUBLIC_KEY_PEM", !!(env.GROOVY_LICENSE_PUBLIC_KEY_PEM || env.NEXT_PUBLIC_GROOVY_LICENSE_PUBLIC_KEY_PEM)],
    ["GROOVY_LICENSE_PRIVATE_KEY_PEM", !!env.GROOVY_LICENSE_PRIVATE_KEY_PEM],
  ].map(([name, ok]) => ({ name, ok }));
  print({
    ok: checks.every((c) => c.ok),
    appUrl: appUrl(args),
    checks,
    providerKeysConfigured: MODEL_PROVIDER_ENV.filter((name) => !!env[name]),
    dataIntegrations: SUPPORTED_DATA_INTEGRATIONS,
  }, args);
}

function commandConnector(args) {
  print({
    ok: true,
    commands: {
      devMac:
        'cd apps/connector && GROOVY_APP_URL="${GROOVY_APP_URL:-https://www.gogroovy.ai}" node connector.mjs --relay "${GROOVY_RELAY_URL:-wss://groovy-relay.fly.dev}" --kill-others --no-autostart',
      whatsapp:
        'cd apps/connector && WHATSAPP_GROUP_NAME="${WHATSAPP_GROUP_NAME:-Groovy}" node connector.mjs --relay "${GROOVY_RELAY_URL:-wss://groovy-relay.fly.dev}" --whatsapp --kill-others --no-autostart',
      normalMac: "open /Applications/Groovy\\ Connector.app",
    },
  }, args);
}

function commandSetupPrompt(args) {
  const requestedFile = args.file || args["prompt-file"] || "docs/ai-agent-setup.md";
  const resolved = path.resolve(String(requestedFile));
  if (fs.existsSync(resolved)) {
    const prompt = fs.readFileSync(resolved, "utf8");
    process.stdout.write(prompt);
    if (!prompt.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  process.stdout.write(`${SETUP_PROMPT_FALLBACK}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [group, command] = args._;
  if (!group || group === "help" || args.help) {
    process.stdout.write(help());
    return;
  }
  if (group === "doctor") return commandDoctor(args);
  if (group === "license" && command === "status") return commandLicenseStatus(args);
  if (group === "license" && command === "activate") return commandLicenseActivate(args);
  if (group === "memory" && command === "status") return commandMemoryStatus(args);
  if (group === "memory" && command === "setup") return commandMemorySetup(args);
  if (group === "integrations" && command === "list") return commandIntegrationsList(args);
  if (group === "integrations" && command === "test") return commandIntegrationsTest(args);
  if (group === "provider-keys" && command === "status") return commandProviderKeysStatus(args);
  if (group === "connector") return commandConnector(args);
  if (group === "setup" && command === "prompt") return commandSetupPrompt(args);
  fail(`Unknown command: ${[group, command].filter(Boolean).join(" ")}`, args);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err), parseArgs(process.argv.slice(2)), 2));
