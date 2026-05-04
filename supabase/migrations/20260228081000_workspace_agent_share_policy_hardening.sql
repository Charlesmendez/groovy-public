-- Harden agent sharing policy:
-- only workspace admins who own the target agent can publish it to workspace scope.

drop policy if exists "Workspace members can share agents" on public.workspace_orchestrator_agents;

create policy "Workspace members can share agents" on public.workspace_orchestrator_agents
  for insert
  with check (
    public.is_workspace_admin(workspace_id)
    and exists (
      select 1
      from public.agents a
      where a.id = workspace_orchestrator_agents.agent_id
        and a.user_id = auth.uid()
    )
  );
