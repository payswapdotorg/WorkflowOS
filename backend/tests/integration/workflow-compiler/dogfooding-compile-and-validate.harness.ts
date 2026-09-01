import {
  compileWorkflow,
  serializeCompiledWorkflowArtifact,
  parseCompiledWorkflowArtifact,
  verifyCompiledWorkflowArtifact,
  verifySourceVersionBinding,
  computeCompiledWorkflowDigest,
  projectCompiledPlanSemantics,
  WORKFLOW_COMPILER_ID,
  WORKFLOW_COMPILER_VERSION,
  COMPILED_WORKFLOW_OBJECT_TYPE,
  SUPPORTED_WORKFLOW_COMPILER_VERSIONS,
} from '../../../src/workflow-compiler/index.js';
import {
  createWorkflowIrBuilder,
  validateWorkflowIrDocument,
  computeWorkflowVersionSemanticDigest,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowNode } from '../../../src/workflow-ir/index.js';

/**
 * V2-007 dogfooding harness — the REAL compile-and-validate experiment.
 *
 * One real authored workflow (the support-ticket-triage task — the same real
 * task the V2-003 and V2-006 dogfooding rounds exercised) is authored with
 * the merged V2-003 fluent builder, transported through the canonical
 * serializer/parser, compiled by the V2-007 compiler, and validated by the
 * compiler's own conformance surface:
 *
 *   - the source WorkflowVersion semantic digest is computed by the merged
 *     V2-003 implementation (never re-implemented here);
 *   - the compiled semantics are validated against the SAME task through the
 *     deterministic semantic projection (compiled plan → IR-canonical form,
 *     compared against the source IR's own canonical serialization);
 *   - the artifact is exported, compiled TWICE (byte identity), re-imported
 *     and re-validated;
 *   - IR-valid-but-compiler-rejectable sources are rejected through the same
 *     real path with typed diagnostics.
 *
 * Everything is deterministic (pure domain modules; no clock, no randomness,
 * no network). Wall-clock fields are run-instance bookkeeping only — they
 * are excluded by `deterministicReportView` for determinism comparisons.
 */

// ----------------------------------------------------------------------------
// The real task: support-ticket triage, authored through the V2-003 builder
// ----------------------------------------------------------------------------

const issueObjectType = {
  kind: 'object',
  fields: [
    { name: 'title', type: { kind: 'string' } },
    { name: 'body', type: { kind: 'string' } },
  ],
} as const;

