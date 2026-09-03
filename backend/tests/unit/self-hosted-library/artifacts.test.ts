import { describe, it, expect } from 'vitest';
import {
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  FIRST_PARTY_PROCEDURE_KINDS,
  FIRST_PARTY_ALLOWED_CAPABILITIES,
  artifactByKind,
} from '../../../src/self-hosted-library/index.js';
import {
  parseWorkflowIrDocument,
  validateWorkflowIrDocument,
  serializeWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
} from '../../../src/workflow-ir/index.js';

/**
 * V2-013 Task 2 — the first-party artifact battery.
 *
 * Proves (the frozen work-order "must deliver"):
 *   - the repository of first-party workflows covers EXACTLY the six
 *     frozen procedure kinds (implementation, review, testing, release,
 *     maintenance, dogfooding);
 *   - every artifact is a VALID ordinary WorkflowIR document (V2-003 is
 *     the semantics authority — parse + validate clean);
 *   - every declared capability is canonical AND inside the first-party
 *     allowlist (no merge gate, no invented capabilities);
 *   - the semantic digest is DETERMINISTIC (the same artifact set yields
 *     the same digests on every load — the manifest derivation base);
 *   - the proof-required steps declared by each execution policy EXIST
 *     as steps in the artifact's own document (the policy overlay is
 *     grounded, never free-floating).
 */

describe('V2-013 first-party artifacts — the repository of development workflows', () => {
  it('contains exactly the six frozen procedure kinds, in canonical order, one artifact each', () => {
    expect(FIRST_PARTY_WORKFLOW_ARTIFACTS.map((a) => a.kind)).toEqual([...FIRST_PARTY_PROCEDURE_KINDS]);
  });

  it('every artifact is a valid ordinary WorkflowIR document (V2-003 parse + validate clean)', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const validation = validateWorkflowIrDocument(artifact.document);
      expect(validation.ok, `${artifact.kind}: ${JSON.stringify(validation.ok ? [] : validation.issues)}`).toBe(true);
      // round-trip parse: the canonically serialized document parses back
      // (the exact content the repository stores — the V2-012 precedent)
      const parsed = parseWorkflowIrDocument(serializeWorkflowIrDocument(artifact.document));
      expect(parsed.ok, `${artifact.kind}: parse of serialized document failed`).toBe(true);
    }
  });

  it('every declared capability is canonical AND inside the first-party allowlist', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      for (const node of artifact.document.ir.nodes) {
        for (const capability of node.capabilityRequirements) {
          expect(
            FIRST_PARTY_ALLOWED_CAPABILITIES.includes(capability),
            `${artifact.kind}/${node.id} capability "${capability}" outside the allowlist`,
          ).toBe(true);
        }
      }
    }
  });

  it('NO artifact declares the merge capability (the architect merge gate is external to every first-party workflow)', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      for (const node of artifact.document.ir.nodes) {
        expect(
          node.capabilityRequirements.includes('github.pull_request.merge'),
          `${artifact.kind}/${node.id} claims the merge gate`,
        ).toBe(false);
      }
    }
  });

  it('the semantic digests are deterministic (two loads of the same artifact set are byte-identical)', () => {
    const first = FIRST_PARTY_WORKFLOW_ARTIFACTS.map((a) => ({
      kind: a.kind,
      digest: computeWorkflowVersionSemanticDigest(a.document),
    }));
    // a second independent load: re-import through artifactByKind lookups
    const second = FIRST_PARTY_PROCEDURE_KINDS.map((kind) => {
      const artifact = artifactByKind(kind)!;
      return { kind, digest: computeWorkflowVersionSemanticDigest(artifact.document) };
    });
    expect(first).toEqual(second);
    // distinct workflows have distinct semantic digests (content discrimination)
    const digests = new Set(first.map((entry) => entry.digest));
    expect(digests.size).toBe(FIRST_PARTY_PROCEDURE_KINDS.length);
  });

  it('every proof-required step declared by the execution policy exists in the artifact document', () => {
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const stepIds = new Set(artifact.document.ir.nodes.map((node) => node.id));
      for (const stepId of artifact.executionPolicy.proofRequiredSteps) {
        expect(stepIds.has(stepId), `${artifact.kind}: proof-required step "${stepId}" is not a document step`).toBe(true);
      }
    }
  });

  it('at least one procedure requires a proof predicate (the proof-consumption surface is exercised)', () => {
    const withProof = FIRST_PARTY_WORKFLOW_ARTIFACTS.filter((a) => a.executionPolicy.proofRequiredSteps.length > 0);
    expect(withProof.length).toBeGreaterThanOrEqual(2);
    // the dogfooding procedure's execute step is proof-required (the frozen clause)
    const dogfooding = artifactByKind('dogfooding')!;
    expect(dogfooding.executionPolicy.proofRequiredSteps).toContain('execute_workflow');
  });

  it('the slugs are stable and namespaced (the installer publishes under deterministic repository slugs)', () => {
    const slugs = FIRST_PARTY_WORKFLOW_ARTIFACTS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug.startsWith('wfos-dev-')).toBe(true);
    }
  });
});
