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
