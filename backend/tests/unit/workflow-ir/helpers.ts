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

/**
 * V2-003 — shared deterministic test fixtures for the WorkflowIR battery.
 *
 * All fixtures are pure data. No clock, no randomness, no network: the same
 * fixture always produces the same canonical serialization and the same
 * WorkflowVersion semantic digest.
 */

/** Secret material that must NEVER be able to appear in serialized IR. */
export const SECRET_MATERIAL_CANARY = 'ghp_live_DEADBEEF_never_serialize_me';

/**
 * Recursively strips `readonly` so fixtures can be structurally mutated to
 * build deliberately-invalid documents (the battery's negative cases).
 */
type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[] : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

/** Structural deep clone (fixtures are JSON data), returned fully mutable. */
export function clone<T>(value: T): DeepMutable<T> {
  return JSON.parse(JSON.stringify(value)) as DeepMutable<T>;
}

const issueObjectType = {
  kind: 'object',
  fields: [
    { name: 'title', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

const fetchIssue: WorkflowNode = {
  id: 'fetch_issue',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    {
      name: 'repository',
      type: { kind: 'string' },
      binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' },
    },
    {
      name: 'issueUrl',
      type: { kind: 'string' },
      binding: { kind: 'workflow_input', input: 'issueUrl' },
    },
  ],
  outputs: [{ name: 'issue', type: issueObjectType }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const draftSummary: WorkflowNode = {
  id: 'draft_summary',
  executionClass: 'agentic_computer_use',
  spec: {
    class: 'agentic_computer_use',
    task: 'Draft a triage summary and severity classification for the inbound GitHub issue.',
  },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    {
      name: 'issue',
      type: issueObjectType,
      binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
    },
  ],
  outputs: [
    { name: 'summary', type: { kind: 'string' } },
    { name: 'severity', type: { kind: 'string' } },
  ],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
};

const reviewGate: WorkflowNode = {
  id: 'review_gate',
  executionClass: 'human',
  spec: {
    class: 'human',
    human: {
      kind: 'approval',
      instruction: 'Approve posting the triage summary and syncing the backlog for this issue.',
    },
  },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

const notifyChannel: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [
    {
      name: 'text',
      type: { kind: 'string' },
      binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
    },
    {
      name: 'channel',
      type: { kind: 'string' },
      optional: true,
      binding: { kind: 'workflow_input', input: 'channel' },
    },
    {
      name: 'credentials',
      type: { kind: 'secret' },
      binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
    },
  ],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

const syncBacklog: WorkflowNode = {
  id: 'sync_backlog',
  executionClass: 'subworkflow',
  spec: {
    class: 'subworkflow',
    subworkflow: {
      workflowId: 'wf-backlog-sync',
      versionRef: 'wfv_0192837465afdeadbeef-candidate-1',
    },
  },
  capabilityRequirements: ['workflow.execute'],
  placement: 'any_supported_node',
  inputs: [
    {
      name: 'summary',
      type: { kind: 'string' },
      binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
    },
  ],
  outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
};

const logRejection: WorkflowNode = {
  id: 'log_rejection',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'filesystem.write' },
  capabilityRequirements: ['filesystem.write'],
  placement: 'device_local',
  inputs: [
    {
      name: 'path',
      type: { kind: 'string' },
      binding: { kind: 'literal', value: 'rejected-triage.log' },
    },
    {
      name: 'content',
      type: { kind: 'string' },
      binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
    },
  ],
  outputs: [],
  failurePolicy: { strategy: 'ignore_and_continue' },
};

const triageEdges: ControlEdge[] = [
  { from: 'fetch_issue', to: 'draft_summary', on: 'success' },
  { from: 'draft_summary', to: 'review_gate', on: 'success' },
  { from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } },
  { from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } },
];

const triagePresentation: PresentationMetadata = {
  title: 'Triage inbound GitHub issue',
  nodeLabels: { review_gate: 'Human review gate' },
  nodePositions: {
    fetch_issue: { x: 40, y: 20 },
    draft_summary: { x: 40, y: 180 },
    review_gate: { x: 40, y: 340 },
  },
  notes: 'Drafted during V2-003 dogfooding.',
};

/**
 * The real "triage an inbound GitHub issue" workflow used by the round-trip,
 * digest, cross-client and dogfooding experiments: observation step,
 * deterministic API steps, human approval gate, secret-referenced credentials,
 * subworkflow dependency, placement constraints and failure policy.
 */
export function buildTriageDocument(): WorkflowIrDocument {
  return {
    objectType: 'workflowos/workflow-ir/v1',
    irSchemaVersion: 1,
    compatibility: {
      compatibilityLevel: 'equivalent',
      inputSurfaceChange: 'none',
      outputSurfaceChange: 'none',
    },
    ir: {
      start: 'fetch_issue',
      inputs: [
        { name: 'issueUrl', type: { kind: 'string' } },
        { name: 'channel', type: { kind: 'string' }, optional: true },
      ],
      outputs: [
        {
          name: 'summary',
          type: { kind: 'string' },
          from: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
        },
        {
          name: 'messageId',
          type: { kind: 'string' },
          from: { kind: 'node_output', node: 'notify_channel', output: 'messageId' },
        },
      ],
      nodes: [
        fetchIssue,
        draftSummary,
        reviewGate,
        notifyChannel,
        syncBacklog,
        logRejection,
      ],
      edges: [...triageEdges],
      defaultPlacement: 'any_supported_node',
      provenance: { origin: 'authored' },
    },
    presentation: clone(triagePresentation),
  };
}

/**
 * The SAME workflow, independently reconstructed with every array in a
 * different order and every object built with a different key insertion
 * order. Semantically identical AND canonically identical (set semantics +
 * canonical key ordering), proving cross-client byte equivalence.
 */
export function buildTriageDocumentAltOrder(): WorkflowIrDocument {
  const nodes = [
    logRejection,
    syncBacklog,
    notifyChannel,
    reviewGate,
    draftSummary,
    fetchIssue,
  ].map(clone);
  const edges: ControlEdge[] = [
    { from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } },
    { from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } },
    { from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } },
    { from: 'draft_summary', to: 'review_gate', on: 'success' },
    { from: 'fetch_issue', to: 'draft_summary', on: 'success' },
  ];
  return {
    presentation: {
      notes: 'Drafted during V2-003 dogfooding.',
      nodePositions: {
        review_gate: { y: 340, x: 40 },
        draft_summary: { y: 180, x: 40 },
        fetch_issue: { y: 20, x: 40 },
      },
      nodeLabels: { review_gate: 'Human review gate' },
      title: 'Triage inbound GitHub issue',
    },
    ir: {
      provenance: { origin: 'authored' },
      defaultPlacement: 'any_supported_node',
      edges,
      nodes,
      outputs: [
        {
          from: { output: 'messageId', node: 'notify_channel', kind: 'node_output' },
          type: { kind: 'string' },
          name: 'messageId',
        },
        {
          from: { output: 'summary', node: 'draft_summary', kind: 'node_output' },
          type: { kind: 'string' },
          name: 'summary',
        },
      ],
      inputs: [
        { type: { kind: 'string' }, optional: true, name: 'channel' },
        { name: 'issueUrl', type: { kind: 'string' } },
      ],
      start: 'fetch_issue',
    },
    compatibility: {
      outputSurfaceChange: 'none',
      inputSurfaceChange: 'none',
      compatibilityLevel: 'equivalent',
    },
    irSchemaVersion: 1,
    objectType: 'workflowos/workflow-ir/v1',
  };
}

