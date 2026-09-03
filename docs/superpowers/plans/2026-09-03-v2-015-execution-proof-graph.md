# V2-015 Execution Proof Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the frozen V2-015 Execution Proof Graph and Trust-Minimized Coordination domain on main `493da4c82ba70d4a104e97559dc54192297792d2`, composing merged V2-014 attestations, V2-005 Run/evidence identity, V2-008 cross-host execution, and V2-009 placement/events without introducing a second workflow, execution, authorization, or verification authority.

**Architecture:** Add a focused proof-graph domain whose durable facts are attestations and stable Run/WorkflowVersion identities, while V2-014 remains the sole cryptographic verification authority, V2-005 remains the Run/evidence persistence authority, and V2-003 remains the WorkflowIR authority. Keep graph construction/admission deterministic, append-only, replay-safe, multi-parent capable, and explicit about trust, assurance, capability, authorization, placement, freshness, and verification.

**Tech Stack:** TypeScript strict, Bun/Vitest, existing WorkflowOS domain-module conventions, PostgreSQL/PGlite only where an existing persistence seam is required, Node builtin cryptography through V2-014 public APIs.

**Spec:** `spec/architecture/v2/work-orders/V2-015.md`

## Global Constraints

- Start from exact merged `main`: `493da4c82ba70d4a104e97559dc54192297792d2`.
- Parallel-no-rebase with V2-012; never consume its unmerged branch.
- V2-014 remains the only cryptographic verification authority; consume `VerifiedExecutionFact` and public verification APIs only.
- V2-005 remains the only Run/evidence persistence authority.
- V2-003 remains the only WorkflowIR/workflow dependency authority.
- V2-009 remains the events/scheduling/placement authority.
- Do not add a second workflow graph, execution engine, authorization engine, or verifier.
- Do not add blockchain/transparency infrastructure, mandatory hardware attestation, or mandatory ZK/TEE requirements.
- Graph evidence is append-only: no prior verified execution fact may be erased or rewritten.
- Every admission decision must preserve separate dimensions for node identity, capability, authorization, placement, assurance, freshness, and verification.
- Critical graph-integrity and admission rules require deterministic mutation/discrimination tests.
- Completion requires deterministic verification, real cryptographic verification in an independent verifier context, two-host dogfooding, architect review/merge, merge evidence, and post-merge finalization.

---

### Task 1: Repository archaeology and proof-graph boundary map

**Files:**
- Inspect only initially: `backend/src/execution-attestation/index.ts`, `backend/src/execution-attestation/types.ts`, `backend/src/computer-agent/index.ts`, `backend/src/computer-agent/types.ts`, the V2-005 Run service/public barrel, V2-009 placement/event public barrel, relevant persistence/repository modules, and neighboring domain tests.
- Create: `backend/src/execution-proof-graph/index.ts`
- Create: `backend/src/execution-proof-graph/types.ts`
- Create: `backend/src/execution-proof-graph/internal/validation.ts`
- Test: `backend/tests/architecture/execution-proof-graph-boundary.test.ts`

**Interfaces:**
- Consumes: only merged public contracts discovered during the audit.
- Produces: an explicit module boundary proving the new module can consume V2-014/V2-005/V2-008/V2-009 through public surfaces without importing private internals.

- [ ] **Step 1: Inventory the merged public contracts.**
Run from `backend/`:
```bash
bunx vitest run tests/architecture
rg "export .*VerifiedExecutionFact|VerifiedExecutionFact|WorkflowRun|WorkflowVersion|placement|authorization|capability" src backend/tests
```
Record exact import specifiers and exported types before writing graph code.

- [ ] **Step 2: Write boundary tests that fail on forbidden coupling.**
The boundary battery must reject imports from private V2-014/V2-005/V2-008/V2-009 internals and reject proof-graph imports from V2-003/V2-014 that would create a competing authority. It must also pin that the graph module has no route or migration requirement unless a later audited seam proves one is required by the frozen work order.

- [ ] **Step 3: Define the minimal graph types.**
Define explicit types for graph identity, graph node, causal/dependency edge, admission predicate input/result, trust-policy input, and graph mutation error. Every node must carry stable attestation/execution identity plus Run/WorkflowVersion binding; every edge must name its relation and deterministic parent ordering.

