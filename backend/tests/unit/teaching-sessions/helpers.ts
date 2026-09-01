import type {
  ControlEdge,
  WorkflowIrDocument,
  WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  createSteppingClock,
  createSequentialIdFactory,
  DefaultTeachingSessionService,
  InMemoryTeachingSessionStore,
  type PinnedWorkflowVersion,
  type TeachingSession,
  type TeachingSessionService,
} from '../../../src/teaching-sessions/index.js';
import { computeWorkflowVersionSemanticDigest } from '../../../src/workflow-ir/index.js';

/**
 * V2-006 — shared deterministic test fixtures for the teaching-sessions
 * battery.
 *
 * All fixtures are pure data; ids and clocks come from injected deterministic
 * factories (no wall clock, no randomness, no network). The same fixtures
 * always produce the same derived lesson, the same session transitions and
 * the same teaching evidence.
 */

// ============================================================================
// The real workflow under test: "support-ticket triage"
// ============================================================================

const ticketObjectType = {
  kind: 'object',
  fields: [
    { name: 'ticketId', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

/** A deterministic/API step WITHOUT any human-readable rationale (capability name only). */
const fetchTicket: WorkflowNode = {
  id: 'fetch_ticket',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
    { name: 'ticketUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketUrl' } },
  ],
  outputs: [{ name: 'ticket', type: ticketObjectType }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

/** An agentic step: the workflow DOES declare the task in natural language. */
const draftReply: WorkflowNode = {
  id: 'draft_reply',
  executionClass: 'agentic_computer_use',
  spec: {
    class: 'agentic_computer_use',
    task: 'Draft a support reply and a severity classification for the ticket.',
  },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'ticket', type: ticketObjectType, binding: { kind: 'node_output', node: 'fetch_ticket', output: 'ticket' } },
  ],
  outputs: [
    { name: 'reply', type: { kind: 'string' } },
    { name: 'severity', type: { kind: 'string' } },
  ],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
  completionEvidence: 'verification',
};

/** A human approval gate — the workflow's declared decision point. */
const humanReview: WorkflowNode = {
  id: 'human_review',
  executionClass: 'human',
  spec: {
    class: 'human',
    human: {
      kind: 'approval',
      instruction: 'Approve sending the drafted support reply and syncing the backlog.',
    },
  },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

/** A deterministic/API step bound to an opaque secret reference. */
const sendReply: WorkflowNode = {
  id: 'send_reply',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [
    { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'reply' } },
    { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'support-bot@secrets' } },
  ],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

/**
 * A subworkflow step — deliberately WITHOUT completionEvidence and without
 * any statement of what the referenced workflow does (both are disclosure
 * cases for the refusal-to-invent regression).
 */
const escalateBacklog: WorkflowNode = {
  id: 'escalate_backlog',
  executionClass: 'subworkflow',
  spec: {
    class: 'subworkflow',
    subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192_backlog_sync_v1' },
  },
  capabilityRequirements: ['workflow.execute'],
  placement: 'any_supported_node',
  inputs: [
    { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'severity' } },
  ],
  outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
};

/** A conditional deterministic step on the rejected branch (ignore_and_continue). */
const logMiss: WorkflowNode = {
  id: 'log_miss',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'filesystem.write' },
  capabilityRequirements: ['filesystem.write'],
  placement: 'device_local',
  inputs: [
    { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'missed-replies.log' } },
    { name: 'content', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'reply' } },
  ],
  outputs: [],
  failurePolicy: { strategy: 'ignore_and_continue' },
};

const triageEdges: ControlEdge[] = [
  { from: 'fetch_ticket', to: 'draft_reply', on: 'success' },
  { from: 'draft_reply', to: 'human_review', on: 'success' },
  { from: 'human_review', to: 'send_reply', on: { outcome: 'approved' } },
  { from: 'human_review', to: 'escalate_backlog', on: { outcome: 'approved' } },
  { from: 'human_review', to: 'log_miss', on: { outcome: 'rejected' } },
];

/**
 * The real "support-ticket triage" workflow used across the battery: an
 * observation/API step with no declared rationale, an agentic drafting step,
 * a human approval decision point with two declared outcomes, a
 * secret-referenced messaging step, a subworkflow dependency without declared
 * semantics, and a conditional logging step on the rejected branch.
 */
export function buildSupportTriageDocument(): WorkflowIrDocument {
  return {
    objectType: 'workflowos/workflow-ir/v1',
    irSchemaVersion: 1,
    compatibility: {
      compatibilityLevel: 'equivalent',
      inputSurfaceChange: 'none',
      outputSurfaceChange: 'none',
    },
    ir: {
      start: 'fetch_ticket',
      inputs: [
        { name: 'ticketUrl', type: { kind: 'string' } },
        { name: 'channel', type: { kind: 'string' }, optional: true },
      ],
      outputs: [
        {
          name: 'messageId',
          type: { kind: 'string' },
          from: { kind: 'node_output', node: 'send_reply', output: 'messageId' },
        },
      ],
      nodes: [fetchTicket, draftReply, humanReview, sendReply, escalateBacklog, logMiss],
      edges: [...triageEdges],
      defaultPlacement: 'any_supported_node',
      provenance: { origin: 'authored' },
    },
  };
}

