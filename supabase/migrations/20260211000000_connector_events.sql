-- Connector telemetry for startup/auth/pairing failures seen by the relay
CREATE TABLE IF NOT EXISTS connector_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL CHECK (event_type IN ('auth_failure', 'pairing_failure', 'runtime_failure')),
  error_code TEXT NOT NULL,
  detail TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id TEXT,
  connector_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_connector_events_created_at
  ON connector_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connector_events_user_created
  ON connector_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connector_events_error_code_created
  ON connector_events(error_code, created_at DESC);

ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;

-- Intentionally no user-facing policies.
-- Relay inserts using service role, and admin tooling can query with service/admin client.
