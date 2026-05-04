create extension if not exists "pgcrypto";

create table if not exists public.orchestrator_extensions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  visibility text not null default 'private',
  runtime_target_default text not null default 'groovy_cloud',
  status text not null default 'draft',
  active_version_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_extensions_user_agent_slug_unique unique (user_id, agent_id, slug),
  constraint orchestrator_extensions_visibility_check
    check (visibility in ('private', 'org', 'public')),
  constraint orchestrator_extensions_runtime_target_check
    check (runtime_target_default in ('groovy_cloud', 'customer_runner', 'device_connector')),
  constraint orchestrator_extensions_status_check
    check (status in ('draft', 'active', 'disabled'))
);

create table if not exists public.orchestrator_extension_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  version_label text not null default 'draft',
  manifest jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_extensions_active_version_fk'
  ) then
    alter table public.orchestrator_extensions
      add constraint orchestrator_extensions_active_version_fk
      foreign key (active_version_id)
      references public.orchestrator_extension_versions(id)
      on delete set null;
  end if;
end $$;

create table if not exists public.orchestrator_extension_runners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  name text not null,
  runtime_target text not null default 'customer_runner',
  transport text not null default 'relay',
  status text not null default 'offline',
  endpoint text null,
  public_key text null,
  auth_token_enc text null,
  auth_token_hash text null,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_extension_runners_user_agent_name_unique unique (user_id, agent_id, name),
  constraint orchestrator_extension_runners_runtime_target_check
    check (runtime_target in ('groovy_cloud', 'customer_runner', 'device_connector')),
  constraint orchestrator_extension_runners_transport_check
    check (transport in ('relay', 'https', 'local')),
  constraint orchestrator_extension_runners_status_check
    check (status in ('pending', 'online', 'offline', 'error'))
);

create table if not exists public.orchestrator_extension_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  extension_version_id uuid null references public.orchestrator_extension_versions(id) on delete set null,
  install_status text not null default 'installed',
  install_scope text not null default 'user',
  runtime_target_override text null,
  enabled boolean not null default true,
  approval_policy jsonb not null default '{}'::jsonb,
  runner_id uuid null references public.orchestrator_extension_runners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_extension_installations_user_agent_extension_unique
    unique (user_id, agent_id, extension_id),
  constraint orchestrator_extension_installations_status_check
    check (install_status in ('installed', 'disabled', 'error')),
  constraint orchestrator_extension_installations_scope_check
    check (install_scope in ('user', 'workspace', 'org')),
  constraint orchestrator_extension_installations_runtime_target_check
    check (
      runtime_target_override is null
      or runtime_target_override in ('groovy_cloud', 'customer_runner', 'device_connector')
    )
);

create table if not exists public.orchestrator_extension_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  installation_id uuid not null references public.orchestrator_extension_installations(id) on delete cascade,
  auth_scope text not null default 'end_user',
  status text not null default 'pending',
  config jsonb not null default '{}'::jsonb,
  secrets_enc text null,
  secrets_hash text null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_extension_connections_install_auth_scope_unique
    unique (user_id, installation_id, auth_scope),
  constraint orchestrator_extension_connections_auth_scope_check
    check (auth_scope in ('none', 'end_user', 'shared_org', 'service_identity')),
  constraint orchestrator_extension_connections_status_check
    check (status in ('pending', 'connected', 'disconnected', 'error'))
);

create table if not exists public.orchestrator_extension_usage_meter (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  extension_version_id uuid null references public.orchestrator_extension_versions(id) on delete set null,
  installation_id uuid null references public.orchestrator_extension_installations(id) on delete set null,
  extension_slug text not null,
  tool_name text not null,
  runtime_target text not null,
  adapter text not null,
  auth_scope text not null,
  risk_level text not null,
  approval_state text not null default 'not_required',
  status text not null default 'success',
  trace_id text null,
  turn_id text null,
  billing_workspace_id uuid null,
  orchestrator_session_id text null,
  duration_ms integer not null default 0,
  input_bytes integer not null default 0,
  output_bytes integer not null default 0,
  groovy_cost_usd numeric null,
  external_usage_units numeric null,
  error_code text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint orchestrator_extension_usage_meter_runtime_target_check
    check (runtime_target in ('groovy_cloud', 'customer_runner', 'device_connector')),
  constraint orchestrator_extension_usage_meter_auth_scope_check
    check (auth_scope in ('none', 'end_user', 'shared_org', 'service_identity')),
  constraint orchestrator_extension_usage_meter_risk_level_check
    check (risk_level in ('read', 'write', 'destructive', 'privileged')),
  constraint orchestrator_extension_usage_meter_status_check
    check (status in ('scheduled', 'success', 'error')),
  constraint orchestrator_extension_usage_meter_approval_state_check
    check (approval_state in ('not_required', 'required', 'approved', 'denied'))
);

