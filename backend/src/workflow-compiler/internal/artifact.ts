/**
 * V2-007 — the compiled-workflow artifact: digest, canonical preimage,
 * serialization, parsing and verification.
 *
 * The artifact digest is sha-256 over canonical JSON of the artifact's
 * semantic body `{objectType, plan, provenance}` (the embedded
 * `artifactDigest` is excluded from its own preimage). The preimage embeds
 * the compiler-owned object type `workflowos/compiled-workflow/v1`, so the
 * digest is DOMAIN-SEPARATED from the WorkflowIR semantic digest (V2-003,
 * domain workflowos/workflow-ir/v1) and from every registry execution-
 * attestation object type (V2-014) — it commits to compiled-plan bytes only
 * and never to execution facts.
 *
 * Parse/verify are fail-closed and total: malformed shape, unknown keys (no
 * smuggling surface — extra keys are NOT part of the digest preimage, so the
 * shape check is load-bearing), unsupported compiler versions, wrong object
 * types and stale digests are typed rejections. A well-formed artifact
 * contains no execution-status fields anywhere (compiling is not executing).
 */
import { createHash } from 'node:crypto';
import { WORKFLOW_IR_OBJECT_TYPE } from '../../workflow-ir/index.js';
import type {
  CompiledArtifactParseResult,
  CompiledArtifactVerification,
  CompiledWorkflowArtifact,
  CompiledWorkflowDigest,
  CompiledWorkflowPlan,
  CompiledWorkflowProvenance,
  CompileDiagnostic,
} from '../types.js';
import { COMPILED_WORKFLOW_OBJECT_TYPE, SUPPORTED_WORKFLOW_COMPILER_VERSIONS } from '../types.js';
import { isJsonValue, isPlainObject, canonicalJsonStringify } from './canonical-json.js';
import { isCanonicalCapability, isCanonicalExecutionClass, isCanonicalPlacement } from './vocabulary.js';

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ============================================================================
// §1  Digest and canonical preimage
// ============================================================================

/** sha-256 (hex) of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The canonical digest preimage of an artifact body (plan + provenance, with
 * the compiler-owned object type). The embedded `artifactDigest` is never
 * part of its own preimage.
 */
export function artifactPreimage(
  plan: CompiledWorkflowPlan,
  provenance: CompiledWorkflowProvenance,
): string {
  return canonicalJsonStringify({ objectType: COMPILED_WORKFLOW_OBJECT_TYPE, plan, provenance });
}

/** The canonical preimage of a complete artifact (digest excluded). */
export function canonicalArtifactPreimage(artifact: CompiledWorkflowArtifact): string {
  return artifactPreimage(artifact.plan, artifact.provenance);
}

/**
 * The compiled-artifact digest: sha-256 over the canonical preimage, under
 * the compiler-owned domain `workflowos/compiled-workflow/v1`.
 */
export function computeCompiledWorkflowDigest(artifact: CompiledWorkflowArtifact): CompiledWorkflowDigest {
  return {
    algorithm: 'sha-256',
    domain: COMPILED_WORKFLOW_OBJECT_TYPE,
    digest: sha256Hex(canonicalArtifactPreimage(artifact)),
  };
}

// ============================================================================
// §2  Serialization (canonical bytes)
// ============================================================================

/**
 * Serialize a compiled artifact to canonical JSON text: deterministic key
 * order, set-normalized collections, no insignificant whitespace. Same
 * artifact → identical bytes, always.
 */
export function serializeCompiledWorkflowArtifact(artifact: CompiledWorkflowArtifact): string {
  return canonicalJsonStringify({ ...artifact });
}

// ============================================================================
// §3  Parse and verify (fail-closed, total)
// ============================================================================

/**
 * Parse and validate a serialized compiled artifact (the import path).
 * Accepts any JSON text; everything ambiguous, malformed, smuggled,
 * version-unsupported or digest-inconsistent is a typed rejection.
 */
export function parseCompiledWorkflowArtifact(text: string): CompiledArtifactParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        invalid('$', `compiled artifact is not valid JSON: ${(error as Error).message}`),
      ],
    };
  }
  return verifyArtifactValue(parsed);
}

