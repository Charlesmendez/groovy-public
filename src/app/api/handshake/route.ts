import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CreateHandshakeBody = {
  paneASessionId?: string;
  paneBSessionId?: string;
};

function normalizeSessionPair(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

/**
 * POST /api/handshake
 * Create or reopen a handshake session between two orchestrator sessions.
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as CreateHandshakeBody | null;
  const paneASessionId =
    typeof body?.paneASessionId === "string" ? body.paneASessionId.trim() : "";
  const paneBSessionId =
    typeof body?.paneBSessionId === "string" ? body.paneBSessionId.trim() : "";

  if (!paneASessionId || !paneBSessionId || paneASessionId === paneBSessionId) {
    return NextResponse.json(
      { error: "paneASessionId and paneBSessionId are required and must differ" },
      { status: 400 }
    );
  }

  const [sessionA, sessionB] = normalizeSessionPair(paneASessionId, paneBSessionId);

  const { data: sessions, error: sessionError } = await supabase
    .from("orchestrator_sessions")
    .select("id,title")
    .in("id", [sessionA, sessionB]);
  if (sessionError) {
    return NextResponse.json({ error: "Failed to validate sessions" }, { status: 500 });
  }
  if (!Array.isArray(sessions) || sessions.length !== 2) {
    return NextResponse.json({ error: "One or both sessions not found" }, { status: 404 });
  }

  const titleBySessionId = new Map<string, string>();
  for (const row of sessions) {
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const title =
      typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled";
    titleBySessionId.set(id, title);
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("handshake_sessions")
    .select("id,status,created_at,pane_a_session_id,pane_b_session_id")
    .eq("user_id", user.id)
    .or(
      `and(pane_a_session_id.eq.${sessionA},pane_b_session_id.eq.${sessionB}),and(pane_a_session_id.eq.${sessionB},pane_b_session_id.eq.${sessionA})`
    )
    .order("created_at", { ascending: true })
    .limit(1);
  if (existingError) {
    return NextResponse.json({ error: "Failed to lookup handshake" }, { status: 500 });
  }
  const existing =
    Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;

  let handshakeId = "";
  let createdAt = new Date().toISOString();

  if (existing?.id) {
    handshakeId = String(existing.id);
    createdAt =
      typeof existing.created_at === "string" && existing.created_at.trim()
        ? existing.created_at
        : createdAt;

    if (existing.status !== "active") {
      const { error: reopenError } = await supabase
        .from("handshake_sessions")
        .update({ status: "active", closed_at: null })
        .eq("id", handshakeId)
        .eq("user_id", user.id);
      if (reopenError) {
        return NextResponse.json({ error: "Failed to reopen handshake" }, { status: 500 });
      }
    }
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("handshake_sessions")
      .insert({
        user_id: user.id,
        pane_a_session_id: sessionA,
        pane_b_session_id: sessionB,
        status: "active",
      })
      .select("id,created_at")
      .single();

    if (insertError) {
      return NextResponse.json({ error: "Failed to create handshake" }, { status: 500 });
    }

    handshakeId = String(inserted.id);
    createdAt =
      typeof inserted.created_at === "string" && inserted.created_at.trim()
        ? inserted.created_at
        : createdAt;
  }

  return NextResponse.json({
    handshakeId,
    createdAt,
    status: "active",
    paneA: {
      sessionId: sessionA,
      title: titleBySessionId.get(sessionA) || "Untitled",
    },
    paneB: {
      sessionId: sessionB,
      title: titleBySessionId.get(sessionB) || "Untitled",
    },
  });
}
