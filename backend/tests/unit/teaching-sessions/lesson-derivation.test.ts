import { describe, it, expect } from 'vitest';
import { deriveLessonFromIrDocument } from '../../../src/teaching-sessions/index.js';
import { buildLinearDocument, buildSupportTriageDocument } from './helpers.js';

/**
 * V2-006 — the derived lesson battery.
 *
 * Teaching is a DERIVED VIEW over the pinned WorkflowIR document: the lesson
 * (intent, prerequisites, steps, decision points, observations, completion
 * criteria) is a deterministic projection of declared IR facts — never a
 * second workflow format, never an execution authority.
 */
describe('V2-006 — deriveLessonFromIrDocument: structure and determinism', () => {
  it('derives one lesson step per IR node, in a deterministic declared-order traversal', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(lesson.steps).toHaveLength(6);
    expect(lesson.steps.map((step) => step.nodeId)).toEqual(lesson.stepOrder);
    // Deterministic topological order with sorted tie-break: after the human
    // decision point the branch steps follow in sorted-node-id order.
    expect(lesson.stepOrder).toEqual([
      'fetch_ticket',
      'draft_reply',
      'human_review',
      'escalate_backlog',
      'log_miss',
      'send_reply',
    ]);
  });

  it('derivation is a pure function: repeated derivation is deep-equal', () => {
    const a = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const b = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(a).toEqual(b);
  });

  it('every step carries its 1-based checkpoint position and its declared execution class', () => {
    const lesson = deriveLessonFromIrDocument(buildLinearDocument());
    expect(lesson.steps.map((step) => step.position)).toEqual([1, 2]);
    expect(lesson.steps.map((step) => step.executionClass)).toEqual(['deterministic_api', 'deterministic_api']);
  });

  it('a cyclic control graph is rejected fail-closed (no honest lesson order exists)', () => {
    const document = buildLinearDocument();
    const cyclic = {
      ...document,
      ir: {
        ...document.ir,
        edges: [
          ...document.ir.edges,
          { from: 'announce', to: 'observe_page', on: 'success' as const },
        ],
      },
    };
    expect(() => deriveLessonFromIrDocument(cyclic)).toThrowError(/IR_GRAPH_CYCLE/);
  });
});

describe('V2-006 — the intent section (derived from declared workflow facts)', () => {
  it('states the declared start, inputs, outputs and provenance origin', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(lesson.intent.startNodeId).toBe('fetch_ticket');
    expect(lesson.intent.inputNames).toEqual(['channel', 'ticketUrl']);
    expect(lesson.intent.outputNames).toEqual(['messageId']);
    expect(lesson.intent.provenanceOrigin).toBe('authored');
  });

  it('the intent statement interpolates ONLY declared facts', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(lesson.intent.statement).toContain('"fetch_ticket"');
    expect(lesson.intent.statement).toContain('ticketUrl');
    expect(lesson.intent.statement).toContain('channel');
    expect(lesson.intent.statement).toContain('messageId');
  });
});

describe('V2-006 — prerequisites (inputs, capabilities, placement)', () => {
  it('derives a prerequisite per declared workflow input, marking optional ones', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const inputs = lesson.prerequisites.filter((p) => p.kind === 'workflow_input');
    expect(inputs.map((p) => p.value).sort()).toEqual([
      'channel (type string, optional)',
      'ticketUrl (type string, required)',
    ]);
  });

  it('derives the deduplicated union of declared capability requirements', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const capabilities = lesson.prerequisites.filter((p) => p.kind === 'required_capability');
    expect(capabilities.map((p) => p.value)).toEqual([
      'filesystem.write',
      'github.repository.read',
      'messaging.send',
      'workflow.execute',
    ]);
  });

  it('derives the declared placement constraints (default + per-step)', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const placements = lesson.prerequisites.filter((p) => p.kind === 'placement');
    expect(placements.map((p) => p.value)).toContain('default placement any_supported_node');
    expect(placements.map((p) => p.value)).toContain('step human_review requires placement device_local');
  });
});

