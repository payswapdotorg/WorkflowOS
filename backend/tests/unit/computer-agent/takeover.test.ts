/**
 * V2-008 — human-takeover regressions (the human acts through the SAME host
 * protocol on a paused run, recorded as human-confirmation evidence; the
 * same grounding/staleness discipline applies to the human's acts).
 *
 * Covers the required regressions:
 *   - a run pauses at a decider 'takeover' decision → report
 *     { state: 'paused', pausedAtStepId, takeoverRequested: true };
 *   - `requestTakeover` on a NON-paused run → ComputerAgentError
 *     COMPUTER_AGENT_RUN_NOT_PAUSED (fail-closed);
 *   - `performTakeoverAction` with an act grounded on a STALE observation →
 *     typed rejection (HOST_PARAMETER_INVALID with the re-observe message)
 *     and the host file NOT written;
 *   - a fresh grounded human act → executes, recorded with evidence class
 *     'human_confirmation', producerKind 'human', producerId = the human's
 *     userId (checked in the recorder double log);
 *   - `finishTakeover` mode 'hand-back' + a decider that then completes →
 *     run completed, the human action is in the step history (verified via
 *     the recorder double invocation log containing the `tak-` invocation id
 *     prefix).
 */
import { describe, it, expect } from 'vitest';
import {
  createAgentHarness,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
} from './helpers.js';

const REPORT_PATH = 'reports/summary.md';
const HUMAN_USER_ID = 'user_human_1';

describe('V2-008 human takeover (pause at the decider\'s takeover point)', () => {
  it('the run pauses at a decider takeover decision → { state: paused, pausedAtStepId, takeoverRequested: true }', async () => {
    const harness = createAgentHarness({});
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({ keySeed: 'takeover-desktop', environment });

    const { decider } = createRecordingDecider(() => ({
      decision: 'takeover',
      reason: 'human confirmation of the destination path is required',
    }));

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    expect(report.state).toBe('paused');
    expect(report.pausedAtStepId).toBe(harness.stepId);
    expect(report.takeoverRequested).toBe(true);
    expect(report.failure).toBeNull();
    expect(harness.recorderDouble.state()).toBe('paused');
    expect(harness.recorderDouble.pausedAtStepId()).toBe(harness.stepId);
  });

  it('requestTakeover on a NON-paused run is rejected COMPUTER_AGENT_RUN_NOT_PAUSED', async () => {
    const harness = createAgentHarness({});
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({ keySeed: 'takeover-not-paused', environment });

    // the run was never driven: its state is 'requested' — takeover is only
    // available on a PAUSED run (fail-closed).
    await expect(
      harness.runtime.requestTakeover(PRINCIPAL, {
        runId: harness.runId,
        stepId: harness.stepId,
        userId: HUMAN_USER_ID,
        host,
      }),
    ).rejects.toMatchObject({ name: 'ComputerAgentError', code: 'COMPUTER_AGENT_RUN_NOT_PAUSED' });
  });
});