- [ ] **Step 4: Implement pure structural validation.**
`internal/validation.ts` validates identity, required references, deterministic ordering, edge/node binding, append-only constraints, and duplicate semantics. It must not verify signatures, mutate persistence, authorize actions, or evaluate placement.

- [ ] **Step 5: Run the architecture boundary battery and commit.**
```bash
bunx vitest run tests/architecture/execution-proof-graph-boundary.test.ts
```
Expected: all new boundary tests PASS; no existing architecture regressions.

```bash
git add backend/src/execution-proof-graph backend/tests/architecture/execution-proof-graph-boundary.test.ts
git commit -m "feat(v2-015): establish execution proof graph boundary"
```

### Task 2: Deterministic graph construction and serialization

**Files:**
- Create/modify: `backend/src/execution-proof-graph/types.ts`
- Create: `backend/src/execution-proof-graph/internal/graph.ts`
- Create: `backend/src/execution-proof-graph/internal/serialization.ts`
- Modify: `backend/src/execution-proof-graph/index.ts`
- Test: `backend/tests/unit/execution-proof-graph/graph.test.ts`
- Test: `backend/tests/unit/execution-proof-graph/serialization.test.ts`

**Interfaces:**
- Consumes: `ExecutionAttestation`, `VerifiedExecutionFact`, stable Run/WorkflowVersion identifiers from merged public APIs.
- Produces: `ExecutionProofGraph`, deterministic `addNode`, deterministic `addEdge`, stable serialization/deserialization, and typed graph-integrity failures.

- [ ] **Step 1: Write red tests for node identity and stable serialization.**
Prove the same valid attestation yields one logical node identity, serialization is byte-deterministic, and a changed canonical attestation identity cannot silently map to the old node.

- [ ] **Step 2: Write red tests for deterministic edge ordering and acyclicity.**
Cover causal and dependency edges, deterministic parent ordering, missing-node rejection, self-edge rejection, direct-cycle rejection, and multi-hop cycle rejection.

- [ ] **Step 3: Implement pure graph construction.**
Graph construction must accept only validated facts, maintain deterministic ordered collections, reject conflicting node redefinition, and never mutate an existing verified fact. No network, clock, random, crypto, or external persistence is allowed in the pure graph core.

- [ ] **Step 4: Implement canonical graph serialization.**
Use the repository's existing canonical-JSON discipline where available. Serialization must include schema/version identity and all integrity-critical fields, with deterministic ordering of nodes, edges, and parent lists.

- [ ] **Step 5: Run targeted tests twice and commit.**
```bash
bunx vitest run tests/unit/execution-proof-graph/graph.test.ts tests/unit/execution-proof-graph/serialization.test.ts
bunx vitest run tests/unit/execution-proof-graph/graph.test.ts tests/unit/execution-proof-graph/serialization.test.ts
```
Expected: identical PASS results on both runs.

```bash
git add backend/src/execution-proof-graph backend/tests/unit/execution-proof-graph
git commit -m "feat(v2-015): add deterministic proof graph core"
```

### Task 3: Verification-derived admission predicates

**Files:**
- Create: `backend/src/execution-proof-graph/internal/admission.ts`
- Modify: `backend/src/execution-proof-graph/index.ts`
- Test: `backend/tests/unit/execution-proof-graph/admission.test.ts`
- Test: `backend/tests/unit/execution-proof-graph/admission-mutations.test.ts`

**Interfaces:**
- Consumes: `VerifiedExecutionFact`, attestation identity/statement bindings, graph edges, and explicit policy inputs.
- Produces: typed admission predicates/results that distinguish verification failure, stale/freshness failure, assurance insufficiency, capability absence, authorization denial, placement ineligibility, and trust-policy rejection.

- [ ] **Step 1: Write red admission tests for verified predecessor requirements.**
A predecessor is admissible only when the supplied fact is a successful V2-014-derived `VerifiedExecutionFact` with exact Run/WorkflowVersion/attestation identity binding and the graph contains the required causal/dependency relationship.

- [ ] **Step 2: Add negative tests for stale/replayed/unverified facts.**
Feed typed V2-014 verification failures and prove the graph layer does not reinterpret them as admissible evidence. A raw attestation envelope or arbitrary signature-valid object must never bypass the `VerifiedExecutionFact` requirement.

- [ ] **Step 3: Add explicit assurance/trust/capability/authorization discrimination.**
A valid signature alone must not satisfy trust, capability, authorization, or assurance policy. Each failure gets a distinct typed result and deterministic machine-readable reason.

