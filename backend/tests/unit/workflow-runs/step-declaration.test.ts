/**
 * V2-005 — step records reference the pinned WorkflowVersion's DECLARED step
 * semantics (merged V2-003 builder + parse; the run module consumes the merged
 * barrels read-only). A step that the version does not declare is
 * typed-rejected; the declared execution class of the step is surfaced for
 * invocation records.
 */
import { describe, it, expect } from 'vitest';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';
import {
  declaredStepIdsOf,
  validateRunStepDeclaration,
} from '../../../src/workflow-runs/internal/step-validation.js';

const fetchNode: WorkflowNode = {
  id: 'fetch_issue',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
  ],
  outputs: [{ name: 'issue', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const reviewNode: WorkflowNode = {
  id: 'review_gate',
  executionClass: 'human',
  spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve posting the triage summary.' } },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

const notifyNode: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

function authorDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addNode(fetchNode)
    .addNode(reviewNode)
    .addNode(notifyNode)
    .addEdge({ from: 'fetch_issue', to: 'review_gate', on: 'success' })
    .addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } })
    // An approval node must cover BOTH declared outcomes; the rejected branch
    // also routes to the notification step (fixture-only: keeps the 3-node
    // declaration set the battery pins while satisfying V2-003's
    // IR_HUMAN_OUTCOME_UNCOVERED rule).
    .addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'rejected' } })
    .build();
}

/** The pinned version content as the repository stores it (opaque JSON). */
function versionContent(): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(authorDocument())) as Record<string, unknown>;
}

function parseVersionContent(content: Record<string, unknown>): WorkflowIrDocument {
  const parsed = parseWorkflowIrDocument(JSON.stringify(content));
  if (!parsed.ok) {
    throw new Error(`fixture document did not parse: ${JSON.stringify(parsed)}`);
  }
  return parsed.document;
}

describe('V2-005 — step records reference the version\'s declared steps', () => {
  it('the declared step ids of the pinned version are exposed in declaration order', () => {
    const document = parseVersionContent(versionContent());
    expect(declaredStepIdsOf(document)).toEqual(['fetch_issue', 'review_gate', 'notify_channel']);
  });

  it('a DECLARED step validates and surfaces its declared execution class', () => {
    const document = parseVersionContent(versionContent());
    const check = validateRunStepDeclaration(document, 'notify_channel');
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.executionClass).toBe('deterministic_api');
    }
    const human = validateRunStepDeclaration(document, 'review_gate');
    expect(human.ok).toBe(true);
    if (human.ok) {
      expect(human.executionClass).toBe('human');
    }
  });

  it('a step the version does NOT declare is typed-rejected (RUN_STEP_NOT_DECLARED)', () => {
    const document = parseVersionContent(versionContent());
    for (const undeclared of ['notify', 'fetch_issue ', 'Notify_Channel', 'escalate_backlog', '']) {
      const check = validateRunStepDeclaration(document, undeclared);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe('RUN_STEP_NOT_DECLARED');
      }
    }
  });

  it('serialization round-trip stability: the same version content always declares the same steps', () => {
    const first = parseVersionContent(versionContent());
    const second = parseVersionContent(versionContent());
    expect(declaredStepIdsOf(first)).toEqual(declaredStepIdsOf(second));
    const checkA = validateRunStepDeclaration(first, 'fetch_issue');
    const checkB = validateRunStepDeclaration(second, 'fetch_issue');
    expect(checkA.ok && checkB.ok && checkA.executionClass === checkB.executionClass).toBe(true);
  });
});