describe('V2-008 human takeover (the human acts through the SAME host protocol)', () => {
  it('a stale-grounded takeover act is rejected typed (re-observe discipline); a fresh human act executes + records; hand-back completes the run', async () => {
    const harness = createAgentHarness({});
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({ keySeed: 'takeover-full', environment });

    // 1. the agent requests takeover → the run pauses:
    const { decider } = createRecordingDecider(() => ({
      decision: 'takeover',
      reason: 'human confirmation required',
    }));
    const paused = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });
    expect(paused.state).toBe('paused');
    expect(paused.pausedAtStepId).toBe(harness.stepId);

    // 2. the human opens a takeover session on the paused run:
    const session = await harness.runtime.requestTakeover(PRINCIPAL, {
      runId: harness.runId,
      stepId: harness.stepId,
      userId: HUMAN_USER_ID,
      host,
    });
    expect(session.id).toBe(`takeover-${harness.runId}-${harness.stepId}`);
    expect(session.userId).toBe(HUMAN_USER_ID);
    expect(session.nodeId).toBe(host.nodeId);

    // 3. the human observes the target through the SAME protocol:
    const humanObserve = await harness.runtime.performTakeoverAction(session, PRINCIPAL, host, {
      kind: 'observe',
      capability: 'filesystem.read',
      subject: REPORT_PATH,
    });
    expect(humanObserve.result.ok).toBe(true);
    const observation = humanObserve.result.ok && humanObserve.result.kind === 'observed'
      ? humanObserve.result.observation
      : null;
    expect(observation).not.toBeNull();
    const target = observation?.elements.find((element) => element.elementId === REPORT_PATH);
    expect(target).toBeDefined();

    // 4. the human dawdles past the observation-age bound, then tries a
    //    grounded act → typed rejection, nothing written:
    harness.clock.advance(45_000);
    const staleAct = await harness.runtime.performTakeoverAction(session, PRINCIPAL, host, {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: {
        observationId: observation?.observationId ?? '',
        targetElementId: REPORT_PATH,
        targetDigest: target?.digest ?? '',
      },
      parameters: { path: REPORT_PATH, content: 'HUMAN-WROTE-THIS' },
    });
    expect(staleAct.result.ok).toBe(false);
    if (!staleAct.result.ok) {
      expect(staleAct.result.failure.code).toBe('HOST_PARAMETER_INVALID');
      expect(staleAct.result.failure.detail).toContain('re-observe');
    }
    expect(staleAct.evidenceCommandId).toBe('not-recorded');
    expect(environment.readFile(REPORT_PATH)).toBeNull(); // the host file was NOT written

    // 5. a FRESH grounded human act executes through the same protocol:
    const freshObserve = await harness.runtime.performTakeoverAction(session, PRINCIPAL, host, {
      kind: 'observe',
      capability: 'filesystem.read',
      subject: REPORT_PATH,
    });
    const freshObservation = freshObserve.result.ok && freshObserve.result.kind === 'observed'
      ? freshObserve.result.observation
      : null;
    expect(freshObservation).not.toBeNull();
    const freshTarget = freshObservation?.elements.find((element) => element.elementId === REPORT_PATH);
    const humanAct = await harness.runtime.performTakeoverAction(session, PRINCIPAL, host, {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: {
        observationId: freshObservation?.observationId ?? '',
        targetElementId: REPORT_PATH,
        targetDigest: freshTarget?.digest ?? '',
      },
      parameters: { path: REPORT_PATH, content: 'HUMAN-CONFIRMED' },
    });
    expect(humanAct.result.ok).toBe(true);
    expect(humanAct.evidenceCommandId).not.toBe('not-recorded');
    expect(environment.readFile(REPORT_PATH)).toBe('HUMAN-CONFIRMED');

    // the human-confirmation evidence: class, producer kind, producer id:
    const humanConfirmations = harness.recorderDouble.evidence.filter(
      (record) => record.evidenceClass === 'human_confirmation',
    );
    expect(humanConfirmations.length).toBe(1);
    expect(humanConfirmations[0]?.producerKind).toBe('human');
    expect(humanConfirmations[0]?.producerId).toBe(HUMAN_USER_ID);

    // 6. hand back to the agent: the decider completes the step on the
    //    human's real effect, and the run completes:
    const { decider: completingDecider } = createRecordingDecider((ctx) => {
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      return {
        decision: 'complete',
        verify: {
          capability: 'filesystem.read',
          subject: REPORT_PATH,
          expect: { elementId: REPORT_PATH, state: 'HUMAN-CONFIRMED' },
        },
        outputs: { written: true },
      };
    });
    const final = await harness.runtime.finishTakeover(PRINCIPAL, session, {
      mode: 'hand-back',
      hosts: [host],
      decider: completingDecider,
      workflowInputs: WORKFLOW_INPUTS,
    });
    expect(final.state).toBe('completed');
    expect(final.steps[0]?.outcome).toBe('completed');

    // the human action IS in the step history: the recorder double's
    // invocation log carries the `tak-` invocation id prefix:
    const takCommands = harness.recorderDouble.commands.filter((commandId) => commandId.includes('tak-'));
    expect(takCommands.length).toBeGreaterThan(0);
    expect(takCommands.some((commandId) => commandId.startsWith(`cmd-agent-${harness.runId}-inv-tak-`))).toBe(true);
    expect(takCommands.some((commandId) => commandId.startsWith(`cmd-agent-${harness.runId}-invc-tak-`))).toBe(true);
    // the human's write survives the hand-back:
    expect(environment.readFile(REPORT_PATH)).toBe('HUMAN-CONFIRMED');
  });
});
