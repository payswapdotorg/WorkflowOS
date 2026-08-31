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
| WORK-071 | Local Development Runtime Substrate — a supported dev-only runtime path so WorkflowOS runs against real authorities without requiring an externally hosted PostgreSQL (no production semantics altered) | WORK-003, WORK-023 (both complete — WORK-071 COMPLETE: merged `8604c8a` via PR #96, recorded complete per §34.8/ADR-0007) |
| WORK-072 | Authentication State Synchronization — fix the frontend auth-state ownership defect (LoginPage changes auth state locally while the App-level state is not synchronously observing → reload required before protected routes become visible) | none (hard) — frontend-only; the historical conflict with WORK-074 on the shared LoginPage/useAuth/App.tsx surface is RESOLVED on the surface (WORK-074 is COMPLETE — merged `cdedd0ca` via PR #99), so no live in-flight partner remains |
| WORK-073 | Create Project Organization Selection — fix the Create Project UI to expose the valid organization selection/input path through the EXISTING organizations authority (no fabricated empty state) | none (hard) — frontend-only (ProjectListPage `CreateProjectForm`); uses the existing WORK-002/WORK-004 authorities |
| WORK-074 | Identity & Access Runtime Activation — the RUNTIME IMPLEMENTATION of WORK-063's spec-only identity-and-access architecture decision (the logical alias "WORK-063-RUNTIME" of the dogfooding experiment's design resolves to this canonical numeric identity) | WORK-063 (complete, spec-only, merged `8dac9c4` via PR #81 — this Work Order implements what that spec specifies); WORK-074 COMPLETE: merged `cdedd0ca` via PR #99, finalized per §34.8/ADR-0007 |

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
>
> **WORK-071..074 note (2026-08-30 customer dogfooding experiment's governed follow-up,
> recomputed by the PR #87 reconciliation):** these four Work Orders are NEW in the
> 2026-08-30 dogfooding-governed follow-up. The experiment was ATTEMPTED and STOPPED at
> onboarding (the runtime does not yet provide the required production authentication or
> a local runtime database path) — see
> [`dogfooding-evidence/2026-08-30-onboarding-attempt.md`](dogfooding-evidence/2026-08-30-onboarding-attempt.md).
> They are issued PLANNED, NOT activated, NOT started, and remain OUTSIDE
> `program-state.json` → `workOrders[]` until the architect activates them (recorded
> in `dependency-state.json` → `futureGeneration` and `future-roadmap.json` → `sequence`).
> WORK-071 is the local-development runtime substrate (finding F-2); WORK-072 fixes the
> frontend auth-state synchronization defect (finding F-3); WORK-073 fixes the Create
> Project organization-selection / provenance defect (finding F-4); WORK-074 is the
> RUNTIME ACTIVATION of WORK-063's spec-only identity-and-access architecture decision
> (finding F-1; the logical alias "WORK-063-RUNTIME" of the experiment's design resolves
> to the canonical numeric identity WORK-074 per the repo's identity-surface invariant).
> WORK-074 is NOT a re-decision of WORK-063's architecture — WORK-063 remains the
> architecture authority (merged as `8dac9c4`, spec-only, finalized §34.8/ADR-0007);
> WORK-074 implements what that spec specifies. WORK-071 and WORK-074 are the
> dogfooding-gate enablers ([`dogfooding-model.md`](dogfooding-model.md) §8, updated in
> this change) and are PARALLEL-SAFE with each other (different protected surfaces: the
> platform/runtime substrate vs the identity/auth runtime). WORK-072 and WORK-073 are
> PARALLEL-SAFE with each other (different frontend surfaces). WORK-072's
> historical conflict with WORK-074 on the shared LoginPage/useAuth/App.tsx
> surface is RESOLVED on the surface (WORK-074 is COMPLETE — merged `cdedd0ca`
> via PR #99); no live in-flight partner remains.
> F-5 (authority read failure → explicit error → no fabricated empty state) is a POSITIVE
> finding and carries NO Work Item. F-6 (GitHub/Vercel/LLM configuration not exercisable)
> and F-7 (target product could not be fully built/deployed) are blocked-by-prerequisite
> findings and carry NO Work Item. (Historical, at the PR #87 reconciliation: the
> program was then 55/55 recorded work orders complete with nothing in flight —
> WORK-064 among them, merged as `c351451` via PR #86 and finalized
> §34.8/ADR-0007 via PR #95 — and that change did NOT claim any of WORK-071..074
> was activated or in flight; NO runtime implementation rode it —
> governance/persistence only.)
>
> **Live state (the 2026-08-31 WORK-074 post-merge finalization, §34.8/ADR-0007):**
> WORK-071 is COMPLETE (merged `8604c8a` via PR #96) and WORK-074 is COMPLETE
> (merged `cdedd0ca` via PR #99 — the runtime identity layer is on main: human
> login, server-side sessions, scoped machine identity, the Workbench off the
> demo key); the program is 57/57 recorded work orders complete with NOTHING in
> flight. WORK-072 and WORK-073 remain PLANNED, NOT activated, NOT started. The
> dogfooding gate's two enabler edges (WORK-074 + WORK-071) are SATISFIED — the
> first full authenticated/local dogfooding experiment is PERMITTED and NOT
> started (the architect's authorization governs the run). WORK-063 remains
> complete = the architecture/specification identity (spec-only, `8dac9c4`);
> WORK-074 is complete = the runtime implementation — the two identities are NOT
> collapsed.
