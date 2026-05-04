-- Persist the connector-reported model for Code CLI assistant messages.
ALTER TABLE public.claude_code_cli_messages
  ADD COLUMN IF NOT EXISTS model TEXT;
