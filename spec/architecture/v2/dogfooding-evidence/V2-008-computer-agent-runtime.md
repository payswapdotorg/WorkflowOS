# V2-008 — Computer-Agent Runtime — Dogfooding Evidence

**Work Order:** V2-008 — Computer-Agent Runtime (wave W3)
**Classification of capability:** execution-facing runtime (computer-use execution, observation/action grounding, host adapters, human takeover, bounded recovery, computer-execution evidence) — a user-workflow-executing capability
**Validation type:** real-computer-task experiment (work-order dogfooding requirement, literal frozen clause: "Automate one useful computer task end-to-end on a real host, including one intentionally recoverable failure and a human takeover path. Where the host supports V2-014, capture an execution attestation and verify it through an independent verifier path; include one tamper/replay negative.")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; the Work Order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-008 — Computer-Agent Runtime, wave W3, branch `feat/v2-008-computer-agent-runtime`, base `d36499cb95c6fe80a58346cfb7452b2bf75d7a28` (merged main: V2-002/V2-003/V2-004/V2-005/V2-006/V2-007/V2-014 + IG-001 + IG-002 + governance reconciliation all frozen on this base).

## Workflow / version under test

**The "daily-triage" workflow** — authored through the real V2-003 builder, persisted through the real V2-002 repository (the run pins the immutable version), parsed + semantic-digest-verified and compiled through the real V2-007 compiler by the runtime at execution time:

- semantic digest `b704255281e567bb84ad0718190a35dddf35d52b23f39f75c93d8793a2a17173` (identical across every run of this experiment — content-derived);
- 4 nodes / 4 control edges:
  1. `read_inbox` (`agentic_computer_use`, task: read every real file in the inbox and extract the invoice summary; capabilities `filesystem.read`; placement `device_local`; completion evidence `observation`),
  2. `write_report` (`agentic_computer_use`, task: write the triage report without clobbering; capabilities `filesystem.read`+`filesystem.write`; placement `device_local`; completion evidence `observation`; input bound to `read_inbox.summary`),
  3. `approve_report` (`human` approval — the pause point; completion evidence `human_confirmation`),
  4. `finalize` (`agentic_computer_use`, task: confirm the human disposition of the stale partial report; capabilities `filesystem.read`; placement `device_local`; completion evidence `observation`).

## Surface / host

**A REAL desktop host**: one `DesktopHostAdapter` over `RealFilesystemDesktopEnvironment` — real `node:fs/promises` I/O rooted at a real sandboxed directory (`mkdtemp` under the OS temp dir). The host registered through the REAL V2-004 registration protocol (key enrollment from seed `sha256('v2-008-dogfooding-desktop-host')` → nonce challenge → HMAC-SHA256 challenge-response → registration → session → trust tier `trusted` → heartbeat), node id `node_e5c012b60cc17e4a`, platform class `desktop`, location class `device`, advertising `filesystem.read`/`filesystem.write` (canonical registry names). The host carries a REAL Ed25519 attester key (`generateAttesterKeyPair`, key id `wfeak_ea93957fd866982cb649f070a8bfd3b3` in the persisted run) — genuine V2-014 support.

**The full real stack**: real PGlite + all migrations, real identity stack, real V2-002 repository (authoring + version pinning), real V2-005 `DefaultWorkflowRunService` (every durable fact — commands, steps, invocations, evidence, attestation bindings, timeline — is transactional in the real tables), the real V2-004 matcher for host routing, the real V2-003 parser + V2-007 compiler for the executed plan.

## Exact task

Automate **daily inbox triage** end-to-end on the real host:

1. The workflow starts with three REAL fixture files in the sandbox (`inbox/invoice-001.txt` — INVOICE ACME-001 amount 120.00 status unpaid; `inbox/invoice-002.txt` — INVOICE ACME-002 amount 85.50 status paid; `inbox/note-standup.txt` — a standup note).
2. `read_inbox`: the agent observes the real directory, reads each REAL file, extracts the invoice summary from the REAL content.
3. `write_report`: the agent observes the absent report target and writes the triage report — with the **intentionally recoverable failure** in the middle (below).
4. `approve_report`: the run pauses; the human approves (real resume through the human-execution pause point).
5. `finalize`: the agent needs the human's judgment on the stale partial report's disposition — the **human takeover path** (below) — then verifies the human's real work and completes.

## Starting state