/**
 * Verify an in-memory compiled artifact: closed shape, supported compiler
 * version, and a digest that matches the recomputed canonical preimage.
 */
export function verifyCompiledWorkflowArtifact(artifact: unknown): CompiledArtifactVerification {
  const result = verifyArtifactValue(artifact);
  if (result.ok) return { ok: true };
  return { ok: false, diagnostics: result.diagnostics };
}

// ============================================================================
// §4  The shared fail-closed validation path
// ============================================================================

function verifyArtifactValue(value: unknown): CompiledArtifactParseResult {
  const diagnostics: CompileDiagnostic[] = [];

  // ---- top-level shape: exactly {artifactDigest, objectType, plan, provenance} ----
  if (!isPlainObject(value)) {
    return { ok: false, diagnostics: [invalid('$', 'compiled artifact must be a JSON object')] };
  }
  checkExactKeys(value, '$', ['artifactDigest', 'objectType', 'plan', 'provenance'], [], diagnostics);

  if (value['objectType'] !== COMPILED_WORKFLOW_OBJECT_TYPE) {
    diagnostics.push(
      invalid('$.objectType', `objectType must be "${COMPILED_WORKFLOW_OBJECT_TYPE}"`),
    );
  }
  const artifactDigest = value['artifactDigest'];
  if (typeof artifactDigest !== 'string' || !SHA_256_HEX_PATTERN.test(artifactDigest)) {
    diagnostics.push(invalid('$.artifactDigest', 'artifactDigest must be a 64-hex sha-256 string'));
  }

  // ---- provenance (validated before the digest so version problems classify correctly) ----
  const provenance = validateProvenance(value['provenance'], diagnostics);

  // ---- plan ----
  const plan = validatePlan(value['plan'], diagnostics);

  // ---- compiler version gate ----
  if (provenance !== undefined && !diagnostics.some((d) => d.code === 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED')) {
    const version = provenance.compiler.version;
    if (!SUPPORTED_WORKFLOW_COMPILER_VERSIONS.includes(version)) {
      diagnostics.push(
        versionUnsupported(
          '$.provenance.compiler.version',
          `artifact declares compiler version ${version}, which this build does not support (supported: ${SUPPORTED_WORKFLOW_COMPILER_VERSIONS.join(', ')}) — fail closed, never guess forward`,
        ),
      );
    }
  }

  // ---- digest integrity (load-bearing: the plan and provenance are covered) ----
  if (
    diagnostics.length === 0 &&
    typeof artifactDigest === 'string' &&
    plan !== undefined &&
    provenance !== undefined
  ) {
    const recomputed = sha256Hex(artifactPreimage(plan, provenance));
    if (recomputed !== artifactDigest) {
      diagnostics.push(
        invalid(
          '$.artifactDigest',
          'artifact digest mismatch: the plan/provenance body does not hash to the embedded digest (artifact is stale or tampered)',
        ),
      );
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, artifact: value as unknown as CompiledWorkflowArtifact };
}

function validateProvenance(value: unknown, diagnostics: CompileDiagnostic[]): CompiledWorkflowProvenance | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid('$.provenance', 'provenance must be an object'));
    return undefined;
  }
  checkExactKeys(value, '$.provenance', ['compiler', 'optionsDigest', 'source'], [], diagnostics);

  const compiler = value['compiler'];
  if (!isPlainObject(compiler)) {
    diagnostics.push(invalid('$.provenance.compiler', 'compiler provenance must be an object'));
  } else {
    checkExactKeys(compiler, '$.provenance.compiler', ['id', 'version'], [], diagnostics);
    if (typeof compiler['id'] !== 'string' || compiler['id'].length === 0) {
      diagnostics.push(invalid('$.provenance.compiler.id', 'compiler id must be a non-empty string'));
    }
    if (
      typeof compiler['version'] !== 'number' ||
      !Number.isInteger(compiler['version']) ||
      compiler['version'] < 1
    ) {
      diagnostics.push(
        invalid('$.provenance.compiler.version', 'compiler version must be an integer ≥ 1'),
      );
    }
  }

  if (typeof value['optionsDigest'] !== 'string' || !SHA_256_HEX_PATTERN.test(value['optionsDigest'])) {
    diagnostics.push(invalid('$.provenance.optionsDigest', 'optionsDigest must be a 64-hex sha-256 string'));
  }

  const source = value['source'];
  if (!isPlainObject(source)) {
    diagnostics.push(invalid('$.provenance.source', 'source provenance must be an object'));
    return undefined;
  }
  checkExactKeys(
    source,
    '$.provenance.source',
    ['digestAlgorithm', 'digestDomain', 'irSchemaVersion', 'objectType', 'origin', 'semanticDigest'],
    ['sourceRefs'],
    diagnostics,
  );
  if (source['digestAlgorithm'] !== 'sha-256') {
    diagnostics.push(invalid('$.provenance.source.digestAlgorithm', 'source digest algorithm must be "sha-256"'));
  }
  if (source['digestDomain'] !== WORKFLOW_IR_OBJECT_TYPE) {
    diagnostics.push(
      invalid('$.provenance.source.digestDomain', `source digest domain must be "${WORKFLOW_IR_OBJECT_TYPE}"`),
    );
  }
  if (source['objectType'] !== WORKFLOW_IR_OBJECT_TYPE) {
    diagnostics.push(invalid('$.provenance.source.objectType', `source object type must be "${WORKFLOW_IR_OBJECT_TYPE}"`));
  }
  if (
    typeof source['irSchemaVersion'] !== 'number' ||
    !Number.isInteger(source['irSchemaVersion']) ||
    source['irSchemaVersion'] < 1
  ) {
    diagnostics.push(invalid('$.provenance.source.irSchemaVersion', 'source IR schema version must be an integer ≥ 1'));
  }
  if (!['authored', 'compiled', 'imported'].includes(String(source['origin']))) {
    diagnostics.push(invalid('$.provenance.source.origin', 'source origin must be authored, compiled or imported'));
  }
  if (typeof source['semanticDigest'] !== 'string' || !SHA_256_HEX_PATTERN.test(source['semanticDigest'])) {
    diagnostics.push(invalid('$.provenance.source.semanticDigest', 'source semantic digest must be a 64-hex sha-256 string'));
  }
  if (source['sourceRefs'] !== undefined) {
    const refs = source['sourceRefs'];
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')) {
      diagnostics.push(invalid('$.provenance.source.sourceRefs', 'sourceRefs must be an array of strings'));
    }
  }

  if (diagnostics.length > 0) return undefined;
  return value as unknown as CompiledWorkflowProvenance;
}

