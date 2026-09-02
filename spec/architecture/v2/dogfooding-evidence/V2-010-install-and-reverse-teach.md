# V2-010 — Reverse Teaching — Dogfooding Evidence

**Work Order:** V2-010 — Reverse Teaching (wave W4)
**Classification of capability:** user-facing teaching capability (the TEACH ME mode: install a workflow, derive the manual-task lesson from its semantics, a person performs the task by hand) — a learning surface, never an execution surface
**Validation type:** real-product experiment (work-order dogfooding requirement, literal frozen clause: "Install a real workflow, invoke reverse teaching, have a real person follow the lesson, then compare the taught task with direct workflow execution")
**Status:** EVIDENCE PERSISTED — experiment run through the real integrated paths; the Work Order remains pending-architect-merge (agents never mark COMPLETE)

## Work Order ID

V2-010 — Reverse Teaching, wave W4, branch `feat/v2-010-reverse-teaching`, base `85882da8a6247537799c59537005bda1e5a71672` (merged main: V2-002/V2-003/V2-004/V2-005/V2-006/V2-007/V2-008/V2-009/V2-014 + IG-001 + IG-002 + governance reconciliation all frozen on this base).

## Workflow / version under test

**The "daily-customer-followup" workflow** — authored through the real V2-003 builder (`createWorkflowIrBuilder`), created and INSTALLED (pinned immutable version 1) through the real V2-002 HTTP routes:

