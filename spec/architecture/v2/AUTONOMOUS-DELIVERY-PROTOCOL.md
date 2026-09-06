# WorkflowOS V2 — Autonomous Delivery Protocol

**Status:** GOVERNED
**Purpose:** make the remaining V2 roadmap executable by one long-running Z.ai orchestration task while preserving a single Architect authority.

## Operating model

One persistent orchestrator may launch disposable implementation, verification, browser, investigation, and PR-repair agents. Agents are workers, not governance authorities.

The repository and GitHub are the durable state machine. The Architect alone may accept architecture, request/resolve scope, and merge PRs.

## Work packet requirements

Every implementation Work Order must define:

- unique Work Order ID;
- exact objective and bounded change surface;
- explicit dependencies and dependency type;
- parallelism class (`SERIAL`, `PARALLEL_AFTER_DEPENDENCIES`, or `GATE`);
- forbidden scope / non-goals;
- implementation acceptance criteria;
- deterministic verification;
- real-system/browser evidence where applicable;
- exact-head requirements;
- completion authority (actual Architect merge);
- downstream Work Orders unlocked by merge.

## Orchestrator rules

1. Read the current machine state before selecting work.
2. Never start a Work Order whose implementation dependency is not COMPLETE.
3. Multiple Work Orders may execute concurrently only when their change surfaces are disjoint and their declared dependencies are satisfied.
4. Each Work Order gets a fresh branch from the exact current base required by its packet.
5. Each Work Order creates one PR and one durable evidence record.
6. A PR waiting for Architect review does not prevent independent eligible Work Orders from continuing.
7. Architect review feedback is handled by a disposable repair agent on the same PR branch; no competing PR is created.
8. A failed verification blocks that Work Order only unless its failure reveals a shared architectural defect.
9. Merges are the only completion authority.
10. After every merge, the orchestrator re-reads machine state and recomputes eligibility.
11. No agent may change frozen V2 semantics or introduce a new authority without explicit Architect authorization.
12. Deployment is not considered complete until the final production acceptance Work Order is merged and the production revision/evidence are recorded.

## Recommended execution behavior

Use the maximum safe parallelism exposed by the dependency graph. Keep provider-specific infrastructure changes isolated so a failure in one provider slice does not invalidate unrelated slices.

The orchestrator should maintain durable status only through repository/GitHub state; local task memory is disposable.
