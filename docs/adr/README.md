# Architecture Decision Records — WorkflowOS (repository-resident)

This directory is the **repository-resident Architecture Decision Record authority for
WorkflowOS's own architecture** — the self-hosting side of the runtime `/architecture`
module's per-project ADR feature, which remains the authority for *tenant projects*.
Nothing here replaces or competes with the runtime module: that module governs projects
built BY WorkflowOS; this directory records why WorkflowOS-the-repository is shaped the
way it is, so a fresh architect recovers the rationale trail from the repository alone
(WORK-052, Issue #61 §6 — evidence and decision durability).

## Rules

1. One decision per file, numbered sequentially: `ADR-NNNN-short-name.md`.
2. ADRs are append-mostly: a superseded ADR is marked `Status: superseded by ADR-NNNN`
   and never deleted (decision history is durable).
3. Every ADR states: Status, Context, Decision, Consequences.
4. Material decisions (authority placement, identity choices, fail-closed semantics,
   scope boundaries) REQUIRE an ADR before the implementing PR is reviewed.
5. ADRs are introduced through Work Orders (the architect authorizes the change; the
   implementer records the decision; PR review approves it).
6. The decisions index in `spec/development-state/program-state.json` points at every
   ADR so the control plane surfaces them.

## Index

| ADR | Decision | Status |
|---|---|---|
| [ADR-0001](ADR-0001-repository-resident-governance-state.md) | The development-governance state is repository-resident; no new DB tables; no HTTP API in this increment | accepted |
| [ADR-0002](ADR-0002-assurance-depth-not-authority.md) | Assurance profiles change depth, not authority; requirement dominance over the WORK-051 impact matrix | accepted |
| [ADR-0003](ADR-0003-parallel-protocol-surface-declaration.md) | The parallel protocol is surface-declaration + deterministic conflict detection (git/PR-native) | accepted |
| [ADR-0004](ADR-0004-fail-closed-validation-core-prohibitions.md) | Governance state validates fail-closed against code-pinned core prohibitions | accepted |
| [ADR-0005](ADR-0005-work-052-base-branch.md) | WORK-052 branches from the WORK-051 head + merges main | accepted |
| [ADR-0006](ADR-0006-governance-manifest-detector.md) | The detector registry advances 6→7 with `governance-manifest` | accepted |