Fresh real stack (fresh PGlite + fresh node directory), fixed fixture files with exact bytes, injected deterministic clocks (shared stepping clock: run service, runtime, host adapter — all timestamp producers and the verifying boundary coherent; epoch 7), fixed key seeds, deterministic command/invocation id discipline. No network, no wall-clock dependence in product logic, no randomness. The only wall-clock lines are run-instance bookkeeping (start/duration).

## The intentionally recoverable failure (real, not scripted)

Between the agent's grounding observation of the (absent) report target `reports/triage-report.md` and its grounded write, the OUTSIDE WORLD — a stale prior partial run, performed as a real concurrent `node:fs` write by the operator — creates the target file with `STALE PARTIAL REPORT (prior interrupted run)\nsummary: (incomplete)\n`. The sequence that follows, all for real:

1. The agent issues the grounded `filesystem.write` (grounding: the observed ABSENT target digest).
2. The host re-resolves the current target digest, finds the file EXISTS with different content → **`HOST_TARGET_CHANGED`, no execution** — the fail-closed wrong-target prevention is the ONLY thing standing between the workflow and clobbering a file it did not observe. The stale file is asserted byte-identical afterwards (`sha256 fe795b1643d862e1…`).
3. The runtime classifies the failure recoverable; the decider sees the typed failure in its action history and **re-observes** — now seeing the real conflicting content.
4. The agent writes the report under the versioned name `reports/triage-report-2.md` (grounded on ITS observed absence), which succeeds; the completion claim is verified against a fresh observation of the real file bytes (`sha256 b1f9654ea0df4611…`), and the report content is derived from the REAL invoice data (`3 files read; 2 invoices; unpaid: ACME-001 (total 120.00)`).

Recovery never invented success: the failed action's effect was UNKNOWN until re-observed, and the step completed only on the verified observation (5 actions consumed — the recovery is visible in the durable record).

## The human takeover path (real)

The `finalize` step needs a human judgment (preserve vs. discard the stale partial report). The decider returns `{decision: 'takeover'}`; the run pauses with the takeover marker. The human then acts through the **same universal host protocol** on the same host:

1. `requestTakeover` (human `v2-008-dogfooding-human`) — a takeover session on the paused step.
2. The human observes the REAL stale file through `filesystem.read` (the takeover action resumes the run under the human executor — a human acting IS execution; the same attempt continues).
3. The human performs a grounded `filesystem.write` of `reports/stale-disposition.md` (`HUMAN REVIEWED: stale partial report preserved for audit; fresh report written as triage-report-2.md`) — REAL bytes on the real filesystem (`sha256 cefe81d21f321f7b…`), recorded as `human_confirmation` evidence with producer kind `human` and the human's producer id.
4. `finishTakeover` mode `hand-back`: the agent re-drives the step, verifies the human's real file against the exact expected content, and completes — the run finishes `completed` with the takeover in the durable record (the human's `tak-`-namespace invocations and the human producer identity on 4 human-produced records).

## The V2-014 path (real keys, independent verification, negatives)

The host's real Ed25519 key signs a canonical `ExecutionStatement` per completed capability step (bound to workflow/version/semantic-digest/deployment/run/attempt/step/node; commitment-based inputs/outputs/observations; single-use nonce; epoch; honest `software_signed` assurance — never up-claimed):

- the runtime verifies each attestation through the **independent verifier path** (the merged V2-014 `verifyAttestation` with explicit binding + freshness + trusted-attester policy and a single-use replay registry) BEFORE attachment;
- attachment goes through the real V2-005 run boundary, which re-verifies and consumes the nonce durably — 3 bindings for 3 completed capability steps, each bound to the exact run/attempt/step;
- **TAMPER negative**: a structured clone with `statement.action` mutated to `TAMPERED: the file was definitely uploaded everywhere` — the independent verifier rejects it typed (`ATTESTATION_SIGNATURE_INVALID`), the run boundary attach rejects it typed (`RUN_ATTESTATION_REJECTED`, durably recorded as a typed rejection — never evidence), and no binding is added;
- **REPLAY negative**: re-attaching the ORIGINAL valid attestation — rejected typed (`RUN_ATTESTATION_REPLAYED`, durable single-use nonce consumption), no binding added.

## Expected outcome

