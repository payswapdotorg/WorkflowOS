# Persistent Architecture Governance

This directory defines repository-resident governance contracts for WorkflowOS. It is not a replacement authority for architecture, Work Items, workflow, verification, review, or GitHub.

## The retired upload wave (resolved 2026-08-29)

This directory previously carried the architect's direct-to-main upload wave of 2026-08-28T18:24–18:40Z — `ARCHITECTURE_LOCK.md` ("Version: 2.0, Status: FROZEN"), `ARCHITECT_ROLE.md`, `AGENT_PROTOCOL.md`, and `NEW_ARCHITECT_START.md` — which declared a parallel "2.0" roadmap under re-used WORK-053..059 identifiers. By the architect's 2026-08-29 PR #74 review verdict, the architect-issued issue track (ACR-001, WORK-053..061, v1.1) is the **one canonical track**; those documents are **retired to `spec/archive/upload-wave-2026-08-28/`** with correction banners (non-authoritative historical material). The JSON contracts below are PROPOSED v1.1 contracts; the frozen governing architecture remains v1.0 (`spec/architecture.md`, `spec/architecture-lock.md`, `spec/development-state/program-state.json`). See `spec/architecture/v1.1/reconciliation-record.md` §8.

## The v1.1 proposed contracts

- `architect.json` defines who/what may make architectural and merge decisions.
- `worker-protocol.json` defines the stateless implementation-agent handoff.
- `assurance-profiles.json` defines deterministic proof depth.
- `checkpoint-contract.json` defines required checkpoint classes.
- `future-roadmap.json` records the proposed v1.1 sequence and the retired upload-wave identities (`retiredUploadWave`).

Authoritative precedence is: frozen ArchitectureVersion/architecture lock → owning domain authority → Work Order → derived development state → evidence summaries. When artifacts conflict, fail closed and require architect reconciliation.
