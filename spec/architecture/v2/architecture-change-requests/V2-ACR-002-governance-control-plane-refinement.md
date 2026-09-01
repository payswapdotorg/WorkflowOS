# V2-ACR-002 — Governance Control-Plane Refinement

**Status:** PROPOSED / implementation-authorized governance evolution
**Scope:** V2 development governance and self-hosting control plane
**Precedence:** This record refines the V2 governance control model. It does not change the sole Architect merge authority, frozen V1 authority, WorkflowOS product semantics, or the universal workflow protocol.

## Problem

The V2 governance model correctly introduced repository-resident state, adaptive assurance, derived dependency/frontier/checkpoint projections, no-rebase parallelism, integration gates, and post-merge finalization. Operational experience showed that the remaining model still describes some derived information as if it were independently authoritative and still treats post-merge recording as a manual governance event.

That creates unnecessary state duplication and leaves avoidable reconciliation work after an Architect merge.

## Decision

### 1. Facts are authoritative; projections are derived

The development control plane has three classes of information:

1. **Authoritative facts** — Work Order intent and scope, architect decisions, verification/dogfooding evidence, and repository Git merge history.
2. **Operational state** — mutable implementation facts needed to resume in-flight work, such as branch, base SHA, PR binding, last verified SHA, unresolved findings and next mechanical action.
3. **Derived projections** — dependency eligibility, implementation frontier, checkpoint requirement/result summaries, and any equivalent readiness summaries.

`dependency-state.json`, `frontier-state.json`, and `checkpoint-state.json` are projections only. They are regenerated from authoritative facts and operational state; they are never independent authorities.

`nextEligible`, wave readiness, and similar navigation fields are projections as well. A stale projection must never override the underlying graph, Work Order state, Git evidence, or governed architecture decision.

### 2. Work Order completion remains an Architect decision, but merge recording is not a second decision

The Architect's merge is the sole completion event.

After a merge lands, the control plane MAY automatically or deterministically reconcile the canonical program state from authoritative Git evidence. Such reconciliation only records facts already established by the Architect's merge; it does not approve architecture, advance scope, create new authority, or choose whether the merge was correct.

The recorder MUST:

- bind completion to the actual merge evidence;
- preserve the Work Order's PR identity and actual merge commit;
- remove obsolete active-handoff/resumption state;
- leave unrelated findings untouched;
- fail closed when merge identity cannot be established unambiguously.

The Architect remains the only actor who can merge a Work Order, reopen it for new work, amend architectural scope, or authorize an architecture change.

### 3. A red reconciliation window is an enforcement window, not a governance ritual

If Git history proves that a Work Order merged but canonical state has not yet reconciled, the control plane MUST report a blocking inconsistency.

A reconciliation agent may close that bookkeeping gap using repository-resident facts. It MUST NOT convert the gap into a new approval step.

### 4. One dependency graph

The Work Order dependency graph is the single authoritative dependency graph.

Roadmap locks may constrain concurrency and composition, but may not introduce a competing dependency graph. Frontier and wave membership are derived from the Work Order graph plus roadmap constraints.

### 5. One state transition model

The canonical lifecycle remains:

```text
PLANNED → IN_FLIGHT → READY_FOR_MERGE → COMPLETE
```

with `BLOCKED` for rework/waiting.

The control plane MUST derive whether a state is internally consistent from authoritative facts. Redundant fields that merely restate eligibility or completion are projections and must not be used as alternate transition authority.

### 6. Assurance remains monotone

Assurance profiles continue to control only required verification depth. No projection, recorder, or automation may lower an assurance requirement or substitute evidence classes.

## Required invariants

- Git merge history is the authoritative source of whether the Architect performed the completion event.
- `mergedAs` is a durable identity binding, not an approval token.
- A persisted `complete` state whose `mergedAs` does not match authoritative Git evidence is invalid.
- A persisted `in_flight` state with authoritative merge evidence is invalid and must fail closed until reconciled.
- Derived projections cannot authorize implementation, merge, architecture change, or release.
- There is exactly one dependency graph.
- There is exactly one completion authority: the Architect's merge.
- Post-merge bookkeeping may be automated because it records an already-authoritative event; it may not make or infer a new semantic decision.
- Conversation memory is never an authoritative source.

## Non-goals

This refinement does not:

- add a second architect or reviewer;
- add a workflow engine;
- add a governance database;
- change V2 product semantics;
- replace the `/architecture`, `/work-items`, `/workflows`, `/verification`, `/reviews`, or `/github` authorities;
- permit self-hosted workers to merge their own PRs;
- weaken any V1 or V2 security, tenant, concurrency, idempotency, provenance, or evidence invariant.

## Migration

Existing repository-resident derived artifacts remain valid. Their role is clarified as projection state rather than independent authority. Existing post-merge finalization evidence remains covered by the merged-finalization invariant; future implementations may reconcile that state automatically from authoritative Git evidence without changing the completion semantics.
