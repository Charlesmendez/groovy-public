-- WhatsApp thread mappings should track runtime agent ownership directly.

alter table public.orchestrator_external_threads
  add column if not exists orchestrator_agent_id uuid
  references public.agents(id)
  on delete set null;

create index if not exists idx_orchestrator_external_threads_user_provider_agent
  on public.orchestrator_external_threads(user_id, provider, orchestrator_agent_id)
  where orchestrator_agent_id is not null;

-- Backfill from runtime session mapping when available.
update public.orchestrator_external_threads oet
set orchestrator_agent_id = osr.agent_id
from public.orchestrator_session_runtime osr
where oet.orchestrator_session_id = osr.session_id
  and oet.user_id = osr.user_id
  and oet.orchestrator_agent_id is null
  and osr.agent_id is not null;
