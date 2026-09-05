# WorkflowOS — Current Development State

> **This file is a convenience projection only. Git and canonical machine state remain authoritative.**

Verified against repository `main` and relevant GitHub PR/CI evidence on 2026-09-05.

## Current main / reconciliation

PR #194 merged T6 as `52ca783fb927a44889e217117a6569633f14a98b`.

PR #198 merged T8 as `63549e02e30c720da45f66e3dd1facc6323da3ed` after exact-head Architect acceptance of `51e41da01a6b010d5287fb698640de8e73c9b274`.

The canonical machine-state reconciliation follows this merge; before any new implementation dispatch, workers MUST re-read live `main` rather than relying on a stored SHA here.

## Current active program

**V2-017 — Universal Product UX** (`POST-W6-PRODUCT`)

## Current Work Order

`spec/architecture/v2/work-orders/V2-017.md`

Status: **READY** at the Work Order level; implementation is proceeding through its bounded T1–T16 task slices.

## Current V2-017 task

**T7 — Failure / recovery / takeover**

T8 is complete by actual Git merge. T7 is the current durable resident-worker dispatch and is unblocked by the T6 merge; T9, T11 and T14 remain independently eligible.

- T7 dispatch issue: **#197** — `V2-017 T7 — Resident Z.ai implementation dispatch: Failure, recovery, takeover`
- T7 execution base: `420cd2a0b0cfafb221e44d9c73bf00b8fbc8ef40` (live `main` verified immediately before dispatch)
- T8 dispatch issue: **#196** — completed by PR #198
- T8 merge: `63549e02e30c720da45f66e3dd1facc6323da3ed`

## Completed tasks

Authoritative task-level machine state records these V2-017 slices COMPLETE:

- T1 — human-facing application shell
- T2 — workflow-first Home
- T3 — workflow library
- T4 — workflow detail
- T5 — Tell / Show / Tell + Show creation
- T6 — Run / approval / where-it-runs
- T8 — scheduling and events
- T13 — expert/developer workspace transition

T8 completion is bound to PR #198's actual merge identity `63549e02e30c720da45f66e3dd1facc6323da3ed`; its reviewed head was `51e41da01a6b010d5287fb698640de8e73c9b274`.

## Eligible frontier

The reconciled canonical task frontier is:

**T7, T9, T11, T14**

Eligibility is derived from the Work Order dependency graph, actual Git merge facts, roadmap constraints, and required evidence. No eligible slice may depend on an unmerged sibling.

## Open / historical work

- **#197 — V2-017 T7 resident-worker dispatch** — current implementation dispatch.
- **#196 — V2-017 T8 resident-worker dispatch** — completed through PR #198.
- **#152 — IG-006 — Cross-Device Execution Attestation Composition (W5)** — historical fail-closed gate; not a dependency of the current V2-017 frontier.

PR #198 is **merged** and is no longer an open implementation PR.

## Blocked items

- **T10** — blocked on T6, T7, and T9.
- **T12** — blocked on T3, T4, and T11.
- **T15** — blocked until the required T2–T14 implementation/verification responsibilities are complete.
- **T16** — blocked on T15; it is the final Architect gate and merge.

## Required next action

Continue from live `main`. Review/implement the durably dispatched T7 slice on its own branch/PR, beginning only after the worker verifies the current live `main`. T8 requires no further review action unless a new repository regression is found.

## Reconciliation note

Post-merge reconciliation completed 2026-09-05 after Architect acceptance and actual merge of PR #198. The current task is now T7, with T7/T9/T11/T14 on the eligible frontier. The exact live `main` SHA is intentionally not treated as durable navigation state; it must always be fetched from Git before new work.
