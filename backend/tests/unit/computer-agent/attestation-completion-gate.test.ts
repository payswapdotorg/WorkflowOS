/**
 * V2-008 — attestation completion-boundary regressions (the ARCHITECT
 * BLOCKER correction on PR #142): `AgentAttestationPolicy.required` is a
 * COMPLETION GATE. A required-attestation failure (no attester key, an
 * independent V2-014 verification rejection, or a V2-005 attach rejection)
 * must NEVER leave a durably succeeded step and must NEVER let the walk
 * call completeRun().
 *
 * Covers the three deterministic negative cases (architect blocker,
 * required correction #4):
 *   (1) NO ATTESTER KEY — the host does not support the V2-014 contract
 *       while policy.attestation.required is true → typed
 *       AGENT_ATTESTATION_UNAVAILABLE, the step is durably FAILED (never
 *       succeeded), the run FAILS (completeRun never executed);
 *   (2) INDEPENDENT V2-014 VERIFICATION REJECTION — the attesting host
 *       signs, but the runtime's independent verifier rejects the
 *       attestation (trustedAttesterKeyIds: [] trusts nobody — fail-closed)
 *       → typed AGENT_ATTESTATION_REJECTED carrying the V2-014 typed code
 *       (ATTESTATION_ATTESTER_UNEXPECTED), the step is durably FAILED, the
 *       V2-005 boundary is never even asked (no attach command), the run
 *       FAILS;
 *   (3) V2-005 ATTACH REJECTION — the run boundary throws its typed
 *       rejection (WorkflowRunError RUN_ATTESTATION_REJECTED — the real
 *       boundary RAISES, never returns a value) → typed
 *       AGENT_ATTESTATION_REJECTED carrying the boundary code, the step is
 *       durably FAILED, no binding is recorded, the run FAILS.
 *
 * Determinism: injected ManualClock (the only clock), real Ed25519 key
 * material generated once at module scope (assertions never depend on key
 * bytes), fixed seeds/ids, no network, no Date API.
 */
import { describe, it, expect } from 'vitest';
import { generateAttesterKeyPair } from '../../../src/execution-attestation/index.js';
import {
  createAgentHarness,
  createRecordingDecider,
  freshDesktopEnvironment,
  WORKFLOW_INPUTS,
  PRINCIPAL,
  type RecorderDouble,
} from './helpers.js';
import type { RunExecutionReport } from '../../../src/computer-agent/index.js';

const REPORT_PATH = 'reports/summary.md';
const KEY = generateAttesterKeyPair();

/** The observe → grounded-write → verify-complete decider (the house shape). */
function createCompletingDecider(content: string) {
  return createRecordingDecider((ctx) => {
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
        parameters: { path: REPORT_PATH, content },
      };
    }
    return {
      decision: 'complete',
      verify: {
        capability: 'filesystem.read',
        subject: REPORT_PATH,
        expect: { elementId: REPORT_PATH, state: content },
      },
      outputs: { written: true },
    };
  }).decider;
}

/**
 * The blocker's negative invariant: the step is NOT succeeded and
 * completeRun() is prevented (the run fails honestly instead).
 */
function expectCompletionPrevented(
  recorderDouble: RecorderDouble,
  runId: string,
): void {
  // the step is NOT durably succeeded — it is durably FAILED:
  const succeeded = recorderDouble.stepCompletions.filter((completion) => completion.outcome === 'succeeded');
  expect(succeeded).toEqual([]);
  const failed = recorderDouble.stepCompletions.filter((completion) => completion.outcome === 'failed');
  expect(failed.length).toBe(1);
  // completeRun() was NEVER executed: no complete command, no completed state
  expect(recorderDouble.commands).not.toContain(`cmd-agent-${runId}-complete`);
  expect(recorderDouble.state()).toBe('failed');
}

function expectRunFailedWith(
  report: RunExecutionReport,
  code: string,
): void {
  expect(report.state).toBe('failed');
  expect(report.failure?.code).toBe(code);
  expect(report.pausedAtStepId).toBeNull();
  const step = report.steps[0];
  expect(step?.outcome).toBe('failed');
  expect(step?.failure?.code).toBe(code);
  expect(step?.attestationsAttached).toBe(0);
}