- [ ] **Step 4: Implement admission as a pure policy composition layer.**
The module may combine graph relationships with supplied verification/policy facts, but must not call a second verifier or mutate execution state. Placement remains delegated to V2-009 public policy inputs; authorization remains delegated to the existing authorization authority.

- [ ] **Step 5: Add mutation/discrimination tests.**
For every critical predicate, mutate one input dimension at a time: Run, WorkflowVersion, predecessor identity, parent digest, assurance, freshness, capability, authorization, placement, or trust. Each mutation must fail for the correct reason and never become accepted through another dimension.

- [ ] **Step 6: Run targeted tests twice and commit.**
```bash
bunx vitest run tests/unit/execution-proof-graph/admission.test.ts tests/unit/execution-proof-graph/admission-mutations.test.ts
bunx vitest run tests/unit/execution-proof-graph/admission.test.ts tests/unit/execution-proof-graph/admission-mutations.test.ts
```

```bash
git add backend/src/execution-proof-graph backend/tests/unit/execution-proof-graph
 git commit -m "feat(v2-015): add verification-derived admission predicates"
```

### Task 4: Multi-parent dependencies, replay, and convergence

**Files:**
- Create: `backend/src/execution-proof-graph/internal/convergence.ts`
- Modify: `backend/src/execution-proof-graph/internal/graph.ts`
- Test: `backend/tests/unit/execution-proof-graph/multi-parent.test.ts`
- Test: `backend/tests/unit/execution-proof-graph/replay-convergence.test.ts`

**Interfaces:**
- Consumes: existing graph node/edge types plus stable attestation identities and verified execution facts.
- Produces: deterministic multi-parent dependency satisfaction and idempotent duplicate/replay convergence.

- [ ] **Step 1: Write red tests for multi-parent admission.**
One dependent action must require the exact declared parent set; missing one parent denies admission; an extra unrelated parent does not silently satisfy the predicate; ordering of the same parent set must not change the result.

- [ ] **Step 2: Write red replay/convergence tests.**
Delivering the same node or edge twice must converge to one logical fact. Conflicting redefinition of the same stable identity must be rejected, not last-write-wins.

- [ ] **Step 3: Implement deterministic convergence.**
Use stable logical identities and set-equivalent canonical parent ordering. Convergence must be side-effect-free in the pure core and explicit about accepted duplicate versus conflicting mutation.

- [ ] **Step 4: Run mutation tests and commit.**
```bash
bunx vitest run tests/unit/execution-proof-graph/multi-parent.test.ts tests/unit/execution-proof-graph/replay-convergence.test.ts
```

```bash
git add backend/src/execution-proof-graph backend/tests/unit/execution-proof-graph
 git commit -m "feat(v2-015): add multi-parent and replay convergence"
```

### Task 5: Persistence/evidence composition at the existing authority boundary

**Files:**
- Modify only after repository archaeology confirms the exact V2-005 public extension seam.
- Create: `backend/src/execution-proof-graph/internal/evidence.ts` only if the existing V2-005 public contract requires an adapter in V2-015.
- Test: `backend/tests/integration/execution-proof-graph/evidence.integration.test.ts`

**Interfaces:**
- Consumes: persisted Run/evidence references and V2-014 attestation identities through existing public contracts.
- Produces: graph facts that can reconstruct execution history without replacing V2-005 storage semantics.

- [ ] **Step 1: Write a failing integration test against the existing V2-005 public contract.**
Persist a graph node/reference for a real attestation and reconstruct the same logical execution identity from the existing Run/evidence records.

- [ ] **Step 2: Implement the narrow adapter, if required.**
Do not create new Run tables or duplicate evidence persistence. Store only V2-015-owned graph facts if the frozen Work Order requires durable graph-specific state; otherwise keep the graph as a deterministic composition over existing evidence.

- [ ] **Step 3: Prove append-only behavior.**
An attempted rewrite or deletion of a previously verified graph node must fail in a typed, deterministic way.

- [ ] **Step 4: Run integration tests twice and commit.**
```bash
bunx vitest run tests/integration/execution-proof-graph/evidence.integration.test.ts
bunx vitest run tests/integration/execution-proof-graph/evidence.integration.test.ts
```

