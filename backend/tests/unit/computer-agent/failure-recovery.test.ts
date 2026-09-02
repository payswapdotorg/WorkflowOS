/**
 * V2-008 — failure-recovery regressions (bounded recovery with typed
 * classification; the runtime NEVER invents successful or failed side
 * effects — after a failed action the effect is UNKNOWN until re-observed).
 *
 * Covers the required regressions:
 *   - `ScriptedDesktopEnvironment.failNextWrites(1)`: the first grounded
 *     write fails HOST_ENVIRONMENT_ERROR; the runtime classifies it through
 *     the typed AgentFailure mapping (HOST_ENVIRONMENT_ERROR →
 *     AGENT_HOST_PERMANENT, NOT recoverable — honest fail-closed; contrast
 *     HOST_TRANSIENT_UNAVAILABLE → AGENT_HOST_TRANSIENT recoverable);
 *   - a custom scripted host adapter (inline `ComputerHostAdapter` with a
 *     script queue) returning HOST_TRANSIENT_UNAVAILABLE once then success:
 *     the runtime's recovery loop re-enters the decider (the history shows
 *     the transient failure), the decider re-observes/re-acts, the step
 *     completes;
 *   - `maxRecoveryCyclesPerStep: 0`: the SAME transient failure fails the
 *     step with AGENT_HOST_TRANSIENT (honest bounded recovery);
 *   - `maxActionsPerStep: 2` with a decider that never completes →
 *     AGENT_MAX_ACTIONS_EXCEEDED and the run failed;
 *   - classification mapping THROUGH RUNTIME REPORTS: HOST_TARGET_CHANGED →
 *     AGENT_TARGET_CHANGED (recoverable) and HOST_CAPABILITY_NOT_SUPPORTED →
 *     AGENT_HOST_PERMANENT (fail-closed, never emulated).
 */
import { describe, it, expect } from 'vitest';
import type {
  ComputerHostAdapter,
  HostInvocationRequest,
  HostInvocationResult,
  HostObservation,
} from '../../../src/computer-agent/index.js';
import { elementDigest, registerComputerHost } from '../../../src/computer-agent/index.js';
import type { DefaultNodeCapabilityService } from '../../../src/node-capability/index.js';
import {
  createAgentHarness,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
  type ManualClock,
} from './helpers.js';

const REPORT_PATH = 'reports/summary.md';

/**
 * A custom scripted host adapter: a plain inline `ComputerHostAdapter`
 * (script queue for acts; fresh observations for reads) registered through
 * the REAL V2-004 protocol. Grounding digests are the host's own element
 * digests so the runtime's staleness/grounding path is fully exercised.
 */
function createScriptedQueueHost(options: {
  nodes: DefaultNodeCapabilityService;
  clock: ManualClock;
  keySeed: string;
  actScript: HostInvocationResult[];
  initialState: string;
}): { host: ComputerHostAdapter; nodeId: string } {
  const { nodeId, sessionToken } = registerComputerHost({
    nodes: options.nodes,
    keySeed: options.keySeed,
    platformClass: 'desktop',
    capabilities: [
      { name: 'filesystem.read', version: 1, availability: 'available' },
      { name: 'filesystem.write', version: 1, availability: 'available' },
    ],
  });
  let observationSeq = 0;
  let nonceSeq = 0;
  let currentState = options.initialState;
  const observationOf = (subject: string, state: string): HostObservation => {
    observationSeq += 1;
    const label = subject.slice(subject.lastIndexOf('/') + 1);
    return {
      observationId: `obs-scripted-${String(observationSeq).padStart(4, '0')}`,
      observedAt: options.clock.now(),
      subject,
      elements: [
        {
          elementId: subject,
          kind: 'file' as const,
          label,
          state,
          digest: elementDigest({ elementId: subject, kind: 'file' as const, label, state }),
        },
      ],
    };
  };
  const host: ComputerHostAdapter = {
    nodeId,
    sessionToken,
    platformClass: 'desktop',
    capabilities: [
      { name: 'filesystem.read', version: 1, availability: 'available' },
      { name: 'filesystem.write', version: 1, availability: 'available' },
    ],
    attestationSupport: { supported: false, reason: 'no-attester-key' },
    nextNonce: () => `nonce-scripted-${String(++nonceSeq).padStart(4, '0')}`,
    async invoke(_invocationId: string, request: HostInvocationRequest): Promise<HostInvocationResult> {
      if (request.kind === 'observe') {
        return { ok: true, kind: 'observed', observation: observationOf(request.subject, currentState), converged: false };
      }
      const scripted = options.actScript.shift();
      if (scripted !== undefined) {
        if (scripted.ok && scripted.kind === 'acted') {
          // a scripted successful write updates the observed state:
          currentState = 'FINAL';
          if (scripted.outcome.effect === null) {
            return {
              ok: true,
              kind: 'acted',
              outcome: { ...scripted.outcome, effect: observationOf(request.grounding?.targetElementId ?? REPORT_PATH, 'FINAL') },
              converged: scripted.converged,
            };
          }
        }
        return scripted;
      }
      return {
        ok: true,
        kind: 'acted',
        outcome: {
          outcome: 'succeeded',
          effect: observationOf(request.grounding?.targetElementId ?? REPORT_PATH, currentState),
          detail: 'scripted act',
        },
        converged: false,
      };
    },
  };
  return { host, nodeId };
}

