# ADR-0003 — The parallel protocol is surface-declaration + deterministic conflict detection

Status: accepted (WORK-052)

## Context

Issue #61 requires a repository-native protocol under which multiple independent
implementation agents work concurrently: one Work Item per branch/PR, explicit dependency
eligibility, shared-authority/migration conflict detection, no worker altering another
Work Item's scope, centralized architecture decisions, PR review as the merge gate — all
without conversational state. Runtime DB coordination cannot fence git branches, and a
"central scheduler" would violate the no-giant-central-agent prohibition.

## Decision

The protocol is **git/PR-native and declaration-based**. Every work-order record in
`program-state.json` declares its change surfaces — modules, reserved migration numbers,
application-layer directories, spec documents, and shared integration surfaces (the
composition root `app.ts`, the static architecture suite, the migration-number pin).
Parallel eligibility is computed deterministically from the declared state:

- eligible ⇔ all declared dependencies are `complete`;
- two `in_flight` items sharing any declared surface ⇒ **conflict** reported (not
  parallel-safe without explicit architect coordination: documented merge order,
  reserved numbering, or sequencing);
- workers edit only their declared surfaces (scope integrity);
- decisions enter only through architect-issued Work Orders + ADRs;
  the architect's PR review is the only merge gate.

## Consequences

- Conflict detection is honest about what actually happened in this program: WORK-046
  and WORK-051 ran as `in_flight` items sharing the static-suite and composition
  surfaces and were coordinated by reserved migration numbering (0052–0056 vs 0057) —
  the protocol's declared-surface model captures exactly that case.
- No scheduler, no worker protocol daemon, no provider coupling: a stateless agent reads
  the work order + program state + ADRs and knows what it may touch.
- Enforcement of scope integrity remains social-plus-review (PR diff review) plus
  static invariants where structural; the protocol makes violations *visible*
  (surface declarations are diffable claims) rather than pretending to fence git.
- Migration numbering stays reserved per work order so both merge orders remain clean
  under the filename-ordered migration runner.
