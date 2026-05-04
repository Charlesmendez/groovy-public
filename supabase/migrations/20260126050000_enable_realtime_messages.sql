-- Enable Realtime for orchestrator_messages table
-- This allows the dashboard to auto-refresh when messages are inserted externally (e.g., WhatsApp)

-- Enable replica identity for realtime change tracking
alter table public.orchestrator_messages replica identity full;

-- Add table to supabase realtime publication
alter publication supabase_realtime add table public.orchestrator_messages;
