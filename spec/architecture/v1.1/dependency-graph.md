# WorkflowOS v1.1 Dependency Graph

The v1.1 graph supplements the frozen v1.0 dependency graph. Dependencies are authoritative only when represented in the owning Work Order/program state; this document is the design-time graph.

```text
WORK-046 + WORK-051 + WORK-052
            ↓                         WORK-063 ←── WORK-002 + WORK-048
         WORK-053                    (COMPLETE — the identity/authorization
            ↓                         foundation extension and the Developer
         WORK-054                    Workbench whose demo-key login this
         /     \                     replaces; merged 8dac9c4 via PR #81)
        ↓       ↓
    WORK-055  WORK-056
        | \     /                         │
        |  \   /                          │
        ↓   \ /                           │
    WORK-058 WORK-057                     │
        |      |                          │
        └──┬───┘                          │
           ↓                              │
       WORK-059                           │
           ↓                              │
       WORK-060                           │
           ↓                              │
       WORK-062  ←── WORK-046 (complete — the delegation authority; merged f0855d2)
           ↓                              │
       WORK-061 ←─────────────────────────┘

# ── v1.1 continuous product validation sub-evolution (ACR-002) ──
#    (NEW in the 2026-08-30 continuous-product-validation roadmap;
#     SEPARATE from the WORK-053..061 track; CONSUMES, does not
#     duplicate, the ACR-001 capabilities when they land.)

WORK-063 (Identity & Access — COMPLETE: merged 8dac9c4 via PR #81, spec-only, finalized §34.8/ADR-0007)
    │
    ↓
WORK-064 (Continuous Product Validation — COMPLETE: merged c351451 via PR #86, finalized §34.8/ADR-0007)
    │
    ↓
WORK-065 (Synthetic Browser Validation Agent)
    │
    ↓
WORK-066 (Validation Scheduling & Change Triggers)  ← soft: WORK-058
    │
    ↓
WORK-067 (Engineering Signal & Regression Correlation)  ← soft: WORK-056
    │
    ↓
WORK-068 (Feedback → Governed Work Items)
    │
    ├────────────→ WORK-069 (Progressive Release & Runtime Validation)  ← soft: WORK-059
    │                      │
    └──────────────────────┴──→ WORK-070 (Continuous Architecture Fitness)  ← soft: WORK-055, WORK-060
```

Exact edges:

- WORK-053 ← WORK-046, WORK-051, WORK-052
- WORK-054 ← WORK-039, WORK-053
- WORK-055 ← WORK-053, WORK-054
- WORK-056 ← WORK-039, WORK-041, WORK-054
- WORK-057 ← WORK-053, WORK-054, WORK-046, WORK-047
- WORK-058 ← WORK-053, WORK-055, WORK-046, WORK-051, WORK-052
- WORK-059 ← WORK-055, WORK-056, WORK-058, WORK-019
- WORK-060 ← WORK-055, WORK-056, WORK-058, WORK-059, WORK-005
- WORK-062 ← WORK-046
- WORK-063 ← WORK-002, WORK-048
- WORK-061 ← WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050, WORK-062, WORK-063

v1.1 continuous product validation sub-evolution (ACR-002) edges:

