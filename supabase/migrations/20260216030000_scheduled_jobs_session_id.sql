-- Add session_id to scheduled_jobs so we can track which orchestrator agent created the job.
-- Nullable because existing jobs don't have a session, and ON DELETE SET NULL keeps the job alive
-- even if the session is deleted.

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.orchestrator_sessions(id)
    ON DELETE SET NULL;

-- Index for efficient lookups: "how many active jobs does this session have?"
CREATE INDEX IF NOT EXISTS scheduled_jobs_session_id_idx
  ON public.scheduled_jobs (session_id)
  WHERE session_id IS NOT NULL;
