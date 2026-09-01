import type {
  ControlEdge,
  PresentationMetadata,
  PortBinding,
  PortDeclaration,
  StepFailurePolicy,
  WorkflowIrDocument,
  WorkflowNode,
  WorkflowOutputBinding,
} from '../../../src/workflow-ir/index.js';
import { buildTriageDocument, buildTriageDocumentAltOrder, clone } from '../../unit/workflow-ir/helpers.js';

/**
 * V2-007 — shared deterministic test fixtures for the Workflow Compiler
 * battery.
 *
 * All fixtures are pure data built through the MERGED V2-003 workflow-ir
 * surface (the authorized implementation dependency). No clock, no
 * randomness, no network: the same fixture always compiles to the same
 * compiled-workflow artifact bytes and the same artifact digest.
 *
 * The primary real workflow is the merged "triage an inbound GitHub issue"
 * fixture (the same real task exercised by the V2-003 dogfooding), re-exported
 * for compiler-side continuity.
 */

/** Secret material that must NEVER appear in a compiled artifact. */
export const SECRET_MATERIAL_CANARY = 'ghp_live_DEADBEEF_never_serialize_me';

/** The real triage workflow (re-export from the merged V2-003 battery). */
export { buildTriageDocument, buildTriageDocumentAltOrder, clone };

/** The opaque secret reference the triage workflow declares (reference only). */
export const TRIAGE_SECRET_REF = 'team-notifications@secrets';

// ----------------------------------------------------------------------------
// structural patch helpers (pure reconstruction, V2-003 helpers style)
// ----------------------------------------------------------------------------

/** Replace a node in a cloned document by id (pure reconstruction). */
export function withNode(
  document: WorkflowIrDocument,
  nodeId: string,
  patch: Partial<WorkflowNode>,
): WorkflowIrDocument {
  let found = false;
  const nodes = document.ir.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    found = true;
    return { ...node, ...patch } as WorkflowNode;
  });
  if (!found) throw new Error(`fixture node not found: ${nodeId}`);
  return { ...document, ir: { ...document.ir, nodes } };
}

/** Patch the workflow IR in a cloned document (pure reconstruction). */
export function withIr(
  document: WorkflowIrDocument,
  irPatch: Partial<WorkflowIrDocument['ir']>,
): WorkflowIrDocument {
  return { ...document, ir: { ...document.ir, ...irPatch } };
}

/** Patch the presentation block in a cloned document (pure reconstruction). */
export function withPresentation(
  document: WorkflowIrDocument,
  presentation: PresentationMetadata | undefined,
): WorkflowIrDocument {
  return { ...document, presentation };
}

/** Append a control edge in a cloned document (pure reconstruction). */
export function withEdge(document: WorkflowIrDocument, edge: ControlEdge): WorkflowIrDocument {
  return { ...document, ir: { ...document.ir, edges: [...document.ir.edges, edge] } };
}

/** Replace the workflow default placement in a cloned document. */
export function withDefaultPlacement(
  document: WorkflowIrDocument,
  defaultPlacement: WorkflowIrDocument['ir']['defaultPlacement'],
): WorkflowIrDocument {
  return withIr(document, { defaultPlacement });
}

/** Replace a node's failure policy in a cloned document. */
export function withNodeFailurePolicy(
  document: WorkflowIrDocument,
  nodeId: string,
  failurePolicy: StepFailurePolicy,
): WorkflowIrDocument {
  return withNode(document, nodeId, { failurePolicy });
}

/** Replace a node's capability requirements in a cloned document. */
export function withNodeCapabilityRequirements(
  document: WorkflowIrDocument,
  nodeId: string,
  capabilityRequirements: string[],
): WorkflowIrDocument {
  return withNode(document, nodeId, { capabilityRequirements });
}

/** Replace a node's placement in a cloned document. */
export function withNodePlacement(
  document: WorkflowIrDocument,
  nodeId: string,
  placement: WorkflowNode['placement'],
): WorkflowIrDocument {
  return withNode(document, nodeId, { placement });
}

/** Replace a node's input bindings in a cloned document. */
export function withNodeInputs(
  document: WorkflowIrDocument,
  nodeId: string,
  inputs: PortBinding[],
): WorkflowIrDocument {
  return withNode(document, nodeId, { inputs });
}

/** Replace the workflow provenance in a cloned document. */
export function withProvenance(
  document: WorkflowIrDocument,
  provenance: WorkflowIrDocument['ir']['provenance'],
): WorkflowIrDocument {
  return withIr(document, { provenance });
}

/** Replace the workflow output bindings in a cloned document. */
export function withWorkflowOutputs(
  document: WorkflowIrDocument,
  outputs: WorkflowOutputBinding[],
): WorkflowIrDocument {
  return withIr(document, { outputs });
}

