-- Add code_cli_provider column to support Codex CLI as alternative to Claude CLI
alter table public.claude_code_agent_configs
add column if not exists code_cli_provider text not null default 'claude'
check (code_cli_provider in ('claude', 'codex'));
