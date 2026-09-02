/**
 * V2-010 — shared deterministic test fixtures for the reverse-teaching
 * battery.
 *
 * All fixtures are pure data; ids and clocks come from injected deterministic
 * factories (no wall clock, no randomness, no network). The same fixtures
 * always produce the same derived reverse-teaching lesson, the same session
 * transitions and the same teaching evidence.
 */
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';
import {
  capabilitySensitivityOf,
} from '../../../src/computer-agent/index.js';
import {
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
  DefaultReverseTeachingSessionService,
  type InstalledVersionPin,
  type ReverseTeachingSessionService,
} from '../../../src/reverse-teaching/index.js';

export const LEARNER_ID = 'v2-010-learner';
export const INSTALLATION_ID = 'wfin_v2_010_fixture_installation';

/** The deterministic stepping clock base (2024-12-07T10:40:00Z, 1 s steps). */
export const CLOCK_BASE_MS = 1733568000000;
export const CLOCK_STEP_MS = 1000;

export function buildTestService(): ReverseTeachingSessionService {
  return new DefaultReverseTeachingSessionService({
    idFactory: createSequentialIdFactory('rt'),
    clock: createSteppingClock(CLOCK_BASE_MS, CLOCK_STEP_MS),
    store: new InMemoryReverseTeachingSessionStore(),
  });
}

export function pinOf(document: WorkflowIrDocument): InstalledVersionPin {
  return {
    installationId: INSTALLATION_ID,
    workflowId: 'wf-v2-010-fixture',
    versionId: 'wfv-v2-010-fixture-v1',
    semanticDigest: computeWorkflowVersionSemanticDigest(document),
  };
}

// ============================================================================
// The real workflow under test: "daily customer follow-up"
// ============================================================================

/**
 * A realistic manual-task workflow: fetch open tickets, draft follow-ups,
 * approve them, send the message, record the customer response, escalate to
 * the backlog sync subworkflow.
 *
 * Deliberately exercises EVERY manual-actionability class and BOTH safety
 * classifications:
 *   - fetch_open_tickets  — deterministic_api           → system_performed
 *   - draft_followup      — agentic_computer_use        → agent_task,
 *                                                          safety_gated (filesystem.read)
 *   - approve_draft       — human (approval, no caps)   → human_declared, ordinary
 *   - record_outcome      — human + spreadsheet.edit    → human_declared, safety_gated
 *   - send_followup       — deterministic_api           → system_performed
 *   - escalate_backlog    — subworkflow                 → subworkflow_reference
 */
export function authorDailyFollowupDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_open_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_followup', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_open_tickets',
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
      id: 'draft_followup',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Draft a follow-up message for each open ticket in the fetched list.',
      },
      capabilityRequirements: ['github.repository.read', 'filesystem.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_open_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'draft', type: { kind: 'string' } },
        { name: 'remainingCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_draft',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'approval',
          instruction: 'Approve the drafted follow-up messages before sending.',
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'record_outcome',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: "Record the customer's response in the shared follow-up spreadsheet.",
          provides: { name: 'response', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: ['spreadsheet.edit'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'response', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_followup',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_followup', output: 'draft' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'followup-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'escalate_backlog',
      executionClass: 'subworkflow',
      spec: {
        class: 'subworkflow',
        subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192_backlog_sync_v1' },
      },
      capabilityRequirements: ['workflow.execute'],
      placement: 'any_supported_node',
      inputs: [
        { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'record_outcome', output: 'response' } },
      ],
      outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
    })
    .addEdge({ from: 'fetch_open_tickets', to: 'draft_followup', on: 'success' })
    .addEdge({ from: 'draft_followup', to: 'approve_draft', on: 'success' })
    .addEdge({ from: 'approve_draft', to: 'send_followup', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_draft', to: 'record_outcome', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_draft', to: 'escalate_backlog', on: { outcome: 'rejected' } })
    .addEdge({ from: 'record_outcome', to: 'escalate_backlog', on: 'success' })
    .build();
}

/**
 * The expected canonical manual performance order of the fixture.
 *
 * The V2-006 canonical Kahn traversal with the sorted ready-set tie-break:
 * after `approve_draft` unlocks BOTH `record_outcome` and `send_followup`,
 * `record_outcome` sorts first; completing it then makes `escalate_backlog`
 * ready, which sorts before `send_followup`.
 */
export const EXPECTED_STEP_ORDER = [
  'fetch_open_tickets',
  'draft_followup',
  'approve_draft',
  'record_outcome',
  'escalate_backlog',
  'send_followup',
] as const;

/**
 * The fixture's MANUAL-safety expectations (safety gating is about MANUAL
 * performance: only steps the person performs by hand and whose declared
 * capability requirements intersect V2-008's sensitive set are gated):
 *
 *   - fetch_open_tickets: system_performed (no manual instruction) → ordinary
 *   - draft_followup:     agent_task + filesystem.read (sensitive) → safety_gated
 *   - approve_draft:      human_declared, no capability requirements → ordinary
 *   - record_outcome:     human_declared + spreadsheet.edit (sensitive) → safety_gated
 *   - send_followup:      system_performed (no manual instruction) → ordinary
 *   - escalate_backlog:   subworkflow_reference (workflow.execute ordinary) → ordinary
 */
export const EXPECTED_SAFETY: Readonly<Record<string, 'ordinary' | 'safety_gated'>> = {
  fetch_open_tickets: 'ordinary',
  draft_followup: 'safety_gated',
  approve_draft: 'ordinary',
  record_outcome: 'safety_gated',
  send_followup: 'ordinary',
  escalate_backlog: 'ordinary',
};

/** Assert the V2-008 consumed classification actually classifies the fixture's capabilities. */
export function assertConsumedSensitivityExpectations(): void {
  // The two fixture capabilities that MUST be sensitive in V2-008's vocabulary.
  if (capabilitySensitivityOf('filesystem.read') !== 'sensitive') {
    throw new Error('fixture assumption broken: filesystem.read must be sensitive in the consumed V2-008 vocabulary');
  }
  if (capabilitySensitivityOf('spreadsheet.edit') !== 'sensitive') {
    throw new Error('fixture assumption broken: spreadsheet.edit must be sensitive in the consumed V2-008 vocabulary');
  }
  if (capabilitySensitivityOf('github.repository.read') !== 'ordinary') {
    throw new Error('fixture assumption broken: github.repository.read must be ordinary in the consumed V2-008 vocabulary');
  }
  // The fixture-level expectations (safety is about MANUAL performance).
  EXPECTED_SAFETY;
}
