import { NextResponse } from "next/server";

// Force Node.js runtime - ssh2 has native bindings incompatible with Edge/Turbopack
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { Client } from "ssh2";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { getAuthedUser } from "@/lib/workspaces";
import { logError, logInfo, logWarn } from "@/lib/observability/log";

function isAllowedEmail(email?: string | null) {
  const allowlist = process.env.HOSTED_MAC_ADMIN_EMAILS || "";
  if (!email || !allowlist.trim()) return false;
  const allowed = allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

function execCommand(conn: Client, command: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("close", (code: number) => {
        if (code !== 0) {
          return reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
        }
        resolve({ stdout, stderr });
      });
      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    });
  });
}

type Body = {
  request_id?: string;
  enable_whatsapp?: boolean;
  relay_url?: string;
  app_url?: string;
  pairing_code?: string;
  shared_root?: string;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  let stage = "init";
  try {
    const user = await getAuthedUser();
    if (!isAllowedEmail(user.email)) {
      logWarn("hosted_mac.bootstrap.forbidden", { user_id: user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.request_id) {
      logWarn("hosted_mac.bootstrap.missing_request_id", { user_id: user.id });
      return NextResponse.json({ error: "Missing request_id" }, { status: 400 });
    }

    stage = "load_assignment";
    const supabase = createSupabaseAdminClient();
    const { data: assignment } = await supabase
      .from("hosted_mac_assignments")
      .select("*")
      .eq("request_id", body.request_id)
      .single();
    if (!assignment) {
      logWarn("hosted_mac.bootstrap.assignment_not_found", {
        request_id: body.request_id,
        user_id: user.id,
      });
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    const privateKey = assignment.ssh_private_key_enc
      ? decryptLlmApiKey(assignment.ssh_private_key_enc)
      : null;
    const password = assignment.ssh_password_enc
      ? decryptLlmApiKey(assignment.ssh_password_enc)
      : null;

    const relayUrl =
      body.relay_url || process.env.GROOVY_RELAY_URL || "wss://groovy-relay.fly.dev";
    const appUrl = body.app_url || process.env.NEXT_PUBLIC_APP_URL || "";
    const defaultTarballUrl =
      "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-Headless.tar.gz";
    const tarballUrl =
      process.env.HOSTED_MAC_BOOTSTRAP_TARBALL_URL || defaultTarballUrl;
    if (!tarballUrl) {
      logWarn("hosted_mac.bootstrap.missing_tarball_url", {
        request_id: body.request_id,
        user_id: user.id,
        has_app_url: !!appUrl,
      });
      return NextResponse.json({ error: "Missing tarball URL" }, { status: 400 });
    }

    logInfo("hosted_mac.bootstrap.start", {
      request_id: body.request_id,
      user_id: user.id,
      provider: assignment.provider,
      hostname: assignment.hostname,
      ssh_port: assignment.ssh_port || 22,
      ssh_user: assignment.ssh_user,
      relay_url: relayUrl,
      has_pairing_code: !!(body.pairing_code && body.pairing_code.trim()),
      enable_whatsapp: body.enable_whatsapp === true,
      tarball_url_set: true,
    });

    stage = "ssh_connect";
    const conn = new Client();
    await new Promise<void>((resolve, reject) => {
      conn
        .on("ready", () => resolve())
        .on("error", (err) => reject(err))
        .connect({
          host: assignment.hostname,
          port: assignment.ssh_port || 22,
          username: assignment.ssh_user,
          privateKey: privateKey || undefined,
          password: privateKey ? undefined : password || undefined,
          readyTimeout: 30_000,
        });
    });

    const installDir = "$HOME/.groovy/connector-headless";
    const plistPath = "/Library/LaunchDaemons/ai.gogroovy.connector.plist";
    const enableWhatsapp = body.enable_whatsapp === true ? "--whatsapp" : "";

    const command = `
set -e
mkdir -p ${installDir}
cd ${installDir}
curl -fsSL "${tarballUrl}" -o connector.tgz
tar -xzf connector.tgz
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found" >&2
  exit 1
fi
sudo tee ${plistPath} >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.gogroovy.connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec "$NODE_BIN" "${installDir}/connector.mjs" --relay "${relayUrl}" ${enableWhatsapp}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GROOVY_APP_URL</key>
    <string>${appUrl}</string>
    <key>GROOVY_PAIRING_CODE</key>
    <string>${body.pairing_code || ""}</string>
    <key>GROOVY_HOSTED_MAC_REQUEST_ID</key>
    <string>${body.request_id || ""}</string>
    <key>GROOVY_HOSTED_TARBALL_URL</key>
    <string>${tarballUrl}</string>
    <key>GROOVY_SHARED_ROOT</key>
    <string>${body.shared_root || ""}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/groovy-connector.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/groovy-connector.log</string>
</dict>
</plist>
PLIST
sudo launchctl unload ${plistPath} 2>/dev/null || true
sudo launchctl load ${plistPath}
`;

    stage = "ssh_exec_bootstrap";
    await execCommand(conn, command);
    conn.end();

    stage = "update_request_status";
    await supabase
      .from("hosted_mac_requests")
      .update({ status: "bootstrapped", updated_at: new Date().toISOString() })
      .eq("id", body.request_id);

    logInfo("hosted_mac.bootstrap.ok", {
      request_id: body.request_id,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bootstrap failed";
    logError("hosted_mac.bootstrap.error", {
      stage,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
