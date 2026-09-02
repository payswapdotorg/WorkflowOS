/**
 * V2-008 — stale-observation regressions (grounding freshness: an act is
 * never dispatched on an observation older than the policy bound, and never
 * on an observation the runtime never received — fail-closed, re-observe
 * required).
 *
 * Covers the required regressions:
 *   - a decider grounds an act on an observation while the injected clock
 *     has advanced beyond `maxObservationAgeMs` → the act is NOT dispatched
 *     to the host; the decider's history contains an `AGENT_OBSERVATION_STALE`
 *     record; the runtime's bounded recovery re-enters the decider;
 *   - when the decider then re-observes and re-acts WITHIN the bound, the
 *     step completes;
 *   - grounding on an observationId the runtime never received (cross-drive
 *     observation) → the same stale discipline (not dispatched, stale record,
 *     recovery, then fresh re-observe/re-act completes).
 */
import { describe, it, expect } from 'vitest';
import type { AgentDecision, AgentDecisionContext } from '../../../src/computer-agent/index.js';
import {
  createAgentHarness,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
} from './helpers.js';

const REPORT_PATH = 'reports/summary.md';

type GroundingPlan = { observationId: string; targetElementId: string; targetDigest: string };

/**
 * The deterministic decider state machine: observe → (stale act) → re-observe
 * → fresh act → verify-complete. `staleGrounding` produces the FIRST act's
 * grounding (the stale/unknown one); the fresh act grounds on the
 * observation the re-observe produced. `afterStaleRejection` runs at the
 * moment the runtime re-enters the decider AFTER the stale act was rejected
 * (the assertion point for "the environment was untouched by the non-
 * dispatched act").
 */
function buildStaleDecider(
  staleGrounding: (context: AgentDecisionContext) => GroundingPlan,
  beforeStaleAct?: () => void,
  afterStaleRejection?: () => void,
) {
  let phase: 'observe' | 'staleAct' | 'reObserve' | 'freshAct' | 'complete' = 'observe';
  return createRecordingDecider((ctx): AgentDecision => {
    if (phase === 'observe') {
      phase = 'staleAct';
      return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
    }
    if (phase === 'staleAct') {
      phase = 'reObserve';
      beforeStaleAct?.();
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: staleGrounding(ctx),
        parameters: { path: REPORT_PATH, content: 'fresh-write' },
      };
    }
    if (phase === 'reObserve') {
      phase = 'freshAct';
      afterStaleRejection?.();
      return { decision: 'observe', capability: 'filesystem.read', subject: REPORT_PATH };
    }
    if (phase === 'freshAct') {
      phase = 'complete';
      const target = ctx.observation?.elements.find((element) => element.elementId === REPORT_PATH);
      return {
        decision: 'act',
        capability: 'filesystem.write',
        grounding: {
          observationId: ctx.observation?.observationId ?? '',
          targetElementId: REPORT_PATH,
          targetDigest: target?.digest ?? '',
        },
        parameters: { path: REPORT_PATH, content: 'fresh-write' },
      };
    }
    return {
      decision: 'complete',
      verify: { capability: 'filesystem.read', subject: REPORT_PATH, expect: { elementId: REPORT_PATH, state: 'fresh-write' } },
      outputs: { written: true },
    };
  });
}

describe('V2-008 stale-observation discipline (clock advanced beyond the bound)', () => {
  it('does NOT dispatch the stale act; records AGENT_OBSERVATION_STALE in the decider history; completes after a fresh re-observe/re-act', async () => {
    const harness = createAgentHarness({ policy: { maxObservationAgeMs: 30_000, maxRecoveryCyclesPerStep: 4 } });
    const environment = freshDesktopEnvironment();
    environment.externalWrite(REPORT_PATH, 'draft-v1');
    const { host } = harness.attachDesktopHost({ keySeed: 'stale-desktop-a', environment });
    let contentAfterStaleRejection: string | null = 'never-captured';

    const { decider, contexts } = buildStaleDecider(
      (ctx) => {
        const target = ctx.observation?.elements.find((element) => element.elementId === REPORT_PATH);
        return {
          observationId: ctx.observation?.observationId ?? '',
          targetElementId: REPORT_PATH,
          targetDigest: target?.digest ?? '',
        };
      },
      () => {
        // the agent dawdles: the injected clock advances BEYOND the bound
        // between the observation and the act (deterministic — the decider
        // script owns the manual clock advance):
        harness.clock.advance(45_000);
      },
      () => {
        // captured AT the re-entry after the stale rejection: the environment
        // file is UNCHANGED (the stale act was never dispatched to the host):
        contentAfterStaleRejection = environment.readFile(REPORT_PATH);
      },
    );

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // The stale act was recorded in the decider's history, NOT dispatched:
    const staleRecords = contexts.flatMap((ctx) => ctx.history).filter((record) => record.failureCode === 'AGENT_OBSERVATION_STALE');
    expect(staleRecords.length).toBeGreaterThan(0);
    expect(staleRecords[0]?.invocationId).toBe('not-dispatched');
    expect(staleRecords[0]?.detail).toContain('re-observe');
    // exactly ONE write was ever dispatched to the host (the fresh one):
    const dispatchedWrites = harness.recorderDouble.invocationRequests.filter(
      (request) => request.capability === 'filesystem.write',
    );
    expect(dispatchedWrites.length).toBe(1);
    // the environment file was UNCHANGED at the moment of the stale
    // rejection (the non-dispatched act touched nothing):
    expect(contentAfterStaleRejection).toBe('draft-v1');
    // the fresh re-observe/re-act completes the step within the bound:
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.outcome).toBe('completed');
    expect(report.steps[0]?.observations).toBeGreaterThanOrEqual(2);
    expect(environment.readFile(REPORT_PATH)).toBe('fresh-write');
  });
});

describe('V2-008 stale-observation discipline (cross-drive: an observation the runtime never received)', () => {
  it('grounding on an unknown observationId is treated with the SAME stale discipline (no dispatch, stale record, recovery, then completes)', async () => {
    const harness = createAgentHarness({ policy: { maxObservationAgeMs: 30_000, maxRecoveryCyclesPerStep: 4 } });
    const environment = freshDesktopEnvironment();
    environment.externalWrite(REPORT_PATH, 'draft-v1');
    const { host } = harness.attachDesktopHost({ keySeed: 'stale-desktop-cross', environment });

    const { decider, contexts } = buildStaleDecider((ctx) => {
      // a cross-drive grounding: an observationId from a DIFFERENT drive
      // (this runtime never received it — its observation memory has no such
      // id). No clock advance needed: unknown ⇒ stale.
      const target = ctx.observation?.elements.find((element) => element.elementId === REPORT_PATH);
      return {
        observationId: 'obs-from-another-drive-9999',
        targetElementId: REPORT_PATH,
        targetDigest: target?.digest ?? '',
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    const staleRecords = contexts.flatMap((ctx) => ctx.history).filter((record) => record.failureCode === 'AGENT_OBSERVATION_STALE');
    expect(staleRecords.length).toBeGreaterThan(0);
    expect(staleRecords[0]?.invocationId).toBe('not-dispatched');
    const dispatchedWrites = harness.recorderDouble.invocationRequests.filter(
      (request) => request.capability === 'filesystem.write',
    );
    expect(dispatchedWrites.length).toBe(1);
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.outcome).toBe('completed');
    expect(environment.readFile(REPORT_PATH)).toBe('fresh-write');
  });
});
