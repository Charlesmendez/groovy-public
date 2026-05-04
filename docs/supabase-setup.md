# Supabase setup for FLOW (Auth + Chat Persistence + Uploads)

This app uses Supabase for:
- Authentication (email/password)
- Postgres persistence (agents, chat sessions, messages)
- Storage uploads (`chat_uploads` bucket)
- Vector search via `pgvector` for document grounding

## 1) Create a Supabase project
- Create a project in Supabase
- Copy:
  - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
  - Anon public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 2) Configure Auth
- In Supabase Dashboard → **Authentication** → **Providers**
  - Enable **Email** (email/password)

## 3) Run the database migrations
Open Supabase Dashboard → **SQL Editor** and run migrations in order:
- `supabase/migrations/20260109000000_init_flow.sql`
- `supabase/migrations/20260109000001_devices_and_claude_code.sql`

This creates:
- `flags`, `agents`, `chat_sessions`, `chat_messages`
- `chat_attachments`, `chat_doc_chunks` (+ vector index)
- `match_chat_doc_chunks(...)` RPC for retrieval
- `chat_uploads` storage bucket + policies

And for Claude Code / local terminals:
- `devices`, `device_pairing_codes`, `device_workspaces`, `claude_code_agent_configs`

## 4) Set environment variables
Create `.env.local` in the repo root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...

# OpenAI (required for embeddings and also used by voice Realtime)
OPENAI_API_KEY=...

# Optional provider keys (required only if you select those providers/models)
ANTHROPIC_API_KEY=...
XAI_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

## 5) Start the app
```bash
npm run dev
```

Go to `/login`, create an account, then open the dashboard.

## Upload support (current)
The chat upload pipeline extracts text + embeds it for retrieval. Currently supported:
- PDF (`.pdf`)
- DOCX (`.docx`)
- Plain text / Markdown / CSV / JSON (`.txt`, `.md`, `.csv`, `.json`)

Images are not supported yet (can be added later for vision-capable models).

