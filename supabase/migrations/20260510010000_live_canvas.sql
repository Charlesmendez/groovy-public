-- Live channel: agent-built HTML canvas backed by a per-user markdown wiki.
--
-- Storage bucket "wiki" holds one directory per user with this shape:
--   {user_id}/index.md
--   {user_id}/log.md
--   {user_id}/schema.md
--   {user_id}/ui/canvas.html
--   {user_id}/entities/<name>.md
--   {user_id}/concepts/<name>.md
--   {user_id}/projects/<name>.md
--
-- Postgres table user_canvas_revisions keeps an append-only history of the
-- HTML canvas so it can be rewound independently of the wiki itself.
--
-- Storage bucket "wiki_raw_sources" holds immutable per-user source records.
-- App code writes these once during ingest_source turns. The LLM-owned wiki
-- cites them but does not modify them.

-- Storage bucket for the wiki
insert into storage.buckets (id, name, public)
values ('wiki', 'wiki', false)
on conflict (id) do nothing;

update storage.buckets
set file_size_limit = 102400
where id = 'wiki'
  and (file_size_limit is null or file_size_limit > 102400);

drop policy if exists "wiki_select_own" on storage.objects;
drop policy if exists "wiki_insert_own" on storage.objects;
drop policy if exists "wiki_update_own" on storage.objects;
drop policy if exists "wiki_delete_own" on storage.objects;

create policy "wiki_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'wiki'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "wiki_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'wiki'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "wiki_update_own"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'wiki'
  and auth.uid()::text = split_part(name, '/', 1)
)
with check (
  bucket_id = 'wiki'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "wiki_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'wiki'
  and auth.uid()::text = split_part(name, '/', 1)
);

-- Immutable raw-source bucket
insert into storage.buckets (id, name, public)
values ('wiki_raw_sources', 'wiki_raw_sources', false)
on conflict (id) do nothing;

update storage.buckets
set file_size_limit = 262144
where id = 'wiki_raw_sources'
  and (file_size_limit is null or file_size_limit > 262144);

drop policy if exists "wiki_raw_sources_select_own" on storage.objects;
drop policy if exists "wiki_raw_sources_insert_own" on storage.objects;

create policy "wiki_raw_sources_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'wiki_raw_sources'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "wiki_raw_sources_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'wiki_raw_sources'
  and auth.uid()::text = split_part(name, '/', 1)
);

-- Append-only revision log for the canvas HTML
create table if not exists public.user_canvas_revisions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null,
  html text not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint user_canvas_revisions_user_version_unique unique (user_id, version),
  constraint user_canvas_revisions_html_size_check check (octet_length(html) <= 102400)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_canvas_revisions_user_version_unique'
      and conrelid = 'public.user_canvas_revisions'::regclass
  ) then
    alter table public.user_canvas_revisions
      add constraint user_canvas_revisions_user_version_unique unique (user_id, version);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'user_canvas_revisions_html_size_check'
      and conrelid = 'public.user_canvas_revisions'::regclass
  ) then
    alter table public.user_canvas_revisions
      add constraint user_canvas_revisions_html_size_check check (octet_length(html) <= 102400);
  end if;
end $$;

create index if not exists user_canvas_revisions_user_idx
  on public.user_canvas_revisions (user_id, version desc);

alter table public.user_canvas_revisions enable row level security;

drop policy if exists "canvas_revisions_select_own" on public.user_canvas_revisions;
drop policy if exists "canvas_revisions_insert_own" on public.user_canvas_revisions;
drop policy if exists "canvas_revisions_delete_own" on public.user_canvas_revisions;

create policy "canvas_revisions_select_own"
on public.user_canvas_revisions
for select
using (auth.uid() = user_id);

create policy "canvas_revisions_insert_own"
on public.user_canvas_revisions
for insert
with check (auth.uid() = user_id);

create policy "canvas_revisions_delete_own"
on public.user_canvas_revisions
for delete
using (auth.uid() = user_id);
