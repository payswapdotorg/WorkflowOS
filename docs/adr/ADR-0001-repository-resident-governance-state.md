# ADR-0001 — The development-governance state is repository-resident

Status: accepted (WORK-052)

## Context

WORK-052 (Issue #61) requires a canonical development state — active architecture
version, Work Orders, dependency DAG, frontier, checkpoint definitions and outcomes,
durable decisions, handoff/resumption data — such that a fresh checkout reconstructs the
architecture program without conversational history. The obvious implementation choices
were (a) new PostgreSQL tables in a governance module, (b) an HTTP control-plane API over
that data, or (c) machine-readable artifacts in the repository consumed by an
application-layer service.

## Decision

The canonical development-governance state is **repository-resident**:
`spec/development-state/governance-model.json` (the model) and
`spec/development-state/program-state.json` (the program state), validated and queried by
the application-layer capability `backend/src/development-governance/` and surfaced by
the `governance:status` CLI. WORK-052 adds **no database tables, no migrations, and no
HTTP API route** for the control plane.

## Consequences

- The repository — already the authority for architecture spec, work orders, and code —
  is also the authority for program state; conversation loss cannot lose the program.
- Concurrent workers maintain program state per the protocol (one branch per Work Item;
  the architect merges), so git/PR review — the existing merge gate — arbitrates all
  state evolution; no second writer authority is needed.
- PostgreSQL remains untouched in its role: the authority for TENANT runtime state
  (workflow, verification, evidence, assertions). No duplicate-authority surface is
  created; the "no chat-dependent state" prohibition is satisfied structurally.
- The control-plane service is a pure function of repository files: deterministic,
  testable against the real artifacts, with fail-closed validation.
- Deferred deliberately (explicit deferral in the PR): an HTTP API surface for the
  control plane, and automation that syncs program-state.json from live PR/CI state.
  Both are separate decisions with their own authority questions (tenant surface,
  write path); the work order's stop-condition discipline requires they not be smuggled
  in here.
