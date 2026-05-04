#!/usr/bin/env node
/**
 * Test the claude_run handler logic directly (simulates connector receiving a message)
 * 
 * Usage:
 *   node test-claude-handler.mjs "prompt"                      # Basic test
 *   node test-claude-handler.mjs "prompt" /path/to/cwd         # With cwd
 *   node test-claude-handler.mjs "follow-up" /path session_id  # Continue conversation
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import os from "os";

// Load API key from .env (simulating what server would send)
let apiKey = "";
try {
  const envPath = resolve(process.cwd(), "../../.env");
  const envContent = readFileSync(envPath, "utf8");
  const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (match) {
    apiKey = match[1].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("Could not read API key from .env");
  process.exit(1);
}

// Simulate the message the connector would receive
const msg = {
  type: "claude_run",
  request_id: "test-123",
  prompt: process.argv[2] || "Say hello in exactly 3 words",
  cwd: process.argv[3] || process.cwd(),
  api_key: apiKey,
  allowed_tools: "Read,Edit,Bash",
  timeout_ms: 60000,
  session_id: process.argv[4] || "",
};

console.log("=== Testing claude_run handler logic (stream-json) ===");
console.log("Simulated message:", {
  ...msg,
  api_key: msg.api_key.slice(0, 20) + "...",
  session_id: msg.session_id ? msg.session_id.slice(0, 8) + "..." : "(new session)",
});
console.log("");

const prompt = String(msg.prompt || "").trim();
const cwdRaw = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : os.homedir();
const passedApiKey = typeof msg.api_key === "string" ? msg.api_key.trim() : "";
const timeoutMs = Number.isFinite(Number(msg.timeout_ms)) ? Number(msg.timeout_ms) : 5 * 60 * 1000;
const sessionId = typeof msg.session_id === "string" ? msg.session_id.trim() : "";

if (!prompt) {
  console.error("ERROR: missing_prompt");
  process.exit(1);
}
if (!passedApiKey) {
  console.error("ERROR: missing_api_key");
  process.exit(1);
}

const safeCwd = cwdRaw || os.homedir();
const escapedPrompt = prompt.replace(/"/g, '\\"');

// Build command - stream-json requires --verbose with -p
let cmd = `claude -p "${escapedPrompt}" --output-format stream-json --verbose`;
if (sessionId) {
  cmd += ` --resume "${sessionId}"`;
}
cmd += " < /dev/null";

console.log("Command:", cmd);
console.log("CWD:", safeCwd);
console.log("API Key (from message):", passedApiKey.slice(0, 20) + "...");
console.log("");

const startedAt = Date.now();
const streamEvents = [];

const spawnResult = await new Promise((resolve, reject) => {
  let stdout = "";
  let stderr = "";
  
  const child = spawn(cmd, {
    shell: true,
    cwd: safeCwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: passedApiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Stream-json output goes to STDOUT when using Node.js spawn
  child.stdout.on("data", (data) => {
    const chunk = data.toString();
    stdout += chunk;
    
    // Parse stream-json output (newline-delimited JSON)
    const lines = chunk.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        streamEvents.push(event);
        
        // Print progress
        if (event.type === "assistant") {
          const textContent = event.message?.content?.find(c => c.type === "text");
          if (textContent?.text) {
            console.log("[STREAM] assistant:", textContent.text.slice(0, 100) + (textContent.text.length > 100 ? "..." : ""));
          }
        } else if (event.type === "result") {
          console.log("[STREAM] result received");
        } else {
          console.log("[STREAM]", event.type);
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("close", (code) => {
    resolve({ code, stdout, stderr });
  });

  child.on("error", (err) => {
    reject(err);
  });

  setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
});

console.log("");
console.log("=== Result ===");
console.log("Exit code:", spawnResult.code);
console.log("Duration:", Date.now() - startedAt, "ms");
console.log("Stream events:", streamEvents.length);

// Extract final result from stream events
const resultEvent = streamEvents.find(e => e.type === "result");

if (resultEvent) {
  console.log("is_error:", resultEvent.is_error);
  console.log("result:", resultEvent.result?.slice(0, 200) + (resultEvent.result?.length > 200 ? "..." : ""));
  console.log("session_id:", resultEvent.session_id);
  console.log("cost_usd:", resultEvent.total_cost_usd);
  console.log("");
  console.log("SUCCESS - Handler logic works!");
  console.log("");
  console.log("To continue this conversation, run:");
  console.log(`  node test-claude-handler.mjs "your follow-up question" "${safeCwd}" "${resultEvent.session_id}"`);
} else {
  console.log("No result event found in stream");
  console.log("Events received:", streamEvents.map(e => e.type).join(", "));
}
