import { describe, it, expect } from 'vitest';
import {
  computeWorkflowVersionSemanticDigest,
  canonicalSemanticJson,
} from '../../../src/workflow-ir/index.js';
import {
  buildService,
  buildLinearDocument,
  buildLinearDocumentEdited,
  buildLinearDocumentRelabeled,
  pinLinearDocument,
  LEARNER_A,
} from './helpers.js';

/**
 * V2-006 — VERSION PINNING (required regression).
 *
 * A TeachingSession is bound to ONE immutable WorkflowVersion reference
 * carried as DATA (workflow id + version id + the V2-003 semantic digest as
 * computed by the merged workflow-ir barrel — never recomputed or redefined
 * here). Supplying teaching content whose semantic digest differs from the
 * pinned one is a typed, fail-closed rejection, and the session is unharmed.
 */
describe('V2-006 — a session pins one immutable WorkflowVersion', () => {
  it('the session records the pinned workflow id, version id and semantic digest as data', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    expect(session.pinned.workflowId).toBe('wf-linear-read-aloud');
    expect(session.pinned.versionId).toBe('wfv_linear_1');
    expect(session.pinned.semanticDigest.digest).toBe(pinned.semanticDigest.digest);
    expect(session.pinned.semanticDigest.algorithm).toBe('sha-256');
    expect(session.pinned.semanticDigest.domain).toBe('workflowos/workflow-ir/v1');
    // The digest value equals what the MERGED V2-003 barrel computes.
    expect(session.pinned.semanticDigest).toEqual(computeWorkflowVersionSemanticDigest(document));
  });

  it('beginLesson accepts content whose semantic digest matches the pin', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const session = service.createSession({ learnerId: LEARNER_A, pinned: pinLinearDocument(document) });
    const begun = service.beginLesson({ sessionId: session.id, document });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson).not.toBeNull();
  });

  it('presentation-only changes keep the pin (the pin is SEMANTIC, registry: presentationExcluded)', () => {
    const service = buildService();
    const pinned = pinLinearDocument(buildLinearDocument());
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    const relabeled = buildLinearDocumentRelabeled();
    expect(canonicalSemanticJson(relabeled)).toBe(canonicalSemanticJson(buildLinearDocument()));
    const begun = service.beginLesson({ sessionId: session.id, document: relabeled });
    expect(begun.status).toBe('in_progress');
  });

  it('edited content (different semantic digest) is rejected with VERSION_PIN_MISMATCH', () => {
    const service = buildService();
    const pinned = pinLinearDocument(buildLinearDocument());
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    const edited = buildLinearDocumentEdited();
    expect(computeWorkflowVersionSemanticDigest(edited).digest).not.toBe(pinned.semanticDigest.digest);
    expect(() => service.beginLesson({ sessionId: session.id, document: edited })).toThrowError(/VERSION_PIN_MISMATCH/);
  });

  it('the pin-mismatch rejection leaves the session unharmed (still not_started, no lesson)', () => {
    const service = buildService();
    const pinned = pinLinearDocument(buildLinearDocument());
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    const before = JSON.stringify(session);
    try {
      service.beginLesson({ sessionId: session.id, document: buildLinearDocumentEdited() });
      expect.unreachable('beginLesson must reject mismatched content');
    } catch {
      // typed rejection expected
    }
    const after = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(after.status).toBe('not_started');
    expect(after.lesson).toBeNull();
    expect(JSON.stringify({ ...after })).toContain('"status":"not_started"');
    expect(before).not.toBe('');
  });

  it('a mismatched pin is rejected even after the lesson has begun (re-supply of foreign content)', () => {
    const service = buildService();
    const pinned = pinLinearDocument(buildLinearDocument());
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document: buildLinearDocument() });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });
    expect(() =>
      service.beginLesson({ sessionId: session.id, document: buildLinearDocumentEdited() }),
    ).toThrowError(/VERSION_PIN_MISMATCH/);
    // The already-begun lesson and the confirmed checkpoint are untouched.
    const after = service.getSession({ sessionId: session.id, learnerId: LEARNER_A });
    expect(after.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['observe_page']);
  });

  it('re-beginning with the SAME content is idempotent (session state preserved)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    service.beginLesson({ sessionId: session.id, document });
    service.confirmCheckpoint({ sessionId: session.id, learnerId: LEARNER_A, nodeId: 'observe_page' });
    const reBegun = service.beginLesson({ sessionId: session.id, document });
    expect(reBegun.status).toBe('in_progress');
    expect(reBegun.progress.confirmedCheckpoints).toHaveLength(1);
  });
});

