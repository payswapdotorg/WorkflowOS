# Repository Development State — Authority Declaration

`spec/development-state/` is the **canonical machine-readable development-governance
state of the WorkflowOS repository** (WORK-052, Issue #61 §2). It exists so that a
fresh architect or implementation agent with zero conversational history can determine
what architecture version governs, which Work Orders exist and their statuses, what can
run in parallel, which checkpoints apply at which assurance depth, which decisions
constrain the work, and how to resume interrupted implementation.

## Artifacts and their authority

| Artifact | Authority | Changed by |
|---|---|---|
| `governance-model.json` | The governance MODEL: the Engineering Control Loop, assurance profiles + deterministic selection rules + requirement matrix, the governed checkpoint contracts (architecture fitness functions), the self-hosting boundary, the authority map. | Architect only — through a Work Order (GitHub Issue → `spec/work-orders/`) + PR review. Schema evolution is versioned; never edited in place silently. |
| `program-state.json` | The PROGRAM STATE: the governing architecture version record, one record per Work Order (status, dependencies, declared change surfaces, branch/PR bindings, merge evidence, handoff/resumption records, checkpoint outcomes), and the decisions index. | Implementers per the parallel protocol (one branch per Work Item; updated as work progresses); the architect merges. Statuses are evidence-backed (`complete` requires merge evidence). |
| `dependency-state.json` | Derived dependency eligibility and conflict state. It can be regenerated from authoritative Work Order/program state and the canonical dependency graph. | Derived by governance tooling; never an independent authority. |
| `frontier-state.json` | Derived current implementation frontier and live PR/base reconciliation. | Derived by governance tooling; stale/conflicting state fails closed. |
| `checkpoint-state.json` | Derived checkpoint requirement/result summary. Actual verification evidence remains owned by `/verification`. | Derived by governance tooling and checkpoint orchestration. |

**Who may write what:** the governance model changes only through architect-issued Work
Orders; the program state is maintained by the implementing agent of each Work Order
within its declared surfaces and becomes canonical when the architect merges the PR.
Nothing in this directory is a runtime tenant artifact: PostgreSQL (via the existing
modules) remains the authority for tenant project state; the runtime `/architecture`
module remains the per-project ADR/authority; this directory is the self-hosting plane.

## v1.1 evolution artifacts

The next architecture generation is proposed, not silently activated:

- `spec/architecture/v1.1/` — additive architecture and lock package, including the [reconciliation record](../architecture/v1.1/reconciliation-record.md) (2026-08-29 pass 1: the verified repository truth and the corrected derived state; pass 2: the architect verdict resolving the upload-wave identity collision — §8; and the GitHub enforcement gaps).
- `spec/architecture-change-requests/ACR-001-v1-1-adaptive-engineering-control-system.md` — durable architecture evolution proposal.
- `spec/governance/` — persistent architect, worker, assurance and checkpoint contracts.
- `spec/governance/future-roadmap.json` — planned v1.1 Work Order sequence and parallelization hints.

An ACR is required before a new ArchitectureVersion becomes governing.

## Consumption

- `backend/src/development-governance/` loads and validates both artifacts FAIL-CLOSED
  (schema, vocabularies, DAG acyclicity, evidence-backed statuses, boundary integrity
  against code-pinned core prohibitions, assurance-matrix integrity, enforcement
  references) and answers the control-plane queries.
- `bun run governance:status` (in `backend/`) prints the control-plane summary from a
  fresh checkout.
- The `governance-manifest` detector (7th detector in the WORK-051 closed registry)
  evaluates this state at any exact revision through the architecture-checkpoint
  substrate (`docs/adr/ADR-0006-governance-manifest-detector.md`).
- The post-merge finalization audit (`§34.8`; ADR-0007) binds this state to the
  repository's git merge history: `governance:status` reports every gap (a merged
  Work Order not yet `complete` with matching `mergedAs`).

## Validation invariants (enforced by the loader — fail closed)

1. Schema version match (both artifacts); unknown fields rejected.
2. Closed vocabularies: statuses, assurance profiles, surface flags, feedback origins,
   checkpoint kinds, proof classes.
3. The work-order dependency DAG is acyclic and references known Work Orders only.
4. `complete` records carry merge evidence (`pr` + `mergeCommit`); `in_flight` records
   carry a branch (and a PR number once opened) and NO merge evidence — the explicit
   merge-vs-checkpoint rule: the architect's merge is the ONLY completion event, and
   checkpoint outcomes are implementer claims recorded only on started (`in_flight` /
   `complete`) items; they never substitute the merge (code-pinned, PR #62 round 1).
5. Coordination records are MUTUAL and COVERING: a coordination reference between two
   in-flight work orders appears on BOTH records (one-sided declarations are invalid
   state), an in-flight start over incomplete dependencies coordinates with THOSE
   dependencies, and references point at started (in-flight) or merged (complete) work
   orders only (PR #62 round 1).
6. The self-hosting boundary contains the code-pinned core prohibitions (ADR-0004).
7. Each assurance profile's requirements dominate the WORK-051 impact/checkpoint matrix
   at the corresponding impact level (ADR-0002) — assurance adds depth, never subtracts.
8. Every checkpoint contract's enforcement references exist in the repository.
9. The post-merge finalization protocol is explicit, code-pinned machine-readable
   state (trigger `architect-merge`; the obligation names `mergedAs`, handoff
   removal, and the data-only constraint; the enforcement references the
   merged-finalization invariant; the constraints add no authority, no workflow
   state, no automation — §34.8, ADR-0007).
10. v1.1 derived artifacts cannot supersede v1.0 authorities and cannot activate v1.1
    without an approved Architecture Change Request.

A repository whose development state violates any invariant is NOT a valid governed
state: the control plane refuses to serve it, and the `governance-manifest` checkpoint
detector fails closed.