```bash
git add backend/src/execution-proof-graph backend/tests/integration/execution-proof-graph
 git commit -m "feat(v2-015): compose proof graph with durable execution evidence"
```

### Task 6: Cross-device continuation and coordination composition

**Files:**
- Create: `backend/src/execution-proof-graph/internal/coordination.ts`
- Modify: `backend/src/execution-proof-graph/index.ts`
- Test: `backend/tests/integration/execution-proof-graph/cross-device.integration.test.ts`
- Test: `backend/tests/integration/execution-proof-graph/coordinator-mutation.integration.test.ts`

**Interfaces:**
- Consumes: V2-008 execution handoff/runtime surfaces, V2-009 placement/event facts, V2-014 verified facts, and graph admission predicates.
- Produces: graph-level continuation decisions that preserve Run/WorkflowVersion identity and explicit policy dimensions.

- [ ] **Step 1: Write a failing two-node continuation test.**
Node A produces an attestation; Node B independently obtains a V2-014 `VerifiedExecutionFact`; V2-015 admits the dependent action only after exact predecessor and graph bindings are satisfied.

- [ ] **Step 2: Write reconnect/replay and duplicate-delivery tests.**
Repeat delivery after disconnect/reconnect. Assert one logical graph fact and no duplicate side effect at the integration boundary. The graph layer must not itself become a second execution engine.

- [ ] **Step 3: Write malicious-coordinator mutation tests.**
Mutate parent commitments, node identity, Run, WorkflowVersion, or graph relationships and prove independent reconstruction detects the mutation.

- [ ] **Step 4: Implement only the coordination seam.**
Do not modify V2-008/V2-009/V2-014 internals. Consume their merged public outputs and return typed graph/admission decisions to the caller.

- [ ] **Step 5: Run integration tests twice and commit.**
```bash
bunx vitest run tests/integration/execution-proof-graph/cross-device.integration.test.ts tests/integration/execution-proof-graph/coordinator-mutation.integration.test.ts
bunx vitest run tests/integration/execution-proof-graph/cross-device.integration.test.ts tests/integration/execution-proof-graph/coordinator-mutation.integration.test.ts
```

```bash
git add backend/src/execution-proof-graph backend/tests/integration/execution-proof-graph
 git commit -m "feat(v2-015): compose cross-device proof coordination"
```

### Task 7: Real cryptographic verification and assurance discrimination

**Files:**
- Modify: `backend/tests/integration/execution-proof-graph/cross-device.integration.test.ts`
- Create: `backend/tests/integration/execution-proof-graph/run-v2-015-dogfooding.ts`
- Create: `spec/architecture/v2/dogfooding-evidence/V2-015-execution-proof-graph.md`

**Interfaces:**
- Consumes: V2-014's real Ed25519 signing and independent verification context.
- Produces: persisted dogfooding evidence proving graph admission is driven by verification-derived facts rather than signature presence alone.

- [ ] **Step 1: Extend integration coverage with real signed envelopes.**
Generate real V2-014 attestations, export canonical envelope bytes, verify them in a separate process/context, then feed only the resulting `VerifiedExecutionFact` into V2-015 admission.

- [ ] **Step 2: Add negative cryptographic experiments.**
Tamper canonical bytes, mutate Run/WorkflowVersion, replay a consumed nonce/epoch, provide insufficient assurance, and replace the trusted key context. Each experiment must fail through V2-014 verification and therefore yield no admissible V2-015 predecessor fact.

- [ ] **Step 3: Implement the dogfooding runner.**
Use the real stack, two real supported host kinds, safe isolated effects, real PGlite/current migrations, and independent verifier process. Record structured facts, normalized transcript, and deterministic hash. Do not substitute hand-built positive statements for runtime-produced attestations.

- [ ] **Step 4: Run the dogfood repeatedly.**
Run four consecutive executions from a fresh-stack setup. Require exit 0, identical normalized transcript/hash, correct graph reconstruction, and deterministic replay/duplicate convergence.

- [ ] **Step 5: Persist limitations honestly and commit.**
The evidence file must state what is real versus simulated and preserve negative findings append-only.

```bash
bunx tsx tests/integration/execution-proof-graph/run-v2-015-dogfooding.ts
bunx tsx tests/integration/execution-proof-graph/run-v2-015-dogfooding.ts
```