/** A minimal LINEAR two-step workflow (order / pinning tests). */
export function buildLinearDocument(): WorkflowIrDocument {
  return {
    objectType: 'workflowos/workflow-ir/v1',
    irSchemaVersion: 1,
    compatibility: {
      compatibilityLevel: 'equivalent',
      inputSurfaceChange: 'none',
      outputSurfaceChange: 'none',
    },
    ir: {
      start: 'observe_page',
      inputs: [{ name: 'pageUrl', type: { kind: 'string' } }],
      outputs: [],
      nodes: [
        {
          id: 'observe_page',
          executionClass: 'deterministic_api',
          spec: { class: 'deterministic_api', capability: 'browser.observe' },
          capabilityRequirements: ['browser.observe'],
          placement: 'any_supported_node',
          inputs: [
            { name: 'url', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'pageUrl' } },
          ],
          outputs: [{ name: 'pageText', type: { kind: 'string' } }],
          failurePolicy: { strategy: 'fail_workflow' },
        },
        {
          id: 'announce',
          executionClass: 'deterministic_api',
          spec: { class: 'deterministic_api', capability: 'speech.synthesis' },
          capabilityRequirements: ['speech.synthesis'],
          placement: 'device_local',
          inputs: [
            { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'observe_page', output: 'pageText' } },
          ],
          outputs: [],
          failurePolicy: { strategy: 'fail_workflow' },
        },
      ],
      edges: [{ from: 'observe_page', to: 'announce', on: 'success' }],
      defaultPlacement: 'any_supported_node',
      provenance: { origin: 'authored' },
    },
  };
}

/** The linear workflow with one EDITED step (a semantically different version). */
export function buildLinearDocumentEdited(): WorkflowIrDocument {
  const document = buildLinearDocument();
  return {
    ...document,
    ir: {
      ...document.ir,
      nodes: [
        document.ir.nodes[0]!,
        {
          ...document.ir.nodes[1]!,
          placement: 'cloud_allowed',
          inputs: [
            { name: 'text', type: { kind: 'string' }, binding: { kind: 'literal', value: 'page read' } },
          ],
        },
      ],
    },
  };
}

/** The linear workflow with a PRESENTATION-ONLY change (same semantic digest). */
export function buildLinearDocumentRelabeled(): WorkflowIrDocument {
  const document = buildLinearDocument();
  return { ...document, presentation: { title: 'Read a page aloud (display label)' } };
}

// ============================================================================
// Deterministic service construction
// ============================================================================

/** Deterministic injected clock base (2024-12-07T10:40:00Z). */
export const CLOCK_BASE_MS = 1733568000000;
export const CLOCK_STEP_MS = 1000;

export const LEARNER_A = 'learner_amelia';
export const LEARNER_B = 'learner_ben';

export const LINEAR_WORKFLOW_ID = 'wf-linear-read-aloud';
export const LINEAR_VERSION_ID = 'wfv_linear_1';

/** The pinned version reference for the linear fixture (digest via the merged V2-003 barrel). */
export function pinLinearDocument(
  document: WorkflowIrDocument = buildLinearDocument(),
  versionId: string = LINEAR_VERSION_ID,
): PinnedWorkflowVersion {
  return {
    workflowId: LINEAR_WORKFLOW_ID,
    versionId,
    semanticDigest: computeWorkflowVersionSemanticDigest(document),
  };
}

/** A fresh deterministic teaching-session service over an isolated store. */
export function buildService(): TeachingSessionService {
  return new DefaultTeachingSessionService({
    idFactory: createSequentialIdFactory('ts'),
    clock: createSteppingClock(CLOCK_BASE_MS, CLOCK_STEP_MS),
    store: new InMemoryTeachingSessionStore(),
  });
}

/** The exact expected declared-semantics text of a support-triage step. */
export const SUPPORT_TRIAGE_STEP_SEMANTICS: Readonly<Record<string, string>> = {
  fetch_ticket: 'github.repository.read',
  draft_reply: 'Draft a support reply and a severity classification for the ticket.',
  human_review: 'Approve sending the drafted support reply and syncing the backlog.',
  send_reply: 'messaging.send',
  escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
  log_miss: 'filesystem.write',
};

/** JSON snapshot helper for state comparisons (sessions are JSON values). */
export function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

/** Deep structural clone (fixtures are JSON data). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Walk a full deterministic teaching flow over the support-triage lesson and
 * return the final session: begin → confirm every checkpoint in order → pass
 * the independent performance assessment.
 */
export function teachThrough(
  service: TeachingSessionService,
  learnerId: string,
  document: WorkflowIrDocument,
  pinned: PinnedWorkflowVersion,
): TeachingSession {
  const created = service.createSession({ learnerId, pinned });
  service.beginLesson({ sessionId: created.id, document });
  const lesson = service.getLesson({ sessionId: created.id, learnerId });
  for (const step of lesson.steps) {
    service.confirmCheckpoint({ sessionId: created.id, learnerId, nodeId: step.nodeId });
  }
  const assessment = service.submitIndependentPerformance({
    sessionId: created.id,
    learnerId,
    orderedStepIds: lesson.stepOrder,
    semanticsByStep: SUPPORT_TRIAGE_STEP_SEMANTICS,
  });
  if (!assessment.passed) {
    throw new Error(`teach-through assessment unexpectedly failed: ${JSON.stringify(assessment)}`);
  }
  return service.getSession({ sessionId: created.id, learnerId });
}
