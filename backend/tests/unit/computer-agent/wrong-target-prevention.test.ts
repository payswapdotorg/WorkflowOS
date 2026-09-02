/**
 * V2-008 — wrong-target prevention regressions (grounding discipline:
 * a grounded act fails closed on ANY target change — never silent
 * re-targeting, never clobbering).
 *
 * Covers the required regressions:
 *   - (a) desktop: decider observes a file, the environment changes it
 *     externally between observe and act → HOST_TARGET_CHANGED with
 *     `actualDigest` set, the file NOT clobbered; the decider re-observes
 *     (sees the real content) and acts on a NEW path → the step completes
 *     through the REAL runtime;
 *   - (b) browser: `ScriptedBrowserEnvironment.mutateElement` between observe
 *     and `browser.click` → HOST_TARGET_CHANGED, element state unchanged;
 *   - (c) browser: `removeElement` between observe and click →
 *     HOST_TARGET_NOT_FOUND;
 *   - (d) filesystem ABSENT-target discipline: observe an absent file
 *     (digest === FILE_ABSENT_DIGEST); an external creation before the
 *     grounded write → HOST_TARGET_CHANGED (no clobber); still absent → the
 *     write proceeds (digest equality on the absent state).
 */
import { describe, it, expect } from 'vitest';
import {
  DesktopHostAdapter,
  WebBrowserHostAdapter,
  ScriptedDesktopEnvironment,
  ScriptedBrowserEnvironment,
  FILE_ABSENT_DIGEST,
} from '../../../src/computer-agent/index.js';
import type { HostInvocationResult, ActionGrounding } from '../../../src/computer-agent/index.js';
import {
  createAgentHarness,
  createManualClock,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
} from './helpers.js';

const NO_ATTESTATION = { supported: false as const, reason: 'no-attester-key' as const };
const CLOCK = createManualClock(1_788_264_000_000);

function expectHostFailure(result: HostInvocationResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.failure.code).toBe(code);
  }
}

describe('V2-008 wrong-target prevention (desktop, adapter-level)', () => {
  it('(a-pre) an externally changed file rejects the grounded write with actualDigest set and NO clobber', async () => {
    const environment = new ScriptedDesktopEnvironment({
      directories: ['reports'],
      files: [{ path: 'reports/summary.md', content: 'ORIGINAL' }],
    });
    const host = new DesktopHostAdapter({
      nodeId: 'node-unit-desktop',
      sessionToken: 'session-unit-desktop',
      clock: () => CLOCK.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    const element = observe.observation.elements[0];
    expect(element?.state).toBe('ORIGINAL');

    // the environment changes the target between observe and act:
    environment.externalWrite('reports/summary.md', 'CHANGED-EXTERNALLY');

    const grounding: ActionGrounding = {
      observationId: observe.observation.observationId,
      targetElementId: 'reports/summary.md',
      targetDigest: element?.digest ?? '',
    };
    const act = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding,
      parameters: { path: 'reports/summary.md', content: 'AGENT-WRITE' },
    });
    expectHostFailure(act, 'HOST_TARGET_CHANGED');
    if (!act.ok) {
      expect(act.failure.actualDigest).toBeDefined();
      expect(act.failure.actualDigest).not.toBe(element?.digest);
    }
    // NO clobber: the environment content is the external writer's bytes
    expect(environment.readFile('reports/summary.md')).toBe('CHANGED-EXTERNALLY');
  });

  it('(a-pre) a fresh observation of the changed file grounds a write on a NEW path', async () => {
    const environment = new ScriptedDesktopEnvironment({
      directories: ['reports'],
      files: [{ path: 'reports/summary.md', content: 'ORIGINAL' }],
    });
    const host = new DesktopHostAdapter({
      nodeId: 'node-unit-desktop',
      sessionToken: 'session-unit-desktop',
      clock: () => CLOCK.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    const firstObserve = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    environment.externalWrite('reports/summary.md', 'CHANGED-EXTERNALLY');
    // the stale-grounded act is rejected (as above)…
    if (!firstObserve.ok || firstObserve.kind !== 'observed') throw new Error('observe failed');
    const stale = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: {
        observationId: firstObserve.observation.observationId,
        targetElementId: 'reports/summary.md',
        targetDigest: firstObserve.observation.elements[0]?.digest ?? '',
      },
      parameters: { path: 'reports/summary.md', content: 'AGENT-WRITE' },
    });
    expectHostFailure(stale, 'HOST_TARGET_CHANGED');
    // …the decider re-observes (fresh reality)…
    const reObserve = await host.invoke('inv-obs-2', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    expect(reObserve.ok).toBe(true);
    if (!reObserve.ok || reObserve.kind !== 'observed') throw new Error('re-observe failed');
    expect(reObserve.observation.elements[0]?.state).toBe('CHANGED-EXTERNALLY');
    // …and acts on a NEW path (the changed file is left alone):
    const fresh = await host.invoke('inv-write-2', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: null,
      parameters: { path: 'reports/final.md', content: 'FINAL' },
    });
    expect(fresh.ok).toBe(true);
    expect(environment.readFile('reports/final.md')).toBe('FINAL');
    expect(environment.readFile('reports/summary.md')).toBe('CHANGED-EXTERNALLY');
  });
});

