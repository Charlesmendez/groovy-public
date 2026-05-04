-- Prevent duplicate WhatsApp ingress messages from being inserted twice
-- when the connector has to replay the same inbound message id.
create unique index if not exists idx_orchestrator_messages_whatsapp_user_trace
on public.orchestrator_messages (session_id, trace_id)
where role = 'user' and trace_id like 'wa:%';
