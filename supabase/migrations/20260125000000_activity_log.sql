-- Orchestrator chat sessions (separate from agent-specific sessions)
CREATE TABLE IF NOT EXISTS orchestrator_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_sessions_user 
  ON orchestrator_sessions(user_id, updated_at DESC);

ALTER TABLE orchestrator_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own orchestrator sessions" ON orchestrator_sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own orchestrator sessions" ON orchestrator_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own orchestrator sessions" ON orchestrator_sessions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own orchestrator sessions" ON orchestrator_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- Orchestrator messages (stored per session)
CREATE TABLE IF NOT EXISTS orchestrator_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES orchestrator_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_session 
  ON orchestrator_messages(session_id, created_at);

ALTER TABLE orchestrator_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own orchestrator messages" ON orchestrator_messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own orchestrator messages" ON orchestrator_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Activity log for tracking all agent events (linked to session)
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES orchestrator_sessions(id) ON DELETE CASCADE,
  trace_id TEXT,
  agent TEXT NOT NULL, -- browser, files, obsidian, data, memory, system
  action TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_session 
  ON activity_log(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_log_user_created 
  ON activity_log(user_id, created_at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own activity" ON activity_log
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own activity" ON activity_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Auto-cleanup old activities (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_activities()
RETURNS void AS $$
BEGIN
  DELETE FROM activity_log 
  WHERE created_at < now() - interval '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
