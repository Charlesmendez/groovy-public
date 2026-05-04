import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  storagePath?: unknown;
  fileId?: unknown;
  sessionId?: unknown;
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function filenameFromPath(storagePath: string): string | undefined {
  const name = storagePath.split("/").pop() || "";
  const trimmed = name.trim();
  return trimmed || undefined;
}

type SessionGeneratedMediaRefs = {
  storagePaths: Set<string>;
  fileIds: Set<string>;
};

function extractSessionIdFromStoragePath(
  storagePath: string,
  userId: string
): string | null {
  if (!storagePath.startsWith(`${userId}/`)) return null;
  const remainder = storagePath.slice(userId.length + 1);
  const sessionId = remainder.split("/")[0] || "";
  return sessionId.trim() ? sessionId.trim() : null;
}

async function loadLinkedFilesSessionIds(opts: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  sessionId: string;
}): Promise<Set<string>> {
  const { supabase, userId, sessionId } = opts;
  const allowed = new Set<string>();
  const { data: rows } = await supabase
    .from("orchestrator_agent_sessions")
    .select("agent_session_id")
    .eq("user_id", userId)
    .eq("orchestrator_session_id", sessionId)
    .eq("agent_type", "files")
    .limit(20);
  for (const row of rows || []) {
    const id =
      row && typeof row === "object"
        ? toNonEmptyString((row as { agent_session_id?: unknown }).agent_session_id)
        : null;
    if (id) allowed.add(id);
  }
  return allowed;
}

async function loadSessionGeneratedMediaRefs(opts: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  sessionId: string;
}): Promise<SessionGeneratedMediaRefs> {
  const { supabase, userId, sessionId } = opts;
  const refs: SessionGeneratedMediaRefs = {
    storagePaths: new Set<string>(),
    fileIds: new Set<string>(),
  };
  const { data: rows } = await supabase
    .from("orchestrator_messages")
    .select("metadata, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);

  for (const row of rows || []) {
    const metadata =
      row && typeof row === "object" ? (row as { metadata?: unknown }).metadata : null;
    const rec =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : null;
    const generatedRaw = rec?.generated_files;
    if (!Array.isArray(generatedRaw)) continue;
    for (const rawFile of generatedRaw) {
      if (!rawFile || typeof rawFile !== "object") continue;
      const f = rawFile as Record<string, unknown>;
      const storagePath =
        toNonEmptyString(f.storage_path) || toNonEmptyString(f.storagePath);
      const fileId = toNonEmptyString(f.file_id) || toNonEmptyString(f.fileId);
      if (storagePath) refs.storagePaths.add(storagePath);
      if (fileId) refs.fileIds.add(fileId);
    }
  }
  return refs;
}

function validateSessionRef(args: {
  refs: SessionGeneratedMediaRefs;
  userId: string;
  allowedFilesSessionIds: Set<string>;
  storagePath?: string | null;
  fileId?: string | null;
}): { ok: true } | { ok: false; error: string } {
  const storagePath = toNonEmptyString(args.storagePath);
  const fileId = toNonEmptyString(args.fileId);
  const pathSessionId =
    storagePath && args.userId
      ? extractSessionIdFromStoragePath(storagePath, args.userId)
      : null;
  if (pathSessionId && args.allowedFilesSessionIds.has(pathSessionId)) {
    return { ok: true };
  }
  const hasKnownRefs =
    args.refs.storagePaths.size > 0 || args.refs.fileIds.size > 0;
  if (!hasKnownRefs) {
    return {
      ok: false,
      error:
        "No generated files found in this session. Regenerate the file in this conversation and try again.",
    };
  }
  if (fileId && args.refs.fileIds.has(fileId)) return { ok: true };
  if (storagePath && args.refs.storagePaths.has(storagePath)) return { ok: true };
  return {
    ok: false,
    error:
      "Media reference does not belong to the current session.",
  };
}

async function resolveStoragePathFromFileId(opts: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  fileId: string;
}): Promise<{ storagePath: string; filename?: string } | null> {
  const { supabase, userId, fileId } = opts;

  // First, try direct attachment binding (works for uploads that persisted anthropic_file_id).
  const { data: attachment, error: attachmentErr } = await supabase
    .from("chat_attachments")
    .select("storage_path, file_name, created_at")
    .eq("user_id", userId)
    .eq("anthropic_file_id", fileId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!attachmentErr && attachment) {
    const row = attachment as { storage_path?: unknown; file_name?: unknown };
    const storagePath = toNonEmptyString(row.storage_path);
    if (storagePath) {
      return {
        storagePath,
        filename: toNonEmptyString(row.file_name) || filenameFromPath(storagePath),
      };
    }
  }

  // Fallback: scan recent orchestrator message metadata for generated_files entries.
  const { data: recentOrch } = await supabase
    .from("orchestrator_messages")
    .select("metadata, created_at")
    .eq("user_id", userId)
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(120);

  for (const row of recentOrch || []) {
    const meta =
      row && typeof row === "object" ? (row as { metadata?: unknown }).metadata : null;
    const rec = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
    const filesRaw = rec?.generated_files;
    if (!Array.isArray(filesRaw)) continue;
    for (const rawFile of filesRaw) {
      if (!rawFile || typeof rawFile !== "object") continue;
      const f = rawFile as Record<string, unknown>;
      const id =
        toNonEmptyString(f.file_id) || toNonEmptyString(f.fileId) || null;
      if (id !== fileId) continue;
      const storagePath =
        toNonEmptyString(f.storage_path) || toNonEmptyString(f.storagePath);
      if (!storagePath) continue;
      const filename =
        toNonEmptyString(f.filename) ||
        toNonEmptyString(f.name) ||
        filenameFromPath(storagePath);
      return { storagePath, filename: filename || undefined };
    }
  }

  return null;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let storagePath = toNonEmptyString(body.storagePath);
  const fileId = toNonEmptyString(body.fileId);
  const sessionId = toNonEmptyString(body.sessionId);
  let filename: string | undefined;

  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId is required for media URL resolution." },
      { status: 400 }
    );
  }
  const refs = await loadSessionGeneratedMediaRefs({
    supabase,
    userId: user.id,
    sessionId,
  });
  const allowedFilesSessionIds = await loadLinkedFilesSessionIds({
    supabase,
    userId: user.id,
    sessionId,
  });

  if (storagePath) {
    const preCheck = validateSessionRef({
      refs,
      userId: user.id,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!preCheck.ok) {
      return NextResponse.json({ error: preCheck.error }, { status: 403 });
    }
  }

  if (!storagePath && fileId) {
    const resolved = await resolveStoragePathFromFileId({
      supabase,
      userId: user.id,
      fileId,
    });
    if (resolved) {
      storagePath = resolved.storagePath;
      filename = resolved.filename;
    }
    const postCheck = validateSessionRef({
      refs,
      userId: user.id,
      allowedFilesSessionIds,
      storagePath,
      fileId,
    });
    if (!postCheck.ok) {
      return NextResponse.json({ error: postCheck.error }, { status: 403 });
    }
  }

  if (!storagePath) {
    return NextResponse.json(
      { error: "Missing resolvable media reference (storagePath/fileId)." },
      { status: 400 }
    );
  }

  if (!storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: signedData, error: signErr } = await supabase.storage
    .from("chat_uploads")
    .createSignedUrl(storagePath, 3600);

  if (signErr || !signedData?.signedUrl) {
    return NextResponse.json(
      { error: signErr?.message || "Failed to sign media URL." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    url: signedData.signedUrl,
    storagePath,
    filename: filename || filenameFromPath(storagePath) || null,
  });
}