function validatePlan(value: unknown, diagnostics: CompileDiagnostic[]): CompiledWorkflowPlan | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid('$.plan', 'plan must be an object'));
    return undefined;
  }
  checkExactKeys(value, '$.plan', ['entry', 'units', 'inputs', 'outputs', 'defaultPlacement'], [], diagnostics);

  if (typeof value['entry'] !== 'string' || !IDENTIFIER_PATTERN.test(value['entry'])) {
    diagnostics.push(invalid('$.plan.entry', 'plan entry must be a unit identifier'));
  }
  if (typeof value['defaultPlacement'] !== 'string' || !isCanonicalPlacement(value['defaultPlacement'])) {
    diagnostics.push(invalid('$.plan.defaultPlacement', 'defaultPlacement must be a canonical registry placement identifier'));
  }

  validatePorts(value['inputs'], '$.plan.inputs', diagnostics);
  validateWorkflowOutputs(value['outputs'], '$.plan.outputs', diagnostics);

  const units = value['units'];
  if (!Array.isArray(units) || units.length === 0) {
    diagnostics.push(invalid('$.plan.units', 'plan must declare at least one unit'));
    return undefined;
  }

  const unitIds = new Set<string>();
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const unitId = validateUnit(unit, `$.plan.units[${i}]`, diagnostics);
    if (unitId !== undefined) {
      if (unitIds.has(unitId)) {
        diagnostics.push(invalid(`$.plan.units[${i}]`, `duplicate unit id "${unitId}"`));
      }
      unitIds.add(unitId);
    }
  }

  const entry = value['entry'];
  if (typeof entry === 'string' && unitIds.size > 0 && !unitIds.has(entry)) {
    diagnostics.push(invalentry(entry));
  }

  // successor references must resolve to declared units
  if (unitIds.size > 0) {
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (!isPlainObject(unit)) continue;
      const unitId = unit['unit'];
      const successors: unknown[] = Array.isArray(unit['onSuccess']) ? [...unit['onSuccess']] : [];
      if (typeof unit['onFailure'] === 'string') successors.push(unit['onFailure']);
      if (Array.isArray(unit['onOutcomes'])) {
        for (const outcome of unit['onOutcomes']) {
          if (isPlainObject(outcome) && typeof outcome['to'] === 'string') {
            successors.push(outcome['to']);
          }
        }
      }
      for (const target of successors) {
        if (typeof target === 'string' && !unitIds.has(target)) {
          diagnostics.push(
            invalid(`$.plan.units[${i}]`, `unit "${String(unitId)}" references unknown successor unit "${target}"`),
          );
        }
      }
    }
  }

  if (diagnostics.length > 0) return undefined;
  return value as unknown as CompiledWorkflowPlan;
}

