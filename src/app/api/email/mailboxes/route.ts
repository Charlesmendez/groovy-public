import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  findOwnedGmailMailbox,
  loadGmailMailboxes,
  publicMailbox,
} from "@/lib/email/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function value(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  try {
    const mailboxes = await loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
    });
    return NextResponse.json({
      ok: true,
      mailboxes: mailboxes.map((mailbox) => publicMailbox(mailbox)),
    });
  } catch (error) {
    return jsonError(error, "Could not load mailboxes.");
  }
}

export async function PATCH(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const connectionId = value(body?.connectionId);
  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "connectionId is required." },
      { status: 400 },
    );
  }
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    const color = value(body?.color) || mailbox.color;
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      return NextResponse.json(
        { ok: false, error: "Choose a valid mailbox color." },
        { status: 400 },
      );
    }
    const isDefaultSender =
      typeof body?.isDefaultSender === "boolean"
        ? body.isDefaultSender
        : mailbox.isDefaultSender;
    if (isDefaultSender) {
      await auth.supabase
        .from("email_mailbox_preferences")
        .update({ is_default_sender: false, updated_at: new Date().toISOString() })
        .eq("user_id", auth.userId)
        .eq("provider", "gmail")
        .neq("connection_id", connectionId);
    }
    const { error } = await auth.supabase
      .from("email_mailbox_preferences")
      .upsert(
        {
          user_id: auth.userId,
          provider: "gmail",
          connection_id: connectionId,
          display_name: value(body?.displayName) || mailbox.displayName,
          color,
          is_default_sender: isDefaultSender,
          included_in_unified:
            typeof body?.includedInUnified === "boolean"
              ? body.includedInUnified
              : mailbox.includedInUnified,
          ai_instructions:
            typeof body?.aiInstructions === "string"
              ? body.aiInstructions.slice(0, 4000)
              : mailbox.aiInstructions,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider,connection_id" },
      );
    if (error) throw new Error(error.message);
    const refreshed = await loadGmailMailboxes({
      supabase: auth.supabase,
      userId: auth.userId,
    });
    return NextResponse.json({
      ok: true,
      mailboxes: refreshed.map((item) => publicMailbox(item)),
    });
  } catch (error) {
    return jsonError(error, "Could not save mailbox settings.");
  }
}
