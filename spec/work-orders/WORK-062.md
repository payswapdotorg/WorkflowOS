# WORK-062 — Durable Multi-Agent Orchestration Substrate

Status: planned.

Issued by: the 2026-08-30 governance correction (the execution-substrate
architecture decision). This Work Order establishes the next governed
capability — it does NOT implement runtime code. Activation requires the
architect's authorization and is recorded in
`spec/development-state/program-state.json` (this change records none).

Dependencies: WORK-046 (Multi-Agent Delegation — the delegation authority this
substrate sits underneath). Downstream: WORK-061 (Self-Hosting Conformance and
Continuous Governance) depends on this Work Order, because self-hosting cannot
honestly be considered complete without durable multi-agent execution and
recovery.

## Objective

Provide the durable orchestration substrate UNDERNEATH WORK-046 delegation so
that every delegated multi-agent execution is durable, convergent, and safely
recoverable — across crashes, restarts, coordinator loss, concurrent drivers,
and external (native/external) execution — WITHOUT becoming a second authority
of any kind.

WORK-046 already guarantees, inside one delegation plan: idempotent plan
identity (`(workItemId, planKey)`), one execution identity per attempt, a
crash-safe durable dispatch intent, the attempt-generation fence, and
recoverable partial completion. WORK-062 does NOT replace or weaken those
guarantees — it generalizes the layer underneath them: delegated executions
become durable units with leases/ownership, fencing, dependency-aware
scheduling, cross-restart reconciliation, and external execution convergence,
so that orchestration survives coordinator loss and still converges.

## The authority model (the execution-substrate decision)

WorkflowOS's architecture deliberately separates intelligence, delegation,
orchestration, execution, verification, and review:

```text
WORK-047
  ↓ recommendation
WORK-046
  ↓ governed delegation
WORK-062
  ↓ durable orchestration
Existing Execution Authority
  ↓
Verification
  ↓
Review
```

- WORK-047 (Agent Intelligence) is ADVISORY: it recommends; it never executes.
- WORK-046 (Multi-Agent Delegation) remains the ONE DELEGATION AUTHORITY: it
  governs which delegated executions exist, under which pinned roles,
  providers, and constraints.
- WORK-062 (this Work Order) is the DURABLE ORCHESTRATION SUBSTRATE
  underneath delegation: it makes each delegated execution durable,
  idempotent, lease-owned, fenced, reconcilable, and dependency-aware —
  native and external alike.
- The EXISTING execution authority (the existing `ExecutionService.submit()`
  boundary over the existing sessions/workspaces/providers) remains the ONE
  EXECUTION AUTHORITY. The substrate drives it; it never replaces it.
- Verification (`/verification`) and review (`/reviews`) remain the ONE
  verification/review authorities, unchanged.

The chain above is the RUNTIME authority/flow ordering — who recommends, who
governs delegation, who orchestrates durably, who executes, who verifies, who
reviews. It is NOT a restatement of build dependencies: the dependency edge is
WORK-046 → WORK-062 (the substrate is built underneath the delegation
authority), and WORK-047's recorded dependency on WORK-046 is unchanged.

## Substrate responsibilities

The substrate is responsible for:

1. **dependency-aware scheduling** — deciding when delegated work is admissible
   to start, from its durable dependency constraints;
2. **durable execution identity** — exactly one durable identity per delegated
   execution, stable across retries and reconciliation;
3. **idempotent retries** — re-driving the same logical work converges on ONE
   logical outcome (no duplicate logical execution);
4. **leases/ownership** — at most one active owner of a delegated execution at
   any time, even with concurrent coordinators;
5. **fencing** — stale owners/workers cannot mutate state after ownership
   takeover;
6. **crash/restart reconciliation** — durable state converges to the truth
   after any crash or restart (including the observe-or-resubmit decision);
7. **external execution convergence** — external side effects and in-flight
   external executions converge after crashes/restarts, never duplicate;
8. **partial completion** — partial progress is explicit, durable, and
   resumable;
9. **deterministic reconciliation** — the same durable state always reconciles
   to the same result (a total, documented order);
10. **safe dependency-aware parallelism** — independent nodes may execute in
    parallel while dependent nodes never do;
11. **simple/complex/very-complex execution shapes** — a single unit, a bounded
    multi-unit dependency DAG, and very large multi-wave plans with heavy
    partial failure all run under the SAME orchestration semantics.

Scheduling here is SEMANTICS (durable readiness, dependency enforcement,
admissible parallelism), not a silent autonomous scheduler: any background
drive is a governed implementation decision under the same stop-condition
discipline as WORK-046 (W046-AC12), never an unrequested timer/cron/loop.

## Explicit prohibitions

WORK-062 must NEVER become:

- a **second workflow engine** — no workflow states, no transitions, no Work
  Item lifecycle authority (`/workflows` stays the ONE workflow authority);
- a **second delegation authority** — delegation semantics (plans, units,
  roles, role pinning, plan identity) stay in WORK-046's governed surface;
- a **second execution authority** — execution stays in the existing
  `ExecutionService.submit()` boundary (exactly one submit call site, exactly
  as W046-AC03 requires);
- a **second verification authority** — evidence evaluation stays in
  `/verification`; review stays in `/reviews`;
