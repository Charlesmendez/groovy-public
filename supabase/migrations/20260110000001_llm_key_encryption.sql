-- Store encrypted provider API keys for ai-chat agents (reversible encryption).
-- Plaintext is never stored; the server decrypts at request time.

alter table public.agents
  add column if not exists llm_api_key_enc text null;

