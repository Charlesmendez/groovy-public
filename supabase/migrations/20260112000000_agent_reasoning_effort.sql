-- Add reasoning_effort column to agents table for OpenAI extended thinking
alter table public.agents 
add column if not exists reasoning_effort text null default 'medium';