```bash
git add backend/tests/integration/execution-proof-graph spec/architecture/v2/dogfooding-evidence/V2-015-execution-proof-graph.md
git commit -m "test(v2-015): add real cross-device proof-graph dogfooding"
```

### Task 8: Full mutation/discrimination and architecture verification

**Files:**
- Test: all `backend/tests/unit/execution-proof-graph/**`
- Test: all `backend/tests/integration/execution-proof-graph/**`
- Test: `backend/tests/architecture/**` additions only where V2-015-specific static pins are required.

**Interfaces:**
- Consumes: complete V2-015 implementation.
- Produces: deterministic completion receipts proving every frozen invariant and architecture boundary.

- [ ] **Step 1: Run the complete V2-015 scoped battery twice.**
```bash
bunx vitest run tests/unit/execution-proof-graph tests/integration/execution-proof-graph
bunx vitest run tests/unit/execution-proof-graph tests/integration/execution-proof-graph
```

- [ ] **Step 2: Run architecture and static-boundary checks.**
```bash
bunx vitest run tests/architecture
```
Confirm there is no second workflow/execution/verification/authorization authority, no forbidden private imports, no migration/route drift unless explicitly justified, and no V2-013/V2-012 sibling dependency.

- [ ] **Step 3: Run repository typecheck and scoped lint.**
```bash
bun run typecheck
bunx eslint src/execution-proof-graph tests/unit/execution-proof-graph tests/integration/execution-proof-graph
```
Separate inherited baseline failures from V2-015-attributable failures; never hide baseline defects.

- [ ] **Step 4: Run the full canonical test scope in disjoint chunks.**
Use the repository's existing canonical include set and execute disjoint chunks if necessary to avoid worker/resource limits. Cross-check arithmetic against the pre-V2-015 baseline and require zero new failures attributable to this work.

- [ ] **Step 5: Record the completion matrix.**
Create/update the V2-015 evidence with exact commands, counts, hashes, baseline comparisons, and limitations. Do not mark PASS from a claim alone.

- [ ] **Step 6: Commit verification evidence.**
```bash
git add backend/tests spec/architecture/v2/dogfooding-evidence/V2-015-execution-proof-graph.md
git commit -m "test(v2-015): finalize proof graph verification evidence"
```

### Task 9: Review gate and merge preparation

**Files:**
- PR body/comments only after implementation is actually complete.

**Interfaces:**
- Consumes: final branch SHA, exact diff, deterministic verification receipts, dogfooding evidence.
- Produces: review-ready PR with no architectural drift and no unsupported completion claims.

- [ ] **Step 1: Verify exact base and scope.**
Confirm merge base remains `493da4c82ba70d4a104e97559dc54192297792d2`, the branch has not consumed V2-012, and the diff contains only V2-015-owned paths plus its plan/evidence artifacts.

- [ ] **Step 2: Audit against every frozen invariant.**
Do not merge if any invariant depends on prose rather than executable evidence.

- [ ] **Step 3: Run the final dogfood and full scoped verification from the exact final head.**
Record exact SHA and timestamps.

- [ ] **Step 4: Open the implementation PR against `main`.**
Use Issue #157 as the activation/handoff reference. The PR must explicitly state that architect merge is the completion event and that V2-013 remains blocked until post-merge finalization.

- [ ] **Step 5: Stop for architect review.**
No self-merge. The architect independently inspects the final diff, tests, evidence, and actual GitHub CI state before merging.

---

## Self-review checklist

- **Spec coverage:** all 12 invariants are explicitly tested or structurally pinned; every required verification item has a corresponding task; real two-host dogfooding is included; every stop condition is guarded.
- **Placeholder scan:** no task depends on “implement later”; any persistence seam is explicitly discovered and justified before modification.
- **Authority consistency:** V2-003 = workflow semantics, V2-005 = Run/evidence persistence, V2-014 = cryptographic verification, V2-009 = scheduling/placement/events, V2-008 = computer-use execution. V2-015 only composes and evaluates proof-graph-specific relationships/policy inputs.
- **Mutation coverage:** node identity, parent commitments, Run, WorkflowVersion, freshness, assurance, capability, authorization, placement, and trust dimensions all receive independent discrimination coverage.
- **Completion condition:** V2-015 is not complete until deterministic tests, real cryptographic verification, two-host dogfooding, architect review/merge, actual merge evidence, and post-merge finalization all exist.
