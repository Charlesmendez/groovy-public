-- Prevent repeated Groovy draft replies for the same Gmail thread.
--
-- The heartbeat can see several messages from one thread across runs. A user may
-- also manually delete the Gmail draft, but the inbox action row should remain
-- the durable marker that Groovy already drafted this thread once.

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, provider, connection_id, gmail_thread_id, recommended_action
      order by
        case status
          when 'pending' then 0
          when 'approved' then 1
          when 'executing' then 2
          when 'failed' then 3
          when 'done' then 4
          when 'rejected' then 5
          else 6
        end,
        case when gmail_draft_id is not null then 0 else 1 end,
        created_at desc,
        id desc
    ) as rn
  from public.inbox_actions
  where recommended_action = 'draft_reply'
    and gmail_thread_id is not null
)
update public.inbox_actions ia
set
  metadata = coalesce(ia.metadata, '{}'::jsonb) || jsonb_build_object(
    'deduped_duplicate_thread_id', ia.gmail_thread_id,
    'deduped_duplicate_reason', 'draft_reply_thread_uniqueness',
    'deduped_duplicate_at', now()
  ),
  gmail_thread_id = null,
  updated_at = now()
from ranked r
where ia.id = r.id
  and r.rn > 1;

create unique index if not exists inbox_actions_one_draft_reply_per_thread_idx
on public.inbox_actions (user_id, provider, connection_id, gmail_thread_id)
where recommended_action = 'draft_reply'
  and gmail_thread_id is not null;
