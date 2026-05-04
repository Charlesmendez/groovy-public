import fs from "fs";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { createInterface } from "readline";

const CODEX_PLAN_SESSION_SCAN_LIMIT = 250;
const CODEX_PLAN_CONTENT_MAX_CHARS = 12000;

function normalizeCliString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function expandHomePath(value) {
  const raw = normalizeCliString(value);
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function normalizePlanRoot(value) {
  const expanded = expandHomePath(value);
  return expanded ? path.resolve(expanded) : "";
}

function isSameOrInsidePath(candidate, root) {
  const safeCandidate = normalizePlanRoot(candidate);
  const safeRoot = normalizePlanRoot(root);
  if (!safeCandidate || !safeRoot) return false;
  if (safeCandidate === safeRoot) return true;
  const relative = path.relative(safeRoot, safeCandidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sessionMatchesWorkspaceRoots(cwd, workspaceRoots) {
  const safeCwd = normalizePlanRoot(cwd);
  const safeRoots = workspaceRoots.map(normalizePlanRoot).filter(Boolean);
  if (!safeRoots.length) return true;
  if (!safeCwd) return false;
  return safeRoots.some((root) => isSameOrInsidePath(safeCwd, root) || isSameOrInsidePath(root, safeCwd));
}

function truncatePlanText(value, maxLength = 120) {
  const text = normalizeCliString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseCodexPlanArguments(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rawPlan = Array.isArray(parsed.plan) ? parsed.plan : [];
  const plan = rawPlan
    .map((item) => {
      const step = normalizeCliString(item?.step || item?.text || item?.title);
      if (!step) return null;
      const status = normalizeCliString(item?.status || "pending").toLowerCase() || "pending";
      return { step, status };
    })
    .filter(Boolean);
  if (!plan.length) return null;
  return {
    explanation: normalizeCliString(parsed.explanation),
    plan,
  };
}

function renderCodexPlanMarkdown({ title, workspaceRoot, explanation, plan, sessionId, sourcePath }) {
  const lines = [`# ${title}`, "", "Provider: Codex"];
  if (workspaceRoot) lines.push(`Workspace: ${workspaceRoot}`);
  if (sessionId) lines.push(`Session: ${sessionId}`);
  if (sourcePath) lines.push(`Source: ${sourcePath}`);
  if (explanation) {
    lines.push("", "## Notes", explanation);
  }
  lines.push("", "## Plan");
  for (const item of plan) {
    const status = normalizeCliString(item.status).toLowerCase();
    const checkbox = status === "completed" ? "x" : " ";
    const suffix =
      status && status !== "completed" && status !== "pending" ? ` (${status.replace(/_/g, " ")})` : "";
    lines.push(`- [${checkbox}] ${item.step}${suffix}`);
  }
  const content = lines.join("\n");
  if (content.length <= CODEX_PLAN_CONTENT_MAX_CHARS) return content;
  return `${content.slice(0, CODEX_PLAN_CONTENT_MAX_CHARS).trimEnd()}\n\n...`;
}

async function collectRecentCodexSessionFiles(sessionsRoot) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        try {
          const stat = await fsp.stat(fullPath);
          files.push({ path: fullPath, stat });
        } catch {
          // skip unreadable entries
        }
      }
    }
  }

  await walk(sessionsRoot);
  return files
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, CODEX_PLAN_SESSION_SCAN_LIMIT);
}

async function readCodexSessionIndex() {
  const indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
  const index = new Map();
  try {
    const stream = fs.createReadStream(indexPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = normalizeCliString(entry.id);
        if (!id) continue;
        index.set(id, {
          threadName: normalizeCliString(entry.thread_name),
          updatedAt: normalizeCliString(entry.updated_at),
        });
      } catch {
        // skip malformed index rows
      }
    }
  } catch {
    // no Codex index yet
  }
  return index;
}

