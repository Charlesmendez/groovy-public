-- External/guest Minds must never inherit workspace-wide skills or data
-- integrations. Runtime checks fail closed as well, but the database prevents
-- direct PostgREST writes from weakening this boundary.
update public.orchestrator_profiles
set
  authorization_stance = 'restricted',
  memory_scope = 'profile',
  inherit_workspace_skills = false,
  inherit_workspace_integrations = false,
  updated_at = now()
where surface = 'external'
  and (
    authorization_stance <> 'restricted'
    or memory_scope <> 'profile'
    or inherit_workspace_skills
    or inherit_workspace_integrations
  );

alter table public.orchestrator_profiles
  drop constraint if exists orchestrator_profiles_external_capabilities_check;

alter table public.orchestrator_profiles
  add constraint orchestrator_profiles_external_capabilities_check
  check (
    surface <> 'external'
    or (
      authorization_stance = 'restricted'
      and memory_scope = 'profile'
      and inherit_workspace_skills = false
      and inherit_workspace_integrations = false
    )
  );
