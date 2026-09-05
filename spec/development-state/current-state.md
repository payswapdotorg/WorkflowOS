# WorkflowOS — Current Development State

> **This file is a convenience projection only. Git and canonical machine state remain authoritative.**

Verified against repository `main` and relevant GitHub PR/CI evidence on 2026-09-05.

## Current main / reconciliation

PR #194 merged T6 as `52ca783fb927a44889e217117a6569633f14a98b`.

PR #198 merged T8 as `63549e02e30c720da45f66e3dd1facc6323da3ed` after exact-head Architect acceptance of `51e41da01a6b010d5287fb698640de8e73c9b274`.

PR #199 merged T7 as `2b00f0cc0096af23ca031bc543d6f01bd13a157b` after exact-head Architect acceptance of `8b6d440744d5a8b309a7faa531c8716da0468dea`.

The canonical machine-state reconciliation follows these merges; before any new implementation dispatch, workers MUST re-read live `main` rather than relying on a stored SHA here.

## Current active program

**V2-017 — Universal Product UX** (`POST-W6-PRODUCT`)

## Current Work Order

`spec/architecture/v2/work-orders/V2-017.md`

Status: **READY** at the Work Order level; implementation is proceeding through its bounded T1–T16 task slices.

## Current V2-017 task

**T9 — Teach Me / reverse teaching**

T7 is complete by actual Git merge. T9 is now the current durable resident-worker dispatch and is unblocked by the T4 merge; T11 and T14 remain independently eligible.

- T9 dispatch issue: **#200** — `V2-017 T9 — Resident Z.ai implementation dispatch: Teach Me / reverse teaching`
- T9 execution base: `35e35a66e89c32f4c3f49e017f62c160249ce91c` (clean live `main` verified immediately before dispatch)
- T7 dispatch issue: **#197** — completed through PR #199
- T7 merge: `2b00f0cc0096af23ca031bc543d6f01bd13a157b`
- T8 dispatch issue: **#196** — completed through PR #198
- T8 merge: `63549e02e30c720da45f66e3dd1facc6323da3ed`

## Completed tasks

Authoritative task-level machine state records these V2-017 slices COMPLETE:

- T1 — human-facing application shell
- T2 — workflow-first Home
- T3 — workflow library
- T4 — workflow detail
- T5 — Tell / Show / Tell + Show creation
- T6 — Run / approval / where-it-runs
- T7 — failure / recovery / takeover
- T8 — scheduling and events
- T13 — expert/developer workspace transition

T7 completion is bound to PR #199's actual merge identity `2b00f0cc0096af23ca031bc543d6f01bd13a157b`; its reviewed head was `8b6d440744d5a8b309a7faa531c8716da0468dea`.

## Eligible frontier

The reconciled canonical task frontier is:

**T9, T11, T14**

Eligibility is derived from the Work Order dependency graph, actual Git merge facts, roadmap constraints, and required evidence. No eligible slice may depend on an unmerged sibling.

## Open / historical work

- **#200 — V2-017 T9 resident-worker dispatch** — current implementation dispatch.
- **#197 — V2-017 T7 resident-worker dispatch** — completed through PR #199.
- **#196 — V2-017 T8 resident-worker dispatch** — completed through PR #198.
- **#152 — IG-006 — Cross-Device Execution Attestation Composition (W5)** — historical fail-closed gate; not a dependency of the current V2-017 frontier.

## Blocked items

- **T10** — blocked on T6, T7, and T9.
- **T12** — blocked on T3, T4, and T11.
- **T15** — blocked until the required T2–T14 implementation/verification responsibilities are complete.
- **T16** — blocked on T15; it is the final Architect gate and merge.

## Required next action

Continue from live `main` and execute the durably dispatched T9 slice on its own branch/PR, beginning only after the worker verifies the current live `main`. T7 and T8 require no further review action unless a new repository regression is found.

## Reconciliation note

Post-merge reconciliation completed 2026-09-05 after Architect acceptance and actual merge of PR #199. The current task is now T9, with T9/T11/T14 on the eligible frontier and Issue #200 as the durable T9 dispatch. The exact live `main` SHA is intentionally not treated as durable navigation state; it must always be fetched from Git before new work.
