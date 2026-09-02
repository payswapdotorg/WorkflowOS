/**
 * V2-011 — the unsafe-optimization guard (defense in depth).
 *
 * The analyzer rejects unsafe opportunities at detection time (typed
 * findings — see analysis.ts); this guard RE-VERIFIES everything before
 * any candidate is proposed or materialized, against the stored baseline
 * and candidate documents:
 *
 *   1. the derived candidate is a VALID WorkflowIR document (the merged
 *      V2-003 validator — fail-closed);
 *   2. the human decision points are IDENTICAL (optimizations may never
 *      remove or alter human steps);
 *   3. no substituted node declares a SENSITIVE capability (the merged
 *      V2-008 set — the computer-use runtime's grants and takeover
 *      boundaries must never be silently removed);
 *   4. the task surface is EQUIVALENT (the correctness proof);
 *   5. the merged V2-003 negotiation ACCEPTS the candidate's honest
 *      public-surface declaration.
 */
import type { WorkflowIrDocument } from '../../workflow-ir/index.js';
import type { VersionComparison } from '../types.js';
import { WorkflowOptimizationError } from '../types.js';
import { sensitiveRequirementsOf } from './capability-vocabulary.js';
import { assertDocumentValid } from './analysis.js';

function unsafe(
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): WorkflowOptimizationError {
  return new WorkflowOptimizationError('UNSAFE_OPTIMIZATION', message, { reason, ...details });
}

/** Re-verify every unsafe-optimization invariant for a derived candidate. */
export function assertCandidateSafe(input: {
  readonly baseline: WorkflowIrDocument;
  readonly candidate: WorkflowIrDocument;
  readonly comparison: VersionComparison;
  readonly affectedNodeIds: readonly string[];
}): void {
  const { baseline, candidate, comparison, affectedNodeIds } = input;

  // 1. the candidate must be a valid WorkflowIR document
  assertDocumentValid(candidate);

  // 2. the human decision points must be identical
  const humanNodesOf = (document: WorkflowIrDocument): Record<string, unknown> => {
    const humans: Record<string, unknown> = {};
    for (const node of document.ir.nodes) {
      if (node.executionClass === 'human') {
        humans[node.id] = node.spec;
      }
    }
    return humans;
  };
  if (JSON.stringify(humanNodesOf(baseline)) !== JSON.stringify(humanNodesOf(candidate))) {
    throw unsafe(
      'HUMAN_NODE_MODIFIED',
      'the candidate modifies human decision points (optimizations may never touch human steps)',
      { baselineHumanNodeIds: Object.keys(humanNodesOf(baseline)), candidateHumanNodeIds: Object.keys(humanNodesOf(candidate)) },
    );
  }

  // 3. the substituted baseline nodes must declare no sensitive capability
  const affected = new Set<string>(affectedNodeIds);
  const substituted = baseline.ir.nodes.filter((node) => affected.has(node.id));
  for (const node of substituted) {
    const sensitive = sensitiveRequirementsOf(node.capabilityRequirements);
    if (sensitive.length > 0) {
      throw unsafe(
        'SENSITIVE_CAPABILITY_SUBSTITUTION',
        `node ${node.id} declares the sensitive capability [${sensitive.join(', ')}]: substituting its execution path would remove the V2-008 runtime's grants and takeover boundaries`,
        { nodeIds: [node.id], sensitive },
      );
    }
  }

  // 4. the task surface must be equivalent
  if (!comparison.correctness.equivalent) {
    throw unsafe(
      'TASK_SURFACE_DIVERGED',
      `the candidate's task surface diverges from the baseline: ${comparison.correctness.firstDivergence}`,
      { firstDivergence: comparison.correctness.firstDivergence },
    );
  }

  // 5. the merged V2-003 negotiation must accept the candidate
  if (comparison.negotiation.decision === 'reject') {
    throw unsafe(
      'TASK_SURFACE_DIVERGED',
      `the merged V2-003 negotiation rejects the candidate's public-surface declaration: ${comparison.negotiation.reason}`,
      { negotiation: comparison.negotiation },
    );
  }
}
