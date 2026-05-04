-- Allow one runtime mapping per (session, user) so workspace-shared
-- conversations can maintain user-specific epoch/branch state.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_session_runtime_pkey'
      and conrelid = 'public.orchestrator_session_runtime'::regclass
  ) then
    alter table public.orchestrator_session_runtime
      drop constraint orchestrator_session_runtime_pkey;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_session_runtime_pkey'
      and conrelid = 'public.orchestrator_session_runtime'::regclass
  ) then
    alter table public.orchestrator_session_runtime
      add constraint orchestrator_session_runtime_pkey
      primary key (session_id, user_id);
  end if;
end $$;

create index if not exists idx_orchestrator_session_runtime_session
  on public.orchestrator_session_runtime(session_id);
