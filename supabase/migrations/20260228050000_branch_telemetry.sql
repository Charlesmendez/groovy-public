-- Branch telemetry for branch-controller observability.

alter table public.orchestrator_branches
  add column if not exists fork_reason text,
  add column if not exists merge_reason text,
  add column if not exists abort_reason text,
  add column if not exists budget_limit_hit text,
  add column if not exists budget_hit_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_branches_budget_limit_hit_check'
      and conrelid = 'public.orchestrator_branches'::regclass
  ) then
    alter table public.orchestrator_branches
      add constraint orchestrator_branches_budget_limit_hit_check
      check (
        budget_limit_hit is null
        or budget_limit_hit in ('read_only', 'max_turns', 'max_branches')
      );
  end if;
end $$;

create index if not exists orchestrator_branches_budget_hits_idx
  on public.orchestrator_branches (agent_id, epoch_id, budget_hit_at desc)
  where budget_limit_hit is not null;
