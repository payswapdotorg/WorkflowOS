# WorkflowOS Implementation Backlog — Dependency Graph

## 1. DEPENDENCY GRAPH

### Foundation
PLAT-001 → DATA-001, DATA-002, DATA-003, SEC-001, OBS-001

AUTH-001 → AUTH-002 → AUTH-003
DATA-001 → PROJ-001 → AUTH-003

### Planning
PROJ-001 → SPEC-001 → ARCH-001
ARCH-001 → ARCH-002, ARCH-003
ARCH-002 + ARCH-003 → ARCH-004
ARCH-001 → REQ-001 → REQ-002
REQ-001 + REQ-002 + ARCH-001 + PROJ-001 → WORK-001 → WORK-002 → WORKFLOW-001
WORK-001 + REQ-002 + ARCH-001 → WORK-003

### GitHub
AUTH-002 + PROJ-001 + SEC-001 → GITHUB-001 → GITHUB-002
GITHUB-001 + SEC-001 + DATA-001 + DATA-002 → GITHUB-003 → GITHUB-004
GITHUB-002 + WORK-001 → GITHUB-005
GITHUB-002 + GITHUB-003 → GITHUB-006

### LLM / agents
WORK-003 + SEC-001 → AGENT-001 → AGENT-002
PLAT-001 + SEC-001 → LLM-001 → LLM-002, LLM-003
LLM-003 depends on WORK-003 + REQ-002 + ARCH-001

### Verification / review
GITHUB-006 + REQ-002 + DATA-001 + DATA-003 → VERIFY-001 → VERIFY-002 → VERIFY-003
VERIFY-003 + WORK-001 + GITHUB-005 → REVIEW-001 → REVIEW-002

### Workflow convergence
WORK-001 + WORK-002 + GITHUB-005 → WORKFLOW-001
WORKFLOW-001 + WORK-003 + AGENT-001 → WORKFLOW-002
WORKFLOW-001 + VERIFY-001 + REVIEW-001 → WORKFLOW-003
WORKFLOW-003 + GITHUB-005 → WORKFLOW-004
WORKFLOW-001 + OBS-001 + AUDIT-001 → WORKFLOW-005

### Application order
WORKFLOW-002 → implementation orchestration
GITHUB-006 + VERIFY-001..003 + REVIEW-001..002 + WORKFLOW-002 → WORKFLOW-003
WORKFLOW-003 + GITHUB-005 → WORKFLOW-004
WORKFLOW-004 → AUDIT-001 / UI-001..003 / NOTIFY-001 as applicable

## 2. PARALLELIZATION

After the foundation and project/security substrate, these streams can proceed in parallel:

- Specifications and architecture management
- Requirements and acceptance criteria
- GitHub App/repository integration
- LLM Gateway
- Agent Gateway
- Audit/observability foundations

The main convergence point is the workflow engine, which consumes contracts from work items, GitHub PRs, agents, verification, and reviews.

## 3. DEPENDENCY INVARIANTS

- No requirement depends on an undefined requirement.
- Work-item dependencies must form an acyclic graph.
- Workflow state authority remains in `/workflows`.
- Verification semantics remain in `/verification`.
- GitHub-specific behavior remains in `/github`.

## 4. IMPLEMENTED AUTONOMOUS EXECUTION EXTENSIONS

The following work items extend the original frozen lifecycle without changing its authority model:

WORK-024 → WORK-025
WORK-025 → WORK-026
WORK-026 → WORK-027
WORK-027 → WORK-028
WORK-028 → WORK-029
WORK-029 → WORK-030
WORK-030 → WORK-031

```text
WORK-025 Autonomous architecture/workspace
        ↓
WORK-026 Runtime + implementation context + provider configuration
        ↓
WORK-027 Native/external execution abstraction
        ↓
WORK-028 Companion extension
        ↓
WORK-029 Z.ai external adapter
        ↓
WORK-030 ChatGPT/Codex external adapter
        ↓
WORK-031 Claude Code external adapter
```

## 5. NEXT ROADMAP DEPENDENCIES

### Evidence and execution policy

WORK-031 → WORK-032
WORK-032 → WORK-033

`WORK-032` provides benchmark evidence. `WORK-033` defines fair benchmark modes and execution policy without suppressing provider capabilities.

### Execution substrate

WORK-033 → WORK-034
WORK-034 → WORK-035
WORK-035 → WORK-036
WORK-036 → WORK-037

```text
WORK-034 Persistent Agent Sessions
        ↓
WORK-035 Workspace + Git Worktrees
        ↓
WORK-036 Tool Runtime
        ↓
WORK-037 Agent Policy + Permissions
```

### Existing-project understanding

