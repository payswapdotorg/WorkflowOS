/**
 * V2-011 — shared unit-battery helpers.
 *
 * Everything deterministic: fixture documents authored through the MERGED
 * V2-003 builder (real registry names, real port/binding/edge shapes), a
 * scripted materializer (records every call; returns sequential ids), and
 * the service composition with sequential ids + a stepping clock — the
 * V2-006/V2-010 house discipline (zero wall clock, zero randomness, zero
 * network).
 */
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  DefaultWorkflowOptimizationService,
  InMemoryOptimizationProposalStore,
  createSequentialIdFactory,
  createSteppingClock,
} from '../../../src/workflow-optimization/index.js';
import type {
  CandidateVersionMaterializer,
  CandidateVersionMaterializerInput,
  CandidateVersionMaterializerResult,
  WorkflowOptimizationService,
} from '../../../src/workflow-optimization/index.js';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

// ============================================================================
// Fixture documents (authored through the merged V2-003 builder)
// ============================================================================

/** The V2-011 dogfooding task workflow: the repository ticket digest report. */
export function authorCleanSubstitutableDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_board',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_digest',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_board', output: 'digest' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record why the digest report was rejected.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

/** The unsafe variant: the agentic node declares a SENSITIVE capability. */
export function authorSensitiveSubstitutableDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'write_report',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Write the digest line into the maintenance report file.',
      },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_digest',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'write_report', output: 'digest' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record why the digest report was rejected.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addEdge({ from: 'fetch_tickets', to: 'write_report', on: 'success' })
    .addEdge({ from: 'write_report', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

/** The pure-UI agentic node: NO substitution opportunity (the agentic class is required). */
export function authorUiAutomationDocument(): WorkflowIrDocument {
  const base = authorCleanSubstitutableDocument();
  return {
    ...base,
    ir: {
      ...base.ir,
      nodes: base.ir.nodes.map((node) =>
        node.id === 'scan_board'
          ? {
              ...node,
              spec: {
                class: 'agentic_computer_use',
                task: 'Observe the repository board page and click through the open ticket list.',
              },
              capabilityRequirements: ['browser.observe', 'browser.click'],
            }
          : node,
      ),
    },
  };
}

/** The reuse fixture: normalize_a / normalize_b are structural duplicates. */
export function authorReuseDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_rows')
    .addWorkflowInput({ name: 'sheetQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'publish_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_rows',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'sheetQuery' } },
      ],
      outputs: [{ name: 'rows', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'normalize_a',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'rows', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_rows', output: 'rows' } },
      ],
      outputs: [{ name: 'normalized', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'normalize_b',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'spreadsheet.read' },
      capabilityRequirements: ['spreadsheet.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'rows', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_rows', output: 'rows' } },
      ],
      outputs: [{ name: 'normalized', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_report',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the normalized digest before publishing.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'publish_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'normalize_a', output: 'normalized' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record why the normalized digest was rejected.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addEdge({ from: 'fetch_rows', to: 'normalize_a', on: 'success' })
    .addEdge({ from: 'fetch_rows', to: 'normalize_b', on: 'success' })
    .addEdge({ from: 'normalize_a', to: 'approve_report', on: 'success' })
    .addEdge({ from: 'normalize_b', to: 'approve_report', on: 'success' })
    .addEdge({ from: 'approve_report', to: 'publish_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_report', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

/** The human-duplicate fixture: two identical approval gates (unsafe reuse). */
export function authorHumanDuplicateDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('prepare_request')
    .addWorkflowInput({ name: 'requestQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'prepare_request',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'requestQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'gate_a',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'gate_b',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'literal', value: 'digest line' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record why the digest report was rejected.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addEdge({ from: 'prepare_request', to: 'gate_a', on: 'success' })
    .addEdge({ from: 'prepare_request', to: 'gate_b', on: 'success' })
    .addEdge({ from: 'gate_a', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'gate_b', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'gate_a', to: 'record_rejection', on: { outcome: 'rejected' } })
    .addEdge({ from: 'gate_b', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

/** The two-substitutable-nodes fixture (cross-version isolation). */
export function authorTwoSubstitutableNodesDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_a',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [{ name: 'digestA', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'scan_b',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board history and summarize the resolved ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'scan_a', output: 'digestA' } },
      ],
      outputs: [{ name: 'digestB', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_b', output: 'digestB' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_a', on: 'success' })
    .addEdge({ from: 'scan_a', to: 'scan_b', on: 'success' })
    .addEdge({ from: 'scan_b', to: 'send_digest', on: 'success' })
    .build();
}

/**
 * The multi-requirement fixture: scan_board declares TWO API-stable ordinary
 * requirements. A multi-requirement agentic node is NOT substitutable: the
 * deterministic_api spec carries exactly ONE capability, so substituting
 * would silently drop part of the node's execution contract — the analyzer
 * must detect NO opportunity for it (the full requirement set is preserved).
 */
export function authorMultiRequirementAgenticDocument(): WorkflowIrDocument {
  const base = authorCleanSubstitutableDocument();
  return {
    ...base,
    ir: {
      ...base.ir,
      nodes: base.ir.nodes.map((node) =>
        node.id === 'scan_board'
          ? {
              ...node,
              capabilityRequirements: ['github.repository.read', 'spreadsheet.read'],
            }
          : node,
      ),
    },
  };
}

/**
 * Two agentic nodes with IDENTICAL structure (same task string, same ports,
 * same failure policy, placement, completion evidence) — the second node's
 * capability requirements are `secondScanRequirements`. When the two nodes
 * declare DIFFERENT requirements they are NOT duplicates (their execution
 * contracts differ) and must never be grouped for reuse; when they declare
 * IDENTICAL requirements they ARE duplicates (the boundary's positive side).
 */
function authorAgenticDuplicatePairDocument(
  secondScanRequirements: readonly string[],
): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'scan_a',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'scan_b',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: [...secondScanRequirements],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_digest',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_a', output: 'digest' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record why the digest report was rejected.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_a', on: 'success' })
    .addEdge({ from: 'fetch_tickets', to: 'scan_b', on: 'success' })
    .addEdge({ from: 'scan_a', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'scan_b', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

/**
 * The differently-capable duplicates fixture: structurally identical agentic
 * nodes whose capabilityRequirements DIFFER — NOT duplicates; never grouped
 * for reuse (the reuse substitution would replace both nodes' distinct
 * execution contracts with workflow.execute).
 */
export function authorDifferentlyCapableAgenticDuplicatesDocument(): WorkflowIrDocument {
  return authorAgenticDuplicatePairDocument(['spreadsheet.read']);
}

/**
 * The identically-capable duplicates fixture: structurally identical agentic
 * nodes with IDENTICAL capabilityRequirements — genuine duplicates; still
 * grouped for reuse (the signature boundary's positive side).
 */
export function authorAgenticDuplicatesDocument(): WorkflowIrDocument {
  return authorAgenticDuplicatePairDocument(['github.repository.read']);
}

// ============================================================================
// Deterministic mutations of fixture documents (surface-divergence probes)
// ============================================================================

/** Rename one node's output port (breaks the task surface, not the class). */
export function withRenamedOutputPort(document: WorkflowIrDocument): WorkflowIrDocument {
  return {
    ...document,
    ir: {
      ...document.ir,
      nodes: document.ir.nodes.map((node) =>
        node.id === 'send_digest'
          ? {
              ...node,
              outputs: [{ ...node.outputs[0]!, name: 'messageIdentifier' }],
            }
          : node,
      ),
    },
  };
}

/** Change one node's failure policy retry budget (surface divergence). */
export function withChangedFailurePolicy(document: WorkflowIrDocument): WorkflowIrDocument {
  return {
    ...document,
    ir: {
      ...document.ir,
      nodes: document.ir.nodes.map((node) =>
        node.id === 'scan_board'
          ? { ...node, failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 } }
          : node,
      ),
    },
  };
}

// ============================================================================
// The scripted materializer (records every call; sequential version ids)
// ============================================================================

export class ScriptedMaterializer implements CandidateVersionMaterializer {
  private counter = 0;
  readonly calls: CandidateVersionMaterializerInput[] = [];
  /** when set, the next createCandidateVersion call throws this. */
  failure: Error | null = null;

  async createCandidateVersion(
    input: CandidateVersionMaterializerInput,
  ): Promise<CandidateVersionMaterializerResult> {
    this.calls.push(input);
    if (this.failure) {
      throw this.failure;
    }
    this.counter += 1;
    return { versionId: `wfv_scripted_${this.counter}` };
  }
}

// ============================================================================
// The deterministic service composition
// ============================================================================

const CLOCK_START_MS = 1789000000000;
const CLOCK_STEP_MS = 1000;

export function composeOptimizationService(): {
  service: WorkflowOptimizationService;
  materializer: ScriptedMaterializer;
} {
  const materializer = new ScriptedMaterializer();
  const service = new DefaultWorkflowOptimizationService({
    idFactory: createSequentialIdFactory('opt'),
    clock: createSteppingClock(CLOCK_START_MS, CLOCK_STEP_MS),
    store: new InMemoryOptimizationProposalStore(),
    materializer,
  });
  return { service, materializer };
}

/** The canonical baseline pin used across the unit battery. */
export const BASELINE = {
  ownerId: 'owner-v2-011',
  workflowId: 'wf-v2-011-fixture',
  versionId: 'wfv-v2-011-fixture-v1',
} as const;

/** Serialize a document to the plain JSON object the materializer carries. */
export function documentToPlainJson(document: WorkflowIrDocument): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>;
}
