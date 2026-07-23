import { NextResponse } from "next/server";

// Force Node.js runtime - ssh2 has native bindings incompatible with Edge/Turbopack
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { Client } from "ssh2";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { signedArtifactUrl } from "@/lib/downloads/artifacts";
import { getAuthedUser } from "@/lib/workspaces";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { getConfiguredAppUrl, getRelayUrl } from "@/lib/config/appConfig";

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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validHostedMacValue(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error("Invalid hosted Mac bootstrap value");
  }
  return text;
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

    const relayUrl = getRelayUrl() || "";
    const appUrl = getConfiguredAppUrl() || "";
    if (!relayUrl || !appUrl) {
      return NextResponse.json(
        { error: "GROOVY_APP_URL and GROOVY_RELAY_URL must be configured" },
        { status: 503 }
      );
    }
    const pairingCode = validHostedMacValue(body.pairing_code, 128);
    const requestId = validHostedMacValue(body.request_id, 128);
    const sharedRoot = validHostedMacValue(body.shared_root, 512);
    const tarballRef = process.env.HOSTED_MAC_BOOTSTRAP_TARBALL_URL || "";
    const tarballUrl = await signedArtifactUrl(supabase, tarballRef, 60 * 60);
    if (!tarballUrl) {
      logWarn("hosted_mac.bootstrap.missing_tarball_url", {
        request_id: body.request_id,
        user_id: user.id,
        has_app_url: !!appUrl,
        tarball_ref_set: !!tarballRef,
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
    const enableWhatsapp = body.enable_whatsapp === true ? " --whatsapp" : "";
    const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.gogroovy.connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec "$(command -v node)" "${installDir}/connector.mjs" --relay "${xmlEscape(relayUrl)}"${enableWhatsapp}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GROOVY_APP_URL</key>
    <string>${xmlEscape(appUrl)}</string>
    <key>GROOVY_PAIRING_CODE</key>
    <string>${xmlEscape(pairingCode)}</string>
    <key>GROOVY_HOSTED_MAC_REQUEST_ID</key>
    <string>${xmlEscape(requestId)}</string>
    <key>GROOVY_HOSTED_TARBALL_URL</key>
    <string>${xmlEscape(tarballUrl)}</string>
    <key>GROOVY_SHARED_ROOT</key>
    <string>${xmlEscape(sharedRoot)}</string>
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
`;
    const plistB64 = Buffer.from(plistXml, "utf8").toString("base64");

    const command = `
set -e
mkdir -p ${installDir}
cd ${installDir}
curl -fsSL ${shQuote(tarballUrl)} -o connector.tgz
tar -xzf connector.tgz
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found" >&2
  exit 1
fi
printf %s ${shQuote(plistB64)} | base64 -d | sudo tee ${shQuote(plistPath)} >/dev/null
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
