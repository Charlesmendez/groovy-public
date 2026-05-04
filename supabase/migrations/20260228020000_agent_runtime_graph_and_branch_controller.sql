-- Agent runtime graph + branch controller settings + inbox agent scope.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Branch controller persistence
-- ---------------------------------------------------------------------------
alter table public.user_preferences
  add column if not exists branch_controller jsonb not null default
  '{"maxBranches":4,"maxTurnsPerBranch":8,"mode":"read_write"}'::jsonb;

-- ---------------------------------------------------------------------------
-- Agent runtime graph (epoch + branch + session runtime head)
-- ---------------------------------------------------------------------------
create table if not exists public.orchestrator_agent_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  sequence integer not null,
  status text not null default 'active',
  reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint orchestrator_agent_epochs_status_check
    check (status in ('active', 'closed')),
  constraint orchestrator_agent_epochs_agent_sequence_unique
    unique (agent_id, sequence)
);

create index if not exists orchestrator_agent_epochs_user_agent_idx
  on public.orchestrator_agent_epochs (user_id, agent_id, created_at desc);

create unique index if not exists orchestrator_agent_epochs_one_active_idx
  on public.orchestrator_agent_epochs (agent_id)
  where status = 'active';

alter table public.orchestrator_agent_epochs enable row level security;

drop policy if exists "orchestrator_agent_epochs_select_own" on public.orchestrator_agent_epochs;
drop policy if exists "orchestrator_agent_epochs_insert_own" on public.orchestrator_agent_epochs;
drop policy if exists "orchestrator_agent_epochs_update_own" on public.orchestrator_agent_epochs;
drop policy if exists "orchestrator_agent_epochs_delete_own" on public.orchestrator_agent_epochs;

create policy "orchestrator_agent_epochs_select_own"
on public.orchestrator_agent_epochs
for select
using (auth.uid() = user_id);

create policy "orchestrator_agent_epochs_insert_own"
on public.orchestrator_agent_epochs
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_agent_epochs_update_own"
on public.orchestrator_agent_epochs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_agent_epochs_delete_own"
on public.orchestrator_agent_epochs
for delete
using (auth.uid() = user_id);

create table if not exists public.orchestrator_branches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  epoch_id uuid not null references public.orchestrator_agent_epochs(id) on delete cascade,
  parent_branch_id uuid null references public.orchestrator_branches(id) on delete set null,
  name text not null default 'main',
  status text not null default 'active',
  turn_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint orchestrator_branches_status_check
    check (status in ('active', 'merged', 'aborted')),
  constraint orchestrator_branches_turn_count_check
    check (turn_count >= 0)
);

create index if not exists orchestrator_branches_user_agent_epoch_idx
  on public.orchestrator_branches (user_id, agent_id, epoch_id, created_at desc);

create index if not exists orchestrator_branches_epoch_status_idx
  on public.orchestrator_branches (epoch_id, status, updated_at desc);

create unique index if not exists orchestrator_branches_main_per_epoch_idx
  on public.orchestrator_branches (epoch_id)
  where parent_branch_id is null;

alter table public.orchestrator_branches enable row level security;

drop policy if exists "orchestrator_branches_select_own" on public.orchestrator_branches;
drop policy if exists "orchestrator_branches_insert_own" on public.orchestrator_branches;
drop policy if exists "orchestrator_branches_update_own" on public.orchestrator_branches;
drop policy if exists "orchestrator_branches_delete_own" on public.orchestrator_branches;

create policy "orchestrator_branches_select_own"
on public.orchestrator_branches
for select
using (auth.uid() = user_id);

create policy "orchestrator_branches_insert_own"
on public.orchestrator_branches
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_branches_update_own"
on public.orchestrator_branches
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_branches_delete_own"
on public.orchestrator_branches
for delete
using (auth.uid() = user_id);

