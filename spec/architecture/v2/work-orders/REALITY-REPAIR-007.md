# REALITY-REPAIR-007 — User-Facing Run Lifecycle Controls

**Status:** AUTHORIZED — sequential after REALITY-REPAIR-003
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-008 ACCEPT

## Objective
Close the human run-control loop by exposing the already-implemented V2-005 lifecycle commands through the product UX.

## Scope
Add user-facing controls appropriate to current run state, minimally including:
- **Approve / Resume** for runs waiting on a human approval gate, implemented through the existing V2-005 `resume` command/envelope.
- **Pause** where the current run state permits safe pause.
- **Cancel / Stop** where the current run state permits cancellation.

The UI must not invent a separate approval authority. “Approve” is a user-facing label for the existing resume-with-human-confirmation semantics unless current V2-005 contracts demonstrate a distinct command already exists.

## Non-goals
No new approval route, workflow state machine, execution authority, or command semantics. Do not alter V2-005 lifecycle rules.

## Required evidence
- Fresh branch from the merged REALITY-REPAIR-003 head.
- Browser proof of a run reaching a waiting-for-user/approval state, then user action returning it to execution.
- Browser proof of safe cancel/pause where applicable.
- Idempotency and forbidden-transition behavior remain enforced by V2-005 command envelopes.
- Existing run/start/recovery/failure journeys remain green.
- Deterministic tests plus real browser proof.

## Completion
Architect merge only after exact-head verification. Do not start before REALITY-REPAIR-003 is merged.
