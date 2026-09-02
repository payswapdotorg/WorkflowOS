# V2-009 — Scheduling + Events + Placement — Dogfooding Evidence

**Work Order:** V2-009 — Scheduling + Events + Placement (wave W4)
**Classification of capability:** execution-facing trigger layer (deployment placement policy, schedule definitions, typed event subscriptions, the deduplicated event inbox, trigger deliveries with placement resolution and event/run correlation) — a workflow-launching capability
**Validation type:** real-product experiment (work-order dogfooding requirement, literal frozen clause: "Run one controlled scheduled workflow and one supported device/application event workflow, verifying duplicate suppression and placement behavior")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; the Work Order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-009 — Scheduling + Events + Placement, wave W4, branch `feat/v2-009-events-schedules-triggers`, base `b349233ba735db4a68732005cf544ef1a35c23b6` (merged main: V2-002/V2-003/V2-004/V2-005/V2-006/V2-007/V2-008/V2-014 + IG-001 + IG-002 + governance reconciliation all frozen on this base).

## Workflow / version under test

**The "morning-briefing" workflow** — authored through the real V2-003 builder (`createWorkflowIrBuilder`), persisted and INSTALLED (pinned immutable version 1) through the real V2-002 HTTP routes:

- one declared step `send_briefing` (`deterministic_api`, capability `messaging.send`, placement `cloud_allowed`, completion evidence `observation`), one workflow input `briefing`.
- The deployment pins the SAME immutable (workflow, version) tuple the installation pins (V2-002's WorkflowDeployment forward note discharged by V2-009).

## Surface / host

**The full real stack**: real PGlite (PostgreSQL compiled to WASM — the platform's pglite-database-client, the same single persistence boundary as production `pg`) with ALL 62 migrations (including V2-009's `0062_workflow_deployments_v2.sql`) applied by the real migration-runner; the real identity stack (users/organizations/memberships/API-key credential provisioner + auth provider); a REAL Fastify app built by `buildServer` with the REAL V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs routes AND the REAL V2-009 workflow-deployments routes — every step driven over HTTP via `app.inject()`.

**A REAL device node**: registered through the REAL V2-004 protocol (key enrollment from the SHA-256 seed `sha256('v2-009-test-node-key:v2-009-dogfooding-device')` → nonce challenge → HMAC-SHA256 challenge-response → registration → trust tier `trusted`), platform class `desktop`, location class `device`, node id `node_b5c32e06e6dd95fd`.

## Exact task

1. **THE CONTROLLED SCHEDULED WORKFLOW**: deploy the pinned version with a `device_preferred` placement policy and a **daily 09:00 Africa/Accra** wall-clock schedule (the user's timezone), advance the injected deterministic clock past the 09:00Z boundary and drive the engine tick through the real HTTP route.
2. **THE SUPPORTED DEVICE/APPLICATION EVENT WORKFLOW**: a second deployment subscribes to `file.changed` events (typed schema, source-filtered to the device node, matching the REAL path of a REAL file written to the real filesystem with its real sha-256 digest); the event is delivered through the real ingest route.
3. **DUPLICATE SUPPRESSION**: deliver the exact same (source, eventId) again; verify convergence (no second run, no second side effect).
4. **PLACEMENT BEHAVIOR**: verify the placement resolution recorded on every delivery (node, placement, rank), plus the offline-device recovery path (a localOnly deployment with no device in its isolated directory PENDS with a typed placement failure; the device's real V2-004 registration recovers the delivery).
5. **NEGATIVE**: a disabled deployment's due occurrence is honestly skipped (no run) — enable/disable semantics are real.

## Starting state

Fresh real stack (fresh PGlite + fresh identity stack) per run; the shared deterministic injected clock (the run boundary, the trigger boundary and the node directory all observe the same epoch); fixed node key seeds; the real sandboxed temp dir for the event source file. No network, no wall-clock dependence in product logic, no randomness.

## Expected outcome

- The scheduled workflow fires exactly once at 09:00Z (Africa/Accra is GMT+0): one run created through the V2-005 boundary with trigger type `schedule` and the occurrence identity; the delivery records the resolved device node at placement rank 0.
- The event workflow creates exactly one run with trigger type `file_event`; the run's trigger identity embeds the inbox event identity (event/run correlation).
- The duplicate event converges: HTTP 200, `created=false`, zero new deliveries, exactly 2 runs total (1 schedule + 1 event).
- The offline-device delivery recovers after real registration.
- The disabled deployment's occurrence is `skipped_disabled`.

## Observed outcome (verbatim run transcript)

```text
=== V2-009 dogfooding RUN 1 (fresh PGlite + fresh identity stack) ===
# device node registered through the real V2-004 protocol: platform=desktop location=device trust=trusted
# workflow created + installed (pinned immutable version 1) through the real V2-002 routes
# deployment 'morning-briefing-daily' created (device_preferred) with a DAILY 09:00 Africa/Accra schedule
# tick fired the 09:00 occurrence: deliveriesDelivered=1 occurrencesConsidered=1
# scheduled delivery state=delivered scheduledAt=2026-09-02T09:00:00.000Z resolution=normal
# placement resolved: node=node_b5c32e06e6dd95fd placement=device_preferred rank=0
# run created through the real V2-005 boundary: state=requested trigger={"type":"schedule","id":"sch:sub_d955d9bb0d18af90:2026-09-02T09:00:00.000Z"}
# real event source file written: /tmp/v2-009-dogfooding-ByzPgl/inbox/morning-briefing.md (sha-256 0c39d07c15982cd3…)
# event subscription: file.changed sourced from the device, matching the real file path (typed schema)
# event delivered: matched 1 subscription, delivery state=delivered run=wfr_7d41dda7cf338de92e059e1c18ec9977
# event/run correlation: the run's trigger identity = {"type":"file_event","id":"evt:evt_bc0874b70b5015f2:sub_b537fd2bcd6cbd87"}
# DUPLICATE event delivered again: HTTP 200 created=false newDeliveries=0
# runs after the duplicate: exactly 2 (1 scheduled + 1 event — NO second side effect)
# offline device (isolated empty directory): delivery state=pending attempts=1 outcome=placement_unavailable
# device recovered through the real protocol: delivery state=delivered node=node_5305fcdb6b758528 run=created
# disabled deployment: skippedDisabled=1 delivered=0 (enable/disable is real)
# PASS: scheduled workflow fired, event workflow delivered, duplicate suppressed, placement recorded + recovered

=== V2-009 dogfooding RUN 2 (fresh PGlite + fresh identity stack) ===
(…byte-identical after normalizing run-scoped bookkeeping — uuid-derived ids, the derived
dep_/sub_/evt_/dlv_/run_/node_/wfr_ ids, the mkdtemp sandbox suffixes…)

determinism: transcripts IDENTICAL after normalization

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
```

Every element of the expected outcome was observed. The two-run determinism comparison follows the V2-005/V2-006 precedent (fresh PGlite + fresh identity stack per run; transcripts compared after normalizing run-scoped bookkeeping).

## Duration / cost

Each full experiment run (stack build + migrations + both workflow paths + duplicate + recovery + negative + second full run): ~6–7 s wall-clock on the sandbox (PGlite in-process; no network).

## Evidence references

- Runner (executable evidence): `backend/tests/integration/workflow-deployments/run-scheduled-and-event-trigger-dogfooding.ts` (run with `bunx tsx` from `backend/`).
- The deterministic harness: `backend/tests/integration/workflow-deployments/trigger-test-support.ts`.
- The durable state: PGlite tables `wfos_v2_deployments`, `wfos_v2_trigger_subscriptions`, `wfos_v2_inbound_events`, `wfos_v2_trigger_deliveries` (migration `0062_workflow_deployments_v2.sql`); the runs in `wfos_v2_runs` (V2-005's tables, created through the merged boundary).
- The regression batteries: `backend/tests/unit/workflow-deployments/` (8 files / 94 tests) and `backend/tests/integration/workflow-deployments/` (2 files / 26 tests) — every required regression of the work order has a deterministic test.

## Classification

**PASS** — the frozen dogfooding clause is satisfied end-to-end on the real integrated paths:
- one controlled scheduled workflow (daily 09:00 Africa/Accra — the user's timezone — fired through the real tick route with the injected clock);
- one supported device event workflow (a real `file.changed` event with a real file's real digest, sourced from the real V2-004-registered device);
- duplicate suppression proven (HTTP 200 converged, zero new deliveries, exactly one event run — the V2-009 inbox dedup AND the V2-005 run-level convergence both hold);
- placement behavior proven (the device_preferred policy resolved the real device node at rank 0 on both deliveries; the localOnly/offline path pended with a typed placement failure and recovered after real registration).

## Limitations (recorded honestly)

1. The tick is driven EXPLICITLY (the real HTTP route + the real injected clock); V2-009 deliberately ships no ambient background scheduler (constitution §19: no hidden autonomous engine). Production cadence is a platform concern (a worker calling the same route).
2. The offline-device recovery segment drives the module's SERVICE boundary directly (not the HTTP route) because the segment needs an ISOLATED node directory, while the single HTTP app is wired to the shared directory. The route is transport-only; the service is the module authority — the same boundary, honestly disclosed.
3. The dogfooding clock advances are injected determinism (not wall-clock waits); the wall-clock timezone math is proven separately by the timezone-boundary unit battery (DST gap/ambiguity + Africa/Accra).
4. The event payload for `file.changed` carries the real path + real sha-256 digest of a real file; the FILESYSTEM WATCHER that would produce such events autonomously is outside V2-009's frozen scope (the inbox ingest boundary + typed schemas are the owned surface).
5. The workflow's execution (the run's steps) is V2-008's/V2-005's concern; this experiment verifies the TRIGGER layer (launch + placement + correlation), exactly the Work Order's scope.

## Resulting action

No V2-009 contract defect discovered by the experiment. The Work Order is READY_FOR_ARCHITECT_REVIEW with this evidence persisted; the merge remains the architect's.