create table if not exists public.orchestrator_session_runtime (
  session_id uuid primary key references public.orchestrator_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  active_epoch_id uuid not null references public.orchestrator_agent_epochs(id) on delete cascade,
  active_branch_id uuid not null references public.orchestrator_branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orchestrator_session_runtime_user_agent_idx
  on public.orchestrator_session_runtime (user_id, agent_id, updated_at desc);

alter table public.orchestrator_session_runtime enable row level security;

drop policy if exists "orchestrator_session_runtime_select_own" on public.orchestrator_session_runtime;
drop policy if exists "orchestrator_session_runtime_insert_own" on public.orchestrator_session_runtime;
drop policy if exists "orchestrator_session_runtime_update_own" on public.orchestrator_session_runtime;
drop policy if exists "orchestrator_session_runtime_delete_own" on public.orchestrator_session_runtime;

create policy "orchestrator_session_runtime_select_own"
on public.orchestrator_session_runtime
for select
using (auth.uid() = user_id);

create policy "orchestrator_session_runtime_insert_own"
on public.orchestrator_session_runtime
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_session_runtime_update_own"
on public.orchestrator_session_runtime
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_session_runtime_delete_own"
on public.orchestrator_session_runtime
for delete
using (auth.uid() = user_id);

alter table public.orchestrator_messages
  add column if not exists epoch_id uuid references public.orchestrator_agent_epochs(id) on delete set null;

alter table public.orchestrator_messages
  add column if not exists branch_id uuid references public.orchestrator_branches(id) on delete set null;

create index if not exists idx_orchestrator_messages_session_epoch_created
  on public.orchestrator_messages (session_id, epoch_id, created_at);

create index if not exists idx_orchestrator_messages_branch_created
  on public.orchestrator_messages (branch_id, created_at)
  where branch_id is not null;

-- ---------------------------------------------------------------------------
-- Inbox action agent scope + agent-scoped alias/confirmation tables
-- ---------------------------------------------------------------------------
alter table public.inbox_actions
  add column if not exists agent_id uuid references public.agents(id) on delete set null;

create index if not exists inbox_actions_user_agent_status_idx
  on public.inbox_actions (user_id, agent_id, status, created_at desc)
  where agent_id is not null;

-- best-effort backfill from scheduler job ownership
update public.inbox_actions ia
set agent_id = sj.agent_id
from public.scheduled_jobs sj
where ia.source_job_id = sj.id
  and ia.agent_id is null
  and sj.agent_id is not null;

-- best-effort backfill from session runtime mapping
update public.inbox_actions ia
set agent_id = osr.agent_id
from public.orchestrator_session_runtime osr
where ia.session_id = osr.session_id
  and ia.agent_id is null
  and osr.agent_id is not null;

create table if not exists public.inbox_action_aliases_agent (
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  alias integer not null check (alias > 0),
  action_id uuid not null references public.inbox_actions(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_id, alias),
  constraint inbox_action_aliases_agent_unique_action unique (action_id)
);

create index if not exists inbox_action_aliases_agent_agent_idx
  on public.inbox_action_aliases_agent (user_id, agent_id, alias);

alter table public.inbox_action_aliases_agent enable row level security;

drop policy if exists "inbox_action_aliases_agent_select_own" on public.inbox_action_aliases_agent;
drop policy if exists "inbox_action_aliases_agent_insert_own" on public.inbox_action_aliases_agent;
drop policy if exists "inbox_action_aliases_agent_update_own" on public.inbox_action_aliases_agent;
drop policy if exists "inbox_action_aliases_agent_delete_own" on public.inbox_action_aliases_agent;

create policy "inbox_action_aliases_agent_select_own"
on public.inbox_action_aliases_agent
for select
using (auth.uid() = user_id);

create policy "inbox_action_aliases_agent_insert_own"
on public.inbox_action_aliases_agent
for insert
with check (auth.uid() = user_id);

create policy "inbox_action_aliases_agent_update_own"
on public.inbox_action_aliases_agent
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "inbox_action_aliases_agent_delete_own"
on public.inbox_action_aliases_agent
for delete
using (auth.uid() = user_id);

create table if not exists public.inbox_command_confirmations_agent (
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consumed_at timestamptz null,
  primary key (user_id, agent_id),
  constraint inbox_command_confirmations_agent_status_check
    check (status in ('pending', 'consumed', 'cancelled'))
);

create index if not exists inbox_command_confirmations_agent_user_status_idx
  on public.inbox_command_confirmations_agent (user_id, agent_id, status, updated_at desc);

alter table public.inbox_command_confirmations_agent enable row level security;

drop policy if exists "inbox_command_confirmations_agent_select_own" on public.inbox_command_confirmations_agent;
drop policy if exists "inbox_command_confirmations_agent_insert_own" on public.inbox_command_confirmations_agent;
drop policy if exists "inbox_command_confirmations_agent_update_own" on public.inbox_command_confirmations_agent;
drop policy if exists "inbox_command_confirmations_agent_delete_own" on public.inbox_command_confirmations_agent;

create policy "inbox_command_confirmations_agent_select_own"
on public.inbox_command_confirmations_agent
for select
using (auth.uid() = user_id);

create policy "inbox_command_confirmations_agent_insert_own"
on public.inbox_command_confirmations_agent
for insert
with check (auth.uid() = user_id);

create policy "inbox_command_confirmations_agent_update_own"
on public.inbox_command_confirmations_agent
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "inbox_command_confirmations_agent_delete_own"
on public.inbox_command_confirmations_agent
for delete
using (auth.uid() = user_id);
