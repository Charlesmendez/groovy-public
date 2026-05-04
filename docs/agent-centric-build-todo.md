# Agent-Centric Build Todo

This is the execution checklist for the agent-centric runtime migration.

## Phase 1 - Foundation (start now)

- [x] Add `agent_id` ownership to `scheduled_jobs` and index it.
- [x] Add heartbeat task support for `orchestrator_agent_id` (instead of session-only binding).
- [x] Wire orchestrator tool context to carry `orchestratorAgentId`.
- [x] Update schedule tool writes so new jobs persist `agent_id`.
- [x] Keep context compaction enabled, but scope it per agent runtime.
- [x] Keep durable memory in Datagran as the source of truth.

## Phase 2 - Branch Controller + Safety

- [x] Add Branch Controller settings (max branches, max turns/branch, mode `read_only|read_write`).
- [x] Enforce tool-level write gates by branch mode.
- [x] Add deterministic branch budget checks before tool execution.
- [x] Add branch telemetry (fork reason, merge/abort reason, budget limit hit).

## Phase 3 - Agent Runtime Graph

- [x] Add tables for agent epochs and branches.
- [x] Persist message lineage by `agent_id` + `epoch_id` + `branch_id`.
- [x] Add clear-conversation behavior as "rotate active epoch".
- [x] Keep per-agent compaction policy when rebuilding runtime context.

## Phase 4 - Skills Runtime

- [x] Add persistent skill registry (`draft|canary|stable|rollback` lifecycle).
- [x] Add versioned skill state scoped to agent/epoch/branch.
- [x] Dynamically inject active skill tools into orchestrator runtime.
- [x] Add safe rollback switch for bad skill versions.

## Phase 5 - Channels and Access

- [x] Move WhatsApp thread mapping to agent runtime identifiers.
- [x] Move scheduler execution and inbox command state to agent identifiers.
- [x] Add workspace + agent ACL model for invited users.
- [x] Ensure heartbeat runs under dedicated `heartbeat-system` agent.

## Phase 6 - Cutover

- [x] Remove session-first API assumptions from frontend orchestrator UX.
- [x] Replace session UX with agent-first UX and clear-conversation control.
- [x] Remove legacy session-only write paths after migration backfill.
- [x] Add migration verifier checks before final cleanup.
