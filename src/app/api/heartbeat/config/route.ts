import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureHeartbeatSystemAgentId } from "@/lib/orchestrator/runtimeAgents";

function heartbeatChannelToDelivery(channel: string | null | undefined): { dashboard: boolean; whatsapp: boolean; telegram: boolean } {
  switch (channel) {
    case "telegram": return { dashboard: true, whatsapp: false, telegram: true };
    case "both":     return { dashboard: true, whatsapp: true, telegram: true };
    default:         return { dashboard: true, whatsapp: true, telegram: false };
  }
}

const HEARTBEAT_INTERVAL_MINUTES = 120;
const HEARTBEAT_SCHEDULE = { type: "interval_minutes", minutes: HEARTBEAT_INTERVAL_MINUTES } as const;
function isTwoHourHeartbeatSchedule(schedule: unknown): boolean {
  if (!schedule || typeof schedule !== "object") return false;
  const s = schedule as { type?: unknown; minutes?: unknown };
  if (s.type !== "interval_minutes") return false;
  return typeof s.minutes === "number" && s.minutes === HEARTBEAT_INTERVAL_MINUTES;
}

/**
 * GET /api/heartbeat/config
 *
 * Returns the current heartbeat configuration + last 30 days of runs.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find the heartbeat scheduled job (task->type = heartbeat_v1)
  const { data: jobs } = await supabase
    .from("scheduled_jobs")
    .select("id,agent_id,device_id,enabled,schedule,task,last_run_at,last_status,updated_at")
    .eq("user_id", user.id)
    .eq("kind", "orchestrator")
    .order("updated_at", { ascending: false })
    .limit(50);

  let heartbeatJob = (jobs || []).find((j) => {
    const t = j.task as Record<string, unknown> | null;
    return t && t.type === "heartbeat_v1";
  });

  // Migrate existing heartbeat jobs from hourly to every 2 hours.
  if (heartbeatJob && !isTwoHourHeartbeatSchedule((heartbeatJob as { schedule?: unknown }).schedule)) {
    const { data: migrated } = await supabase
      .from("scheduled_jobs")
      .update({
        schedule: HEARTBEAT_SCHEDULE,
        updated_at: new Date().toISOString(),
      })
      .eq("id", heartbeatJob.id)
      .select("id,agent_id,device_id,enabled,schedule,task,last_run_at,last_status,updated_at")
      .maybeSingle();
    if (migrated) heartbeatJob = migrated;
  }

  // Auto-create heartbeat job (enabled) if none exists yet.
  if (!heartbeatJob) {
    const { data: devices } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", user.id)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .limit(1);
    const deviceId = devices?.[0]?.id;
    if (deviceId) {
      const heartbeatAgentId = await ensureHeartbeatSystemAgentId(supabase, user.id);
      if (!heartbeatAgentId) {
        return NextResponse.json({ error: "Failed to initialize heartbeat agent" }, { status: 500 });
      }
      const { data: prefs } = await supabase
        .from("user_preferences")
        .select("heartbeat_channel")
        .eq("user_id", user.id)
        .maybeSingle();
      const task = {
        type: "heartbeat_v1",
        ui_hidden: true,
        orchestrator_agent_id: heartbeatAgentId,
        delivery: heartbeatChannelToDelivery((prefs as Record<string, unknown> | null)?.heartbeat_channel as string),
        options: { lookback_minutes: 120, max_emails: 10, max_events: 10, max_chars: 3000 },
      };
      const { data: newJob } = await supabase
        .from("scheduled_jobs")
        .insert({
          user_id: user.id,
          agent_id: heartbeatAgentId,
          device_id: deviceId,
          name: "Heartbeat",
          kind: "orchestrator",
          task,
          schedule: HEARTBEAT_SCHEDULE,
          enabled: true,
        })
        .select("id,agent_id,device_id,enabled,schedule,task,last_run_at,last_status,updated_at")
        .single();
      if (newJob) heartbeatJob = newJob;
    }
  }

  // Load recent runs (last 30 days) if job exists
  let runs: Array<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    created_at: string;
  }> = [];

  if (heartbeatJob) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const { data: runRows } = await supabase
      .from("scheduled_job_runs")
      .select("id,status,started_at,finished_at,duration_ms,created_at")
      .eq("job_id", heartbeatJob.id)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(200);
    runs = (runRows || []) as typeof runs;
  }

  // Check Gmail / Calendar connections
  const { data: connections } = await supabase
    .from("datagran_agent_configs")
    .select("provider, connection_id")
    .eq("user_id", user.id)
    .in("provider", ["gmail", "google_calendar"]);

  const hasGmail = (connections || []).some((c) => c.provider === "gmail" && c.connection_id);
  const hasCalendar = (connections || []).some((c) => c.provider === "google_calendar" && c.connection_id);
  const { data: upreadyLink } = await supabase
    .from("upready_account_links")
    .select("flow_user_id")
    .eq("flow_user_id", user.id)
    .maybeSingle();
  const hasUpreadyReadiness = !!upreadyLink;

  const heartbeatTaskOptions =
    heartbeatJob &&
    typeof (heartbeatJob.task as Record<string, unknown>)?.options === "object"
      ? ((heartbeatJob.task as Record<string, unknown>).options as Record<string, unknown>)
      : null;

  return NextResponse.json({
    enabled: heartbeatJob ? heartbeatJob.enabled === true : false,
    jobId: heartbeatJob?.id || null,
    deviceId: (heartbeatJob as { device_id?: unknown } | null)?.device_id || null,
    agentId: (heartbeatJob as { agent_id?: unknown } | null)?.agent_id || null,
    lastRunAt: heartbeatJob?.last_run_at || null,
    lastStatus: heartbeatJob?.last_status || null,
    model:
      typeof heartbeatTaskOptions?.model_name === "string" && heartbeatTaskOptions.model_name
        ? heartbeatTaskOptions.model_name
        : null,
    delivery: heartbeatJob
      ? (heartbeatJob.task as Record<string, unknown>)?.delivery || { dashboard: true, whatsapp: true }
      : { dashboard: true, whatsapp: true },
    runs,
    integrations: {
      gmail: hasGmail,
      google_calendar: hasCalendar,
      upready_readiness: hasUpreadyReadiness,
    },
  });
}

/**
 * POST /api/heartbeat/config
 *
 * Body:
 *  - enabled: boolean (true = create/enable, false = pause)
 *  - delivery?: { dashboard?: boolean, whatsapp?: boolean }
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    enabled?: boolean;
    delivery?: { dashboard?: boolean; whatsapp?: boolean; telegram?: boolean };
    deviceId?: string;
    /** Digest model override; null clears back to the default. */
    model?: string | null;
  } | null;

  // Model-only update: patch task.options.model_name on the existing heartbeat
  // job without touching enablement/schedule/device.
  if (body && typeof body.enabled !== "boolean" && "model" in body) {
    const model =
      typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    const { data: jobs } = await supabase
      .from("scheduled_jobs")
      .select("id,task")
      .eq("user_id", user.id)
      .eq("kind", "orchestrator")
      .order("updated_at", { ascending: false })
      .limit(50);
    const heartbeatJob = (jobs || []).find((j) => {
      const t = j.task as Record<string, unknown> | null;
      return t && t.type === "heartbeat_v1";
    });
    if (!heartbeatJob) {
      return NextResponse.json(
        { error: "No heartbeat job yet — enable the heartbeat first." },
        { status: 404 }
      );
    }
    const taskObj = { ...((heartbeatJob.task as Record<string, unknown>) || {}) };
    const options = {
      ...((taskObj.options as Record<string, unknown>) || {}),
    };
    if (model) options.model_name = model;
    else delete options.model_name;
    taskObj.options = options;
    const { error: updateErr } = await supabase
      .from("scheduled_jobs")
      .update({ task: taskObj, updated_at: new Date().toISOString() })
      .eq("id", heartbeatJob.id)
      .eq("user_id", user.id);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, jobId: heartbeatJob.id, model });
  }

  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "Missing enabled (boolean)" }, { status: 400 });
  }

  const requestedDeviceId =
    typeof body.deviceId === "string" && body.deviceId.trim()
      ? body.deviceId.trim()
      : null;
  let targetDeviceId: string | null = null;
  if (requestedDeviceId) {
    const { data: requestedDevice } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", requestedDeviceId)
      .limit(1)
      .maybeSingle();
    if (!requestedDevice?.id) {
      return NextResponse.json(
        { error: "Selected connector is not owned by this account." },
        { status: 400 },
      );
    }
    targetDeviceId = requestedDevice.id;
  } else {
    // Default target: latest active owned connector.
    const { data: devices } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", user.id)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .limit(1);
    targetDeviceId = devices?.[0]?.id || null;
  }
  if (!targetDeviceId) {
    return NextResponse.json(
      { error: "No Groovy Connector paired. Pair one first so the heartbeat can run." },
      { status: 400 },
    );
  }

  const heartbeatAgentId = await ensureHeartbeatSystemAgentId(supabase, user.id);
  if (!heartbeatAgentId) {
    return NextResponse.json(
      { error: "Failed to initialize heartbeat agent." },
      { status: 500 }
    );
  }

  // Find existing heartbeat job
  const { data: existingJobs } = await supabase
    .from("scheduled_jobs")
    .select("id,task,enabled,agent_id")
    .eq("user_id", user.id)
    .eq("kind", "orchestrator")
    .order("updated_at", { ascending: false })
    .limit(50);

  const existing = (existingJobs || []).find((j) => {
    const t = j.task as Record<string, unknown> | null;
    return t && t.type === "heartbeat_v1";
  });

  let delivery: { dashboard?: boolean; whatsapp?: boolean; telegram?: boolean };
  if (body.delivery) {
    delivery = body.delivery;
  } else {
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("heartbeat_channel")
      .eq("user_id", user.id)
      .maybeSingle();
    delivery = heartbeatChannelToDelivery((prefs as Record<string, unknown> | null)?.heartbeat_channel as string);
  }

  if (existing) {
    // Update existing job
    const taskObj = (existing.task as Record<string, unknown>) || {};
    const updatedTask = { ...taskObj, delivery, orchestrator_agent_id: heartbeatAgentId };
    const { data: updated, error: updateErr } = await supabase
      .from("scheduled_jobs")
      .update({
        enabled: body.enabled,
        agent_id: heartbeatAgentId,
        task: updatedTask,
        schedule: HEARTBEAT_SCHEDULE,
        device_id: targetDeviceId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select("id,agent_id,device_id,enabled")
      .maybeSingle();

    if (updateErr || !updated?.id) {
      return NextResponse.json(
        { error: updateErr?.message || "Failed to update heartbeat job" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      jobId: updated.id,
      enabled: updated.enabled === true,
      deviceId: updated.device_id || targetDeviceId,
      agentId: updated.agent_id || heartbeatAgentId,
    });
  }

  if (!body.enabled) {
    // Nothing to disable
    return NextResponse.json({ ok: true, jobId: null, enabled: false });
  }

  const task = {
    type: "heartbeat_v1",
    ui_hidden: true,
    orchestrator_agent_id: heartbeatAgentId,
    delivery,
    options: {
      lookback_minutes: 120,
      max_emails: 10,
      max_events: 10,
      max_chars: 3000,
    },
  };

  const { data: job, error: jobErr } = await supabase
    .from("scheduled_jobs")
    .insert({
      user_id: user.id,
      agent_id: heartbeatAgentId,
      device_id: targetDeviceId,
      name: "Heartbeat",
      kind: "orchestrator",
      task,
      schedule: HEARTBEAT_SCHEDULE,
      enabled: true,
    })
    .select("id")
    .single();

  if (jobErr) {
    return NextResponse.json({ error: jobErr.message || "Failed to create heartbeat job" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    jobId: job?.id || null,
    enabled: true,
    agentId: heartbeatAgentId,
    deviceId: targetDeviceId,
  });
}
