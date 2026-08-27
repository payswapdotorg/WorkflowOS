# WORK-045 — Agent Roles

Status: READY
Architecture: frozen v1.0 authority model + forward multi-agent intelligence direction (§33.9)
Dependencies: WORK-034, WORK-036, WORK-044

## Objective

Model reusable engineering roles such as Architect, Planner, Implementer, Tester, Security Reviewer, Performance Reviewer, UX Reviewer, and Release Engineer independently from any specific agent/provider.

WORK-045 is a ROLE MODEL / CONTRACT slice. It does not implement multi-agent delegation (WORK-046), agent intelligence (WORK-047), a second routing engine, or a new execution engine.

## Governing contracts

- `/workflows` remains the workflow-state authority.
- `/agents` remains execution/provider gateway authority.
- `/execution-policy` remains the hard eligibility/selection policy authority.
- WORK-044 remains the routing authority for selecting among eligible execution candidates.
- Roles are provider-independent. A role describes responsibility, capabilities, expected inputs/outputs, and execution constraints; it does not name or bind to a specific provider implementation.
- Role resolution is advisory/configuration, not workflow authority.
- Role semantics must not bypass authorization, security, tool policy, eligibility, verification, review, or GitHub authority.
- Native and external execution remain first-class wherever a role is executed.

## Scope

1. Define the provider-independent role contract.
2. Define a closed initial catalog of reusable engineering roles required by the roadmap.
3. Define role metadata sufficient for later routing/delegation without performing provider selection here.
4. Provide deterministic role lookup/resolution by stable role identity.
5. Represent role-required capabilities as declarative requirements consumed by existing eligibility/policy boundaries; do not implement a second evaluator.
6. Preserve native/external execution neutrality.
7. Expose role definitions through an application-layer boundary without creating a new frozen module/authority.
8. Add regression and architecture tests proving roles are reusable, deterministic, provider-independent, and authority-safe.

## Out of scope

- Multi-agent delegation/orchestration (WORK-046)
- Agent Intelligence or learned role selection (WORK-047)
- Adaptive routing or new ranking logic (WORK-044)
- New provider adapters
- New execution engine or session engine
- Workflow state transitions
- Authorization/permission engine
- Verification/review semantics
- GitHub merge/CI authority
- Credential/secret storage
- Frontend role-management UX
- Dynamic marketplace/custom-role authoring unless already required by an existing frozen contract

## Initial role catalog

The implementation must support these stable role identities at minimum:

```text
architect
planner
implementer
tester
security-reviewer
performance-reviewer
ux-reviewer
release-engineer
```

The catalog may be represented as deterministic application data. Do not introduce persistence unless the existing architecture explicitly requires it; a static/immutable catalog is preferred for this bounded slice.

## Acceptance Criteria

### W045-AC01 — Provider-independent role contract

Every role has a stable identity, display name, purpose, responsibilities, required capabilities/constraints, expected inputs, expected outputs, and lifecycle metadata without embedding provider/model identifiers.

Evidence: unit + static architecture test.

### W045-AC02 — Closed initial role catalog

All eight required role identities exist exactly once and resolve deterministically.

Evidence: unit test.

### W045-AC03 — Deterministic resolution

Given a stable role identity, repeated resolution returns the same role definition independent of object iteration or database ordering.

Evidence: deterministic regression test.

### W045-AC04 — No provider binding

Role definitions contain no hard-coded provider/model selection and do not import provider adapters or provider SDKs.

Evidence: static architecture test.

### W045-AC05 — Capability requirements are declarative

A role may declare required capabilities and constraints, but WORK-045 does not evaluate or authorize them. Existing WORK-043 and WORK-037 boundaries remain authoritative.

Evidence: static architecture test + contract test.

### W045-AC06 — Native/external neutrality

Role definitions do not intrinsically prefer native or external execution. Execution-mode information, when present, is declarative/advisory and does not dispatch or select a provider.

Evidence: paired unit/static tests.

### W045-AC07 — No workflow authority

Role resolution cannot transition Work Items, Execution Records, sessions, verification, reviews, or merge state.

Evidence: static architecture test.

### W045-AC08 — No second execution/routing engine

The role layer does not create a second execution engine, eligibility engine, ranking engine, or provider registry. WORK-044 remains the routing boundary and `/agents` remains execution authority.

Evidence: static architecture test.

### W045-AC09 — Reusable role semantics

Two different provider candidates may execute the same role while receiving the same role contract, subject only to the existing eligibility/routing policy for that execution.

Evidence: integration regression test.

### W045-AC10 — Stable role versioning

Role definitions expose a stable version/revision identifier so later changes can be distinguished from the original role contract. Changing a role definition must not silently mutate the meaning of an existing historical execution.

Evidence: unit + integration test.

### W045-AC11 — Tenant-safe resolution

Any request-scoped role resolution remains within the caller's authorized project/organization context. No cross-tenant role metadata or configuration may affect the result.

Evidence: integration/static architecture test.

### W045-AC12 — No credential or secret ownership

Role definitions and role resolution persist/read no provider credentials, tokens, cookies, or secrets.

Evidence: static architecture test.

### W045-AC13 — Explainable role definition

Resolved role output identifies its purpose, responsibilities, requirements, version, and whether execution-mode/capability declarations are advisory versus authoritative.

Evidence: contract + regression test.

### W045-AC14 — Forward compatibility for WORK-046/047

The role contract exposes stable extension points for later delegation and intelligence without requiring those systems to change the role identity model.

Evidence: static architecture test + contract test.

## Required implementation evidence

- Unit tests for catalog completeness and deterministic resolution.
- Static architecture tests for provider independence and authority boundaries.
- Integration tests showing the same role contract can be paired with different eligible native/external candidates without role mutation.
- Version/revision regression tests.
- Tenant/project scoping tests where request-scoped resolution is exposed.
- Typecheck and lint clean.
- Full repository regression suite clean.

## Stop conditions

STOP and raise an Architecture Change Request if implementation requires:

- a new workflow state or workflow engine;
- changing WORK-043 eligibility semantics;
- changing WORK-044 routing semantics;
- provider-specific role definitions as architectural truth;
- a second provider/agent registry;
- credential ownership in the role layer;
- a new authoritative persistence model for execution history;
- changing the frozen architecture version.

## Definition of Done

- W045 acceptance criteria have objective evidence.
- All required tests pass on CI.
- Architecture invariants pass.
- PR contains only WORK-045 scope.
- Independent Architect Review approves the implementation PR.
- Implementation PR is merged.
- WORK-045 is then marked VERIFIED before WORK-046 becomes eligible.
