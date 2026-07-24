-- Durable rolling context for long-lived orchestrator sessions.
--
-- The immutable transcript remains in orchestrator_messages. A checkpoint is
-- only a model-facing continuation summary through a stable message cursor.
-- Runtime permissions, tools, channel membership, and worker rosters are
-- intentionally not stored here; callers resolve those boundaries fresh.

create table if not exists public.orchestrator_context_checkpoints (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.orchestrator_sessions(id) on delete cascade,
  scope_key text not null,
  summary text not null,
  -- Store the cursor value without a foreign key. Deleting an archived
  -- transcript row must not erase or regress the checkpoint cursor.
  through_message_id uuid,
  through_created_at timestamptz not null,
  summarized_message_count integer not null default 0
    check (summarized_message_count >= 0),
  summary_version integer not null default 1
    check (summary_version >= 1),
  provider text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, scope_key),
  check (char_length(scope_key) between 1 and 300),
  check (char_length(summary) between 1 and 800000)
);

alter table public.orchestrator_context_checkpoints
  drop constraint if exists
    orchestrator_context_checkpoints_through_message_id_fkey;

create index if not exists orchestrator_context_checkpoints_session_idx
  on public.orchestrator_context_checkpoints(session_id, updated_at desc);

create index if not exists orchestrator_messages_context_cursor_idx
  on public.orchestrator_messages(session_id, created_at, id)
  where session_id is not null;

create or replace function public.prevent_orchestrator_checkpoint_regression()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if
    new.through_created_at < old.through_created_at
    or (
      new.through_created_at = old.through_created_at
      and coalesce(new.through_message_id::text, '') <
        coalesce(old.through_message_id::text, '')
    )
    or (
      new.through_created_at = old.through_created_at
      and new.through_message_id is not distinct from old.through_message_id
      and new.summary_version <= old.summary_version
    )
  then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists orchestrator_context_checkpoint_no_regression
  on public.orchestrator_context_checkpoints;
create trigger orchestrator_context_checkpoint_no_regression
before update on public.orchestrator_context_checkpoints
for each row execute function public.prevent_orchestrator_checkpoint_regression();

alter table public.orchestrator_context_checkpoints enable row level security;

-- Checkpoints are model-facing prompt material. Keep writes server-only so a
-- browser client cannot forge a summary or move the transcript cursor.
revoke all on table public.orchestrator_context_checkpoints
  from anon, authenticated;

-- No browser-facing policies are created. The service role bypasses RLS and is
-- the only runtime allowed to read or mutate model-facing checkpoint text.
drop policy if exists "orchestrator_context_checkpoints_select"
  on public.orchestrator_context_checkpoints;
drop policy if exists "orchestrator_context_checkpoints_insert"
  on public.orchestrator_context_checkpoints;
drop policy if exists "orchestrator_context_checkpoints_update"
  on public.orchestrator_context_checkpoints;
drop policy if exists "orchestrator_context_checkpoints_delete"
  on public.orchestrator_context_checkpoints;

comment on table public.orchestrator_context_checkpoints is
  'Rolling model-facing summaries for long-lived orchestrator contexts. Full transcripts remain in orchestrator_messages.';
comment on column public.orchestrator_context_checkpoints.scope_key is
  'Security/runtime scope such as session, epoch:<id>, or branch:<id>.';
comment on column public.orchestrator_context_checkpoints.summary is
  'Historical conversation facts only. It never grants tools, agents, skills, or permissions.';
