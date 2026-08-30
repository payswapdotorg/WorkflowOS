# WORK-061 — Self-Hosting Conformance and Continuous Governance

Status: planned.

Objective: Prove that WorkflowOS can use its own governed engineering lifecycle to plan, execute, verify, review, release, observe, and maintain WorkflowOS without bypassing its architecture authority.

Dependencies: WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050, WORK-062, WORK-063.

Scope: self-hosting conformance suite, recursive governance checks, recovery/resumption proof, internal change exercises.

Required invariants: WorkflowOS implementation is governed as customer software; governing architecture cannot be self-modified without ACR/ArchitectureVersion approval; repository state remains sufficient for a fresh architect/worker; all internal changes use the same Work Item/Work Order/verification/review path.

Required proof: end-to-end self-hosting exercise, conversation-loss recovery, unauthorized architecture mutation rejection, multi-agent parallel implementation proof through the durable orchestration substrate (WORK-062: same-key convergence, idempotent retry, crash/restart reconciliation, lease takeover and stale-worker fencing), release/observation feedback loop proof, and the production identity experience (WORK-063: a human signs in, creates an organization, creates a project, invites a developer, and authorizes a scoped agent service account that runs governed work — with tenant isolation and privilege separation holding throughout).

Note: WORK-062 (Durable Multi-Agent Orchestration Substrate) is a dependency because self-hosting cannot honestly be considered complete without durable multi-agent execution and recovery — delegated multi-agent work must survive crashes, restarts, and coordinator loss under the same governed lifecycle. Issued by the 2026-08-30 governance correction.

Note: WORK-063 (Identity and Access Layer) is a dependency because the customer-facing self-hosting experience begins with a human signing in and ends with an authorized agent running governed work — neither is possible on a shared bootstrap demo key. Issued by the 2026-08-30 identity-and-access architecture decision; that dependency edge is now SATISFIED — WORK-063 is COMPLETE (merged by the architect as `8dac9c4` via PR #81 on 2026-08-30, spec-only: the architecture decision and this dependency-model correction; finalized per §34.8/ADR-0007). The runtime identity layer the WORK-063 Work Order specifies remains UNIMPLEMENTED future work under the architect's separate authorization; WORK-061's required proof will exercise it when that implementation lands. WORK-061 remains blocked on WORK-057/058/059/060 (the WORK-053..056 foundation chain) and is NOT activated.

Definition of done: a fresh WorkflowOS instance can reconstruct and safely continue its own development program from repository/GitHub state alone.
