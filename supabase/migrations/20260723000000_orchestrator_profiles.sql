-- Harness profiles ("Minds"): configurable orchestrator identities.
-- A profile owns WHO the orchestrator is (persona, purpose, tone,
-- authorization stance, brain, tool policy, agent roster, memory scope).
-- The kernel stays in code. Zero rows = built-in Groovy default persona,
-- byte-identical to pre-profile behavior (see src/lib/orchestrator/profilePrompt.ts).

create table if not exists public.orchestrator_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  persona_prompt text,                 -- null = built-in Groovy persona
  purpose text,
  tone text,
  custom_instructions text,
  authorization_stance text not null default 'operator'
    check (authorization_stance in ('operator', 'restricted')),
  model jsonb,                         -- {provider, model, reasoningEffort} | null = user/env default
  tool_policy jsonb not null default '{"mode":"all"}'::jsonb,
  agent_roster jsonb,                  -- null = all agents; else array of agent uuids
  memory_scope text not null default 'shared'
    check (memory_scope in ('shared', 'profile')),
  surface text not null default 'internal'
    check (surface in ('internal', 'external')),
  widget_config jsonb,                 -- phase 3: widget branding
  is_default boolean not null default false,
  cloned_from uuid references public.orchestrator_profiles(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- External-facing profiles are both capability- and memory-isolated.
  check (
    surface = 'internal'
    or (
      authorization_stance = 'restricted'
      and memory_scope = 'profile'
    )
  ),
  -- A profile is either workspace-owned or personal, never both.
  check ((workspace_id is null) <> (user_id is null))
);

create unique index if not exists orchestrator_profiles_workspace_slug_idx
  on public.orchestrator_profiles (workspace_id, slug)
  where workspace_id is not null;

create unique index if not exists orchestrator_profiles_user_slug_idx
  on public.orchestrator_profiles (user_id, slug)
  where workspace_id is null;

-- At most one default profile per workspace / per personal owner.
create unique index if not exists orchestrator_profiles_workspace_default_idx
  on public.orchestrator_profiles (workspace_id)
  where workspace_id is not null and is_default;

create unique index if not exists orchestrator_profiles_user_default_idx
  on public.orchestrator_profiles (user_id)
  where workspace_id is null and is_default;

alter table public.orchestrator_profiles enable row level security;

drop policy if exists "orchestrator_profiles_select" on public.orchestrator_profiles;
create policy "orchestrator_profiles_select" on public.orchestrator_profiles
  for select using (
    (workspace_id is not null and public.is_workspace_member(workspace_id))
    or (workspace_id is null and user_id = auth.uid())
  );

drop policy if exists "orchestrator_profiles_insert" on public.orchestrator_profiles;
create policy "orchestrator_profiles_insert" on public.orchestrator_profiles
  for insert with check (
    (workspace_id is not null and public.is_workspace_admin(workspace_id))
    or (workspace_id is null and user_id = auth.uid())
  );

drop policy if exists "orchestrator_profiles_update" on public.orchestrator_profiles;
create policy "orchestrator_profiles_update" on public.orchestrator_profiles
  for update using (
    (workspace_id is not null and public.is_workspace_admin(workspace_id))
    or (workspace_id is null and user_id = auth.uid())
  );

drop policy if exists "orchestrator_profiles_delete" on public.orchestrator_profiles;
create policy "orchestrator_profiles_delete" on public.orchestrator_profiles
  for delete using (
    (workspace_id is not null and public.is_workspace_admin(workspace_id))
    or (workspace_id is null and user_id = auth.uid())
  );

-- Sticky profile per conversation + per external thread.
alter table public.orchestrator_sessions
  add column if not exists profile_id uuid references public.orchestrator_profiles(id) on delete restrict;

alter table public.orchestrator_external_threads
  add column if not exists profile_id uuid references public.orchestrator_profiles(id) on delete restrict;

-- Scheduled jobs can pin a profile (falls back to default when null).
alter table public.scheduled_jobs
  add column if not exists profile_id uuid references public.orchestrator_profiles(id) on delete restrict;

create index if not exists orchestrator_sessions_profile_idx
  on public.orchestrator_sessions (profile_id) where profile_id is not null;
