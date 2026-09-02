/**
 * V2-011 — the deterministic comparison criteria (the Work Order's
 * must-deliver: correctness, latency, cost, reliability, maintenance).
 *
 * CORRECTNESS FIRST: the task-surface equivalence proof. The task
 * surface is WHAT the workflow does for its consumers — the workflow
 * interface (inputs/outputs), the control structure (nodes, edges, human
 * decision points) and every node's data contracts (port
 * bindings/declarations, failure policies, placements, completion
 * evidence). The execution MECHANISM (spec class, capability payload,
 * subworkflow reference) is deliberately OUT of the surface: changing it
 * is the optimization; the candidate must prove everything else is
 * byte-identical. The merged V2-003 negotiation cross-checks the
 * candidate's public-surface declaration (never re-derived here).
 *
 * Then the frozen modeled rubric (documented weights over declared
 * facts — honest MODELS, never measurements; the empirical layer below
 * grounds them with real V2-005 run records, consumed read-only).
 */
import { negotiateWorkflowVersionUpdate } from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../workflow-ir/index.js';
import type { WorkflowRunHistory } from '../../workflow-runs/index.js';
import type {
  CriterionDelta,
  MaintenanceBreakdown,
  RunComparison,
  TaskSurfaceEquivalence,
  VersionComparison,
} from '../types.js';
import { OPTIMIZATION_RUBRIC, OPTIMIZATION_RULES_VERSION } from '../types.js';

// ============================================================================
// §1  The task surface (WHAT the workflow does — the equivalence proof)
// ============================================================================

/** The task surface of one document (the correctness comparison key). */
function taskSurfaceOf(document: WorkflowIrDocument): {
  readonly start: string;
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly nodeIds: readonly string[];
  readonly perNode: Readonly<Record<string, unknown>>;
  readonly edges: readonly string[];
  readonly humanNodes: Readonly<Record<string, unknown>>;
} {
  const perNode: Record<string, unknown> = {};
  const humanNodes: Record<string, unknown> = {};
  const nodeIds: string[] = [];
  for (const node of document.ir.nodes) {
    nodeIds.push(node.id);
    perNode[node.id] = {
      inputs: node.inputs,
      outputs: node.outputs,
      failurePolicy: node.failurePolicy,
      placement: node.placement,
      completionEvidence: node.completionEvidence ?? null,
    };
    if (node.executionClass === 'human') {
      humanNodes[node.id] = node.spec;
    }
  }
  nodeIds.sort();
  const edges = [...document.ir.edges]
    .map((edge) => `${edge.from}->${edge.to} on ${JSON.stringify(edge.on)}`)
    .sort();
  return {
    start: document.ir.start,
    inputs: document.ir.inputs,
    outputs: document.ir.outputs,
    nodeIds,
    perNode,
    edges,
    humanNodes,
  };
}

/** Compare two values structurally (JSON order-stable for our plain data). */
function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

/** The first divergence between two task surfaces (null when equivalent). */
function firstTaskSurfaceDivergence(
  baseline: ReturnType<typeof taskSurfaceOf>,
  candidate: ReturnType<typeof taskSurfaceOf>,
): string | null {
  if (baseline.start !== candidate.start) {
    return `start: ${baseline.start} != ${candidate.start}`;
  }
  if (jsonOf(baseline.inputs) !== jsonOf(candidate.inputs)) {
    return `workflow inputs: ${jsonOf(baseline.inputs)} != ${jsonOf(candidate.inputs)}`;
  }
  if (jsonOf(baseline.outputs) !== jsonOf(candidate.outputs)) {
    return `workflow outputs: ${jsonOf(baseline.outputs)} != ${jsonOf(candidate.outputs)}`;
  }
  if (jsonOf(baseline.nodeIds) !== jsonOf(candidate.nodeIds)) {
    return `node ids: ${jsonOf(baseline.nodeIds)} != ${jsonOf(candidate.nodeIds)}`;
  }
  for (const nodeId of baseline.nodeIds) {
    const a = (baseline.perNode as Record<string, unknown>)[nodeId]!;
    const b = (candidate.perNode as Record<string, unknown>)[nodeId] ?? null;
    if (jsonOf(a) !== jsonOf(b)) {
      const aRecord = a as Record<string, unknown>;
      const bRecord = (b ?? {}) as Record<string, unknown>;
      for (const field of ['inputs', 'outputs', 'failurePolicy', 'placement', 'completionEvidence']) {
        if (jsonOf(aRecord[field]) !== jsonOf(bRecord[field])) {
          return `node ${nodeId} ${field}: ${jsonOf(aRecord[field])} != ${jsonOf(bRecord[field])}`;
        }
      }
      return `node ${nodeId}: ${jsonOf(a)} != ${jsonOf(b)}`;
    }
  }
  if (jsonOf(baseline.edges) !== jsonOf(candidate.edges)) {
    return `edges: ${jsonOf(baseline.edges)} != ${jsonOf(candidate.edges)}`;
  }
  if (jsonOf(baseline.humanNodes) !== jsonOf(candidate.humanNodes)) {
    for (const nodeId of Object.keys(baseline.humanNodes)) {
      const a = (baseline.humanNodes as Record<string, unknown>)[nodeId] ?? null;
      const b = (candidate.humanNodes as Record<string, unknown>)[nodeId] ?? null;
      if (jsonOf(a) !== jsonOf(b)) {
        return `human node ${nodeId} spec: ${jsonOf(a)} != ${jsonOf(b)}`;
      }
    }
    return `human nodes: ${jsonOf(baseline.humanNodes)} != ${jsonOf(candidate.humanNodes)}`;
  }
  return null;
}

