do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'aiyra_conversations_channel_mode_check'
      and conrelid = 'public.aiyra_conversations'::regclass
  ) then
    alter table public.aiyra_conversations
      drop constraint aiyra_conversations_channel_mode_check;
  end if;
end
$$;

alter table public.aiyra_conversations
  add constraint aiyra_conversations_channel_mode_check
  check (channel_mode in ('mic_main', 'twilio_main', 'twilio_parent'));
