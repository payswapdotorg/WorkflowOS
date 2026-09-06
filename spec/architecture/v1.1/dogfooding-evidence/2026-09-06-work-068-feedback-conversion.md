# WORK-068 — Feedback → Governed Work Items: the real-system dogfooding run

Executed by `backend/tests/integration/feedback-conversion/run-work-068-dogfooding.ts`
(the real PGlite stack + the real identity + the real route surface + the
real WORK-067 signal service + the real /work-items intake). The durable
activation dispatch is Issue #12 on payswapdotorg/WorkflowOS (2026-09-06,
live main 0d06f8b). The transcript below is the structured run record.


# WORK-068 feedback→governed-Work-Item conversion — the real-system dogfooding run

Executed: 2026-09-06T05:51:16.608Z (the runner's own clock — NOT a domain decision input)

## Stack

- real PGlite with ALL migrations; the real identity stack (API-key operator)
- the REAL WORK-067 EngineeringSignalService (the public signal intake + correlation engine)
- the REAL /work-items intake (PgWorkItemRepository — wfos_work_items + the real UNIQUE constraint)
- the REAL Fastify route surface: POST /projects/:id/feedback/convert + GET /projects/:id/feedback/proposals

- PASS LEG 1 — two logical signals recorded (the cross-source observations converged in WORK-067) — expected 2, got 2
- PASS LEG 2 — GET /feedback/proposals 200 — expected 200, got 200
- PASS LEG 2 — two assessed proposals — expected 2, got 2
- PASS LEG 2 — the checkout proposal FB- id — 'FB-9b3c912d30' must match /^FB-[0-9a-f]{10}$/
- PASS LEG 2 — cross-source confirmation recorded — expected ["ci","validation"], got ["ci","validation"]
- PASS LEG 2 — READ-ONLY: nothing landed in the authoritative store — expected 0, got 0
- PASS LEG 3 — POST /feedback/convert 201 (created) — expected 201, got 201
- PASS LEG 3 — two Work Items created through the existing intake — expected 2, got 2
- PASS LEG 3 — decidedBy is the AUTHENTICATED principal (server-resolved) — expected "a26c0d76-3f75-469b-86fb-a220516c4832", got "a26c0d76-3f75-469b-86fb-a220516c4832"
- PASS LEG 4 — two authoritative Work Item records — expected 2, got 2
- PASS LEG 4 — the authoritative FB- work item id — 'FB-9b3c912d30' must match /^FB-[0-9a-f]{10}$/
- PASS LEG 4 — NOT completed (the full governance lifecycle still applies) — expected false, got false
- PASS LEG 4 — the originating signal provenance preserved — expected true, got true
- PASS LEG 4 — the raw observation references preserved VERBATIM — expected ["run-df-1","wfos_github_ci_evidence:df-1"], got ["run-df-1","wfos_github_ci_evidence:df-1"]
- PASS LEG 4 — the governed decision embedded in the authoritative record — expected "a26c0d76-3f75-469b-86fb-a220516c4832", got "a26c0d76-3f75-469b-86fb-a220516c4832"
- PASS LEG 5 — the repeat conversion 200 (no creates) — expected 200, got 200
- PASS LEG 5 — zero creates on the repeat — expected 0, got 0
- PASS LEG 5 — both proposals converged — expected 2, got 2
- PASS LEG 5 — still exactly two authoritative records — expected 2, got 2
- PASS LEG 6 — the recurrence conversion 201 (the completed item does not block) — expected 201, got 201
- PASS LEG 6 — the recurrence Work Item FB-xxx.R2 — 'FB-9b3c912d30.R2' must match /^FB-[0-9a-f]{10}\.R2$/
- PASS LEG 6 — the recurrence chain recorded — expected ["efca7fdd-9caa-4931-a918-c2d345720bac"], got ["efca7fdd-9caa-4931-a918-c2d345720bac"]
- PASS LEG 6 — the escalated recurrence severity assessed — expected "critical", got "critical"
- PASS LEG 6 — three authoritative records (the completed fix + the recurrence + the webhook item) — expected 3, got 3
- PASS LEG 7 — unauthenticated GET → 401 — expected 401, got 401
- PASS LEG 7 — the foreign user → 403 (tenant isolation) — expected 403, got 403
- PASS LEG 7 — the forged decidedBy field REJECTED (400) — expected 400, got 400
- PASS LEG 7 — the forged decision field REJECTED (400) — expected 400, got 400
- PASS LEG 7 — the forged assessment field REJECTED (400) — expected 400, got 400
- PASS LEG 7 — the forged priority field REJECTED (400) — expected 400, got 400
- PASS LEG 7 — the missing decisionReason → 400 (no silent conversion) — expected 400, got 400
- PASS LEG 7 — the unknown signal id → 400 (fail-closed, never fabricated) — expected 400, got 400

## Result

ALL LEGS PASS (exit 0)

## Boundary summary (the honest scope statement)

- The conversion submitted proposed Work Items ONLY through the existing WorkItemRepository.create intake; no second work-item authority exists (18 static-architecture invariants + the discrimination suite pin it).
- Every created Work Item preserves its originating signal provenance (metadata.feedbackConversion: signal ids, sources, environments, occurrence references verbatim, the advisory regression evidence, the governed decision).
- The mutation required the explicit governed decision (decidedBy server-resolved + the caller-supplied decisionReason); the assessment was re-derived in the mutation path; the read-only assess created nothing.
- Deduplication converged the repeated conversion on the existing OPEN items; the completed item yielded the recurrence (FB-xxx.R2) with the recurrence chain — never a duplicate, never a blocked conversion.
- The created Work Items are NOT completed, NOT assigned, NOT executed — the full governance lifecycle (architecture checkpoint, agent execution, verification, architect review, merge) still applies before any code change.
- The signal store is the documented in-memory WORK-067 boundary (no durable signal storage exists yet — the future ACR at the port); the Work Items are durable in the real schema.

## Determinism

The experiment ran TWICE on fresh stacks (fresh PGlite with all migrations, fresh identity provisioning). All legs passed both times (exit 0). The structured outcomes (leg results, counts, statuses, provenance shapes, orderings) were identical across both runs; the normalized transcripts — eliding only the per-stack generated UUID-shaped scope identities (organization/project/architecture-version/user/record ids, which are the sha256 identity derivation INPUTS) and their derived FB- hashes, plus the execution timestamp — were byte-identical.
