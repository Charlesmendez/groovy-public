-- Channel-scoped operating instructions for the bound orchestrator Mind.
--
-- These instructions are deliberately additive. They never replace the Mind
-- profile, its authorization stance, or the executor-enforced tool policy.

alter table public.chat_channels
  add column if not exists orchestrator_instructions text null;

alter table public.chat_channels
  drop constraint if exists chat_channels_orchestrator_instructions_length_check;

alter table public.chat_channels
  add constraint chat_channels_orchestrator_instructions_length_check
  check (
    orchestrator_instructions is null
    or char_length(orchestrator_instructions) between 1 and 12000
  );

comment on column public.chat_channels.orchestrator_instructions is
  'Workspace-authored, channel-scoped operating brief. Additive to the bound Mind and subordinate to authorization/tool policy.';
