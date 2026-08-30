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
WORK-062 Durable Multi-Agent Orchestration Substrate  (planned)
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
ACTIVATED 2026-08-30 — in flight). WORK-061 depends on WORK-062: self-hosting cannot
honestly be considered complete without durable multi-agent execution and
recovery.

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
