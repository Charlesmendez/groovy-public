import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { parseEmailAddresses } from "@/lib/email/gmail";
import type { EmailSnippet } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function mapSnippet(row: RecordLike): EmailSnippet {
  return {
    id: text(row.id),
    name: text(row.name),
    shortcut: text(row.shortcut),
    mailboxConnectionIds: strings(row.mailbox_connection_ids),
    to: parseEmailAddresses(row.to_recipients),
    cc: parseEmailAddresses(row.cc_recipients),
    bcc: parseEmailAddresses(row.bcc_recipients),
    subject: rawText(row.subject),
    body: rawText(row.body),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

async function listSnippets(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data, error } = await supabase
    .from("email_snippets")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => mapSnippet(row as RecordLike));
}

export async function GET() {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({
      ok: true,
      snippets: await listSnippets(auth.supabase, auth.userId),
    });
  } catch (error) {
    return jsonError(error, "Could not load snippets.");
  }
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const name = text(body?.name);
  const shortcut = text(body?.shortcut).replace(/^\//, "").toLowerCase();
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "Give this snippet a name." },
      { status: 400 },
    );
  }
  if (shortcut && !/^[a-z0-9_-]{1,32}$/i.test(shortcut)) {
    return NextResponse.json(
      { ok: false, error: "Shortcuts can use letters, numbers, _ and -." },
      { status: 400 },
    );
  }
  try {
    const { data, error } = await auth.supabase
      .from("email_snippets")
      .insert({
        user_id: auth.userId,
        name: name.slice(0, 120),
        shortcut: shortcut || null,
        mailbox_connection_ids: strings(body?.mailboxConnectionIds),
        to_recipients: parseEmailAddresses(body?.to),
        cc_recipients: parseEmailAddresses(body?.cc),
        bcc_recipients: parseEmailAddresses(body?.bcc),
        subject: rawText(body?.subject).slice(0, 998),
        body: rawText(body?.body).slice(0, 100_000),
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({
      ok: true,
      snippet: mapSnippet(data as RecordLike),
    });
  } catch (error) {
    return jsonError(error, "Could not create the snippet.");
  }
}

export async function PATCH(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const id = text(body?.id);
  const name = text(body?.name);
  const shortcut = text(body?.shortcut).replace(/^\//, "").toLowerCase();
  if (!id || !name) {
    return NextResponse.json(
      { ok: false, error: "id and name are required." },
      { status: 400 },
    );
  }
  if (shortcut && !/^[a-z0-9_-]{1,32}$/i.test(shortcut)) {
    return NextResponse.json(
      { ok: false, error: "Shortcuts can use letters, numbers, _ and -." },
      { status: 400 },
    );
  }
  try {
    const { data, error } = await auth.supabase
      .from("email_snippets")
      .update({
        name: name.slice(0, 120),
        shortcut: shortcut || null,
        mailbox_connection_ids: strings(body?.mailboxConnectionIds),
        to_recipients: parseEmailAddresses(body?.to),
        cc_recipients: parseEmailAddresses(body?.cc),
        bcc_recipients: parseEmailAddresses(body?.bcc),
        subject: rawText(body?.subject).slice(0, 998),
        body: rawText(body?.body).slice(0, 100_000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", auth.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({
      ok: true,
      snippet: mapSnippet(data as RecordLike),
    });
  } catch (error) {
    return jsonError(error, "Could not update the snippet.");
  }
}

export async function DELETE(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const id =
    new URL(request.url).searchParams.get("id")?.trim() ||
    text(((await request.json().catch(() => null)) as RecordLike | null)?.id);
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id is required." },
      { status: 400 },
    );
  }
  try {
    const { error } = await auth.supabase
      .from("email_snippets")
      .delete()
      .eq("id", id)
      .eq("user_id", auth.userId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not delete the snippet.");
  }
}
