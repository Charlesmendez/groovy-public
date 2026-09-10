-- Team Chat executes with the workspace capability owner's provider keys and
-- connector access. Before usageActorUserId existed, that runtime owner was
-- also written into usage rows, hiding the actual member who initiated work.
-- Reattribute historical rows by the durable chat run trace while preserving
-- the credential owner in metadata for audits.

with attributable_runs as (
  select
    channel.workspace_id,
    run.trace_id,
    min(run.started_by::text)::uuid as usage_actor_user_id
  from public.chat_orchestrator_runs run
  join public.chat_channels channel
    on channel.id = run.channel_id
  join public.workspace_members member
    on member.workspace_id = channel.workspace_id
   and member.user_id = run.started_by
  where run.started_by is not null
    and nullif(btrim(run.trace_id), '') is not null
  group by channel.workspace_id, run.trace_id
  having count(distinct run.started_by) = 1
)
update public.billing_usage_events event
set
  user_id = attributable.usage_actor_user_id,
  meta = coalesce(event.meta, '{}'::jsonb) || jsonb_build_object(
    'usageActorUserId', attributable.usage_actor_user_id,
    'credentialOwnerUserId', event.user_id,
    'usageAttributionSource', 'chat_orchestrator_runs.started_by'
  )
from attributable_runs attributable
where event.workspace_id = attributable.workspace_id
  and event.trace_id = attributable.trace_id
  and event.user_id is distinct from attributable.usage_actor_user_id;

with attributable_runs as (
  select
    channel.workspace_id,
    run.trace_id,
    min(run.started_by::text)::uuid as usage_actor_user_id
  from public.chat_orchestrator_runs run
  join public.chat_channels channel
    on channel.id = run.channel_id
  join public.workspace_members member
    on member.workspace_id = channel.workspace_id
   and member.user_id = run.started_by
  where run.started_by is not null
    and nullif(btrim(run.trace_id), '') is not null
  group by channel.workspace_id, run.trace_id
  having count(distinct run.started_by) = 1
)
update public.billing_tool_events event
set
  user_id = attributable.usage_actor_user_id,
  meta = coalesce(event.meta, '{}'::jsonb) || jsonb_build_object(
    'usageActorUserId', attributable.usage_actor_user_id,
    'credentialOwnerUserId', event.user_id,
    'usageAttributionSource', 'chat_orchestrator_runs.started_by'
  )
from attributable_runs attributable
where event.workspace_id = attributable.workspace_id
  and event.trace_id = attributable.trace_id
  and event.user_id is distinct from attributable.usage_actor_user_id;