/** A minimal valid document (single deterministic node, no presentation). */
export function buildMinimalDocument(): WorkflowIrDocument {
  return {
    objectType: 'workflowos/workflow-ir/v1',
    irSchemaVersion: 1,
    compatibility: {
      compatibilityLevel: 'equivalent',
      inputSurfaceChange: 'none',
      outputSurfaceChange: 'none',
    },
    ir: {
      start: 'observe',
      inputs: [{ name: 'sourceUrl', type: { kind: 'string' } }],
      outputs: [],
      nodes: [
        {
          id: 'observe',
          executionClass: 'deterministic_api',
          spec: { class: 'deterministic_api', capability: 'browser.observe' },
          capabilityRequirements: ['browser.observe'],
          placement: 'any_supported_node',
          inputs: [
            {
              name: 'url',
              type: { kind: 'string' },
              binding: { kind: 'workflow_input', input: 'sourceUrl' },
            },
          ],
          outputs: [{ name: 'pageText', type: { kind: 'string' } }],
          failurePolicy: { strategy: 'fail_workflow' },
        },
      ],
      edges: [],
      defaultPlacement: 'any_supported_node',
      provenance: { origin: 'authored' },
    },
  };
}

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

/** Patch the workflow-level failure policy of a node in a cloned document. */
export function withNodeFailurePolicy(
  document: WorkflowIrDocument,
  nodeId: string,
  failurePolicy: StepFailurePolicy,
): WorkflowIrDocument {
  return withNode(document, nodeId, { failurePolicy });
}

/** Set the workflow IR in a cloned document (pure reconstruction). */
export function withIr(
  document: WorkflowIrDocument,
  irPatch: Partial<WorkflowIrDocument['ir']>,
): WorkflowIrDocument {
  return { ...document, ir: { ...document.ir, ...irPatch } };
}

/** Set the presentation block in a cloned document (pure reconstruction). */
export function withPresentation(
  document: WorkflowIrDocument,
  presentation: PresentationMetadata | undefined,
): WorkflowIrDocument {
  return { ...document, presentation };
}

/** Set the compatibility metadata in a cloned document (pure reconstruction). */
export function withCompatibility(
  document: WorkflowIrDocument,
  compatibility: WorkflowIrDocument['compatibility'],
): WorkflowIrDocument {
  return { ...document, compatibility };
}

/** Append a control edge in a cloned document (pure reconstruction). */
export function withEdge(document: WorkflowIrDocument, edge: ControlEdge): WorkflowIrDocument {
  return { ...document, ir: { ...document.ir, edges: [...document.ir.edges, edge] } };
}

/** Replace the input bindings of a node in a cloned document. */
export function withNodeInputs(
  document: WorkflowIrDocument,
  nodeId: string,
  inputs: PortBinding[],
): WorkflowIrDocument {
  return withNode(document, nodeId, { inputs });
}

/** Replace the outputs of a node in a cloned document. */
export function withNodeOutputs(
  document: WorkflowIrDocument,
  nodeId: string,
  outputs: PortDeclaration[],
): WorkflowIrDocument {
  return withNode(document, nodeId, { outputs });
}

/** Replace the workflow output bindings in a cloned document. */
export function withWorkflowOutputs(
  document: WorkflowIrDocument,
  outputs: WorkflowOutputBinding[],
): WorkflowIrDocument {
  return withIr(document, { outputs });
}