describe('V2-008 failure recovery (permanent host-environment failure is fail-closed)', () => {
  it('failNextWrites(1): the grounded write fails HOST_ENVIRONMENT_ERROR → classified AGENT_HOST_PERMANENT, not recoverable; the run fails honestly', async () => {
    const harness = createAgentHarness({ policy: { maxRecoveryCyclesPerStep: 4 } });
    const environment = freshDesktopEnvironment();
    environment.externalWrite(REPORT_PATH, 'draft-v1');
    const { host } = harness.attachDesktopHost({ keySeed: 'env-error-desktop', environment });

    const { decider } = createRecordingDecider((ctx) => {
      const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      if (!wrote) {
        const target = ctx.observation.elements.find((element) => element.elementId === REPORT_PATH);
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: {
            observationId: ctx.observation.observationId,
            targetElementId: REPORT_PATH,
            targetDigest: target?.digest ?? '',
          },
          parameters: { path: REPORT_PATH, content: 'FINAL' },
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'filesystem.read', subject: REPORT_PATH, expect: { elementId: REPORT_PATH, state: 'FINAL' } },
      };
    });

    // the next writeFile on the scripted desktop environment fails (the
    // host surfaces the environment error honestly):
    environment.failNextWrites(1);

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // the runtime classifies HOST_ENVIRONMENT_ERROR → AGENT_HOST_PERMANENT:
    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_HOST_PERMANENT');
    expect(step?.failure?.recoverable).toBe(false);
    // the typed classification carries the HOST detail (the scripted error):
    expect(step?.failure?.detail).toContain('scripted transient write failure');
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_HOST_PERMANENT');
    // the failed invocation was recorded honestly (outcome failed, not invented):
    const writeCompletion = harness.recorderDouble.invocationCompletions[1];
    expect(writeCompletion?.outcome).toBe('failed');
    // the environment was NOT written (the effect is unknown, never guessed):
    expect(environment.readFile(REPORT_PATH)).toBe('draft-v1');
  });
});