function invalentry(entry: string): CompileDiagnostic {
  return invalid('$.plan.entry', `plan entry "${entry}" is not a declared unit`);
}

function validateUnit(value: unknown, path: string, diagnostics: CompileDiagnostic[]): string | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid(path, 'unit must be an object'));
    return undefined;
  }
  checkExactKeys(
    value,
    path,
    [
      'unit',
      'executionClass',
      'spec',
      'capabilityRequirements',
      'placement',
      'inputs',
      'outputs',
      'failurePolicy',
      'onSuccess',
      'onFailure',
      'onOutcomes',
    ],
    ['completionEvidence'],
    diagnostics,
  );

  const unit = value['unit'];
  if (typeof unit !== 'string' || !IDENTIFIER_PATTERN.test(unit)) {
    diagnostics.push(invalid(`${path}.unit`, 'unit id must be an identifier'));
    return undefined;
  }

  if (typeof value['executionClass'] !== 'string' || !isCanonicalExecutionClass(value['executionClass'])) {
    diagnostics.push(invalid(`${path}.executionClass`, 'executionClass must be a canonical registry execution class'));
  }
  if (typeof value['placement'] !== 'string' || !isCanonicalPlacement(value['placement'])) {
    diagnostics.push(invalid(`${path}.placement`, 'placement must be a canonical registry placement identifier'));
  }

  const requirements = value['capabilityRequirements'];
  if (!Array.isArray(requirements)) {
    diagnostics.push(invalid(`${path}.capabilityRequirements`, 'capabilityRequirements must be an array'));
  } else {
    for (let i = 0; i < requirements.length; i += 1) {
      const requirement = requirements[i];
      if (typeof requirement !== 'string' || !isCanonicalCapability(requirement)) {
        diagnostics.push(
          invalid(
            `${path}.capabilityRequirements[${i}]`,
            `"${String(requirement)}" is not a canonical registry capability name (aliases are forbidden)`,
          ),
        );
      }
    }
  }

  validateSpec(value['spec'], `${path}.spec`, diagnostics);
  validateFailurePolicy(value['failurePolicy'], `${path}.failurePolicy`, diagnostics);

  if (value['completionEvidence'] !== undefined) {
    const evidence = value['completionEvidence'];
    if (typeof evidence !== 'string' || !['observation', 'verification', 'human_confirmation'].includes(evidence)) {
      diagnostics.push(
        invalid(`${path}.completionEvidence`, 'completionEvidence must be observation, verification or human_confirmation'),
      );
    }
  }

  validatePorts(value['inputs'], `${path}.inputs`, diagnostics, true);
  validatePorts(value['outputs'], `${path}.outputs`, diagnostics);

  const onSuccess = value['onSuccess'];
  if (!Array.isArray(onSuccess) || onSuccess.some((target) => typeof target !== 'string')) {
    diagnostics.push(invalid(`${path}.onSuccess`, 'onSuccess must be an array of unit ids'));
  }
  const onFailure = value['onFailure'];
  if (onFailure !== null && typeof onFailure !== 'string') {
    diagnostics.push(invalid(`${path}.onFailure`, 'onFailure must be a unit id or null'));
  }
  const onOutcomes = value['onOutcomes'];
  if (!Array.isArray(onOutcomes)) {
    diagnostics.push(invalid(`${path}.onOutcomes`, 'onOutcomes must be an array'));
  } else {
    for (let i = 0; i < onOutcomes.length; i += 1) {
      const outcome = onOutcomes[i];
      if (
        !isPlainObject(outcome) ||
        Object.keys(outcome).length !== 2 ||
        typeof outcome['outcome'] !== 'string' ||
        !IDENTIFIER_PATTERN.test(outcome['outcome']) ||
        typeof outcome['to'] !== 'string'
      ) {
        diagnostics.push(invalid(`${path}.onOutcomes[${i}]`, 'outcome continuation must be {outcome, to}'));
      }
    }
  }

  return unit;
}

