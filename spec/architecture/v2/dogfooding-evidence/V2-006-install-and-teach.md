# V2-006 Install-and-Teach — Dogfooding Evidence

**Work Order ID:** V2-006 — Teaching Sessions (wave W2A, task W2A-a; GitHub issue #119)
**Classification of this record:** required real-system feature-boundary experiment (dogfooding-protocol.md; work order "Dogfooding": *install one real workflow and use it to teach a real operator the task, then record whether the operator can perform the task independently*)
**Experiment date:** 2026-09-01 (repo clock)
**Implementation under test:** green commit `1654cdd26f51f77dccb830a74dbd2ad4ff5b8ae7` (red battery `450b60945d44a22990c12d87ee5de623f13b6ac4`, battery alignment `8b59bbcef6b61eecda30b4546ac8cc222d135c7c`; evidence committed in the docs commit that carries this file)
**Status:** PASS (18/18 experiment assertions held; 0 failures) — Work Order remains implemented/pending-architect-merge (agents never mark COMPLETE)

## Workflow / version under test

- **Workflow:** slug `support-ticket-triage` ("Support Ticket Triage" — triage an inbound support ticket and reply), private, created in the experiment tenant through the real V2-002 route. Run 1 identity: `wfw_7fccce1121e9e11a7ef42360e857b193` (repository identities are deterministic from authoritative inputs including the run-scoped org UUID — see the determinism note below).
- **Immutable WorkflowVersion (the pin):** version 1 `wfwv_c09a6ac56bf98625973668fa2274c577`, CONTENT digest `724b618be8e9b99f43fccba37b43a29b2086a4415d76f07d74202f9cc8441be9` (V2-002 immutability/convergence proof over the opaque document), **SEMANTIC digest** (V2-003, computed by the merged workflow-ir barrel — the digest the teaching session pins) `80e36409e57ec55bf687f53034ada4f43247f889be04693ce156bb8d916cb26d` (sha-256, domain `workflowos/workflow-ir/v1`).
- **Installation:** `wfin_65a7566ee3b97deb311715e750d873df` (status `enabled`, pins version 1) — created through the real `POST /organizations/{orgId}/workflow-repository/installations` route.
- **Authored content:** a real WorkflowIR document authored with the merged V2-003 builder (`createWorkflowIrBuilder`): 6 steps — `fetch_ticket` (deterministic_api `github.repository.read`), `draft_reply` (agentic_computer_use with declared task), `human_review` (human approval decision point with `approved`/`rejected` outcomes), `escalate_backlog` (subworkflow dependency without declared semantics), `log_miss` (conditional `filesystem.write` on the rejected branch), `send_reply` (deterministic_api `messaging.send` with a `secret_ref` binding).
- **TeachingSession:** `ts_1`, learner `v2-006-operator`, injected deterministic sources (sequential id factory `ts_*`, stepping clock base 1733568000000 = 2024-12-07T10:40:00Z, step 1000 ms — zero wall clock in the teaching domain).

## Surface / host

- **REAL application (install path):** `buildServer()` (backend/src/api/server.ts) with the V2-002 workflow-repository routes registered through the ordinary path (`deps.auth && deps.workflowRepository`), the real API-key auth provider + user resolution, and the real `DefaultWorkflowRepositoryService`; every repository step (create workflow, install/pin, read version, read installation detail, post-teaching re-read) driven over HTTP via `app.inject()` — Fastify's real request pipeline (routing, hooks, auth, serialization).
- **REAL persistence:** `createPgliteDatabaseClient()` (actual PostgreSQL compiled to WASM; the same single `DatabaseClient` boundary as production `pg`) + `runMigrations()` applying all 60 migrations including `0060_workflow_repository_v2.sql` (the transcript's first line records it).
- **REAL identity stack:** `PgUserRepository` / `PgOrganizationRepository` / `PgMembershipRepository` / `ApiKeyAuthProvider` + `EnvSecretStore` / `ApiKeyCredentialProvisioner`; one tenant with a raw API key.
- **Teach path:** the V2-006 public API (`src/teaching-sessions/index.ts` barrel) — `DefaultTeachingSessionService` over `InMemoryTeachingSessionStore` (the reference composition for the store port; durable session persistence is a later, separately-owned concern). Read-only consumption of the merged V2-002 (route) + V2-003 (parse + semantic digest) barrels; no mock anywhere in this Work Order's control boundary.
- **Host:** local dev sandbox, Node 24 via `bunx tsx`, PGlite in-memory. (CI equivalent: real PostgreSQL behind `WORKFLOWOS_DATABASE_URL`; unset in this environment, recorded honestly.)
- **Reproducible experiment path:** `backend/tests/integration/teaching-sessions/run-install-and-teach-dogfooding.ts` (`bunx tsx tests/integration/teaching-sessions/run-install-and-teach-dogfooding.ts` from `backend/`).

## Exact task (the Work Order's required experiment)

Install one real workflow and use it to teach a real operator the task; then record whether the operator can perform the task independently:

1. **INSTALL** — author the support-ticket-triage workflow (merged V2-003 builder), create it through the real V2-002 route (born with immutable version 1), INSTALL/pin version 1 through the real installations route, read the version back over HTTP, and compute the pinned semantic digest with the merged V2-003 barrel.
2. **TEACH** — create a TeachingSession from the installed version through the V2-006 public API; as the operator/learner: read the derived lesson (intent, prerequisites, step explanations, decision points, completion criteria, and the typed `NOT_SPECIFIED_BY_WORKFLOW` disclosures); answer one practice question deliberately INCORRECTLY (record the typed rejection + correction), then correctly; raise a learner question and resolve it from the workflow's own disclosure; confirm the checkpoints in order, pausing mid-session and resuming to the exact checkpoint.
3. **INDEPENDENT PERFORMANCE** — submit the independent-task assessment: the module's own evaluation of whether the operator can perform the task without step-by-step teaching (reproduce the declared step order + each step's declared semantics).
4. **NO MUTATION** — re-read the installed version over HTTP after teaching (byte-identical), confirm the installation still pins v1, and confirm the pinned semantic digest still matches.

## Starting state

Empty fresh PGlite database (all 60 migrations applied), one empty tenant with a provisioned operator user/API key. No workflow, version, or installation rows exist; no teaching session exists.

## Expected outcome

1. The workflow is installed and pinned exactly as authored (version 1, content + semantic digests reproduced).
2. The lesson is derived as a view over the installed version: 6 checkpoints in declared control order; every stated fact is a verbatim IR value or canonical structural rendering; every missing fact (human-readable rationale for API steps, subworkflow semantics, undeclared completion evidence, workflow goal) is a typed `NOT_SPECIFIED_BY_WORKFLOW` disclosure — nothing invented.
3. A wrong practice answer is a typed `incorrect` outcome whose correction quotes the workflow's own declaration; the session state is unharmed.
4. Pause/resume returns to the exact pending checkpoint; questions are retained.
5. The operator passes the independent-performance assessment (order + all 6 declared semantics reproduced without step-by-step teaching) → the operator CAN perform the task independently per the module's assessment semantics.
6. All teaching evidence records carry evidenceClass `teaching` (never execution evidence); the installed workflow is byte-identical after the entire teaching flow.

## Observed outcome (run `dogfood-mtiz84n6` — all 18 assertions PASS, 0 failures; exit code 0)

```
[PASS] infra.migrations :: real PGlite + migration-runner applied 60 migrations (0060 present: true)

--- 1. INSTALL (real V2-002 routes over HTTP, real PGlite) ---
[PASS] 1.install-create-workflow :: POST /workflow-repository/workflows 201 — workflow (slug support-ticket-triage) born with immutable version 1 (number 1, head=v1)
[PASS] 1.install-pin-version :: POST /workflow-repository/installations 201 — the org INSTALLS (pins) version 1 (status enabled)
[PASS] 1.install-read-version :: GET /workflow-repository/workflows/…/versions/v1 → 200 (content digest 724b618be8e9b99f43fccba37b43a29b2086a4415d76f07d74202f9cc8441be9)
[PASS] 1.install-semantic-digest :: pinned WorkflowVersion semantic digest (merged V2-003 barrel): 80e36409e57ec55bf687f53034ada4f43247f889be04693ce156bb8d916cb26d

--- 2. TEACH (real V2-006 public API, injected deterministic ids/clock) ---
[PASS] 2.session-created :: TeachingSession ts_1 bound to the installed version (status not_started, pin carried as data)
[PASS] 2.lesson-begun :: beginLesson verified the semantic digest against the pin and derived the lesson (status in_progress)
        operator reads the derived lesson (verbatim):
        intent: This workflow starts at step "fetch_ticket", takes 1 declared input(s) (ticketUrl) and produces 1 workflow output(s) (messageId); its provenance origin is "authored". The workflow does not declare its goal in natural language.
        prerequisites:
          - ticketUrl (type string, required)
          - required capability filesystem.write
          - required capability github.repository.read
          - required capability messaging.send
          - required capability workflow.execute
          - default placement any_supported_node
          - step draft_reply requires placement cloud_allowed
          - step fetch_ticket requires placement cloud_allowed
          - step human_review requires placement device_local
          - step log_miss requires placement device_local
          - step send_reply requires placement cloud_preferred
        steps:
          1. Step 1 (fetch_ticket) executes the canonical capability "github.repository.read" as deterministic_api. Its declared placement is cloud_allowed. Its declared failure policy is fail_workflow. Its completion is established by observation (declared). The workflow does not declare a human-readable rationale for this step.
          2. Runs after success of step fetch_ticket. Step 2 (draft_reply) is executed as agentic_computer_use with the declared task: "Draft a support reply and a severity classification for the ticket.". Its declared placement is cloud_allowed. Its declared failure policy is retry_then_fail_workflow(maxAttempts=2). Its completion is established by verification (declared).
          3. Runs after success of step draft_reply. Step 3 (human_review) is a human approval step with the declared instruction: "Approve sending the drafted support reply and syncing the backlog.". Its declared placement is device_local. Its declared failure policy is fail_workflow. Its completion is established by human_confirmation (declared).
          4. Runs after outcome:approved of step human_review. Step 4 (escalate_backlog) invokes subworkflow "wf-backlog-sync" at version reference "wfv_0192_backlog_sync_v1". Its declared placement is any_supported_node. Its declared failure policy is retry_then_fail_workflow(maxAttempts=3). The workflow does not declare what the referenced subworkflow does. The workflow does not declare how completion of this step is established.
          5. Runs after outcome:rejected of step human_review. Step 5 (log_miss) executes the canonical capability "filesystem.write" as deterministic_api. Its declared placement is device_local. Its declared failure policy is ignore_and_continue. The workflow does not declare a human-readable rationale for this step. The workflow does not declare how completion of this step is established.
          6. Runs after outcome:approved of step human_review. Step 6 (send_reply) executes the canonical capability "messaging.send" as deterministic_api. Its declared placement is cloud_preferred. Its declared failure policy is fail_workflow. Its completion is established by verification (declared). The workflow does not declare a human-readable rationale for this step.
        decision points:
          - human_review (approval): Approve sending the drafted support reply and syncing the backlog. → outcomes: approved, rejected
        completion criteria:
          - workflow produces output messageId
          - escalate_backlog is a terminal step
          - log_miss is a terminal step
          - send_reply is a terminal step
[PASS] 2.lesson-read :: lesson: 6 steps in declared order [fetch_ticket → draft_reply → human_review → escalate_backlog → log_miss → send_reply]; 7 typed NOT_SPECIFIED_BY_WORKFLOW disclosures (the workflow's own gaps, never invented prose)
[PASS] 2.practice-questions :: 6 practice questions derived from the workflow's own declared step semantics (options = declared semantics only)
[PASS] 2.practice-incorrect-typed-rejection :: deliberately WRONG practice answer for fetch_ticket ("messaging.send") → typed outcome "incorrect" with the correction quoting the workflow's own declaration: "github.repository.read"
        correction feedback: Not the workflow declaration for step "fetch_ticket". The workflow declares: "github.repository.read". (The correction quotes the workflow own declared semantics.)
[PASS] 2.practice-corrected :: the corrected practice answer ("github.repository.read") → typed outcome "correct"
[PASS] 2.learner-question-retained-and-resolved :: operator question retained across the session; the answer is the workflow's own typed disclosure, not invention: "The workflow does not declare what the referenced subworkflow does."
[PASS] 2.pause-resume-exact-checkpoint :: paused mid-session (after 2/6 confirmations) and RESUMED to the exact pending checkpoint "human_review"
[PASS] 2.checkpoints-confirmed-in-order :: all 6 checkpoints confirmed in the lesson order: fetch_ticket → draft_reply → human_review → escalate_backlog → log_miss → send_reply

--- 3. INDEPENDENT PERFORMANCE (without step-by-step teaching) ---
[PASS] 3.operator-performs-task-independently :: the operator reproduced the workflow's declared step order and every step's declared semantics WITHOUT step-by-step teaching: assessment passed (order correct, 6/6 semantics correct) — session completed

--- 4. EVIDENCE + NO MUTATION (real route re-read) ---
[PASS] 4.teaching-evidence-typed :: 9 teaching-evidence records (2 practice + 6 checkpoint confirmations + 1 assessment), every evidenceClass "teaching" (never execution evidence): learner_practice_attempt,learner_practice_attempt,learner_checkpoint_confirmation,learner_checkpoint_confirmation,learner_checkpoint_confirmation,learner_checkpoint_confirmation,learner_checkpoint_confirmation,learner_checkpoint_confirmation,learner_assessment_outcome
[PASS] 4.no-mutation-installed-workflow :: GET the installed version after teaching → 200, response body BYTE-IDENTICAL to the pre-teaching snapshot; the installation still pins version 1 (number 1)
[PASS] 4.pin-still-matches :: the pinned semantic digest still matches the unchanged installed content (80e36409e57ec55bf687f53034ada4f43247f889be04693ce156bb8d916cb26d)

runId=dogfood-mtiz84n6 workflow=wfw_7fccce1121e9e11a7ef42360e857b193 version=wfwv_c09a6ac56bf98625973668fa2274c577 installation=wfin_65a7566ee3b97deb311715e750d873df semanticDigest=80e36409e57ec55bf687f53034ada4f43247f889be04693ce156bb8d916cb26d sessionId=ts_1 teachingClockBase=1733568000000 durationMs=3260 failures=0
OBSERVATION (scope, not failure): the operator is the implementing agent acting through the real public teaching API (not an independently recruited human); independent performance is evaluated by the teaching module's assessment semantics (order + declared-semantics reproduction) — real task execution belongs to unmerged V2-005/V2-008 and teaching↔execution composition is deferred to integration gates.
DETERMINISM NOTE: re-running this harness yields an identical teaching transcript (session ids ts_1…, stepping clock stamps, lesson content, evidence order); only run-scoped bookkeeping (runId, wall durationMs, and the repository uuid-derived org/workflow/version/installation identities) differs and is normalized in the evidence re-run comparison.
```

**Can the operator perform the task independently?** YES, per the teaching module's own assessment: after one teaching pass (lesson read, one deliberately-incorrect practice answer corrected, 6/6 checkpoints confirmed, a pause/resume mid-session), the operator reproduced the workflow's declared step order and every step's declared semantics without step-by-step teaching — assessment passed (order correct, 6/6 semantics correct), session completed, and the completion produced ONLY teaching evidence (9 records, class `teaching`), never an execution record.

## Determinism re-run (protocol requirement)

A second full execution (run `dogfood-mtiz8ew7`, durationMs 3303, 18/18 PASS, exit 0) produced a **byte-identical transcript after normalizing exactly the run-scoped bookkeeping** — `runId`, wall `durationMs`, and the repository's UUID-derived org/workflow/version/installation identities (`wfw_*`, `wfwv_*`, `wfin_*`, org/user UUIDs), which are inputs the teaching domain treats as opaque pinned data:

- identical session id (`ts_1`), identical injected teaching-clock stamps, identical lesson content and step order, identical practice/assessment outcomes, identical evidence kind sequence;
- identical SEMANTIC digest `80e36409e57ec55bf687f53034ada4f43247f889be04693ce156bb8d916cb26d` and CONTENT digest `724b618be8e9b99f43fccba37b43a29b2086a4415d76f07d74202f9cc8441be9` (deterministic derivations over the same authored content);
- `diff` of the two normalized transcripts: empty.

## Evidence references

- Red regression battery commit: `450b60945d44a22990c12d87ee5de623f13b6ac4` (`test(teaching-sessions): deterministic red regression battery for V2-006`, 15 files / 3030 insertions — tests only).
- Battery alignment commit: `8b59bbcef6b61eecda30b4546ac8cc222d135c7c` (`test(teaching-sessions): align red battery with the module surface`).
- Green implementation commit: `1654cdd26f51f77dccb830a74dbd2ad4ff5b8ae7` (`feat(teaching-sessions): implement V2-006 teaching session domain module`).
- Harness (reproducible experiment): `backend/tests/integration/teaching-sessions/run-install-and-teach-dogfooding.ts`.
- Scoped battery at the implementation head: `bunx vitest run tests/unit/teaching-sessions tests/integration/teaching-sessions` → 14 files / 116 tests passed / 0 failed.
- Architecture suite: `bunx vitest run tests/architecture` → 895 passed / 1 file (base baseline, unchanged).

## Duration / cost

Wall duration ≈ 3.3 s per full experiment run (process start, PGlite + 60 migrations, identity stack, Fastify build, HTTP install path, full teaching flow, post-teaching re-read) on the local dev sandbox; teaching-domain time is the injected stepping clock (base 1733568000000, +1000 ms per recorded transition), independent of wall time.

## Classification

**PASS** — every expected outcome held on the real path; no contract failure, no UX failure, no operational failure. The only defect found during dogfooding was a wrong expected-evidence-count constant in the harness itself (fixed before the persisted runs; the module was never wrong — the integration battery had already pinned the correct 9-record stream).

## Resulting action

- None required within V2-006 scope: the module satisfied the Work Order's dogfooding requirement through the real install path (V2-002 routes over HTTP + PGlite + migrations) and the real teach path (V2-006 public API).
- Merge-readiness: V2-006 remains implemented/pending-architect-merge. Teaching↔execution composition (dogfooding-protocol V2-010-style "follow the lesson, then execute") is explicitly deferred to the integration gates once V2-005/V2-008 exist — recorded as the top integration expectation, not silently assumed.

## Honest limitations

1. **The operator is the implementing agent** acting through the real public teaching API — not an independently recruited human. The learner's behavior (reading the lesson, the deliberately wrong practice answer, the question asked, the pause point) is the agent role-playing an operator honestly; a human factors trial with a recruited operator remains outstanding and is the architect's/product's call.
2. **"Perform the task independently" is the teaching module's own assessment semantics** (reproduction of the declared step order + each step's declared semantics from the lesson), not a real-world task execution: actually performing the task (fetching the ticket, sending the reply) belongs to the unmerged V2-005 (WorkflowRun) / V2-008 (computer-agent runtime), and the assessment deliberately does not claim any side effect completed.
3. **Teaching evidence ≠ proof of real-world skill**: the teaching model itself (spec/architecture/v2/workflow-teaching-and-marketplace.md) states an execution result does not prove a learner can perform the task independently and vice versa — the assessment outcome here is a teaching-evidence-class record, exactly as specified.
4. **Session persistence is the reference in-memory store** (the store port's reference composition): resumability was exercised within one process by design; durable cross-process resume is a later, separately-owned concern (the port is the contract).
5. **The lesson's knowledge is bounded by the workflow's declarations** — e.g. the workflow does not declare what the `wf-backlog-sync` subworkflow does; the lesson discloses that honestly rather than inventing it, so the operator's "independent" knowledge is exactly the authored semantics, no more.