describe('V2-006 — decision points (what the workflow expects the human to decide)', () => {
  it('derives the human approval gate with BOTH declared outcomes and where they lead', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    expect(lesson.decisionPoints).toHaveLength(1);
    const decision = lesson.decisionPoints[0]!;
    expect(decision.nodeId).toBe('human_review');
    expect(decision.humanKind).toBe('approval');
    expect(decision.instruction).toBe('Approve sending the drafted support reply and syncing the backlog.');
    expect(decision.outcomes.sort()).toEqual(['approved', 'rejected']);
    const approved = decision.leadsTo.find((l) => l.outcome === 'approved')!;
    expect(approved.nextNodeIds.sort()).toEqual(['escalate_backlog', 'send_reply']);
    const rejected = decision.leadsTo.find((l) => l.outcome === 'rejected')!;
    expect(rejected.nextNodeIds).toEqual(['log_miss']);
  });

  it('a workflow without human nodes has no decision points', () => {
    const lesson = deriveLessonFromIrDocument(buildLinearDocument());
    expect(lesson.decisionPoints).toEqual([]);
  });
});

describe('V2-006 — observations and completion criteria', () => {
  it('derives the declared per-step outputs and workflow outputs as observations', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const stepOutputs = lesson.observations.filter((o) => o.kind === 'step_output');
    expect(stepOutputs.map((o) => o.value)).toContain('fetch_ticket declares output port ticket');
    const workflowOutputs = lesson.observations.filter((o) => o.kind === 'workflow_output');
    expect(workflowOutputs.map((o) => o.value)).toEqual(['workflow output messageId']);
  });

  it('derives completion criteria from declared workflow outputs and terminal steps', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const outputCriteria = lesson.completionCriteria.filter((c) => c.kind === 'workflow_output');
    expect(outputCriteria.map((c) => c.value)).toEqual(['workflow produces output messageId']);
    const terminal = lesson.completionCriteria.filter((c) => c.kind === 'terminal_step');
    // send_reply, escalate_backlog and log_miss have no outgoing declared edges.
    expect(terminal.map((c) => c.value).sort()).toEqual([
      'escalate_backlog is a terminal step',
      'log_miss is a terminal step',
      'send_reply is a terminal step',
    ]);
  });

  it('declared step completion-evidence classes are surfaced as observations', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const evidenceObservations = lesson.observations.filter((o) => o.kind === 'step_completion_evidence');
    expect(evidenceObservations.map((o) => o.value)).toContain(
      'fetch_ticket completion is established by observation',
    );
    expect(evidenceObservations.map((o) => o.value)).toContain(
      'human_review completion is established by human_confirmation',
    );
  });
});

describe('V2-006 — step conditional context (declared control edges)', () => {
  it('branch steps record the declared incoming edge trigger they depend on', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const logMiss = lesson.steps.find((step) => step.nodeId === 'log_miss')!;
    expect(logMiss.conditionalOn).toEqual([
      { from: 'human_review', trigger: 'outcome:rejected' },
    ]);
    const sendReply = lesson.steps.find((step) => step.nodeId === 'send_reply')!;
    expect(sendReply.conditionalOn).toEqual([
      { from: 'human_review', trigger: 'outcome:approved' },
    ]);
    const fetchTicket = lesson.steps.find((step) => step.nodeId === 'fetch_ticket')!;
    expect(fetchTicket.conditionalOn).toEqual([]);
  });

  it('per-step declared facts include inputs, outputs, placement and failure policy', () => {
    const lesson = deriveLessonFromIrDocument(buildSupportTriageDocument());
    const sendReply = lesson.steps.find((step) => step.nodeId === 'send_reply')!;
    expect(sendReply.inputs.map((input) => input.port)).toEqual(['credentials', 'text']);
    expect(sendReply.outputs.map((output) => output.port)).toEqual(['messageId']);
    expect(sendReply.placement).toBe('cloud_preferred');
    expect(sendReply.failurePolicy).toBe('fail_workflow');
    const draftReply = lesson.steps.find((step) => step.nodeId === 'draft_reply')!;
    expect(draftReply.failurePolicy).toBe('retry_then_fail_workflow(maxAttempts=2)');
  });
});
