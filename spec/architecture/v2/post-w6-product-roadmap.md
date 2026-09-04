# WorkflowOS 2.0 — Post-W6 Universal Product UX Program

**Status:** governed product-layer evolution under `V2-ACR-003`
**Program Work Order:** `V2-017`
**Design authority:** `docs/superpowers/specs/2026-09-03-workflowos-universal-ux-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-09-03-v2-017-universal-product-ux.md`
**Repository-only execution contract:** `docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md`
**Precondition:** Original V2 roadmap W0–W6 and IG-005 are complete.

## Purpose

The original V2 implementation roadmap established the universal workflow protocol, semantic model, execution/runtime system, teaching, scheduling, optimization, ecosystem, verifiable execution and self-hosting. After W6, the remaining product problem is to expose those capabilities through one coherent human-facing experience.

V2-017 is the governed product-layer program for that work. It is presentation and interaction composition over existing authorities; it does not redefine workflow semantics, execution authority, evidence truth, marketplace economics, or development governance.

## Authority model

There is one Work Order authority for this product evolution: `V2-017`.

This document is a program decomposition and dependency/navigation artifact. It does not create independent Work Order identities, semantic authorities, execution authorities, or approval authorities.

- `V2-017` owns product UX composition.
- Existing V2 authorities remain authoritative for Workflow, WorkflowVersion, WorkflowIR, Deployment, Run, Node, Capability, authorization, placement, evidence, teaching semantics, marketplace economics, execution attestation/proof, and governance.
- The existing developer/engineering surface remains an expert workspace, not a replacement product architecture.

## Repository-only execution invariant

A fresh agent must be able to execute and recover V2-017 using repository-resident information alone. Conversation history, chat summaries, agent memory, pasted reports, verbal instructions, and unstored assumptions are non-authoritative.

For the complete bootstrap, task-entry, execution, evidence, recovery and handoff contract, read `docs/superpowers/plans/2026-09-04-v2-017-repository-only-execution.md`.

## Product model

Primary product verbs:

`MAKE / DO / LEARN / SHARE / IMPROVE`

Primary navigation:

`Home / Workflows / Explore / Activity`

Universal entry:

`Search / Ask / Create`

Primary workflow actions:

`Run / Teach Me / Edit`, with `Schedule` contextual.

Progressive disclosure:

`DO → UNDERSTAND → CONTROL → INSPECT`

## Program graph

```text
                                   V2-017
                         Universal Product UX Program
                                      │
              ┌───────────────────────┼────────────────────────┐
              │                       │                        │
              ▼                       ▼                        ▼
        Foundation              Workflow-first UX        Ecosystem UX
              │                       │                        │
              │                       ├── T3 Library           ├── T11 Versions + Improve
              │                       ├── T4 Detail            ├── T12 Share + Marketplace
              │                       ├── T5 Create             │
              │                       ├── T6 Run + Placement   │
              │                       ├── T7 Recovery           │
              │                       ├── T8 Scheduling         │
              │                       └── T9 Teach Me           │
              │                                                │
              ├── T1 Shell/navigation                         │
              ├── T2 Home/attention                            │
              ├── T13 Expert workspace                         │
              └── T14 Responsive/mobile                       │
                                      │                        │
                                      └────────┬───────────────┘
                                               ▼
                                      T10 Activity + Trust
                                               │
                                               ▼
                                      T15 Full verification
                                      + real product dogfood
                                               │
                                               ▼
                                      T16 Architect gate
                                               │
                                               ▼
                                      V2-017 COMPLETE
```

The visual grouping above is a product decomposition. Actual task dependencies below are authoritative for implementation sequencing.

## Task graph

### Foundation / shell

**T1 — Human-facing application shell**

- Depends on: `V2-ACR-003` and stable post-W6 `main`.
- Provides: Home / Workflows / Explore / Activity navigation, universal Create entry, session surface, Expert entry, protected-route preservation.
- Merge boundary: independent Task 1 PR.

**T2 — Workflow-first Home**

- Depends on: T1.
- Provides: goal/search entry, recent workflows, attention, approvals, updates, device issues with honest read states.

**T13 — Expert/developer workspace**

- Depends on: T1.
- Provides: explicit expert transition while preserving the existing engineering control surface.
- Must not migrate developer authority into the consumer shell.

**T14 — Responsive/mobile adaptation**

- Depends on: T1 and the shared product-shell surfaces.
- Provides: platform-appropriate mobile/tablet hierarchy without changing semantics.

### Workflow-first UX

**T3 — Workflow library**

- Depends on: T1.
- Provides: My Workflows, Installed, Shared with me, Drafts, Archived, contextual attention filters and workflow cards.

**T4 — Workflow detail**

- Depends on: T3 and existing V2 workflow/version/install authorities.
- Provides: purpose, primary actions, state, steps, when/where, activity, version, access/safety, advanced inspection entry.

**T5 — Tell / Show / Tell + Show creation**