- a **Redis-backed source of truth** — PostgreSQL remains the authoritative
  store; Redis remains a non-authoritative cache/coordination aid only.

## Required invariants

1. Intelligence never directly executes recommendations. (WORK-047 recommends;
   only the governed chain may act on them.)
2. WORK-046 remains the delegation authority. (The substrate orchestrates
   delegated executions; it never authors, redefines, or supersedes delegation
   semantics.)
3. Each delegated execution has one durable execution identity. (Stable across
   retries and reconciliation; referencing the EXISTING execution record.)
4. Duplicate logical submissions converge. (Same logical key → one logical
   execution and one logical outcome.)
5. Concurrent coordinators cannot obtain conflicting ownership. (Lease/ownership
   acquisition is exclusive per delegated execution.)
6. Stale workers cannot mutate state after fencing/takeover. (Every state
   mutation is ownership- and generation-fenced — the WORK-046
   attempt-generation-fence precedent generalized.)
7. External side effects converge after crashes/restarts. (Observe-or-resubmit
   with durable intent; never duplicate a logical external execution.)
8. Dependency constraints are enforced durably. (A dependent node cannot start
   until its dependencies' durable outcomes admit it — not in-memory only.)
9. Independent nodes may execute in parallel. (Parallelism is derived from the
   durable dependency graph, never suppressed by accident of design.)
10. Partial completion is explicit. (Partial state is recorded, observable, and
    resumable — never silently collapsed into success or failure.)
11. Replanning cannot erase durable evidence. (A new/revised plan cannot
    delete or rewrite the durable record of what was already executed,
    observed, or verified.)
12. Tenant isolation remains server-authoritative. (Project/tenant scoping is
    resolved and enforced server-side, exactly like the existing delegation
    and execution routes.)
13. PostgreSQL remains authoritative. (All durable orchestration state lives
    in PostgreSQL.)
14. Redis remains non-authoritative. (Redis may cache or coordinate but can be
    fully lost without losing or forking durable truth.)
15. Native and external execution share the same orchestration semantics.
   (Leases, fencing, retries, reconciliation, and dependency enforcement apply
    identically to both execution modes.)

## Required proof (verification obligations of the future implementation)

The future implementation must prove, with objective evidence:

1. **same-key concurrency** — concurrent submissions under the same logical key
   converge (real PostgreSQL, independent connections);
2. **idempotent retry** — retrying a completed/in-flight logical execution
   converges on the existing outcome instead of duplicating work;
3. **crash/restart recovery** — every crash window (before/after durable
   intent, before/after submission, before/after outcome) reconciles to the
   same truth;
4. **lease takeover** — ownership transfer after lease expiry/liveness loss is
   safe and exclusive;
5. **stale-worker fencing** — a fenced (stale) worker's state mutation is
   rejected (discrimination-proven against the unfenced behavior);
6. **dependency scheduling** — a node starts only when its durable dependency
   constraints are satisfied;
7. **safe parallel execution** — independent nodes run in parallel without
   interference or ordering dependence;
8. **dependency-violation rejection** — a node whose dependencies are not
   satisfied cannot be admitted (fail closed, typed error);
9. **external execution convergence** — an external execution interrupted by
   crash/restart converges (observed or safely resubmitted — never
   duplicated);
10. **partial completion** — a partially completed shape is explicit, durable,
    and resumable to completion;
11. **deterministic replanning** — replanning under the same durable state
    produces the same result and cannot erase durable evidence;
12. **real PostgreSQL concurrency** — the concurrency claims are proven on real
    PostgreSQL with independent connections (two-actor regressions), not
    single-connection simulations;
13. **mutation/discrimination tests** — the invariants are discriminating:
    mutating the substrate (removing the fence, the lease check, the
    dependency check, the idempotency key, or the tenant scope) makes the
    corresponding test FAIL.

## Scope

Allowed: the durable orchestration substrate beneath the delegation boundary —
durable execution identity, leases/ownership + fencing, dependency-aware
scheduling + safe parallelism, crash/restart reconciliation, external
execution convergence, explicit partial completion, deterministic
reconciliation; native AND external executions under one orchestration
semantic; simple/complex/very-complex execution shapes under that one
semantic; the required proofs above on real PostgreSQL.

Forbidden: everything in "Explicit prohibitions"; autonomous activation;
GitHub merge/CI authority; credential/secret storage; frontend UX; and — for
THIS change — any runtime implementation at all (this task delivers the Work
Order and the dependency-model correction only).

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a second workflow, delegation, execution, or verification authority;
- Redis (or any non-PostgreSQL store) as a source of truth;
- an autonomous scheduler not explicitly governed and authorized;
- tenant isolation moving to the client;
- erasing or rewriting durable evidence on replanning;
- changing the frozen architecture version.

## Definition of done

- All required invariants hold with objective evidence (the required proofs
  above, on real PostgreSQL, with mutation/discrimination tests).
- Static architecture invariants for the authority-boundary claims pass
  (including the no-second-authority matrix).
- Typecheck and lint clean; the full repository regression suite clean.
- PR contains only WORK-062 scope; independent Architect Review approves; the
  implementation PR is merged; WORK-062 is marked VERIFIED before WORK-061
  becomes eligible on it.
