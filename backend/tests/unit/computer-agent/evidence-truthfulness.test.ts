/**
 * V2-008 — evidence-truthfulness regressions (THE core: constitution §7 —
 * a model/host statement is NEVER evidence of a side effect; a step
 * completes ONLY on the runtime's own verification observation).
 *
 * Covers the required regressions:
 *   - a decider that claims `complete` with a verify.expect that does NOT
 *     match the actual file content → the step does NOT complete (no
 *     recordStepCompleted with 'succeeded'); the runtime continues the loop;
 *     at the action bound the step fails AGENT_COMPLETION_UNVERIFIED; the
 *     recorder's evidence log contains an observation-class
 *     'completion claim did not verify' record;
 *   - the positive path: a matching expectation → the step completes with
 *     the verify observation recorded;
 *   - the host's 'claim' evidence class is recorded for acts, but the step
 *     NEVER completes on the claim alone — only on the verify observation.
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

describe('V2-008 evidence truthfulness (a claim that does not verify never completes the step)', () => {
  it('claims complete with a WRONG expectation → no completion, honest unverified records, AGENT_COMPLETION_UNVERIFIED at the bound', async () => {
    const harness = createAgentHarness({ policy: { maxActionsPerStep: 4 } });
    const environment = freshDesktopEnvironment();
    const { host, nodeId } = harness.attachDesktopHost({ keySeed: 'unverified-desktop', environment });

    const { decider, contexts } = createRecordingDecider((ctx) => {
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
          parameters: { path: REPORT_PATH, content: 'ACTUAL-CONTENT' },
        };
      }
      // the agent CLAIMS completion, but its expectation does NOT match the
      // actual file content (the file really holds 'ACTUAL-CONTENT'):
      return {
        decision: 'complete',
        verify: {
          capability: 'filesystem.read',
          subject: REPORT_PATH,
          expect: { elementId: REPORT_PATH, state: 'CLAIMED-BUT-WRONG' },
        },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // The step did NOT complete: no succeeded step completion was recorded.
    expect(harness.recorderDouble.stepCompletions.filter((completion) => completion.outcome === 'succeeded')).toEqual([]);
    // The act itself DID happen (the host claim + the real file):
    expect(environment.readFile(REPORT_PATH)).toBe('ACTUAL-CONTENT');
    const claimRecords = harness.recorderDouble.evidence.filter((record) => record.evidenceClass === 'claim');
    expect(claimRecords.length).toBe(1);
    expect(claimRecords[0]?.producerKind).toBe('computer_host');
    expect(claimRecords[0]?.producerId).toBe(nodeId);
    // The honest unverified records: one per repeated wrong claim:
    const unverified = harness.recorderDouble.evidence.filter(
      (record) => record.description === 'completion claim did not verify against the verification observation',
    );
    expect(unverified.length).toBe(2);
    for (const record of unverified) {
      expect(record.evidenceClass).toBe('observation');
      expect(record.producerKind).toBe('computer_agent');
    }
    // The decider saw the typed failure code in its history (loop continued):
    const unverifiedSeen = contexts.some((ctx) =>
      ctx.history.some((record) => record.failureCode === 'AGENT_COMPLETION_UNVERIFIED'),
    );
    expect(unverifiedSeen).toBe(true);
    // At the action bound: honest typed failure, run failed:
    const step = report.steps[0];
    expect(step?.outcome).toBe('failed');
    expect(step?.failure?.code).toBe('AGENT_COMPLETION_UNVERIFIED');
    expect(report.state).toBe('failed');
    expect(report.failure?.code).toBe('AGENT_COMPLETION_UNVERIFIED');
  });
});

describe('V2-008 evidence truthfulness (completion only on the runtime\'s verification observation)', () => {
  it('a matching expectation → completed, with the verify observation recorded; NEVER on the claim alone', async () => {
    const harness = createAgentHarness({ policy: { maxActionsPerStep: 8 } });
    const environment = freshDesktopEnvironment();
    const { host, nodeId } = harness.attachDesktopHost({ keySeed: 'verified-desktop', environment });

    // capture the recorder state AT THE MOMENT of the complete decision —
    // after the successful act (claim) but before the verification:
    const completionsWhenCompleting: number[] = [];
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
      completionsWhenCompleting.push(harness.recorderDouble.stepCompletions.length);
      return {
        decision: 'complete',
        verify: {
          capability: 'filesystem.read',
          subject: REPORT_PATH,
          expect: { elementId: REPORT_PATH, state: 'FINAL' },
        },
        outputs: { written: true },
      };
    });

    const report = await harness.runtime.executeRun(PRINCIPAL, {
      runId: harness.runId,
      hosts: [host],
      decider,
      workflowInputs: WORKFLOW_INPUTS,
    });

    // AFTER the successful act (the host's claim), the step had NOT completed:
    expect(completionsWhenCompleting).toEqual([0]);
    // The claim is recorded for the act (host producer):
    const claimRecords = harness.recorderDouble.evidence.filter((record) => record.evidenceClass === 'claim');
    expect(claimRecords.length).toBe(1);
    expect(claimRecords[0]?.producerKind).toBe('computer_host');
    expect(claimRecords[0]?.producerId).toBe(nodeId);
    // The verify observation is recorded (the completion evidence):
    const verifyObservations = harness.recorderDouble.evidence.filter(
      (record) =>
        record.evidenceClass === 'observation' &&
        record.description === `observation of ${REPORT_PATH} via filesystem.read`,
    );
    expect(verifyObservations.length).toBeGreaterThanOrEqual(1);
    expect(verifyObservations[0]?.producerId).toBe(nodeId);
    // Exactly ONE succeeded step completion — only after verification:
    const succeeded = harness.recorderDouble.stepCompletions.filter((completion) => completion.outcome === 'succeeded');
    expect(succeeded.length).toBe(1);
    expect(succeeded[0]?.stepId).toBe(harness.stepId);
    expect(succeeded[0]?.outcome).toBe('succeeded');
    expect(report.state).toBe('completed');
    expect(report.steps[0]?.outcome).toBe('completed');
    expect(environment.readFile(REPORT_PATH)).toBe('FINAL');
  });
});
