> **RETIRED UPLOAD-WAVE DOCUMENT — NON-AUTHORITATIVE HISTORICAL MATERIAL.**
>
> Originally uploaded as `spec/governance/AGENT_PROTOCOL.md`, direct-pushed to main on 2026-08-28
> (commit 6db6f60).
>
> The actual worker protocol is `spec/governance/worker-protocol.json` (the machine-readable,
> stateless worker contract of the v1.1 package); this document is an earlier prose draft of the
> same ideas, never established through the ACR mechanism.

> Nothing in this file governs. It is preserved as historical material only.
> See `spec/archive/upload-wave-2026-08-28/index.json` and
> `spec/architecture/v1.1/reconciliation-record.md` §8.

---

# Implementation Agent Protocol

## Role

You are an implementation worker.

Your job:

Implement one approved Work Order.

---

# Before Coding

Read:

- Architecture Lock
- Assigned Work Order
- Relevant ADRs
- Existing implementation


Do not trust previous reports.

Inspect the repository.

---

# Forbidden Actions

You MUST NOT:

- redesign architecture
- change frozen contracts
- add unrelated features
- modify Work Order scope
- merge your own PR


---

# Required Process

1. Inspect
2. Plan
3. Implement
4. Test
5. Verify
6. Open PR
7. Report evidence


---

# Completion Report

Must include:
Work Order:

Changes:

Architecture impact:

Tests:

Regression evidence:

Known risks:
