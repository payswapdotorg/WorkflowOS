/**
 * WORK-051 test helper — a permissive architecture checkpoint gate.
 *
 * Existing convergence/merge-gating/e2e suites assert PRE-WORK-051 lifecycle
 * behavior with an unconditional pass-through gate. The WORK-051 gate
 * semantics (blocking, impact policy, evidence) are covered by the dedicated
 * checkpoint suites:
 *   tests/integration/architecture-governance/*.integration.test.ts
 *   tests/integration/workflows/checkpoint-gates.integration.test.ts
 */

import type {
  ArchitectureCheckpointGate,
  ArchitectureCheckpointGateInput,
  ArchitectureCheckpointGateResult,
} from '@modules/workflows/index.js';

export class AllowAllCheckpointGate implements ArchitectureCheckpointGate {
  async evaluate(
    _input: ArchitectureCheckpointGateInput,
  ): Promise<ArchitectureCheckpointGateResult> {
    return {
      allowed: true,
      applicable: true,
      status: 'passed',
      checkpointId: null,
      reasons: [],
    };
  }
}
