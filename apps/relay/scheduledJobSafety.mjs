export function scheduledJobRelayExecutionDenialReason(job) {
  const channelId = String(job?.channel_id || "").trim();
  const kind = String(job?.kind || "").trim();
  if (channelId && kind !== "orchestrator") {
    return "channel_shell_schedule_forbidden";
  }
  return null;
}

export function relayExecutableScheduledJobs(jobs) {
  return Array.isArray(jobs)
    ? jobs.filter((job) => !scheduledJobRelayExecutionDenialReason(job))
    : [];
}
