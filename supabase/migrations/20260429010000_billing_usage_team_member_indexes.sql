-- Speed up admin usage filtering by workspace member.
create index if not exists idx_billing_usage_events_workspace_user_created_id
on public.billing_usage_events (workspace_id, user_id, created_at, id);

create index if not exists idx_billing_tool_events_workspace_user_created_id
on public.billing_tool_events (workspace_id, user_id, created_at, id);
