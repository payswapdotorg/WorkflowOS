/**
 * V2-005 — run lifecycle + version pinning + tenant isolation over real
 * PostgreSQL semantics (pglite locally / real PG under
 * WORKFLOWOS_DATABASE_URL).
 *
 * Pins the Work Order's required regressions:
 *   - version pinning (composite (workflow, version) tuple; wrong-workflow
 *     version typed-rejected; the pinned version's immutability keeps run
 *     inputs stable);
 *   - pause/resume race legality + attempt rule (pause/resume SAME attempt;
 *     declared crash → NEW attempt);
 *   - unauthorized completion (typed rejection; run state untouched);
 *   - terminal runs are lifecycle-immutable but evidence-appendable;
 *   - tenant/isolation (cross-org typed not-found, zero leakage).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  WorkflowRunError,
  type WorkflowRunService,
} from '../../../src/workflow-runs/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  commitmentOf,
  envelope,
  type WorkflowRunTestStack,
} from './run-test-support.js';

describe('V2-005 — run lifecycle, version pinning, tenant isolation (real PG)', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let workflowId: string;
  let version1Id: string;
  let version2Id: string;
  let installationId: string | null;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    service = harness.freshRunService();
    const triage = await createTriageWorkflow(harness, 'triage-lifecycle');
    workflowId = triage.workflowId;
    version1Id = triage.version.id;
    // a SECOND version exists (publisher edit) — v1 pins must not move
    const v2 = await harness.repository.createVersion({ userId: harness.ownerAId }, workflowId, {
      content: { title: 'v2 content' } as Record<string, unknown>,
      protocol: { irSchemaVersion: 'test-ir-1' },
    });
    version2Id = v2.version.id;
    // an installation pins v1
    const install = await harness.repository.installVersion({ userId: harness.ownerAId }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
    });
    installationId = install.installation.id;
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
  const MEMBER = () => ({ userId: harness.memberAId });
  const OUTSIDER = () => ({ userId: harness.userBId });

  async function requestRun(opts: { triggerId?: string; versionId?: string; commandId?: string } = {}) {
    return service.requestRun(OWNER(), {
      commandId: opts.commandId ?? 'cmd-req-0001',
      correlationId: opts.triggerId ?? 'delivery-0001',
      causationId: 'evt-issue-opened-1',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: opts.versionId ?? version1Id,
      installationId,
      trigger: { type: 'webhook', id: opts.triggerId ?? 'delivery-0001' },
      inputCommitments: [commitmentOf('ticket-4321-body')],
    });
  }

  it('requests a run pinned to the EXACT (workflow, version) + installation + trigger + input commitments', async () => {
    const outcome = await requestRun();
    expect(outcome.executed).toBe(true);
    expect(outcome.result.created).toBe(true);
    const run = outcome.result.run;
    expect(run.state).toBe('requested');
    expect(run.workflowId).toBe(workflowId);
    expect(run.versionId).toBe(version1Id);
    expect(run.versionContentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.versionSemanticDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.installationId).toBe(installationId);
    expect(run.trigger).toEqual({ type: 'webhook', id: 'delivery-0001' });
    expect(run.inputCommitments).toEqual([commitmentOf('ticket-4321-body')]);
    expect(run.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.triggeredByUserId).toBe(harness.ownerAId);
  });

  it('a version from ANOTHER workflow is typed-rejected (tuple integrity)', async () => {
    const other = await createTriageWorkflow(harness, 'triage-other');
    try {
      await service.requestRun(OWNER(), envelope(2, 'delivery-0002'), {
        organizationId: harness.orgAId,
        workflowId, // workflow A
        versionId: other.version.id, // version of workflow B — structurally unrunnable
        trigger: { type: 'manual', id: 'manual-1' },
        inputCommitments: [],
      });
      expect.unreachable('cross-workflow version must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_VERSION_NOT_OF_WORKFLOW');
    }
  });

  it('version pinning: a NEWER version never moves the run\'s pinned inputs', async () => {
    const outcome = await requestRun();
    const run = outcome.result.run;
    expect(run.versionId).toBe(version1Id);
    expect(run.versionId).not.toBe(version2Id);
    // reading the run again after the new version exists: the pin is stable
    const reread = await service.getRun(OWNER(), run.id);
    expect(reread.versionId).toBe(version1Id);
    expect(reread.versionContentDigest).toBe(run.versionContentDigest);
    expect(reread.versionSemanticDigest).toBe(run.versionSemanticDigest);
  });

  it('starts the run (requested → running, attempt 1) and emits the registry event', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    const started = await service.startRun(OWNER(), envelope(3, 'delivery-0001'), {
      runId,
      nodeId: 'node_test_host_1',
    });
    expect(started.result.run.state).toBe('running');
    expect(started.result.attempt).not.toBeNull();
    expect(started.result.attempt!.attemptNumber).toBe(1);
    expect(started.result.attempt!.state).toBe('running');
    expect(started.result.attempt!.nodeId).toBe('node_test_host_1');

    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.timeline.map((e) => e.eventName)).toContain('workflow.run.requested');
    expect(history.timeline.map((e) => e.eventName)).toContain('workflow.run.started');
  });

  it('PAUSE mid-run and RESUME to the EXACT step — the SAME attempt continues', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(4, 'delivery-0001'), { runId });
    await service.recordStepStarted(OWNER(), envelope(5, 'delivery-0001'), {
      runId,
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('fetch-input')],
    });
    // pause AT the review gate
    const paused = await service.pauseRun(OWNER(), envelope(6, 'delivery-0001'), {
      runId,
      atStepId: 'review_gate',
    });
    expect(paused.result.run.state).toBe('paused');
    expect(paused.result.attempt!.state).toBe('suspended');
    expect(paused.result.attempt!.pausedAtStepId).toBe('review_gate');

    const resumed = await service.resumeRun(OWNER(), envelope(7, 'delivery-0001'), { runId });
    expect(resumed.result.run.state).toBe('running');
    expect(resumed.result.newAttempt).toBe(false);
    expect(resumed.result.attempt.attemptNumber).toBe(1);
    expect(resumed.result.resumedAtStepId).toBe('review_gate');
    expect(resumed.result.attempt.state).toBe('running');
    expect(resumed.result.attempt.pausedAtStepId).toBeNull();
  });

  it('a DECLARED crash closes the attempt; the next resume RESTARTS as a NEW attempt', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(8, 'delivery-0001'), { runId });
    await service.recordStepStarted(OWNER(), envelope(9, 'delivery-0001'), { runId, stepId: 'fetch_issue' });
    const interrupted = await service.interruptRunAttempt(OWNER(), envelope(10, 'delivery-0001'), {
      runId,
      reason: 'execution host lost (crash declared by the executor)',
    });
    expect(interrupted.result.run.state).toBe('paused');
    expect(interrupted.result.attempt!.state).toBe('interrupted');
    expect(interrupted.result.attempt!.attemptNumber).toBe(1);

    const resumed = await service.resumeRun(OWNER(), envelope(11, 'delivery-0001'), { runId });
    expect(resumed.result.run.state).toBe('running');
    expect(resumed.result.newAttempt).toBe(true);
    expect(resumed.result.attempt.attemptNumber).toBe(2);
    expect(resumed.result.attempt.state).toBe('running');

    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it('illegal lifecycle transitions are TYPED-rejected and the state is untouched', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    // pause before start is illegal
    try {
      await service.pauseRun(OWNER(), envelope(12, 'delivery-0001'), { runId });
      expect.unreachable('pause on requested must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_INVALID_STATE_TRANSITION');
    }
    expect((await service.getRun(OWNER(), runId)).state).toBe('requested');
    // complete before start is illegal
    try {
      await service.completeRun(OWNER(), envelope(13, 'delivery-0001'), { runId });
      expect.unreachable('complete on requested must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_INVALID_STATE_TRANSITION');
    }
    // start after started (still running) is illegal
    await service.startRun(OWNER(), envelope(14, 'delivery-0001'), { runId });
    try {
      await service.startRun(OWNER(), envelope(15, 'delivery-0001'), { runId });
      expect.unreachable('double start must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_INVALID_STATE_TRANSITION');
    }
    expect((await service.getRun(OWNER(), runId)).state).toBe('running');
  });

  it('completion from paused is illegal — the run must be actively running', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(16, 'delivery-0001'), { runId });
    await service.pauseRun(OWNER(), envelope(17, 'delivery-0001'), { runId });
    try {
      await service.completeRun(OWNER(), envelope(18, 'delivery-0001'), { runId });
      expect.unreachable('complete on paused must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_INVALID_STATE_TRANSITION');
    }
  });

  it('UNAUTHORIZED completion from another tenant → typed not-found; the run state is untouched', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(19, 'delivery-0001'), { runId });
    try {
      await service.completeRun(OUTSIDER(), envelope(20, 'delivery-0001'), { runId });
      expect.unreachable('outsider completion must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_NOT_FOUND');
    }
    expect((await service.getRun(OWNER(), runId)).state).toBe('running');
    // and the outsider cannot even READ the run (uniform not-found, no leak)
    try {
      await service.getRun(OUTSIDER(), runId);
      expect.unreachable('outsider read must be a typed not-found');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_NOT_FOUND');
    }
  });

  it('organization listing is member-scoped; requesting into a non-member org is typed-rejected', async () => {
    await requestRun();
    const runsA = await service.listRunsInOrganization(OWNER(), harness.orgAId);
    expect(runsA.length).toBe(1);
    const memberRuns = await service.listRunsInOrganization(MEMBER(), harness.orgAId);
    expect(memberRuns.length).toBe(1);
    try {
      await service.listRunsInOrganization(OUTSIDER(), harness.orgAId);
      expect.unreachable('outsider listing must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_NOT_ORGANIZATION_MEMBER');
    }
  });

  it('complete → terminal: lifecycle immutable, steps rejected, evidence STILL appendable', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(21, 'delivery-0001'), { runId });
    await service.recordStepStarted(OWNER(), envelope(22, 'delivery-0001'), { runId, stepId: 'fetch_issue' });
    await service.recordStepCompleted(OWNER(), envelope(23, 'delivery-0001'), {
      runId,
      stepId: 'fetch_issue',
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('issue-body')],
    });
    const done = await service.completeRun(OWNER(), envelope(24, 'delivery-0001'), {
      runId,
      outputCommitments: [commitmentOf('message-id-42')],
    });
    expect(done.result.run.state).toBe('completed');
    expect(done.result.attempt!.state).toBe('ended');

    // lifecycle is immutable after terminal
    for (const [label, fn] of [
      ['pause', () => service.pauseRun(OWNER(), envelope(25, 'delivery-0001'), { runId })],
      ['resume', () => service.resumeRun(OWNER(), envelope(26, 'delivery-0001'), { runId })],
      ['cancel', () => service.cancelRun(OWNER(), envelope(27, 'delivery-0001'), { runId })],
      ['complete', () => service.completeRun(OWNER(), envelope(28, 'delivery-0001'), { runId })],
      ['fail', () => service.failRun(OWNER(), envelope(29, 'delivery-0001'), { runId })],
    ] as const) {
      try {
        await fn();
        expect.unreachable(`${label} on terminal run must be rejected`);
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_TERMINAL');
      }
    }
    // steps/invocations are closed on terminal runs
    try {
      await service.recordStepStarted(OWNER(), envelope(30, 'delivery-0001'), { runId, stepId: 'review_gate' });
      expect.unreachable('step on terminal run must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_TERMINAL');
    }
    // evidence is STILL appendable (append-only-for-evidence)
    const evidence = await service.recordEvidence(OWNER(), envelope(31, 'delivery-0001'), {
      runId,
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'node_test_host_1',
      contentCommitment: commitmentOf('post-completion observation'),
    });
    expect(evidence.result.evidence.evidenceClass).toBe('observation');
  });

  it('fail and cancel are first-class terminal transitions with output reasons', async () => {
    const r1 = await requestRun({ triggerId: 'delivery-fail-1', commandId: 'cmd-req-fail-1' });
    await service.startRun(OWNER(), envelope(32, 'delivery-fail-1'), { runId: r1.result.run.id });
    const failed = await service.failRun(OWNER(), envelope(33, 'delivery-fail-1'), {
      runId: r1.result.run.id,
      reason: 'messaging.send unavailable',
    });
    expect(failed.result.run.state).toBe('failed');

    const r2 = await requestRun({ triggerId: 'delivery-cancel-1', commandId: 'cmd-req-cancel-1' });
    const cancelled = await service.cancelRun(OWNER(), envelope(34, 'delivery-cancel-1'), {
      runId: r2.result.run.id,
      reason: 'operator aborted before start',
    });
    expect(cancelled.result.run.state).toBe('cancelled');
    // cancelled runs are terminal too
    try {
      await service.startRun(OWNER(), envelope(35, 'delivery-cancel-1'), { runId: r2.result.run.id });
      expect.unreachable('start on cancelled must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_TERMINAL');
    }
  });

  it('step records reference the pinned version\'s DECLARED steps (typed rejection otherwise)', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(36, 'delivery-0001'), { runId });
    try {
      await service.recordStepStarted(OWNER(), envelope(37, 'delivery-0001'), { runId, stepId: 'not_declared' });
      expect.unreachable('undeclared step must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_STEP_NOT_DECLARED');
    }
    const ok = await service.recordStepStarted(OWNER(), envelope(38, 'delivery-0001'), {
      runId,
      stepId: 'fetch_issue',
    });
    expect(ok.result.step.status).toBe('started');
    const completed = await service.recordStepCompleted(OWNER(), envelope(39, 'delivery-0001'), {
      runId,
      stepId: 'fetch_issue',
      outcome: 'succeeded',
    });
    expect(completed.result.step.status).toBe('completed');
    expect(completed.result.step.outcome).toBe('succeeded');
  });

  it('capability invocations use canonical registry names (typed rejection otherwise)', async () => {
    const requested = await requestRun();
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), envelope(40, 'delivery-0001'), { runId });
    try {
      await service.recordInvocationRequested(OWNER(), envelope(41, 'delivery-0001'), {
        runId,
        capability: 'messages.send', // forbidden alias
        executionClass: 'deterministic_api',
        stepId: 'notify_channel',
      });
      expect.unreachable('non-canonical capability must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_CAPABILITY_NON_CANONICAL');
    }
    const invocation = await service.recordInvocationRequested(OWNER(), envelope(42, 'delivery-0001'), {
      runId,
      capability: 'messaging.send',
      executionClass: 'deterministic_api',
      stepId: 'notify_channel',
      inputCommitments: [commitmentOf('notify-input')],
    });
    expect(invocation.result.invocation.capability).toBe('messaging.send');
    expect(invocation.result.invocation.outcome).toBeNull();
    const done = await service.recordInvocationCompleted(OWNER(), envelope(43, 'delivery-0001'), {
      runId,
      invocationId: invocation.result.invocation.id,
      outcome: 'succeeded',
      outputCommitments: [commitmentOf('notify-output')],
    });
    expect(done.result.invocation.outcome).toBe('succeeded');
  });
});
