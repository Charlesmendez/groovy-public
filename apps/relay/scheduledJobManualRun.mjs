export function scheduledJobManualRunDeviceDecision(job, targetDeviceId) {
  const target = String(targetDeviceId || "").trim();
  const assigned = String(job?.device_id || "").trim();
  if (!target || !assigned) {
    return { ok: false, error: "scheduled_job_device_missing" };
  }
  if (assigned === target) {
    return { ok: true, rebind: false };
  }
  if (String(job?.kind || "") !== "orchestrator") {
    return { ok: false, error: "scheduled_job_requires_assigned_connector" };
  }
  if (String(job?.target_agent_id || "").trim()) {
    return { ok: false, error: "scheduled_job_requires_assigned_connector" };
  }
  return { ok: true, rebind: true };
}
