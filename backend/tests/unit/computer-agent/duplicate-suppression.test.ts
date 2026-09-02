/**
 * V2-008 — duplicate-action suppression regressions (at-most-once host
 * discipline; constitution §7 evidence truth + registry quality rule
 * "duplicate action suppression where required").
 *
 * Covers the required regressions:
 *   - `HostInvocationLedger` directly: same invocationId + same act request
 *     twice → the second returns the RECORDED result with `converged: true`
 *     and the effectful function executed EXACTLY ONCE;
 *   - through a `DesktopHostAdapter`: the environment file is written exactly
 *     once (a converged re-delivery with DIFFERENT parameters never
 *     re-executes — content unchanged after the second call);
 *   - observe requests are READS: the same invocationId twice executes FRESH
 *     both times (different observationIds — an observation frozen by
 *     convergence would ground acts on stale state);
 *   - different invocationIds both execute (no cross-invocation suppression);
 *   - a FAILED act result is also frozen in the ledger (a re-drive never
 *     re-executes a failed effect either — the outcome is unknown until
 *     re-observed, and the host never guesses).
 */
import { describe, it, expect } from 'vitest';
import {
  HostInvocationLedger,
  DesktopHostAdapter,
  ScriptedDesktopEnvironment,
} from '../../../src/computer-agent/index.js';
import type { HostInvocationResult } from '../../../src/computer-agent/index.js';
import { createManualClock } from './helpers.js';

const NO_ATTESTATION = { supported: false as const, reason: 'no-attester-key' as const };

describe('V2-008 duplicate-action suppression (HostInvocationLedger directly)', () => {
  it('executes the effect exactly once per invocationId; the re-delivery converges on the recorded result', async () => {
    const ledger = new HostInvocationLedger();
    let executions = 0;
    const effect = async (): Promise<HostInvocationResult> => {
      executions += 1;
      return { ok: true, kind: 'acted', outcome: { outcome: 'succeeded', effect: null, detail: 'written' }, converged: false };
    };
    const first = await ledger.executeAct('inv-write-1', effect);
    const second = await ledger.executeAct('inv-write-1', effect);
    expect(executions).toBe(1);
    expect(ledger.size).toBe(1);
    if (first.ok) {
      expect(first.converged).toBe(false);
    }
    if (second.ok) {
      expect(second.converged).toBe(true);
    }
    if (second.ok && second.kind === 'acted') {
      expect(second.outcome.detail).toBe('written'); // the recorded result, verbatim
    }
  });

  it('freezes a FAILED act result too (the re-drive never re-executes a failed effect)', async () => {
    const ledger = new HostInvocationLedger();
    let executions = 0;
    const effect = async (): Promise<HostInvocationResult> => {
      executions += 1;
      return { ok: false, failure: { code: 'HOST_ENVIRONMENT_ERROR', detail: 'scripted failure' } };
    };
    const first = await ledger.executeAct('inv-fail-1', effect);
    const second = await ledger.executeAct('inv-fail-1', effect);
    expect(executions).toBe(1);
    expect(first).toEqual(second);
    expect(ledger.size).toBe(1);
  });

  it('different invocationIds are different ledger entries — both execute', async () => {
    const ledger = new HostInvocationLedger();
    let executions = 0;
    const effect = async (): Promise<HostInvocationResult> => {
      executions += 1;
      return { ok: true, kind: 'acted', outcome: { outcome: 'succeeded', effect: null, detail: `write-${executions}` }, converged: false };
    };
    const first = await ledger.executeAct('inv-a', effect);
    const second = await ledger.executeAct('inv-b', effect);
    expect(executions).toBe(2);
    if (first.ok) {
      expect(first.converged).toBe(false);
    }
    if (second.ok) {
      expect(second.converged).toBe(false);
    }
    expect(ledger.size).toBe(2);
  });
});

describe('V2-008 duplicate-action suppression (through the DesktopHostAdapter)', () => {
  function desktopFixture() {
    const clock = createManualClock(1_788_264_000_000);
    const environment = new ScriptedDesktopEnvironment({
      directories: ['reports'],
      files: [{ path: 'reports/summary.md', content: 'v0' }],
    });
    const host = new DesktopHostAdapter({
      nodeId: 'node-unit-desktop',
      sessionToken: 'session-unit-desktop',
      clock: () => clock.now(),
      attestation: NO_ATTESTATION,
      environment,
    });
    return { host, environment };
  }

  it('same invocationId twice → converged recorded result, file written EXACTLY once (no clobber-by-redelivery)', async () => {
    const { host, environment } = desktopFixture();
    const observe = await host.invoke('inv-obs-1', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    expect(observe.ok).toBe(true);
    if (!observe.ok || observe.kind !== 'observed') throw new Error('observe failed');
    const element = observe.observation.elements[0];
    expect(element).toBeDefined();

    const first = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: { observationId: observe.observation.observationId, targetElementId: 'reports/summary.md', targetDigest: element?.digest ?? '' },
      parameters: { path: 'reports/summary.md', content: 'A' },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.converged).toBe(false);
    }
    expect(environment.readFile('reports/summary.md')).toBe('A');

    // the re-delivery of the SAME invocation id requests DIFFERENT content:
    // convergence means the recorded result (and the recorded effect) — the
    // file is never written a second time.
    const second = await host.invoke('inv-write-1', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: { observationId: observe.observation.observationId, targetElementId: 'reports/summary.md', targetDigest: element?.digest ?? '' },
      parameters: { path: 'reports/summary.md', content: 'B' },
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.converged).toBe(true);
    }
    expect(environment.readFile('reports/summary.md')).toBe('A');
    if (second.ok && second.kind === 'acted' && first.ok && first.kind === 'acted') {
      expect(second.outcome.detail).toBe(first.outcome.detail);
    }
  });

  it('observe requests with the SAME invocationId execute fresh both times (reads are never ledger-frozen)', async () => {
    const { host, environment } = desktopFixture();
    const first = await host.invoke('inv-obs-same', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    // the file changes between the two observations of the same id
    environment.externalWrite('reports/summary.md', 'v1');
    const second = await host.invoke('inv-obs-same', { kind: 'observe', capability: 'filesystem.read', subject: 'reports/summary.md' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || first.kind !== 'observed') throw new Error('first observe failed');
    if (!second.ok || second.kind !== 'observed') throw new Error('second observe failed');
    expect(first.observation.observationId).not.toBe(second.observation.observationId);
    // the second observation reflects CURRENT reality (fresh read, not a
    // converged replay of the first)
    expect(second.observation.elements[0]?.state).toBe('v1');
    expect(first.observation.elements[0]?.state).toBe('v0');
  });

  it('different invocationIds both execute (fresh write each)', async () => {
    const { host, environment } = desktopFixture();
    const first = await host.invoke('inv-write-x', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: null,
      parameters: { path: 'reports/summary.md', content: 'X' },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.converged).toBe(false);
    }
    const second = await host.invoke('inv-write-y', {
      kind: 'act',
      capability: 'filesystem.write',
      grounding: null,
      parameters: { path: 'reports/summary.md', content: 'Y' },
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.converged).toBe(false);
    }
    expect(environment.readFile('reports/summary.md')).toBe('Y');
  });
});
