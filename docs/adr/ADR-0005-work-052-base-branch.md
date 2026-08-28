# ADR-0005 — WORK-052 branches from the WORK-051 head and merges main

Status: accepted (WORK-052 — an implementation-lineage decision, recorded for review)

## Context

Issue #61 directs: "Build on the already merged WORK-038 through WORK-051 foundations
and preserve WORK-045 roles / WORK-046 delegation / WORK-047 intelligence semantics
where present." At implementation start, `main` (5c7d5bb) contains WORK-045 but NOT
WORK-051, whose implementation PR #52 is open at head `a25eeef` (round-4 remediation
complete, all CI green, awaiting the architect's re-review). WORK-052's core
deliverable — architecture checkpoints as first-class governed control points, the
assurance model, and the checkpoint contracts — extends the WORK-051 substrate
(`src/architecture-checkpoints/`, migrations 0052–0056, the assertion/evidence model).

## Decision

The WORK-052 branch is created from the WORK-051 head `a25eeef` and merges `origin/main`
(5c7d5bb, WORK-045) — commit 5c21256 — following the repository's established
integration pattern (WORK-051 itself merged main in at `f32955e`). WORK-046's branch
(PR #60) is deliberately NOT merged: Issue #61's "where present" wording anticipates its
absence, nothing in WORK-052 depends on the delegation module, and including another
open work item's diff would muddy review. No new migration is added in WORK-052, so
migration numbering 0052–0056 (WORK-051) and 0057 (WORK-046, PR #60) remain reserved
and both merge orders stay clean under the filename-ordered runner.

## Consequences

- The WORK-052 PR's diff against `main` necessarily includes the WORK-051 commits; the
  PR description states this explicitly and the architect can review the combined
  state. If PR #52 merges first, the marginal diff collapses to the WORK-052 commits.
- Re-implementing the checkpoint substrate on bare `main` was rejected: it would create
  a duplicate checkpoint/evidence authority — a hard prohibition — the moment PR #52
  merges.
- If PR #52 receives further remediation rounds, this branch rebases/merges forward as
  needed (the normal integration cost of a real dependency).
