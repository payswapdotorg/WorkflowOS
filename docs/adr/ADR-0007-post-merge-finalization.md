# ADR-0007 — The Post-Merge Finalization Protocol

Status: accepted (WORK-052 post-merge corrective finalization)

## Context

WORK-052 defined the completion rule precisely: the architect's merge of the
implementation PR is the ONLY completion event; checkpoint outcomes are
implementer claims that never substitute the merge (code-pinned in the shared
validation engine since the PR #62 round-1 review).

PR #62 was merged as `47615c236ec0e194e112efd3d2ef0f432c4bf210` (squash merge of
head `2f1daec`) on 2026-08-28. The post-merge architectural review then found
the canonical repository state still recording WORK-052 as `in_flight` with the
stale head `7fa47c2` and an active handoff inviting a fresh instance to resume
already-merged work. The rule was sound; the operational gap was structural: the
PR cannot know its eventual merge commit before the architect merges, and
nothing in the repository bound the canonical state to the merge history after
the fact. A condition without a finalization mechanism leaves the repository
able to hold a materially false program state — exactly the
authority/provenance failure this milestone exists to prevent.

The same review confirmed the positive side: the completion semantics, mutual
coordination, truthful frontier, and shared validation engine carried forward
correctly. This ADR closes the operational gap without redesigning WORK-052.

The PR #63 architectural review of the corrective change then found one
provenance defect in the new invariant: the audit validated only
`mergedAs.mergeCommit` — a genuine merge commit paired with a false
`mergedAs.pr` audited clean, violating the obligation this protocol states
(`mergedAs` records the PR number AND the actual merge commit). The invariant
therefore validates the ENTIRE `mergedAs` identity (the PR #63 round-2
correction).

## Decision

The governance model gains an explicit, code-pinned **post-merge finalization
protocol** (`governance-model.json` `postMergeFinalization`; validated by the
ONE shared engine):

1. **Trigger.** The architect's merge landing on `main` — the same event that
   completes the work order.
2. **Obligation.** The canonical state is finalized: the Work Order's status
   becomes `complete` with `mergedAs` recording the PR number and the ACTUAL
   merge commit; the active handoff is removed (a fresh instance can never
   resume already-merged work); the work-order document status is updated. The
   finalization is a small, data-only change merged by the architect; no code
   rides along unless separately ordered.
3. **Enforcement — the merged-finalization invariant.** A Work Order with merge
   evidence in the repository's first-parent history must be `complete` with a
   `mergedAs` matching the AUTHORITATIVE merge identity — the PR number AND
   the ACTUAL merge commit are both validated (for the `WORK-NNN:`
   squash/direct-merge convention the work order's declared `pr` remains the
   PR identity while the subject binds the commit to the work order; a bound
   record declaring no `pr` fails closed). Evidence is repository-resident git
   history in both merge shapes this repository actually uses:
   `Merge pull request #N from …` (classic merge commits, bound by PR number)
   and the architect-merge subject convention `WORK-NNN: …` (squash/direct
   merges, bound by work-order id — PR #62 merged this way). The invariant is
   enforced by the static architecture suite against the real git history (CI
   fails between the merge and the finalization — that visible red window IS
   the enforcement) and reported by `governance:status`
   (`backend/src/development-governance/internal/merged-finalization.ts`
   is the ONE audit implementation, shared by the CLI and the suite).
4. **Constraints (code-pinned).** No new authority — the architect remains the
   only completion authority and the finalization records the architect's merge
   decision after the fact; no new workflow state — statuses stay
   pending/blocked/in_flight/complete; no automation — the protocol is manual
   and architect-controlled; the audit consumes repository-resident git history
   only, never an external service.

This corrective change bootstraps the protocol and therefore carries code along
with the WORK-052 finalization data (the protocol codification, the audit
module, the ADR-0006 detector correction). Subsequent finalizations are
data-only.

## Consequences

- A merged Work Order can no longer remain represented as `in_flight` in
  canonical state without failing CI: the false state the post-merge review
  found becomes structurally unmissable.
- Between the architect's merge and the finalization, CI runs red on main by
  design. The window is visible, bounded by architect action, and can never
  silently pass — an unambiguous cost signal that the finalization is owed.
- The completion authority is unchanged: the architect merges the
  implementation PR (the completion event) and merges the finalization (the
  recording of that event). A complete Work Order is re-opened only by an
  architect-issued Work Order.
- The audit binds only what the repository binds: work orders carry PR
  bindings (`pr`) and merge subjects carry work-order ids; historical records
  whose merge evidence predates these bindings remain covered by the structural
  validator rules (complete ⇒ mergedAs; in_flight ⇒ no mergedAs).
- `mergedAs` is a durable provenance IDENTITY: the PR number and the merge
  commit are BOTH validated against the repository's merge evidence — a
  genuine merge commit paired with a false PR number is rejected, and a
  bound record declaring no `pr` fails closed (the PR #63 round-2 review).
- Multiple merge events for one work order (e.g. an implementation merge plus a
  corrective finalization squash) audit clean when `mergedAs` matches ANY
  actual merge commit; `mergedAs` records the completion event (the
  implementation merge).

## Amendment — the third merge-evidence shape (2026-08-30, the WORK-063 finalization)

The architect merged PR #81 as `8dac9c47f7397e22765478520ac71659d37e1783`
(subject "Governance: WORK-063 — Identity and Access Layer (the
identity-and-access architecture decision) (#81)") — a THIRD merge-evidence
shape this repository's architect actually uses: the governance-decision
squash-merge convention `Governance: WORK-NNN — title (#PR)` (previously seen
at `9aadd50`, the PR #80 governance correction that issued WORK-062). The
evidence collector recognized only the classic `Merge pull request #N from …`
and `WORK-NNN: …` colon conventions, so the actual WORK-063 architect merge
was invisible to the audit — the exact fail-open blindness this protocol
exists to prevent (a merged-but-unfinalized work order would not open the red
window when the merge subject uses an unrecognized shape).

The WORK-063 post-merge finalization fixes this narrowly
(`backend/src/development-governance/internal/merged-finalization.ts`): the
evidence collector recognizes the governance-decision convention — the
work-order id in TITLE-HEAD position after the fixed `Governance: ` prefix,
separated by an em-dash — binding by work-order id, with the declared `pr`
remaining the PR identity exactly as for the colon convention. Every existing
discrimination is preserved and now regression-pinned: a post-merge
FINALIZATION commit (the `chore(governance): the WORK-NNN post-merge
finalization — … (#PR)` shape of `46e7858`/PR #83, and every topic-naming
subject such as `1ccc45f`/PR #63) is structurally excluded — it can never be
mistaken for the architect's merge. Recognizing `9aadd50` alongside
`f0855d2` as WORK-062 evidence is consistent with the multi-merge rule above:
both are actual architect merges of WORK-062 identity content, and
`mergedAs` records the completion event `f0855d2`, which the audit matches
against ANY actual merge commit.
