# Live Feature Plan

Live is a full-screen, user-specific canvas at `/live`. The canvas is an
agent-written HTML document rendered in a sandboxed iframe. Each turn replaces
the canvas and updates a private markdown wiki that gives future turns memory.

## Goals

- Give the user one persistent, personal interface instead of a chat transcript.
- Store durable user/project context in a private per-user markdown wiki.
- Let the model reshape the visible HTML canvas on every turn.
- Keep all canvas interactivity form-based; no JavaScript runs in the iframe.
- Keep prior canvas versions in an append-only revision table.

## Data Model

- Supabase Storage bucket `wiki`, private.
- Supabase Storage bucket `wiki_raw_sources`, private and append-only from the
  app path.
- Object layout:
  - `{user_id}/schema.md`
  - `{user_id}/index.md`
  - `{user_id}/log.md`
  - `{user_id}/ui/canvas.html`
  - `{user_id}/entities/*.md`
  - `{user_id}/concepts/*.md`
  - `{user_id}/projects/*.md`
  - `{user_id}/sources/*.md`
- Postgres table `public.user_canvas_revisions` stores bounded canvas history.

## Request Flow

1. `/live` authenticates with the Supabase cookie session.
2. The server bootstraps missing wiki files and embeds the current canvas in a
   sandboxed iframe.
3. The canvas posts forms to `/api/live/turn`.
4. The turn route validates auth, CSRF signals, intent, text, and extra fields.
5. The turn route streams a plain-text progress page that reports concrete
   steps such as reading the wiki, asking the orchestrator, running tools,
   drafting the canvas, repairing HTML, and writing wiki files.
6. Live runs a normal orchestrator tool/context pass for the user's request and
   includes that result in the canvas prompt.
7. `runLiveTurn` asks the model for a new HTML document during that same
   request, validates it, and
   automatically asks for one repair if the HTML is blank, structurally broken,
   missing a Live form, hidden by root CSS, or damaged by sanitization.
8. When the final canvas is saved, the progress response renders that canvas
   inline in the same iframe so the user does not get stuck on the status page.
9. For `ingest_source`, the server writes an immutable raw source record before
   the model updates the wiki.
10. The route returns only validated/sanitized HTML. If repair also fails, it
   returns a deterministic retry canvas instead of a blank page.
11. The server stores the final canvas and records a canvas revision.
12. A second model pass updates wiki files and appends a log entry when the turn
   produced a valid model canvas.

## Safety Constraints

- The iframe allows forms and same-origin cookies, but not scripts.
- The initial `srcDoc` gets a CSP meta tag; turn responses get a CSP header.
- Persisted canvas HTML is sanitized before storage and before initial render.
- Model HTML is validated before the user sees it; failed output gets one
  model repair attempt with the exact validation errors.
- Loading/progress UI is streamed plain HTML/CSS and uses meta refresh, not
  scripts.
- Live uses the normal orchestrator runtime as a tool/context prepass before
  the model writes the canvas. Server-side tools run directly, and
  connector-backed tools continue through the existing relay RPC when an owned
  connector device is available.
- Canvas forms must stay same-origin.
- URL attributes are constrained; off-origin active resources are blocked.
- Wiki paths are allowlisted and must be user-relative.
- Wiki file size and canvas output size are bounded.

## Current Implementation

- Route: `src/app/live/page.tsx`
- Turn API: `src/app/api/live/turn/route.ts`
- Turn runner: `src/lib/live/turn.ts`
- Wiki client/path guards: `src/lib/live/wiki/*`
- Raw source storage: `src/lib/live/wiki/rawSources.ts`
- Canvas seed/sanitizer/revisions: `src/lib/live/canvas/*`
- Prompts: `src/lib/live/prompts/*`
- Migration: `supabase/migrations/20260510010000_live_canvas.sql`

## Follow-Up Gaps

- Add a navigation entry or feature flag gate when Live is ready for users.
- Add focused unit tests for sanitizer/path guards.
- Add source-ingest UI affordances beyond model-generated forms.
- Add a richer wiki lint operation that can safely propose/apply batches.
- Add a UI affordance for revision rollback.
- Decide whether Live should require an active license or specific plan flag.
