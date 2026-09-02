# V2-007 Dogfooding Evidence — Compile-and-Validate (Real Task)

**Work Order ID:** V2-007 — Workflow Compiler
**Workflow under test:** "support-ticket triage" (the merged V2-003 support-ticket-triage task — the same real task the V2-003 round-trip and V2-006 install-and-teach dogfooding rounds exercised): WorkflowIR document, schema version 1, object type `workflowos/workflow-ir/v1`, authored live through the merged V2-003 fluent builder (`createWorkflowIrBuilder`).
**WorkflowVersion under test:** the version whose semantic content is this IR. Its identity is the WorkflowVersion SEMANTIC digest computed by the merged V2-003 implementation: `571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37` (sha-256, domain `workflowos/workflow-ir/v1`) — byte-identical to the digest recorded in the V2-003 and V2-006 dogfooding evidence (cross-work-order continuity of the same real task). WorkflowVersion persistence/pinning itself is V2-002 (merged, deliberately not consumed here — the compiler binds to the semantic digest only).
**Surface/host:** `backend/src/workflow-compiler/` public module surface (compile, artifact serialization/parse/verify, source-version binding verification, semantic projection), exercised in a REAL process on this development host (worktree `/home/z/worktrees/V2-007`, branch `feat/v2-007-workflow-compiler`): `bunx tsx tests/integration/workflow-compiler/run-compile-and-validate-dogfooding.ts`. In-process, no DB, no routes, no network (pure domain module by design; V2-007 owns no routes/server surface).
**Experiment date / head:** 2026-09-01T23:24:25Z (run 1) and 2026-09-01T23:24:29Z (run 2), at implementation head `0ea048e3cca4cfc270bfba5380abd8d8a0413986` (green implementation commit). Red-battery history: `bdb5ac9…` → `83ba35a…` → `a94678b…` (all test-only, verified red pre-implementation).

## Exact task (dogfooding-protocol requirement for V2-007)

Compile ONE real authored workflow and validate the compiled artifact against the SAME real task, through the compiler's own conformance surface. Per the Work Order: "Compile a real authored workflow and validate the compiled artifact against the same real task using the compiler's conformance/execution harness. Full integration with durable WorkflowRun/evidence execution is exercised by IG-003 after V2-005 and V2-008 are merged." Concretely: author support-ticket triage with the merged V2-003 builder → validate → compute the real WorkflowVersion semantic digest → transport round-trip (serialize/parse) → **compile with the V2-007 compiler** → verify provenance (compiler identity + source-version binding), artifact integrity (canonical digest) and inspectability (flattened plan facts: BFS order, human-gate outcome continuations, opaque secret_ref) → **validate compiled semantics against the same task** via the deterministic semantic projection compared against the source IR's own canonical serialization → export → re-import → re-verify → **compile TWICE and prove byte-identical artifacts** → prove the same real path rejects IR-valid-but-compiler-unrepresentable sources with typed diagnostics.

## The workflow (real, not a toy)

6 nodes / 5 control edges, workflow inputs `issueUrl` (required) / `channel` (optional), outputs `summary` / `messageId`, default placement `any_supported_node`, provenance `authored`:

| Node | Execution class | Semantics |
|---|---|---|
| `fetch_issue` | `deterministic_api` | `github.repository.read`, completion evidence `observation`, placement `cloud_allowed`, fail_workflow |
| `draft_summary` | `agentic_computer_use` | agent drafts triage summary + severity, retry budget 2 |
| `review_gate` | `human` | approval gate with declared outcomes `approved`/`rejected` (3-edge outcome fan-out), completion evidence `human_confirmation`, placement `device_local` |
| `notify_channel` | `deterministic_api` | `messaging.send` with secret-referenced credentials (`secret_ref: team-notifications@secrets` on a `secret`-typed port), completion evidence `verification`, placement `cloud_preferred` |
| `sync_backlog` | `subworkflow` | immutable dependency `wf-backlog-sync` @ `wfv_0192837465afdeadbeef-candidate-1`, requires `workflow.execute`, retry budget 3 |
| `log_rejection` | `deterministic_api` | `filesystem.write` rejection log, `ignore_and_continue`, placement `device_local` |

## Starting state