async function readCodexPlanFromSession({ filePath, fileStat, workspaceRoots, threadIndex }) {
  let sessionId = "";
  let cwd = "";
  let threadName = "";
  let latestPlan = null;
  let latestPlanAt = "";

  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const shouldParse =
        line.includes('"type":"session_meta"') ||
        line.includes('"name":"update_plan"') ||
        line.includes('"type":"thread_name_updated"') ||
        (!cwd && line.includes('"type":"turn_context"'));
      if (!shouldParse) continue;

      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};

      if (row.type === "session_meta") {
        sessionId = normalizeCliString(payload.id || sessionId);
        cwd = normalizePlanRoot(payload.cwd || cwd);
        if (cwd && !sessionMatchesWorkspaceRoots(cwd, workspaceRoots)) return null;
      } else if (row.type === "turn_context") {
        cwd = normalizePlanRoot(payload.cwd || cwd);
        if (cwd && !sessionMatchesWorkspaceRoots(cwd, workspaceRoots)) return null;
      } else if (row.type === "event_msg" && payload.type === "thread_name_updated") {
        threadName = normalizeCliString(payload.thread_name || threadName);
      } else if (
        row.type === "response_item" &&
        payload.type === "function_call" &&
        payload.name === "update_plan"
      ) {
        const parsedPlan = parseCodexPlanArguments(payload.arguments);
        if (parsedPlan) {
          latestPlan = parsedPlan;
          latestPlanAt = normalizeCliString(row.timestamp) || latestPlanAt;
        }
      }
    }
  } catch {
    return null;
  }

  if (!latestPlan || !sessionMatchesWorkspaceRoots(cwd, workspaceRoots)) return null;

  const indexed = sessionId ? threadIndex.get(sessionId) : null;
  const firstStep = latestPlan.plan[0]?.step || "";
  const workspaceName = cwd ? path.basename(cwd) || cwd : "workspace";
  const title = truncatePlanText(threadName || indexed?.threadName || firstStep || `Codex plan - ${workspaceName}`, 100);
  const sourcePath = filePath;
  const content = renderCodexPlanMarkdown({
    title,
    workspaceRoot: cwd,
    explanation: latestPlan.explanation,
    plan: latestPlan.plan,
    sessionId,
    sourcePath,
  });

  return {
    provider: "codex",
    workspaceRoot: cwd || normalizePlanRoot(workspaceRoots[0]) || path.join(os.homedir(), ".codex"),
    filename: path.basename(filePath).replace(/\.jsonl$/i, ".md"),
    title,
    content,
    modifiedAt: latestPlanAt || indexed?.updatedAt || fileStat.mtime.toISOString(),
    sizeBytes: fileStat.size,
    sourcePath,
    sessionId,
  };
}

export async function collectCodexPlans(workspaceRoots) {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const threadIndex = await readCodexSessionIndex();
  const sessionFiles = await collectRecentCodexSessionFiles(sessionsRoot);
  const plans = [];
  const seenSessionIds = new Set();

  for (const sessionFile of sessionFiles) {
    const plan = await readCodexPlanFromSession({
      filePath: sessionFile.path,
      fileStat: sessionFile.stat,
      workspaceRoots,
      threadIndex,
    });
    if (!plan) continue;
    const key = plan.sessionId || plan.sourcePath;
    if (key && seenSessionIds.has(key)) continue;
    if (key) seenSessionIds.add(key);
    plans.push(plan);
  }

  return plans;
}

async function main() {
  let workspaceRoots = [];
  try {
    const parsed = JSON.parse(process.argv[2] || "[]");
    workspaceRoots = Array.isArray(parsed) ? parsed : [];
  } catch {
    workspaceRoots = [];
  }
  const startedAt = Date.now();
  try {
    const plans = await collectCodexPlans(workspaceRoots);
    process.stdout.write(JSON.stringify({ ok: true, plans, elapsedMs: Date.now() - startedAt }));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - startedAt,
      })
    );
  }
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
});
