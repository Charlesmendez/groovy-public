# Handshake: Agent-to-Agent Communication

## Concept

"Handshake" is a user-initiated agent-to-agent communication feature, exclusive to the **multi-agent view**. The user explicitly connects two panes (sessions) together and instructs them to collaborate. Each pane continues to show its own thinking process and activities as it does today, but a new **shared handshake thread** appears inline inside both panes — showing what one agent said to the other and what it received back.

---

## UX Design: "The Handshake"

### Initiating a Handshake

**Drag-to-connect**: In the multi-agent grid, the user hovers a pane header to reveal a small **link icon** (a chain link / handshake icon). They **drag from one pane's link icon to another pane** — a glowing animated beam follows the cursor. When they drop on the target pane, both panes light up with a matching colored border pulse, and a **handshake banner** appears at the top of both panes showing:

```
🤝 Connected to: [Pane B name] — Type an instruction to collaborate
```

**Alternative (keyboard/mobile)**: Right-click a pane header → "Connect to..." → dropdown of other open panes. Or a small "Connect" button in the pane header dropdown.

### The Handshake State

Once two panes are connected:

1. **Both pane borders** gain a subtle **shared accent glow** — a warm orange/amber pulse (`orange-500/30`) that is distinct from any single-agent color. This immediately communicates "these two are linked."

2. **A thin connection line** is drawn as an SVG overlay between the two pane tiles in the grid — a dotted animated line (like data flowing between them). This line persists as long as the handshake is active.

3. **Handshake banner** appears pinned at the top of both panes' message areas:
   - Shows the partner pane's name and a small avatar/icon of the partner's dominant agent
   - A "Disconnect" button (X) to break the handshake
   - Status indicator: `idle` / `collaborating` / `waiting for response`

### Sending a Handshake Message

The user types in **either pane's input**. The message is sent to that pane's orchestrator session as usual, but with additional context injected:

- The system prompt gets an addendum: *"You are in a handshake collaboration with [Partner Agent]. You can send messages to them using the `handshake_send` tool, and you will receive their responses. Collaborate as instructed by the user."*
- A new tool `handshake_send` becomes available: sends a message to the partner pane's session and waits for the response.
- A new tool `handshake_receive` is implicitly handled: when pane B's session receives a handshake message from pane A, it processes it and returns a response.

### How It Looks in the UI

Inside each pane's message list, handshake messages get a **special visual treatment**:

```
┌─────────────────────────────────────────┐
│  ← From: Research Pane                  │  (incoming handshake message)
│  ┌─────────────────────────────────┐    │
│  │ "Here are the 5 URLs I found    │    │  Rendered with a left-border
│  │  for competitor analysis..."    │    │  accent in orange-500 and a
│  └─────────────────────────────────┘    │  subtle bg-orange-500/5
│                                         │
│  → To: Research Pane                    │  (outgoing handshake message)
│  ┌─────────────────────────────────┐    │
│  │ "Thanks, I'll now generate a    │    │  Rendered with a right-border
│  │  report comparing these..."     │    │  accent in orange-500
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

- **Incoming** handshake messages: left-aligned with orange left-border, labeled "← From: [Partner]"
- **Outgoing** handshake messages: right-aligned with orange right-border, labeled "→ To: [Partner]"
- These appear **inline** in the normal message flow, interleaved with the pane's own thinking/activities

### The Agent Activity During Handshake

When a pane is waiting for the partner's response, its activity strip shows:

```
🤝 Handshake  •  Waiting for [Partner name]...  (pulsing orange dot)
```

When the response arrives, it completes:

```
✓ Handshake  •  Received response from [Partner name]  (checkmark, orange)
```

### Disconnecting

Click the X on the handshake banner, or right-click → "Disconnect". Both panes lose the shared glow, the SVG line disappears, and the `handshake_send` tool is removed from the system prompt. Previous handshake messages remain visible in history with a faded treatment.

---

## Technical Architecture

### Phase 1: Database — Handshake Sessions Table

**New migration**: `20260301000000_handshake_sessions.sql`

```sql
create table if not exists public.handshake_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pane_a_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  pane_b_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  status text not null default 'active',  -- 'active' | 'closed'
  metadata jsonb null,
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint handshake_sessions_status_check check (status in ('active', 'closed')),
  constraint handshake_sessions_unique_pair unique (pane_a_session_id, pane_b_session_id)
);

-- Indexes + RLS policies (own-user only, matching existing patterns)
```

**New table**: `handshake_messages` — stores the inter-agent messages for replay/history:

```sql
create table if not exists public.handshake_messages (
  id uuid primary key default gen_random_uuid(),
  handshake_id uuid not null references public.handshake_sessions(id) on delete cascade,
  from_session_id uuid not null,
  to_session_id uuid not null,
  content text not null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);
```

### Phase 2: API Routes

**`POST /api/handshake`** — Create a handshake session
- Body: `{ paneASessionId, paneBSessionId }`
- Returns: `{ handshakeId, status: 'active' }`

**`DELETE /api/handshake/[id]`** — Close a handshake session
- Sets status to 'closed', sets closed_at

**`GET /api/handshake?sessionId=xxx`** — Get active handshakes for a session
- Returns active handshake sessions involving this session ID

**`POST /api/handshake/[id]/send`** — Send a message through the handshake
- Body: `{ fromSessionId, content, metadata? }`
- This is the core: it persists the handshake message, then triggers an orchestrator call on the target session with the handshake context injected
- Returns the partner's response (or streams it)

### Phase 3: Orchestrator Integration

#### 3a. New Tool: `handshake_send`

**In `executableTools.ts`**:

```typescript
export const handshakeSendSchema = z.object({
  message: z.string().describe("The message to send to the connected agent"),
  context: z.string().optional().describe("Optional context/data to share"),
});
```

**In `tools.ts`**: Map `handshake_send` → agent type `"handshake"` (new)

**In `toolExecutor.ts`**: Execute by POSTing to `/api/handshake/[id]/send`, which triggers the partner session's orchestrator and returns the response.

#### 3b. System Prompt Injection

**In `router.ts` `buildSystemPrompt()`**: When a handshake is active, append:

```
## Active Handshake
You are connected to another agent session: "[Partner session title]".
You have a `handshake_send` tool available. Use it when you need to:
- Ask the partner agent for information or help
- Send results to the partner agent
- Collaborate on the user's request

