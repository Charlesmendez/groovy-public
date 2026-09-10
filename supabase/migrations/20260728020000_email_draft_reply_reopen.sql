-- A completed draft reply belongs to the inbound message that triggered it,
-- not to every future reply in the Gmail thread. Keep duplicate protection
-- while an action is active, but allow a later message to reopen the
-- conversation and receive its own classification and draft.

drop index if exists public.inbox_actions_one_draft_reply_per_thread_idx;

create unique index inbox_actions_one_active_draft_reply_per_thread_idx
on public.inbox_actions (user_id, provider, connection_id, gmail_thread_id)
where recommended_action = 'draft_reply'
  and gmail_thread_id is not null
  and status in ('pending', 'approved', 'executing');