WORK-035 + WORK-036 + WORK-037 → WORK-038
WORK-038 → WORK-039

`WORK-038` establishes an explicit Project Baseline for repositories not originally created by WorkflowOS. `WORK-039` builds persistent repository/context intelligence from that baseline.

### Continuous development and maintenance

WORK-039 + WORK-032 → WORK-040
WORK-039 + WORK-040 → WORK-041

```text
WORK-040 Continuous Development Planner
WORK-041 Maintenance + Project Health Engine
```

Both feed governed Work Items rather than creating parallel workflow engines.

### Cross-mode execution and adaptive routing

WORK-034 + WORK-027 → WORK-042
WORK-033 + WORK-037 + WORK-042 → WORK-043
WORK-032 + WORK-033 + WORK-043 → WORK-044

```text
WORK-042 Cross-Mode Handoff
        ↓
WORK-043 Execution Eligibility + Constraints
        ↓
WORK-044 Adaptive Execution Router
```

Eligibility is evaluated before benchmark ranking. Subscription plans, quota, privacy, policy, capability, and availability are hard constraints; benchmark quality is a ranking signal only among eligible candidates.

### Multi-agent intelligence

WORK-034 + WORK-036 + WORK-044 → WORK-045
WORK-045 + WORK-035 + WORK-037 → WORK-046
WORK-032 + WORK-044 + WORK-046 → WORK-047

```text
WORK-045 Agent Roles
        ↓
WORK-046 Multi-Agent Delegation
        ↓
WORK-047 Agent Intelligence
```

Agent Intelligence may recommend roles/providers/models/modes from historical evidence, but must not override hard constraints or authoritative workflow/verification/review boundaries.

WORK-046 → WORK-062

```text
WORK-047 Agent Intelligence          (advisory — recommends)
        ↓ recommendation
WORK-046 Multi-Agent Delegation      (the ONE delegation authority)
        ↓ governed delegation
WORK-062 Durable Multi-Agent Orchestration Substrate  (complete — merged f0855d2)
        ↓ durable orchestration
existing Execution Authority         (the ONE execution authority)
        ↓
existing Verification
        ↓
existing Review
```

The WORK-047 → WORK-046 → WORK-062 chain is the RUNTIME authority/flow ordering
(who recommends, who governs delegation, who orchestrates durably) — not a
restatement of build dependencies: the dependency edge is WORK-046 → WORK-062
(the substrate is built underneath the delegation authority), and WORK-047's
recorded dependency on WORK-046 is unchanged. The substrate makes every
delegated execution durable — dependency-aware scheduling, one durable
execution identity per delegated execution, idempotent retries, leases/ownership
with fencing, crash/restart reconciliation, external execution convergence,
explicit partial completion, deterministic reconciliation, and safe
dependency-aware parallelism across simple/complex/very-complex execution
shapes — while adding NO second workflow engine, NO second delegation
authority, NO second execution authority, NO second verification authority,
and NO Redis-backed source of truth (PostgreSQL stays authoritative). See
`spec/work-orders/WORK-062.md` (issued by the 2026-08-30 governance correction;
ACTIVATED 2026-08-30; MERGED by the architect as `f0855d2` via PR #82 on 2026-08-30
— squash-merged at the approved review-remediated head `1caa259`, finalized complete
per §34.8/ADR-0007). WORK-061 depends on WORK-062: self-hosting cannot
honestly be considered complete without durable multi-agent execution and
recovery — that dependency edge is now SATISFIED (WORK-061 remains blocked on
WORK-057/058/059/060, the WORK-053..056 foundation chain).

### Product experience

WORK-040 + WORK-041 + WORK-042 + WORK-044 → WORK-048
WORK-041 + WORK-048 → WORK-049
WORK-042 + WORK-043 + WORK-048 → WORK-050

```text
WORK-048 Developer Workbench
WORK-049 Project Health + Maintenance UX
WORK-050 Unified Execution UX
```

The UX layer is a consumer of the same authoritative execution/workflow contracts and must not introduce frontend-owned workflow state.

### Identity and access (production human + machine identity)

WORK-002 + WORK-048 → WORK-063
WORK-063 → WORK-061

```text
Human users                     Machine/agent clients
(OAuth/OIDC: Google,            (service accounts with
 GitHub; email)                  capability-scoped API credentials)
        └──────────┬──────────────────┘
                   ▼
         Identity / Session           (authentication — who are you?)
                   ▼
         Organization / Membership
                   ▼
         Project authorization        (server-side, authoritative —
                   ▼                   what may you do to this project?)
         existing WorkflowOS authorities (unchanged)
```

