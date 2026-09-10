-- Email workspace reads are ordered by provider time and repeatedly reconcile
-- one Gmail conversation. The original generic created_at index leaves those
-- paths scanning and sorting a growing action history.

create index if not exists inbox_actions_email_feed_received_idx
  on public.inbox_actions (
    user_id,
    provider,
    connection_id,
    received_at desc nulls last,
    created_at desc,
    id desc
  )
  where provider = 'gmail';

create index if not exists inbox_actions_email_updated_idx
  on public.inbox_actions (
    user_id,
    provider,
    updated_at desc
  )
  where provider = 'gmail';

create index if not exists inbox_actions_email_thread_created_idx
  on public.inbox_actions (
    user_id,
    provider,
    connection_id,
    gmail_thread_id,
    received_at desc nulls last,
    created_at desc
  )
  where provider = 'gmail' and gmail_thread_id is not null;

-- Send idempotency and tracking lookups use PostgREST JSON containment
-- (`metadata @> ...`). jsonb_path_ops keeps this index compact while covering
-- those exact-containment predicates.
create index if not exists inbox_actions_metadata_path_idx
  on public.inbox_actions using gin (metadata jsonb_path_ops)
  where provider = 'gmail';
