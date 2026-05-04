-- Add optional system_prompt column for AI Chat agents
alter table public.agents add column if not exists system_prompt text null;
