# WorkflowOS v1.1 Dependency Graph

The v1.1 graph supplements the frozen v1.0 dependency graph. Dependencies are authoritative only when represented in the owning Work Order/program state; this document is the design-time graph.

```text
WORK-046 + WORK-051 + WORK-052
            ↓
         WORK-053
            ↓
         WORK-054
         /     \
        ↓       ↓
    WORK-055  WORK-056
        | \     /
        |  \   /
        ↓   \ /
    WORK-058 WORK-057
        |      |
        └──┬───┘
           ↓
       WORK-059
           ↓
       WORK-060
           ↓
       WORK-062  ←── WORK-046 (complete — the delegation authority)
           ↓
       WORK-061
```

Exact edges:

- WORK-053 ← WORK-046, WORK-051, WORK-052
- WORK-054 ← WORK-039, WORK-053
- WORK-055 ← WORK-053, WORK-054
- WORK-056 ← WORK-039, WORK-041, WORK-054
- WORK-057 ← WORK-053, WORK-054, WORK-046, WORK-047
- WORK-058 ← WORK-053, WORK-055, WORK-046, WORK-051, WORK-052
- WORK-059 ← WORK-055, WORK-056, WORK-058, WORK-019
- WORK-060 ← WORK-055, WORK-056, WORK-058, WORK-059, WORK-005
- WORK-062 ← WORK-046
- WORK-061 ← WORK-057, WORK-058, WORK-059, WORK-060, WORK-047, WORK-050, WORK-062

WORK-062 (Durable Multi-Agent Orchestration Substrate) was added by the
2026-08-30 governance correction — the execution-substrate architecture
decision. It is the durable orchestration substrate underneath WORK-046
delegation: the runtime authority chain is WORK-047 (recommendation) →
WORK-046 (governed delegation) → WORK-062 (durable orchestration) → the
existing execution authority → verification → review, while the dependency
edge is WORK-062 ← WORK-046 and WORK-047's recorded dependency on WORK-046 is
unchanged. WORK-061 now depends on WORK-062 because self-hosting cannot
honestly be considered complete without durable multi-agent execution and
recovery. WORK-062 is planned and NOT activated (see
`spec/work-orders/WORK-062.md`).

Parallelization is permitted only where dependencies are complete and protected-surface coordination permits it. The graph is not itself an authorization token; derived frontier state must reconcile it with live program state and GitHub merge evidence.

> **Reconciliation note (2026-08-29, updated by pass 2):** the architect's direct-to-main upload wave
> (2026-08-28T18:24–18:40Z) re-used the WORK-053..059 identifiers for a different
> dependency set (053←[052], 054←[053], 055←[052], 056←[053,055], 057←[053,055],
> 058←[056,057], 059←[058]) under a "2.0" label. By the architect's 2026-08-29 PR #74
> review verdict, this design-time graph (the architect-issued issues #65..#73) is the
> one canonical track; the upload wave is retired under distinct UW-053..059 identities
> (`spec/archive/upload-wave-2026-08-28/`), and `spec/development-state/dependency-state.json`
> `futureGeneration` is the one canonical dependency mapping — see
> [`reconciliation-record.md`](reconciliation-record.md) §8.
