-- Per-worker harness reasoning effort. Null delegates to the model default.
alter table public.claude_code_agent_configs
  add column if not exists reasoning_effort text null;

alter table public.claude_code_agent_configs
  drop constraint if exists claude_code_agent_configs_reasoning_effort_check;

alter table public.claude_code_agent_configs
  add constraint claude_code_agent_configs_reasoning_effort_check
  check (reasoning_effort is null or reasoning_effort in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
