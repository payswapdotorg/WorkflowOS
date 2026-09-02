import { describe, it, expect } from 'vitest';
import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  verifyCompiledWorkflowArtifact,
  computeCompiledWorkflowDigest,
  assertCompileWorkflow,
  WorkflowCompilerError,
  SUPPORTED_WORKFLOW_COMPILER_VERSIONS,
  WORKFLOW_COMPILER_VERSION,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_ERROR_CODES,
} from '../../../src/workflow-compiler/index.js';
import { buildTriageDocument, clone } from './helpers.js';
import type { CompiledWorkflowArtifact } from '../../../src/workflow-compiler/index.js';

/**
 * V2-007 — compiler-version compatibility battery.
 *
 * Inputs declaring unsupported compiler versions are rejected (fail closed,
 * never guess forward). Artifacts declaring unsupported compiler versions are
 * rejected at parse. Tampered artifacts (mutated plan, stale digest) are
 * rejected by digest verification. The typed error surface mirrors the
 * merged workflow-ir style.
 */

const AUTHORED = buildTriageDocument();

function okArtifact(): CompiledWorkflowArtifact {
  const result = compileWorkflow(AUTHORED);
  if (!result.ok) throw new Error('fixture must compile');
  return result.artifact;
}

describe('V2-007 — inputs declaring unsupported compiler versions', () => {
  it('this build declares its supported compiler versions explicitly', () => {
    expect(WORKFLOW_COMPILER_VERSION).toBe(1);
    expect(SUPPORTED_WORKFLOW_COMPILER_VERSIONS).toContain(WORKFLOW_COMPILER_VERSION);
    expect(SUPPORTED_WORKFLOW_COMPILER_VERSIONS).toEqual([1]);
  });

  it('options declaring an unsupported compiler version are rejected', () => {
    const result = compileWorkflow(AUTHORED, { compilerVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED')).toBe(true);
      expect(result.diagnostics.some((d) => d.message.includes('2'))).toBe(true);
    }
  });

  it('options declaring the current compiler version are accepted', () => {
    const result = compileWorkflow(AUTHORED, { compilerVersion: 1 });
    expect(result.ok).toBe(true);
  });

  it('options declaring an unknown option key are rejected (no guessed semantics)', () => {
    const result = compileWorkflow(AUTHORED, { unknownOption: true } as object);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_INPUT_INVALID')).toBe(true);
    }
  });

  it('version rejection takes precedence and is deterministic', () => {
    const first = compileWorkflow(AUTHORED, { compilerVersion: 99 });
    const second = compileWorkflow(AUTHORED, { compilerVersion: 99 });
    expect(first).toEqual(second);
  });
});

describe('V2-007 — artifacts declaring unsupported compiler versions', () => {
  it('an artifact declaring a future compiler version is rejected at parse', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact);
    tampered.provenance.compiler.version = 99;
    const bytes = JSON.stringify(tampered);
    const parsed = parseCompiledWorkflowArtifact(bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED')).toBe(true);
    }
  });

  it('an artifact from the current compiler version parses', () => {
    const bytes = serializeCompiledWorkflowArtifact(okArtifact());
    const parsed = parseCompiledWorkflowArtifact(bytes);
    expect(parsed.ok).toBe(true);
  });

  it('verifyCompiledWorkflowArtifact rejects an unsupported declared version', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact);
    tampered.provenance.compiler.version = 99;
    const verification = verifyCompiledWorkflowArtifact(tampered);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED')).toBe(true);
    }
  });
});

describe('V2-007 — tampered / malformed artifacts fail closed', () => {
  it('a mutated plan with a stale embedded digest is rejected (digest is load-bearing)', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact);
    const unit = tampered.plan.units.find((candidate) => candidate.unit === 'draft_summary');
    if (unit) unit.placement = 'device_local';
    expect(computeCompiledWorkflowDigest(tampered).digest).not.toBe(tampered.artifactDigest);
    const verification = verifyCompiledWorkflowArtifact(tampered);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_ARTIFACT_INVALID')).toBe(true);
    }
  });

  it('a mutated digest field itself is rejected', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact);
    tampered.artifactDigest = '0'.repeat(64);
    const verification = verifyCompiledWorkflowArtifact(tampered);
    expect(verification.ok).toBe(false);
  });

  it('a removed provenance block is rejected', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact) as unknown as Record<string, unknown>;
    delete tampered['provenance'];
    const verification = verifyCompiledWorkflowArtifact(tampered as unknown as CompiledWorkflowArtifact);
    expect(verification.ok).toBe(false);
  });

  it('non-JSON text is rejected as an invalid artifact', () => {
    const parsed = parseCompiledWorkflowArtifact('this is not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_ARTIFACT_INVALID')).toBe(true);
    }
  });

  it('an artifact with a wrong object type is rejected', () => {
    const artifact = okArtifact();
    const tampered = clone(artifact) as unknown as { objectType: string };
    tampered.objectType = 'workflowos/not-a-compiled-workflow/v1';
    const parsed = parseCompiledWorkflowArtifact(JSON.stringify(tampered));
    expect(parsed.ok).toBe(false);
  });

  it('an artifact with unknown top-level keys is rejected (no smuggling surface)', () => {
    const artifact = okArtifact();
    const smuggled = {
      ...clone(artifact),
      executed: true,
      status: 'completed',
    };
    const parsed = parseCompiledWorkflowArtifact(JSON.stringify(smuggled));
    expect(parsed.ok).toBe(false);
  });

  it('the genuine artifact verifies ok', () => {
    expect(verifyCompiledWorkflowArtifact(okArtifact()).ok).toBe(true);
  });
});

describe('V2-007 — typed error surface (workflow-ir style)', () => {
  it('the error-code vocabulary is closed and stable', () => {
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_INPUT_INVALID');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_PLACEMENT_CONFLICT');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_GRAPH_INVALID');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_POLICY_VIOLATION');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_VERSION_UNSUPPORTED');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_AMBIGUOUS_INPUT');
    expect(WORKFLOW_COMPILER_ERROR_CODES).toContain('WORKFLOW_COMPILER_ARTIFACT_INVALID');
  });

  it('assertCompileWorkflow throws a WorkflowCompilerError carrying all diagnostics', () => {
    expect(() => assertCompileWorkflow(AUTHORED, { compilerVersion: 2 })).toThrowError(WorkflowCompilerError);
    try {
      assertCompileWorkflow(AUTHORED, { compilerVersion: 2 });
    } catch (error) {
      const typed = error as WorkflowCompilerError;
      expect(typed.name).toBe('WorkflowCompilerError');
      expect(typed.code).toBe('WORKFLOW_COMPILER_VERSION_UNSUPPORTED');
      expect(typed.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('assertCompileWorkflow returns the artifact payload on success', () => {
    const payload = assertCompileWorkflow(AUTHORED);
    expect(payload.artifact.provenance.compiler.id).toBe(WORKFLOW_COMPILER_ID);
    expect(payload.artifact.provenance.compiler.version).toBe(WORKFLOW_COMPILER_VERSION);
  });
});
