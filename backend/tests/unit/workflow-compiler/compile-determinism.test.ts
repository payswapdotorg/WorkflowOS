import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  computeCompiledWorkflowDigest,
  COMPILED_WORKFLOW_OBJECT_TYPE,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_VERSION,
} from '../../../src/workflow-compiler/index.js';
import { validateWorkflowIrDocument, serializeWorkflowIrDocument, parseWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  buildTriageDocument,
  buildTriageDocumentAltOrder,
  withPresentation,
  withEdge,
  withIr,
} from './helpers.js';

/**
 * V2-007 — deterministic compilation battery.
 *
 * Identical source document + identical compiler version + identical options
 * → byte-identical serialized compiled artifact (registry digest rule:
 * canonical JSON, no presentation formatting, no wall clock, no randomness).
 * Semantically-equal sources (independent authoring order) compile to the
 * SAME artifact bytes because the plan is built from set-normalized
 * semantics. Different options → different compile-options digest → different
 * artifact identity.
 */

const AUTHORED = buildTriageDocument();

function okCompile(document: Parameters<typeof compileWorkflow>[0]) {
  const result = compileWorkflow(document);
  if (!result.ok) {
    throw new Error(`fixture must compile: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  return result;
}

describe('V2-007 — deterministic compilation (same input → byte-identical artifact)', () => {
  it('the source fixture is a valid WorkflowIR document (precondition)', () => {
    expect(validateWorkflowIrDocument(AUTHORED).ok).toBe(true);
  });

  it('repeated compilation yields identical artifact digests and identical serialized bytes', () => {
    const first = okCompile(AUTHORED);
    const second = okCompile(AUTHORED);
    expect(first.artifact).toEqual(second.artifact);
    expect(serializeCompiledWorkflowArtifact(first.artifact)).toBe(
      serializeCompiledWorkflowArtifact(second.artifact),
    );
    expect(computeCompiledWorkflowDigest(first.artifact).digest).toBe(
      computeCompiledWorkflowDigest(second.artifact).digest,
    );
  });

  it('the artifact digest is a 64-hex sha-256 over the compiler-owned domain', () => {
    const digest = computeCompiledWorkflowDigest(okCompile(AUTHORED).artifact);
    expect(digest.algorithm).toBe('sha-256');
    expect(digest.domain).toBe(COMPILED_WORKFLOW_OBJECT_TYPE);
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the artifact embeds its own digest and it matches the recomputed digest', () => {
    const { artifact } = okCompile(AUTHORED);
    expect(artifact.artifactDigest).toBe(computeCompiledWorkflowDigest(artifact).digest);
  });

  it('the artifact records the compiler identity and version it was produced by', () => {
    const { artifact } = okCompile(AUTHORED);
    expect(artifact.provenance.compiler.id).toBe(WORKFLOW_COMPILER_ID);
    expect(artifact.provenance.compiler.version).toBe(WORKFLOW_COMPILER_VERSION);
  });

  it('serialized bytes are canonical JSON (no insignificant whitespace)', () => {
    const bytes = serializeCompiledWorkflowArtifact(okCompile(AUTHORED).artifact);
    expect(bytes).not.toMatch(/[\n\r\t]/);
    expect(bytes).not.toMatch(/[:,{}[\]]\s/);
    expect(JSON.parse(bytes)).toEqual(JSON.parse(bytes));
  });
});

describe('V2-007 — reproducibility across serialization round-trips', () => {
  it('serialize → parse → re-serialize is byte-identical', () => {
    const { artifact } = okCompile(AUTHORED);
    const bytes = serializeCompiledWorkflowArtifact(artifact);
    const parsed = parseCompiledWorkflowArtifact(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeCompiledWorkflowArtifact(parsed.artifact)).toBe(bytes);
      expect(parsed.artifact).toEqual(artifact);
    }
  });

  it('compiling the transport-round-tripped source document reproduces the exact artifact bytes', () => {
    const { artifact } = okCompile(AUTHORED);
    const irBytes = serializeWorkflowIrDocument(AUTHORED);
    const reparsed = parseWorkflowIrDocument(irBytes);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      const recompiled = okCompile(reparsed.document).artifact;
      expect(serializeCompiledWorkflowArtifact(recompiled)).toBe(
        serializeCompiledWorkflowArtifact(artifact),
      );
    }
  });

  it('recompiling the same document keeps artifact identity (no drift from repeated compilation)', () => {
    const direct = okCompile(AUTHORED).artifact;
    const again = okCompile(AUTHORED).artifact;
    expect(direct).toEqual(again);
    expect(direct.artifactDigest).toBe(again.artifactDigest);
  });
});

describe('V2-007 — semantic-source determinism (authoring order is presentation)', () => {
  it('an independently re-authored, order-scrambled source compiles to identical bytes', () => {
    const a = okCompile(AUTHORED).artifact;
    const b = okCompile(buildTriageDocumentAltOrder()).artifact;
    expect(serializeCompiledWorkflowArtifact(a)).toBe(serializeCompiledWorkflowArtifact(b));
  });

  it('presentation-only source changes do not change the compiled artifact', () => {
    const base = okCompile(AUTHORED).artifact;
    const relabeled = okCompile(
      withPresentation(AUTHORED, {
        title: 'A totally different display title',
        nodeLabels: { review_gate: 'A DIFFERENT display label' },
        notes: 'presentation is never semantics',
      }),
    ).artifact;
    expect(serializeCompiledWorkflowArtifact(relabeled)).toBe(
      serializeCompiledWorkflowArtifact(base),
    );
    expect(relabeled.artifactDigest).toBe(base.artifactDigest);
  });

  it('removing the presentation entirely does not change the compiled artifact', () => {
    const base = okCompile(AUTHORED).artifact;
    const bare = okCompile(withPresentation(AUTHORED, undefined)).artifact;
    expect(serializeCompiledWorkflowArtifact(bare)).toBe(serializeCompiledWorkflowArtifact(base));
  });
});

describe('V2-007 — compile options are part of artifact identity', () => {
  it('declared supported compiler version compiles and is pinned in the options digest', () => {
    const withVersion = okCompile(AUTHORED, { compilerVersion: 1 });
    const without = okCompile(AUTHORED);
    expect(withVersion.artifact.provenance.optionsDigest).not.toBe(
      without.artifact.provenance.optionsDigest,
    );
    expect(withVersion.artifact.artifactDigest).not.toBe(without.artifact.artifactDigest);
  });

  it('different options produce different artifact digests and different bytes', () => {
    const withVersion = okCompile(AUTHORED, { compilerVersion: 1 });
    const without = okCompile(AUTHORED);
    expect(serializeCompiledWorkflowArtifact(withVersion.artifact)).not.toBe(
      serializeCompiledWorkflowArtifact(without.artifact),
    );
  });
});

describe('V2-007 — deterministic compilation across semantic edge additions (order-free)', () => {
  it('adding an edge changes the artifact deterministically (no clock/random dependence)', () => {
    const base = okCompile(AUTHORED).artifact;
    const extended = okCompile(
      withEdge(AUTHORED, { from: 'sync_backlog', to: 'log_rejection', on: 'success' }),
    ).artifact;
    expect(extended.artifactDigest).not.toBe(base.artifactDigest);
    const extendedAgain = okCompile(
      withEdge(AUTHORED, { from: 'sync_backlog', to: 'log_rejection', on: 'success' }),
    ).artifact;
    expect(extendedAgain).toEqual(extended);
  });

  it('a semantic change to the source changes the artifact; the SAME change re-applied is stable', () => {
    const mutated = withIr(AUTHORED, {
      inputs: [
        { name: 'issueUrl', type: { kind: 'string' } },
        { name: 'channel', type: { kind: 'string' }, optional: true },
        { name: 'priority', type: { kind: 'string' }, optional: true },
      ],
    });
    const first = okCompile(mutated).artifact;
    const second = okCompile(mutated).artifact;
    expect(first).toEqual(second);
    expect(first.artifactDigest).not.toBe(okCompile(AUTHORED).artifact.artifactDigest);
  });
});