Red battery committed first (`bdb5ac9` — 9 unit files / 1867 lines, all failing on the missing module; alignment rounds `83ba35a`/`a94678b`), then the green implementation committed at `0ea048e`: scoped suites 190/190 (11 files: 9 unit + 2 integration), `bun run typecheck` clean, scoped eslint zero findings. The inherited mid-flight draft (written by the interrupted dispatch #1 at 23:08–23:19) was reconciled: one harness defect fixed in the untracked dogfooding scaffolding — the edge-set-preservation check had compared a canonically-ordered projection against authoring-order source edges with an order-sensitive comparison; it now compares edge multisets (a set is a set in the V2-003 schema). The compiler module itself needed no fixes. No repository persistence, no execution runtime — as specified for this Work Order.

## Expected outcome

- compilation succeeds through the real path and is deterministic (same source + same compiler version → byte-identical artifact);
- the compiled plan is inspectable and preserves the source task's declared semantics exactly (semantic projection ≡ the IR's own canonical form; control-edge set preserved by the flattening);
- the artifact is bound to the source WorkflowVersion semantic digest (verifySourceVersionBinding) and carries compiler identity + options-digest commitment;
- the artifact exports to canonical bytes, re-imports losslessly, re-verifies, and still binds + still projects to the source semantics;
- secrets stay opaque (`secret_ref` handle only; secret material canary absent from exported bytes);
- a model-generated source (provenance origin `compiled`, model-session sourceRef) compiles to inspectable data with NO execution/proof claims — generated intent is never proof of execution;
- IR-valid-but-compiler-unrepresentable sources (placement conflict, human pause point with retry budget, cyclic control, duplicate capability requirements, undeclared invoked capability, unsupported requested compiler version) are rejected fail-closed with typed diagnostics and no partial artifacts.

## Observed outcome (real run — verbatim script output, run 1 of 2)

`bunx tsx tests/integration/workflow-compiler/run-compile-and-validate-dogfooding.ts` → exit code **0**:

```text
V2-007 compile-and-validate — dogfooding run
work order: V2-007 (workflow compiler v1)
compiler object type: workflowos/compiled-workflow/v1
supported compiler versions: 1
wall clock start (ms): 1788305065751
wall duration (ms): 21

workflow under test (authored with the merged V2-003 builder):
  task                                           support-ticket triage
  authoring path                                 workflow-ir-builder
  nodes / edges                                  6 / 5
  start                                          fetch_issue
  workflow inputs / outputs                      2 / 2

source WorkflowVersion identity (computed by merged V2-003):
  valid WorkflowIR document                      true
  semantic digest                                571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
  digest algorithm / domain                      sha-256 / workflowos/workflow-ir/v1
  IR schema version / object type                1 / workflowos/workflow-ir/v1

compilation:
  compiled                                       true
  compiled units                                 6
  plan order (BFS)                               fetch_issue -> draft_summary -> review_gate -> log_rejection -> notify_channel -> sync_backlog
  artifact digest                                2d615ff3224852b40fe31ffeebebc8e085559ef185baefa0952d9f579365f805
  options digest                                 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a

conformance validation (deterministic semantic projection vs the IR):
  semantic equivalence (projection === IR)       true
  control-edge set preserved                     true
  source-version binding verified                true
  artifact verified (shape+version+digest)       true
  secret credentials opaque (secret_ref only)    true
  secret material absent from exported bytes     true
  generated source → no execution claims         true

export / import:
  exported bytes                                 4884
  re-import ok                                   true
  re-serialize identical                         true
  re-imported artifact verified                  true
  re-imported binding verified                   true
  re-imported projection equivalent              true

determinism (compile twice):
  byte-identical artifacts                       true
  identical digests                              true
  deeply equal artifacts                         true
  stable semantic projection                     true

IR-valid-but-compiler-rejectable sources (typed diagnostics, no partial artifacts):
  rejected: placement conflict (cloud_required default + device_local nodes) true [WORKFLOW_COMPILER_PLACEMENT_CONFLICT] ir-valid=true
  rejected: human pause point with a retry budget true [WORKFLOW_COMPILER_POLICY_VIOLATION] ir-valid=true
  rejected: cyclic control graph (back edge log_rejection → draft_summary) true [WORKFLOW_COMPILER_GRAPH_INVALID] ir-valid=true
  rejected: duplicate capability requirements    true [WORKFLOW_COMPILER_AMBIGUOUS_INPUT] ir-valid=true
  rejected: undeclared invoked capability (messaging.send not in requirements) true [WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED] ir-valid=true
  rejected: unsupported requested compiler version (2) true [WORKFLOW_COMPILER_VERSION_UNSUPPORTED] ir-valid=true

assertions: 31/31 passed
  PASS                                           authored workflow is a valid WorkflowIR document
  PASS                                           source semantic digest is sha-256 under the workflow-ir domain
  PASS                                           source semantic digest matches the merged triage fixture digest (cross-client)
  PASS                                           compilation succeeds through the real path
  PASS                                           artifact provenance records the compiler identity and version
  PASS                                           artifact carries the source WorkflowVersion semantic digest
  PASS                                           source-version binding verifies against the authored document
  PASS                                           artifact digest is sha-256 under the compiler-owned domain and matches the embedded digest
  PASS                                           the artifact verifies (shape, version, digest integrity)
  PASS                                           the plan compiles all 6 steps in deterministic breadth-first order
  PASS                                           the human approval gate flattens to outcome continuations (no success edges, 3-edge fan-out)
  PASS                                           secret credentials pass through as an opaque secret_ref handle only
  PASS                                           compiled semantics project back EXACTLY to the source IR declared semantics
  PASS                                           the control-edge set is preserved by the flattening (ordering semantics)
  PASS                                           exported artifact bytes carry the opaque secret reference and never secret material
  PASS                                           a model-generated source compiles to inspectable data with NO execution/proof claims
  PASS                                           the compiled artifact re-imports from its exported bytes
  PASS                                           re-imported bytes serialize identically (lossless round-trip)
  PASS                                           the re-imported artifact re-verifies (digest + provenance intact)
  PASS                                           the re-imported artifact still binds to the source WorkflowVersion
  PASS                                           the re-imported plan still projects to the source IR semantics
  PASS                                           compiling the same source twice yields the byte-identical artifact
  PASS                                           the double-compilation digests are identical
  PASS                                           the double-compilation artifacts are deeply equal
  PASS                                           the semantic projection is stable across repeated evaluation
  PASS                                           rejectable fixture rejected with a typed diagnostic: placement conflict (cloud_required default + device_local nodes)
  PASS                                           rejectable fixture rejected with a typed diagnostic: human pause point with a retry budget
  PASS                                           rejectable fixture rejected with a typed diagnostic: cyclic control graph (back edge log_rejection → draft_summary)
  PASS                                           rejectable fixture rejected with a typed diagnostic: duplicate capability requirements
  PASS                                           rejectable fixture rejected with a typed diagnostic: undeclared invoked capability (messaging.send not in requirements)
  PASS                                           an unsupported requested compiler version is rejected fail-closed

RESULT: compiled semantics validated against the same real task — deterministic, provenance-bound, secret-safe
```