- Depends on: T1.
- Provides: text, voice, demonstration, hybrid creation entry and semantic understanding preview.
- Must compose over existing authoring/public contracts and never create a second workflow representation.

**T6 — Run / approval / where-it-runs**

- Depends on: T4.
- Provides: consequential-action preview, human-readable placement choice, run states, approval affordances.

**T7 — Failure / recovery / takeover**

- Depends on: T6.
- Provides: failure explanation, Take over, Try again, Edit workflow, Stop, with Run identity preserved.

**T8 — Scheduling and events**

- Depends on: T4; consumes existing scheduling/event authorities.
- Provides: human-readable `When` UX, manual/scheduled/event/workflow-completion triggers, advanced trigger controls only on demand.

**T9 — Teach Me / reverse teaching**

- Depends on: T4 and existing teaching/reverse-teaching authorities.
- Provides: lesson entry beside Run, resumable practice, checkpoints, evidence separation, uncertainty disclosure.

### Trust / ecosystem

**T10 — Activity and “How do you know?”**

- Depends on: T6, T7, T9 and existing Run/evidence/attestation authorities.
- Provides: universal activity timeline, concise evidence explanation, advanced verification disclosure.

**T11 — Versions, updates and optimization**

- Depends on: T4.
- Provides: version history, update comparison, explicit adoption, optimization proposals as new versions.

**T12 — Sharing / marketplace / install**

- Depends on: T3/T4/T11 and existing V2-012 authorities.
- Provides: Share, Make my own, Explore listings, install/purchase presentation, entitlement/install/execution separation.

### Completion

**T15 — Full verification and product dogfooding**

- Depends on: T2–T14 being implemented at their feature boundaries.
- Provides: final regression, exact-head CI evidence, real browser end-to-end product journey, persisted dogfooding evidence, acceptance-criteria reconciliation and scope audit.

**T16 — Architect gate**

- Depends on: T15.
- Provides: exact-base verification, PR evidence review, sole-architect merge decision and post-merge finalization.

## Implementation sequencing

The program preserves safe parallelism where surfaces are disjoint:

```text
T1
 │
 ├── T2
 ├── T3
 ├── T5
 └── T13
      │
      └── T14

T3 → T4
T4 → T6 → T7
T4 → T8
T4 → T9
T4 → T11
T3/T4/T11 → T12
T6/T7/T9 → T10

T2–T14 → T15 → T16
```

Implementation agents must use the exact dependency relationships above in combination with the V2 control-plane rules. They must not make an unmerged task implementation a dependency of another task; when composition requires merged artifacts, composition occurs from current `main` through a dedicated integration gate or the declared sequential boundary.

## Integration boundaries

V2-017 uses the following composition checkpoints:

1. **Shell boundary:** T1 establishes the consumer/expert split.
2. **Workflow boundary:** T3 + T4 establish the primary Workflow mental model.
3. **Execution boundary:** T6 + T7 establish Run, recovery and takeover presentation over V2-005/V2-008 authorities.
4. **Teaching boundary:** T9 composes teaching/reverse-teaching over the same immutable WorkflowVersion.
5. **Trust boundary:** T10 composes Run/evidence/attestation without making cryptographic authenticity equal physical proof.
6. **Ecosystem boundary:** T11 + T12 compose immutable versioning, optimization and marketplace/install behavior without authority drift.
7. **Product gate:** T15 is the final cross-feature product dogfooding gate before T16.

If any composition boundary requires changing an existing semantic or authority contract, stop and raise a separate governed V2 architecture change instead of modifying V2-017's UX layer to compensate.

## Non-negotiable constraints

- WorkflowIR remains the semantic source of workflow meaning.
- WorkflowVersion remains immutable.
- Conversation is input, never the durable workflow format.
- Failed reads remain visibly unavailable and are never converted into successful empty states.
- Purchase/entitlement is never presented as execution authorization.
- Signatures/digests/attestations never become automatic proof of physical side effects.
- Unsupported capabilities are disclosed honestly.
- Existing developer/engineering controls remain reachable.
- No second workflow protocol, workflow engine, execution authority, evidence authority, or verification authority.
- No platform-specific workflow semantics.
- Product terminology may simplify architecture vocabulary but may not change semantics.
- Task checkboxes, PR prose, chat history and agent reports never override canonical repository state.

## Completion definition

V2-017 is complete only when:

1. all T1–T15 implementation/verification responsibilities have concrete evidence;
2. real browser product dogfooding covers representative creation, review, execution, completion or recovery, teaching, and version/update behavior;
3. the acceptance criteria in `spec/architecture/v2/work-orders/V2-017.md` are verified line-by-line;
4. the final review confirms no frozen authority or semantic drift;
5. T16 receives sole-architect disposition and actual merge evidence;
6. canonical development state is reconciled after merge.

This document is a governed program map, not permission to skip the Work Order, verification, dogfooding, review, or merge requirements. It must remain sufficient for a zero-history implementation agent to determine how to resume V2-017 from the repository.