WORK-063 (Identity and Access Layer) replaces the bootstrap demo-key login
with the production identity model. It extends WORK-002's frozen foundation
(the `AuthProvider` boundary, deterministic identity resolution,
organizations/memberships/roles/permissions, the `AuthorizationService`
decision chain with tenant isolation) and retires the Workbench's demo-key
bootstrap (WORK-048). Authentication stays SEPARATED from authorization:
login — human or machine — produces a principal; authorization is always a
server-side decision on the existing chain (user → membership →
role/permission → project access; AUTHZ-AC-01..03 unchanged). Both principal
kinds are first-class and permanent: humans sign in with Google/GitHub/email;
agents present scoped service-account credentials (e.g. CAN read Work
Orders, create branches, create PRs, read execution state; CANNOT modify
architecture, approve their own PR, alter verification evidence, or change
tenant). API keys REMAIN available for automation — the layer is never an
"OAuth-only" replacement. It adds NO second workflow/business authority, NO
client-side authorization, and NO new tenant-isolation model. WORK-063 is
COMPLETE — merged by the architect as `8dac9c4` via PR #81 on 2026-08-30
(spec-only: the architecture decision, the Work Order, and the
dependency-model correction; NO runtime implementation rode the merge) and
finalized per §34.8/ADR-0007 — see `spec/work-orders/WORK-063.md` and the
program state. The runtime identity layer the Work Order specifies remains
UNIMPLEMENTED (architect-gated future work).
WORK-061 depends on WORK-063: the customer-facing self-hosting experience
begins with a human signing in and ends with an authorized agent running
governed work — neither is possible on a shared demo key. That dependency
edge is now SATISFIED (WORK-061 remains blocked on WORK-057/058/059/060,
the WORK-053..056 foundation chain).

### Development governance and self-hosting

WORK-005 + WORK-015 + WORK-017 + WORK-018 + WORK-019 + WORK-044 → WORK-051
WORK-038 + WORK-039 + WORK-040 + WORK-041 + WORK-045 + WORK-051 → WORK-052

```text
WORK-051 Architecture Governance and Checkpoints
        ↓
WORK-052 Development Governance & Self-Hosting Control Plane
```

WORK-052 makes the repository the durable source of truth for the architecture program
(`spec/development-state/`): the governing architecture version, the Work Order
dependency DAG, parallelization eligibility, checkpoint contracts and assurance
profiles, durable decisions, and resumption state. The canonical machine-readable form
of THIS dependency graph — including statuses, merge evidence, and in-flight
coordination — is `spec/development-state/program-state.json`; this document remains
the human-readable design-time view.

WORK-051 and WORK-052 share surfaces with the in-flight WORK-046 (the static
architecture suite and composition root); migration numbering is reserved per work
order (0052–0056 WORK-051, 0057 WORK-046) so all merge orders stay clean. WORK-052
introduces no new migration.

### Continuous product validation sub-evolution (v1.1, ACR-002 — proposed)

The 2026-08-30 research-driven v1.1 evolution adds a continuous product
validation sub-evolution that closes the engineering control loop with an
explicit `VALIDATE` stage. Seven new Work Orders carry the sub-evolution;
they are SEPARATE from the WORK-053..061 track (which implements ACR-001)
and CONSUME (but do not duplicate) the ACR-001 capabilities when those
Work Orders land.

```text
WORK-063 (Identity & Access — COMPLETE: merged as 8dac9c4 via PR #81, spec-only, finalized §34.8/ADR-0007; spec/work-orders/WORK-063.md)
    │
    ↓
WORK-064 (Continuous Product Validation — COMPLETE: merged as c351451 via PR #86, finalized §34.8/ADR-0007; spec/work-orders/WORK-064.md)
    │
    ↓
WORK-065 (Synthetic Browser Validation Agent — the execution mechanism — COMPLETE: merged as 5de5e83 via PR #97, finalized §34.8/ADR-0007)
    │
    ↓
WORK-066 (Validation Scheduling & Change Triggers — PRE_MERGE/POST_RELEASE/CONTINUOUS — COMPLETE: merged as 0a506b1 via PR #102, finalized §34.8/ADR-0007)
    │                                  ← soft: WORK-058 (Adaptive Assurance Engine)
    ↓
WORK-067 (Engineering Signal & Regression Correlation — dedup, release-correlation, regression-likelihood)
    │                                  ← soft: WORK-056 (Engineering Signals Intake)
    ↓
WORK-068 (Feedback → Governed Work Items — through the EXISTING /work-items authority)
    │
    ├────────────→ WORK-069 (Progressive Release & Runtime Validation — canary, continue/halt/recover)
    │                                      ← soft: WORK-059 (Operational/Release Governance)
    │                      │
    └──────────────────────┴──→ WORK-070 (Continuous Architecture Fitness → ACR through /architecture)
                                      ← soft: WORK-055 (Quality Attributes) + WORK-060 (ACR Feedback Loop)
```