describe('V2-008 wrong-target prevention (desktop, through the REAL runtime)', () => {
  it('(a) decider observes → env races the file → grounded act fails HOST_TARGET_CHANGED → re-observe → act on a NEW path → completes', async () => {
    const harness = createAgentHarness({});
    const environment = freshDesktopEnvironment();
    environment.externalWrite('reports/summary.md', 'ORIGINAL');
    const { host } = harness.attachDesktopHost({ keySeed: 'wrong-target-desktop', environment });
    const reportPath = 'reports/summary.md';

    const { decider, contexts } = createRecordingDecider((ctx) => {
      const sawTargetChanged = ctx.history.some((record) => record.failureCode === 'HOST_TARGET_CHANGED');
      const writeSucceeded = ctx.history.some((record) => record.capability === 'filesystem.write' && record.ok);
      if (ctx.observation === null) {
        return { decision: 'observe', capability: 'filesystem.read', subject: reportPath };
      }
      if (writeSucceeded) {
        // verify the NEW path's real content → completion evidence:
        return {
          decision: 'complete',
          verify: { capability: 'filesystem.read', subject: 'reports/final.md', expect: { elementId: 'reports/final.md', state: 'FINAL' } },
          outputs: { written: true },
        };
      }
      if (!sawTargetChanged) {
        // the environment races the target between observe and act:
        environment.externalWrite(reportPath, 'EXTERNAL-RACE');
        const target = ctx.observation.elements.find((element) => element.elementId === reportPath);
        return {
          decision: 'act',
          capability: 'filesystem.write',
          grounding: {
            observationId: ctx.observation.observationId,
            targetElementId: reportPath,
            targetDigest: target?.digest ?? '',
          },
          parameters: { path: reportPath, content: 'AGENT-CONTENT' },
        };
      }
      if (!ctx.observation.elements.some((element) => element.elementId === reportPath && element.state === 'EXTERNAL-RACE')) {
        // re-observe: the fresh observation must show the REAL (raced) content
        return { decision: 'observe', capability: 'filesystem.read', subject: reportPath };
      }
      // the raced file is left alone — write a NEW path instead:
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: null,
        parameters: { path: 'reports/final.md', content: 'FINAL' },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // The decider observed the HOST_TARGET_CHANGED failure in its history
    // (the runtime re-entered the loop with the failure record — recoverable):
    const targetChangedSeen = contexts.some((ctx) =>
      ctx.history.some((record) => record.failureCode === 'HOST_TARGET_CHANGED'),
    );
    expect(targetChangedSeen).toBe(true);
    // The raced file was NOT clobbered by the agent:
    expect(environment.readFile('reports/summary.md')).toBe('EXTERNAL-RACE');
    // The honest recovery completes the step on the NEW path:
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.outcome).toBe('completed');
    expect(report.steps[0]?.failure).toBeNull();
    expect(environment.readFile('reports/final.md')).toBe('FINAL');
  });
});

describe('V2-008 wrong-target prevention (browser)', () => {
  function browserFixture() {
    const environment = new ScriptedBrowserEnvironment([
      {
        url: 'https://unit.example/form',
        elements: [
          { elementId: 'btn-submit', kind: 'button' as const, label: 'Submit', state: 'enabled' },
          { elementId: 'input-name', kind: 'input' as const, label: 'Name', state: '' },
        ],
      },
    ]);
    const host = new WebBrowserHostAdapter({
      nodeId: 'node-unit-web',
      sessionToken: 'session-unit-web',
      clock: () => CLOCK.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    return { host, environment };
  }

  it('(b) mutateElement between observe and browser.click → HOST_TARGET_CHANGED, element state unchanged', async () => {
    const { host, environment } = browserFixture();
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'browser.observe', subject: 'https://unit.example/form' });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    const button = observe.observation.elements.find((element) => element.elementId === 'btn-submit');
    expect(button?.state).toBe('enabled');

    environment.mutateElement('btn-submit', 'disabled-by-race');

    const click = await host.invoke('inv-click-1', {
      kind: 'act',
      capability: 'browser.click',
      grounding: { observationId: observe.observation.observationId, targetElementId: 'btn-submit', targetDigest: button?.digest ?? '' },
      parameters: {},
    });
    expectHostFailure(click, 'HOST_TARGET_CHANGED');
    if (!click.ok) {
      expect(click.failure.actualDigest).toBeDefined();
    }
    // the element was NOT clicked (state unchanged from the external mutation)
    const after = environment.snapshot().find((element) => element.elementId === 'btn-submit');
    expect(after?.state).toBe('disabled-by-race');
  });

  it('(c) removeElement between observe and browser.click → HOST_TARGET_NOT_FOUND', async () => {
    const { host, environment } = browserFixture();
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'browser.observe', subject: 'https://unit.example/form' });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    const button = observe.observation.elements.find((element) => element.elementId === 'btn-submit');

    environment.removeElement('btn-submit');

    const click = await host.invoke('inv-click-1', {
      kind: 'act',
      capability: 'browser.click',
      grounding: { observationId: observe.observation.observationId, targetElementId: 'btn-submit', targetDigest: button?.digest ?? '' },
      parameters: {},
    });
    expectHostFailure(click, 'HOST_TARGET_NOT_FOUND');
    // the element stays gone (nothing was acted upon)
    expect(environment.snapshot().find((element) => element.elementId === 'btn-submit')).toBeUndefined();
  });
});

