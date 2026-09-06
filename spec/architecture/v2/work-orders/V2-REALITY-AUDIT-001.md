# V2-REALITY-AUDIT-001 — Product Reality, Journey, and Architecture Reconciliation

**Status:** governed pre-deployment audit
**Program:** WorkflowOS V2
**Depends on:** V2-017 complete through T16
**Purpose:** operate the real V2 product as a user, reconcile every UX journey against the already-implemented V2 operational architecture, classify defects correctly, have the Architect review/reshape all proposed architectural solutions, then authorize bounded fixes before deployment.

## Governing principle

The V2 operational architecture predates and underlies the V2-017 UX composition. Therefore a UX failure is NOT evidence of a missing backend capability until the worker has traced the user intent through the existing public route, service, adapter and authority.

Prefer, in order:

1. correct use of an existing operational capability;
2. a missing UX/backend composition adapter;
3. a missing public route/command over an existing authority;
4. only then a genuine new authority or V2 architecture change.

Z.ai browser evidence is observational evidence. It never overrides repository architecture, implementation, or Git history.

## Required program stages

### R0 — Operational architecture inventory

Inspect the complete V2 architecture package and all V2 Work Orders relevant to user-facing behavior, including at minimum V2-002, V2-003, V2-004, V2-005, V2-006, V2-007, V2-008, V2-009, V2-010, V2-011, V2-012, V2-014 and V2-015, plus integration gates.

Trace the actual implementation: API routes, module/application services, public barrels, frontend API client, V2-017 pages/components, browser tests and dogfooding evidence.

Produce a `UX intent → route → service → authority → persistence/effect` map for every UX capability.

### R1 — Full real-user browser reconnaissance

Run the deployed/staging V2 application with Z.ai's Agent Browser exactly as a real user. Do not fix anything during this phase.

Use safe deterministic fixtures and real authentication/session behavior. Use direct API inspection only as supplementary diagnostics after the browser has demonstrated the user-visible result.

Exercise every reachable V2 journey, including:

- authentication, registration, login, logout, session persistence and auth failure;
- Home goal/search entry, recent workflows, attention states and unavailable surfaces;
- Tell, Show and Tell + Show creation through preview and attempted commit;
- My Workflows, Installed, Shared, Drafts, Archived and all contextual filters;
- workflow detail, steps, version/pin, access, placement, activity and actions;
- Run preview, manual request, approval, placement, start, running, paused, waiting-for-you, completed, failed and cancelled states;
- recovery, takeover, retry, stop and edit-from-failure;
- schedules, recurring triggers, events, duplicate delivery, missed windows and placement failure;
- Teach Me, checkpoints, practice, pause/resume, version pinning and evidence separation;
- versions, updates, optimization proposals and explicit adoption;
- Explore, listing detail, visibility, purchase/entitlement, install, pinning, fork/make-your-own where exposed;
- Activity, historical run links, evidence and trust disclosure;
- explicit Expert transition, project/workbench/architecture/requirements/work-item/benchmark/settings surfaces;
- desktop, tablet and mobile-width behavior, reload/back/forward/deep links, network failures, multiple organizations and unsupported capabilities.

For every journey record pass/fail/blocked, exact visible result, expected result, route, action, browser evidence, diagnostic API outcome where necessary, and reproducibility.

### R2 — UX ↔ operational discrepancy analysis

For every failure or suspicious behavior, locate the actual backend capability before declaring the capability absent.

Classify each primary root cause exactly as one of:

- `UX_DEFECT`
- `WIRED_TO_WRONG_AUTHORITY`
- `WIRED_TO_WRONG_COMMAND_OR_READ`
- `MISSING_ADAPTER_OR_COMPOSITION`
- `MISSING_PUBLIC_AUTHORITY_CONTRACT`
- `TRUE_ARCHITECTURE_GAP`
- `ENVIRONMENT_OR_DEPLOYMENT_DEFECT`
- `EXPECTED_UNAVAILABLE_SURFACE`

For each finding, show the evidence chain from user action through frontend code and backend route/service to the authoritative operational contract.

### R3 — Z.ai durable audit report

Create one durable report with:

- complete journey matrix;
- all pass/fail/blocked observations;
- exact browser evidence references;
- actual route/service/authority mappings;
- discrepancy classification and confidence;
- root cause;
- minimal proposed repair;
- alternative architectural options where appropriate;
- expected user-visible effect;
- security/authority/semantic implications;
- test and dogfooding requirements;
- whether implementation can stay inside an existing authority or requires a governed architecture change.

