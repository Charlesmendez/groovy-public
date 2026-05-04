-- Expand provider-key constraints for the customer-owned key model.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'user_api_keys_provider_check'
      and conrelid = 'public.user_api_keys'::regclass
  ) then
    alter table public.user_api_keys drop constraint user_api_keys_provider_check;
  end if;
end $$;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (
    provider in (
      'anthropic',
      'openai',
      'google',
      'xai',
      'claude_cli',
      'codex_cli',
      'azure_openai',
      'aws_bedrock',
      'groq',
      'mistral',
      'other'
    )
  );