- 6 declared steps exercising every manual-actionability class and both safety classifications: `fetch_open_tickets` (deterministic_api `github.repository.read`), `draft_followup` (agentic_computer_use — the agent's drafting task; declares the V2-008-sensitive `filesystem.read`), `approve_draft` (human approval, approved/rejected outcomes), `record_outcome` (human information step — declares the V2-008-sensitive `spreadsheet.edit`), `escalate_backlog` (subworkflow reference), `send_followup` (deterministic_api `messaging.send` with a `secret_ref` binding).
- One workflow input `ticketQuery`, one workflow output `messageId`, an approval decision with approved AND rejected continuations.

## Surface / host

**The full real stack**: real PGlite (PostgreSQL compiled to WASM — the platform's test-database boundary, the same single persistence surface as production `pg`) with ALL 62 migrations applied by the real migration-runner; the real identity stack (users/organizations/memberships + API-key credential provisioner + auth provider); a REAL Fastify app built by `buildServer` with the REAL V2-002 workflow-repository routes AND the REAL V2-005 workflow-runs routes — every repository, run, and installation step driven over HTTP via `app.inject()`.

**The teach path**: the V2-010 public API (`src/reverse-teaching/index.ts` barrel) — `DefaultReverseTeachingSessionService` over `InMemoryReverseTeachingSessionStore` (the reference composition for the store port, the exact V2-006 precedent; durable session persistence is a separately-owned later concern). The reverse-teaching lesson derivation composes the merged V2-006 lesson derivation verbatim; the unsafe-instruction gate consumes the merged V2-008 sensitive-capability vocabulary; the digest verification consumes the merged V2-003 barrel. No mock anywhere in this Work Order's control boundary.

**Host:** local dev sandbox, Node 24 via `bunx tsx`, PGlite in-memory. (CI equivalent: real PostgreSQL behind `WORKFLOWOS_DATABASE_URL`; unset in this environment, recorded honestly.)

**Reproducible experiment path:** `backend/tests/integration/reverse-teaching/run-install-and-reverse-teach-dogfooding.ts` (`bunx tsx tests/integration/reverse-teaching/run-install-and-reverse-teach-dogfooding.ts` from `backend/`).

## Exact task (the Work Order's required experiment)

1. **INSTALL** — author the daily-customer-followup workflow (merged V2-003 builder), create it through the real V2-002 route (born with immutable version 1), INSTALL/pin version 1 through the real installations route, read the version back over HTTP, compute the pinned semantic digest with the merged V2-003 barrel.
2. **REVERSE-TEACH** — create a reverse-teaching session bound to the INSTALLATION pin (installationId + workflow + version + semantic digest, carried as data) through the V2-010 public API; the real person (the operator/learner driving the lesson): reads the derived manual view (purpose, prerequisites, decision points, expected outcomes, uncertainty disclosures); attempts the safety-gated drafting step BEFORE acknowledging its sensitive-capability notice (the typed negative); acknowledges the notice explicitly; performs the performable steps BY HAND with REAL artifacts (the follow-up message drafted by hand and written to a real file; the customer response recorded in a real spreadsheet file); pauses mid-lesson and resumes to the exact pending step; acknowledges the disclosed system-performed and subworkflow-delegated steps; finalizes.
3. **ZERO RUNS** — the real V2-005 list surface on the same database must be EMPTY after the complete manual lesson (the execution/teaching distinction).
4. **COMPARE WITH DIRECT EXECUTION** — request a run for the SAME pinned version through the real V2-005 HTTP route (the AUTOMATE ME mode), drive it through the real run boundary exactly as an executor would (start → per-step started → canonical capability invocations with output commitments → step completed → complete), and compare the executed run with the taught task.
5. **NO MUTATION** — the installed version re-read over HTTP must be byte-identical; the installation must still pin v1.

## Starting state

Fresh real stack (fresh PGlite + fresh identity stack) per run; the deterministic injected sources (sequential ids, stepping clocks) on both the teaching service and the run service; fixed learner content. No network, no wall-clock dependence in product logic, no randomness.

## Expected outcome

1. The workflow is installed and pinned exactly as authored (version 1; the HTTP-read content re-parses and its semantic digest matches the pin).
2. The reverse-teaching lesson is derived as a view over the installed version: 6 manual steps in the canonical order; every manual instruction is a fixed-template rendering of a declared fact only; 2 system-performed steps disclose that NO manual equivalent is declared; 1 subworkflow step discloses that its procedure lives in the referenced version — nothing invented.
3. The unsafe-instruction gate holds: the drafting step (sensitive `filesystem.read`) rejects manual performance before the explicit safety acknowledgment; after it, the performance is accepted.
4. The person performs the whole task by hand (3 performable steps with real artifacts + 3 disclosure acknowledgments), pausing and resuming to the exact pending step; 9 teaching-evidence records, each in the teaching class and each pinned to the installed version.
5. ZERO runs exist after the manual lesson.
6. The direct-execution run for the same pinned version executes all six declared steps through the real V2-005 boundary and completes; its declared steps ARE the lesson's steps; its recorded output commitment for the drafting step equals the sha-256 of the real file the person produced by hand.
7. The installed version is byte-identical after both modes; the installation still pins v1.

## Observed outcome (verbatim run transcript)

```text
=== V2-010 dogfooding RUN 2 (fresh PGlite + fresh identity stack) ===

--- 1. install the real workflow (real V2-002 routes over real PGlite) ---
[PASS] 1.create-workflow :: POST /workflow-repository/workflows 201 — workflow born with immutable version 1 (wfw_1c4db…2fa0)
[PASS] 1.install-pin-version :: POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (wfin_a3a4…ab9c, status enabled)
[PASS] 1.read-back-pin-integrity :: GET the installed version over HTTP → 200; the HTTP-read content re-parses (content digest a4994c005…e195)
[PASS] 1.install-semantic-digest :: pinned WorkflowVersion semantic digest (merged V2-003 barrel): be8f0d8d8…8ebc

--- 2. reverse-teach (the real person follows the lesson, real manual artifacts) ---
[PASS] 2.session-created :: reverse-teaching session rt_1 bound to the INSTALLED version (installation wfin_a3a4…ab9c carried as data)
[PASS] 2.lesson-begun :: lesson begun: 6 manual steps in canonical order (fetch_open_tickets → draft_followup → approve_draft → record_outcome → escalate_backlog → send_followup)
[PASS] 2.purpose-extracted :: purpose extracted (fixed template over declared facts; inputs/outputs/provenance composed from the V2-006 base lesson)
[PASS] 2.decision-points-extracted :: decision points extracted: the person decides approval (approved/rejected) and provides the response
[PASS] 2.uncertainty-disclosed :: uncertainty disclosed: 2 system-performed steps declare NO manual equivalent, 1 subworkflow delegates its procedure (nothing invented)
[PASS] 2.unsafe-instruction-gated :: the safety-gated drafting step (filesystem.read is sensitive per the V2-008 vocabulary) REJECTS performance before the explicit acknowledgment
[PASS] 2.manual-draft-performed :: the person REALLY drafted the follow-up by hand (real file /tmp/v2-010-dogfood-qcqIrx/drafts/followup-draft.txt, sha-256 67e8767c4…a0b1) after acknowledging the safety notice
[PASS] 2.pause-resume-exact-step :: paused mid-lesson and resumed to the EXACT pending step (record_outcome)
[PASS] 2.lesson-finalized :: lesson finalized: 3 steps performed by hand + 3 disclosed steps acknowledged = the whole task, completed
[PASS] 2.teaching-evidence-only :: all 9 evidence records are TEACHING evidence (learning facts), each pinned to the installed version — no execution evidence anywhere

--- 3. zero runs — the manual lesson created no execution records ---
[PASS] 3.zero-runs :: the real V2-005 list surface on the same database: 0 runs after the complete manual lesson

--- 4. direct workflow execution through the real V2-005 boundary (the comparison) ---
[PASS] 4.request-run :: POST /workflow-runs/runs 201 — run wfr_67f14…14d8 REQUESTED for the SAME pinned version (trigger manual)
[PASS] 4.run-pins-the-same-version :: the run pins the EXACT same (workflow, version, installation) tuple and semantic digest the lesson was derived from
[PASS] 4.start-run :: POST /start 200 — the direct-execution run is RUNNING
[PASS] 4.step-started-fetch_open_tickets :: step fetch_open_tickets started (declared by the pinned version)
[PASS] 4.invocation-fetch_open_tickets :: capability invocation github.repository.read (deterministic_api) — canonical registry name verbatim
[PASS] 4.invocation-completed-fetch_open_tickets :: invocation github.repository.read completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-fetch_open_tickets :: step fetch_open_tickets completed (succeeded)
[PASS] 4.step-started-draft_followup :: step draft_followup started (declared by the pinned version)
[PASS] 4.invocation-draft_followup :: capability invocation filesystem.read (agentic_computer_use) — canonical registry name verbatim
[PASS] 4.invocation-completed-draft_followup :: invocation filesystem.read completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-draft_followup :: step draft_followup completed (succeeded)
[PASS] 4.step-started-approve_draft :: step approve_draft started (declared by the pinned version)
[PASS] 4.invocation-approve_draft :: capability invocation workflow.execute (human) — canonical registry name verbatim
[PASS] 4.invocation-completed-approve_draft :: invocation workflow.execute completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-approve_draft :: step approve_draft completed (succeeded)
[PASS] 4.step-started-record_outcome :: step record_outcome started (declared by the pinned version)
[PASS] 4.invocation-record_outcome :: capability invocation spreadsheet.edit (human) — canonical registry name verbatim
[PASS] 4.invocation-completed-record_outcome :: invocation spreadsheet.edit completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-record_outcome :: step record_outcome completed (succeeded)
[PASS] 4.step-started-escalate_backlog :: step escalate_backlog started (declared by the pinned version)
[PASS] 4.invocation-escalate_backlog :: capability invocation workflow.execute (subworkflow) — canonical registry name verbatim
[PASS] 4.invocation-completed-escalate_backlog :: invocation workflow.execute completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-escalate_backlog :: step escalate_backlog completed (succeeded)
[PASS] 4.step-started-send_followup :: step send_followup started (declared by the pinned version)
[PASS] 4.invocation-send_followup :: capability invocation messaging.send (deterministic_api) — canonical registry name verbatim
[PASS] 4.invocation-completed-send_followup :: invocation messaging.send completed (executor's claimed outcome; commitments only)
[PASS] 4.step-completed-send_followup :: step send_followup completed (succeeded)
[PASS] 4.run-completed :: POST /complete 200 — the direct-execution run SUCCEEDED (all six declared steps executed)
[PASS] 4.comparison-same-steps :: COMPARISON: the executed run's declared steps == the taught lesson's steps (same pinned version → the same task in both modes)
[PASS] 4.comparison-same-artifact :: COMPARISON: the person's hand-drafted file sha-256 67e8767c4…a0b1 == the run's recorded output commitment for the drafting step (same input → same outcome artifact through both modes)

--- 5. no mutation — the installed version is untouched ---
[PASS] 5.installed-version-identical :: the installed version re-read over HTTP is byte-identical after BOTH the manual lesson and the direct execution
[PASS] 5.installation-still-pins-v1 :: the installation still pins version 1 (enabled)

# RUN 2 summary: all checks PASS

(RUN 1 transcript: byte-identical to RUN 2 above after normalizing run-scoped
 bookkeeping — uuid-derived org/user/version/installation/run ids, the mkdtemp
 sandbox suffixes, the run labels — the full RUN 1 transcript is reproduced by
 simply running this runner; both runs share the same deterministic content digests.)

determinism: transcripts IDENTICAL after normalization

DOGFOODING RESULT: PASS (deterministic across two fresh runs)
```

Every element of the expected outcome was observed (43 checks PASS, 0 failures, exit code 0). The two-run determinism comparison follows the V2-005/V2-006/V2-009 precedent (fresh PGlite + fresh identity stack per run; transcripts compared after normalizing run-scoped bookkeeping).

## Duration / cost

Each full experiment run (stack build + migrations + install + the complete manual lesson + the full direct-execution run + no-mutation re-reads + the second full run + the determinism comparison): ~4–5 s wall-clock on the sandbox (PGlite in-process; no network).

## Evidence references

- Runner (executable evidence): `backend/tests/integration/reverse-teaching/run-install-and-reverse-teach-dogfooding.ts` (run with `bunx tsx` from `backend/`).
- The integration regression battery: `backend/tests/integration/reverse-teaching/reverse-teaching.core.integration.test.ts` (the real-stack proof: install → reverse-teach → ZERO runs → no mutation).
- The deterministic unit battery: `backend/tests/unit/reverse-teaching/` (11 files / 55 tests) — every required regression of the work order has a deterministic test.
- The module: `backend/src/reverse-teaching/` (public barrel + types + internal/{derivation,session-service,in-memory-store,immutable}).

## Classification

**PASS** — the frozen dogfooding clause is satisfied end-to-end on the real integrated paths:

- a real workflow installed and pinned through the real V2-002 routes;
- reverse teaching invoked through the V2-010 public API, the session bound to the installation's pin;
- a real person followed the lesson: the safety gates were passed explicitly (the pre-acknowledgment attempt was rejected typed), the performable steps were performed BY HAND with real artifacts (a real drafted file, a real recorded response), the lesson was paused and resumed to the exact pending step, and the system-performed/subworkflow steps were acknowledged exactly as disclosed;
- the taught task was compared with direct workflow execution: a run for the SAME pinned version executed all six declared steps through the real V2-005 boundary and completed; the run's declared steps ARE the lesson's steps; the run's recorded output commitment for the drafting step EQUALS the sha-256 of the file the person produced by hand (same input → same outcome artifact through both modes);
- the manual lesson created ZERO execution records (the real V2-005 list surface stayed empty), and the installed version stayed byte-identical.

## Limitations (recorded honestly)

1. The "real person" is the operator driving the lesson through the module's public API (the V2-006 dogfooding precedent): their choices, manual results, and acknowledgments are their own recorded inputs; the manual artifacts (the drafted file, the recorded response) are real files with real digests, but there is no GUI surface in this Work Order's scope (the module owns the teaching flow, not a frontend).
2. The direct-execution segment drives the run through the V2-005 command surface exactly as an executor would (the V2-005 dogfooding's own precedent): the per-step invocations are the executor's claimed outcomes with one-way output commitments — the actual computer-agent execution of agentic steps is V2-008's runtime (IG-003 territory), not this teaching Work Order's scope. The comparison proves step-set and outcome-artifact equivalence between the two modes, which is exactly the frozen clause.
3. Durable reverse-teaching session persistence is a later, separately-owned concern (the V2-006 store-port precedent): the in-memory reference store is the declared composition; the dogfooding proves the full flow on the real stack around it.
4. The subworkflow step's manual procedure is disclosed as delegated (the referenced version's own teaching), never derived here — resolving the referenced subworkflow's document through the repository is IG-004 composition territory.
5. The mkdtemp sandbox paths and uuid-derived repository identities are normalized for the determinism comparison (the content digests — which are deterministic — are compared at full precision inside the checks themselves).

## Resulting action

No V2-010 contract defect discovered by the experiment. The Work Order is READY_FOR_ARCHITECT_REVIEW with this evidence persisted; the merge remains the architect's.
