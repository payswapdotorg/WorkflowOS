import { describe, it, expect } from 'vitest';
import { authorDailyFollowupDocument, pinOf, buildTestService, LEARNER_ID } from './helpers.js';
import { ReverseTeachingError } from '../../../src/reverse-teaching/index.js';
import { computeWorkflowVersionSemanticDigest } from '../../../src/workflow-ir/index.js';

/**
 * V2-010 — the version-pinning regressions (Work Order: "reverse-teaching
 * session bound to an immutable WorkflowVersion").
 *
 * The session binds to the installed pin (installationId + workflowId +
 * versionId + V2-003 semantic digest); supplied content is verified against
 * the pin fail-closed (V2-006's exact discipline, extended with the
 * installation identity).
 */
describe('V2-010 version pinning', () => {
  const document = authorDailyFollowupDocument();

  function expectCode(fn: () => unknown, code: string): ReverseTeachingError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ReverseTeachingError);
      const typed = error as ReverseTeachingError;
      expect(typed.code).toBe(code);
      return typed;
    }
    throw new Error(`expected a ReverseTeachingError with code ${code}`);
  }

  it('creates a session bound to the installed pin (carried as data, deep-frozen)', () => {
    const service = buildTestService();
    const pin = pinOf(document);
    const session = service.createSession({ learnerId: LEARNER_ID, pin });
    expect(session.id).toMatch(/^rt_/);
    expect(session.status).toBe('not_started');
    expect(session.pin).toEqual(pin);
    expect(session.pin.installationId).toBe(pin.installationId);
    expect(Object.isFrozen(session.pin)).toBe(true);
  });

  it('rejects an invalid installation identity (fail-closed)', () => {
    const service = buildTestService();
    const pin = pinOf(document);
    expectCode(() => service.createSession({ learnerId: LEARNER_ID, pin: { ...pin, installationId: '' } }), 'INSTALLATION_PIN_INVALID');
    expectCode(() => service.createSession({ learnerId: LEARNER_ID, pin: { ...pin, installationId: 42 as never } }), 'INSTALLATION_PIN_INVALID');
  });

  it('rejects an invalid pin shape (digest/algorithm/domain)', () => {
    const service = buildTestService();
    const pin = pinOf(document);
    expectCode(
      () => service.createSession({ learnerId: LEARNER_ID, pin: { ...pin, semanticDigest: { ...pin.semanticDigest, algorithm: 'md5' as never } } }),
      'PIN_DIGEST_ALGORITHM_UNSUPPORTED',
    );
    expectCode(
      () => service.createSession({ learnerId: LEARNER_ID, pin: { ...pin, semanticDigest: { ...pin.semanticDigest, domain: 'wrong/domain' as never } } }),
      'PIN_DIGEST_DOMAIN_MISMATCH',
    );
    expectCode(
      () => service.createSession({ learnerId: LEARNER_ID, pin: { ...pin, semanticDigest: { ...pin.semanticDigest, digest: 'not-hex' } } }),
      'REVERSE_TEACHING_INPUT_INVALID',
    );
  });

  it('beginLesson verifies supplied content against the pin (VERSION_PIN_MISMATCH on drift)', () => {
    const service = buildTestService();
    const pin = pinOf(document);
    const session = service.createSession({ learnerId: LEARNER_ID, pin });
    // a DIFFERENT document (different semantics) must fail the pin check
    const tampered = JSON.parse(JSON.stringify(authorDailyFollowupDocument())) as ReturnType<typeof authorDailyFollowupDocument>;
    (tampered.ir.nodes.find((n: { id: string }) => n.id === 'draft_followup')!.spec as { task: string }).task =
      'A different task that changes the semantic digest.';
    expectCode(() => service.beginLesson({ sessionId: session.id, document: tampered }), 'VERSION_PIN_MISMATCH');
    // the session stays not_started after the failed attachment
    const read = service.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(read.status).toBe('not_started');
    expect(read.lesson).toBeNull();
  });

  it('beginLesson accepts the exact pinned document and is idempotent', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson).not.toBeNull();
    expect(begun.pinnedDocument).not.toBeNull();
    // re-attachment of identical semantic content is a no-op (same updatedAt)
    const again = service.beginLesson({ sessionId: session.id, document: JSON.parse(JSON.stringify(document)) as typeof document });
    expect(again.updatedAt).toBe(begun.updatedAt);
    expect(again.status).toBe('in_progress');
  });

  it('the pinned document snapshot is byte-identical to the supplied installed content (deep-frozen)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(JSON.stringify(begun.pinnedDocument)).toBe(JSON.stringify(document));
    expect(Object.isFrozen(begun.pinnedDocument)).toBe(true);
    // and the pin digest equals the V2-003 digest of the pinned document (consumed, never recomputed differently)
    expect(computeWorkflowVersionSemanticDigest(begun.pinnedDocument!).digest).toBe(begun.pin.semanticDigest.digest);
  });

  it('a session for another learner is not readable (learner-scoped)', () => {
    const service = buildTestService();
    const session = service.createSession({ learnerId: LEARNER_ID, pin: pinOf(document) });
    expectCode(() => service.getSession({ sessionId: session.id, learnerId: 'someone-else' }), 'LEARNER_NOT_AUTHORIZED');
    expectCode(() => service.getSession({ sessionId: 'rt_missing', learnerId: LEARNER_ID }), 'SESSION_NOT_FOUND');
  });
});
