-- Add 'claude_cli' as a valid provider for user_api_keys
-- This stores the Claude headless CLI OAuth token (from `claude setup-token`)
-- which authenticates via CLAUDE_CODE_OAUTH_TOKEN env var instead of ANTHROPIC_API_KEY.

-- Drop the old check constraint and add a new one that includes claude_cli
ALTER TABLE user_api_keys DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;
ALTER TABLE user_api_keys ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'google', 'xai', 'claude_cli'));