const TRIAGE_NODES: WorkflowNode[] = [
  {
    id: 'fetch_issue',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'github.repository.read' },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
      { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
    ],
    outputs: [{ name: 'issue', type: issueObjectType }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'observation',
  },
  {
    id: 'draft_summary',
    executionClass: 'agentic_computer_use',
    spec: {
      class: 'agentic_computer_use',
      task: 'Draft a triage summary and severity classification for the inbound GitHub issue.',
    },
    capabilityRequirements: ['github.repository.read'],
    placement: 'cloud_allowed',
    inputs: [
      {
        name: 'issue',
        type: issueObjectType,
        binding: { kind: 'node_output', node: 'fetch_issue', output: 'issue' },
      },
    ],
    outputs: [
      { name: 'summary', type: { kind: 'string' } },
      { name: 'severity', type: { kind: 'string' } },
    ],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
  },
  {
    id: 'review_gate',
    executionClass: 'human',
    spec: {
      class: 'human',
      human: {
        kind: 'approval',
        instruction: 'Approve posting the triage summary and syncing the backlog for this issue.',
      },
    },
    capabilityRequirements: [],
    placement: 'device_local',
    inputs: [],
    outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'human_confirmation',
  },
  {
    id: 'notify_channel',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'messaging.send' },
    capabilityRequirements: ['messaging.send'],
    placement: 'cloud_preferred',
    inputs: [
      {
        name: 'text',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
      {
        name: 'channel',
        type: { kind: 'string' },
        optional: true,
        binding: { kind: 'workflow_input', input: 'channel' },
      },
      {
        name: 'credentials',
        type: { kind: 'secret' },
        binding: { kind: 'secret_ref', ref: 'team-notifications@secrets' },
      },
    ],
    outputs: [{ name: 'messageId', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'fail_workflow' },
    completionEvidence: 'verification',
  },
  {
    id: 'sync_backlog',
    executionClass: 'subworkflow',
    spec: {
      class: 'subworkflow',
      subworkflow: {
        workflowId: 'wf-backlog-sync',
        versionRef: 'wfv_0192837465afdeadbeef-candidate-1',
      },
    },
    capabilityRequirements: ['workflow.execute'],
    placement: 'any_supported_node',
    inputs: [
      {
        name: 'summary',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ],
    outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
    failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
  },
  {
    id: 'log_rejection',
    executionClass: 'deterministic_api',
    spec: { class: 'deterministic_api', capability: 'filesystem.write' },
    capabilityRequirements: ['filesystem.write'],
    placement: 'device_local',
    inputs: [
      { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'rejected-triage.log' } },
      {
        name: 'content',
        type: { kind: 'string' },
        binding: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
      },
    ],
    outputs: [],
    failurePolicy: { strategy: 'ignore_and_continue' },
  },
];

/** The real workflow authored through the merged V2-003 builder. */
export function authorTriageWorkflow(): WorkflowIrDocument {
  const builder = createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .withDefaultPlacement('any_supported_node')
    .withProvenance({ origin: 'authored' })
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addWorkflowInput({ name: 'channel', type: { kind: 'string' }, optional: true })
    .addWorkflowOutput({
      name: 'summary',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'draft_summary', output: 'summary' },
    })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'notify_channel', output: 'messageId' },
    });
  for (const node of TRIAGE_NODES) {
    builder.addNode(node);
  }
  builder.addEdge({ from: 'fetch_issue', to: 'draft_summary', on: 'success' });
  builder.addEdge({ from: 'draft_summary', to: 'review_gate', on: 'success' });
  builder.addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } });
  builder.addEdge({ from: 'review_gate', to: 'sync_backlog', on: { outcome: 'approved' } });
  builder.addEdge({ from: 'review_gate', to: 'log_rejection', on: { outcome: 'rejected' } });
  return builder.build();
}

// ----------------------------------------------------------------------------
// The report
// ----------------------------------------------------------------------------

export interface CompileAndValidateReport {
  readonly workOrderId: 'V2-007';
  readonly compiler: {
    readonly id: string;
    readonly version: number;
    readonly objectType: string;
    readonly supportedVersions: readonly number[];
  };
  readonly workflow: {
    readonly task: string;
    readonly authoringPath: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly start: string;
    readonly inputCount: number;
    readonly outputCount: number;
  };
  readonly sourceVersion: {
    readonly valid: boolean;
    readonly semanticDigest: string;
    readonly digestAlgorithm: string;
    readonly digestDomain: string;
    readonly irSchemaVersion: number;
    readonly objectType: string;
  };
  readonly compilation: {
    readonly ok: boolean;
    readonly unitCount: number;
    readonly planOrder: readonly string[];
    readonly artifactDigest: string;
    readonly optionsDigest: string;
  };
  readonly conformance: {
    readonly semanticEquivalence: boolean;
    readonly edgeSetPreserved: boolean;
    readonly sourceBindingVerified: boolean;
    readonly artifactVerified: boolean;
    readonly secretRefOpaque: boolean;
    readonly canaryAbsent: boolean;
    readonly generatedSourceHasNoExecutionClaims: boolean;
  };
  readonly exportImport: {
    readonly exportedByteLength: number;
    readonly reimportOk: boolean;
    readonly reserializeIdentical: boolean;
    readonly reimportVerified: boolean;
    readonly reimportBindingVerified: boolean;
    readonly reimportProjectionEquivalent: boolean;
  };
  readonly determinism: {
    readonly doubleCompileIdenticalBytes: boolean;
    readonly doubleCompileIdenticalDigest: boolean;
    readonly doubleCompileIdenticalArtifact: boolean;
    readonly projectionStable: boolean;
  };
  readonly rejections: readonly {
    readonly fixture: string;
    readonly rejected: boolean;
    readonly code: string | null;
    readonly irValid: boolean;
  }[];
  readonly assertions: readonly { readonly name: string; readonly passed: boolean }[];
  readonly wallClockStartedAtMs: number;
  readonly wallDurationMs: number;
}

