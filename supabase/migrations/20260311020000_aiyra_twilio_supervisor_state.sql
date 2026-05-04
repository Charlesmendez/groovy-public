alter table public.aiyra_conversations
  add column if not exists twilio_last_update_id text null,
  add column if not exists twilio_last_update_at timestamptz null,
  add column if not exists twilio_child_conversation_id text null,
  add column if not exists twilio_child_kind text null,
  add column if not exists twilio_child_status text null,
  add column if not exists twilio_child_stage text null,
  add column if not exists twilio_child_summary text null,
  add column if not exists twilio_child_raw_text text null,
  add column if not exists twilio_call_sid text null,
  add column if not exists twilio_message_sid text null,
  add column if not exists twilio_speak_suggested boolean null,
  add column if not exists twilio_supervisor_state jsonb null;

create index if not exists aiyra_conversations_user_twilio_update_idx
  on public.aiyra_conversations (user_id, twilio_last_update_at desc);

create index if not exists aiyra_conversations_user_twilio_child_idx
  on public.aiyra_conversations (user_id, twilio_child_conversation_id);

alter table public.connector_aiyra_voice_health
  add column if not exists conversation_id text null,
  add column if not exists orchestrator_session_id uuid null references public.orchestrator_sessions(id) on delete set null,
  add column if not exists twilio_supervisor_state jsonb null;

create index if not exists connector_aiyra_voice_health_user_conversation_idx
  on public.connector_aiyra_voice_health (user_id, conversation_id);
