# REALITY-REPAIR-005 — Home Approval and Update Attention Composition

**Status:** AUTHORIZED — after REALITY-REPAIR-003
**Program:** V2 reality repair
**Parallelism:** PARALLEL_AFTER_003
**Dependencies:** REALITY-REPAIR-003
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-005 ACCEPT

Compose Home's Pending approvals and Updates surfaces from existing V2-005/V2-002 reads and derivations already used by Workflow Detail and RunExperience.

Do not create an aggregate authority or duplicate attention state. Preserve honest unavailable behavior for device issues.

Required browser proof: an approval-waiting run appears on Home and opens to the run; an installed workflow behind head version appears in Updates; no false “not part of the product” claims remain.

## Completion
Architect merge after exact-head verification. Required before R6.
