-- Allow users to update their own chat attachment rows.
-- Needed so /api/files-agent/upload can persist anthropic_file_id after upload.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_attachments'
      and policyname = 'chat_attachments_update_own'
  ) then
    create policy "chat_attachments_update_own"
    on public.chat_attachments
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end
$$;

-- Backfill anthropic_file_id from historical message metadata files[] entries.
-- We take the most recent anthropicFileId per (user, session, attachment id).
with file_refs as (
  select
    m.user_id,
    m.session_id,
    (f->>'id') as attachment_id,
    nullif(f->>'anthropicFileId', '') as anthropic_file_id,
    row_number() over (
      partition by m.user_id, m.session_id, (f->>'id')
      order by m.created_at desc
    ) as rn
  from public.chat_messages m
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(m.metadata->'files') = 'array' then m.metadata->'files'
      else '[]'::jsonb
    end
  ) as f
  where nullif(f->>'id', '') is not null
    and nullif(f->>'anthropicFileId', '') is not null
)
update public.chat_attachments a
set anthropic_file_id = r.anthropic_file_id
from file_refs r
where r.rn = 1
  and a.user_id = r.user_id
  and a.session_id = r.session_id
  and a.id::text = r.attachment_id
  and a.anthropic_file_id is null;