The partner agent may also send you messages — these will appear as tool inputs.
Always acknowledge received handshake messages and act on them as instructed.
```

#### 3c. Conditional Tool Availability

The `handshake_send` tool is only registered in `createExecutableTools()` when:
- `context.activeHandshakeId` is set (passed from the API route)
- `context.handshakePartnerSessionId` is set

This means the tool **only appears** when there's an active handshake — clean and non-polluting.

### Phase 4: Client-Side State (`useMultiAgent.ts`)

#### 4a. New State

```typescript
// Active handshakes: Map<paneId, HandshakeState>
type HandshakeState = {
  handshakeId: string;
  partnerPaneId: string;
  partnerSessionId: string;
  partnerName: string;
  status: 'active' | 'collaborating' | 'waiting' | 'closed';
};
```

Add to the `useMultiAgent` hook:
- `handshakes: Map<string, HandshakeState>`
- `connectPanes(paneAId: string, paneBId: string): Promise<void>` — calls POST /api/handshake
- `disconnectHandshake(paneId: string): Promise<void>` — calls DELETE /api/handshake/[id]
- `getHandshakeForPane(paneId: string): HandshakeState | null`

#### 4b. Enriched `sendPaneMessage`

When sending from a pane that has an active handshake, pass `handshakeId` and `partnerSessionId` in the send options so the orchestrator API route knows to inject the handshake system prompt and register the `handshake_send` tool.

### Phase 5: UI Components

#### 5a. `HandshakeConnector.tsx` — SVG Overlay

A component rendered as a portal over the `AgentGrid`. It:
- Listens to active handshakes from `useMultiAgent`
- Uses `getBoundingClientRect()` on both pane DOM elements
- Draws an SVG `<line>` or `<path>` between them with:
  - Animated dash-offset (flowing dots)
  - Orange-500 color, opacity 0.4
  - Pulse animation when data is flowing
- During drag-to-connect: draws a temporary beam from source pane to cursor

#### 5b. `HandshakeBanner.tsx` — Pane Banner

Rendered inside `AgentTilePane.tsx` between the header and message area:
- Orange-500/10 background, orange-500/30 border
- Shows: handshake icon + "Connected to: [name]" + status badge + disconnect X
- Compact: 32px height, doesn't eat into message space

#### 5c. `HandshakeMessage.tsx` — Inline Message Bubble

A new message variant in `MessageList.tsx`:
- Detected by `message.metadata?.handshake === true`
- Incoming: left orange border, "← From: [partner]" label
- Outgoing: right orange border, "→ To: [partner]" label
- Subtle `bg-orange-500/5` background to distinguish from normal messages

#### 5d. `HandshakeDragHandle.tsx` — Pane Header Link Icon

Small icon in each pane's header (only in multi-view):
- Chain link icon, `w-3.5 h-3.5`, `text-zinc-500` normally
- On hover: `text-orange-400` with tooltip "Drag to connect"
- Implements HTML5 drag with custom drag image (glowing dot)
- Drop target: other panes' headers light up orange when dragged over

### Phase 6: Activity & SSE Events

#### 6a. New SSE Event Type: `handshake`

```typescript
{
  type: "handshake";
  handshakeId: string;
  action: "send" | "receive" | "waiting" | "complete";
  partnerSessionId: string;
  content?: string;
  metadata?: unknown;
}
```

#### 6b. New Activity Agent Type

Add `"handshake"` to `ActivityAgentType`:

```typescript
export type ActivityAgentType = AgentType | "memory" | "system" | "handshake";
```

**Color**: orange-400 / orange-500/10 / orange-500/30 (consistent with the handshake theme)

**Icon**: `Handshake` from lucide-react (or `Link2` as fallback)

---

## Implementation Order

1. **Database migration** — handshake_sessions + handshake_messages tables
2. **API routes** — /api/handshake CRUD + /api/handshake/[id]/send
3. **Orchestrator tool** — handshake_send schema, tool definition, executor
4. **System prompt injection** — conditional handshake context in buildSystemPrompt
5. **Client state** — useMultiAgent handshake state + connectPanes/disconnectPanes
6. **UI: HandshakeBanner** — the banner inside panes (simplest visual first)
7. **UI: HandshakeMessage** — inline message rendering with orange treatment
8. **UI: HandshakeDragHandle** — drag-to-connect interaction
9. **UI: HandshakeConnector** — SVG connection lines between panes
10. **SSE events** — handshake activity events + activity strip integration
11. **Polish** — animations, edge cases, disconnection cleanup, error handling

---

## Design Principles

- **Orange is the handshake color**: Distinct from all existing agent colors (cyan, amber, indigo, violet, emerald, rose, blue, lime). Orange-500 is the accent.
- **Inline, not modal**: Handshake messages live inside the existing message flow — no popups or separate windows.
- **Visible connection**: The SVG line between panes makes the relationship spatial and obvious.
- **Non-intrusive**: When no handshake is active, zero UI changes. The drag handle is subtle.
- **User-controlled**: Only the user initiates and terminates handshakes. Agents cannot auto-connect.
- **Fits existing patterns**: Uses the same tool definition → executor → SSE → activity pipeline as every other agent.
