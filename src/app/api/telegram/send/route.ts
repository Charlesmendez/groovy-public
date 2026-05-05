import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendTelegramText, sendTelegramDocument, sendTelegramPhoto } from "@/lib/telegram/client";
import { decryptTelegramBotToken } from "@/lib/telegram/botToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const messageThreadId = typeof body.messageThreadId === "number" ? body.messageThreadId : undefined;
  const media = Array.isArray(body.media) ? body.media : [];

  if (!chatId || (!text && media.length === 0)) {
    return NextResponse.json({ error: "chatId and text or media required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data: botConfig } = await admin
    .from("telegram_bot_configs")
    .select("bot_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!botConfig?.bot_token_encrypted) {
    return NextResponse.json({ error: "No Telegram bot configured" }, { status: 404 });
  }

  const botToken = decryptTelegramBotToken(botConfig.bot_token_encrypted);
  const results: Array<{ type: string; ok: boolean; error?: string }> = [];

  for (const item of media) {
    if (!item || typeof item !== "object") continue;
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const storagePath = typeof item.storagePath === "string" ? item.storagePath.trim() : "";
    const filename = typeof item.filename === "string" ? item.filename.trim() : "";
    const caption = typeof item.caption === "string" ? item.caption.trim() : undefined;

    let resolvedUrl = url;
    if (!resolvedUrl && storagePath) {
      const { data: signedData } = await supabase.storage
        .from("chat_uploads")
        .createSignedUrl(storagePath, 3600);
      if (signedData?.signedUrl) resolvedUrl = signedData.signedUrl;
    }
    if (!resolvedUrl) {
      results.push({ type: "media", ok: false, error: "no_url" });
      continue;
    }

    try {
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filename || resolvedUrl);
      if (isImage) {
        await sendTelegramPhoto({ botToken, chatId: Number(chatId), photo: resolvedUrl, caption, messageThreadId });
      } else {
        await sendTelegramDocument({ botToken, chatId: Number(chatId), document: resolvedUrl, filename: filename || undefined, caption, messageThreadId });
      }
      results.push({ type: "media", ok: true });
    } catch (err) {
      results.push({ type: "media", ok: false, error: err instanceof Error ? err.message : "send_failed" });
    }
  }

  const mediaFailed = results.some((r) => !r.ok);
  if (text && !mediaFailed) {
    try {
      const safeText = text.length > 4096 ? `${text.slice(0, 4076).trimEnd()}\n...(truncated)` : text;
      await sendTelegramText({ botToken, chatId: Number(chatId), text: safeText, messageThreadId });
      results.push({ type: "text", ok: true });
    } catch (err) {
      results.push({ type: "text", ok: false, error: err instanceof Error ? err.message : "send_failed" });
    }
  } else if (text && mediaFailed) {
    results.push({ type: "text", ok: false, error: "skipped_due_media_failure" });
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