/** Replace the workflow inputs in a cloned document. */
export function withWorkflowInputs(
  document: WorkflowIrDocument,
  inputs: PortDeclaration[],
): WorkflowIrDocument {
  return withIr(document, { inputs });
}

// ----------------------------------------------------------------------------
// deliberate compiler-rejection fixtures
// ----------------------------------------------------------------------------

/**
 * IR-VALID but placement-contradictory: the workflow default placement
 * demands cloud-only execution while the human review gate demands the local
 * device — no location class can satisfy both requirements (compile-time
 * placement conflict; V2-003 validation does not cross-check these fields).
 */
export function buildPlacementConflictDocument(): WorkflowIrDocument {
  return withDefaultPlacement(buildTriageDocument(), 'cloud_required');
}

/** IR-VALID but policy-unhonorable: a human pause point with a retry budget. */
export function buildHumanRetryPolicyDocument(): WorkflowIrDocument {
  return withNodeFailurePolicy(
    buildTriageDocument(),
    'review_gate',
    { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
  );
}

/** IR-VALID but policy-unhonorable: a human pause point with ignore+continue. */
export function buildHumanIgnorePolicyDocument(): WorkflowIrDocument {
  return withNodeFailurePolicy(buildTriageDocument(), 'review_gate', { strategy: 'ignore_and_continue' });
}

/** IR-VALID but ambiguous: a node declares the same capability requirement twice. */
export function buildDuplicateCapabilityRequirementDocument(): WorkflowIrDocument {
  return withNodeCapabilityRequirements(buildTriageDocument(), 'fetch_issue', [
    'github.repository.read',
    'github.repository.read',
  ]);
}

/** IR-INVALID: a non-canonical capability alias in the requirements. */
export function buildAliasCapabilityDocument(): WorkflowIrDocument {
  return withNodeCapabilityRequirements(buildTriageDocument(), 'fetch_issue', ['github.read_repo']);
}

/** IR-INVALID: an unknown capability name in the requirements. */
export function buildUnknownCapabilityDocument(): WorkflowIrDocument {
  return withNodeCapabilityRequirements(buildTriageDocument(), 'fetch_issue', ['nosuch.op']);
}

/** IR-INVALID: a non-canonical alias as the invoked capability of a step. */
export function buildAliasInvokedCapabilityDocument(): WorkflowIrDocument {
  return withNode(buildTriageDocument(), 'fetch_issue', {
    spec: { class: 'deterministic_api', capability: 'github.read_repo' },
  } as Partial<WorkflowNode>);
}

/** IR-INVALID: an edge references an unknown node (dangling edge). */
export function buildDanglingEdgeDocument(): WorkflowIrDocument {
  return withEdge(buildTriageDocument(), { from: 'fetch_issue', to: 'ghost_node', on: 'success' });
}

/** IR-INVALID: a binding references an unknown source node. */
export function buildDanglingBindingDocument(): WorkflowIrDocument {
  return withNodeInputs(buildTriageDocument(), 'draft_summary', [
    {
      name: 'issue',
      type: {
        kind: 'object',
        fields: [
          { name: 'title', type: { kind: 'string' } },
          { name: 'body', type: { kind: 'string' } },
        ],
      },
      binding: { kind: 'node_output', node: 'ghost_node', output: 'issue' },
    },
  ]);
}

/** IR-INVALID: an unreachable node (not reachable from start). */
export function buildUnreachableNodeDocument(): WorkflowIrDocument {
  const document = clone(buildTriageDocument());
  const isolated: WorkflowNode = {
    id: 'isolated_step',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.read' },
    capabilityRequirements: ['filesystem.read'],
    placement: 'device_local',
    inputs: [],
    outputs: [],
    failurePolicy: { strategy: 'fail_workflow' },
  };
  document.ir.nodes.push(isolated);
  return document;
}

/** IR-INVALID: unsupported IR schema version (this build supports {1}). */
export function buildUnsupportedSchemaVersionDocument(): WorkflowIrDocument {
  const document = clone(buildTriageDocument());
  document.irSchemaVersion = 2;
  return document;
}

/** IR-INVALID: wrong object type. */
export function buildWrongObjectTypeDocument(): WorkflowIrDocument {
  const document = clone(buildTriageDocument());
  (document as { objectType: string }).objectType = 'workflowos/not-the-ir/v1';
  return document;
}

/**
 * A model-generated source: IR provenance origin `compiled` with a reference
 * to the generating session. Generated intent is intent-only — the compiled
 * artifact must never grow execution/proof claims from it.
 */
export function buildGeneratedSourceDocument(): WorkflowIrDocument {
  return withProvenance(buildTriageDocument(), {
    origin: 'compiled',
    sourceRefs: ['model-session:v0-neutral-planner:run-42'],
  });
}
