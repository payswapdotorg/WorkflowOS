# WorkflowOS v1.1 Work Items

These are the planned v1.1 evolution Work Orders. They supplement the frozen v1.0 `spec/work-items.md` and do not retroactively alter completed v1.0 Work Items.

| Work Item | Purpose | Dependencies |
|---|---|---|
| WORK-053 | Architecture v1.1 foundation and control loop | WORK-046, WORK-051, WORK-052 |
| WORK-054 | Derived System Model and provenance graph | WORK-039, WORK-053 |
| WORK-055 | Quality Attributes and Architecture Fitness | WORK-053, WORK-054 |
| WORK-056 | Engineering Signals and Feedback Intake | WORK-039, WORK-041, WORK-054 |
| WORK-057 | Change Programs and Change Sets | WORK-053, WORK-054, WORK-046, WORK-047 |
| WORK-058 | Adaptive Assurance Engine | WORK-053, WORK-055, WORK-046, WORK-051, WORK-052 |
| WORK-059 | Operational and Release Governance | WORK-055, WORK-056, WORK-058, WORK-019 |
| WORK-060 | Continuous Architecture Evolution and ACR Feedback Loop | WORK-055, WORK-056, WORK-058, WORK-059, WORK-005 |
| WORK-061 | Self-Hosting Conformance and Continuous Governance | WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050 |

All items remain architect-governed and require a Work Order file, declared surfaces, deterministic assurance, checkpoint requirements, proof contract, and architect-controlled merge.

> **Reconciliation note (2026-08-29, updated by pass 2):** these WORK-053..061 identities follow the
> architect-issued GitHub issues #65..#73 (2026-08-28T17:34Z). The architect's direct-to-main
> upload wave one hour later re-used WORK-053..059 for different scopes under a "2.0" label;
> by the architect's 2026-08-29 PR #74 review verdict this issue-backed track is the ONE
> canonical track and the upload wave is retired under distinct UW-053..059 identities
> (`spec/archive/upload-wave-2026-08-28/`) — see [`reconciliation-record.md`](reconciliation-record.md) §8.
> No item here is activated.
