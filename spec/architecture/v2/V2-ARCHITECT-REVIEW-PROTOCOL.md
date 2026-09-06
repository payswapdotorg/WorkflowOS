# WorkflowOS V2 — Architect Review Protocol

**Status:** GOVERNED
**Authority:** Architect-only review and merge authority
**Execution state:** `spec/development-state/v2-autonomous-execution-state.json`

## Purpose

Provide one reliable trigger for human Architect review while allowing the long-running Z.ai orchestrator to continue all independent implementation work without repeated user prompts.

## Review trigger

A Work Order becomes reviewable only when the orchestrator has produced a durable `READY_FOR_ARCHITECT_REVIEW` event for the same exact PR head SHA.

The event is valid only when:

| Condition | Required |
|---|---|
| Work Order implementation complete | Yes |
| Deterministic verification passing | Yes |
| Required dogfooding/equivalent conformance evidence persisted | Yes |
| Required real-browser evidence persisted for user-facing changes | Yes |
| PR branch synchronized against current `main` | Yes |
| No pending synchronization or repair work | Yes |
| Work Order scope unchanged | Yes |
| Frozen architecture/authority unchanged | Yes |

## GitHub emission contract

The **persistent Z.ai orchestrator is the emitter** of the review trigger. A local conversation, CI job, or user prompt is not the review notification mechanism.

Once every review prerequisite is satisfied for one exact PR head, Z.ai must publish the review event to the **GitHub PR conversation** for that same PR. The emission must happen immediately after final verification and must use the guarded repository helper:

```text
scripts/emit-architect-review-trigger.sh
```

The helper verifies that the PR is still open, targets `main`, and still has the exact expected head SHA before posting. It refuses to emit when the head has moved and de-duplicates an identical trigger for the same Work Order/head pair.

The GitHub comment must contain both:

1. the exact machine-readable review-event fields; and
2. the exact user-facing trigger line defined below.

Minimum emitted packet:

```yaml
workflowos_review_event: READY_FOR_ARCHITECT_REVIEW/v1
work_order: <WO>
pr: <N>
head_sha: <exact PR head>
base_sha: <exact current main>
verification: <passing result summary>
evidence:
  - <repository evidence path>
status: READY_FOR_ARCHITECT_REVIEW
```

The final visible trigger line is:

```text
ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>
```

An emitted GitHub comment is durable evidence that the orchestrator entered `AWAITING_ARCHITECT_REVIEW`; it does **not** grant approval, merge authority, or acceptance.

## Exact-head rule

The review request must identify:

- Work Order ID;
- PR number;
- exact PR head SHA;
- exact current `main` SHA;
- verification result;
- evidence locations; and
- `READY_FOR_ARCHITECT_REVIEW` status.

Any PR head change invalidates the request. A new request must be emitted after verification and synchronization complete again.

## User trigger

The only user-facing Architect review prompt is:

```text
ARCHITECT REVIEW: WorkflowOS PR #<N>, Work Order <WO>, head <SHA>
```

The canonical delivery surface for that prompt is the GitHub PR conversation, emitted by Z.ai. The user does not need to prompt for review during implementation, synchronization, test repair, or review waiting. A PR in `AWAITING_ARCHITECT_REVIEW` has already emitted its trigger.

## Review lifecycle

```text
IMPLEMENTING
    ↓
VERIFYING
    ↓
SYNCHRONIZING (only when main advanced)
    ↓
READY_FOR_ARCHITECT_REVIEW
    ↓
AWAITING_ARCHITECT_REVIEW
    ↓
┌───────────────┬─────────────────┐
│               │                 │
MERGED     CHANGES_REQUESTED   GOVERNANCE STOP
│               │                 │
↓               ↓                 ↓
COMPLETE   SAME PR REPAIR      ARCHITECT DECISION
                ↓
            REVERIFY
                ↓
            SYNCHRONIZE
                ↓
      READY_FOR_ARCHITECT_REVIEW
```

## No-rebase-tax rule

The user is never the synchronization mechanism. When another PR merges and advances `main`, the Z.ai orchestrator automatically refreshes every affected in-flight PR, reruns required verification, and updates its exact-head review state.

Mechanical conflicts may be resolved automatically only within the existing Work Order scope. Semantic, authority, or scope conflicts stop the packet and surface an Architect governance event.

## Review batching

Architect review may cover multiple independently ready PRs in one session, but each review decision remains explicitly associated with its Work Order and exact head SHA. One PR must never be considered accepted because another PR was reviewed or merged.

## Merge authority

Only the Architect may approve architecture, accept a Work Order, or merge its PR. The Z.ai orchestrator schedules, implements, verifies, synchronizes, records evidence, and presents review-ready packets; it does not merge.
