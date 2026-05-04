-- Enable Realtime for orchestrator_sessions table
-- This allows the dashboard to auto-refresh when sessions are created externally (e.g., WhatsApp)

-- Enable replica identity for realtime change tracking
alter table public.orchestrator_sessions replica identity full;

-- Add table to supabase realtime publication
alter publication supabase_realtime add table public.orchestrator_sessions;
