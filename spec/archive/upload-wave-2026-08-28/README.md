# Retired upload-wave material (2026-08-28) — NON-AUTHORITATIVE

This directory preserves the architect's 2026-08-28 direct-to-main upload wave
(commits `7db2ad3`..`0541d13`, pushed 18:24–18:40Z) as **historical/proposed
material only**. Nothing in this directory governs.

## Why this material was retired

The upload wave re-used the `WORK-053..059` identifiers for a different roadmap
than the architect-issued GitHub issues `#65..#73` (opened 17:34Z the same day,
one hour earlier) that define the v1.1 evolution program carried by PR #74 —
and its governance documents claimed `Architecture Version: 2.0, Status:
FROZEN`, although **no Architecture Change Request was ever approved for any
version change** (the governing architecture is v1.0 per
`spec/development-state/program-state.json`).

A fresh architect reading the repository could therefore not determine what
`WORK-053` means, or which architecture version governs. The architect's
2026-08-29 PR #74 review verdict resolved this at the identity/authority
layer:

- **The architect-issued GitHub issue track is canonical**: ACR-001 +
  `WORK-053..061` (v1.1, proposed) — `spec/work-orders/WORK-053.md`..`WORK-061.md`.
- **The upload-wave artifacts are retired under distinct `UW-053..059`
  identities** (below), explicitly non-authoritative.
- The machine-readable retirement record is
  [`index.json`](./index.json) (the single place the retired identity claims
  are recorded); the full decision record is
  `spec/architecture/v1.1/reconciliation-record.md` §8.

## The canonical interpretation of every Work Order ID

For any `WORK-NNN`: the canonical meaning is defined by
`spec/development-state/program-state.json` (recorded work orders) and, for the
proposed v1.1 future track, `spec/development-state/dependency-state.json`
(`futureGeneration`) + `spec/work-orders/WORK-NNN.md` (the architect-issued
files). Files in this directory never define a `WORK-NNN` meaning.

## Contents

| Archived file | Retired identity | Originally uploaded as |
|---|---|---|
| `UW-053-architecture-checkpoint-framework.md` | UW-053 | `spec/work-orders/WORK-053 — Architecture Checkpoint Framework.md` |
| `UW-054-adaptive-assurance-profiles.md` | UW-054 | `spec/work-orders/WORK-054 — Adaptive Assurance Profiles.md` |
| `UW-055-evidence-and-proof-registry.md` | UW-055 | `spec/work-orders/WORK-055 — Evidence and Proof Registry.md` |
| `UW-056-change-program-change-set-model.md` | UW-056 | `spec/work-orders/WORK-056 — Change Program - Change Set Model.md` |
| `UW-057-architecture-fitness-engine.md` | UW-057 | `spec/work-orders/WORK-057 — Architecture Fitness Engine.md` |
| `UW-058-continuous-maintenance-intelligence.md` | UW-058 | `spec/work-orders/WORK-058 — Continuous Maintenance Intelligence.md` |
| `UW-059-workflowos-self-hosting-lifecycle.md` | UW-059 | `spec/work-orders/WORK-059 — WorkflowOS Self-Hosting Lifecycle.md` |
| `ARCHITECTURE_LOCK.uploaded.md` | — | `spec/governance/ARCHITECTURE_LOCK.md` (the "2.0 FROZEN" claim — corrected in its banner) |
| `ARCHITECT_ROLE.uploaded.md` | — | `spec/governance/ARCHITECT_ROLE.md` |
| `AGENT_PROTOCOL.uploaded.md` | — | `spec/governance/AGENT_PROTOCOL.md` |
| `NEW_ARCHITECT_START.uploaded.md` | — | `spec/governance/NEW_ARCHITECT_START.md` |
| `CURRENT_STATE.uploaded.md` | — | `spec/implementation/CURRENT_STATE.md` (stale "Active: WORK-052" + "v2.0" — corrected in its banner) |
| `DAG.uploaded.yaml` | — | `spec/work-orders/DAG.yaml` (`architecture_version: "2.0"` — corrected in its banner) |

Each archived file carries a banner at the top stating its retired,
non-authoritative status and the canonical meaning of the identifier it
originally claimed; the original content below the banner is the verbatim
historical record.