// ============================================================================
// §2  The modeled rubric scores (deterministic, declared facts only)
// ============================================================================

function perExecutionClassScore(
  document: WorkflowIrDocument,
  weight: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const node of document.ir.nodes) {
    total += weight[node.executionClass] ?? 0;
  }
  return total;
}

function maintenanceBreakdownOf(document: WorkflowIrDocument): MaintenanceBreakdown {
  const nodeCount = document.ir.nodes.length;
  let agenticNodeCount = 0;
  for (const node of document.ir.nodes) {
    if (node.executionClass === 'agentic_computer_use') {
      agenticNodeCount += 1;
    }
  }
  const duplicateNodeCount = countDuplicateNodes(document);
  const score =
    nodeCount * OPTIMIZATION_RUBRIC.maintenanceWeights.perNode +
    duplicateNodeCount * OPTIMIZATION_RUBRIC.maintenanceWeights.perDuplicateNode +
    agenticNodeCount * OPTIMIZATION_RUBRIC.maintenanceWeights.perAgenticNode;
  return { nodeCount, duplicateNodeCount, agenticNodeCount, score };
}

/**
 * The structural signature used for duplicate detection (mirrors analysis.ts
 * — INCLUDING capabilityRequirements: the declared requirements are part of
 * the duplicated logic's identity, so differently-capable nodes are different
 * logic and never count as duplicates).
 */
function duplicateSignatureOf(node: WorkflowNode): string {
  return JSON.stringify({
    executionClass: node.executionClass,
    spec: node.spec,
    capabilityRequirements: [...node.capabilityRequirements],
    inputs: node.inputs,
    outputs: node.outputs,
    failurePolicy: node.failurePolicy,
    placement: node.placement,
    completionEvidence: node.completionEvidence ?? null,
  });
}

/** The number of redundant copies (nodes beyond the first per duplicate group). */
export function countDuplicateNodes(document: WorkflowIrDocument): number {
  const seen = new Map<string, number>();
  for (const node of document.ir.nodes) {
    if (node.executionClass === 'subworkflow') {
      continue;
    }
    const signature = duplicateSignatureOf(node);
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of seen.values()) {
    if (count > 1) {
      duplicates += count - 1;
    }
  }
  return duplicates;
}

function deltaOf(baseline: number, candidate: number): CriterionDelta {
  const roundedBaseline = Math.round(baseline * 1e10) / 1e10;
  const roundedCandidate = Math.round(candidate * 1e10) / 1e10;
  return {
    baseline: roundedBaseline,
    candidate: roundedCandidate,
    delta: Math.round((roundedCandidate - roundedBaseline) * 1e10) / 1e10,
  };
}

// ============================================================================
// §3  The deterministic document comparison (correctness FIRST)
// ============================================================================