describe('V2-008 wrong-target prevention (filesystem ABSENT-target discipline)', () => {
  it('(d) observe absent (FILE_ABSENT_DIGEST) → external creation before the grounded write → HOST_TARGET_CHANGED, no clobber', async () => {
    const environment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const host = new DesktopHostAdapter({
      nodeId: 'node-unit-desktop',
      sessionToken: 'session-unit-desktop',
      clock: () => CLOCK.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    const target = 'reports/new-file.md';
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'filesystem.read', subject: target });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    const element = observe.observation.elements[0];
    expect(element?.digest).toBe(FILE_ABSENT_DIGEST);

    // the target is created externally AFTER the observation:
    environment.externalWrite(target, 'CREATED-EXTERNALLY');

    const write = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: { observationId: observe.observation.observationId, targetElementId: target, targetDigest: FILE_ABSENT_DIGEST },
      parameters: { path: target, content: 'MINE' },
    });
    expectHostFailure(write, 'HOST_TARGET_CHANGED');
    if (!write.ok) {
      // the audit digest is the digest of the file that now EXISTS:
      expect(write.failure.actualDigest).toBeDefined();
      expect(write.failure.actualDigest).not.toBe(FILE_ABSENT_DIGEST);
    }
    // no clobber: the external writer's bytes survive
    expect(environment.readFile(target)).toBe('CREATED-EXTERNALLY');
  });

  it('(d) still absent → the grounded write proceeds (digest equality on the absent state)', async () => {
    const environment = new ScriptedDesktopEnvironment({ directories: ['reports'] });
    const host = new DesktopHostAdapter({
      nodeId: 'node-unit-desktop',
      sessionToken: 'session-unit-desktop',
      clock: () => CLOCK.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    const target = 'reports/new-file.md';
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'filesystem.read', subject: target });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    expect(observe.observation.elements[0]?.digest).toBe(FILE_ABSENT_DIGEST);

    // the target is STILL absent at act time → the write proceeds:
    const write = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: { observationId: observe.observation.observationId, targetElementId: target, targetDigest: FILE_ABSENT_DIGEST },
      parameters: { path: target, content: 'MINE' },
    });
    expect(write.ok).toBe(true);
    expect(environment.readFile(target)).toBe('MINE');
  });
});
