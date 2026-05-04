-- Enable realtime for workspace_orchestrator_sessions so shared-session lists update live.

alter publication supabase_realtime add table public.workspace_orchestrator_sessions;

