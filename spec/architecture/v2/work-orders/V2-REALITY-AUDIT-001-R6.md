# V2-REALITY-AUDIT-001-R6 — Full Reality Re-Audit

**Status:** PLANNED — gate after all accepted corrective Work Orders merge
**Program:** V2 product reality gate
**Parallelism:** FINAL-GATE
**Dependencies:** REALITY-REPAIR-001, REALITY-REPAIR-002, REALITY-REPAIR-003, REALITY-REPAIR-004, REALITY-REPAIR-005, REALITY-REPAIR-006, REALITY-REPAIR-007, REALITY-REPAIR-008, REALITY-REPAIR-009

## Objective
Repeat the real-browser reality audit against the merged product and real deployment composition to determine whether the accepted findings are actually resolved and whether any critical UX-to-operational architecture mismatch remains.

## Scope
Re-run the governed V2 journey matrix across the real deployment topology, including fresh-user onboarding, deployment-served product routes, marketplace installation/detail, run lifecycle and approval controls, creation boundary/expert authoring, Home attention surfaces, teaching, version/update, activity/trust, responsive behavior, offline/error handling, and the previously failing journeys.

## Non-goals
No implementation, ad-hoc fixes, architecture changes, deployment provisioning, or roadmap reinterpretation during the audit. Any newly discovered defect becomes a separate Architect-authorized corrective Work Order.

## Required evidence
Fresh exact main head; real deployment topology; real browser transcript; journey matrix with pass/fail/blocked/unavailable status; evidence hashes; exact comparison against R0-R4 findings; explicit confirmation that no critical mismatch remains or a durable new finding set if one does.

## Exit
- PASS when the audited journey set has no unresolved critical UX-to-operational architecture mismatch and all accepted repair claims are evidenced.
- FAIL when a critical mismatch remains; keep deployment locked and create the smallest governed corrective packet(s).

R6 does not itself unlock deployment. R7 must record the Architect release-readiness decision.
