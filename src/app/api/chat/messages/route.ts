import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const { data: messages, error: msgError } = await supabase
    .from("chat_messages")
    .select("id, role, content, created_at, metadata")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  const { data: attachments, error: attError } = await supabase
    .from("chat_attachments")
    .select("id, file_name, mime_type, size_bytes, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });

  if (attError) {
    return NextResponse.json({ error: attError.message }, { status: 500 });
  }

  return NextResponse.json({ messages: messages || [], attachments: attachments || [] });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body:
    | { sessionId?: unknown; role?: unknown; content?: unknown; metadata?: unknown }
    | null = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : String(body.sessionId || "");
  const role = typeof body.role === "string" ? body.role : String(body.role || "");
  const content = typeof body.content === "string" ? body.content : String(body.content || "");
  const metadata =
    body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  if (!role || !["user", "assistant", "system", "tool"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }

  // Ownership check: ensure session belongs to user via agent ownership.
  const { data: sessionRow, error: sessionErr } = await supabase
    .from("chat_sessions")
    .select("id, agent_id")
    .eq("id", sessionId)
    .single();

  if (sessionErr || !sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const { data: agentRow, error: agentErr } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("id", sessionRow.agent_id)
    .single();

  if (agentErr || !agentRow || agentRow.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      role,
      content,
      metadata: metadata || {},
    })
    .select("id, role, content, created_at, metadata")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: data });
}
