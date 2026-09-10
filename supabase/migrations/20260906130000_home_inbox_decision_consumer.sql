-- Optional Home Inbox decision consumer. No existing profile, user, tenant,
-- conversation or schedule is adopted or activated by this migration.
create table public.home_inbox_bindings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.orchestrator_profiles(id) on delete restrict,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  workspace_id uuid references public.workspaces(id) on delete restrict,
  tenant_id uuid not null,
  project_id uuid not null,
  harness_ref text not null check (harness_ref ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
  home_key_enc text not null,
  home_origin text not null,
  status text not null default 'paused' check(status in ('active','paused','revoked')),
  verified_at timestamptz not null,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index home_inbox_binding_active_scope on public.home_inbox_bindings(tenant_id,project_id,harness_ref) where status <> 'revoked';
create index home_inbox_bindings_profile on public.home_inbox_bindings(profile_id,created_at);
-- One dedicated Mind per project binding. Reusing a Mind across clients would
-- also reuse its explicit skill/integration grants, despite isolated sessions.
create unique index home_inbox_binding_profile_scope on public.home_inbox_bindings(profile_id) where status <> 'revoked';

create function public.guard_home_inbox_binding_scope() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if row(new.profile_id,new.owner_user_id,new.workspace_id,new.tenant_id,new.project_id,new.harness_ref,new.home_origin,new.home_key_enc)
       is distinct from row(old.profile_id,old.owner_user_id,old.workspace_id,old.tenant_id,old.project_id,old.harness_ref,old.home_origin,old.home_key_enc)
       or (old.status='revoked' and new.status<>'revoked') then
      raise exception 'Home Inbox binding identity and revoked credentials are immutable' using errcode='23514';
    end if;
  else
    -- Serialize same-Mind creation, including credential rotation, and retain
    -- the project boundary after revocation. Never recycle a client Mind into
    -- another project's history, persona or explicitly assigned capabilities.
    perform 1 from public.orchestrator_profiles where id=new.profile_id for update;
    if exists(select 1 from public.home_inbox_bindings b where b.profile_id=new.profile_id
      and (b.tenant_id<>new.tenant_id or b.project_id<>new.project_id)) then
      raise exception 'Use a dedicated Mind for each Home project' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_home_inbox_binding_scope before insert or update on public.home_inbox_bindings
for each row execute function public.guard_home_inbox_binding_scope();
revoke all on function public.guard_home_inbox_binding_scope() from public,anon,authenticated;

create table public.home_inbox_decision_runs (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.home_inbox_bindings(id) on delete restrict,
  decision_id uuid not null,
  claim_key text not null,
  claim_enc text,
  profile_snapshot jsonb,
  session_id uuid references public.orchestrator_sessions(id) on delete restrict,
  trace_id uuid not null default gen_random_uuid(),
  state text not null check(state in ('claiming','running','completed','delivered','unknown','cancelled')),
  result jsonb,
  applied boolean,
  error_code text,
  expires_at timestamptz not null,
  delivery_attempts integer not null default 0 check(delivery_attempts>=0),
  next_delivery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(binding_id,decision_id),
  check(state not in ('running','completed','delivered') or (claim_enc is not null and profile_snapshot is not null)),
  check(state not in ('completed','delivered') or result is not null)
);
-- Private even to profile owners: route handlers expose only authorized
-- metadata. Service-role access never substitutes for runtime ownership checks.
alter table public.home_inbox_bindings enable row level security;
alter table public.home_inbox_decision_runs enable row level security;
revoke all on public.home_inbox_bindings,public.home_inbox_decision_runs from public,anon,authenticated;
grant all on public.home_inbox_bindings,public.home_inbox_decision_runs to service_role;
create index home_inbox_decisions_pending_receipts on public.home_inbox_decision_runs(next_delivery_at) where state='completed';
create index home_inbox_decisions_unfinished on public.home_inbox_decision_runs(expires_at) where state in ('claiming','running');
