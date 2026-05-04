-- Add per-agent LLM key source + hashed key (never store plaintext)

alter table public.agents
  add column if not exists llm_key_source text null,
  add column if not exists llm_api_key_hash text null;

-- Optional helper index (not unique, used for quick "configured" checks)
create index if not exists agents_user_key_source_idx
on public.agents (user_id, llm_key_source);

