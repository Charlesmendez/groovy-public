-- Email clients reconcile queue and read-state changes made on other devices
-- from inbox_actions updates. Keep the publication change idempotent so this
-- migration is safe when Realtime was already enabled manually in Supabase.

do $$
begin
  alter publication supabase_realtime add table public.inbox_actions;
exception
  when duplicate_object then null;
end $$;
