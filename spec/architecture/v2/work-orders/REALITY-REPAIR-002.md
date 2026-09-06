# REALITY-REPAIR-002 — First-Run Organization Onboarding

**Status:** AUTHORIZED — sequential after REALITY-REPAIR-001
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-002 ACCEPT

## Objective
Give a newly registered user an explicit first-run organization target so existing org-scoped V2 product capabilities can be reached without out-of-band fixture creation.

## Scope
Add a minimal authenticated onboarding step consuming the existing `POST /organizations` contract. The flow must establish the caller's organization selection for the existing product shell. Org-scoped actions must not silently no-op when no organization exists; they must provide actionable onboarding/error state.

Prefer explicit user-facing creation over server-side auto-provisioning because it introduces no new ownership/naming semantics into the backend.

## Non-goals
No changes to organization authority semantics, membership authorization, workflow authority, marketplace economics, or V2 product route contracts.

## Required evidence
- Fresh branch from the merged REALITY-REPAIR-001 head.
- Fresh signup with zero pre-seeded organizations.
- Organization creation through the real browser UI only.
- Post-onboarding `GET /organizations` resolves the created organization and product selection uses it.
- Marketplace access/purchase path no longer silently no-ops.
- Existing authenticated journeys remain green.
- Deterministic tests plus real browser proof.

## Completion
Architect merge only after exact-head verification. Do not start before REALITY-REPAIR-001 is merged.
