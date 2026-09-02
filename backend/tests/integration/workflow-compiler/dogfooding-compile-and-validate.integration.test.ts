import { describe, it, expect } from 'vitest';
import {
  deterministicReportView,
  runCompileAndValidateExperiment,
} from './dogfooding-compile-and-validate.harness.js';

/**
 * V2-007 — the compile-and-validate dogfooding experiment (integration,
 * deterministic).
 *
 * The dogfooding harness is exercised here through the REAL product paths:
 * the support-ticket-triage workflow authored with the merged V2-003 fluent
 * builder, compiled by this module, validated through the deterministic
 * semantic projection against the source IR's own canonical serialization,
 * exported/imported, and compiled twice for byte identity. The standalone
 * dogfooding RUN (`run-compile-and-validate-dogfooding.ts`) produces the
 * persisted evidence; this test pins the experiment's contract.
 */
describe('V2-007 compile-and-validate dogfooding experiment', () => {
  const report = runCompileAndValidateExperiment();

  it('authors a real workflow through the merged V2-003 builder and compiles it', () => {
    expect(report.workOrderId).toBe('V2-007');
    expect(report.workflow.task).toBe('support-ticket triage');
    expect(report.workflow.authoringPath).toBe('workflow-ir-builder');
    expect(report.workflow.nodeCount).toBe(6);
    expect(report.workflow.edgeCount).toBe(5);
    expect(report.workflow.start).toBe('fetch_issue');
    expect(report.sourceVersion.valid).toBe(true);
    expect(report.compilation.ok).toBe(true);
    expect(report.compilation.unitCount).toBe(6);
  });

  it('records the real V2-003 semantic digest of the source WorkflowVersion', () => {
    expect(report.sourceVersion.digestAlgorithm).toBe('sha-256');
    expect(report.sourceVersion.digestDomain).toBe('workflowos/workflow-ir/v1');
    expect(report.sourceVersion.semanticDigest).toMatch(/^[0-9a-f]{64}$/);
    // the digest is the known cross-client digest of the triage workflow
    expect(report.sourceVersion.semanticDigest).toBe(
      '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37',
    );
  });

  it('validates the compiled semantics against the same task (semantic equivalence)', () => {
    expect(report.conformance.semanticEquivalence).toBe(true);
    expect(report.conformance.edgeSetPreserved).toBe(true);
    expect(report.conformance.sourceBindingVerified).toBe(true);
    expect(report.conformance.artifactVerified).toBe(true);
    expect(report.conformance.secretRefOpaque).toBe(true);
    expect(report.conformance.canaryAbsent).toBe(true);
    expect(report.conformance.generatedSourceHasNoExecutionClaims).toBe(true);
  });

  it('exports, re-imports and re-validates the compiled artifact', () => {
    expect(report.exportImport.exportedByteLength).toBeGreaterThan(0);
    expect(report.exportImport.reimportOk).toBe(true);
    expect(report.exportImport.reserializeIdentical).toBe(true);
    expect(report.exportImport.reimportVerified).toBe(true);
    expect(report.exportImport.reimportBindingVerified).toBe(true);
    expect(report.exportImport.reimportProjectionEquivalent).toBe(true);
  });

  it('compiles the same source twice to byte-identical artifacts (determinism proof)', () => {
    expect(report.determinism.doubleCompileIdenticalBytes).toBe(true);
    expect(report.determinism.doubleCompileIdenticalDigest).toBe(true);
    expect(report.determinism.doubleCompileIdenticalArtifact).toBe(true);
    expect(report.determinism.projectionStable).toBe(true);
  });

  it('rejects IR-valid-but-compiler-unrepresentable sources with typed diagnostics', () => {
    expect(report.rejections.length).toBe(6);
    for (const rejection of report.rejections) {
      expect(rejection.rejected).toBe(true);
      expect(rejection.code).toMatch(/^WORKFLOW_COMPILER_[A-Z_]+$/);
    }
    const codes = report.rejections.map((rejection) => rejection.code);
    expect(codes).toContain('WORKFLOW_COMPILER_PLACEMENT_CONFLICT');
    expect(codes).toContain('WORKFLOW_COMPILER_POLICY_VIOLATION');
    expect(codes).toContain('WORKFLOW_COMPILER_GRAPH_INVALID');
    expect(codes).toContain('WORKFLOW_COMPILER_AMBIGUOUS_INPUT');
    expect(codes).toContain('WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED');
    expect(codes).toContain('WORKFLOW_COMPILER_VERSION_UNSUPPORTED');
  });

  it('all experiment assertions pass', () => {
    expect(report.assertions.length).toBeGreaterThanOrEqual(20);
    expect(report.assertions.filter((assertion) => assertion.passed)).toHaveLength(
      report.assertions.length,
    );
  });

  it('is deterministic: a second run produces the identical experiment report', () => {
    const second = runCompileAndValidateExperiment();
    expect(deterministicReportView(second)).toEqual(deterministicReportView(report));
  });
});
