/**
 * V2-011 — the deterministic optimization analysis.
 *
 * Pure function over one WorkflowIrDocument (validated first through the
 * MERGED V2-003 validator — fail-closed): same input → same analysisId,
 * same opportunities, same rejections. Zero clock, zero randomness.
 *
 * Detection rules (rules version `workflowos-optimization-rules-v1`):
 *
 *   - api_substitution: an `agentic_computer_use` node whose declared
 *     capabilityRequirements are EXACTLY ONE API-stable ordinary
 *     capability (the deterministic_api spec carries a single capability —
 *     a multi-requirement node is not substitutable without dropping part
 *     of its execution contract, so rules-v1 never proposes one). REJECTED
 *     when the requirement is in the merged V2-008 SENSITIVE set (the
 *     substitution would strip the computer-use runtime's grants and
 *     takeover boundaries).
 *   - workflow_reuse: duplicated non-subworkflow nodes (identical class,
 *     spec payload, capability requirements, ports/bindings, failure
 *     policy, placement, completion evidence — only the node id differs;
 *     differently-capable nodes are different logic and never group). REJECTED
 *     when the group is human (optimizations may never touch human decision
 *     points) or when the group's requirements are sensitive.
 *
 * Every rationale is a FIXED template interpolating ONLY declared facts
 * (the no-invention guarantee — the V2-006/V2-010 teaching discipline).
 */
import { createHash } from 'node:crypto';
import {
  validateWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
} from '../../workflow-ir/index.js';
import {
  allRequirementsApiStable,
  sensitiveRequirementsOf,
} from './capability-vocabulary.js';
import { deepFreeze } from './immutable.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../workflow-ir/index.js';
import type {
  OptimizationAnalysis,
  OptimizationOpportunity,
  RejectedOpportunity,
} from '../types.js';
import { OPTIMIZATION_RULES_VERSION, WorkflowOptimizationError } from '../types.js';

/** The structural signature two nodes must share to be duplicates. */
interface NodeSignature {
  readonly executionClass: WorkflowNode['executionClass'];
  readonly spec: unknown;
  /** the declared capability requirements — the nodes' execution CONTRACT. */
  readonly capabilityRequirements: readonly string[];
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly failurePolicy: unknown;
  readonly placement: WorkflowNode['placement'];
  readonly completionEvidence: unknown;
}

function signatureOf(node: WorkflowNode): NodeSignature {
  return {
    executionClass: node.executionClass,
    spec: node.spec,
    capabilityRequirements: [...node.capabilityRequirements],
    inputs: node.inputs,
    outputs: node.outputs,
    failurePolicy: node.failurePolicy,
    placement: node.placement,
    completionEvidence: node.completionEvidence ?? null,
  };
}

function sameSignature(a: NodeSignature, b: NodeSignature): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate the document through the MERGED V2-003 validator (fail-closed). */
export function assertDocumentValid(document: WorkflowIrDocument): void {
  const result = validateWorkflowIrDocument(document);
  if (!result.ok) {
    const summary = result.issues
      .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
      .join('; ');
    throw new WorkflowOptimizationError(
      'IR_DOCUMENT_INVALID',
      `invalid WorkflowIR document: ${summary}`,
      { issueCount: result.issues.length },
    );
  }
}

/** The deterministic analysis identity (sha-256 over rules + digest + derivation). */
function deriveAnalysisId(
  semanticDigest: string,
  opportunities: readonly OptimizationOpportunity[],
  rejected: readonly RejectedOpportunity[],
): string {
  const hash = createHash('sha-256');
  hash.update(OPTIMIZATION_RULES_VERSION, 'utf8');
  hash.update('\n');
  hash.update(semanticDigest, 'utf8');
  hash.update('\n');
  hash.update(JSON.stringify(opportunities), 'utf8');
  hash.update('\n');
  hash.update(JSON.stringify(rejected), 'utf8');
  return `opt_${hash.digest('hex')}`;
}

/**
 * Analyze one WorkflowIrDocument: deterministic opportunity detection with
 * typed unsafe rejections. The embedded document is deep-frozen (the
 * derivation input — provenance evidence).
 */
