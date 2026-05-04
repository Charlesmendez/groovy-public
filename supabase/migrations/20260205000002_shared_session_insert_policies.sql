-- Tighten insert policies so users can only write into orchestrator sessions they can see.
-- This is important once sessions/messages are shareable via workspace_orchestrator_sessions.

-- Orchestrator messages: must be authored by the current user AND session must be visible.
drop policy if exists "Users can insert own orchestrator messages" on public.orchestrator_messages;
create policy "Users can insert messages into visible sessions"
on public.orchestrator_messages
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.orchestrator_sessions os
    where os.id = orchestrator_messages.session_id
  )
);

-- Activity log: same constraint when session_id is present.
drop policy if exists "Users can insert own activity" on public.activity_log;
create policy "Users can insert activity into visible sessions"
on public.activity_log
for insert
with check (
  auth.uid() = user_id
  and (
    session_id is null
    or exists (
      select 1 from public.orchestrator_sessions os
      where os.id = activity_log.session_id
    )
  )
);