describe('V2-008 attestation completion boundary (required attestation is a completion gate)', () => {
  it('(1) no attester key + required policy → AGENT_ATTESTATION_UNAVAILABLE; the step never succeeds; the run fails; completeRun is prevented', async () => {
    const harness = createAgentHarness({ policy: { attestation: { required: true } } });
    const environment = freshDesktopEnvironment();
    // NO attesterKey: the host honestly reports unsupported attestation.
    const { host } = harness.attachDesktopHost({ keySeed: 'gate-no-key-desktop', environment });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider: createCompletingDecider('FINAL'),
      workflowInputs: WORKFLOW_INPUTS,
    });

    expectRunFailedWith(report, 'AGENT_ATTESTATION_UNAVAILABLE');
    expect(report.failure?.detail).toContain('does not support the V2-014 contract');
    expectCompletionPrevented(harness.recorderDouble, harness.runId);
    // no attach command ever reached the V2-005 boundary:
    expect(harness.recorderDouble.commands.some((command) => command.includes('-att-'))).toBe(false);
    expect(harness.recorderDouble.attestationAttachments).toEqual([]);
    // the required-policy failure is a typed failure — NOT an honest-absence
    // evidence record (absence records are the optional-policy path):
    expect(
      harness.recorderDouble.evidence.some((record) => record.description?.includes('attestation-absence') ?? false),
    ).toBe(false);
  });

  it('(2) independent V2-014 verification rejection (nobody trusted) → AGENT_ATTESTATION_REJECTED; the boundary is never asked; the run fails; completeRun is prevented', async () => {
    const harness = createAgentHarness({
      policy: {
        // the empty list trusts NOBODY (fail-closed) — the independent
        // verifier must reject the host's real, validly-signed attestation.
        attestation: { required: true, trustedAttesterKeyIds: [] },
      },
    });
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({
      keySeed: 'gate-untrusted-desktop',
      environment,
      attesterKey: KEY,
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider: createCompletingDecider('FINAL'),
      workflowInputs: WORKFLOW_INPUTS,
    });

    expectRunFailedWith(report, 'AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('ATTESTATION_ATTESTER_UNEXPECTED');
    expectCompletionPrevented(harness.recorderDouble, harness.runId);
    // rejected at the runtime's OWN independent verification — the V2-005
    // attach was never attempted (no attach command, no binding):
    expect(harness.recorderDouble.commands.some((command) => command.includes('-att-'))).toBe(false);
    expect(harness.recorderDouble.attestationAttachments).toEqual([]);
  });

  it('(3) V2-005 attach rejection (typed boundary throw) → AGENT_ATTESTATION_REJECTED; no binding; the run fails; completeRun is prevented', async () => {
    const harness = createAgentHarness({
      policy: { attestation: { required: true } },
      // the REAL V2-005 boundary RAISES its typed rejection (WorkflowRunError
      // RUN_ATTESTATION_REJECTED — never a returned value); the double
      // mirrors that exact discipline:
      attachAttestationRejection: {
        code: 'RUN_ATTESTATION_REJECTED',
        message:
          'attestation att-unit rejected at the run boundary — ATTESTATION_REPLAYED: the single-use nonce was already consumed',
      },
    });
    const environment = freshDesktopEnvironment();
    const { host } = harness.attachDesktopHost({
      keySeed: 'gate-attach-rejected-desktop',
      environment,
      attesterKey: KEY,
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider: createCompletingDecider('FINAL'),
      workflowInputs: WORKFLOW_INPUTS,
    });

    expectRunFailedWith(report, 'AGENT_ATTESTATION_REJECTED');
    expect(report.failure?.detail).toContain('RUN_ATTESTATION_REJECTED');
    expectCompletionPrevented(harness.recorderDouble, harness.runId);
    // the attach WAS attempted (the boundary claimed the command) and the
    // typed rejection surfaced through it — no binding was recorded:
    expect(harness.recorderDouble.commands.some((command) => command.includes('-att-'))).toBe(true);
    expect(harness.recorderDouble.attestationAttachments).toEqual([]);
  });
});