- The run pauses at the human approval node, resumes through the human outcome, pauses again for the agent-requested takeover, and completes end-to-end after the hand-back — all state transitions real in the V2-005 tables.
- The intentional race is prevented (no clobber) and recovered from (versioned write) — all real filesystem bytes.
- The human's takeover actions are real protocol invocations recorded with human identity.
- Three attestations produced/verified/attached; tamper and replay both rejected typed with no binding added.
- The full history reconstructs from the persisted run alone (registry event names in the timeline: `workflow.run.requested/started/paused/resumed/completed`, `workflow.step.started`, `capability.invocation.requested/completed`, `observation.recorded`).

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-008/backend && bunx tsx tests/integration/computer-agent/run-v2-008-dogfooding.ts` — exit code 0, 2026-09-02T10:51:24Z (wall clock start 1788345484382 ms; wall duration 4146 ms; wall-clock lines are run-instance bookkeeping — all product clocks are injected).

```text
V2-008 dogfooding run — Work Order V2-008, base d36499cb95c6fe80a58346cfb7452b2bf75d7a28
wall clock start: 1788345484382ms (the only wall-clock lines; all product clocks are injected)
real host sandbox: /tmp/v2-008-dogfooding-c1rNKe
real fixtures: inbox/invoice-001.txt, inbox/invoice-002.txt, inbox/note-standup.txt
workflow authored: wfw_bb656c7765325da48dcb484222b3a24d version wfwv_3a39ec541e1efa740c0e0d2b990aae17 (semantic digest b704255281e567bb84ad0718190a35dddf35d52b23f39f75c93d8793a2a17173)
run requested: wfr_df8d0fa47e0821299c46c04d5cf3a8a9 (state requested)
drive 1 → {"state":"paused","pausedAt":"approve_report","steps":["read_inbox:completed","write_report:completed","approve_report:paused"]}
  [PASS] drive 1 pauses at the human approval step — approve_report
  [PASS] the paused step is the approval node
  [PASS] the outside-world stale file was NOT clobbered (fail-closed wrong-target prevention) — sha256 fe795b1643d862e1…
  [PASS] the REAL report file contains the summary extracted from the REAL invoice contents — sha256 b1f9654ea0df4611…
  [PASS] the write step completed despite the intentional race (recoverable failure recovered honestly)
  [PASS] the recovery consumed real actions (re-observe + re-ground + versioned write) — actions=5
drive 2 → {"state":"paused","pausedAt":"finalize","takeoverRequested":true}
  [PASS] drive 2 pauses for the takeover — finalize
  [PASS] the agent requested human takeover for the disposition judgment
takeover session: takeover-wfr_df8d0fa47e0821299c46c04d5cf3a8a9-finalize (human v2-008-dogfooding-human on host node_e5c012b60cc17e4a)
  [PASS] the human observed the REAL stale file through the same protocol
  [PASS] the human wrote the REAL disposition note through the same protocol
  [PASS] the human disposition file exists with the exact bytes — sha256 cefe81d21f321f7b…
drive 3 → {"state":"completed","steps":["finalize:completed"]}
  [PASS] the run COMPLETED end-to-end on the real host after the takeover hand-back
  [PASS] timeline reconstruction contains the registry event workflow.run.requested
  [PASS] timeline reconstruction contains the registry event workflow.run.started
  [PASS] timeline reconstruction contains the registry event workflow.step.started
  [PASS] timeline reconstruction contains the registry event capability.invocation.requested
  [PASS] timeline reconstruction contains the registry event capability.invocation.completed
  [PASS] timeline reconstruction contains the registry event observation.recorded
  [PASS] timeline reconstruction contains the registry event workflow.run.paused
  [PASS] timeline reconstruction contains the registry event workflow.run.resumed
  [PASS] timeline reconstruction contains the registry event workflow.run.completed
  [PASS] evidence reconstruction contains agent intent evidence
  [PASS] evidence reconstruction contains host observation evidence
  [PASS] evidence reconstruction contains host claim evidence (claims, never completion proof)
  [PASS] evidence reconstruction contains the human approval confirmation
  [PASS] the human producer identity is recorded on the approval + takeover actions — 4 records
  [PASS] three attestation bindings (one per completed capability step: read, write, finalize) — 3
  [PASS] the write step attestation is bound to the exact run/attempt/step — attester wfeak_ea93957fd866982cb649f070a8bfd3b3
  [PASS] assurance is honestly software_signed (the universal baseline)
  [PASS] the host signed exactly the produced attestations (real Ed25519 keys) — 3
  [PASS] TAMPER negative: the independent verifier rejects the mutated statement with a typed failure — ATTESTATION_SIGNATURE_INVALID
  [PASS] TAMPER negative: the V2-005 run boundary rejects the tampered attestation typed
  [PASS] the tamper rejection is durably recorded (never evidence) — 1 rejections
  [PASS] the tampered attach added NO binding
  [PASS] REPLAY negative: re-attaching the ORIGINAL valid attestation is rejected (durable single-use nonce)
  [PASS] the replay added NO binding (exactly the three real attestations)
  [PASS] the real sandbox contains exactly the expected real files
