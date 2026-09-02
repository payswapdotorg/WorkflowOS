/**
 * V2-005 — crash/retry reconstruction over real PostgreSQL: the persisted Run
 * alone rebuilds the full execution history. A fresh service instance over the
 * SAME database reconstructs exactly; a post-crash duplicate command converges
 * idempotently; no phantom side effects appear.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  WorkflowRunError,
  type WorkflowRunService,
  type WorkflowRunHistory,
} from '../../../src/workflow-runs/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  commitmentOf,
  type WorkflowRunTestStack,
} from './run-test-support.js';

describe('V2-005 — crash recovery + full history reconstruction (real PG)', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let workflowId: string;
  let version1Id: string;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    service = harness.freshRunService();
    const triage = await createTriageWorkflow(harness, 'triage-reconstruct');
    workflowId = triage.workflowId;
    version1Id = triage.version.id;
  });

  beforeEach(async () => {
    await harness.stack.db.client.exec(
      'TRUNCATE wfos_v2_run_commands, wfos_v2_run_events, wfos_v2_run_attestation_rejections, ' +
      'wfos_v2_run_attestations, wfos_v2_run_evidence, wfos_v2_run_invocations, wfos_v2_run_steps, ' +
      'wfos_v2_run_attempts, wfos_v2_runs CASCADE',
    );
  });

  afterAll(async () => {
    await harness.teardown();
  });

  const OWNER = () => ({ userId: harness.ownerAId });

  /** Drive a run mid-flight: requested → started → fetch completed → paused at review. */
  async function midFlightRun(): Promise<string> {
    const requested = await service.requestRun(OWNER(), {
      commandId: 'cmd-cr-req-0001',
      correlationId: 'delivery-cr-0001',
      causationId: 'evt-cr-1',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
      trigger: { type: 'manual', id: 'manual-cr-1' },
      inputCommitments: [commitmentOf('cr-input')],
    });
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-cr-start-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      nodeId: 'node_crash_host_1',
    });
    await service.recordStepStarted(OWNER(), { commandId: 'cmd-cr-step-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('fetch-in')],
    });
    await service.recordInvocationRequested(OWNER(), { commandId: 'cmd-cr-inv-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      capability: 'github.repository.read',
      executionClass: 'deterministic_api',
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('inv-in')],
    });
    await service.recordInvocationCompleted(OWNER(), { commandId: 'cmd-cr-inv-0002', correlationId: 'delivery-cr-0001' }, {
      runId,
      invocationId: (await service.getRunHistory(OWNER(), runId)).invocations[0]!.id,
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('inv-out')],
    });
    await service.recordStepCompleted(OWNER(), { commandId: 'cmd-cr-step-0002', correlationId: 'delivery-cr-0001' }, {
      runId,
      stepId: 'fetch_issue',
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('issue-out')],
    });
    await service.recordEvidence(OWNER(), { commandId: 'cmd-cr-ev-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_crash_host_1',
      contentCommitment: commitmentOf('cr-observation'),
    });
    await service.pauseRun(OWNER(), { commandId: 'cmd-cr-pause-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      atStepId: 'review_gate',
    });
    return runId;
  }

  it('a FRESH service instance over the same database reconstructs the history EXACTLY', async () => {
    const runId = await midFlightRun();
    const before: WorkflowRunHistory = await service.getRunHistory(OWNER(), runId);

    // CRASH: the original instance is discarded; a fresh instance takes over
    const fresh = harness.freshRunService();
    const after: WorkflowRunHistory = await fresh.getRunHistory(OWNER(), runId);

    expect(after.run).toEqual(before.run);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.steps).toEqual(before.steps);
    expect(after.invocations).toEqual(before.invocations);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.attestations).toEqual(before.attestations);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.commands).toEqual(before.commands);

    // the reconstructed state is the PAUSED mid-run state, at the exact step
    expect(after.run.state).toBe('paused');
    expect(after.attempts[0]!.state).toBe('suspended');
    expect(after.attempts[0]!.pausedAtStepId).toBe('review_gate');
    // steps in declared/recorded order with outcomes
    expect(after.steps.map((s) => [s.stepId, s.status, s.outcome])).toEqual([
      ['fetch_issue', 'completed', 'succeeded'],
    ]);
    expect(after.invocations.map((i) => [i.capability, i.outcome])).toEqual([
      ['github.repository.read', 'succeeded'],
    ]);
    expect(after.evidence.map((e) => [e.evidenceClass, e.producerId])).toEqual([
      ['observation', 'node_crash_host_1'],
    ]);
    // timeline: requested → started → step.started → invocation.requested →
    // invocation.completed → step.completed → observation.recorded → paused
    expect(after.timeline.map((e) => e.eventName)).toEqual([
      'workflow.run.requested',
      'workflow.run.started',
      'workflow.step.started',
      'capability.invocation.requested',
      'capability.invocation.completed',
      'workflow.step.completed',
      'observation.recorded',
      'workflow.run.paused',
    ]);
  });

  it('the fresh instance can RESUME the reconstructed run to the exact step and complete it', async () => {
    const runId = await midFlightRun();
    const fresh = harness.freshRunService();
    const resumed = await fresh.resumeRun(OWNER(), { commandId: 'cmd-cr-resume-0001', correlationId: 'delivery-cr-0001' }, { runId });
    expect(resumed.result.newAttempt).toBe(false);
    expect(resumed.result.attempt.attemptNumber).toBe(1);
    expect(resumed.result.resumedAtStepId).toBe('review_gate');
    // continue execution on the reconstructed state
    await fresh.recordStepStarted(OWNER(), { commandId: 'cmd-cr-step-0003', correlationId: 'delivery-cr-0001' }, {
      runId,
      stepId: 'review_gate',
    });
    await fresh.recordStepCompleted(OWNER(), { commandId: 'cmd-cr-step-0004', correlationId: 'delivery-cr-0001' }, {
      runId,
      stepId: 'review_gate',
      outcome: 'succeeded',
    });
    const done = await fresh.completeRun(OWNER(), { commandId: 'cmd-cr-complete-0001', correlationId: 'delivery-cr-0001' }, {
      runId,
      outputCommitments: [commitmentOf('cr-final-output')],
    });
    expect(done.result.run.state).toBe('completed');
  });

  it('post-crash DUPLICATE command converges idempotently — no phantom side effects', async () => {
    const runId = await midFlightRun();
    const before: WorkflowRunHistory = await service.getRunHistory(OWNER(), runId);

    // the executor replays a command it cannot prove was delivered (same id,
    // same payload) through a FRESH instance
    const fresh = harness.freshRunService();
    const replay = await fresh.recordStepCompleted(OWNER(), {
      commandId: 'cmd-cr-step-0002', // the SAME command id as pre-crash
      correlationId: 'delivery-cr-0001',
    }, {
      runId,
      stepId: 'fetch_issue',
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('issue-out')],
    });
    expect(replay.executed).toBe(false);

    const after: WorkflowRunHistory = await service.getRunHistory(OWNER(), runId);
    expect(after.steps.length).toBe(before.steps.length);
    expect(after.timeline.length).toBe(before.timeline.length);
    expect(after.commands.length).toBe(before.commands.length);
    expect(after.invocations.length).toBe(before.invocations.length);
    expect(after.evidence.length).toBe(before.evidence.length);
    // no phantom run appeared in the tenant
    const runs = await service.listRunsInOrganization(OWNER(), harness.orgAId);
    expect(runs.length).toBe(1);
  });

  it('a MISMATCHED post-crash command payload is typed-rejected (never silently applied)', async () => {
    const runId = await midFlightRun();
    const fresh = harness.freshRunService();
    try {
      await fresh.recordStepCompleted(OWNER(), {
        commandId: 'cmd-cr-step-0002',
        correlationId: 'delivery-cr-0001',
      }, {
        runId,
        stepId: 'fetch_issue',
        outcome: 'succeeded',
        outputCommitments: [commitmentOf('PHANTOM output')],
      });
      expect.unreachable('payload mismatch must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_COMMAND_PAYLOAD_CONFLICT');
    }
    // and the durable history is unchanged
    const after = await service.getRunHistory(OWNER(), runId);
    expect(after.steps[0]!.outputCommitments).toEqual([commitmentOf('issue-out')]);
  });
});