create table if not exists public.orchestrator_extension_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  installation_id uuid null references public.orchestrator_extension_installations(id) on delete set null,
  trace_id text null,
  turn_id text null,
  orchestrator_session_id text null,
  extension_slug text not null,
  tool_name text not null,
  action text not null default 'tool_call',
  actor_scope text not null default 'end_user',
  approval_state text not null default 'not_required',
  status text not null default 'success',
  request_preview jsonb not null default '{}'::jsonb,
  result_preview jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint orchestrator_extension_audit_events_actor_scope_check
    check (actor_scope in ('none', 'end_user', 'shared_org', 'service_identity')),
  constraint orchestrator_extension_audit_events_status_check
    check (status in ('scheduled', 'success', 'error')),
  constraint orchestrator_extension_audit_events_approval_state_check
    check (approval_state in ('not_required', 'required', 'approved', 'denied'))
);

create table if not exists public.orchestrator_extension_runtime_traces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid not null references public.orchestrator_extensions(id) on delete cascade,
  extension_version_id uuid null references public.orchestrator_extension_versions(id) on delete set null,
  installation_id uuid null references public.orchestrator_extension_installations(id) on delete set null,
  trace_id text null,
  turn_id text null,
  extension_slug text not null,
  tool_name text not null,
  runtime_target text not null,
  adapter text not null,
  status text not null default 'success',
  duration_ms integer not null default 0,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text null,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint orchestrator_extension_runtime_traces_runtime_target_check
    check (runtime_target in ('groovy_cloud', 'customer_runner', 'device_connector')),
  constraint orchestrator_extension_runtime_traces_status_check
    check (status in ('scheduled', 'success', 'error'))
);

create table if not exists public.orchestrator_extension_analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  extension_id uuid null references public.orchestrator_extensions(id) on delete set null,
  installation_id uuid null references public.orchestrator_extension_installations(id) on delete set null,
  trace_id text null,
  event_name text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists orchestrator_extensions_user_agent_status_idx
  on public.orchestrator_extensions (user_id, agent_id, status, updated_at desc);

create index if not exists orchestrator_extension_versions_extension_created_idx
  on public.orchestrator_extension_versions (extension_id, created_at desc);

create index if not exists orchestrator_extension_installations_user_agent_status_idx
  on public.orchestrator_extension_installations (user_id, agent_id, install_status, updated_at desc);

create index if not exists orchestrator_extension_connections_install_status_idx
  on public.orchestrator_extension_connections (installation_id, status, updated_at desc);

create index if not exists orchestrator_extension_runners_user_agent_status_idx
  on public.orchestrator_extension_runners (user_id, agent_id, status, updated_at desc);

create index if not exists orchestrator_extension_usage_meter_user_created_idx
  on public.orchestrator_extension_usage_meter (user_id, created_at desc);

create index if not exists orchestrator_extension_usage_meter_extension_tool_idx
  on public.orchestrator_extension_usage_meter (extension_id, tool_name, created_at desc);

create index if not exists orchestrator_extension_audit_events_user_created_idx
  on public.orchestrator_extension_audit_events (user_id, created_at desc);

create index if not exists orchestrator_extension_runtime_traces_trace_idx
  on public.orchestrator_extension_runtime_traces (trace_id, created_at desc);

create index if not exists orchestrator_extension_analytics_events_user_event_idx
  on public.orchestrator_extension_analytics_events (user_id, event_name, created_at desc);

alter table public.orchestrator_extensions enable row level security;
alter table public.orchestrator_extension_versions enable row level security;
alter table public.orchestrator_extension_installations enable row level security;
alter table public.orchestrator_extension_connections enable row level security;
alter table public.orchestrator_extension_runners enable row level security;
alter table public.orchestrator_extension_usage_meter enable row level security;
alter table public.orchestrator_extension_audit_events enable row level security;
alter table public.orchestrator_extension_runtime_traces enable row level security;
alter table public.orchestrator_extension_analytics_events enable row level security;

