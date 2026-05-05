import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getTelegramMe, setTelegramWebhook, deleteTelegramWebhook, setTelegramBotCommands } from "@/lib/telegram/client";
import { decryptTelegramBotToken, encryptTelegramBotToken } from "@/lib/telegram/botToken";
import { randomBytes } from "crypto";
import { logError, logInfo } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getAppBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    ""
  );
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const { data: config } = await admin
    .from("telegram_bot_configs")
    .select("bot_username, created_at, updated_at")
    .eq("user_id", user.id)
    .single();

  if (!config) {
    return NextResponse.json({ connected: false });
  }

  const { count: groupCount } = await admin
    .from("telegram_groups")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { count: contactCount } = await admin
    .from("telegram_known_contacts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  return NextResponse.json({
    connected: true,
    botUsername: config.bot_username,
    createdAt: config.created_at,
    groupCount: groupCount || 0,
    contactCount: contactCount || 0,
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "connect";
  const admin = createSupabaseAdminClient();

  if (action === "disconnect") {
    const { data: existing } = await admin
      .from("telegram_bot_configs")
      .select("bot_token_encrypted")
      .eq("user_id", user.id)
      .single();

    if (existing) {
      try {
        await deleteTelegramWebhook(decryptTelegramBotToken(existing.bot_token_encrypted));
      } catch {
        // best-effort
      }
      await admin.from("telegram_bot_configs").delete().eq("user_id", user.id);
    }

    logInfo("telegram.setup.disconnect", { user_id: user.id });
    return NextResponse.json({ ok: true, disconnected: true });
  }

  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  if (!botToken) {
    return NextResponse.json({ error: "botToken required" }, { status: 400 });
  }

  let botInfo;
  try {
    botInfo = await getTelegramMe(botToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid token";
    return NextResponse.json({ error: `Failed to verify bot token: ${msg}` }, { status: 400 });
  }

  const baseUrl = getAppBaseUrl();
  if (!baseUrl) {
    return NextResponse.json({ error: "Missing NEXT_PUBLIC_APP_URL" }, { status: 500 });
  }

  const webhookSecret = randomBytes(32).toString("hex");
  const webhookUrl = `${baseUrl}/api/telegram/webhook/${user.id}`;

  try {
    await setTelegramWebhook({
      botToken,
      url: webhookUrl,
      secretToken: webhookSecret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Webhook setup failed";
    return NextResponse.json({ error: `Failed to set webhook: ${msg}` }, { status: 500 });
  }

  await setTelegramBotCommands(botToken, [
    { command: "start", description: "Start a private chat" },
    { command: "new", description: "Reset conversation" },
    { command: "register", description: "Activate bot in a group" },
    { command: "code", description: "Run a Claude Code task on your connector" },
  ]).catch(() => {});

  await admin.from("telegram_bot_configs").upsert(
    {
      user_id: user.id,
      bot_token_encrypted: encryptTelegramBotToken(botToken),
      bot_username: botInfo.username,
      webhook_secret: webhookSecret,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  logInfo("telegram.setup.connect", {
    user_id: user.id,
    bot_username: botInfo.username,
    webhook_url: webhookUrl,
  });

  return NextResponse.json({
    ok: true,
    botUsername: botInfo.username,
    botName: botInfo.first_name,
    webhookUrl,
  });
}