function validateSpec(value: unknown, path: string, diagnostics: CompileDiagnostic[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid(path, 'spec must be an object with a "class"'));
    return;
  }
  const specClass = value['class'];
  if (typeof specClass !== 'string' || !isCanonicalExecutionClass(specClass)) {
    diagnostics.push(invalid(path, 'spec class must be a canonical registry execution class'));
    return;
  }
  switch (specClass) {
    case 'deterministic_api': {
      checkExactKeys(value, path, ['class', 'capability'], [], diagnostics);
      const capability = value['capability'];
      if (typeof capability !== 'string' || !isCanonicalCapability(capability)) {
        diagnostics.push(
          invalid(`${path}.capability`, `"${String(capability)}" is not a canonical registry capability name`),
        );
      }
      return;
    }
    case 'agentic_computer_use': {
      checkExactKeys(value, path, ['class', 'task'], [], diagnostics);
      if (typeof value['task'] !== 'string' || value['task'].length === 0) {
        diagnostics.push(invalid(`${path}.task`, 'agentic task must be a non-empty string'));
      }
      return;
    }
    case 'human': {
      const human = value['human'];
      if (!isPlainObject(human)) {
        diagnostics.push(invalid(`${path}.human`, 'human spec must be an object'));
        return;
      }
      const kind = human['kind'];
      if (kind === 'approval' || kind === 'information') {
        checkExactKeys(
          human,
          `${path}.human`,
          ['kind', 'instruction', ...(kind === 'information' ? ['provides'] : [])],
          [],
          diagnostics,
        );
        if (typeof human['instruction'] !== 'string' || human['instruction'].length === 0) {
          diagnostics.push(invalid(`${path}.human.instruction`, 'human instruction must be a non-empty string'));
        }
        if (kind === 'information') {
          const provides = human['provides'];
          if (!isPlainObject(provides)) {
            diagnostics.push(invalid(`${path}.human.provides`, 'provides must be a port declaration'));
          } else {
            checkExactKeys(provides, `${path}.human.provides`, ['name', 'type'], ['optional'], diagnostics);
            validatePortDeclaration(provides, `${path}.human.provides`, diagnostics);
          }
        }
      } else if (kind === 'decision') {
        checkExactKeys(human, `${path}.human`, ['kind', 'instruction', 'options'], [], diagnostics);
        if (typeof human['instruction'] !== 'string' || human['instruction'].length === 0) {
          diagnostics.push(invalid(`${path}.human.instruction`, 'human instruction must be a non-empty string'));
        }
        const options = human['options'];
        if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option !== 'string')) {
          diagnostics.push(invalid(`${path}.human.options`, 'decision options must be a non-empty array of strings'));
        }
      } else {
        diagnostics.push(invalid(`${path}.human.kind`, `unknown human step kind "${String(kind)}"`));
      }
      return;
    }
    case 'subworkflow': {
      const subworkflow = value['subworkflow'];
      if (!isPlainObject(subworkflow)) {
        diagnostics.push(invalid(`${path}.subworkflow`, 'subworkflow dependency must be an object'));
        return;
      }
      checkExactKeys(subworkflow, `${path}.subworkflow`, ['workflowId', 'versionRef'], [], diagnostics);
      if (typeof subworkflow['workflowId'] !== 'string' || subworkflow['workflowId'].length === 0) {
        diagnostics.push(invalid(`${path}.subworkflow.workflowId`, 'workflowId must be a non-empty string'));
      }
      if (typeof subworkflow['versionRef'] !== 'string' || subworkflow['versionRef'].length === 0) {
        diagnostics.push(invalid(`${path}.subworkflow.versionRef`, 'versionRef must be a non-empty string'));
      }
      return;
    }
  }
}