The worker may propose solutions but may not self-authorize a new architecture authority.

### R4 — Architect reconciliation

The Architect reviews the complete report and independently re-checks the critical proposed fixes against source and operational contracts.

For every finding the Architect records one disposition:

- `ACCEPT` — proposal is correct and minimal;
- `REVISE` — preserve intent but change solution;
- `REJECT` — underlying operational capability already exists or finding is misdiagnosed;
- `SPLIT` — divide into multiple bounded implementation slices;
- `ARCHITECTURE_CHANGE` — a genuine missing authority/semantic contract requires the V2 governed architecture-change mechanism.

Accepted repairs become the canonical pre-deployment repair backlog and dependency graph.

### R5 — Governed implementation

Z.ai implements only Architect-authorized slices, one bounded PR per slice unless an explicit integration gate says otherwise.

Fix the smallest correct composition seam first. Do not rebuild operational services merely because the UX was written before the worker traced the existing functions.

Each fix must add regression/discrimination coverage for the previously failing journey and prove that the wrong-authority/wrong-command case cannot silently pass.

### R6 — Full repeat audit

Run the complete R1 browser matrix again after all accepted fixes. Re-test all previously passing journeys affected by the changed authorities as well as all fixed failures.

### R7 — V2 release readiness

Only after R6 is complete may the Architect resume the separate V2 deployment roadmap.

## Critical reconciliation questions

### Creation

Does an operational service already accept high-level intent, demonstrations, or agent-produced plans and produce valid WorkflowIR/WorkflowVersion through V2-002/V2-003? Or is capture→IR genuinely missing?

The worker must explicitly distinguish the V2-007 compiler (WorkflowIR→executable plan) from any hypothetical capture→WorkflowIR authoring function. `backend/src/agent-intelligence/` must also be checked before declaring an AI authoring function present; that domain currently describes itself as deterministic execution-recommendation ranking, not natural-language workflow authoring.

### Editing

Does `/expert` merely provide a mode bridge, or is there already a workflow-specific authoring/editor command deeper in the existing engineering surface? Trace WorkflowDetailPage → ExpertPage → project/workbench controls and any backend mutation route before concluding that an editor is absent.

### Home unavailable surfaces

Determine whether approvals, updates and device issues are genuinely unsupported read surfaces or whether the UX simply failed to compose existing V2-005, V2-002 and V2-004/V2-009 authorities.

### Drafts / Archived

Determine whether these are valid product concepts supported by an existing state model, derivable views, or intentionally unavailable UX sections. They must not be implemented by inventing a second workflow state machine.

### Run / Recovery / Scheduling / Teaching

Verify that every visible action corresponds to a real public command and that every displayed state is derived from the authoritative existing Run, placement, trigger and teaching records. Presentation-only buttons that cannot reach a corresponding authority are defects.

### Marketplace

Verify actual composition of listing → entitlement → installation → pinned version → execution authorization. A purchase/entitlement must never be treated as execution authorization.

### Cross-device

Verify whether operational cross-host placement/handoff/proof capabilities already exist and whether V2 UX exposes them correctly or leaves them inaccessible.

## Evidence standard

The audit package must retain:

- exact V2 test head SHA;
- environment identity without credentials;
- complete browser transcripts/logs;
- screenshots for critical failures and repairs;
- journey matrix;
- route/service/authority map;
- Architect disposition of every finding;
- implementation PR references;
- regression results;
- final repeat-audit results;
- unresolved findings and explicit release disposition.

## Exit criteria

1. Every currently reachable V2 UX journey has been exercised or explicitly justified as unavailable.
2. Every failure has been traced to the real operational architecture.
3. No existing operational capability remains unused merely because the UX was written against an incorrect assumption.
4. All accepted fixes are implemented, merged and re-tested.
5. Genuine architecture gaps use the governed V2 architecture-change mechanism.
6. No critical journey is blocked by an undocumented UX↔operational mismatch.
7. The Architect has an evidence-backed V2 release candidate and may then advance to deployment.

## Non-goals

This program does not redesign V2-017, create a second UX architecture, change WorkflowIR semantics casually, invent a second workflow/verification/execution authority, or deploy production infrastructure. Deployment starts only after this audit closes its exit criteria.