export function compareWorkflowVersions(
  baseline: WorkflowIrDocument,
  candidate: WorkflowIrDocument,
): VersionComparison {
  const baselineSurface = taskSurfaceOf(baseline);
  const candidateSurface = taskSurfaceOf(candidate);
  const divergence = firstTaskSurfaceDivergence(baselineSurface, candidateSurface);
  const correctness: TaskSurfaceEquivalence = {
    equivalent: divergence === null,
    firstDivergence: divergence,
  };

  // the merged V2-003 negotiation cross-check (the candidate's honest
  // public-surface declaration — consumed, never re-derived)
  const negotiation = negotiateWorkflowVersionUpdate({
    installed: {
      inputs: baseline.ir.inputs,
      outputs: baseline.ir.outputs,
      compatibility: baseline.compatibility,
    },
    candidate: {
      inputs: candidate.ir.inputs,
      outputs: candidate.ir.outputs,
      compatibility: candidate.compatibility,
    },
  });

  return {
    rulesVersion: OPTIMIZATION_RULES_VERSION,
    correctness,
    negotiation,
    latency: deltaOf(
      perExecutionClassScore(baseline, OPTIMIZATION_RUBRIC.latencyUnitsPerExecutionClass),
      perExecutionClassScore(candidate, OPTIMIZATION_RUBRIC.latencyUnitsPerExecutionClass),
    ),
    cost: deltaOf(
      perExecutionClassScore(baseline, OPTIMIZATION_RUBRIC.costUnitsPerExecutionClass),
      perExecutionClassScore(candidate, OPTIMIZATION_RUBRIC.costUnitsPerExecutionClass),
    ),
    reliability: deltaOf(
      perExecutionClassScore(baseline, OPTIMIZATION_RUBRIC.failureWeightPerExecutionClass),
      perExecutionClassScore(candidate, OPTIMIZATION_RUBRIC.failureWeightPerExecutionClass),
    ),
    maintenance: deltaOf(
      maintenanceBreakdownOf(baseline).score,
      maintenanceBreakdownOf(candidate).score,
    ),
    maintenanceBreakdown: {
      baseline: maintenanceBreakdownOf(baseline),
      candidate: maintenanceBreakdownOf(candidate),
    },
  };
}

// ============================================================================
// §4  The empirical run comparison (REAL V2-005 records, read-only)
// ============================================================================

export function compareRunHistories(
  baseline: WorkflowRunHistory,
  optimized: WorkflowRunHistory,
): RunComparison {
  // CORRECTNESS FIRST: terminal states, step sets, step statuses
  const baselineCompleted = baseline.run.state === 'completed';
  const optimizedCompleted = optimized.run.state === 'completed';
  const baselineSteps = [...baseline.steps].sort((a, b) => (a.stepId < b.stepId ? -1 : 1));
  const optimizedSteps = [...optimized.steps].sort((a, b) => (a.stepId < b.stepId ? -1 : 1));
  const sameStepSet =
    jsonOf(baselineSteps.map((step) => step.stepId)) ===
    jsonOf(optimizedSteps.map((step) => step.stepId));
  let sameStepStatuses = sameStepSet;
  if (sameStepSet) {
    for (let index = 0; index < baselineSteps.length; index += 1) {
      if (baselineSteps[index]!.status !== optimizedSteps[index]!.status) {
        sameStepStatuses = false;
        break;
      }
    }
  }
  const equivalent =
    baselineCompleted && optimizedCompleted && sameStepSet && sameStepStatuses;

  // resource cost signals: invocation counts (the agentic loop costs more)
  const baselineInvocationCount = baseline.invocations.length;
  const optimizedInvocationCount = optimized.invocations.length;

  // maintainability signals: distinct capabilities + step counts
  const distinctCapabilities = (history: WorkflowRunHistory): readonly string[] => {
    const names = new Set<string>();
    for (const invocation of history.invocations) {
      names.add(invocation.capability);
    }
    return [...names].sort();
  };

  return {
    correctness: {
      baselineCompleted,
      optimizedCompleted,
      sameStepSet,
      sameStepStatuses,
      equivalent,
    },
    resourceCost: {
      baselineInvocationCount,
      optimizedInvocationCount,
      invocationDelta: optimizedInvocationCount - baselineInvocationCount,
    },
    maintainabilitySignals: {
      baselineDistinctCapabilities: distinctCapabilities(baseline),
      optimizedDistinctCapabilities: distinctCapabilities(optimized),
      baselineStepCount: baseline.steps.length,
      optimizedStepCount: optimized.steps.length,
    },
  };
}
