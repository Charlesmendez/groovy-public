-- Huddle clients filter Realtime updates by non-primary-key columns. Publish
-- complete rows so participant joins/leaves and huddle termination remain
-- visible across browsers, including after an upsert of a previous join.
alter table public.chat_huddles replica identity full;
alter table public.chat_huddle_participants replica identity full;
alter table public.chat_huddle_signals replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.chat_huddles;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime
    add table public.chat_huddle_participants;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_huddle_signals;
exception
  when duplicate_object then null;
end $$;