**Compiled-artifact identities produced:** artifact digest `2d615ff3224852b40fe31ffeebebc8e085559ef185baefa0952d9f579365f805` (sha-256 over the canonical preimage `{objectType: workflowos/compiled-workflow/v1, plan, provenance}` — domain-separated from the source IR digest and from every registry execution-attestation object type); options digest `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` (sha-256 of the canonical empty declared-options object — defaults were relied upon, and the commitment reflects exactly that).

**Determinism proof (second real run, separate process):** run 2 executed at 2026-09-01T23:24:29Z → exit code **0**, wall duration 16 ms. The two full transcripts are **byte-identical** after normalizing exactly the two run-scoped wall-clock bookkeeping lines (`wall clock start (ms)` / `wall duration (ms)`): `diff` of the raw transcripts reports only those two lines; every artifact digest, plan order, projection, rejection code and assertion outcome is identical. Determinism is additionally pinned in-process by the committed battery (`dogfooding-compile-and-validate.integration.test.ts` runs the experiment twice inside one test process and compares the normalized reports; `compile-determinism.test.ts` proves order-insensitive source construction → identical artifact bytes).

## Evidence references

- Red battery (committed RED first, test-only): `bdb5ac90321ed65530a04be5f274b8aea0f83b8c` (9 unit files / 1867 lines, import-failing on the missing module), alignment rounds `83ba35a6a5a4d8d183c08455b1fa91950ded0327` and `a94678b8ae6acc94d88ee1a134ac07783870944c`.
- Green implementation: `0ea048e3cca4cfc270bfba5380abd8d8a0413986` — `backend/src/workflow-compiler/**` (8 source files: barrel, types, 6 internal modules) + the integration pipeline battery + this dogfooding scaffolding (harness, integration test, runner).
- Repeatable experiment: `backend/tests/integration/workflow-compiler/run-compile-and-validate-dogfooding.ts` (the standalone real-process runner whose transcript is above) and `backend/tests/integration/workflow-compiler/dogfooding-compile-and-validate.harness.ts` (the experiment itself, shared by the runner and the committed integration test `dogfooding-compile-and-validate.integration.test.ts`).
- Full final-head verification (scoped/architecture/full-suite/typecheck/eslint + boundary greps): recorded in the W2A-b worklog section at the final head.

