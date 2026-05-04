-- Keep orchestrator_sessions.updated_at in sync with message activity.
-- This fixes session ordering (and makes shared sessions feel live) because shared members do not own the session row.

create or replace function public.bump_orchestrator_session_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orchestrator_sessions
  set updated_at = now()
  where id = new.session_id;
  return new;
end;
$$;

drop trigger if exists trg_orchestrator_messages_bump_session on public.orchestrator_messages;
create trigger trg_orchestrator_messages_bump_session
after insert on public.orchestrator_messages
for each row execute function public.bump_orchestrator_session_updated_at();

