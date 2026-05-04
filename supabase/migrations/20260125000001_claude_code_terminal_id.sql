-- Add persistent terminal_id tracking for Claude Code sessions

alter table public.claude_code_agent_configs
add column if not exists terminal_id uuid null;

-- Ensure terminal IDs are globally unique when set (allows reliable reattach)
create unique index if not exists claude_code_agent_configs_terminal_id_uniq
on public.claude_code_agent_configs (terminal_id)
where terminal_id is not null;

create index if not exists claude_code_agent_configs_user_device_terminal_idx
on public.claude_code_agent_configs (user_id, device_id, terminal_id);