- WORK-064 ← WORK-048 (complete), WORK-050 (complete), WORK-063 (complete — merged as 8dac9c4 via PR #81, spec-only, finalized §34.8/ADR-0007) → WORK-064 is COMPLETE (merged as c351451 via PR #86 on 2026-08-30 — the approved head 524c3f4, tree identical — and finalized §34.8/ADR-0007; the domain/model authority is on main at backend/src/continuous-validation/)
- WORK-065 ← WORK-064 (complete) → WORK-065 is DEPENDENCY-ELIGIBLE and NOT activated
- WORK-066 ← WORK-064 (complete), WORK-065, WORK-058 (soft — adaptive assurance engine, planned)
- WORK-067 ← WORK-064 (complete), WORK-015 (complete — existing verification), WORK-040 (complete — continuous planning), WORK-041 (complete — maintenance), WORK-056 (soft — signal intake, planned) → WORK-067 is DEPENDENCY-ELIGIBLE and NOT activated
- WORK-068 ← WORK-067
- WORK-069 ← WORK-064 (complete), WORK-066, WORK-019 (complete — deployment governance), WORK-026 (complete — runtime), WORK-020 (complete — audit), WORK-059 (soft — operational/release governance, planned)
- WORK-070 ← WORK-067, WORK-069, WORK-051 (complete — architecture checkpoint framework), WORK-055 (soft — quality-attribute model, planned), WORK-060 (soft — ACR feedback loop, planned)

WORK-062 (Durable Multi-Agent Orchestration Substrate) was added by the
2026-08-30 governance correction — the execution-substrate architecture
decision. It is the durable orchestration substrate underneath WORK-046
delegation: the runtime authority chain is WORK-047 (recommendation) →
WORK-046 (governed delegation) → WORK-062 (durable orchestration) → the
existing execution authority → verification → review, while the dependency
edge is WORK-062 ← WORK-046 and WORK-047's recorded dependency on WORK-046 is
unchanged. WORK-061 now depends on WORK-062 because self-hosting cannot
honestly be considered complete without durable multi-agent execution and
recovery. WORK-062 was ACTIVATED by the architect on 2026-08-30 and COMPLETE:
merged by the architect as `f0855d2` via PR #82 on 2026-08-30 (squash-merged at
the approved review-remediated head `1caa259`; the merge tree is identical to
the approved head) and finalized complete per §34.8/ADR-0007 (see
`spec/work-orders/WORK-062.md` and the program state). WORK-061's WORK-062
dependency edge is satisfied; WORK-061 remains blocked on
WORK-057/058/059/060.

WORK-063 (Identity and Access Layer) was added by the 2026-08-30
identity-and-access architecture decision — the production identity model:
human login (OAuth/OIDC: Google/GitHub; email) and scoped machine identity
(service accounts with capability-scoped API credentials) flowing into the
EXISTING server-side authorization chain (user → organization membership →
role/permission → project access), extending WORK-002's frozen foundation
and replacing the Workbench's bootstrap demo-key login (WORK-048) — while
adding NO second workflow/business authority, NO client-side authorization,
and NO removal of API keys (automation stays first-class). It was placed
early (wave 2) because production human login and scoped machine identity
must exist before customer-facing self-hosting: WORK-061 now also depends
on WORK-063 — the self-hosting experience begins with a human signing in
and ends with an authorized agent running governed work. WORK-063 is
COMPLETE: merged by the architect as `8dac9c4` via PR #81 on 2026-08-30
(squash-merged at branch head `f86d1f2`; the tree is identical to the
approved rebased head) and finalized complete per §34.8/ADR-0007 — the
delivery is SPEC-ONLY (the architecture decision, the Work Order, and the
dependency-model correction; NO runtime implementation rode the merge; the
runtime identity layer remains UNIMPLEMENTED, architect-gated future work).
See `spec/work-orders/WORK-063.md` and the program state.

WORK-064..070 (the continuous product validation sub-evolution, ACR-002) are
NEW Work Orders issued by the 2026-08-30 research-driven v1.1 evolution. They
are SEPARATE from the WORK-053..061 track (which implements ACR-001). They
CONSUME (but do not duplicate) the ACR-001 capabilities when those Work
Orders land:

- WORK-067 (Engineering Signal & Regression Correlation) is the
  CORRELATION/REGRESSION-DETECTION LAYER that CONSUMES WORK-056's signal
  taxonomy when WORK-056 lands; until then, it operates on raw observations
  directly with the same provenance discipline.
- WORK-069 (Progressive Release & Runtime Validation) is the CLOSED-LOOP
  RUNTIME VALIDATION LAYER that CONSUMES WORK-059's release governance
  framework when WORK-059 lands; until then, it operates directly on the
  existing v1.0 release/runtime authorities.
