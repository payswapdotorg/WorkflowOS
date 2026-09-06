# REALITY-REPAIR-006 — Installed Workflow Naming

**Status:** AUTHORIZED — after REALITY-REPAIR-003
**Program:** V2 reality repair
**Parallelism:** PARALLEL_AFTER_003
**Dependencies:** REALITY-REPAIR-003
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-007 ACCEPT

Resolve installed-card names using the existing public workflow read when the org-scoped listing lacks the workflow name. No new route or aggregate authority.

Required regression: installed marketplace workflow displays its real name and still opens against caller-org detail reads.

## Completion
Architect merge after exact-head verification. Required before R6.
