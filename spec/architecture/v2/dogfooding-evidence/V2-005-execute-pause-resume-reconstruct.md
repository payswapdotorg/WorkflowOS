# V2-005 Workflow Runs + Evidence — Dogfooding Evidence (Execute → Pause/Resume → Attestation Boundary → Reconstruct)

**Work Order:** V2-005 — Workflow Runs + Evidence
**Classification of capability:** execution-facing persistence capability (durable run state, evidence, and the attestation-binding boundary; HTTP command + history surface)
**Validation type:** real-system experiment per the work-order dogfooding requirement ("Execute a real workflow, pause/resume it, inspect its evidence and reconstruct the actual execution history from the recorded Run. Where the execution host produces an ExecutionAttestation, verify that the Run references the same statement/digest and that a modified or mismatched attestation cannot be attached as though it described the Run.") + issue #133 acceptance criteria (crash recovery, idempotent commands, tenant isolation, evidence-class separation).
**Status:** EVIDENCE PERSISTED — experiment run through the real product path; Work Order remains implemented/pending-architect-merge (agents never mark COMPLETE).

## Work Order ID

V2-005 — Workflow Runs + Evidence, wave W2B, branch `feat/v2-005-workflow-runs`, base `bdce0eacbb4fac3ece4ebf95861731de3eed474d` (post-W2A merge of PR #131 / V2-014).

## Workflow / version under test

A REAL workflow authored with the merged V2-003 builder (`createWorkflowIrBuilder`): the support-ticket-triage workflow (6 nodes — `fetch_issue`, `draft_summary`, `review_gate`, `notify_channel`, `sync_backlog`, `log_rejection` — 5 control edges, secret-referenced credentials, subworkflow dependency, placement constraints). Its real WorkflowVersion semantic digest is **`571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37`** (domain `workflowos/workflow-ir/v1`) — byte-identical to the merged V2-003 and V2-014 dogfooding evidence digest of the same workflow, asserted at run time (reference-data continuity, not re-derivation).

The immutable WorkflowVersion is created + INSTALLED (pinned) through the REAL V2-002 HTTP routes (not derived fixtures), and the run pins that exact repository identity:

| Binding | Value (run-scoped, normalized in the transcript) |
|---|---|
| Workflow (real V2-002 route identity) | `<scoped:0>` (uuid-derived `wfw_…`) |
| WorkflowVersion (real V2-002 route identity) | `<scoped:1>` (uuid-pinned `wfwv_…`, versionNumber 1) |
| WorkflowInstallation (real V2-002 install route) | `<scoped:2>` (`wfin_…`, status enabled, pins v1) |
| WorkflowRun (deterministic V2-005 identity) | `<scoped:3>` (`wfr_…` — derived from org + workflow + version + trigger surface + input digest) |
| WorkflowVersion semantic digest (V2-003, reference data) | `571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37` |
| Run / attempt / attested step | run `<scoped:3>` / `1` / `notify_channel` |
| Node (V2-004 `deriveNodeKeyFingerprint` over the V2-004 dogfooding browser-host key seed) | `node_795e8b12eaef3e45` (the merged V2-004 dogfooding device host, reproduced + asserted) |
| Workload identity | `wl_v2-005-dogfood-triage-runner` |
| Causal parent (real ExecutionDigest of the `review_gate` approval statement) | `<scoped:13>` (key-independent digest of the real parent statement) |

## Surface / host

- **Runner:** `backend/tests/integration/workflow-runs/run-execute-pause-resume-reconstruct-dogfooding.ts` on the single dogfooding host. Real stack: **real PGlite** (actual PostgreSQL compiled to WASM — the platform's `pglite-database-client`, the same single persistence boundary as production `pg`) + **real migration-runner with ALL 61 migrations** (incl. `0061_workflow_runs_v2.sql`, applied and asserted) + **real identity stack** (`PgUserRepository` / `PgOrganizationRepository` / `PgMembershipRepository` / `ApiKeyAuthProvider` + `ApiKeyCredentialProvisioner` + `EnvSecretStore`, two real tenants: the operator org and an outsider org) + **REAL Fastify apps built by `buildServer`** with the REAL V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs routes, every step driven over HTTP via `app.inject()`.
- **The executed workload is REAL:** the harness writes real artifact files (`inbound-issue.json`, `fetched-issue.txt`, `draft-summary.txt`, `approval-record.json`, `notify-payload.txt`, `message-id.json`) to a real temp directory, reads the artifact bytes back from disk, and computes their real SHA-256 through `executionValueCommitment`; the observation commitments hash real `fs.stat` observation records. The attestation is signed with a REAL Ed25519 key pair from `generateAttesterKeyPair()` (`node:crypto` `generateKeyPairSync`/`sign`/`verify` — never mocked) and exported through `serializeAttestation`.
- **Clocks:** fully injected deterministic sources — a stepping run clock (base 2026-09-01T12:00:00.000Z, 1s step; the same clock object is injected into every service instance) with a settable freshness override used ONLY for the STALE experiment (12:06:00.000Z); statement freshness constants (executedAt 12:00:00.000Z, validUntil 12:05:00.000Z, issuedAt 12:00:01.000Z, epoch 7). The wall clock appears ONLY in the harness's run-instance bookkeeping lines (start/duration), printed outside the compared transcripts.

## Exact task

1. Author the real support-ticket-triage workflow with the merged V2-003 builder (semantic digest pinned to the merged V2-003/V2-014 evidence digest); create + install (pin) version 1 through the real V2-002 routes; read the installed version back over HTTP and re-verify the pin.
2. REQUEST a run of the installed version through the REAL V2-005 run route with the real operator principal, the installation pin, a webhook trigger, and real input commitments; prove duplicate-trigger and duplicate-command convergence on ONE run.
3. DRIVE the run: step started/completed records for the declared steps, capability invocations with canonical registry names (`github.repository.read`, `messaging.send`), and DISTINCT evidence classes — intent, claim, observation (real fs observations of real artifacts), human_confirmation (the review-gate approval record).
4. PAUSE mid-run AT `notify_channel`; CRASH (dispose the service instance + Fastify app mid-run); build a FRESH instance over the same database; prove the post-crash duplicate command converges and the fresh instance RESUMES to the exact step.
5. Produce a REAL V2-014 ExecutionAttestation (real Ed25519 key pair, real artifact commitments, real causal-parent execution digest, statement bound to the EXACT run/attempt/step/version/installation) and attach it through the real route — the Run boundary must verify the digest, the statement binding, and freshness, then record the binding + DISTINCT verification-class evidence.
6. Negative experiments, all typed: (a) MODIFIED (a real attestation whose statement was mutated after signing, never re-signed); (b) MISMATCHED (a real second attestation bound to a DIFFERENT real run, attached to this run); (c) REPLAY (the same valid attestation again — plus a FRESH service instance replay for durability); (d) STALE (expired validity window). None may become verification evidence.
7. UNAUTHORIZED completion from the other tenant → typed rejection, state untouched; then authorized completion.
8. RECONSTRUCT the full execution history from the persisted Run alone — a fresh service instance AND a fresh route read — asserting the timeline (registry event names in order), attempts, steps in flow order, invocations, evidence classes + provenance, the attestation binding, the typed rejections, and the 31-command exactly-once log.
9. DETERMINISM: run the whole experiment twice (fresh PGlite + fresh identity stack + fresh Ed25519 key pair per run) and compare the normalized transcripts; plus a second independent invocation of the harness.

## Starting state

Fresh PGlite database per experiment run (all 61 migrations applied fresh); fresh identity stack; fresh Ed25519 key material per run (Ed25519 cannot be seeded — disclosed below); fresh real artifacts in a fresh temp directory per run. No ambient clock, no network, no shared state between the two experiment runs.

## Expected outcome

- One run requested per trigger surface with duplicate delivery/command convergence (201 → 200 converged, same run identity).
- The lifecycle only performs legal transitions; pause/resume preserves run + attempt identity and resumes at the exact recorded step; a fresh instance over the same database reconstructs and continues the run.
- The valid attestation attaches exactly once (201) with a durable binding and exactly ONE verification-class evidence record; every negative experiment produces a typed rejection recorded durably, and none becomes verification evidence.
- Unauthorized completion is a uniform typed 404 with the run state untouched.
- The reconstructed history equals what was recorded, exactly, in both reads; the command log proves exactly-once.
- The two experiment transcripts are identical after normalizing run-scoped bookkeeping.

## Observed outcome (verbatim run transcript)

Run: `cd /home/z/worktrees/V2-005/backend && bunx tsx tests/integration/workflow-runs/run-execute-pause-resume-reconstruct-dogfooding.ts` — **exit code 0** (2026-09-02T03:33Z, wall duration ≈ 6.7 s per invocation; wall-clock lines are run-instance bookkeeping, not protocol state — all protocol clocks are injected constants). The experiment runs TWICE per invocation (run-1 primary, run-2 with a second real Ed25519 key pair + a fresh PGlite + fresh identity stack) and was executed as three independent invocations (all exit 0; transcripts byte-identical modulo the wall-clock bookkeeping lines). Run-scoped identities are shown normalized (`<scoped:N>` — capture-order placeholders for the uuid-derived org/workflow/version/installation ids, the run-derived attempt/step/invocation/evidence/event/command/rejection ids, and the key-derived attestation material + ExecutionDigest); the pinned semantic digest and all real artifact commitments are cross-run-stable constants asserted in-code.

**119/119 assertions PASS.**

```text
V2-005 workflow runs + evidence dogfooding run
work order: V2-005 (workflow runs + evidence)
tested module: backend/src/workflow-runs (PostgreSQL-authoritative run state + evidence; routes over the real Fastify buildServer)
wall clock start (ms): <run-instance bookkeeping>

--- run-1: infrastructure (real PGlite + migration-runner)
  [ok]   run-1: infra.migrations — real PGlite + migration-runner applied 61 migrations (0060 + 0061 workflow-runs present)

--- run-1: 1. install the real workflow + start a real run (real routes)
  [ok]   run-1: 1.authored-workflow-pinned — the authored support-ticket-triage semantic digest is byte-identical to the merged V2-003/V2-014 dogfooding evidence digest (571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37)
  [ok]   run-1: 1.create-workflow — POST /workflow-repository/workflows 201 — workflow <scoped:0> born with immutable version 1 (<scoped:1>)
  [ok]   run-1: 1.install-pin-version — POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (<scoped:2>, status enabled)
  [ok]   run-1: 1.read-back-pin-integrity — GET the installed version over HTTP → 200; the HTTP-read content re-parses and its semantic digest still equals the pin (571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37)
  [ok]   run-1: 1.request-run — POST /workflow-runs/runs 201 — run <scoped:3> REQUESTED (state requested)
  [ok]   run-1: 1.run-pin — the run pins the EXACT (workflow, version) tuple + the installation <scoped:2> + the pinned semantic digest 571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37
  [ok]   run-1: 1.run-input-commitments — the run's input identity is a one-way commitment digest over the real input artifact (<scoped:4>); raw input never enters
  [ok]   run-1: 1.node-identity-continuity — the execution host identity is the merged V2-004 dogfooding device host (deriveNodeKeyFingerprint over the V2-004 key seed → node_795e8b12eaef3e45)
  [ok]   run-1: 1.duplicate-event-delivery-converges — duplicate trigger delivery under a NEW command id → 200 converged on the SAME run <scoped:3> (created=false; one run per trigger surface)
  [ok]   run-1: 1.duplicate-command-replay-converges — replayed command id → 200, executed=false, converged on <scoped:3> (typed idempotent convergence, no second side effect)

--- run-1: 2. drive the run (declared steps, canonical invocations, distinct evidence)
  [ok]   run-1: 2.evidence-intent — intent evidence recorded (class intent, producer webhook trigger; no registry event — classes never impersonate protocol events)
  [ok]   run-1: 2.start-run — POST /start 200 — run RUNNING, attempt #1 running on the V2-004 dogfooding device host node_795e8b12eaef3e45
  [ok]   run-1: 2.step-started-fetch_issue — step fetch_issue started (declared by the pinned version; attempt #1)
  [ok]   run-1: 2.invocation-fetch_issue — capability invocation github.repository.read (deterministic_api) requested — canonical registry name verbatim (<scoped:5>)
  [ok]   run-1: 2.invocation-completed-fetch_issue — invocation github.repository.read completed (the executor's claimed outcome — a claim, never side-effect evidence)
  [ok]   run-1: 2.step-completed-fetch_issue — step fetch_issue completed (succeeded)
  [ok]   run-1: 2.step-started-draft_summary — step draft_summary started (declared by the pinned version; attempt #1)
  [ok]   run-1: 2.invocation-draft_summary — capability invocation github.repository.read (agentic_computer_use) requested — canonical registry name verbatim (<scoped:6>)
  [ok]   run-1: 2.invocation-completed-draft_summary — invocation github.repository.read completed (the executor's claimed outcome — a claim, never side-effect evidence)
  [ok]   run-1: 2.step-completed-draft_summary — step draft_summary completed (succeeded)
  [ok]   run-1: 2.evidence-claim — claim evidence recorded as class claim (a model/executor assertion is NEVER observation or verification evidence — constitution §7)
  [ok]   run-1: 2.evidence-observation — observation evidence recorded from a REAL local artifact observation (<scoped:7> — real sha-256 over the real fs observation record)
  [ok]   run-1: 2.observation-projects-registry-event — the observation evidence projects the registry event observation.recorded into the timeline
  [ok]   run-1: 2.step-started-review_gate — step review_gate started (the DECLARED human-approval step)
  [ok]   run-1: 2.evidence-human-confirmation — human_confirmation evidence recorded (class human_confirmation, producer human/operator, real approval-record commitment <scoped:8>)
  [ok]   run-1: 2.step-completed-review_gate — step review_gate completed (succeeded, approved)

--- run-1: 3. pause mid-run at notify_channel (before the crash)
  [ok]   run-1: 3.pause-mid-run — POST /pause 200 — run PAUSED, attempt #1 suspended AT step notify_channel (the exact recorded resume point)

--- run-1: 4. CRASH — service instance destroyed mid-run; FRESH instance over the same database
  [ok]   run-1: 4.post-crash-duplicate-command-converges — post-crash replay of the pause command id → 200, executed=false (converged on the recorded outcome; NO second side effect)
  [ok]   run-1: 4.fresh-instance-resumes-to-exact-step — the FRESH instance RESUMED the reconstructed run to the EXACT step notify_channel (same attempt #1, newAttempt=false — resume is not a restart)
  [ok]   run-1: 2.step-started-notify_channel — step notify_channel started (declared by the pinned version; attempt #1)
  [ok]   run-1: 2.invocation-notify_channel — capability invocation messaging.send (deterministic_api) requested — canonical registry name verbatim (<scoped:9>)
  [ok]   run-1: 2.invocation-completed-notify_channel — invocation messaging.send completed (the executor's claimed outcome — a claim, never side-effect evidence)
  [ok]   run-1: 2.step-completed-notify_channel — step notify_channel completed (succeeded)
  [ok]   run-1: 4.evidence-observation-notify — post-crash observation evidence recorded for the delivered notification artifact (class observation, distinct from the claim)

--- run-1: 5. produce + attach a REAL V2-014 ExecutionAttestation (real Ed25519, real artifacts)
  [ok]   run-1: 5.statement-validates — the composed statement validates against the V2-014 schema (bound to the EXACT run/attempt/step/version/deployment, real artifact commitments, real causal parent)
  [ok]   run-1: 5.attestation-privacy — real Ed25519 attestation produced (2202 canonical chars); the bytes carry the artifact COMMITMENT, never the payload text or the secret ref
        attestation identity <scoped:10> (attester key <scoped:11>, assurance software_signed)
        ExecutionDigest <scoped:12> (domain workflowos/execution-statement/v1)
        causal parent ExecutionDigest <scoped:13> (the review_gate approval fact)
  [ok]   run-1: 5.attach-attestation — POST /attestations 201 — the Run boundary VERIFIED the digest, the run/attempt/step binding, and freshness, then recorded the binding (<scoped:10>)
  [ok]   run-1: 5.attach-records-verification-evidence — the attach recorded DISTINCT verification-class evidence (content commitment = the ExecutionDigest — one-way by V2-014 construction)

--- run-1: 6. negative experiments (modified / mismatched / replayed / stale — ALL typed)
  [ok]   run-1: 6a.modified-attestation-rejected — MODIFIED attestation (a real attestation whose statement was mutated after signing, never re-signed) → 422 RUN_ATTESTATION_REJECTED (typed; the digest/signature no longer commit to the delivered statement; never attached)
  [ok]   run-1: 6b.mismatched-attestation-rejected — MISMATCHED attestation (a REAL second attestation bound to run <scoped:14>, attached to run <scoped:3>) → 422 typed rejection (the statement's run identity must match the record it is attached to)
  [ok]   run-1: 6c.replayed-attestation-rejected — the SAME valid attestation again → typed RUN_ATTESTATION_REJECTED with the durable failureCode ATTESTATION_REPLAYED (single-use consumption: the persisted binding row IS the nonce consumption)
  [ok]   run-1: 6c.durable-replay-across-instances — a FRESH service instance also rejects the replayed attestation (durable replay state — V2-014's InMemoryReplayRegistry was reference-only; durable single-use state is V2-005's)
  [ok]   run-1: 6d.stale-attestation-rejected — STALE attestation (validity expired at 2026-09-01T12:05:00.000Z; boundary clock 2026-09-01T12:06:00.000Z) → 422 typed rejection (freshness is mandatory — timestamps alone are not a replay defense)

--- run-1: 7. unauthorized completion attempt (cross-tenant) → typed 404; then authorized complete
  [ok]   run-1: 7.cross-tenant-read-uniform-404 — cross-tenant run read → uniform 404 workflow-run-not-found (zero existence leakage)
  [ok]   run-1: 7.unauthorized-completion-rejected — UNAUTHORIZED completion from the other tenant → typed 404 RUN_NOT_FOUND; the run state is untouched
  [ok]   run-1: 7.run-state-untouched — operator re-read: the run is still running (the rejected command left no trace on the lifecycle)
  [ok]   run-1: 7.authorized-completion — authorized completion → 200; run COMPLETED (terminal), attempt #1 ended (the claimed output is a commitment, never raw output)

--- run-1: 8. reconstruct the execution history from the persisted Run alone (fresh instance + fresh route read)
  [ok]   run-1: 8.fresh-instance-reconstruction-equals-route-read — a FRESH service instance over the same database reconstructed the history EXACTLY equal to the route read (run, timeline, attempts, steps, invocations, evidence, attestations, rejections, commands)
  [ok]   run-1: 8.reconstruction-run-state — the reconstructed run is the same durable identity <scoped:3> in terminal state completed
  [ok]   run-1: 8.timeline-reconstructed-in-order — the reconstructed state timeline (registry event names, in order): workflow.run.requested → workflow.run.started → workflow.step.started → capability.invocation.requested → capability.invocation.completed → workflow.step.completed → workflow.step.started → capability.invocation.requested → capability.invocation.completed → workflow.step.completed → observation.recorded → workflow.step.started → workflow.step.completed → workflow.run.paused → workflow.run.resumed → workflow.step.started → capability.invocation.requested → capability.invocation.completed → workflow.step.completed → observation.recorded → execution.attestation.verified → verification.completed → workflow.run.completed
  [ok]   run-1: 8.attempts-reconstructed — one execution attempt reconstructed (attempt #1: running → suspended(at notify_channel) → running → ended with the run)
  [ok]   run-1: 8.steps-reconstructed-in-flow-order — the declared steps reconstructed in flow order, all completed/succeeded: fetch_issue → draft_summary → review_gate → notify_channel
  [ok]   run-1: 8.invocations-reconstructed-canonical — capability invocations reconstructed with canonical registry names + the four registry execution classes: github.repository.read(deterministic_api), github.repository.read(agentic_computer_use), messaging.send(deterministic_api)
  [ok]   run-1: 8.evidence-reconstructed-with-classes-and-provenance — evidence reconstructed with DISTINCT classes + provenance: intent@trigger, claim@executor, observation@executor, human_confirmation@human, observation@executor, verification@verifier
  [ok]   run-1: 8.attestation-binding-reconstructed — the attestation binding reconstructed: bound to attempt #1 / step notify_channel with the verified ExecutionDigest + attester key identity
  [ok]   run-1: 8.typed-rejections-reconstructed — all typed boundary rejections reconstructed durably: ATTESTATION_SIGNATURE_INVALID, ATTESTATION_BINDING_MISMATCH, ATTESTATION_REPLAYED, ATTESTATION_REPLAYED, ATTESTATION_EXPIRED (append-only audit — never erased, never evidence)
  [ok]   run-1: 8.no-negative-became-verification-evidence — exactly ONE verification-class evidence record exists (the valid attach); no modified/mismatched/replayed/stale attestation became verification evidence
  [ok]   run-1: 8.command-log-proves-exactly-once — the command log reconstructs 31 distinct exactly-once commands (replayed command ids converged — ONE pause_run; the 5 rejected attach commands are durably typed)
        reconstructed command types: request_run, record_evidence, start_run, record_step_started, record_invocation_requested, record_invocation_completed, record_step_completed, pause_run, resume_run, attach_attestation, complete_run

--- run-2: (the whole experiment repeated over a FRESH PGlite + fresh identity stack + second real Ed25519 key pair — 59/59 assertions PASS, all lines identical to run-1 modulo the label)

--- determinism (the whole experiment run twice; fresh PGlite + fresh identity stack + fresh Ed25519 key pair per run)
  [ok]   determinism — the two transcripts are IDENTICAL after normalizing run-scoped bookkeeping (uuid-derived org/workflow/version/installation ids, run-derived ids, key-derived attestation material); every state transition, event order, evidence class, typed rejection, and reconstruction projection is byte-stable
RESULT: a real workflow executed, paused/resumed to the exact step through a fresh instance after a mid-run crash, a REAL attestation attached through the verified Run boundary, all negative experiments typed, the execution history reconstructed exactly from the persisted Run alone, determinism proven
wall duration (ms): <run-instance bookkeeping>
OBSERVATION (scope, not failure): no real PostgreSQL server is reachable in this sandbox (PGlite is real PostgreSQL compiled to WASM — the same single persistence boundary; true multi-connection contention runs in the env-gated real-PG CI workflow, mirrored by the env-gated concurrency regression). The executor harness is the module's own command surface driven over the real routes (real computer-use execution is V2-008; scheduling/events are V2-009) — the Run records what the commanded execution path reports, and the attestation binds it. The operator is the implementing agent. Attestation semantics are V2-014's frozen contract (consumed through the merged verifier; durable single-use replay state is V2-005's, as the persisted V2-014 evidence limitation requires).
DETERMINISM NOTE: re-running this harness yields identical transcripts after normalizing run-scoped bookkeeping (the uuid-derived repository identities and the run ids they pin, key-derived attestation identities/digests/signatures, and wall duration); the pinned WorkflowVersion semantic digest and all real artifact commitments are cross-run-stable constants asserted in-code.
```

## Evidence references

- Red battery (test-only, proven red at commit time): `9f4aa1d374914aea770ab69ef597216dc545ee6c` `test(workflow-runs): deterministic red battery for V2-005` (16 test files / 3122 insertions, zero src).
- Red-battery alignment: `c31ffd1b4c5e28403f6cd593a01c5e146e412ade` `test(workflow-runs): align red battery fixture with valid V2-003 IR (approval outcome coverage)`.
- Green implementation: `793ed0b86a4fa55d86b1bbe0bc73868f8b690705` `feat(workflow-runs): implement V2-005 workflow run state + evidence persistence` (module + migration 0061 + route + minimal server registration; scoped suites 15 files / 119 tests green).
- Dogfooding harness (this evidence's runner): `2b83140` `test(workflow-runs): V2-005 execute-pause-resume-reconstruct dogfooding harness`.
- Dogfooding evidence (this file) commit: see the worklog/PR body for the final head SHA.
- Merged sibling dogfooding evidence consumed for reference-data continuity: `V2-003-workflow-ir-round-trip.md` (semantic digest 571a0788…), `V2-004-two-host-capability-discovery.md` (device host node_795e8b12eaef3e45), `V2-014-attestation-replay-rejection.md` (the attestation production pattern + the persisted limitation that durable replay state is V2-005's).

## Duration / cost

≈ 6.7 s wall per harness invocation (three invocations: two identical pre-evidence runs + the evidence run; each invocation runs the full experiment twice). ~61 migrations applied per experiment run.

## Failure classification

**PASS** — every assertion held on every invocation; no contract, UX, or operational failure observed. Two harness-only fixes were made during harness bring-up (both before any evidence run; the module was never wrong):
1. the harness initially drove a post-crash step through the disposed Fastify app (`FST_ERR_REOPENED_CLOSE_SERVER`) — fixed by parameterizing the app per phase;
2. the initial MODIFIED negative mutated the ALREADY-ATTACHED attestation's statement, which correctly surfaces as the durable REPLAY rejection first (the attestation identity is already consumed) — redesigned to the honest in-transit mutation model (a real never-attached attestation whose statement is mutated after signing, never re-signed), which produces the expected `ATTESTATION_SIGNATURE_INVALID` typed rejection. The module's behavior was correct in both cases; the initial experiment design was not.

## Resulting action

V2-005 remains implemented/pending-architect-merge (the architect's merge is the sole completion event). The dogfooding PASS is recorded for the completion gate; no corrective Work Order is required from this experiment.

## Honest limitations (recorded, never silent)

1. **No real PostgreSQL server in this sandbox** — PGlite is real PostgreSQL compiled to WASM (the same single persistence boundary, the same DDL triggers/constraints, the same SQL semantics). True multi-connection contention is covered by the env-gated real-PG regression (`tests/integration/workflow-runs/workflow-runs.concurrency-idempotency.integration.test.ts`, gated on `WORKFLOWOS_DATABASE_URL`, the repo's established pattern); the orchestrator's real-PG CI re-runs it.
2. **The executor is the module's own command surface** — the harness drives the real HTTP routes as the execution host; real computer-use execution is V2-008 and scheduling/event triggers are V2-009. The Run honestly records what the commanded execution path reports, and the V2-014 attestation binds it — exactly the boundary V2-005 owns.
3. **The operator is the implementing agent** acting through the real API (no independently recruited human); the human-approval step is recorded as real human_confirmation evidence produced by the operator's real approval record.
4. **Ed25519 key material cannot be seeded** — each experiment run uses a fresh real key pair; key-derived material (attester key id, attestation identity, signature, and the digests that bind run-scoped identities) is normalized in the transcript comparison and disclosed here. The WorkflowVersion semantic digest, the content/input digests, and all real artifact commitments are key-independent and were asserted identical across runs.
5. **Attestation semantics are V2-014's frozen contract** — consumed read-only through the merged verifier barrel; the Run boundary adds only run-derived binding expectations and durable single-use replay state (explicitly V2-005's per the persisted V2-014 evidence limitation). This module never redefines attestation semantics and never treats a signature as automatic side-effect proof.
6. **One vocabulary observation (non-blocking):** the frozen registry defines no cancellation or attempt-interruption EVENT, so the module records those two timeline transitions under deliberately module-scoped names (`run.cancelled`, `run.attempt.interrupted`) that never pose as registry protocol event names — pinned by the registry-conformance battery and recorded here as an honest observation for a possible future governed registry extension.

## Findings

None blocking. No frozen-concept contradiction; no stop condition triggered. The two harness-only bring-up fixes are disclosed above (module never wrong). Carried-forward non-blocking observations: canonical-JSON helpers remain module-internal per domain (IG-001 consolidation candidate, W1 finding); the registry vocabulary observation in limitation 6.
