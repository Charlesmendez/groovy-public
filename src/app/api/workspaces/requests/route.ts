import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";

type PostBody = {
  sessionId?: unknown;
  agentId?: unknown;
  requestedUserIds?: unknown;
  message?: unknown;
  dedupeKey?: unknown;
  expiresInSeconds?: unknown;
  requiresConnector?: unknown;
  provider?: unknown;
  metadata?: unknown;
};

type PatchBody = {
  id?: unknown;
  action?: unknown;
  clientId?: unknown;
  result?: unknown;
  error?: unknown;
};

function toStringOrEmpty(v: unknown) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function toBool(v: unknown) {
  if (typeof v === "boolean") return v;
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_FANOUT = 10;
const DEFAULT_EXPIRES_SECONDS = 60 * 60; // 1h

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sessionId = toStringOrEmpty(searchParams.get("sessionId"));
  const agentId = toStringOrEmpty(searchParams.get("agentId"));
  const status = toStringOrEmpty(searchParams.get("status")) || "pending";

  const { data: rows, error } = await supabase
    .from("workspace_orchestrator_requests")
    .select(
      "id, workspace_id, session_id, agent_id, requested_by_user_id, requested_user_id, status, request, result, dedupe_key, expires_at, claimed_at, claimed_by_client_id, attempt_count, last_error, created_at, updated_at"
    )
    .eq("requested_user_id", user.id)
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const filtered = (rows || []).filter((r) => {
    if (sessionId && String((r as { session_id?: unknown }).session_id || "") !== sessionId) return false;
    if (agentId && String((r as { agent_id?: unknown }).agent_id || "") !== agentId) return false;
    const exp = (r as { expires_at?: unknown }).expires_at;
    if (!exp) return true;
    const t = new Date(String(exp)).getTime();
    return Number.isFinite(t) ? t > now : true;
  });

  return NextResponse.json({ ok: true, requests: filtered });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const sessionId = toStringOrEmpty(body.sessionId);
  let agentId = toStringOrEmpty(body.agentId);
  const message = toStringOrEmpty(body.message).trim();
  const dedupeKey = toStringOrEmpty(body.dedupeKey).trim() || null;
  const requiresConnector = toBool(body.requiresConnector);
  const provider = toStringOrEmpty(body.provider).trim() || null;
  const expiresInSecondsRaw =
    typeof body.expiresInSeconds === "number" ? body.expiresInSeconds : Number(body.expiresInSeconds);
  const expiresInSeconds =
    Number.isFinite(expiresInSecondsRaw) && expiresInSecondsRaw > 0
      ? Math.min(expiresInSecondsRaw, 60 * 60 * 24)
      : DEFAULT_EXPIRES_SECONDS;

  const requestedUserIdsRaw = body.requestedUserIds;
  const requestedUserIds = Array.isArray(requestedUserIdsRaw)
    ? requestedUserIdsRaw.map((x) => toStringOrEmpty(x)).filter(Boolean)
    : [];

  if ((!sessionId && !agentId) || !message || requestedUserIds.length === 0) {
    return NextResponse.json(
      { error: "Missing agentId/sessionId, message, or requestedUserIds" },
      { status: 400 }
    );
  }

  const uniqueTargets = Array.from(new Set(requestedUserIds)).filter((id) => id !== user.id);
  if (uniqueTargets.length === 0) {
    return NextResponse.json({ ok: true, created: 0, skipped: requestedUserIds.length });
  }

  if (uniqueTargets.length > MAX_FANOUT) {
    return NextResponse.json(
      { error: `Too many recipients (max ${MAX_FANOUT})` },
      { status: 400 }
    );
  }

  // Infer workspace_id (single-workspace model)
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin: createSupabaseAdminClient(),
  });
  if (!membership?.workspace_id) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const workspaceId = String(membership.workspace_id);

  if (sessionId && !agentId) {
    const { data: runtime } = await supabase
      .from("orchestrator_session_runtime")
      .select("agent_id")
      .eq("session_id", sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (runtime?.agent_id) {
      agentId = String(runtime.agent_id);
    }
  }

  if (agentId) {
    const { data: sharedAgentRow } = await supabase
      .from("workspace_orchestrator_agents")
      .select("agent_id")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .maybeSingle();
    if (!sharedAgentRow) {
      return NextResponse.json(
        { error: "Agent is not shared to workspace" },
        { status: 400 }
      );
    }
  } else if (sessionId) {
    const { data: sharedSessionRow } = await supabase
      .from("workspace_orchestrator_sessions")
      .select("session_id")
      .eq("workspace_id", workspaceId)
      .eq("session_id", sessionId)
      .maybeSingle();
    if (!sharedSessionRow) {
      return NextResponse.json(
        { error: "Session is not shared to workspace" },
        { status: 400 }
      );
    }
  }

  // Validate recipients are members
  const { data: memberRows, error: membersErr } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .in("user_id", uniqueTargets);
  if (membersErr) {
    return NextResponse.json({ error: membersErr.message }, { status: 500 });
  }

  const memberSet = new Set((memberRows || []).map((m) => String(m.user_id)));
  const notMembers = uniqueTargets.filter((id) => !memberSet.has(id));
  if (notMembers.length > 0) {
    return NextResponse.json(
      { error: "Some recipients are not workspace members", notMembers },
      { status: 400 }
    );
  }

  const expIso = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const requestPayload = {
    message,
    requiresConnector,
    provider: provider || undefined,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
  };

  let created = 0;
  let skipped = 0;

  for (const requestedUserId of uniqueTargets) {
    const { error: insErr } = await supabase
      .from("workspace_orchestrator_requests")
      .insert({
        workspace_id: workspaceId,
        session_id: sessionId || null,
        agent_id: agentId || null,
        requested_by_user_id: user.id,
        requested_user_id: requestedUserId,
        status: "pending",
        request: requestPayload,
        dedupe_key: dedupeKey,
        expires_at: expIso,
        updated_at: nowIso(),
      });

    if (insErr) {
      // Unique violation (dedupe) → skip
      if (insErr.code === "23505") {
        skipped++;
        continue;
      }
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
    created++;
  }

  return NextResponse.json({ ok: true, created, skipped });
}

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const id = toStringOrEmpty(body.id);
  const action = toStringOrEmpty(body.action);
  const clientId = toStringOrEmpty(body.clientId).trim() || null;

  if (!id || !action) {
    return NextResponse.json({ error: "Missing id or action" }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from("workspace_orchestrator_requests")
    .select(
      "id, requested_by_user_id, requested_user_id, status, expires_at, attempt_count"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const requestedBy = String((row as { requested_by_user_id?: unknown }).requested_by_user_id || "");
  const requestedUser = String((row as { requested_user_id?: unknown }).requested_user_id || "");
  const status = String((row as { status?: unknown }).status || "");
  const expiresAtRaw = (row as { expires_at?: unknown }).expires_at;
  const expired =
    expiresAtRaw && new Date(String(expiresAtRaw)).getTime() <= Date.now();

  const isRequester = user.id === requestedBy;
  const isRequested = user.id === requestedUser;

  if (!isRequester && !isRequested) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (action === "claim") {
    if (!isRequested) {
      return NextResponse.json({ error: "Only requested user can claim" }, { status: 403 });
    }
    if (expired) {
      return NextResponse.json({ ok: false, claimed: false, reason: "expired" }, { status: 410 });
    }
    if (status !== "pending") {
      return NextResponse.json({ ok: true, claimed: false, reason: "not_pending" });
    }

    const nextAttempt = Number((row as { attempt_count?: unknown }).attempt_count || 0) + 1;
    const ts = nowIso();
    const { data: updated, error: updErr } = await supabase
      .from("workspace_orchestrator_requests")
      .update({
        status: "running",
        claimed_at: ts,
        claimed_by_client_id: clientId,
        attempt_count: nextAttempt,
        updated_at: ts,
      })
      .eq("id", id)
      .eq("requested_user_id", user.id)
      .eq("status", "pending")
      .select("id, status, claimed_at, claimed_by_client_id, attempt_count")
      .maybeSingle();

    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    if (!updated) {
      // Someone else claimed it
      return NextResponse.json({ ok: true, claimed: false, reason: "race" });
    }
    return NextResponse.json({ ok: true, claimed: true, request: updated });
  }

  if (action === "complete" || action === "error") {
    if (!isRequested) {
      return NextResponse.json({ error: "Only requested user can complete/error" }, { status: 403 });
    }
    if (status !== "running") {
      return NextResponse.json({ ok: false, updated: false, reason: "not_running" }, { status: 409 });
    }

    const ts = nowIso();
    const result = body.result && typeof body.result === "object" ? body.result : undefined;
    const errText = toStringOrEmpty(body.error).trim() || null;

    const { error: updErr } = await supabase
      .from("workspace_orchestrator_requests")
      .update({
        status: action === "complete" ? "complete" : "error",
        result: result || null,
        last_error: action === "error" ? (errText || "Unknown error") : null,
        completed_at: ts,
        updated_at: ts,
      })
      .eq("id", id)
      .eq("requested_user_id", user.id)
      .eq("status", "running");

    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, updated: true });
  }

  if (action === "cancel") {
    // Either requester or requested user can cancel/dismiss
    if (!(isRequester || isRequested)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (status === "complete" || status === "error" || status === "cancelled") {
      return NextResponse.json({ ok: true, updated: false, reason: "already_finished" });
    }
    const ts = nowIso();
    let q = supabase
      .from("workspace_orchestrator_requests")
      .update({
        status: "cancelled",
        cancelled_at: ts,
        updated_at: ts,
      })
      .eq("id", id);

    // Must chain properly - Supabase returns new object on each call
    if (isRequester) {
      q = q.eq("requested_by_user_id", user.id);
    } else if (isRequested) {
      q = q.eq("requested_user_id", user.id);
    }

    const { error: updErr } = await q;
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, updated: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
