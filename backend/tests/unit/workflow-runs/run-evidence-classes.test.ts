/**
 * V2-005 — evidence truth semantics (constitution §7): the five registry
 * evidence classes are DISTINCT; classes never impersonate one another;
 * provenance is REQUIRED; a claim is never verification.
 */
import { describe, it, expect } from 'vitest';
import {
  RUN_EVIDENCE_CLASSES,
  WorkflowRunError,
} from '../../../src/workflow-runs/index.js';
import {
  assertRunEvidenceClass,
  assertRunEvidenceProducer,
  assertRunCapabilityName,
  assertRunExecutionClass,
  assertRunCommitmentList,
  evidenceTimelineEventName,
} from '../../../src/workflow-runs/internal/run-validation.js';

describe('V2-005 — evidence class separation + provenance (pure validation)', () => {
  it('the five registry evidence classes are the closed vocabulary', () => {
    expect([...RUN_EVIDENCE_CLASSES]).toEqual([
      'intent',
      'observation',
      'claim',
      'verification',
      'human_confirmation',
    ]);
  });

  it('wrong-class recording is typed-rejected (fail-closed, never coerced)', () => {
    for (const bad of ['obseravtion', 'Observation', 'proof', 'attestation', 'output', '', 'evidence']) {
      try {
        assertRunEvidenceClass(bad);
        expect.unreachable(`class "${bad}" must be rejected`);
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_EVIDENCE_CLASS_INVALID');
      }
    }
    for (const good of RUN_EVIDENCE_CLASSES) {
      expect(() => assertRunEvidenceClass(good)).not.toThrow();
    }
  });

  it('provenance-less recording is typed-rejected (producer kind + id REQUIRED)', () => {
    expect(() => assertRunEvidenceProducer({ producerKind: 'executor', producerId: 'host-1' })).not.toThrow();
    for (const bad of [
      { producerKind: '', producerId: 'host-1' },
      { producerKind: 'executor', producerId: '' },
      { producerKind: '   ', producerId: 'x' },
    ]) {
      try {
        assertRunEvidenceProducer(bad);
        expect.unreachable('missing provenance must be rejected');
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_EVIDENCE_PRODUCER_REQUIRED');
      }
    }
  });

  it('classes never impersonate one another: verification ≠ observation ≠ claim', () => {
    // The three execution-facing classes map to DISTINCT protocol timeline
    // projections — observation evidence projects the registry
    // observation.recorded event, verification evidence projects
    // verification.completed; claim/intent/human_confirmation have NO registry
    // event (they are evidence records, not protocol events).
    expect(evidenceTimelineEventName('observation')).toBe('observation.recorded');
    expect(evidenceTimelineEventName('verification')).toBe('verification.completed');
    expect(evidenceTimelineEventName('claim')).toBeNull();
    expect(evidenceTimelineEventName('intent')).toBeNull();
    expect(evidenceTimelineEventName('human_confirmation')).toBeNull();
  });

  it('a claim can never be recorded as verification by the mapping', () => {
    const claimEvent = evidenceTimelineEventName('claim');
    expect(claimEvent).not.toBe('verification.completed');
    expect(claimEvent).not.toBe('observation.recorded');
  });
});

describe('V2-005 — canonical vocabulary validation (registry anti-drift)', () => {
  it('capability invocations use canonical registry capability names VERBATIM', () => {
    for (const good of [
      'workflow.execute',
      'workflow.pause',
      'workflow.resume',
      'workflow.cancel',
      'workflow.observe',
      'messaging.send',
      'github.repository.read',
      'filesystem.write',
      'browser.navigate',
    ]) {
      expect(() => assertRunCapabilityName(good)).not.toThrow();
    }
    // aliases / near-misses / platform-specific mutations are typed-rejected
    for (const bad of [
      'messaging.send.v2',
      'messages.send',
      'calls.answer',
      'github.read_repo',
      'browser.observe.v2',
      'chrome.tabs.navigate',
      'Workflow.Execute',
      '',
    ]) {
      try {
        assertRunCapabilityName(bad);
        expect.unreachable(`capability "${bad}" must be rejected as non-canonical`);
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_CAPABILITY_NON_CANONICAL');
      }
    }
  });

  it('execution classes are the four canonical registry identifiers', () => {
    for (const good of ['deterministic_api', 'agentic_computer_use', 'human', 'subworkflow']) {
      expect(() => assertRunExecutionClass(good)).not.toThrow();
    }
    for (const bad of ['api', 'computer_use', 'agentic', 'model', 'auto', '']) {
      try {
        assertRunExecutionClass(bad);
        expect.unreachable(`execution class "${bad}" must be rejected`);
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_EXECUTION_CLASS_INVALID');
      }
    }
  });

  it('commitment lists must be sha-256 hex values (never raw secret payloads)', () => {
    const ok = '6a1b31c7a2f04d0c5b8e4c2f6c9d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f809';
    expect(() => assertRunCommitmentList([ok])).not.toThrow();
    expect(() => assertRunCommitmentList([])).not.toThrow();
    for (const bad of ['not-hex', ok.toUpperCase(), `${ok}0`, 'secret-bot-token-value']) {
      try {
        assertRunCommitmentList([bad]);
        expect.unreachable(`commitment "${bad}" must be rejected`);
      } catch (err) {
        expect((err as WorkflowRunError).code).toBe('RUN_INVALID_INPUT_COMMITMENTS');
      }
    }
  });
});
