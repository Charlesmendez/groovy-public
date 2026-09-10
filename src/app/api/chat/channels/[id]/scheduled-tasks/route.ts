import { NextResponse } from "next/server";
import {
  canManageChannelSchedules,
  channelScheduleManualRunDeviceCandidates,
  channelScheduleSummary,
  parseChannelScheduleAction,
  publicChannelSchedule,
  type ChannelScheduledTask,
} from "@/lib/chat/channelSchedules";
import { isSameOriginMutation } from "@/lib/notifications/push";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
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
  user_id: string;
  device_id: string | null;
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
  userId: string,
): ChannelScheduledTask {
  const lastStatus =
    job.last_status === "success" ||
    job.last_status === "error" ||
    job.last_status === "skipped"
      ? job.last_status
      : null;
  const rawName = job.name?.replace(/\s+/g, " ").trim() || "Scheduled task";
  const deviceId =
    canManageChannel &&
    job.user_id === userId &&
    typeof job.device_id === "string" &&
    UUID_PATTERN.test(job.device_id)
      ? job.device_id
      : null;
  return {
    id: job.id,
    deviceId,
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
    canRun: Boolean(deviceId),
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
      "id,user_id,device_id,name,kind,task,schedule,enabled,skip_next_run,last_run_at,last_status,updated_at,target_agent:agents!scheduled_jobs_target_agent_id_fkey(name)",
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
      publicJob(job, canManageChannel, visible.userId),
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

export async function POST(req: Request, { params }: Params) {
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
  if (!UUID_PATTERN.test(jobId)) {
    return json(
      { error: "A scheduled task is required" },
      { status: 400 },
    );
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
          "Guests can view channel schedules, but only workspace members can run them",
      },
      { status: 403 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: job, error: jobError } = await admin
    .from("scheduled_jobs")
    .select("id,user_id,device_id,kind,target_agent_id")
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
  if (job.user_id !== visible.userId) {
    return json(
      { error: "Only the task owner can run it manually" },
      { status: 403 },
    );
  }

  const assignedDeviceId =
    typeof job.device_id === "string" ? job.device_id.trim() : "";
  const canMoveToAnotherDevice =
    job.kind === "orchestrator" && !job.target_agent_id;
  let ownedDeviceIds: string[] = [];
  if (canMoveToAnotherDevice) {
    const { data: devices, error: devicesError } = await admin
      .from("devices")
      .select("id")
      .eq("user_id", visible.userId)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(20);
    if (devicesError) {
      return json({ error: devicesError.message }, { status: 500 });
    }
    ownedDeviceIds = (devices || []).flatMap((device) =>
      typeof device.id === "string" && device.id.trim()
        ? [device.id.trim()]
        : [],
    );
  }
  const candidateDeviceIds = channelScheduleManualRunDeviceCandidates({
    assignedDeviceId,
    ownedDeviceIds,
    canMoveToAnotherDevice,
  });
  if (candidateDeviceIds.length === 0) {
    return json({ error: "no_connector_devices" }, { status: 409 });
  }

  let lastError = "device_not_online";
  for (const deviceId of candidateDeviceIds) {
    try {
      const result = await callConnectorRpcViaRelay({
        userId: visible.userId,
        deviceId,
        rpcType: "schedule_trigger",
        payload: { job_id: jobId },
        timeoutMs: 30_000,
      });
      if (result.ok !== true) {
        lastError =
          typeof result.error === "string"
            ? result.error
            : "scheduled_task_start_failed";
        if (lastError === "device_not_online" && canMoveToAnotherDevice) {
          continue;
        }
        break;
      }
      return json({ ok: true, accepted: true, jobId, deviceId });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError === "device_not_online" && canMoveToAnotherDevice) {
        continue;
      }
      break;
    }
  }

  return json({ error: lastError }, { status: 409 });
}
