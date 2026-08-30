# WorkflowOS v1.1 Work Items

These are the planned v1.1 evolution Work Orders. They supplement the frozen v1.0 `spec/work-items.md` and do not retroactively alter completed v1.0 Work Items.

| Work Item | Purpose | Dependencies |
|---|---|---|
| WORK-053 | Architecture v1.1 foundation and control loop | WORK-046, WORK-051, WORK-052 |
| WORK-063 | Identity and Access Layer — human login (OAuth/OIDC, email) and scoped machine identity (service accounts, capability-scoped API credentials) | WORK-002, WORK-048 |
| WORK-054 | Derived System Model and provenance graph | WORK-039, WORK-053 |
| WORK-055 | Quality Attributes and Architecture Fitness | WORK-053, WORK-054 |
| WORK-056 | Engineering Signals and Feedback Intake | WORK-039, WORK-041, WORK-054 |
| WORK-057 | Change Programs and Change Sets | WORK-053, WORK-054, WORK-046, WORK-047 |
| WORK-058 | Adaptive Assurance Engine | WORK-053, WORK-055, WORK-046, WORK-051, WORK-052 |
| WORK-059 | Operational and Release Governance | WORK-055, WORK-056, WORK-058, WORK-019 |
| WORK-060 | Continuous Architecture Evolution and ACR Feedback Loop | WORK-055, WORK-056, WORK-058, WORK-059, WORK-005 |
| WORK-062 | Durable Multi-Agent Orchestration Substrate — durable execution underneath WORK-046 delegation | WORK-046 |
| WORK-061 | Self-Hosting Conformance and Continuous Governance | WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050, WORK-062, WORK-063 |
| WORK-064 | Continuous Product Validation — the ValidationJourney/EffectPolicy domain model | WORK-048, WORK-050, WORK-063 (all complete — WORK-064 COMPLETE: merged `c351451` via PR #86, finalized §34.8/ADR-0007) |
| WORK-065 | Synthetic Browser Validation Agent — the execution mechanism for ValidationJourneys | WORK-064 |
| WORK-066 | Validation Scheduling & Change Triggers — PRE_MERGE/POST_RELEASE/CONTINUOUS, assurance-aware | WORK-064, WORK-065, (soft: WORK-058) |
| WORK-067 | Engineering Signal & Regression Correlation — dedup, release-correlation, regression-likelihood | WORK-064, WORK-015, WORK-040, WORK-041, (soft: WORK-056) |
| WORK-068 | Feedback → Governed Work Items — convert signals through the EXISTING /work-items authority | WORK-067 |
| WORK-069 | Progressive Release & Runtime Validation — canary/partial rollout with governed continue/halt/recover | WORK-064, WORK-066, WORK-019, WORK-026, WORK-020, (soft: WORK-059) |
| WORK-070 | Continuous Architecture Fitness — closed-loop synthesis → architecture risk → ACR | WORK-067, WORK-069, WORK-051, (soft: WORK-055, WORK-060) |

All items remain architect-governed and require a Work Order file, declared surfaces, deterministic assurance, checkpoint requirements, proof contract, and architect-controlled merge.

> **Reconciliation note (2026-08-29, updated by pass 2):** these WORK-053..061 identities follow the
> architect-issued GitHub issues #65..#73 (2026-08-28T17:34Z). The architect's direct-to-main
> upload wave one hour later re-used WORK-053..059 for different scopes under a "2.0" label;
> by the architect's 2026-08-29 PR #74 review verdict this issue-backed track is the ONE
> canonical track and the upload wave is retired under distinct UW-053..059 identities
> (`spec/archive/upload-wave-2026-08-28/`) — see [`reconciliation-record.md`](reconciliation-record.md) §8.
> No item here is activated.
>
> **WORK-062 note (2026-08-30 governance correction):** WORK-062 is NOT part of the original
> issue track #65..#73 — it was issued by the 2026-08-30 governance correction (the
> execution-substrate architecture decision: the durable orchestration substrate underneath
> WORK-046 delegation, in the runtime chain WORK-047 recommendation → WORK-046 governed
> delegation → WORK-062 durable orchestration → existing execution authority → verification →
> review). WORK-061 now depends on it: self-hosting cannot honestly be considered complete
> without durable multi-agent execution and recovery. WORK-062 was ACTIVATED by the
> architect on 2026-08-30 and is COMPLETE — merged by the architect as `f0855d2` via
> PR #82 on 2026-08-30 (squash-merged at the approved review-remediated head `1caa259`;
> the merge tree is identical to the approved head) and finalized complete per
> §34.8/ADR-0007 (PR #83, merged as `46e7858`; program-state.json records status
> complete with the full `mergedAs` provenance identity: pr 82, mergeCommit
> f0855d2955dcf2d3edea683e497902ad30778fc8). WORK-061's WORK-062 dependency edge is
> thereby satisfied; WORK-061 remains blocked on WORK-057/058/059/060 (the WORK-053..056
> foundation chain).
>
> **WORK-063 note (2026-08-30 identity-and-access architecture decision):** WORK-063 is NOT part
> of the original issue track #65..#73 either — it was issued by the 2026-08-30
> identity-and-access architecture decision (the production identity model: human login via
> OAuth/OIDC — Google/GitHub — and email, PLUS scoped machine identity — service accounts with
> capability-scoped API credentials — flowing into the existing server-side authorization chain
> user → organization membership → role/permission → project access; authentication stays
> separated from authorization; API keys remain first-class for automation; the Workbench's
> bootstrap demo-key login is retired). It extends WORK-002's frozen foundation and was placed
> early (wave 2, parallel with WORK-054) because production human login and scoped machine
> identity must exist before customer-facing self-hosting: WORK-061 now also depends on
> WORK-063. WORK-063 is COMPLETE — merged by the architect as `8dac9c4` via PR #81 on
> 2026-08-30 (squash-merged at branch head `f86d1f2`; the tree is identical to the approved
> rebased head) and finalized complete per §34.8/ADR-0007 (program-state.json records status
> complete with the full `mergedAs` provenance identity: pr 81, mergeCommit
> 8dac9c47f7397e22765478520ac71659d37e1783). The merged delivery is SPEC-ONLY (the
> architecture decision, the Work Order, and the dependency-model correction; NO runtime
> implementation rode the merge — the runtime identity layer remains UNIMPLEMENTED,
> architect-gated future work). WORK-061's WORK-063 dependency edge is thereby satisfied;
> WORK-061 remains blocked on WORK-057/058/059/060 (the WORK-053..056 foundation chain).
>
> **WORK-064..070 note (2026-08-30 continuous product validation sub-evolution, ACR-002):**
> these seven Work Orders are NEW in the 2026-08-30 research-driven v1.1 evolution. They
> are SEPARATE from the WORK-053..061 track (which implements ACR-001). They CONSUME (but do
> not duplicate) the ACR-001 capabilities when those Work Orders land: WORK-067 consumes
> WORK-056's signal taxonomy; WORK-069 consumes WORK-059's release framework; WORK-070
> consumes WORK-055's model and WORK-060's loop. Soft dependencies are marked "(soft: …)";
> the Work Order can be implemented with a simpler initial surface and upgraded to the full
> soft dependency when it lands. WORK-064's dependency on WORK-063 references the WORK-063
> Work Order carried into main by PR #81 — COMPLETE (merged as `8dac9c4`, spec-only,
> finalized §34.8/ADR-0007 on 2026-08-30) — and WORK-064 itself is now COMPLETE too:
> ACTIVATED by the architect on 2026-08-30, implemented on branch
> `feat/work-064-continuous-validation` (PR #86), merged as `c351451` (squash-merged at the
> approved head `524c3f4` — the tree is identical) and finalized §34.8/ADR-0007 on
> 2026-08-30 — the domain/model authority is on main at `backend/src/continuous-validation/`.
> WORK-065 and WORK-067 are now DEPENDENCY-ELIGIBLE (both depend only on WORK-064;
> parallel-eligible — different protected surfaces) and remain NOT activated, NOT started
> (recorded honestly in `dependency-state.json` → `futureGenerationEligibility`). The six
> remaining Work Orders (WORK-065..070) are PLANNED and NOT activated. Each carries parallel-execution metadata
> (`parallelEligibility`, `parallelConflicts`, `protectedSurfaces`) — see
> [`parallel-execution-metadata.md`](parallel-execution-metadata.md).
