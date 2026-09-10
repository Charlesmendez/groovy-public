-- Typing activity is intentionally ephemeral and has an expression-backed
-- uniqueness boundary rather than a primary key. Because the table is part of
-- supabase_realtime, PostgreSQL needs the full row as its replica identity
-- before direct deletes or FK cascades can be published.
alter table public.chat_typing_indicators replica identity full;
