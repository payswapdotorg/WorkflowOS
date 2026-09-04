# WorkflowOS — Architect Review Protocol

## Purpose

This protocol is a repeatable review loop for the sole WorkflowOS Architect. It is repository-governance guidance, not a new authority. Existing architecture, Work Orders, canonical machine state, Git history, CI, verification, and dogfooding evidence remain authoritative.

## Review loop

For every PR:

1. **Verify actual base SHA.** Confirm the PR base ref and commit against live `main` and the declared Work Order entry. Reject stale or ambiguous bases.
2. **Verify actual head SHA.** Confirm the exact PR head currently under review. Do not review a different commit from the one submitted or previously tested.
3. **Inspect the actual diff.** Compare changed files and semantics against the declared Work Order scope. Do not substitute the PR description for the diff.
4. **Identify semantic authority owners.** For every consequential concept touched, identify the existing V2 authority that owns it and confirm the PR composes with rather than duplicates or overrides that authority.
5. **Check for duplicated protocols.** Look for a second workflow protocol, execution model, evidence/verification authority, state machine, semantic representation, or protocol-visible alias.
6. **Check frozen boundary violations.** Verify that WorkflowIR, immutable WorkflowVersion semantics, run/evidence authority, capability/authorization boundaries, placement/locality, marketplace economics, execution proof, and V1 boundaries remain within their declared owners unless a governed architecture change explicitly authorizes otherwise.
7. **Check UX truthfulness.** Where the PR is user-facing, verify terminology and presentation preserve the underlying semantics. Never accept fabricated success, invented facts, or a UI claim that outruns authoritative reads.
8. **Check unavailable/unknown states.** Failed or missing authoritative reads, unsupported capabilities, and unavailable placement must remain visibly unavailable/unknown rather than becoming successful empty or inferred states.
9. **Check regression coverage.** Confirm deterministic tests pin the new invariant, discrimination/mutation cases cover the failure mode, and no required existing regression has been weakened or removed.
10. **Check dogfooding evidence.** Confirm the required real-product or equivalent operational experiment was actually run for the exact head and that positive and negative findings are persisted honestly.
11. **Approve or request correction.** Approve only when scope, architecture, verification, and evidence satisfy the owning Work Order. Request changes with findings tied to concrete repository evidence.
12. **Merge only after gates.** The Architect alone decides whether the PR is mergeable. A green CI result, agent statement, or review approval is not itself the completion event.
13. **Reconcile state after merge.** Bind canonical task state to the actual PR and merge commit. Reconciliation records Git facts; it does not approve, broaden scope, or create a new authority.
14. **Recompute frontier.** Derive the next eligible task from the authoritative Work Order graph, actual Git merge history, roadmap constraints, and required evidence. Treat navigation fields such as `nextEligible` and `nextAction` as projections only.

## Review evidence hierarchy

When sources disagree, prefer:

1. actual Git history and current `main`;
2. canonical development-state authority artifacts;
3. the governing Work Order and governed architecture records;
4. persisted verification and dogfooding evidence;
5. actual PR metadata/diff/comments as supporting evidence;
6. agent summaries, plans, screenshots, and conversational material only as navigation hints.

## Hard stops

Request correction or stop the work when any of the following is true:

- the submitted head is not the head actually verified;
- the branch uses an unmerged sibling as a dependency;
- the diff crosses a frozen authority boundary without a governed architecture change;
- a second semantic/protocol/execution/evidence authority is introduced;
- an unavailable or failed read is presented as successful data;
- a model or UI claim is presented as execution evidence without the required authority;
- required regression, discrimination, security, freshness, replay, cryptographic, integration, or dogfooding evidence is absent or weakened;
- completion is claimed without an actual Architect-authorized merge;
- repository state and Git facts disagree in a way that has not been reconciled;
- derived navigation/projection state is being used to authorize implementation.

## Post-merge discipline

After the Architect merges:

- record the real merge commit and PR identity;
- synchronize the relevant human-readable and machine operational state through the governed reconciliation path;
- preserve negative findings and historical evidence;
- remove obsolete in-flight markers;
- recompute the implementation frontier;
- never treat reconciliation as a second approval.

The Architect should leave the repository in a state where a new Architect can repeat this review loop without relying on the prior session.
