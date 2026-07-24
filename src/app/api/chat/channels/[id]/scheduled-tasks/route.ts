import { NextResponse } from "next/server";
import {
  canManageChannelSchedules,
  channelScheduleSummary,
  parseChannelScheduleAction,
  publicChannelSchedule,
  type ChannelScheduledTask,
} from "@/lib/chat/channelSchedules";
import { isSameOriginMutation } from "@/lib/notifications/push";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ChannelRow = {
  id: string;
  workspace_id: string;
  created_by: string;
  kind: string;
};

type JobRow = {
  id: string;
  name: string | null;
  kind: string | null;
  task: unknown;
  schedule: unknown;
  enabled: boolean;
  skip_next_run: boolean;
  last_run_at: string | null;
  last_status: string | null;
  updated_at: string | null;
  target_agent?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

function json(body: Record<string, unknown>, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function isMigrationPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    Boolean(error.message?.includes("channel_id"))
  );
}

async function visibleChannel(
  channelId: string,
): Promise<
  | {
      userId: string;
      channel: ChannelRow;
      workspaceRole: "admin" | "member" | "guest" | null;
    }
  | NextResponse
> {
  if (!UUID_PATTERN.test(channelId)) {
    return json({ error: "Channel not found" }, { status: 404 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  const { data: channel, error } = await supabase
    .from("chat_channels")
    .select("id,workspace_id,created_by,kind")
    .eq("id", channelId)
    .maybeSingle();
  if (error) return json({ error: error.message }, { status: 500 });
  if (!channel || channel.kind !== "channel") {
    return json({ error: "Channel not found" }, { status: 404 });
  }
  const { data: membership, error: membershipError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", channel.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) {
    return json({ error: membershipError.message }, { status: 500 });
  }
  return {
    userId: user.id,
    channel: channel as ChannelRow,
    workspaceRole:
      membership?.role === "admin" ||
      membership?.role === "member" ||
      membership?.role === "guest"
        ? membership.role
        : null,
  };
}

function targetAgentName(job: JobRow): string | null {
  const relation = Array.isArray(job.target_agent)
    ? job.target_agent[0]
    : job.target_agent;
  if (typeof relation?.name !== "string") return null;
  const name = relation.name.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return name.length > 80 ? `${name.slice(0, 79).trimEnd()}…` : name;
}

function publicJob(
  job: JobRow,
  canManageChannel: boolean,
): ChannelScheduledTask {
  const lastStatus =
    job.last_status === "success" ||
    job.last_status === "error" ||
    job.last_status === "skipped"
      ? job.last_status
      : null;
  const rawName = job.name?.replace(/\s+/g, " ").trim() || "Scheduled task";
  return {
    id: job.id,
    name:
      rawName.length > 120
        ? `${rawName.slice(0, 119).trimEnd()}…`
        : rawName,
    kind: job.kind === "shell" ? "shell" : "orchestrator",
    summary: channelScheduleSummary({ kind: job.kind, task: job.task }),
    schedule: publicChannelSchedule(job.schedule),
    enabled: job.enabled,
    skipNextRun: job.skip_next_run,
    lastRunAt: job.last_run_at,
    lastStatus,
    updatedAt: job.updated_at,
    targetAgentName: targetAgentName(job),
    canManage: canManageChannel,
  };
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const visible = await visibleChannel(id);
  if (visible instanceof NextResponse) return visible;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("scheduled_jobs")
    .select(
      "id,name,kind,task,schedule,enabled,skip_next_run,last_run_at,last_status,updated_at,target_agent:agents!scheduled_jobs_target_agent_id_fkey(name)",
    )
    .eq("channel_id", id)
    .order("enabled", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error && isMigrationPending(error)) {
    return json({ tasks: [], migrationPending: true });
  }
  if (error) return json({ error: error.message }, { status: 500 });
  const canManageChannel = canManageChannelSchedules({
    workspaceRole: visible.workspaceRole,
    channelCreatedBy: visible.channel.created_by,
    userId: visible.userId,
  });
  return json({
    tasks: ((data || []) as unknown as JobRow[]).map((job) =>
      publicJob(job, canManageChannel),
    ),
    migrationPending: false,
  });
}

export async function PATCH(req: Request, { params }: Params) {
  if (!isSameOriginMutation(req)) {
    return json({ error: "Cross-origin request denied" }, { status: 403 });
  }
  const { id } = await params;
  const visible = await visibleChannel(id);
  if (visible instanceof NextResponse) return visible;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
  const action = parseChannelScheduleAction(body?.action);
  if (!UUID_PATTERN.test(jobId) || !action) {
    return json(
      { error: "A scheduled task and valid action are required" },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: job, error: jobError } = await admin
    .from("scheduled_jobs")
    .select("id,enabled")
    .eq("id", jobId)
    .eq("channel_id", id)
    .maybeSingle();
  if (jobError && isMigrationPending(jobError)) {
    return json(
      { error: "Channel schedules are still being activated" },
      { status: 503 },
    );
  }
  if (jobError) return json({ error: jobError.message }, { status: 500 });
  if (!job) {
    return json({ error: "Scheduled task not found" }, { status: 404 });
  }
  const canManage = canManageChannelSchedules({
    workspaceRole: visible.workspaceRole,
    channelCreatedBy: visible.channel.created_by,
    userId: visible.userId,
  });
  if (!canManage) {
    return json(
      {
        error:
          "Guests can view channel schedules, but only workspace members can change them",
      },
      { status: 403 },
    );
  }
  if (action === "skip" && job.enabled === false) {
    return json(
      { error: "Resume this task before skipping its next run" },
      { status: 409 },
    );
  }
  const patch =
    action === "pause"
      ? { enabled: false }
      : action === "resume"
        ? { enabled: true, skip_next_run: false }
        : { skip_next_run: true };
  const { data: updated, error } = await admin
    .from("scheduled_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("channel_id", id)
    .select("id")
    .maybeSingle();
  if (error) return json({ error: error.message }, { status: 500 });
  if (!updated) {
    return json(
      { error: "The scheduled task changed before this action completed" },
      { status: 409 },
    );
  }
  return json({ ok: true });
}
