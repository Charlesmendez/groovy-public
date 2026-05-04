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
  const agentId = url.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("chat_sessions")
    .select("id, title, created_at, updated_at")
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sessions: data || [] });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: { agentId?: string; title?: string } | null = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = String(body.agentId || "");
  const title = body.title ? String(body.title) : null;

  if (!agentId) {
    return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: user.id,
      agent_id: agentId,
      title: title || "New chat",
    })
    .select("id, title, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ session: data });
}

export async function DELETE(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Ensure ownership: fetch the session and verify user owns the agent
  const { data: sessionRow, error: sessionErr } = await supabase
    .from("chat_sessions")
    .select("id, agent_id")
    .eq("id", id)
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

  // Delete attachments then messages then session
  const delAtt = await supabase.from("chat_attachments").delete().eq("session_id", id);
  if (delAtt.error) {
    return NextResponse.json({ error: delAtt.error.message }, { status: 500 });
  }
  const delMsg = await supabase.from("chat_messages").delete().eq("session_id", id);
  if (delMsg.error) {
    return NextResponse.json({ error: delMsg.error.message }, { status: 500 });
  }
  const delSes = await supabase.from("chat_sessions").delete().eq("id", id);
  if (delSes.error) {
    return NextResponse.json({ error: delSes.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
