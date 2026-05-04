import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getEnterpriseDemoConfig } from "@/lib/enterpriseDemo";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_SESSION_TITLE = "Enterprise review";
const DEMO_FILES_AGENT_NAME = "Enterprise Review Files";
const UPLOAD_BUCKET = "chat_uploads";
const STORAGE_BATCH_SIZE = 100;

type IdRow = {
  id?: unknown;
};

type ChatSessionRow = {
  id?: unknown;
};

type AttachmentRow = {
  storage_path?: unknown;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: Iterable<string>) {
  return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean)));
}

function getBearerToken(req: Request) {
  const header = req.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function tokensMatch(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function POST(req: Request) {
  const config = getEnterpriseDemoConfig();
  const cleanupToken = asString(process.env.ENTERPRISE_DEMO_CLEANUP_TOKEN);

  if (!config.enabled || !config.userId) {
    return NextResponse.json({ ok: false, error: "enterprise demo is disabled" }, { status: 404 });
  }
  if (!cleanupToken) {
    return NextResponse.json(
      { ok: false, error: "ENTERPRISE_DEMO_CLEANUP_TOKEN is not configured" },
      { status: 500 }
    );
  }
  if (!tokensMatch(getBearerToken(req), cleanupToken)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseAdminClient();
  const demoUserId = config.userId;

  const { data: reviewSessions, error: reviewSessionsError } = await supabase
    .from("orchestrator_sessions")
    .select("id")
    .eq("user_id", demoUserId)
    .eq("title", DEMO_SESSION_TITLE);
  if (reviewSessionsError) {
    console.error("[enterprise-review-cleanup] failed to load review sessions:", reviewSessionsError);
    return NextResponse.json({ ok: false, error: "Failed to load demo review sessions" }, { status: 500 });
  }

  const reviewSessionIds = uniqueStrings((reviewSessions || []).map((row) => asString((row as IdRow).id)));

  const { data: filesAgents, error: filesAgentsError } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", demoUserId)
    .eq("type", "files-agent")
    .eq("name", DEMO_FILES_AGENT_NAME);
  if (filesAgentsError) {
    console.error("[enterprise-review-cleanup] failed to load files agents:", filesAgentsError);
    return NextResponse.json({ ok: false, error: "Failed to load demo files agents" }, { status: 500 });
  }

  const filesAgentIds = uniqueStrings((filesAgents || []).map((row) => asString((row as IdRow).id)));

  let filesSessionIds: string[] = [];
  if (filesAgentIds.length > 0) {
    const { data: filesSessions, error: filesSessionsError } = await supabase
      .from("chat_sessions")
      .select("id")
      .eq("user_id", demoUserId)
      .in("agent_id", filesAgentIds);
    if (filesSessionsError) {
      console.error("[enterprise-review-cleanup] failed to load file sessions:", filesSessionsError);
      return NextResponse.json({ ok: false, error: "Failed to load demo file sessions" }, { status: 500 });
    }
    filesSessionIds = uniqueStrings(
      (filesSessions || []).map((row) => asString((row as ChatSessionRow).id))
    );
  }

  let storagePaths: string[] = [];
  if (filesSessionIds.length > 0) {
    const { data: attachments, error: attachmentsError } = await supabase
      .from("chat_attachments")
      .select("storage_path")
      .eq("user_id", demoUserId)
      .in("session_id", filesSessionIds);
    if (attachmentsError) {
      console.error("[enterprise-review-cleanup] failed to load attachment paths:", attachmentsError);
      return NextResponse.json({ ok: false, error: "Failed to load demo attachment paths" }, { status: 500 });
    }
    storagePaths = uniqueStrings(
      (attachments || []).map((row) => asString((row as AttachmentRow).storage_path))
    );
  }

  for (let i = 0; i < storagePaths.length; i += STORAGE_BATCH_SIZE) {
    const batch = storagePaths.slice(i, i + STORAGE_BATCH_SIZE);
    const { error: storageError } = await supabase.storage.from(UPLOAD_BUCKET).remove(batch);
    if (storageError) {
      console.error("[enterprise-review-cleanup] failed to remove storage objects:", storageError);
      return NextResponse.json({ ok: false, error: "Failed to delete uploaded demo files" }, { status: 500 });
    }
  }

  if (filesAgentIds.length > 0) {
    const { error: deleteFilesAgentsError } = await supabase
      .from("agents")
      .delete()
      .eq("user_id", demoUserId)
      .in("id", filesAgentIds);
    if (deleteFilesAgentsError) {
      console.error("[enterprise-review-cleanup] failed to delete files agents:", deleteFilesAgentsError);
      return NextResponse.json({ ok: false, error: "Failed to delete demo files agents" }, { status: 500 });
    }
  }

  if (reviewSessionIds.length > 0) {
    const { error: deleteReviewSessionsError } = await supabase
      .from("orchestrator_sessions")
      .delete()
      .eq("user_id", demoUserId)
      .in("id", reviewSessionIds);
    if (deleteReviewSessionsError) {
      console.error(
        "[enterprise-review-cleanup] failed to delete review sessions:",
        deleteReviewSessionsError
      );
      return NextResponse.json({ ok: false, error: "Failed to delete demo review sessions" }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      reviewSessions: reviewSessionIds.length,
      runtimeAgents: 0,
      filesAgents: filesAgentIds.length,
      filesSessions: filesSessionIds.length,
      storageObjects: storagePaths.length,
    },
  });
}