describe('V2-006 — pinned digest shape is validated at session creation (fail closed)', () => {
  it('a pinned digest with a non-sha-256 algorithm is rejected', () => {
    const service = buildService();
    const pinned = {
      ...pinLinearDocument(buildLinearDocument()),
      semanticDigest: {
        algorithm: 'md5' as unknown as 'sha-256',
        domain: 'workflowos/workflow-ir/v1',
        digest: 'a'.repeat(64),
      },
    };
    expect(() => service.createSession({ learnerId: LEARNER_A, pinned })).toThrowError(
      /PIN_DIGEST_ALGORITHM_UNSUPPORTED/,
    );
  });

  it('a pinned digest with a foreign domain is rejected', () => {
    const service = buildService();
    const pinned = {
      ...pinLinearDocument(buildLinearDocument()),
      semanticDigest: {
        algorithm: 'sha-256' as const,
        domain: 'some/other/domain/v1',
        digest: 'a'.repeat(64),
      },
    };
    expect(() => service.createSession({ learnerId: LEARNER_A, pinned })).toThrowError(
      /PIN_DIGEST_DOMAIN_MISMATCH/,
    );
  });

  it('a pinned digest that is not 64-hex is rejected as invalid input', () => {
    const service = buildService();
    const pinned = {
      ...pinLinearDocument(buildLinearDocument()),
      semanticDigest: {
        algorithm: 'sha-256' as const,
        domain: 'workflowos/workflow-ir/v1',
        digest: 'not-hex',
      },
    };
    expect(() => service.createSession({ learnerId: LEARNER_A, pinned })).toThrowError(
      /TEACHING_INPUT_INVALID/,
    );
  });

  it('an empty learner id is rejected', () => {
    const service = buildService();
    expect(() =>
      service.createSession({ learnerId: '', pinned: pinLinearDocument(buildLinearDocument()) }),
    ).toThrowError(/TEACHING_INPUT_INVALID/);
  });

  it('unknown session ids are rejected fail-closed', () => {
    const service = buildService();
    expect(() => service.getSession({ sessionId: 'ts_unknown', learnerId: LEARNER_A })).toThrowError(
      /SESSION_NOT_FOUND/,
    );
  });
});

describe('V2-006 — invalid IR content cannot begin a lesson (fail closed)', () => {
  it('structurally invalid content is rejected with IR_DOCUMENT_INVALID (merged V2-003 validation)', () => {
    const service = buildService();
    const document = buildLinearDocument();
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    // Break the document SEMANTICALLY (dangling edge target) — the digest
    // changes too, so pin first with a document whose digest matches but that
    // is invalid: instead, craft the invalid document FIRST and pin it.
    const invalid = {
      ...document,
      ir: { ...document.ir, edges: [{ from: 'observe_page', to: 'no_such_node', on: 'success' as const }] },
    };
    const invalidPinned = pinLinearDocument(invalid);
    const invalidSession = service.createSession({ learnerId: LEARNER_A, pinned: invalidPinned });
    expect(() => service.beginLesson({ sessionId: invalidSession.id, document: invalid })).toThrowError(
      /IR_DOCUMENT_INVALID/,
    );
    expect(session.id).not.toBe(invalidSession.id);
  });

  it('content with a non-canonical (aliased) capability name is rejected by the merged validation', () => {
    const service = buildService();
    const document = {
      ...buildLinearDocument(),
      ir: {
        ...buildLinearDocument().ir,
        nodes: [
          {
            ...buildLinearDocument().ir.nodes[0]!,
            spec: { class: 'deterministic_api' as const, capability: 'browser.observe.v2' },
            capabilityRequirements: ['browser.observe.v2'],
          },
          buildLinearDocument().ir.nodes[1]!,
        ],
      },
    };
    const pinned = pinLinearDocument(document);
    const session = service.createSession({ learnerId: LEARNER_A, pinned });
    const rejection = (() => {
      try {
        service.beginLesson({ sessionId: session.id, document });
        return null;
      } catch (error) {
        return error as { message: string; code?: string };
      }
    })();
    expect(rejection).not.toBeNull();
    expect(rejection!.message).toMatch(/IR_DOCUMENT_INVALID/);
    expect(rejection!.message).toMatch(/IR_CAPABILITY_NON_CANONICAL|IR_CAPABILITY_REQUIREMENT_NON_CANONICAL/);
  });
});
