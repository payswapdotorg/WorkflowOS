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
