-- Allow creating Claude Code sessions without selecting a workspace folder.
-- When workspace_id is NULL, the relay opens terminals with an empty cwd and the connector defaults to $HOME.

alter table public.claude_code_agent_configs
alter column workspace_id drop not null;