checks: 37/37 passed; wall duration 4146ms
V2-008 dogfooding PASSED
```

## Duration / cost

Wall duration 4146 ms (single process; real PGlite in-memory, real filesystem I/O, real Ed25519 signing/verification). 37/37 fail-closed checks; exit code 0 only when all pass.

## Evidence references

- **Runner:** `backend/tests/integration/computer-agent/run-v2-008-dogfooding.ts` (standalone `bunx tsx` process; committed at `a34350b`).
- **Runtime under test:** `backend/src/computer-agent/` (implementation commit `9da4422` + design-correction commit `be19e4b` — every correction was a genuine defect the real run exposed, fixed at the root).
- **Deterministic battery:** `backend/tests/unit/computer-agent/` (13 files / 88 tests) + `backend/tests/integration/computer-agent/` (3 files / 17 tests on the real stack) — the required regressions: action authorization, stale observation, wrong-target prevention, duplicate action suppression, pause/takeover, recovery, evidence truthfulness, attestation binding, stale/replayed attestation handling, cross-host protocol conformance, locality/privacy enforcement.
- **Full local suite at the final head:** see the worklog record (Task ID V2-008-impl) for the exact counts — the ONLY failures permitted are the inherited, out-of-scope, untouched-by-this-branch files.
- **Scope audit:** `git diff --name-status d36499c..HEAD` — exactly `backend/src/computer-agent/**` (new module) + `backend/tests/unit/computer-agent/**` + `backend/tests/integration/computer-agent/**` + this evidence file. Zero edits to any sibling module, shared config, vitest config, registry, governance files, or the main checkout.

## Classification

**PASS** — the frozen dogfooding clause is satisfied literally: a useful computer task (real inbox triage) automated end-to-end on a real host (real filesystem desktop host), including one intentionally recoverable failure (real mid-flight race, fail-closed no-clobber, honest re-observe recovery) and a human takeover path (real human actions through the same universal protocol, human-confirmation evidence, hand-back verification), with the V2-014 attestation captured (real Ed25519), verified through the independent verifier path, and one tamper plus one replay negative both rejected typed.

## Limitations (recorded honestly)

- The "real host" is a REAL local-filesystem desktop host (real `node:fs` semantics, real races, real bytes) — not a remote machine or a live GUI session. Screen/application capabilities exist on the same adapter but were not the dogfooding vehicle; the browser and mobile hosts are exercised by the deterministic battery over scripted environments (the adapters' protocol discipline is pinned cross-host by `host-protocol-conformance` + `cross-host` integration tests, but only the desktop adapter drove real side effects in this experiment).
- The agent decision policy is an injected deterministic task script (the loop's intelligence port is pluggable by design — V2-008 owns the runtime discipline, not a model). The policy derived every decision from the CURRENT real observation content; the transcript's data (invoice counts, totals) is computed from the real file bytes.
- PGlite is in-process (the CI oracle uses containerized PostgreSQL); the run service's command/state-machine/attestation-boundary code paths are identical.
- The outside-world race write is performed by the runner acting as a concurrent process through `node:fs` directly — honest (the outside world owes the protocol nothing); it is NOT a host-protocol action and is not recorded as one.
- The workflow's rejected-branch approval edge routes to `finalize` as a fixture (both declared outcomes must be covered by V2-003); the experiment drives the approved path.

## Resulting action

V2-008 implementation + deterministic battery + real-host dogfooding are complete on the branch; the Work Order is READY_FOR_ARCHITECT_REVIEW (merge decision is the architect's alone). No frozen-contract contradictions were encountered: the runtime consumes V2-003/V2-004/V2-005/V2-007/V2-014 exactly through their merged barrels and defines no second authority of any of their dimensions.

---

# Correction round — the PR #142 architect blocker (attestation completion boundary)

## The blocker (audited by the architect on the actual branch)

`completeStepWithAttestation()` recorded the step as `succeeded` BEFORE enforcing `AgentAttestationPolicy.required`: a missing attester key, a failed independent V2-014 verification, or a rejected V2-005 attachment could leave a durably succeeded step while `runLoop()` still reported `completed` and the walk could ultimately call `completeRun()`.

## The correction (commits `55cfc21` red → `463b6ee` green)

1. **Enforcement before durable success:** the gate order is now support check → independent V2-014 verification → V2-005 boundary attach → only then `recordStepCompleted('succeeded')`. The atomic direction is the safe one: a crash between the attach and the step record converges on re-drive (the binding is durable, the step command is idempotent); the inverse order is exactly the blocked defect.
2. **Typed propagation:** required-attestation failures surface as typed runtime failures — `AGENT_ATTESTATION_UNAVAILABLE` (no key) and the new `AGENT_ATTESTATION_REJECTED` (V2-014 rejection or V2-005 attach rejection, the typed code carried in the detail). Both `runLoop` call sites (the deterministic_api structured path and the agentic verified-completion path) durably fail the step and return `outcome: 'failed'`; the walk routes the failure through the declared failure policy, so `completeRun()` is unreachable while a required attestation is unsatisfied.
3. **The real boundary's typed throw is honored:** the REAL V2-005 `attachAttestation` RAISES `WorkflowRunError RUN_ATTESTATION_*` (durably recorded, never returned as a value — the previous code's returned-shape check was dead code and the throw escaped the runtime unhandled). The correction catches exactly the `RUN_ATTESTATION*` typed throws and maps them; anything else rethrows. V2-005 and V2-014 semantics are consumed, never redefined.
4. **Optional policy unchanged:** honest absence/rejection still recorded; the step still completes when attestation is not required.

## The three deterministic negative regressions (required correction #4)

Red on the pre-fix head, green after the fix — in BOTH batteries:

- **Unit (`tests/unit/computer-agent/attestation-completion-gate.test.ts`, deterministic, ManualClock):** (1) no attester key + required → `AGENT_ATTESTATION_UNAVAILABLE`; (2) independent V2-014 rejection (`trustedAttesterKeyIds: []` trusts nobody) → `AGENT_ATTESTATION_REJECTED` carrying `ATTESTATION_ATTESTER_UNEXPECTED`, the boundary never asked; (3) V2-005 attach rejection (the recorder double mirrors the real boundary's typed-throw discipline) → `AGENT_ATTESTATION_REJECTED` carrying `RUN_ATTESTATION_REJECTED`, no binding. Each proves: zero succeeded step completions, exactly one durably failed step completion, no `complete` command, run state `failed`.
- **Real stack (`tests/integration/computer-agent/computer-agent.attestation-gate.integration.test.ts`, real PGlite + the real V2-005 boundary + a real Ed25519 key):** the same three negatives against the durable PostgreSQL shape — the step record is `outcome: 'failed'` / `status: 'failed'`, the run state is `failed`, no (or exactly the pre-failure) bindings. Case (3) is a REAL boundary rejection: a host that signs every attestation with one constant nonce → the first attach consumes the nonce in the boundary's DURABLE run-scoped replay registry → the second attach is the typed `ATTESTATION_REPLAYED` throw, durably recorded in `attestationRejections`, the second step never succeeds, the run fails.

## Re-verification after the correction (point #5 of the blocker)

- **Dogfooding runner re-run:** 37/37 checks PASS, exit 0, wall ~3.8s (identical transcript shape; the attestation boundary events now precede `workflow.step.completed` in the reconstructed timeline — the corrected order).
- **Computer-agent battery:** 18 files / 111 tests, all green (91 unit incl. the 3 new gate tests + 20 integration incl. the 3 new real-stack negatives).
- **e2e timeline pin:** updated to the corrected order (`execution.attestation.verified` + `verification.completed` BEFORE `workflow.step.completed`) — the attestation is now verifiably attached before the step is durably completed.
- **Typecheck:** 0 errors. **Lint:** scoped eslint clean; repo-wide `bun run lint` exit 0.
- **Full local suite (disjoint chunks over all 265 vitest files):** 4318 tests — 4250 passed / 3 failed / 65 skipped. The only failures are the inherited WORK-069 governance trio (governance-state W052-AC01 + parallel-eligibility W052-AC03 ×2), pre-existing on main @ `d36499c`, zero governance files in this diff.

## Correction classification

**PASS** — required attestation is now a completion gate at the exact boundary the architect specified: no required-attestation failure can leave a succeeded step, and `completeRun()` is prevented on every negative path, proven deterministically (unit) and durably (real stack).
