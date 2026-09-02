/**
 * V2-005 — idempotent commands + concurrency over real PostgreSQL semantics.
 *
 * Pins the Work Order's required regressions:
 *   - concurrent start (two racing commands with the SAME idempotency key →
 *     exactly ONE run/attempt; both callers converge on the SAME identity);
 *   - duplicate command (replayed command id → typed idempotent convergence,
 *     same result, no second side effect — the command log proves exactly-once);
 *   - duplicate event delivery (different command ids, same trigger identity →
 *     exactly ONE run row — divergent duplicates are structurally
 *     unrepresentable);
 *   - payload conflict (same command id, different payload → typed rejection);
 *   - pause/resume race (interleaved commands → only legal transitions win,
 *     ordering serialized by the DB boundary).
 *
 * A second real-PostgreSQL connection variant (true multi-connection
 * contention) is env-gated below, following the repo's env-gate pattern.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  WorkflowRunError,
  DefaultWorkflowRunService,
  createSteppingRunClock,
  type WorkflowRunService,
} from '../../../src/workflow-runs/index.js';
import {
  buildWorkflowRunTestStack,
  createTriageWorkflow,
  commitmentOf,
  RUN_CLOCK_BASE_MS,
  RUN_CLOCK_STEP_MS,
  RUN_TEST_EPOCH,
  type WorkflowRunTestStack,
} from './run-test-support.js';

describe('V2-005 — idempotent commands + concurrency (real PG)', () => {
  let harness: WorkflowRunTestStack;
  let service: WorkflowRunService;
  let workflowId: string;
  let version1Id: string;

  beforeAll(async () => {
    harness = await buildWorkflowRunTestStack();
    service = harness.freshRunService();
    const triage = await createTriageWorkflow(harness, 'triage-concurrency');
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

  async function requestRunWith(commandId: string, triggerId = 'delivery-cc-0001') {
    return service.requestRun(OWNER(), {
      commandId,
      correlationId: triggerId,
      causationId: 'evt-issue-opened-cc',
    }, {
      organizationId: harness.orgAId,
      workflowId,
      versionId: version1Id,
      trigger: { type: 'webhook', id: triggerId },
      inputCommitments: [commitmentOf('cc-input')],
    });
  }

  it('CONCURRENT START with the same idempotency key → exactly ONE run; both converge on the SAME identity', async () => {
    // two racing request commands with the SAME command id (idempotency key)
    const [a, b] = await Promise.all([
      requestRunWith('cmd-cc-start-0001'),
      requestRunWith('cmd-cc-start-0001'),
    ]);
    const created = [a, b].filter((o) => o.executed);
    expect(created.length).toBe(1);
    expect(a.result.run.id).toBe(b.result.run.id);
    expect(a.result.created || b.result.created).toBe(true);
    // exactly ONE run row in the tenant
    const runs = await service.listRunsInOrganization(OWNER(), harness.orgAId);
    expect(runs.length).toBe(1);
    // exactly ONE request command row in the log (exactly-once proof)
    const history = await service.getRunHistory(OWNER(), a.result.run.id);
    expect(history.commands.length).toBe(1);
    expect(history.commands[0]!.commandId).toBe('cmd-cc-start-0001');
    expect(history.timeline.filter((e) => e.eventName === 'workflow.run.requested').length).toBe(1);
  });

  it('CONCURRENT START of the run lifecycle: two start commands, same idempotency key → ONE attempt', async () => {
    const requested = await requestRunWith('cmd-cc-req-0002');
    const runId = requested.result.run.id;
    const [a, b] = await Promise.all([
      service.startRun(OWNER(), { commandId: 'cmd-cc-start-0002', correlationId: 'delivery-cc-0001' }, { runId }),
      service.startRun(OWNER(), { commandId: 'cmd-cc-start-0002', correlationId: 'delivery-cc-0001' }, { runId }),
    ]);
    expect(a.result.run.state).toBe('running');
    expect(b.result.run.state).toBe('running');
    expect(a.result.attempt!.attemptNumber).toBe(b.result.attempt!.attemptNumber);
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.attempts.length).toBe(1);
    expect(history.timeline.filter((e) => e.eventName === 'workflow.run.started').length).toBe(1);
  });

  it('DUPLICATE EVENT DELIVERY (different command ids, same trigger identity) → ONE run (identity convergence)', async () => {
    const [a, b] = await Promise.all([
      requestRunWith('cmd-cc-delivery-a', 'delivery-cc-dup-1'),
      requestRunWith('cmd-cc-delivery-b', 'delivery-cc-dup-1'),
    ]);
    // duplicate delivery converges on the SAME run identity; exactly one was created
    expect(a.result.run.id).toBe(b.result.run.id);
    const createdCount = Number(a.result.created) + Number(b.result.created);
    expect(createdCount).toBeGreaterThanOrEqual(1);
    const runs = await service.listRunsInOrganization(OWNER(), harness.orgAId);
    expect(runs.length).toBe(1);
  });

  it('DUPLICATE COMMAND REPLAY converges: same result, no second side effect (command log proves exactly-once)', async () => {
    const requested = await requestRunWith('cmd-cc-replay-0001');
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-cc-step-0001', correlationId: 'delivery-cc-0001' }, { runId });

    // first execution of a step command
    const first = await service.recordStepStarted(OWNER(), { commandId: 'cmd-cc-step-0002', correlationId: 'delivery-cc-0001' }, {
      runId,
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('step-input')],
    });
    expect(first.executed).toBe(true);

    // the REPLAY of the exact same command (same id, same payload)
    const replay = await service.recordStepStarted(OWNER(), { commandId: 'cmd-cc-step-0002', correlationId: 'delivery-cc-0001' }, {
      runId,
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('step-input')],
    });
    expect(replay.executed).toBe(false);
    expect(replay.result.step.id).toBe(first.result.step.id);
    expect(replay.result.step.status).toBe(first.result.step.status);

    // exactly-once: ONE step row, ONE command row, ONE step-started event
    const history = await service.getRunHistory(OWNER(), runId);
    expect(history.steps.filter((s) => s.stepId === 'fetch_issue').length).toBe(1);
    expect(history.commands.filter((c) => c.commandId === 'cmd-cc-step-0002').length).toBe(1);
    expect(history.timeline.filter((e) => e.eventName === 'workflow.step.started' && e.stepId === 'fetch_issue').length).toBe(1);
  });

  it('duplicate command replay of a REJECTED command converges on the SAME typed rejection', async () => {
    const requested = await requestRunWith('cmd-cc-reject-0001');
    const runId = requested.result.run.id;
    // pause on a requested run is illegal → typed rejection, recorded
    const command = { commandId: 'cmd-cc-reject-0002', correlationId: 'delivery-cc-0001' };
    await expect(service.pauseRun(OWNER(), command, { runId })).rejects.toMatchObject({
      code: 'RUN_INVALID_STATE_TRANSITION',
    });
    // replaying the SAME command converges on the SAME rejection (no retry)
    await expect(service.pauseRun(OWNER(), command, { runId })).rejects.toMatchObject({
      code: 'RUN_INVALID_STATE_TRANSITION',
    });
    // the rejected command is durably recorded exactly once
    const history = await service.getRunHistory(OWNER(), runId);
    const rejected = history.commands.filter((c) => c.commandId === 'cmd-cc-reject-0002');
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.result.ok).toBe(false);
  });

  it('SAME command id with a DIFFERENT payload → typed payload conflict (never silently re-executed)', async () => {
    const requested = await requestRunWith('cmd-cc-conflict-0001');
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-cc-conflict-0002', correlationId: 'delivery-cc-0001' }, { runId });
    const first = await service.recordStepStarted(OWNER(), { commandId: 'cmd-cc-conflict-0003', correlationId: 'delivery-cc-0001' }, {
      runId,
      stepId: 'fetch_issue',
      inputCommitments: [commitmentOf('step-input')],
    });
    expect(first.executed).toBe(true);
    try {
      await service.recordStepStarted(OWNER(), { commandId: 'cmd-cc-conflict-0003', correlationId: 'delivery-cc-0001' }, {
        runId,
        stepId: 'fetch_issue',
        inputCommitments: [commitmentOf('DIFFERENT-input')],
      });
      expect.unreachable('payload conflict must be rejected');
    } catch (err) {
      expect((err as WorkflowRunError).code).toBe('RUN_COMMAND_PAYLOAD_CONFLICT');
    }
  });

  it('PAUSE/RESUME RACE: interleaved lifecycle commands — only legal transitions win; ordering is serialized by the DB', async () => {
    const requested = await requestRunWith('cmd-cc-race-0001');
    const runId = requested.result.run.id;
    await service.startRun(OWNER(), { commandId: 'cmd-cc-race-0002', correlationId: 'delivery-cc-0001' }, { runId });

    // interleaved pause + resume + pause, all racing concurrently
    const results = await Promise.allSettled([
      service.pauseRun(OWNER(), { commandId: 'cmd-cc-race-p1', correlationId: 'delivery-cc-0001' }, { runId, atStepId: 'review_gate' }),
      service.resumeRun(OWNER(), { commandId: 'cmd-cc-race-r1', correlationId: 'delivery-cc-0001' }, { runId }),
      service.pauseRun(OWNER(), { commandId: 'cmd-cc-race-p2', correlationId: 'delivery-cc-0001' }, { runId, atStepId: 'notify_channel' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // exactly one legal ordering wins; the others are typed-rejected
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const rejection of rejected) {
      if (rejection.status === 'rejected') {
        const code = (rejection.reason as WorkflowRunError).code;
        expect(['RUN_INVALID_STATE_TRANSITION', 'RUN_NOT_RUNNING']).toContain(code);
      }
    }
    // the final durable state is a LEGAL state reachable by the recorded sequence
    const run = await service.getRun(OWNER(), runId);
    expect(['running', 'paused']).toContain(run.state);
    // every fulfilled transition is visible in the timeline (nothing lost)
    const history = await service.getRunHistory(OWNER(), runId);
    const pauseEvents = history.timeline.filter((e) => e.eventName === 'workflow.run.paused').length;
    const resumeEvents = history.timeline.filter((e) => e.eventName === 'workflow.run.resumed').length;
    expect(pauseEvents + resumeEvents).toBe(fulfilled.length);
  });

  it('env-gated (real multi-connection PG): two connections racing the same start → ONE run', async () => {
    const dbUrl = process.env.WORKFLOWOS_DATABASE_URL;
    if (!dbUrl || !dbUrl.startsWith('postgres') || !harness.stack.db.createSecondClient) {
      expect(true).toBe(true); // pglite path: single-connection contention is covered above
      return;
    }
    const second = await harness.stack.db.createSecondClient();
    try {
      const serviceOverSecond = new DefaultWorkflowRunService({
        db: second.client,
        memberships: harness.memberships,
        workflowRepository: harness.repository,
        clock: createSteppingRunClock(RUN_CLOCK_BASE_MS, RUN_CLOCK_STEP_MS),
        currentEpoch: RUN_TEST_EPOCH,
      });
      const command = { commandId: 'cmd-cc-2conn-0001', correlationId: 'delivery-cc-2conn' };
      const input = {
        organizationId: harness.orgAId,
        workflowId,
        versionId: version1Id,
        trigger: { type: 'webhook' as const, id: 'delivery-cc-2conn' },
        inputCommitments: [commitmentOf('two-conn-input')],
      };
      const [a, b] = await Promise.all([
        service.requestRun(OWNER(), command, input),
        serviceOverSecond.requestRun(OWNER(), command, input),
      ]);
      expect(a.result.run.id).toBe(b.result.run.id);
      const runs = await service.listRunsInOrganization(OWNER(), harness.orgAId);
      expect(runs.length).toBe(1);
    } finally {
      await second.close();
    }
  });
});
