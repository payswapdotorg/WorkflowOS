# REALITY-REPAIR-003 — Resolve Workflow Detail Facts Against Caller Organization

**Status:** AUTHORIZED — sequential after REALITY-REPAIR-002
**Parent gate:** V2-REALITY-AUDIT-001
**Architect disposition:** F-003 ACCEPT

## Objective
Fix the workflow detail page so org-scoped runs, installations, deployments, and related facts are read from the caller's organization rather than the publisher/owner organization.

## Scope
Reuse the existing `organizations.listForUser` selection/organization context already consumed by the product shell. Keep public workflow/version reads unchanged. Replace owner-org scoping only where customer-local facts are required.

## Non-goals
No new workflow-scoped aggregate route, no membership-rule changes, no marketplace/entitlement changes, no new authority.

## Required evidence
- Fresh branch from the merged REALITY-REPAIR-002 head.
- Browser: customer purchases and installs a public marketplace workflow, then opens it from Installed/My Workflows.
- Detail loads without publisher-org 403s.
- Customer-local installation/run/deployment facts remain isolated to the caller's org.
- Regression for own-org workflow detail remains green.
- Deterministic tests plus real browser proof.

## Completion
Architect merge only after exact-head verification. Do not start before REALITY-REPAIR-002 is merged.
