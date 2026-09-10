import fs from "fs/promises";
import path from "path";
import dns from "dns/promises";
import net from "net";
import { execFile } from "child_process";
import { promisify } from "util";
import { workspaceSecretGetValue } from "./credentials.mjs";

const execFileAsync = promisify(execFile);
const ACTION_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]{1,127}$/;
const PLACEHOLDER = /\{\{\s*(args|secret)\.([A-Za-z0-9_]+)\s*\}\}/g;

function plainObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeRelative(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("invalid_action_path");
  return normalized;
}

export function normalizeSkillActionsManifest(raw) {
  if (!plainObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.actions) || raw.actions.length > 50) throw new Error("invalid_actions_manifest");
  const seen = new Set();
  const actions = raw.actions.map((entry) => {
    if (!plainObject(entry)) throw new Error("invalid_action");
    const name = String(entry.name || "");
    if (!ACTION_NAME.test(name) || seen.has(name)) throw new Error("invalid_action_name");
    seen.add(name);
    const secrets = Array.from(new Set((Array.isArray(entry.secrets) ? entry.secrets : []).map(String)));
    if (secrets.some((key) => !SECRET_KEY.test(key))) throw new Error("invalid_action_secret");
    const inputSchema = plainObject(entry.inputSchema) ? entry.inputSchema : { type: "object", properties: {}, additionalProperties: false };
    if (inputSchema.type !== "object" || !plainObject(inputSchema.properties)) throw new Error("invalid_action_input_schema");
    const hasHttp = plainObject(entry.http), hasCommand = plainObject(entry.command);
    if (hasHttp === hasCommand) throw new Error("action_requires_one_runtime");
    let runtime;
    if (hasHttp) {
      const url = String(entry.http.url || "");
      if (/\{\{\s*secret\./i.test(url)) throw new Error("secret_in_action_url");
      const parsed = new URL(url.replace(PLACEHOLDER, "placeholder"));
      if (parsed.protocol !== "https:" || /\{\{/.test(parsed.hostname)) throw new Error("invalid_action_url");
      runtime = { http: { method: String(entry.http.method || "GET").toUpperCase(), url, headers: plainObject(entry.http.headers) ? entry.http.headers : {}, body: entry.http.body ?? null, timeoutMs: Math.min(Math.max(Number(entry.http.timeoutMs) || 30000, 1000), 120000) } };
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(runtime.http.method)) throw new Error("invalid_action_method");
    } else {
      const executable = String(entry.command.executable || "");
      if (!executable || executable.includes("/") || !["node", "python3", "python"].includes(executable)) throw new Error("invalid_action_executable");
      const argv = Array.isArray(entry.command.args) ? entry.command.args.map(String) : [];
      if (argv.some((value) => /\{\{\s*secret\./i.test(value))) throw new Error("secret_in_action_arguments");
      if (!argv.length) throw new Error("missing_action_script");
      safeRelative(argv[0]);
      const env = plainObject(entry.command.env) ? entry.command.env : {};
      const blockedEnv = new Set(["PATH", "HOME", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]);
      for (const key of Object.keys(env)) if (!SECRET_KEY.test(key) || blockedEnv.has(key)) throw new Error("invalid_action_environment");
      runtime = { command: { executable, args: argv, env, timeoutMs: Math.min(Math.max(Number(entry.command.timeoutMs) || 60000, 1000), 300000) } };
    }
    return { name, description: String(entry.description || name).slice(0, 500), inputSchema, secrets, ...runtime };
  });
  return { schemaVersion: 1, actions };
}

function validateArgs(schema, args) {
  if (!plainObject(args)) throw new Error("invalid_action_arguments");
  const props = plainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const key of required) if (!(key in args)) throw new Error(`missing_action_argument:${key}`);
  if (schema.additionalProperties === false) for (const key of Object.keys(args)) if (!(key in props)) throw new Error(`unknown_action_argument:${key}`);
  for (const [key, value] of Object.entries(args)) {
    const expected = plainObject(props[key]) ? String(props[key].type || "") : "";
    if (expected && expected !== "string" && expected !== "number" && expected !== "integer" && expected !== "boolean") throw new Error("unsupported_action_schema");
    if (expected === "string" && typeof value !== "string") throw new Error(`invalid_action_argument:${key}`);
    if ((expected === "number" || expected === "integer") && typeof value !== "number") throw new Error(`invalid_action_argument:${key}`);
    if (expected === "boolean" && typeof value !== "boolean") throw new Error(`invalid_action_argument:${key}`);
  }
}

function render(value, args, secrets) {
  if (typeof value === "string") return value.replace(PLACEHOLDER, (_m, scope, key) => {
    if (scope === "secret") { if (!(key in secrets)) throw new Error(`secret_not_configured:${key}`); return secrets[key]; }
    if (!(key in args)) throw new Error(`missing_action_argument:${key}`); return String(args[key]);
  });
  if (Array.isArray(value)) return value.map((item) => render(item, args, secrets));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, args, secrets)]));
  return value;
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const normalized = ip.toLowerCase(); return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
async function assertPublicHttps(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || !url.hostname.includes(".")) throw new Error("blocked_action_url");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) throw new Error("blocked_action_destination");
}
function redact(text, values) {
  let out = String(text || "");
  for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join("[REDACTED]");
    try { out = out.split(encodeURIComponent(value)).join("[REDACTED]"); } catch {}
  }
  return out.slice(0, 100000);
}

