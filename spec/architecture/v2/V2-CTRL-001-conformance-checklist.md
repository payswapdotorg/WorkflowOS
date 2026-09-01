# V2-CTRL-001 — Implementation Conformance Checklist

**Status:** REQUIRED CONTROL ARTIFACT

Every V2 implementation agent MUST read, apply, and truthfully satisfy this checklist before opening a PR. It is a control artifact, not a product capability.

## Pre-implementation

- [ ] Read `spec/architecture/v2/architecture-constitution.md`.
- [ ] Read `spec/architecture/v2/execution-control-plane.md`.
- [ ] Read `spec/architecture/v2/dogfooding-protocol.md`.
- [ ] Read `spec/development-state/v2-work-order-state.json`.
- [ ] Read the assigned Work Order.
- [ ] Verify current `main` SHA from GitHub.
- [ ] Verify every hard dependency is actually COMPLETE.
- [ ] Verify every `contract` dependency is available from merged/frozen state.
- [ ] Verify no sibling parallel branch is being used as a base.
- [ ] Record the exact change surface and exclusions before coding.

## Architecture invariants

- [ ] Workflow is the durable repository identity.
- [ ] WorkflowVersion is immutable and addressable.
- [ ] WorkflowIR is the semantic source of truth.
- [ ] Teaching traces, recordings, prompts, compiled artifacts and marketplace listings are not WorkflowIR.
- [ ] Web, desktop, iOS, Android and cloud use the same protocol semantics.
- [ ] Platform differences appear only through advertised capabilities, permissions, UX, lifecycle and placement availability.
- [ ] Capability possession is not authorization.
- [ ] Placement/locality/privacy constraints remain explicit.
- [ ] Deterministic/API, agentic/computer-use, human, and subworkflow execution remain distinct classes.
- [ ] Model assertions do not become side-effect evidence.
- [ ] Every execution is pinned to an immutable WorkflowVersion.
- [ ] Marketplace entitlement never becomes execution authority.
- [ ] Publisher maintenance cannot silently mutate an installed version.
- [ ] Self-hosting cannot bypass the same protocol/policy/governance boundaries.
- [ ] V1 authority is not silently rewritten or replaced.

## Implementation

- [ ] No second workflow protocol introduced.
- [ ] No second workflow engine introduced.
- [ ] No platform-specific workflow semantics introduced.
- [ ] No second source of truth introduced for an existing V2 concept.
- [ ] Secret material is never stored in workflow definitions, ordinary protocol payloads or marketplace metadata.
- [ ] Authorization and capability checks occur at the appropriate runtime boundary.
- [ ] Cross-process state uses explicit durable semantics where claimed.
- [ ] Event-triggered actions are idempotent where duplicate delivery is possible.
- [ ] Failure states are explicit and fail closed where authority is unavailable.

## Verification

- [ ] Deterministic unit/contract tests added or updated.
- [ ] Discrimination/mutation tests prove the key invariant is load-bearing.
- [ ] Real-system integration tests run when the Work Order requires them.
- [ ] Concurrency/crash testing exists for cross-process or durable claims.
- [ ] Security/authorization tests cover negative cases.
- [ ] Exact final-head verification rerun after the final evidence/documentation change.

## Dogfooding

- [ ] Feature is exercised through the real supported product path.
- [ ] The experiment is performed immediately after the capability is executable.
- [ ] Evidence records exact version/surface/task/expected/observed/result.
- [ ] Unsafe operations use isolated resources or explicit confirmation.
- [ ] Findings are preserved even when negative.
- [ ] Contract-relevant failures block dependent work.
- [ ] Unrelated findings become separate corrective work rather than drive-by fixes.

## PR / completion

- [ ] PR starts from a stable base and contains only its declared scope.
- [ ] Parallel siblings remain independently mergeable.
- [ ] CI is verified on the exact PR head.
- [ ] PR body identifies exact base/head and verification evidence.
- [ ] Work Order state remains accurate: do not mark COMPLETE before actual merge evidence.
- [ ] After merge, finalization uses the real merge SHA.
- [ ] The next eligible wave is derived from canonical state, not from conversation memory.

## Stop conditions

An implementation agent MUST stop and escalate through a governed architecture change when:

- a frozen V2 concept must be reinterpreted;
- two authoritative surfaces cannot be made independently mergeable without semantic compromise;
- a Work Order's stated safety invariant cannot be proven;
- a platform capability required by the protocol cannot be honestly represented;
- durable semantics are claimed but the actual composed adapter is not durable;
- dogfooding reveals a contract-level product failure outside the Work Order's scope;
- implementation would require silently reviving deferred V1 work.