Exact edges:

- WORK-064 ← WORK-048 (complete), WORK-050 (complete), WORK-063 (complete — merged as 8dac9c4 via PR #81, spec-only, finalized §34.8/ADR-0007; the runtime identity layer remains future architect-gated work) → WORK-064 is COMPLETE (merged as c351451 via PR #86 on 2026-08-30 and finalized §34.8/ADR-0007; the domain/model authority is on main at backend/src/continuous-validation/)
- WORK-065 ← WORK-064 (complete — merged as c351451 via PR #86, finalized §34.8/ADR-0007) → WORK-065 is COMPLETE (merged as 5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916 via PR #97 on 2026-08-31 and finalized §34.8/ADR-0007 by the WORK-065 post-merge finalization; the execution mechanism is on main at backend/src/browser-validation/)
- WORK-066 ← WORK-064 (complete), WORK-065 (complete), (soft: WORK-058) → WORK-066 is COMPLETE (merged as 0a506b10e5526151929366bb11197230334b620c via PR #102 on 2026-08-31T16:37:09Z and finalized §34.8/ADR-0007 by the WORK-066 post-merge finalization; the scheduling/trigger decision layer is on main at backend/src/validation-scheduling/)
- WORK-067 ← WORK-064 (complete), WORK-015 (complete), WORK-040 (complete), WORK-041 (complete), (soft: WORK-056) → WORK-067 is COMPLETE (merged as bde33cc5e9a1b109951be9ec48aaef7e692c33c7 via PR #103 on 2026-08-31T18:30:23Z — the approved head 0fe9c48, tree identical — and finalized §34.8/ADR-0007 by the WORK-067 post-merge finalization; the ADVISORY correlation layer is on main at backend/src/engineering-signals/)
- WORK-068 ← WORK-067 (complete — merged as bde33cc via PR #103, finalized §34.8/ADR-0007) → WORK-068 is DEPENDENCY-ELIGIBLE and NOT activated
- WORK-069 ← WORK-064 (complete), WORK-066 (complete — merged as 0a506b1 via PR #102, finalized §34.8/ADR-0007), WORK-019 (complete), WORK-026 (complete), WORK-020 (complete), (soft: WORK-059) → WORK-069 is DEPENDENCY-ELIGIBLE and NOT activated
- WORK-070 ← WORK-067 (complete — merged as bde33cc via PR #103, finalized §34.8/ADR-0007), WORK-069, WORK-051 (complete), (soft: WORK-055, WORK-060)

The `VALIDATE` stage (between RELEASE and OBSERVE in the v1.1 control loop)
is the deliberate act of exercising meaningful user workflows against a real
deployment (preview or production, under a declared EffectPolicy) to confirm
the released system works for the customer. The frozen v1.0 control loop
(10 stages, no `VALIDATE`) remains governing until ACR-001 + ACR-002 are
approved; the v1.1 control loop (11 stages, with `VALIDATE`) is PROPOSED in
`spec/architecture/v1.1/control-system-evolution.md`.

The browser agent (WORK-065) is an EXECUTION MECHANISM, not an authority:
it cannot relax a FORBIDDEN EffectPolicy, cannot mutate code, cannot merge
PRs, cannot approve reviews, cannot transition workflow state. The
ValidationJourney/EffectPolicy domain model is owned by WORK-064 (the
authority); the browser agent executes underneath it.

Production synthetic validation must never perform uncontrolled destructive
side effects. Dangerous functionality requires a sandbox, a synthetic
identity, a test tenant, a test payment instrument, controlled external
integrations, or another explicitly approved safe mechanism.

No customer-product validation failure may be silently discarded, converted
into a false healthy state, or directly converted into an ungoverned code
change. The canonical flow: validation failure → evidence (provenance
preserved) → Engineering Signal (WORK-067) → governed assessment → Work
Item (WORK-068, through the EXISTING `/work-items` authority).

All seven Work Orders are PLANNED and NOT activated. Each carries
parallel-execution metadata (`parallelEligibility`, `parallelConflicts`,
`protectedSurfaces`) — see `spec/architecture/v1.1/parallel-execution-metadata.md`
and each Work Order's `Parallel-execution metadata` section. An Architect
LLM may mechanically determine READY/BLOCKED/PARALLEL-SAFE/CONFLICTING for
each.

The Fresh-Architect Bootstrap artifact
(`spec/architecture/v1.1/fresh-architect-bootstrap.md`) is the durable
record that the repository — not the previous conversation — is
authoritative. A new Architect LLM that reads the repository has the same
authority as the original architect.
