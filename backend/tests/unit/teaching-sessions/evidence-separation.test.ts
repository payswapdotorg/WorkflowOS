import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TEACHING_EVIDENCE_CLASS,
  TEACHING_EVIDENCE_KINDS,
  type TeachingEvidenceRecord,
} from '../../../src/teaching-sessions/index.js';
import {
  teachThrough,
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
} from './helpers.js';
import { WORKFLOW_IR_REGISTRY_VOCABULARY } from '../../../src/workflow-ir/index.js';

/**
 * V2-006 — EVIDENCE SEPARATION (required regression).
 *
 * Teaching evidence (checkpoint confirmations, practice results, assessment
 * outcomes) is a DISTINCT, explicitly-typed evidence concept. It is never
 * conflated with the registry's execution completion-evidence classes, with
 * any run concept, or with any workflow-version digest.
 */
const REGISTRY_PATH = fileURLToPath(
  new URL('../../../../spec/architecture/v2/V2-CTRL-003-protocol-registry.json', import.meta.url),
);

describe('V2-006 — teaching evidence is its own explicitly-typed evidence class', () => {
  const service = buildService();
  const document = buildSupportTriageDocument();
  const pinned = {
    workflowId: 'wf-support-triage',
    versionId: 'wfv_triage_1',
    semanticDigest: { ...pinLinearDocument(document).semanticDigest },
  };
  const learner = 'learner_amelia';
  // Produce a full teaching flow worth of evidence: confirmations, one
  // incorrect + one correct practice attempt, and a passed assessment.
  const created = service.createSession({ learnerId: learner, pinned });
  service.beginLesson({ sessionId: created.id, document });
  const lesson = service.getLesson({ sessionId: created.id, learnerId: learner });
  service.attemptPractice({ sessionId: created.id, learnerId: learner, nodeId: 'fetch_ticket', answer: 'messaging.send' });
  service.attemptPractice({ sessionId: created.id, learnerId: learner, nodeId: 'fetch_ticket', answer: 'github.repository.read' });
  for (const step of lesson.steps) {
    service.confirmCheckpoint({ sessionId: created.id, learnerId: learner, nodeId: step.nodeId });
  }
  service.submitIndependentPerformance({
    sessionId: created.id,
    learnerId: learner,
    orderedStepIds: lesson.stepOrder,
    semanticsByStep: {
      fetch_ticket: 'github.repository.read',
      draft_reply: 'Draft a support reply and a severity classification for the ticket.',
      human_review: 'Approve sending the drafted support reply and syncing the backlog.',
      send_reply: 'messaging.send',
      escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
      log_miss: 'filesystem.write',
    },
  });
  const evidence: readonly TeachingEvidenceRecord[] = service
    .getSession({ sessionId: created.id, learnerId: learner })
    .evidence;

  it('every teaching evidence record carries evidenceClass "teaching"', () => {
    expect(evidence.length).toBeGreaterThanOrEqual(9);
    for (const record of evidence) {
      expect(record.evidenceClass).toBe('teaching');
    }
  });

  it('"teaching" is NOT one of the registry evidence classes (intent/observation/claim/verification/human_confirmation)', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as { evidence: string[] };
    for (const registryClass of registry.evidence) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(registryClass);
    }
    for (const vocabularyClass of WORKFLOW_IR_REGISTRY_VOCABULARY.evidence) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(vocabularyClass);
    }
  });

  it('"teaching" is NOT an execution class, placement id, visibility id or assurance id', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
      executionClasses: string[];
      placement: string[];
      visibility: string[];
      assurance: string[];
    };
    for (const executionClass of registry.executionClasses) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(executionClass);
    }
    for (const placement of registry.placement) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(placement);
    }
    for (const visibility of registry.visibility) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(visibility);
    }
    for (const assurance of registry.assurance) {
      expect(TEACHING_EVIDENCE_CLASS).not.toBe(assurance);
    }
  });

  it('teaching evidence KINDS are learner-teaching concepts, never registry evidence classes', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as { evidence: string[] };
    for (const kind of TEACHING_EVIDENCE_KINDS) {
      expect(registry.evidence).not.toContain(kind);
      expect(kind.startsWith('learner_')).toBe(true);
    }
    expect(TEACHING_EVIDENCE_KINDS).toEqual([
      'learner_checkpoint_confirmation',
      'learner_practice_attempt',
      'learner_assessment_outcome',
    ]);
  });

  it('the full flow produced exactly the three teaching evidence kinds, in order', () => {
    expect([...new Set(evidence.map((record) => record.kind))]).toEqual([
      'learner_practice_attempt',
      'learner_checkpoint_confirmation',
      'learner_assessment_outcome',
    ]);
  });

  it('teaching evidence never references a run/attempt identity of the unmerged execution domain', () => {
    for (const record of evidence) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/"runId"/);
      expect(serialized).not.toMatch(/"attemptId"\s*:/);
      expect(serialized).not.toMatch(/"workflowRunId"/);
    }
  });

  it('a teaching session completion is NOT an execution completion of the workflow', () => {
    const completed = teachThrough(buildService(), 'learner_amelia', buildSupportTriageDocument(), {
      workflowId: 'wf-support-triage',
      versionId: 'wfv_triage_1',
      semanticDigest: pinLinearDocument(buildSupportTriageDocument()).semanticDigest,
    });
    expect(completed.status).toBe('completed');
    // The session record exposes ONLY teaching concepts: pinned version data,
    // learner progress and teaching evidence — no run, execution or
    // side-effect-completion claim anywhere.
    const serialized = JSON.stringify(completed);
    expect(serialized).not.toMatch(/"run"/);
    expect(serialized).not.toMatch(/"sideEffect"/);
    expect(serialized).not.toMatch(/"executedAt"/);
  });

  it('a checkpoint confirmation is learner acknowledgement of UNDERSTANDING, not a side-effect claim', () => {
    const confirmations = evidence.filter((record) => record.kind === 'learner_checkpoint_confirmation');
    expect(confirmations).toHaveLength(6);
    for (const record of confirmations) {
      expect(record.detail).toMatchObject({ acknowledged: 'understanding' });
    }
  });
});
