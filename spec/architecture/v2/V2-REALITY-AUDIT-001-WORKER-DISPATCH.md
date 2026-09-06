# V2-REALITY-AUDIT-001 — Resident Worker Dispatch

**Status:** ACTIVE — Architect authorized
**Repository:** `payswapdotorg/WorkflowOS`
**Governing Work Order:** `spec/architecture/v2/work-orders/V2-REALITY-AUDIT-001.md`
**Report template:** `docs/v2/V2-REALITY-AUDIT-001-WORKER-REPORT-TEMPLATE.md`

## Mission

Operate WorkflowOS V2 through the real browser as a normal user, exercise the complete current UX journey matrix, and then trace every observed result into the existing operational architecture.

Do not begin deployment work. Do not fix defects during reconnaissance. Do not declare an architecture gap until the existing operational code, route, service, adapter and authority have been inspected.

## Exact operating sequence

1. Read `AGENTS.md`, the V2 architecture constitution/control documents, the V2-017 program map/evidence, all relevant V2 Work Orders, current development state, the V2 deployment roadmap, and this Work Order.
2. Re-read live `main` immediately before creating any worker branch.
3. Start/verify an isolated staging-capable V2 runtime and use Z.ai Agent Browser for the browser journey.
4. Create safe fixtures representing each required state; never use destructive production data.
5. Execute every journey in the Work Order inventory. Add any newly discovered route/action to the report before testing it.
6. For every failure, first identify the actual frontend call, backend route, application service, module/public barrel and authoritative owner.
7. Use direct backend inspection only as diagnosis after browser observation; browser behavior is the primary user evidence.
8. Record screenshots/transcripts/logs and exact revisions in the worker report.
9. Produce one durable report using the report template.
10. STOP. Do not self-authorize fixes or architecture changes. The Architect will reconcile the report and create the next bounded repair slices.

## Required discrepancy discipline

A journey that fails is not automatically a missing backend function. The worker must actively test these possibilities in order:

`wrong UX wiring → wrong route/read/command → missing adapter/composition → missing public route/command → true architecture gap`.

The worker must specifically investigate the current creation flow and determine whether an existing V2 operational capability can already produce valid WorkflowIR/WorkflowVersion from a user intent, rather than repeating the UX's current claim that durable creation is unavailable.

The worker must also verify whether the Edit route merely lands on the generic Expert bridge even though a workflow-specific authoring path already exists deeper in the operational application.

## Deliverables

- complete journey matrix;
- route → API → service → authority map;
- failure/finding records;
- proposed architectural remedies with alternatives;
- explicit list of existing capabilities the current UX fails to consume;
- release-blocking findings;
- exact evidence hashes/references where available.

The report must be written to the repository and referenced by the worker's implementation handoff/PR or, if no code changes are made, by the Architect reconciliation record.
