import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildService,
  buildSupportTriageDocument,
  pinLinearDocument,
  LEARNER_A,
  LEARNER_B,
  snapshot,
} from './helpers.js';

/**
 * V2-006 — PERMISSION BOUNDARIES (required regression).
 *
 * Session-scoped permissions only: the session's LEARNER is the single
 * bounded authority for every session operation (confirm, practice, pause,
 * resume, assess, ask, read). This is deliberately NOT an authorization
 * engine: capability advertisement is never authorization (registry
 * authority rules), and teaching permission is its own bounded dimension —
 * the module consumes no capability/role/entitlement inputs at all.
 */

const setup = () => {
  const service = buildService();
  const document = buildSupportTriageDocument();
  const pinned = {
    workflowId: 'wf-support-triage',
    versionId: 'wfv_triage_1',
    semanticDigest: { ...pinLinearDocument(document).semanticDigest },
  };
  const session = service.createSession({ learnerId: LEARNER_A, pinned });
  service.beginLesson({ sessionId: session.id, document });
  service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'fetch_ticket' });
  return { service, sessionId: session.id, document, pinned };
};

describe('V2-006 — only the session learner may operate on the session', () => {
  it('EVERY mutating operation rejects a learner that is not the session learner', () => {
    const { service, sessionId } = setup();
    const before = snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }));

    expect(() =>
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_B, nodeId: 'draft_reply' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() =>
      service.attemptPractice({ sessionId, learnerId: LEARNER_B, nodeId: 'draft_reply', answer: 'x' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() => service.pauseSession({ sessionId, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() => service.resumeSession({ sessionId, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() =>
      service.submitIndependentPerformance({
        sessionId,
        learnerId: LEARNER_B,
        orderedStepIds: ['fetch_ticket'],
        semanticsByStep: {},
      }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() =>
      service.raiseQuestion({ sessionId, learnerId: LEARNER_B, question: '?' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    expect(() =>
      service.resolveQuestion({ sessionId, learnerId: LEARNER_B, questionId: 'ts_1' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);

    // The session is byte-identical after every rejected foreign operation.
    expect(snapshot(service.getSession({ sessionId, learnerId: LEARNER_A }))).toBe(before);
  });

  it('EVERY read operation rejects a learner that is not the session learner', () => {
    const { service, sessionId } = setup();
    expect(() => service.getSession({ sessionId, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() => service.getLesson({ sessionId, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
    expect(() => service.listPracticeQuestions({ sessionId, learnerId: LEARNER_B })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
  });

  it('the typed rejection carries the session learner and the acting learner', () => {
    const { service, sessionId } = setup();
    let details: Record<string, unknown> | undefined;
    try {
      service.confirmCheckpoint({ sessionId, learnerId: LEARNER_B, nodeId: 'draft_reply' });
    } catch (error) {
      details = (error as { details?: Record<string, unknown> }).details;
    }
    expect(details).toMatchObject({ sessionLearnerId: LEARNER_A, actingLearnerId: LEARNER_B });
  });

  it('learner permission is NOT capability permission: the service contract consumes no capability/role/entitlement inputs', () => {
    // Source-level: the service interface's session-scoped inputs are exactly
    // {sessionId, learnerId} (+ operation payload) — no capability set, no
    // role, no entitlement, no authorization token. The module therefore
    // cannot silently equate capability possession with teaching permission
    // (registry authority rule: capability-advertisement-is-not-authorization).
    const typesSource = readFileSync(
      fileURLToPath(new URL('../../../src/teaching-sessions/types.ts', import.meta.url)),
      'utf8',
    );
    const interfaceBody = typesSource.slice(
      typesSource.indexOf('export interface CreateTeachingSessionInput'),
      typesSource.indexOf('export interface TeachingSessionService'),
    );
    for (const forbidden of [/capabilit/i, /role/i, /entitlement/i, /authoriz/i, /permission/i, /token/i]) {
      const matches = interfaceBody.match(new RegExp(forbidden, 'g'));
      expect(
        matches,
        `the service contract must not consume authorization-engine inputs: ${matches}`,
      ).toBeNull();
    }
    // And the 10 session-scoped operations share exactly these 8
    // learner-scoped input shapes (reads/actions reuse shared inputs).
    expect((interfaceBody.match(/learnerId:/g) ?? []).length).toBe(8);
  });
});
