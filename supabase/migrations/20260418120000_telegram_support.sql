-- Telegram bot configuration per user
CREATE TABLE IF NOT EXISTS telegram_bot_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_token_encrypted text NOT NULL,
  bot_username text NOT NULL,
  webhook_secret text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE telegram_bot_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own telegram config"
  ON telegram_bot_configs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own telegram config"
  ON telegram_bot_configs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own telegram config"
  ON telegram_bot_configs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own telegram config"
  ON telegram_bot_configs FOR DELETE
  USING (auth.uid() = user_id);

-- Known Telegram contacts the bot has interacted with (for recipient resolution)
CREATE TABLE IF NOT EXISTS telegram_known_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  telegram_username text,
  first_name text,
  last_name text,
  dm_chat_id bigint,
  last_seen_at timestamptz DEFAULT now(),
  UNIQUE(user_id, telegram_user_id)
);

ALTER TABLE telegram_known_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own telegram contacts"
  ON telegram_known_contacts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own telegram contacts"
  ON telegram_known_contacts FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_known_contacts_user
  ON telegram_known_contacts(user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_known_contacts_username
  ON telegram_known_contacts(user_id, telegram_username);

-- Registered Telegram groups
CREATE TABLE IF NOT EXISTS telegram_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id bigint NOT NULL,
  group_name text,
  is_forum boolean DEFAULT false,
  registered_at timestamptz DEFAULT now(),
  UNIQUE(user_id, telegram_chat_id)
);

ALTER TABLE telegram_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own telegram groups"
  ON telegram_groups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own telegram groups"
  ON telegram_groups FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_groups_user
  ON telegram_groups(user_id);

-- Add heartbeat channel preference to user_preferences
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS heartbeat_channel text DEFAULT 'whatsapp';
