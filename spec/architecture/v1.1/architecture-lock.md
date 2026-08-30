# WorkflowOS v1.1 Architecture Lock

These are forward-evolution invariants for v1.1. They supplement rather than rewrite `spec/architecture-lock.md` v1.0.

## Authority

1. `/architecture` is the sole normative architecture authority.
2. `/requirements` is the sole requirements and acceptance-criteria authority (preserved from the v1.0 module boundaries).
3. `/work-items` is the sole Work Item and Work Order authority.
4. `/workflows` is the sole runtime workflow authority.
5. `/verification` is the sole verification/evidence authority.
6. `/reviews` is the semantic review authority.
7. `/github` is the external repository/PR/CI authority.
8. `spec/development-state/` is the repository-resident development-program state, not a replacement domain authority.

## Evolution

9. v1.0 is immutable historical architecture.
10. ACR approval is required before v1.1 becomes governing.
11. Architecture changes create a new ArchitectureVersion; no self-hosted worker may rewrite a governing version in place.

## Complexity and assurance

12. Work Item remains the atomic governed implementation unit.
13. Change Programs and Change Sets may group Work Items but may not replace Work Item authority.
14. Assurance depth is one of LIGHT, STANDARD, HIGH_ASSURANCE, CRITICAL.
15. Assurance depth changes evidence/checkpoints only; it never weakens authority, security, tenancy, provenance, identity, idempotency, concurrency, or verification semantics.
16. Unknown or unclassified risk defaults to the safer assurance floor.

## Evidence and feedback

17. Derived System Model facts retain provenance and never overwrite authoritative sources.
18. Engineering Signals are evidence-backed and advisory to planning until converted through an authorized Work Item/architecture decision.
19. Quality-attribute fitness requires explicit measurement source and threshold/baseline where a threshold is claimed.
20. Behavioral correctness and transformation completeness are separate proof classes for migrations/refactors.
21. Operational and user feedback may feed planning but cannot directly mutate architecture/workflow/review state.

## Parallel implementation

22. Each implementation agent owns one Work Item branch/PR at a time.
23. Dependency eligibility and protected-surface conflict must be established before parallel execution.
24. Workers may not alter another Work Item's authoritative scope or governance state.
25. Merge remains the architect-controlled convergence gate.

## Self-hosting

26. WorkflowOS may govern its own implementation using the same lifecycle it provides to customer systems.
27. Self-hosting cannot silently change the governing architecture or its own governance rules.
28. Loss of conversational context must not prevent reconstruction of architecture, state, dependencies, checkpoints, decisions, or worker handoff from repository artifacts.

## Continuous product validation (v1.1 sub-evolution, ACR-002 — proposed)

29. The v1.1 control loop EXTENDS the frozen v1.0 10-stage loop with an explicit `VALIDATE` stage between `RELEASE` and `OBSERVE`. The frozen v1.0 control loop (10 stages, no `VALIDATE`) remains governing until ACR-001 + ACR-002 are approved; the v1.1 control loop (11 stages, with `VALIDATE`) is proposed in `control-system-evolution.md`.
30. A `ValidationJourney` declares exactly one `EffectPolicy` (READ_ONLY, SAFE_MUTATION, ISOLATED_MUTATION, or FORBIDDEN). Production synthetic validation must never perform uncontrolled destructive side effects; dangerous functionality requires a sandbox, a synthetic identity, a test tenant, a test payment instrument, controlled external integrations, or another explicitly approved safe mechanism.
31. The browser agent is an execution mechanism, not an authority: it cannot relax a FORBIDDEN, cannot elevate READ_ONLY to SAFE_MUTATION, cannot bypass the EffectPolicy, and cannot mutate code, merge PRs, approve reviews, or transition workflow state.
32. A `TestIdentity` is a synthetic principal (a scoped service account under the WORK-063 identity layer), never a real production user. The demo-key login is not encoded as a permanent customer login.
33. No customer-product validation failure may be silently discarded, converted into a false healthy state, or directly converted into an ungoverned code change. A validation failure produces evidence (provenance preserved), an Engineering Signal (WORK-067), and a governed Work Item (WORK-068, through the EXISTING `/work-items` authority).
34. Validation evidence maps into the EXISTING `/verification` evidence authority as a derived artifact (provenance preserved); it does not create a parallel evidence store.
35. The three validation operating modes (PRE_MERGE, POST_RELEASE, CONTINUOUS) bind the EffectPolicy and the assurance level. The scheduler (WORK-066) consumes triggers from the existing authorities; it does not invent its own. CONTINUOUS runs are scheduled by explicit configuration; no autonomous unsupervised scheduler.
36. Progressive release (WORK-069) binds POST_RELEASE validation to canary/partial rollout with governed continue/halt/recover decisions. The existing deployment authority boundaries are preserved; no second release engine.
37. Continuous architecture fitness (WORK-070) produces architecture-risk recommendations that feed the EXISTING `/architecture` ACR authority. It does not mutate frozen architecture directly; it does not approve ACRs (the architect's non-delegable decision).
38. The seven new Work Orders (WORK-064..070) are SEPARATE from the WORK-053..061 track. They CONSUME (but do not duplicate) the ACR-001 capabilities when those Work Orders land (WORK-067 consumes WORK-056's taxonomy; WORK-069 consumes WORK-059's framework; WORK-070 consumes WORK-055's model and WORK-060's loop).
39. Each new Work Order carries parallel-execution metadata (`parallelEligibility`, `parallelConflicts`, `protectedSurfaces`) so an Architect LLM can mechanically determine READY/BLOCKED/PARALLEL-SAFE/CONFLICTING. A Work Order may not claim "parallel-safe" without identifying why.
40. The Fresh-Architect Bootstrap artifact (`fresh-architect-bootstrap.md`) is the durable record that the repository — not the previous conversation — is authoritative. A new Architect LLM that reads the repository has the same authority as the original architect.
