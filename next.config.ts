import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Exclude packages with native bindings or subprocess spawning from bundling.
  // These are resolved via Node.js require() at runtime instead.
  serverExternalPackages: ["ssh2", "@anthropic-ai/claude-agent-sdk"],
  // Agent SDK spawns cli.js as a subprocess at runtime (not imported).
  // File tracing won't discover it automatically, so include it explicitly.
  outputFileTracingIncludes: {
    "/api/orchestrator": [
      "./node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
      "./node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      "./node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    ],
  },
};

export default nextConfig;
