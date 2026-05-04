-- Claude Code CLI chat messages (replaces terminal-based UI)
-- Each claude_code_agent has a single conversation thread with message history

-- Store CLI session_id per agent for --continue support
CREATE TABLE IF NOT EXISTS public.claude_code_cli_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  claude_code_agent_id UUID NOT NULL,
  claude_session_id TEXT, -- CLI session_id for --continue
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, claude_code_agent_id)
);

-- Chat messages for Code Agent CLI conversations
CREATE TABLE IF NOT EXISTS public.claude_code_cli_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  claude_code_agent_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  diffs JSONB, -- Array of extracted diff blocks: [{filename, hunks, additions, deletions}]
  cost_usd NUMERIC(10, 6), -- Cost of this response (assistant messages only)
  duration_ms INTEGER, -- Duration of CLI call (assistant messages only)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_claude_code_cli_threads_user ON public.claude_code_cli_threads(user_id);
CREATE INDEX IF NOT EXISTS idx_claude_code_cli_threads_agent ON public.claude_code_cli_threads(claude_code_agent_id);
CREATE INDEX IF NOT EXISTS idx_claude_code_cli_messages_user ON public.claude_code_cli_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_claude_code_cli_messages_agent ON public.claude_code_cli_messages(claude_code_agent_id);
CREATE INDEX IF NOT EXISTS idx_claude_code_cli_messages_created ON public.claude_code_cli_messages(claude_code_agent_id, created_at);

-- RLS policies
ALTER TABLE public.claude_code_cli_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claude_code_cli_messages ENABLE ROW LEVEL SECURITY;

-- Threads: users can only access their own
CREATE POLICY "Users can view own claude_code_cli_threads"
  ON public.claude_code_cli_threads FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own claude_code_cli_threads"
  ON public.claude_code_cli_threads FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own claude_code_cli_threads"
  ON public.claude_code_cli_threads FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own claude_code_cli_threads"
  ON public.claude_code_cli_threads FOR DELETE
  USING (auth.uid() = user_id);

-- Messages: users can only access their own
CREATE POLICY "Users can view own claude_code_cli_messages"
  ON public.claude_code_cli_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own claude_code_cli_messages"
  ON public.claude_code_cli_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own claude_code_cli_messages"
  ON public.claude_code_cli_messages FOR DELETE
  USING (auth.uid() = user_id);