function validateFailurePolicy(value: unknown, path: string, diagnostics: CompileDiagnostic[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid(path, 'failure policy must be an object with a "strategy"'));
    return;
  }
  const strategy = value['strategy'];
  switch (strategy) {
    case 'fail_workflow':
    case 'failover':
    case 'ignore_and_continue':
      checkExactKeys(value, path, ['strategy'], [], diagnostics);
      return;
    case 'retry_then_fail_workflow': {
      checkExactKeys(value, path, ['strategy', 'maxAttempts'], [], diagnostics);
      const maxAttempts = value['maxAttempts'];
      if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
        diagnostics.push(invalid(`${path}.maxAttempts`, 'maxAttempts must be an integer ≥ 1'));
      }
      return;
    }
    default:
      diagnostics.push(invalid(path, `unknown failure policy strategy "${String(strategy)}"`));
  }
}

function validatePorts(
  value: unknown,
  path: string,
  diagnostics: CompileDiagnostic[],
  withBinding = false,
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(invalid(path, `${path} must be an array of ports`));
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    const port = value[i];
    const portPath = `${path}[${i}]`;
    if (!isPlainObject(port)) {
      diagnostics.push(invalid(portPath, 'port must be an object'));
      continue;
    }
    checkExactKeys(
      port,
      portPath,
      withBinding ? ['name', 'type', 'binding'] : ['name', 'type'],
      ['optional'],
      diagnostics,
    );
    validatePortDeclaration(port, portPath, diagnostics);
    if (withBinding) {
      validateBinding(port['binding'], `${portPath}.binding`, diagnostics);
    }
  }
}

function validateWorkflowOutputs(value: unknown, path: string, diagnostics: CompileDiagnostic[]): void {
  if (!Array.isArray(value)) {
    diagnostics.push(invalid(path, `${path} must be an array of output bindings`));
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    const output = value[i];
    const outputPath = `${path}[${i}]`;
    if (!isPlainObject(output)) {
      diagnostics.push(invalid(outputPath, 'output binding must be an object'));
      continue;
    }
    checkExactKeys(output, outputPath, ['name', 'type', 'from'], [], diagnostics);
    validatePortDeclaration(output, outputPath, diagnostics);
    const from = output['from'];
    if (!isPlainObject(from)) {
      diagnostics.push(invalid(`${outputPath}.from`, 'output source must be a binding object'));
      continue;
    }
    if (from['kind'] === 'workflow_input' || from['kind'] === 'node_output') {
      validateBinding(from, `${outputPath}.from`, diagnostics);
    } else {
      diagnostics.push(
        invalid(`${outputPath}.from`, 'workflow output must bind to a workflow input or a node output'),
      );
    }
  }
}

function validatePortDeclaration(
  port: Record<string, unknown>,
  path: string,
  diagnostics: CompileDiagnostic[],
): void {
  if (typeof port['name'] !== 'string' || !IDENTIFIER_PATTERN.test(port['name'])) {
    diagnostics.push(invalid(`${path}.name`, 'port name must be an identifier'));
  }
  if (port['optional'] !== undefined && typeof port['optional'] !== 'boolean') {
    diagnostics.push(invalid(`${path}.optional`, 'optional must be a boolean'));
  }
  validatePortType(port['type'], `${path}.type`, diagnostics);
}