export function analyzeWorkflowDocument(document: WorkflowIrDocument): OptimizationAnalysis {
  assertDocumentValid(document);
  const semanticDigest = computeWorkflowVersionSemanticDigest(document).digest;

  const opportunities: OptimizationOpportunity[] = [];
  const rejected: RejectedOpportunity[] = [];

  // --- api_substitution (per agentic node, canonical document order) -----
  for (const node of document.ir.nodes) {
    if (node.executionClass !== 'agentic_computer_use') {
      continue;
    }
    const task = node.spec.class === 'agentic_computer_use' ? node.spec.task : '';
    if (!allRequirementsApiStable(node.capabilityRequirements)) {
      continue;
    }
    // EXACTLY ONE requirement: the deterministic_api spec carries a single
    // capability, and capabilityRequirements are deliberately OUTSIDE the
    // task-surface equivalence surface (the mechanism may change; the
    // contract may never shrink). Substituting a multi-requirement node
    // would silently drop its other requirements — rules-v1 restricts
    // substitution to the provably contract-preserving case. A future rules
    // version may compose genuine multi-capability candidates; it must then
    // also extend the derivation and the equivalence proof deliberately.
    if (node.capabilityRequirements.length !== 1) {
      continue;
    }
    const sensitive = sensitiveRequirementsOf(node.capabilityRequirements);
    if (sensitive.length > 0) {
      rejected.push({
        kind: 'api_substitution',
        nodeIds: [node.id],
        reason: 'SENSITIVE_CAPABILITY_SUBSTITUTION',
        rationale:
          `Node ${node.id} is structurally substitutable (agentic_computer_use task "${task}" with API-stable ` +
          `requirements [${node.capabilityRequirements.join(', ')}]) but declares the sensitive capability ` +
          `[${sensitive.join(', ')}]: substituting the computer-use path would remove the V2-008 runtime's ` +
          `per-capability grants and takeover boundaries — rejected as unsafe.`,
      });
      continue;
    }
    const apiCapability = node.capabilityRequirements[0]!;
    opportunities.push({
      kind: 'api_substitution',
      nodeId: node.id,
      declaredTask: task,
      declaredRequirements: [...node.capabilityRequirements],
      apiCapability,
      rationale:
        `Node ${node.id} is declared agentic_computer_use (task "${task}") but every declared capability ` +
        `requirement (${node.capabilityRequirements.join(', ')}) is served by the stable ${apiCapability} API: ` +
        `substituting the UI-automation loop with the deterministic API call is cheaper (fewer agent ` +
        `invocations), faster (no observe-decide-act loop) and more reliable (no UI brittleness), while the ` +
        `node's ports, edges and failure policy are preserved verbatim.`,
    });
  }

  // --- workflow_reuse (duplicate groups, canonical node-id order) --------
  const candidates = document.ir.nodes.filter(
    (node) => node.executionClass !== 'subworkflow',
  );
  const grouped: WorkflowNode[][] = [];
  for (const node of candidates) {
    const signature = signatureOf(node);
    const existing = grouped.find((group) => sameSignature(signatureOf(group[0]!), signature));
    if (existing) {
      existing.push(node);
    } else {
      grouped.push([node]);
    }
  }
  for (const group of grouped) {
    if (group.length < 2) {
      continue;
    }
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const nodeIds = group.map((node) => node.id);
    if (group[0]!.executionClass === 'human') {
      rejected.push({
        kind: 'workflow_reuse',
        nodeIds,
        reason: 'HUMAN_NODE_MODIFIED',
        rationale:
          `Nodes [${nodeIds.join(', ')}] declare identical human steps: optimizations may never remove or ` +
          `alter human decision points — the reuse substitution is rejected as unsafe.`,
      });
      continue;
    }
    const sensitive = sensitiveRequirementsOf(group[0]!.capabilityRequirements);
    if (sensitive.length > 0) {
      rejected.push({
        kind: 'workflow_reuse',
        nodeIds,
        reason: 'SENSITIVE_CAPABILITY_SUBSTITUTION',
        rationale:
          `Nodes [${nodeIds.join(', ')}] declare duplicated logic but their capability requirements include ` +
          `the sensitive capability [${sensitive.join(', ')}]: substituting the execution path would remove ` +
          `the V2-008 runtime's per-capability grants and takeover boundaries — rejected as unsafe.`,
      });
      continue;
    }
    opportunities.push({
      kind: 'workflow_reuse',
      nodeIds,
      substitutionSiteNodeIds: nodeIds.slice(1),
      rationale:
        `Nodes [${nodeIds.join(', ')}] declare identical logic (class ${group[0]!.executionClass}, identical ` +
        `ports and failure policy): duplicated logic is a maintenance burden — preserve the first site and ` +
        `reference one shared workflow version at the other sites instead of duplicating the implementation.`,
    });
  }

  return deepFreeze({
    analysisId: deriveAnalysisId(semanticDigest, opportunities, rejected),
    rulesVersion: OPTIMIZATION_RULES_VERSION,
    document: deepFreeze(structuredDocumentClone(document)),
    opportunities,
    rejected,
  });
}

/** A JSON-shaped clone that never aliases the caller's structures. */
function structuredDocumentClone(document: WorkflowIrDocument): WorkflowIrDocument {
  return JSON.parse(JSON.stringify(document)) as WorkflowIrDocument;
}