/** The report minus wall-clock bookkeeping — for determinism comparisons. */
export function deterministicReportView(
  report: CompileAndValidateReport,
): Omit<CompileAndValidateReport, 'wallClockStartedAtMs' | 'wallDurationMs'> {
  const { wallClockStartedAtMs: _started, wallDurationMs: _duration, ...rest } = report;
  return rest;
}

const SECRET_MATERIAL_CANARY = 'ghp_live_DEADBEEF_never_serialize_me';

/** Order-insensitive JSON comparison (deep equality via sorted-key stringification). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      record[key] = sortKeysDeep(source[key]);
    }
    return record;
  }
  return value;
}

// ----------------------------------------------------------------------------
// The experiment
// ----------------------------------------------------------------------------

export function runCompileAndValidateExperiment(): CompileAndValidateReport {
  const wallClockStartedAtMs = Date.now();
  const assertions: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, passed: boolean): void => {
    assertions.push({ name, passed });
  };

  // --- 1. author the real workflow with the merged V2-003 builder ---
  const authored = authorTriageWorkflow();
  const irValidation = validateWorkflowIrDocument(authored);
  check('authored workflow is a valid WorkflowIR document', irValidation.ok);

  // --- 2. compute the REAL source WorkflowVersion semantic digest (merged V2-003) ---
  const sourceDigest = computeWorkflowVersionSemanticDigest(authored);
  check(
    'source semantic digest is sha-256 under the workflow-ir domain',
    sourceDigest.algorithm === 'sha-256' && sourceDigest.domain === 'workflowos/workflow-ir/v1',
  );
  check(
    'source semantic digest matches the merged triage fixture digest (cross-client)',
    sourceDigest.digest === '571a0788c4eea5f1491c1a3931b54c1f8efdeec72faac91638d259cc0b408c37',
  );

  // --- 3. transport round-trip, then compile with the V2-007 compiler ---
  const transportBytes = JSON.stringify(authored);
  const reparsed = JSON.parse(transportBytes) as WorkflowIrDocument;
  const compiled = compileWorkflow(reparsed);
  check('compilation succeeds through the real path', compiled.ok);

  if (!compiled.ok) {
    // fail fast with an honest report (the runner exits non-zero)
    const failedReport: CompileAndValidateReport = {
      workOrderId: 'V2-007',
      compiler: {
        id: WORKFLOW_COMPILER_ID,
        version: WORKFLOW_COMPILER_VERSION,
        objectType: COMPILED_WORKFLOW_OBJECT_TYPE,
        supportedVersions: [...SUPPORTED_WORKFLOW_COMPILER_VERSIONS],
      },
      workflow: {
        task: 'support-ticket triage',
        authoringPath: 'workflow-ir-builder',
        nodeCount: authored.ir.nodes.length,
        edgeCount: authored.ir.edges.length,
        start: authored.ir.start,
        inputCount: authored.ir.inputs.length,
        outputCount: authored.ir.outputs.length,
      },
      sourceVersion: {
        valid: irValidation.ok,
        semanticDigest: sourceDigest.digest,
        digestAlgorithm: sourceDigest.algorithm,
        digestDomain: sourceDigest.domain,
        irSchemaVersion: authored.irSchemaVersion,
        objectType: authored.objectType,
      },
      compilation: {
        ok: false,
        unitCount: 0,
        planOrder: [],
        artifactDigest: '',
        optionsDigest: '',
      },
      conformance: {
        semanticEquivalence: false,
        edgeSetPreserved: false,
        sourceBindingVerified: false,
        artifactVerified: false,
        secretRefOpaque: false,
        canaryAbsent: false,
        generatedSourceHasNoExecutionClaims: false,
      },
      exportImport: {
        exportedByteLength: 0,
        reimportOk: false,
        reserializeIdentical: false,
        reimportVerified: false,
        reimportBindingVerified: false,
        reimportProjectionEquivalent: false,
      },
      determinism: {
        doubleCompileIdenticalBytes: false,
        doubleCompileIdenticalDigest: false,
        doubleCompileIdenticalArtifact: false,
        projectionStable: false,
      },
      rejections: [],
      assertions,
      wallClockStartedAtMs,
      wallDurationMs: Date.now() - wallClockStartedAtMs,
    };
    return failedReport;
  }

  const artifact = compiled.artifact;

  // --- 4. provenance: compiler identity + source WorkflowVersion binding ---
  check(
    'artifact provenance records the compiler identity and version',
    artifact.provenance.compiler.id === WORKFLOW_COMPILER_ID &&
      artifact.provenance.compiler.version === WORKFLOW_COMPILER_VERSION,
  );
  check(
    'artifact carries the source WorkflowVersion semantic digest',
    artifact.provenance.source.semanticDigest === sourceDigest.digest,
  );
  const bindingVerified = verifySourceVersionBinding(artifact, authored);
  check('source-version binding verifies against the authored document', bindingVerified);

  // --- 5. artifact identity + integrity ---
  const digest = computeCompiledWorkflowDigest(artifact);
  check(
    'artifact digest is sha-256 under the compiler-owned domain and matches the embedded digest',
    digest.algorithm === 'sha-256' &&
      digest.domain === COMPILED_WORKFLOW_OBJECT_TYPE &&
      digest.digest === artifact.artifactDigest,
  );
  const artifactVerified = verifyCompiledWorkflowArtifact(artifact).ok;
  check('the artifact verifies (shape, version, digest integrity)', artifactVerified);

  // --- 6. inspectable plan facts ---
  const planOrder = artifact.plan.units.map((unit) => unit.unit);
  check(
    'the plan compiles all 6 steps in deterministic breadth-first order',
    planOrder.join(',') === 'fetch_issue,draft_summary,review_gate,log_rejection,notify_channel,sync_backlog',
  );
  const gate = artifact.plan.units.find((unit) => unit.unit === 'review_gate');
  check(
    'the human approval gate flattens to outcome continuations (no success edges, 3-edge fan-out)',
    gate !== undefined &&
      gate.onSuccess.length === 0 &&
      gate.onFailure === null &&
      gate.onOutcomes.length === 3,
  );
  const notify = artifact.plan.units.find((unit) => unit.unit === 'notify_channel');
  const credentials = notify?.inputs.find((input) => input.name === 'credentials');
  const secretRefOpaque =
    credentials !== undefined &&
    credentials.type.kind === 'secret' &&
    credentials.binding.kind === 'secret_ref' &&
    credentials.binding.ref === 'team-notifications@secrets';
  check('secret credentials pass through as an opaque secret_ref handle only', secretRefOpaque);

  // --- 7. conformance: deterministic semantic projection vs the IR's declared semantics ---
  const projection = projectCompiledPlanSemantics(artifact);
  const canonicalIr = (JSON.parse(
    // the merged V2-003 canonical serializer (real code path, not reimplemented)
    serializeWorkflowIrDocument(authored),
  ) as unknown as { ir: unknown }).ir;
  const semanticEquivalence = stableStringify(projection) === stableStringify(canonicalIr);
  check(
    'compiled semantics project back EXACTLY to the source IR declared semantics',
    semanticEquivalence,
  );
  // The edge set is a SET (V2-003 schema): preservation is multiset equality,
  // never authoring-order equality — the projection emits edges in canonical
  // order while `authored.ir.edges` retains the builder's authoring order.
  // Compare canonically keyed edge multisets so a dropped, added, mutated or
  // duplicated edge each fails the check.
  const edgeMultisetKey = (edges: readonly unknown[]): string =>
    edges
      .map((edge) => stableStringify(edge))
      .sort()
      .join('\n');
  const reconstructedEdges = (projection as { edges: unknown[] }).edges;
  const sourceEdges = authored.ir.edges as readonly unknown[];
  const edgeSetPreserved =
    edgeMultisetKey(reconstructedEdges) === edgeMultisetKey(sourceEdges);
  check('the control-edge set is preserved by the flattening (ordering semantics)', edgeSetPreserved);

  // --- 8. secret non-leakage over the exported bytes ---
  const exportedBytes = serializeCompiledWorkflowArtifact(artifact);
  const canaryAbsent =
    !exportedBytes.includes(SECRET_MATERIAL_CANARY) &&
    !exportedBytes.includes('ghp_live') &&
    !exportedBytes.includes('DEADBEEF') &&
    exportedBytes.includes('team-notifications@secrets');
  check('exported artifact bytes carry the opaque secret reference and never secret material', canaryAbsent);

  // --- 9. generated intent is not proof of execution ---
  const generatedDocument: WorkflowIrDocument = {
    ...authored,
    ir: {
      ...authored.ir,
      provenance: { origin: 'compiled', sourceRefs: ['model-session:v0-neutral-planner:run-42'] },
    },
  };
  const generatedCompiled = compileWorkflow(generatedDocument);
  let generatedSourceHasNoExecutionClaims = false;
  if (generatedCompiled.ok) {
    const generatedBytes = serializeCompiledWorkflowArtifact(generatedCompiled.artifact);
    generatedSourceHasNoExecutionClaims =
      Object.keys(generatedCompiled.artifact).sort().join(',') === 'artifactDigest,objectType,plan,provenance' &&
      !/"status"\s*:|"executed"|"startedAt"|"completedAt"|"runId"|attestation|proof/i.test(generatedBytes);
  }
  check(
    'a model-generated source compiles to inspectable data with NO execution/proof claims',
    generatedSourceHasNoExecutionClaims,
  );

  // --- 10. export → import → re-verify ---
  const imported = parseCompiledWorkflowArtifact(exportedBytes);
  const reimportOk = imported.ok;
  let reserializeIdentical = false;
  let reimportVerified = false;
  let reimportBindingVerified = false;
  let reimportProjectionEquivalent = false;
  if (imported.ok) {
    reserializeIdentical = serializeCompiledWorkflowArtifact(imported.artifact) === exportedBytes;
    reimportVerified = verifyCompiledWorkflowArtifact(imported.artifact).ok;
    reimportBindingVerified = verifySourceVersionBinding(imported.artifact, authored);
    reimportProjectionEquivalent =
      stableStringify(projectCompiledPlanSemantics(imported.artifact)) === stableStringify(projection);
  }
  check('the compiled artifact re-imports from its exported bytes', reimportOk);
  check('re-imported bytes serialize identically (lossless round-trip)', reserializeIdentical);
  check('the re-imported artifact re-verifies (digest + provenance intact)', reimportVerified);
  check('the re-imported artifact still binds to the source WorkflowVersion', reimportBindingVerified);
  check('the re-imported plan still projects to the source IR semantics', reimportProjectionEquivalent);

  // --- 11. compile TWICE: byte-identical output (determinism proof) ---
  const secondCompile = compileWorkflow(reparsed);
  const doubleCompileIdenticalArtifact = secondCompile.ok
    ? stableStringify(secondCompile.artifact) === stableStringify(artifact)
    : false;
  const secondBytes = secondCompile.ok
    ? serializeCompiledWorkflowArtifact(secondCompile.artifact)
    : '';
  const doubleCompileIdenticalBytes = secondBytes === exportedBytes;
  const doubleCompileIdenticalDigest =
    secondCompile.ok && secondCompile.artifact.artifactDigest === artifact.artifactDigest;
  check('compiling the same source twice yields the byte-identical artifact', doubleCompileIdenticalBytes);
  check('the double-compilation digests are identical', doubleCompileIdenticalDigest);
  check('the double-compilation artifacts are deeply equal', doubleCompileIdenticalArtifact);
  const projectionStable = stableStringify(projectCompiledPlanSemantics(artifact)) === stableStringify(projection);
  check('the semantic projection is stable across repeated evaluation', projectionStable);

  // --- 12. IR-valid-but-compiler-rejectable sources fail closed through the real path ---
  const rejectionCases: Array<{ fixture: string; document: WorkflowIrDocument; expectedCode: string }> = [
    {
      fixture: 'placement conflict (cloud_required default + device_local nodes)',
      document: { ...authored, ir: { ...authored.ir, defaultPlacement: 'cloud_required' } },
      expectedCode: 'WORKFLOW_COMPILER_PLACEMENT_CONFLICT',
    },
    {
      fixture: 'human pause point with a retry budget',
      document: {
        ...authored,
        ir: {
          ...authored.ir,
          nodes: authored.ir.nodes.map((node) =>
            node.id === 'review_gate'
              ? { ...node, failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 } }
              : node,
          ),
        },
      },
      expectedCode: 'WORKFLOW_COMPILER_POLICY_VIOLATION',
    },
    {
      fixture: 'cyclic control graph (back edge log_rejection → draft_summary)',
      document: {
        ...authored,
        ir: {
          ...authored.ir,
          edges: [...authored.ir.edges, { from: 'log_rejection', to: 'draft_summary', on: 'success' }],
        },
      },
      expectedCode: 'WORKFLOW_COMPILER_GRAPH_INVALID',
    },
    {
      fixture: 'duplicate capability requirements',
      document: {
        ...authored,
        ir: {
          ...authored.ir,
          nodes: authored.ir.nodes.map((node) =>
            node.id === 'fetch_issue'
              ? { ...node, capabilityRequirements: ['github.repository.read', 'github.repository.read'] }
              : node,
          ),
        },
      },
      expectedCode: 'WORKFLOW_COMPILER_AMBIGUOUS_INPUT',
    },
    {
      fixture: 'undeclared invoked capability (messaging.send not in requirements)',
      document: {
        ...authored,
        ir: {
          ...authored.ir,
          nodes: authored.ir.nodes.map((node) =>
            node.id === 'notify_channel' ? { ...node, capabilityRequirements: ['messaging.observe'] } : node,
          ),
        },
      },
      expectedCode: 'WORKFLOW_COMPILER_CAPABILITY_UNSUPPORTED',
    },
  ];
  const rejections = rejectionCases.map((rejectionCase) => {
    const irValid = validateWorkflowIrDocument(rejectionCase.document).ok;
    const result = compileWorkflow(rejectionCase.document);
    const code = result.ok ? null : result.diagnostics[0]?.code ?? null;
    check(
      `rejectable fixture rejected with a typed diagnostic: ${rejectionCase.fixture}`,
      !result.ok && code === rejectionCase.expectedCode && irValid,
    );
    return { fixture: rejectionCase.fixture, rejected: !result.ok, code, irValid };
  });
  const versionRejection = compileWorkflow(authored, { compilerVersion: 2 });
  const versionRejected = !versionRejection.ok;
  const versionCode = versionRejection.ok ? null : versionRejection.diagnostics[0]?.code ?? null;
  check(
    'an unsupported requested compiler version is rejected fail-closed',
    versionRejected && versionCode === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED',
  );
  rejections.push({
    fixture: 'unsupported requested compiler version (2)',
    rejected: versionRejected,
    code: versionCode,
    irValid: true,
  });

  return {
    workOrderId: 'V2-007',
    compiler: {
      id: WORKFLOW_COMPILER_ID,
      version: WORKFLOW_COMPILER_VERSION,
      objectType: COMPILED_WORKFLOW_OBJECT_TYPE,
      supportedVersions: [...SUPPORTED_WORKFLOW_COMPILER_VERSIONS],
    },
    workflow: {
      task: 'support-ticket triage',
      authoringPath: 'workflow-ir-builder',
      nodeCount: authored.ir.nodes.length,
      edgeCount: authored.ir.edges.length,
      start: authored.ir.start,
      inputCount: authored.ir.inputs.length,
      outputCount: authored.ir.outputs.length,
    },
    sourceVersion: {
      valid: irValidation.ok,
      semanticDigest: sourceDigest.digest,
      digestAlgorithm: sourceDigest.algorithm,
      digestDomain: sourceDigest.domain,
      irSchemaVersion: authored.irSchemaVersion,
      objectType: authored.objectType,
    },
    compilation: {
      ok: true,
      unitCount: artifact.plan.units.length,
      planOrder,
      artifactDigest: artifact.artifactDigest,
      optionsDigest: artifact.provenance.optionsDigest,
    },
    conformance: {
      semanticEquivalence,
      edgeSetPreserved,
      sourceBindingVerified: bindingVerified,
      artifactVerified,
      secretRefOpaque,
      canaryAbsent,
      generatedSourceHasNoExecutionClaims,
    },
    exportImport: {
      exportedByteLength: exportedBytes.length,
      reimportOk,
      reserializeIdentical,
      reimportVerified,
      reimportBindingVerified,
      reimportProjectionEquivalent,
    },
    determinism: {
      doubleCompileIdenticalBytes,
      doubleCompileIdenticalDigest,
      doubleCompileIdenticalArtifact,
      projectionStable,
    },
    rejections,
    assertions,
    wallClockStartedAtMs,
    wallDurationMs: Date.now() - wallClockStartedAtMs,
  };
}