function validatePortType(value: unknown, path: string, diagnostics: CompileDiagnostic[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid(path, 'port type must be an object with a "kind"'));
    return;
  }
  const kind = value['kind'];
  switch (kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'json':
    case 'secret':
      checkExactKeys(value, path, ['kind'], [], diagnostics);
      return;
    case 'object': {
      checkExactKeys(value, path, ['kind', 'fields'], [], diagnostics);
      const fields = value['fields'];
      if (!Array.isArray(fields)) {
        diagnostics.push(invalid(`${path}.fields`, 'object port type requires a fields array'));
        return;
      }
      for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i];
        const fieldPath = `${path}.fields[${i}]`;
        if (!isPlainObject(field)) {
          diagnostics.push(invalid(fieldPath, 'object field must be an object'));
          continue;
        }
        checkExactKeys(field, fieldPath, ['name', 'type'], ['optional'], diagnostics);
        validatePortDeclaration(field, fieldPath, diagnostics);
      }
      return;
    }
    case 'array': {
      checkExactKeys(value, path, ['kind', 'element'], [], diagnostics);
      validatePortType(value['element'], `${path}.element`, diagnostics);
      return;
    }
    default:
      diagnostics.push(invalid(path, `unknown port type kind "${String(kind)}"`));
  }
}

function validateBinding(value: unknown, path: string, diagnostics: CompileDiagnostic[]): void {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid(path, 'binding must be an object with a "kind"'));
    return;
  }
  const kind = value['kind'];
  switch (kind) {
    case 'workflow_input':
      checkExactKeys(value, path, ['kind', 'input'], [], diagnostics);
      if (typeof value['input'] !== 'string' || !IDENTIFIER_PATTERN.test(value['input'])) {
        diagnostics.push(invalid(`${path}.input`, 'workflow input name must be an identifier'));
      }
      return;
    case 'node_output':
      checkExactKeys(value, path, ['kind', 'node', 'output'], [], diagnostics);
      if (typeof value['node'] !== 'string' || !IDENTIFIER_PATTERN.test(value['node'])) {
        diagnostics.push(invalid(`${path}.node`, 'source node id must be an identifier'));
      }
      if (typeof value['output'] !== 'string' || !IDENTIFIER_PATTERN.test(value['output'])) {
        diagnostics.push(invalid(`${path}.output`, 'source output port name must be an identifier'));
      }
      return;
    case 'literal':
      checkExactKeys(value, path, ['kind', 'value'], [], diagnostics);
      if (!isJsonValue(value['value'])) {
        diagnostics.push(invalid(`${path}.value`, 'literal value must be JSON data'));
      }
      return;
    case 'secret_ref': {
      // EXACT key set: a secret handle carrying any extra field is malformed —
      // inline secret material has no representation in a compiled artifact.
      checkExactKeys(value, path, ['kind', 'ref'], [], diagnostics);
      const ref = value['ref'];
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256 || /\s/.test(ref)) {
        diagnostics.push(invalid(`${path}.ref`, 'secret_ref must be a non-empty opaque reference'));
      }
      return;
    }
    default:
      diagnostics.push(invalid(path, `unknown binding kind "${String(kind)}"`));
  }
}

// ============================================================================
// §5  Helpers
// ============================================================================

function checkExactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  diagnostics: CompileDiagnostic[],
): void {
  for (const key of required) {
    if (value[key] === undefined) {
      diagnostics.push(invalid(`${path}.${key}`, `missing required field "${key}"`));
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push(invalid(`${path}.${key}`, `unknown field "${key}" (closed shape — no smuggling surface)`));
    }
  }
}

function invalid(path: string, message: string): CompileDiagnostic {
  return { code: 'WORKFLOW_COMPILER_ARTIFACT_INVALID', path, message };
}

function versionUnsupported(path: string, message: string): CompileDiagnostic {
  return { code: 'WORKFLOW_COMPILER_VERSION_UNSUPPORTED', path, message };
}
