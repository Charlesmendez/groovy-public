alter table public.email_classification_feedback
  add column if not exists request_id text null;

create unique index if not exists email_classification_feedback_request_idx
  on public.email_classification_feedback(user_id, request_id);