- WORK-070 (Continuous Architecture Fitness) is the CLOSED-LOOP SYNTHESIS
  of WORK-055 (the model) + WORK-060 (the loop) + WORK-067 (signals) +
  WORK-069 (release/runtime evidence). It does not replace any of them.

WORK-063 (Identity and Access Layer) is the identity layer for WORK-064's
authenticated journeys AND for WORK-061's customer-facing self-hosting (see
the main track above). WORK-063 was carried into main by PR #81 (the
2026-08-30 identity-and-access architecture decision, reconciled onto this
mainline) and is COMPLETE — merged as `8dac9c4` (spec-only) and finalized
per §34.8/ADR-0007. WORK-064's dependency on WORK-063 was thereby SATISFIED,
and WORK-064 is itself now COMPLETE: ACTIVATED by the architect on 2026-08-30
(after the approved implementation plan merged as `4018f42`), implemented on
branch `feat/work-064-continuous-validation` (PR #86), merged as `c351451`
(squash-merged at the approved head `524c3f4` — the tree is identical) and
finalized per §34.8/ADR-0007 on 2026-08-30. (The runtime identity layer that
the authenticated journeys will eventually exercise remains UNIMPLEMENTED
future work; journeys requiring authentication stay governed by the Work
Order's PRE_MERGE/FORBIDDEN rules until that implementation lands under its
own authorization.)

WORK-065..070 are PLANNED and NOT activated. WORK-065 and WORK-067 are now
DEPENDENCY-ELIGIBLE (both depend only on the complete WORK-064;
parallel-eligible — different protected surfaces). The architect's
authorization is required to activate any of them (recorded in
`program-state.json`).
Each carries parallel-execution metadata
(`parallelEligibility`, `parallelConflicts`, `protectedSurfaces`) — see
`parallel-execution-metadata.md` and each Work Order's `Parallel-execution
metadata` section.

Parallelization is permitted only where dependencies are complete and protected-surface coordination permits it. The graph is not itself an authorization token; derived frontier state must reconcile it with live program state and GitHub merge evidence.

> **Reconciliation note (2026-08-29, updated by pass 2):** the architect's direct-to-main upload wave
> (2026-08-28T18:24–18:40Z) re-used the WORK-053..059 identifiers for a different
> dependency set (053←[052], 054←[053], 055←[052], 056←[053,055], 057←[053,055],
> 058←[056,057], 059←[058]) under a "2.0" label. By the architect's 2026-08-29 PR #74
> review verdict, this design-time graph (the architect-issued issues #65..#73) is the
> one canonical track; the upload wave is retired under distinct UW-053..059 identities
> (`spec/archive/upload-wave-2026-08-28/`), and `spec/development-state/dependency-state.json`
> `futureGeneration` is the one canonical dependency mapping — see
> [`reconciliation-record.md`](reconciliation-record.md) §8.

> **Continuous product validation sub-evolution note (2026-08-30):** WORK-064..070
> are NEW Work Orders issued by the 2026-08-30 research-driven v1.1 evolution.
> They do NOT collide with WORK-053..061 (the ACR-001 track) — different
> identifiers, different scopes, different protected surfaces. The dependency
> edge WORK-064 ← WORK-063 references the WORK-063 Work Order carried into
> main by PR #81 — COMPLETE (merged as `8dac9c4`, spec-only, finalized
> §34.8/ADR-0007 on 2026-08-30) — and WORK-064 itself is now COMPLETE too:
> ACTIVATED 2026-08-30, merged as `c351451` via PR #86 (the approved head
> `524c3f4`, tree identical) and finalized §34.8/ADR-0007 on 2026-08-30.
> WORK-065 and WORK-067 are DEPENDENCY-ELIGIBLE (both depend only on WORK-064)
> and remain NOT activated, NOT started (the eligibility is recorded honestly
> in `dependency-state.json` → `futureGenerationEligibility`).