export async function loadSkillActionsManifest(skillDir) {
  const raw = JSON.parse(await fs.readFile(path.join(skillDir, "groovy-actions.json"), "utf8"));
  return normalizeSkillActionsManifest(raw);
}

export async function executeSkillAction({ skillDir, actionName, args, workspaceId, secretBindings }) {
  const secrets = {};
  try {
    const manifest = await loadSkillActionsManifest(skillDir);
    const action = manifest.actions.find((item) => item.name === actionName);
    if (!action) {
      const availableActions = manifest.actions.map((item) => item.name);
      return {
        ok: false,
        error: "action_not_declared",
        message: availableActions.length
          ? `Action ${actionName || "(empty)"} is not declared in the current skill manifest. Use one of: ${availableActions.join(", ")}.`
          : `Action ${actionName || "(empty)"} is not declared in the current skill manifest.`,
        availableActions,
      };
    }
    validateArgs(action.inputSchema, args);
    const bindings = new Map((Array.isArray(secretBindings) ? secretBindings : []).map((item) => [String(item.key), item]));
    for (const key of action.secrets) {
      const binding = bindings.get(key); if (!binding) return { ok: false, error: `secret_not_granted:${key}` };
      const result = await workspaceSecretGetValue({ workspaceId, secretId: binding.id, key });
      if (!result.ok || !result.configured) return { ok: false, error: `secret_not_configured:${key}` };
      secrets[key] = result.value;
    }
    const secretValues = Object.values(secrets).map(String);
    if (action.http) {
      const url = render(action.http.url, args, secrets); await assertPublicHttps(url);
      const headers = render(action.http.headers, args, secrets);
      const bodyValue = action.http.body == null ? null : render(action.http.body, args, secrets);
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), action.http.timeoutMs);
      try {
        const response = await fetch(url, { method: action.http.method, headers, body: bodyValue == null ? undefined : typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue), redirect: "error", signal: controller.signal });
        const text = redact(await response.text(), secretValues);
        return { ok: response.ok, status: response.status, output: text, error: response.ok ? undefined : "action_http_failed" };
      } finally { clearTimeout(timeout); }
    }
    const command = action.command;
    const renderedArgs = render(command.args, args, secrets).map(String);
    const script = path.resolve(skillDir, safeRelative(renderedArgs[0]));
    if (!script.startsWith(path.resolve(skillDir) + path.sep)) throw new Error("invalid_action_script");
    const [realSkillDir, realScript] = await Promise.all([fs.realpath(skillDir), fs.realpath(script)]);
    if (!realScript.startsWith(realSkillDir + path.sep)) throw new Error("action_script_outside_skill");
    renderedArgs[0] = realScript;
    const declaredEnv = render(command.env, args, secrets);
    const env = { PATH: process.env.PATH || "", HOME: process.env.HOME || "", LANG: process.env.LANG || "en_US.UTF-8", ...Object.fromEntries(Object.entries(declaredEnv).map(([key, value]) => [key, String(value)])) };
    const result = await execFileAsync(command.executable, renderedArgs, { cwd: skillDir, env, timeout: command.timeoutMs, maxBuffer: 1024 * 1024 });
    return { ok: true, output: redact(result.stdout, secretValues), stderr: redact(result.stderr, secretValues) };
  } catch (error) {
    return {
      ok: false,
      error: redact(
        error instanceof Error ? error.message : String(error),
        Object.values(secrets).map(String),
      ),
    };
  }
}
