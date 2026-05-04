#!/usr/bin/env node
/**
 * Quick test script to verify claude -p works from Node.js
 * Run: node test-claude-cli.mjs
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load API key from .env file manually
let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    const envPath = resolve(process.cwd(), "../../.env");
    const envContent = readFileSync(envPath, "utf8");
    const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match) {
      apiKey = match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // ignore
  }
}

if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY in environment");
  process.exit(1);
}

const prompt = process.argv[2] || "Say hello in exactly 3 words";
const cwd = process.argv[3] || process.cwd();

console.log("Testing claude -p from Node.js (using spawn with shell)...");
console.log("Prompt:", prompt);
console.log("CWD:", cwd);
console.log("API Key:", apiKey.slice(0, 20) + "...");
console.log("");

// Use spawn with shell: true - this is how the terminal runs commands
const escapedPrompt = prompt.replace(/"/g, '\\"');
const cmd = `claude -p "${escapedPrompt}" --output-format json`;

console.log("Command:", cmd);
console.log("");

const startedAt = Date.now();

const child = spawn(cmd, {
  shell: true,
  cwd,
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
  },
  stdio: ["inherit", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (data) => {
  stdout += data.toString();
  process.stdout.write(data); // Show output in real-time
});

child.stderr.on("data", (data) => {
  stderr += data.toString();
  process.stderr.write(data); // Show errors in real-time
});

child.on("close", (code) => {
  const durationMs = Date.now() - startedAt;
  console.log("");
  console.log(`\nCompleted in ${durationMs}ms with exit code ${code}`);
  
  if (stdout && !stdout.includes("{")) {
    console.log("Note: Output was not JSON");
  }
});

child.on("error", (err) => {
  console.error("Spawn error:", err.message);
});

// Timeout after 90 seconds
setTimeout(() => {
  console.log("\n\nTIMEOUT - killing process");
  child.kill("SIGKILL");
}, 90_000);