drop policy if exists "orchestrator_extensions_select_own" on public.orchestrator_extensions;
create policy "orchestrator_extensions_select_own"
on public.orchestrator_extensions
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extensions_insert_own" on public.orchestrator_extensions;
create policy "orchestrator_extensions_insert_own"
on public.orchestrator_extensions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extensions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extensions_update_own" on public.orchestrator_extensions;
create policy "orchestrator_extensions_update_own"
on public.orchestrator_extensions
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extensions.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extensions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extensions_delete_own" on public.orchestrator_extensions;
create policy "orchestrator_extensions_delete_own"
on public.orchestrator_extensions
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extensions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_versions_select_own" on public.orchestrator_extension_versions;
create policy "orchestrator_extension_versions_select_own"
on public.orchestrator_extension_versions
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_versions_insert_own" on public.orchestrator_extension_versions;
create policy "orchestrator_extension_versions_insert_own"
on public.orchestrator_extension_versions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_versions_update_own" on public.orchestrator_extension_versions;
create policy "orchestrator_extension_versions_update_own"
on public.orchestrator_extension_versions
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_versions.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_versions_delete_own" on public.orchestrator_extension_versions;
create policy "orchestrator_extension_versions_delete_own"
on public.orchestrator_extension_versions
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_installations_select_own" on public.orchestrator_extension_installations;
create policy "orchestrator_extension_installations_select_own"
on public.orchestrator_extension_installations
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_installations_insert_own" on public.orchestrator_extension_installations;
create policy "orchestrator_extension_installations_insert_own"
on public.orchestrator_extension_installations
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_installations.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_installations_update_own" on public.orchestrator_extension_installations;
create policy "orchestrator_extension_installations_update_own"
on public.orchestrator_extension_installations
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_installations.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_installations.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_installations_delete_own" on public.orchestrator_extension_installations;
create policy "orchestrator_extension_installations_delete_own"
on public.orchestrator_extension_installations
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_installations.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_connections_select_own" on public.orchestrator_extension_connections;
create policy "orchestrator_extension_connections_select_own"
on public.orchestrator_extension_connections
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_connections_insert_own" on public.orchestrator_extension_connections;
create policy "orchestrator_extension_connections_insert_own"
on public.orchestrator_extension_connections
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_connections.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_connections_update_own" on public.orchestrator_extension_connections;
create policy "orchestrator_extension_connections_update_own"
on public.orchestrator_extension_connections
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_connections.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_connections.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_connections_delete_own" on public.orchestrator_extension_connections;
create policy "orchestrator_extension_connections_delete_own"
on public.orchestrator_extension_connections
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_connections.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_runners_select_own" on public.orchestrator_extension_runners;
create policy "orchestrator_extension_runners_select_own"
on public.orchestrator_extension_runners
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_runners_insert_own" on public.orchestrator_extension_runners;
create policy "orchestrator_extension_runners_insert_own"
on public.orchestrator_extension_runners
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_runners.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_runners_update_own" on public.orchestrator_extension_runners;
create policy "orchestrator_extension_runners_update_own"
on public.orchestrator_extension_runners
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_runners.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_runners.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_runners_delete_own" on public.orchestrator_extension_runners;
create policy "orchestrator_extension_runners_delete_own"
on public.orchestrator_extension_runners
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_extension_runners.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_extension_usage_meter_select_own" on public.orchestrator_extension_usage_meter;
create policy "orchestrator_extension_usage_meter_select_own"
on public.orchestrator_extension_usage_meter
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_usage_meter_insert_own" on public.orchestrator_extension_usage_meter;
create policy "orchestrator_extension_usage_meter_insert_own"
on public.orchestrator_extension_usage_meter
for insert
with check (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_audit_events_select_own" on public.orchestrator_extension_audit_events;
create policy "orchestrator_extension_audit_events_select_own"
on public.orchestrator_extension_audit_events
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_audit_events_insert_own" on public.orchestrator_extension_audit_events;
create policy "orchestrator_extension_audit_events_insert_own"
on public.orchestrator_extension_audit_events
for insert
with check (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_runtime_traces_select_own" on public.orchestrator_extension_runtime_traces;
create policy "orchestrator_extension_runtime_traces_select_own"
on public.orchestrator_extension_runtime_traces
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_runtime_traces_insert_own" on public.orchestrator_extension_runtime_traces;
create policy "orchestrator_extension_runtime_traces_insert_own"
on public.orchestrator_extension_runtime_traces
for insert
with check (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_analytics_events_select_own" on public.orchestrator_extension_analytics_events;
create policy "orchestrator_extension_analytics_events_select_own"
on public.orchestrator_extension_analytics_events
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_extension_analytics_events_insert_own" on public.orchestrator_extension_analytics_events;
create policy "orchestrator_extension_analytics_events_insert_own"
on public.orchestrator_extension_analytics_events
for insert
with check (auth.uid() = user_id);