describe('V2-008 failure recovery (transient host failure — bounded recovery loop)', () => {
  function transientThenSuccess(): HostInvocationResult[] {
    return [
      { ok: false, failure: { code: 'HOST_TRANSIENT_UNAVAILABLE', detail: 'scripted transient unavailability' } },
      {
        ok: true,
        kind: 'acted',
        outcome: { outcome: 'succeeded', effect: null, detail: 'scripted write' },
        converged: false,
      },
    ];
  }

  it('a scripted HOST_TRANSIENT_UNAVAILABLE once → recovery re-enters the decider (history shows it), re-observe/re-act, step completes', async () => {
    const harness = createAgentHarness({ policy: { maxRecoveryCyclesPerStep: 4 } });
    const { host } = createScriptedQueueHost({
      nodes: harness.nodes,
      clock: harness.clock,
      keySeed: 'transient-host-ok',
      actScript: transientThenSuccess(),
      initialState: 'draft-v1',
    });

    const { decider, contexts } = createRecordingDecider((ctx) => {
      const sawTransient = ctx.history.some((record) => record.failureCode === 'HOST_TRANSIENT_UNAVAILABLE');
      const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      if (!wrote && !sawTransient) {
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: {
            observationId: ctx.observation.observationId,
            targetElementId: REPORT_PATH,
            targetDigest: ctx.observation.elements[0]?.digest ?? '',
          },
          parameters: { path: REPORT_PATH, content: 'FINAL' },
        };
      }
      if (!wrote && ctx.history.filter((record) => record.capability === 'filesystem.read' && record.ok).length < 2) {
        // re-observe after the transient failure (fresh reality first):
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      if (!wrote) {
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: {
            observationId: ctx.observation.observationId,
            targetElementId: REPORT_PATH,
            targetDigest: ctx.observation.elements[0]?.digest ?? '',
          },
          parameters: { path: REPORT_PATH, content: 'FINAL' },
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'filesystem.read', subject: REPORT_PATH, expect: { elementId: REPORT_PATH, state: 'FINAL' } },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // the decider SAW the transient failure in its history (the recovery
    // loop re-entered the decider with the failure record):
    const transientSeen = contexts.some((ctx) =>
      ctx.history.some((record) => record.failureCode === 'HOST_TRANSIENT_UNAVAILABLE'),
    );
    expect(transientSeen).toBe(true);
    // HOST_TRANSIENT_UNAVAILABLE → AGENT_HOST_TRANSIENT recoverable (mapping
    // proven by the completion: the recovery was allowed):
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.outcome).toBe('completed');
    // the full bounded loop: observe, failing act, re-observe, write, verify:
    expect(report.steps[0]?.actions).toBe(5);
  });

  it('maxRecoveryCyclesPerStep: 0 → the same transient failure fails the step with AGENT_HOST_TRANSIENT (honest bounded recovery)', async () => {
    const harness = createAgentHarness({ policy: { maxRecoveryCyclesPerStep: 0 } });
    const { host } = createScriptedQueueHost({
      nodes: harness.nodes,
      clock: harness.clock,
      keySeed: 'transient-host-noretry',
      actScript: transientThenSuccess(),
      initialState: 'draft-v1',
    });

    const { decider } = createRecordingDecider((ctx) => {
      const wrote = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      if (!wrote) {
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: {
            observationId: ctx.observation.observationId,
            targetElementId: REPORT_PATH,
            targetDigest: ctx.observation.elements[0]?.digest ?? '',
          },
          parameters: { path: REPORT_PATH, content: 'FINAL' },
        };
      }
      return {
        decision: 'complete',
        verify: { capability: 'filesystem.read', subject: REPORT_PATH, expect: { elementId: REPORT_PATH, state: 'FINAL' } },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // the transient failure is classified recoverable, but the recovery
    // BUDGET is zero → the step fails honestly with the typed code:
    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_HOST_TRANSIENT');
    expect(step?.failure?.recoverable).toBe(true);
    expect(step?.failure?.detail).toContain('scripted transient unavailability');
    expect(report.state).toBe('failed');
  });
});

describe('V2-008 failure recovery (classification mapping through runtime reports)', () => {
  it('HOST_TARGET_CHANGED → AGENT_TARGET_CHANGED (recoverable): with a zero recovery budget the classified failure reaches the step report', async () => {
    const harness = createAgentHarness({ policy: { maxRecoveryCyclesPerStep: 0 } });
    const environment = freshDesktopEnvironment();
    environment.externalWrite(REPORT_PATH, 'ORIGINAL');
    const { host } = harness.attachDesktopHost({ keySeed: 'target-changed-desktop', environment });

    const { decider } = createRecordingDecider((ctx) => {
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
      }
      // the environment races the target between observe and act (the host
      // will report HOST_TARGET_CHANGED with the actual digest):
      environment.externalWrite(REPORT_PATH, 'EXTERNAL-RACE');
      const target = ctx.observation.elements.find((element) => element.elementId === REPORT_PATH);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: {
          observationId: ctx.observation.observationId,
          targetElementId: REPORT_PATH,
          targetDigest: target?.digest ?? '',
        },
        parameters: { path: REPORT_PATH, content: 'AGENT-CONTENT' },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // the write invocation was recorded as FAILED (the effect is unknown —
    // never invented); the classified typed failure reaches the report:
    const failedCompletions = harness.recorderDouble.invocationCompletions.filter(
      (completion) => completion.outcome === 'failed',
    );
    expect(failedCompletions.length).toBe(1);
    // the runtime's step report carries the CLASSIFIED typed failure —
    // HOST_TARGET_CHANGED → AGENT_TARGET_CHANGED, recoverable — but the zero
    // recovery budget makes it terminal for this step (honest bounded loop):
    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_TARGET_CHANGED');
    expect(step?.failure?.recoverable).toBe(true);
    expect(step?.failure?.detail).toContain('changed');
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_TARGET_CHANGED');
    // the raced file was NOT clobbered (the classified failure is honest):
    expect(environment.readFile(REPORT_PATH)).toBe('EXTERNAL-RACE');
  });

  it('HOST_CAPABILITY_NOT_SUPPORTED → AGENT_HOST_PERMANENT: invoking a capability the host does not advertise fails the step fail-closed (never emulated)', async () => {
    const harness = createAgentHarness({ policy: { maxRecoveryCyclesPerStep: 4 } });
    const environment = freshDesktopEnvironment();
    // the host registers/advertises ONLY filesystem.read + filesystem.write
    // (the step's requirement set) — everything else is honestly unsupported:
    const { host, nodeId } = harness.attachDesktopHost({
      keySeed: 'unsupported-cap-desktop',
      environment,
      capabilities: [
        { name: 'filesystem.read', version: 1, availability: 'available' },
        { name: 'filesystem.write', version: 1, availability: 'available' },
      ],
    });

    // the decider invokes a canonical, ordinary capability the host does NOT
    // advertise (screen.observe is not sensitive — authorization passes; the
    // HOST boundary is what fires). The failure is NOT recoverable, so the
    // decider is never re-entered — the classification lands in the report:
    const { decider } = createRecordingDecider(() => ({
      decision: 'observe',
      capability: 'screen.observe',
      subject: 'screen',
    }));

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    const unsupportedSeen = harness.recorderDouble.invocationCompletions.some(
      (completion) => completion.outcome === 'failed',
    );
    expect(unsupportedSeen).toBe(true);
    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_HOST_PERMANENT');
    expect(step?.failure?.recoverable).toBe(false);
    // the classification carries the advertisement-is-not-authorization
    // honesty note verbatim:
    expect(step?.failure?.detail).toContain('does not advertise screen.observe');
    expect(step?.failure?.detail).toContain('never emulated');
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_HOST_PERMANENT');
    // the failed invocation was recorded honestly on the host's node:
    const failedCompletions = harness.recorderDouble.invocationCompletions.filter(
      (completion) => completion.outcome === 'failed',
    );
    expect(failedCompletions.length).toBe(1);
    expect(step?.nodeId).toBe(nodeId);
  });
});

describe('V2-008 failure recovery (action budget exhaustion)', () => {
  it('maxActionsPerStep: 2 with a never-completing decider → AGENT_MAX_ACTIONS_EXCEEDED, run failed (never invented completion)', async () => {
    const harness = createAgentHarness({ policy: { maxActionsPerStep: 2 } });
    const environment = freshDesktopEnvironment();
    environment.externalWrite(REPORT_PATH, 'draft-v1');
    const { host } = harness.attachDesktopHost({ keySeed: 'budget-desktop', environment });

    // the decider only ever observes — completion evidence never arrives:
    const { decider } = createRecordingDecider(() => ({
      decision: 'observe',
      capability: 'filesystem.read',
      subject: REPORT_PATH,
    }));

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_MAX_ACTIONS_EXCEEDED');
    expect(step?.failure?.detail).toContain('action budget exhausted');
    expect(report.state).toBe('failed');
    // honest: no completion was ever recorded for the step:
    expect(harness.recorderDouble.stepCompletions.filter((completion) => completion.outcome === 'succeeded')).toEqual([]);
    // the two allowed actions were both observations:
    expect(harness.recorderDouble.invocationRequests.map((request) => request.capability)).toEqual([
      'filesystem.read',
      'filesystem.read',
    ]);
  });
});