## Duration / cost

Two real runs, each ~16–21 ms of in-process compute (runner wall clock), plus < 3 s for the full scoped vitest battery. No external resources consumed; the secret reference is an opaque fixture handle, no real credentials involved (protocol safety rule satisfied). No destructive actions (V2-007 compiles data; it executes nothing by construction).

## Classification

**PASS** — one real authored workflow compiled deterministically through the real product path; the compiled semantics validate exactly against the same real task (projection ≡ canonical IR, edge set preserved); the artifact is provenance-bound to the source WorkflowVersion semantic digest, inspectable, secret-safe, losslessly export/import-verified, and byte-reproducible across separate processes; unsupported/ambiguous inputs are rejected fail-closed with typed diagnostics; a model-generated source compiles to intent-only data with no execution claims.

### Honest limitations (explicit observations, not failures)

1. **Real durable execution belongs to unmerged Work Orders.** The "validate against the same real task" boundary for V2-007 is the compiler's conformance surface (deterministic semantic projection against the source IR's own canonical serialization + provenance/integrity/secret checks). No WorkflowRun, attempt, status or execution evidence was produced — run/evidence persistence is V2-005 and computer-agent execution is V2-008 (both unmerged); full compiled-plan execution integration is IG-003 after V2-005/V2-008 merge, exactly as the Work Order's dogfooding section states.
2. **No repository round-trip in this experiment.** The compiler binds to the WorkflowVersion SEMANTIC digest (computed by merged V2-003) rather than to a persisted version id; V2-002's repository/routes are merged and consumable, but V2-007 owns no routes and the experiment deliberately stays on the pure module surface (the V2-006 dogfooding already exercised the real install route for this same task's version). Composition through the real route surface is an integration-gate concern (IG-003), not a compiler conformance concern.
3. **Capability/placement checks are compile-time data checks.** The compiler verifies canonical-vocabulary membership, declared-capability coherence and placement location-class compatibility as DATA (constitution §12); actual node matching is V2-004 (merged) and actual placement decisions happen at execution time (V2-005+).
4. **Compiler v1 represents acyclic control only.** Cyclic control is IR-valid but rejected as compiler-v1-unrepresentable (typed diagnostic, proven in the run above); loop semantics require a governed later compiler version — recorded as a designed fail-closed boundary, not a defect.
5. **The operator is the implementing agent** running the experiment through the module's real public API in a real process (same disclosure as V2-006); an independent third-party operator trial is out of scope for this Work Order.

## Findings (persisted, not silently folded)

1. **Governed registry extension required (registry-conformance rule 5):** the compiled-workflow object type `workflowos/compiled-workflow/v1` is a genuinely new protocol-shaped object-type identifier — the registry's object types are the three execution-attestation ones owned by V2-014, none of which covers a compiled plan. It is kept SCHEMA-INTERNAL and compiler-scoped here; the committed battery pins it distinct from every registry attestation object type AND from the WorkflowIR object type, and pins the embedded vocabulary snapshot against the frozen registry file. It MUST be added to `V2-CTRL-003` through a governed architecture change before it becomes protocol-visible. No aliases of existing registry identifiers were introduced.
2. **Harness defect found during inherited-state reconciliation (fixed, disclosed):** the inherited draft's edge-set-preservation assertion compared a canonically-ordered projection against authoring-order source edges using an order-sensitive comparison — the check as written could only fail for a set-preserving compiler. Fixed to a multiset comparison before any evidence run; the compiler module itself was never wrong. (Also carried forward, unchanged from V2-002's W1 finding: canonical-JSON helpers are module-internal per domain — IG-001 may consolidate.)
3. No frozen-concept contradictions were encountered; no stop condition triggered.

## Resulting action

V2-007 is implementation-complete with persisted verification and dogfooding evidence; Work Order state remains **implemented/pending-architect-merge** (no COMPLETE marking — merge evidence is out of agent scope). Downstream consumers: V2-005/V2-008 (execute the compiled plan; IG-003 composes the full durable path), teaching-sessions (V2-006 may later compile the versions it installs), IG-001/IG-002 (composition gates after sibling merges).
