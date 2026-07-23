import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  cloudScheduledJobEligibility,
  isCloudScheduleDue,
  type CloudScheduledJob,
} from "@/lib/scheduler/cloud";
import { schedulerCronSecret } from "@/lib/scheduler/cronAuth";

type TickResult = {
  jobId: string;
  status: "success" | "error" | "skipped" | "ignored" | "locked";
  reason?: string;
};

function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw.trim());
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function maxCloudJobsPerTick(): number {
  const configured = Number(process.env.SCHEDULER_CLOUD_MAX_JOBS_PER_TICK);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(10, Math.trunc(configured)))
    : 4;
}

export async function runCloudSchedulerTick(req: Request): Promise<{
  ok: boolean;
  checked: number;
  due: number;
  results: TickResult[];
}> {
  const secret = schedulerCronSecret();
  if (!secret) {
    throw new Error("SCHEDULER_CRON_SECRET is not configured");
  }
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("scheduled_jobs")
    .select(
      "id,user_id,device_id,kind,enabled,schedule,task,target_agent_id,last_run_at,skip_next_run"
    )
    .eq("enabled", true)
    .eq("kind", "orchestrator")
    .order("updated_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);

  const jobs = (data || []) as unknown as CloudScheduledJob[];
  const deviceIds = [...new Set(jobs.map((job) => job.device_id).filter(Boolean))];
  const onlineCutoff = new Date(
    Date.now() -
      Math.max(
        60_000,
        Number(process.env.SCHEDULER_CONNECTOR_ONLINE_WINDOW_MS) || 120_000
      )
  ).toISOString();
  const onlineDevices = new Set<string>();
  if (deviceIds.length > 0) {
    const { data: devices } = await admin
      .from("devices")
      .select("id,last_seen")
      .in("id", deviceIds)
      .gte("last_seen", onlineCutoff);
    for (const device of devices || []) {
      if (typeof device.id === "string") onlineDevices.add(device.id);
    }
  }

  const now = new Date();
  const due = jobs
    .map((job) => ({
      job,
      schedule: isCloudScheduleDue(job, now),
      eligibility: cloudScheduledJobEligibility(job),
    }))
    .filter(
      (candidate) =>
        candidate.schedule.due &&
        candidate.eligibility.eligible &&
        !onlineDevices.has(candidate.job.device_id)
    )
    .slice(0, maxCloudJobsPerTick());

  const dispatchUrl = new URL("/api/scheduler/run", req.url).toString();
  const results = await Promise.all(
    due.map(async ({ job }): Promise<TickResult> => {
      const lockToken = randomUUID();
      const { data: claimed, error: claimError } = await admin.rpc(
        "acquire_scheduled_job_cloud_lock",
        {
          p_job_id: job.id,
          p_lock_token: lockToken,
          p_ttl_seconds: 800,
        }
      );
      if (claimError) {
        return { jobId: job.id, status: "error", reason: claimError.message };
      }
      if (claimed !== true) return { jobId: job.id, status: "locked" };

      const started = new Date();
      try {
        // The due/device snapshot above is intentionally broad. Re-check after
        // claiming the job so a connector run or reconnect that happened
        // during the scan does not race this cloud occurrence.
        const { data: latestRow, error: latestError } = await admin
          .from("scheduled_jobs")
          .select(
            "id,user_id,device_id,kind,enabled,schedule,task,target_agent_id,last_run_at,skip_next_run",
          )
          .eq("id", job.id)
          .maybeSingle();
        if (latestError || !latestRow) {
          return {
            jobId: job.id,
            status: "error",
            reason: latestError?.message || "job_disappeared_before_dispatch",
          };
        }
        const latestJob = latestRow as unknown as CloudScheduledJob;
        const latestDue = isCloudScheduleDue(latestJob, started);
        const latestEligibility = cloudScheduledJobEligibility(latestJob);
        if (!latestDue.due || !latestEligibility.eligible) {
          return {
            jobId: job.id,
            status: "ignored",
            reason: latestDue.reason || latestEligibility.reason || "no_longer_eligible",
          };
        }
        const { data: reconnectedDevice, error: deviceCheckError } = await admin
          .from("devices")
          .select("id")
          .eq("id", latestJob.device_id)
          .gte("last_seen", onlineCutoff)
          .maybeSingle();
        if (deviceCheckError) {
          return {
            jobId: job.id,
            status: "error",
            reason: deviceCheckError.message,
          };
        }
        if (reconnectedDevice) {
          return {
            jobId: job.id,
            status: "ignored",
            reason: "connector_reconnected",
          };
        }

        if (latestJob.skip_next_run === true) {
          await Promise.all([
            admin
              .from("scheduled_jobs")
              .update({
                skip_next_run: false,
                last_run_at: started.toISOString(),
                last_status: "skipped",
                last_exit_code: 0,
                updated_at: started.toISOString(),
              })
              .eq("id", job.id),
            admin.from("scheduled_job_runs").insert({
              user_id: job.user_id,
              device_id: job.device_id,
              job_id: job.id,
              status: "skipped",
              exit_code: 0,
              started_at: started.toISOString(),
              finished_at: started.toISOString(),
              duration_ms: 0,
              stdout: "Skipped by user request.",
            }),
          ]);
          return { jobId: job.id, status: "skipped" };
        }

        // Reserve this occurrence before dispatch so an online connector that
        // reconnects mid-tick does not also consider it due.
        const { data: reserved, error: reservationError } = await admin
          .from("scheduled_jobs")
          .update({
            last_run_at: started.toISOString(),
            last_status: "running",
            last_exit_code: null,
            updated_at: started.toISOString(),
          })
          .eq("id", job.id)
          .eq("enabled", true)
          .select("id")
          .maybeSingle();
        if (reservationError || !reserved) {
          return {
            jobId: job.id,
            status: "error",
            reason: reservationError?.message || "job_reservation_failed",
          };
        }

        const response = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            "X-Groovy-Scheduler-Dispatch": "cloud",
          },
          body: JSON.stringify({
            jobId: job.id,
            runId: randomUUID(),
            timezone: latestDue.timezone,
          }),
          cache: "no-store",
        });
        const raw = await response.text();
        const payload = parseJsonBody(raw);
        const success =
          response.ok && payload?.ok === true && payload.kind === "final";
        const errorMessage = success
          ? null
          : typeof payload?.error === "string"
            ? payload.error
            : payload?.kind === "needs_connector"
              ? "cloud_scheduler_connector_tool_blocked"
              : `scheduler_dispatch_http_${response.status}`;
        const text =
          typeof payload?.text === "string"
            ? payload.text
            : typeof payload?.partialText === "string"
              ? payload.partialText
              : "";
        const finished = new Date();
        const durationMs = finished.getTime() - started.getTime();

        await Promise.all([
          admin
            .from("scheduled_jobs")
            .update({
              last_status: success ? "success" : "error",
              last_exit_code: success ? 0 : 1,
              updated_at: finished.toISOString(),
            })
            .eq("id", job.id),
          admin.from("scheduled_job_runs").insert({
            user_id: job.user_id,
            device_id: job.device_id,
            job_id: job.id,
            status: success ? "success" : "error",
            exit_code: success ? 0 : 1,
            started_at: started.toISOString(),
            finished_at: finished.toISOString(),
            duration_ms: durationMs,
            stdout: text.slice(0, 100_000) || null,
            stderr: errorMessage,
            error: errorMessage,
          }),
        ]);
        return success
          ? { jobId: job.id, status: "success" }
          : { jobId: job.id, status: "error", reason: errorMessage || "failed" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const finished = new Date();
        await Promise.all([
          admin
            .from("scheduled_jobs")
            .update({
              last_status: "error",
              last_exit_code: 1,
              updated_at: finished.toISOString(),
            })
            .eq("id", job.id),
          admin.from("scheduled_job_runs").insert({
            user_id: job.user_id,
            device_id: job.device_id,
            job_id: job.id,
            status: "error",
            exit_code: 1,
            started_at: started.toISOString(),
            finished_at: finished.toISOString(),
            duration_ms: finished.getTime() - started.getTime(),
            stderr: reason,
            error: reason,
          }),
        ]);
        return { jobId: job.id, status: "error", reason };
      } finally {
        await admin.rpc("release_scheduled_job_cloud_lock", {
          p_job_id: job.id,
          p_lock_token: lockToken,
        });
      }
    })
  );

  return {
    ok: true,
    checked: jobs.length,
    due: due.length,
    results,
  };
}
