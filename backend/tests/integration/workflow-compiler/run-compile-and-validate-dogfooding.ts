import { runCompileAndValidateExperiment } from './dogfooding-compile-and-validate.harness.js';

/**
 * V2-007 — standalone dogfooding RUN (real process, real product paths).
 *
 * Usage (from backend/):
 *   bunx tsx tests/integration/workflow-compiler/run-compile-and-validate-dogfooding.ts
 *
 * Executes the compile-and-validate experiment in a real process: the real
 * support-ticket-triage workflow authored through the merged V2-003 builder,
 * compiled by the V2-007 compiler, validated against the same task through
 * the deterministic semantic projection, exported, compiled twice (byte
 * identity), re-imported and re-validated. Prints the structured transcript
 * that is persisted (verbatim) as dogfooding evidence at
 * spec/architecture/v2/dogfooding-evidence/V2-007-compile-and-validate.md.
 *
 * Exits non-zero when any experiment assertion fails (fail-closed runner).
 */

function line(label: string, value: string): string {
  return `  ${label.padEnd(46, ' ')} ${value}`;
}

const report = runCompileAndValidateExperiment();

const out: string[] = [];
out.push('V2-007 compile-and-validate — dogfooding run');
out.push(`work order: ${report.workOrderId} (workflow compiler v${report.compiler.version})`);
out.push(`compiler object type: ${report.compiler.objectType}`);
out.push(`supported compiler versions: ${report.compiler.supportedVersions.join(', ')}`);
out.push(`wall clock start (ms): ${report.wallClockStartedAtMs}`);
out.push(`wall duration (ms): ${report.wallDurationMs}`);
out.push('');
out.push('workflow under test (authored with the merged V2-003 builder):');
out.push(line('task', report.workflow.task));
out.push(line('authoring path', report.workflow.authoringPath));
out.push(line('nodes / edges', `${report.workflow.nodeCount} / ${report.workflow.edgeCount}`));
out.push(line('start', report.workflow.start));
out.push(line('workflow inputs / outputs', `${report.workflow.inputCount} / ${report.workflow.outputCount}`));
out.push('');
out.push('source WorkflowVersion identity (computed by merged V2-003):');
out.push(line('valid WorkflowIR document', String(report.sourceVersion.valid)));
out.push(line('semantic digest', report.sourceVersion.semanticDigest));
out.push(line('digest algorithm / domain', `${report.sourceVersion.digestAlgorithm} / ${report.sourceVersion.digestDomain}`));
out.push(line('IR schema version / object type', `${report.sourceVersion.irSchemaVersion} / ${report.sourceVersion.objectType}`));
out.push('');
out.push('compilation:');
out.push(line('compiled', String(report.compilation.ok)));
out.push(line('compiled units', String(report.compilation.unitCount)));
out.push(line('plan order (BFS)', report.compilation.planOrder.join(' -> ')));
out.push(line('artifact digest', report.compilation.artifactDigest));
out.push(line('options digest', report.compilation.optionsDigest));
out.push('');
out.push('conformance validation (deterministic semantic projection vs the IR):');
out.push(line('semantic equivalence (projection === IR)', String(report.conformance.semanticEquivalence)));
out.push(line('control-edge set preserved', String(report.conformance.edgeSetPreserved)));
out.push(line('source-version binding verified', String(report.conformance.sourceBindingVerified)));
out.push(line('artifact verified (shape+version+digest)', String(report.conformance.artifactVerified)));
out.push(line('secret credentials opaque (secret_ref only)', String(report.conformance.secretRefOpaque)));
out.push(line('secret material absent from exported bytes', String(report.conformance.canaryAbsent)));
out.push(line('generated source → no execution claims', String(report.conformance.generatedSourceHasNoExecutionClaims)));
out.push('');
out.push('export / import:');
out.push(line('exported bytes', String(report.exportImport.exportedByteLength)));
out.push(line('re-import ok', String(report.exportImport.reimportOk)));
out.push(line('re-serialize identical', String(report.exportImport.reserializeIdentical)));
out.push(line('re-imported artifact verified', String(report.exportImport.reimportVerified)));
out.push(line('re-imported binding verified', String(report.exportImport.reimportBindingVerified)));
out.push(line('re-imported projection equivalent', String(report.exportImport.reimportProjectionEquivalent)));
out.push('');
out.push('determinism (compile twice):');
out.push(line('byte-identical artifacts', String(report.determinism.doubleCompileIdenticalBytes)));
out.push(line('identical digests', String(report.determinism.doubleCompileIdenticalDigest)));
out.push(line('deeply equal artifacts', String(report.determinism.doubleCompileIdenticalArtifact)));
out.push(line('stable semantic projection', String(report.determinism.projectionStable)));
out.push('');
out.push('IR-valid-but-compiler-rejectable sources (typed diagnostics, no partial artifacts):');
for (const rejection of report.rejections) {
  out.push(line(`rejected: ${rejection.fixture}`, `${rejection.rejected} [${rejection.code ?? 'n/a'}] ir-valid=${rejection.irValid}`));
}
out.push('');
out.push(`assertions: ${report.assertions.filter((a) => a.passed).length}/${report.assertions.length} passed`);
for (const assertion of report.assertions) {
  out.push(line(assertion.passed ? 'PASS' : 'FAIL', assertion.name));
}
out.push('');
const allPassed = report.assertions.every((assertion) => assertion.passed);
out.push(
  allPassed
    ? 'RESULT: compiled semantics validated against the same real task — deterministic, provenance-bound, secret-safe'
    : 'RESULT: ASSERTION FAILURE — the compile-and-validate experiment failed (see FAIL lines above)',
);

process.stdout.write(`${out.join('\n')}\n`);
if (!allPassed) {
  process.exitCode = 1;
}
