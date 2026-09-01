/**
 * V2-003 — the validation battery: strict shape coercion + semantic checks.
 *
 * Every ambiguity is a typed rejection (fail closed, never a silent
 * default): unsupported schema versions, wrong object types, duplicate
 * identifiers, dangling edges, unknown node/output/input references,
 * ambiguous control semantics (human outcome coverage, failure-policy/edge
 * conflicts, unreachable nodes), typed binding mismatches, inline secret
 * material, non-canonical capability names, malformed subworkflow
 * dependencies and non-completion-establishing evidence classes.
 */
import type {
  BindingSource,
  ControlEdge,
  EdgeTrigger,
  HumanStepSpec,
  JsonValue,
  NodeSpec,
  PortBinding,
  PortDeclaration,
  PortType,
  StepFailurePolicy,
  ValidationIssue,
  ValidationResult,
  WorkflowIrDocument,
  WorkflowNode,
} from '../types.js';
import { SUPPORTED_IR_SCHEMA_VERSIONS, WORKFLOW_IR_OBJECT_TYPE } from '../types.js';
import {
  COMPLETION_ESTABLISHING_EVIDENCE_CLASSES,
  isCanonicalCapability,
  isCanonicalExecutionClass,
  isCanonicalPlacement,
  isCompletionEvidenceClass,
} from './registry-vocabulary.js';
import { describePortType, inferLiteralType, isPortTypeAssignable } from './type-system.js';

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SECRET_REF_PATTERN = /^\S{1,256}$/;

const EXECUTION_CLASS_ISSUE = 'IR_EXECUTION_CLASS_UNKNOWN';
const PLACEMENT_ISSUE = 'IR_PLACEMENT_UNKNOWN';
const COMPLETION_EVIDENCE_ISSUE = 'IR_COMPLETION_EVIDENCE_INVALID';

export function validateWorkflowIrDocument(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const document = coerceDocument(input, issues);
  if (document) {
    validateSemantics(document, issues);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ============================================================================
// Stage 1 — strict shape coercion
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code: string, path: string, message: string, issues: ValidationIssue[]): void {
  issues.push({ code, path, message });
}

function checkExactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  issues: ValidationIssue[],
): void {
  for (const key of required) {
    if (value[key] === undefined) {
      issue('IR_FIELD_MISSING', `${path}.${key}`, `missing required field "${key}"`, issues);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue('IR_FIELD_UNEXPECTED', `${path}.${key}`, `unknown field "${key}"`, issues);
    }
  }
}

function checkIdentifier(
  value: unknown,
  path: string,
  code: string,
  issues: ValidationIssue[],
): value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    issue(code, path, `identifier must match ${IDENTIFIER_PATTERN.source}`, issues);
    return false;
  }
  return true;
}

function checkString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  code = 'IR_FIELD_INVALID',
): value is string {
  if (typeof value !== 'string') {
    issue(code, path, 'expected a string', issues);
    return false;
  }
  return true;
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function checkPortType(value: unknown, path: string, issues: ValidationIssue[]): PortType | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'port type must be an object with a "kind"', issues);
    return undefined;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string') {
    issue('IR_FIELD_INVALID', path, 'port type must declare a string "kind"', issues);
    return undefined;
  }
  switch (kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'json':
    case 'secret':
      checkExactKeys(value, path, ['kind'], [], issues);
      return { kind };
    case 'object': {
      checkExactKeys(value, path, ['kind', 'fields'], [], issues);
      const fields = value['fields'];
      if (!Array.isArray(fields)) {
        issue('IR_FIELD_INVALID', `${path}.fields`, 'object port type requires a fields array', issues);
        return undefined;
      }
      const coerced: Array<{ name: string; type: PortType; optional?: boolean }> = [];
      for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i];
        const fieldPath = `${path}.fields[${i}]`;
        if (!isPlainObject(field)) {
          issue('IR_FIELD_INVALID', fieldPath, 'object field must be an object', issues);
          return undefined;
        }
        checkExactKeys(field, fieldPath, ['name', 'type'], ['optional'], issues);
        const name = field['name'];
        if (!checkIdentifier(name, `${fieldPath}.name`, 'IR_PORT_NAME_INVALID', issues)) {
          return undefined;
        }
        if (field['optional'] !== undefined && typeof field['optional'] !== 'boolean') {
          issue('IR_FIELD_INVALID', `${fieldPath}.optional`, 'optional must be a boolean', issues);
          return undefined;
        }
        const type = checkPortType(field['type'], `${fieldPath}.type`, issues);
        if (type === undefined) return undefined;
        coerced.push({ name, type, ...(field['optional'] === true ? { optional: true } : {}) });
      }
      return { kind: 'object', fields: coerced };
    }
    case 'array': {
      checkExactKeys(value, path, ['kind', 'element'], [], issues);
      const element = checkPortType(value['element'], `${path}.element`, issues);
      if (element === undefined) return undefined;
      return { kind: 'array', element };
    }
    default:
      issue('IR_FIELD_INVALID', path, `unknown port type kind "${kind}"`, issues);
      return undefined;
  }
}

function checkPortDeclaration(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  extraKeys: readonly string[] = [],
  extraRequired: readonly string[] = [],
): PortDeclaration | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'port declaration must be an object', issues);
    return undefined;
  }
  checkExactKeys(value, path, ['name', 'type', ...extraRequired], ['optional', ...extraKeys], issues);
  return checkPortNameTypeOptional(value, path, issues);
}

/** name/type/optional checks WITHOUT the exact-keys call (shared shape). */
function checkPortNameTypeOptional(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): PortDeclaration | undefined {
  const name = value['name'];
  if (!checkIdentifier(name, `${path}.name`, 'IR_PORT_NAME_INVALID', issues)) return undefined;
  if (value['optional'] !== undefined && typeof value['optional'] !== 'boolean') {
    issue('IR_FIELD_INVALID', `${path}.optional`, 'optional must be a boolean', issues);
    return undefined;
  }
  const type = checkPortType(value['type'], `${path}.type`, issues);
  if (type === undefined) return undefined;
  return { name, type, ...(value['optional'] === true ? { optional: true } : {}) };
}

function checkBinding(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  allowedKinds: ReadonlySet<string>,
): BindingSource | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'binding must be an object with a "kind"', issues);
    return undefined;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string') {
    issue('IR_FIELD_INVALID', path, 'binding must declare a string "kind"', issues);
    return undefined;
  }
  if (!allowedKinds.has(kind)) {
    issue('IR_BINDING_KIND_UNKNOWN', path, `binding kind "${kind}" is not allowed here`, issues);
    return undefined;
  }
  switch (kind) {
    case 'workflow_input': {
      checkExactKeys(value, path, ['kind', 'input'], [], issues);
      const input = value['input'];
      if (!checkIdentifier(input, `${path}.input`, 'IR_PORT_NAME_INVALID', issues)) return undefined;
      return { kind, input };
    }
    case 'node_output': {
      checkExactKeys(value, path, ['kind', 'node', 'output'], [], issues);
      const node = value['node'];
      const output = value['output'];
      if (!checkIdentifier(node, `${path}.node`, 'IR_NODE_ID_INVALID', issues)) return undefined;
      if (!checkIdentifier(output, `${path}.output`, 'IR_PORT_NAME_INVALID', issues)) return undefined;
      return { kind, node, output };
    }
    case 'literal': {
      checkExactKeys(value, path, ['kind', 'value'], [], issues);
      const literal = value['value'];
      if (!isJsonValue(literal)) {
        issue('IR_LITERAL_NOT_JSON', `${path}.value`, 'literal value must be JSON data', issues);
        return undefined;
      }
      return { kind, value: literal as JsonValue };
    }
    case 'secret_ref': {
      // EXACT key set: a secret handle carrying ANY extra field (value,
      // material, token, password, …) is malformed — inline secret material
      // has no representation in the IR.
      const keys = Object.keys(value);
      const expected = ['kind', 'ref'];
      const unexpected = keys.filter((key) => !expected.includes(key));
      const missing = expected.filter((key) => value[key] === undefined);
      for (const key of missing) {
        issue('IR_SECRET_REF_MALFORMED', `${path}.${key}`, `secret_ref requires "${key}"`, issues);
      }
      for (const key of unexpected) {
        issue('IR_SECRET_REF_MALFORMED', `${path}.${key}`, `secret_ref must carry only an opaque "ref" — unexpected field "${key}"`, issues);
      }
      const ref = value['ref'];
      if (typeof ref !== 'string') {
        issue('IR_SECRET_REF_MALFORMED', `${path}.ref`, 'secret_ref must be an opaque string reference', issues);
        return undefined;
      }
      if (!SECRET_REF_PATTERN.test(ref)) {
        issue('IR_SECRET_REF_MALFORMED', `${path}.ref`, 'secret_ref must be a non-empty opaque reference (no whitespace, ≤256 chars)', issues);
        return undefined;
      }
      if (missing.length > 0 || unexpected.length > 0) return undefined;
      return { kind, ref };
    }
    default:
      issue('IR_BINDING_KIND_UNKNOWN', path, `unknown binding kind "${kind}"`, issues);
      return undefined;
  }
}

function checkPortBinding(value: unknown, path: string, issues: ValidationIssue[]): PortBinding | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'port binding must be an object', issues);
    return undefined;
  }
  checkExactKeys(value, path, ['name', 'type', 'binding'], ['optional'], issues);
  const declaration = checkPortNameTypeOptional(value, path, issues);
  if (declaration === undefined) return undefined;
  const binding = checkBinding(value['binding'], `${path}.binding`, issues, new Set(['workflow_input', 'node_output', 'literal', 'secret_ref']));
  if (binding === undefined) return undefined;
  return { ...declaration, binding };
}

function checkFailurePolicy(value: unknown, path: string, issues: ValidationIssue[]): StepFailurePolicy | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FAILURE_POLICY_INVALID', path, 'failure policy must be an object with a "strategy"', issues);
    return undefined;
  }
  const strategy = value['strategy'];
  if (typeof strategy !== 'string') {
    issue('IR_FAILURE_POLICY_INVALID', path, 'failure policy must declare a string "strategy"', issues);
    return undefined;
  }
  switch (strategy) {
    case 'fail_workflow':
    case 'failover':
    case 'ignore_and_continue':
      checkExactKeys(value, path, ['strategy'], [], issues);
      return { strategy };
    case 'retry_then_fail_workflow': {
      checkExactKeys(value, path, ['strategy', 'maxAttempts'], [], issues);
      const maxAttempts = value['maxAttempts'];
      if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
        issue('IR_FAILURE_POLICY_INVALID', `${path}.maxAttempts`, 'maxAttempts must be an integer ≥ 1', issues);
        return undefined;
      }
      return { strategy, maxAttempts };
    }
    default:
      issue('IR_FAILURE_POLICY_INVALID', path, `unknown failure policy strategy "${strategy}"`, issues);
      return undefined;
  }
}

function checkHumanSpec(value: unknown, path: string, issues: ValidationIssue[]): HumanStepSpec | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'human step spec must be an object', issues);
    return undefined;
  }
  const kind = value['kind'];
  if (typeof kind !== 'string') {
    issue('IR_FIELD_INVALID', path, 'human step spec must declare a string "kind"', issues);
    return undefined;
  }
  switch (kind) {
    case 'approval':
    case 'decision':
    case 'information':
      break;
    default:
      issue('IR_FIELD_INVALID', path, `unknown human step kind "${kind}"`, issues);
      return undefined;
  }
  checkExactKeys(
    value,
    path,
    ['kind', 'instruction', ...(kind === 'decision' ? ['options'] : []), ...(kind === 'information' ? ['provides'] : [])],
    [],
    issues,
  );
  if (typeof value['instruction'] !== 'string' || value['instruction'].length === 0) {
    issue('IR_FIELD_INVALID', `${path}.instruction`, 'human step requires a non-empty instruction', issues);
    return undefined;
  }
  if (kind === 'decision') {
    const options = value['options'];
    if (!Array.isArray(options) || options.length === 0) {
      issue('IR_FIELD_INVALID', `${path}.options`, 'decision step requires a non-empty options array', issues);
      return undefined;
    }
    const coerced: string[] = [];
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      if (!checkIdentifier(option, `${path}.options[${i}]`, 'IR_PORT_NAME_INVALID', issues)) {
        return undefined;
      }
      coerced.push(option);
    }
    return { kind, instruction: value['instruction'], options: coerced };
  }
  if (kind === 'information') {
    const provides = checkPortDeclaration(value['provides'], `${path}.provides`, issues);
    if (provides === undefined) return undefined;
    return { kind, instruction: value['instruction'], provides };
  }
  return { kind, instruction: value['instruction'] };
}

function checkNodeSpec(value: unknown, path: string, issues: ValidationIssue[]): NodeSpec | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'node spec must be an object with a "class"', issues);
    return undefined;
  }
  const nodeClass = value['class'];
  if (typeof nodeClass !== 'string') {
    issue('IR_FIELD_INVALID', path, 'node spec must declare a string "class"', issues);
    return undefined;
  }
  switch (nodeClass) {
    case 'deterministic_api': {
      checkExactKeys(value, path, ['class', 'capability'], [], issues);
      const capability = value['capability'];
      if (!checkString(capability, `${path}.capability`, issues)) return undefined;
      return { class: nodeClass, capability };
    }
    case 'agentic_computer_use': {
      checkExactKeys(value, path, ['class', 'task'], [], issues);
      const task = value['task'];
      if (typeof task !== 'string' || task.length === 0) {
        issue('IR_FIELD_INVALID', `${path}.task`, 'agentic step requires a non-empty task', issues);
        return undefined;
      }
      return { class: nodeClass, task };
    }
    case 'human': {
      checkExactKeys(value, path, ['class', 'human'], [], issues);
      const human = checkHumanSpec(value['human'], `${path}.human`, issues);
      if (human === undefined) return undefined;
      return { class: nodeClass, human };
    }
    case 'subworkflow': {
      checkExactKeys(value, path, ['class', 'subworkflow'], [], issues);
      const subworkflow = value['subworkflow'];
      if (!isPlainObject(subworkflow)) {
        issue('IR_FIELD_INVALID', `${path}.subworkflow`, 'subworkflow dependency must be an object', issues);
        return undefined;
      }
      checkExactKeys(subworkflow, `${path}.subworkflow`, ['workflowId', 'versionRef'], [], issues);
      if (!checkString(subworkflow['workflowId'], `${path}.subworkflow.workflowId`, issues)) return undefined;
      if (!checkString(subworkflow['versionRef'], `${path}.subworkflow.versionRef`, issues)) return undefined;
      return {
        class: nodeClass,
        subworkflow: {
          workflowId: subworkflow['workflowId'],
          versionRef: subworkflow['versionRef'],
        },
      };
    }
    default:
      issue('IR_FIELD_INVALID', path, `unknown node spec class "${nodeClass}"`, issues);
      return undefined;
  }
}

function checkNode(value: unknown, path: string, issues: ValidationIssue[]): WorkflowNode | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'node must be an object', issues);
    return undefined;
  }
  checkExactKeys(
    value,
    path,
    ['id', 'executionClass', 'spec', 'capabilityRequirements', 'placement', 'inputs', 'outputs', 'failurePolicy'],
    ['completionEvidence'],
    issues,
  );
  if (!checkIdentifier(value['id'], `${path}.id`, 'IR_NODE_ID_INVALID', issues)) return undefined;

  const executionClass = value['executionClass'];
  if (typeof executionClass !== 'string' || !isCanonicalExecutionClass(executionClass)) {
    issue(EXECUTION_CLASS_ISSUE, `${path}.executionClass`, `executionClass must be one of the canonical registry execution classes`, issues);
    return undefined;
  }

  const placement = value['placement'];
  if (typeof placement !== 'string' || !isCanonicalPlacement(placement)) {
    issue(PLACEMENT_ISSUE, `${path}.placement`, 'placement must be a canonical registry placement identifier', issues);
    return undefined;
  }

  if (value['completionEvidence'] !== undefined) {
    const completionEvidence = value['completionEvidence'];
    if (typeof completionEvidence !== 'string' || !isCompletionEvidenceClass(completionEvidence)) {
      issue(
        COMPLETION_EVIDENCE_ISSUE,
        `${path}.completionEvidence`,
        `completion evidence must be one of ${COMPLETION_ESTABLISHING_EVIDENCE_CLASSES.join(', ')} — intent and claim never establish completion (constitution §7)`,
        issues,
      );
      return undefined;
    }
  }

  const spec = checkNodeSpec(value['spec'], `${path}.spec`, issues);
  if (spec === undefined) return undefined;
  if (spec.class !== executionClass) {
    issue('IR_SPEC_CLASS_MISMATCH', `${path}.spec.class`, `spec class "${spec.class}" must equal executionClass "${executionClass}"`, issues);
    return undefined;
  }

  const capabilityRequirements = value['capabilityRequirements'];
  if (!Array.isArray(capabilityRequirements)) {
    issue('IR_FIELD_INVALID', `${path}.capabilityRequirements`, 'capabilityRequirements must be an array of canonical names', issues);
    return undefined;
  }
  for (let i = 0; i < capabilityRequirements.length; i += 1) {
    if (typeof capabilityRequirements[i] !== 'string') {
      issue('IR_FIELD_INVALID', `${path}.capabilityRequirements[${i}]`, 'capability requirement must be a string', issues);
      return undefined;
    }
  }

  const inputs = value['inputs'];
  if (!Array.isArray(inputs)) {
    issue('IR_FIELD_INVALID', `${path}.inputs`, 'inputs must be an array of port bindings', issues);
    return undefined;
  }
  const coercedInputs: PortBinding[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const binding = checkPortBinding(inputs[i], `${path}.inputs[${i}]`, issues);
    if (binding === undefined) return undefined;
    coercedInputs.push(binding);
  }

  const outputs = value['outputs'];
  if (!Array.isArray(outputs)) {
    issue('IR_FIELD_INVALID', `${path}.outputs`, 'outputs must be an array of port declarations', issues);
    return undefined;
  }
  const coercedOutputs: PortDeclaration[] = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const declaration = checkPortDeclaration(outputs[i], `${path}.outputs[${i}]`, issues);
    if (declaration === undefined) return undefined;
    coercedOutputs.push(declaration);
  }

  const failurePolicy = checkFailurePolicy(value['failurePolicy'], `${path}.failurePolicy`, issues);
  if (failurePolicy === undefined) return undefined;

  return {
    id: value['id'],
    executionClass,
    spec,
    capabilityRequirements: capabilityRequirements as string[],
    placement,
    inputs: coercedInputs,
    outputs: coercedOutputs,
    failurePolicy,
    ...(value['completionEvidence'] !== undefined
      ? { completionEvidence: value['completionEvidence'] as string }
      : {}),
  } as WorkflowNode;
}

function checkEdge(value: unknown, path: string, issues: ValidationIssue[]): ControlEdge | undefined {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'edge must be an object', issues);
    return undefined;
  }
  checkExactKeys(value, path, ['from', 'to', 'on'], [], issues);
  if (!checkIdentifier(value['from'], `${path}.from`, 'IR_NODE_ID_INVALID', issues)) return undefined;
  if (!checkIdentifier(value['to'], `${path}.to`, 'IR_NODE_ID_INVALID', issues)) return undefined;
  const on = value['on'];
  if (on === 'success' || on === 'failure') {
    return { from: value['from'], to: value['to'], on };
  }
  if (isPlainObject(on)) {
    checkExactKeys(on, `${path}.on`, ['outcome'], [], issues);
    if (!checkIdentifier(on['outcome'], `${path}.on.outcome`, 'IR_PORT_NAME_INVALID', issues)) return undefined;
    return { from: value['from'], to: value['to'], on: { outcome: on['outcome'] } };
  }
  issue('IR_EDGE_TRIGGER_INVALID', `${path}.on`, 'edge trigger must be "success", "failure" or {outcome}', issues);
  return undefined;
}

function checkPresentation(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issue('IR_FIELD_INVALID', path, 'presentation must be an object', issues);
    return;
  }
  checkExactKeys(value, path, [], ['title', 'nodeLabels', 'nodePositions', 'notes'], issues);
  if (value['title'] !== undefined && typeof value['title'] !== 'string') {
    issue('IR_FIELD_INVALID', `${path}.title`, 'title must be a string', issues);
  }
  if (value['notes'] !== undefined && typeof value['notes'] !== 'string') {
    issue('IR_FIELD_INVALID', `${path}.notes`, 'notes must be a string', issues);
  }
  if (value['nodeLabels'] !== undefined) {
    const labels = value['nodeLabels'];
    if (!isPlainObject(labels)) {
      issue('IR_FIELD_INVALID', `${path}.nodeLabels`, 'nodeLabels must be a record of nodeId → label', issues);
    } else {
      for (const [nodeId, label] of Object.entries(labels)) {
        if (!IDENTIFIER_PATTERN.test(nodeId)) {
          issue('IR_NODE_ID_INVALID', `${path}.nodeLabels.${nodeId}`, 'nodeLabels keys must be node ids', issues);
        }
        if (typeof label !== 'string') {
          issue('IR_FIELD_INVALID', `${path}.nodeLabels.${nodeId}`, 'label must be a string', issues);
        }
      }
    }
  }
  if (value['nodePositions'] !== undefined) {
    const positions = value['nodePositions'];
    if (!isPlainObject(positions)) {
      issue('IR_FIELD_INVALID', `${path}.nodePositions`, 'nodePositions must be a record of nodeId → {x,y}', issues);
    } else {
      for (const [nodeId, position] of Object.entries(positions)) {
        const positionPath = `${path}.nodePositions.${nodeId}`;
        if (!IDENTIFIER_PATTERN.test(nodeId)) {
          issue('IR_NODE_ID_INVALID', positionPath, 'nodePositions keys must be node ids', issues);
        }
        if (
          !isPlainObject(position) ||
          typeof position['x'] !== 'number' ||
          !Number.isFinite(position['x']) ||
          typeof position['y'] !== 'number' ||
          !Number.isFinite(position['y'])
        ) {
          issue('IR_FIELD_INVALID', positionPath, 'position must be {x,y} finite numbers', issues);
        }
      }
    }
  }
}

function coerceDocument(input: unknown, issues: ValidationIssue[]): WorkflowIrDocument | null {
  if (!isPlainObject(input)) {
    issue('IR_FIELD_INVALID', '$', 'document must be a JSON object', issues);
    return null;
  }
  if (input['objectType'] !== WORKFLOW_IR_OBJECT_TYPE) {
    issue(
      'IR_OBJECT_TYPE_MISMATCH',
      '$.objectType',
      `objectType must be "${WORKFLOW_IR_OBJECT_TYPE}"`,
      issues,
    );
    return null;
  }
  checkExactKeys(input, '$', ['objectType', 'irSchemaVersion', 'compatibility', 'ir'], ['presentation'], issues);

  const irSchemaVersion = input['irSchemaVersion'];
  if (typeof irSchemaVersion !== 'number' || !Number.isInteger(irSchemaVersion)) {
    issue('IR_FIELD_INVALID', '$.irSchemaVersion', 'irSchemaVersion must be an integer', issues);
    return null;
  }
  if (!SUPPORTED_IR_SCHEMA_VERSIONS.includes(irSchemaVersion)) {
    issue(
      'IR_SCHEMA_VERSION_UNSUPPORTED',
      '$.irSchemaVersion',
      `unsupported IR schema version ${irSchemaVersion} (supported: ${SUPPORTED_IR_SCHEMA_VERSIONS.join(', ')})`,
      issues,
    );
    return null;
  }

  const compatibility = input['compatibility'];
  if (!isPlainObject(compatibility)) {
    issue('IR_FIELD_INVALID', '$.compatibility', 'compatibility metadata must be an object', issues);
    return null;
  }
  checkExactKeys(compatibility, '$.compatibility', ['compatibilityLevel', 'inputSurfaceChange', 'outputSurfaceChange'], [], issues);
  const compatibilityLevels = ['equivalent', 'compatible', 'incompatible'];
  const surfaceChanges = ['none', 'additive', 'breaking'];
  if (
    typeof compatibility['compatibilityLevel'] !== 'string' ||
    !compatibilityLevels.includes(compatibility['compatibilityLevel'])
  ) {
    issue('IR_COMPATIBILITY_INVALID', '$.compatibility.compatibilityLevel', `compatibilityLevel must be one of ${compatibilityLevels.join(', ')}`, issues);
    return null;
  }
  for (const field of ['inputSurfaceChange', 'outputSurfaceChange'] as const) {
    const change = compatibility[field];
    if (typeof change !== 'string' || !surfaceChanges.includes(change)) {
      issue('IR_COMPATIBILITY_INVALID', `$.compatibility.${field}`, `${field} must be one of ${surfaceChanges.join(', ')}`, issues);
      return null;
    }
  }

  const ir = input['ir'];
  if (!isPlainObject(ir)) {
    issue('IR_FIELD_INVALID', '$.ir', 'ir must be an object', issues);
    return null;
  }
  checkExactKeys(ir, '$.ir', ['start', 'inputs', 'outputs', 'nodes', 'edges', 'defaultPlacement', 'provenance'], [], issues);
  if (!checkIdentifier(ir['start'], '$.ir.start', 'IR_NODE_ID_INVALID', issues)) return null;

  const defaultPlacement = ir['defaultPlacement'];
  if (typeof defaultPlacement !== 'string' || !isCanonicalPlacement(defaultPlacement)) {
    issue(PLACEMENT_ISSUE, '$.ir.defaultPlacement', 'defaultPlacement must be a canonical registry placement identifier', issues);
    return null;
  }

  const provenance = ir['provenance'];
  if (!isPlainObject(provenance)) {
    issue('IR_PROVENANCE_INVALID', '$.ir.provenance', 'provenance must be an object', issues);
    return null;
  }
  checkExactKeys(provenance, '$.ir.provenance', ['origin'], ['sourceRefs'], issues);
  const origins = ['authored', 'compiled', 'imported'];
  if (typeof provenance['origin'] !== 'string' || !origins.includes(provenance['origin'])) {
    issue('IR_PROVENANCE_INVALID', '$.ir.provenance.origin', `origin must be one of ${origins.join(', ')}`, issues);
    return null;
  }
  if (provenance['sourceRefs'] !== undefined) {
    if (!Array.isArray(provenance['sourceRefs'])) {
      issue('IR_PROVENANCE_INVALID', '$.ir.provenance.sourceRefs', 'sourceRefs must be an array of strings', issues);
      return null;
    }
    for (let i = 0; i < (provenance['sourceRefs'] as unknown[]).length; i += 1) {
      if (typeof (provenance['sourceRefs'] as unknown[])[i] !== 'string') {
        issue('IR_PROVENANCE_INVALID', `$.ir.provenance.sourceRefs[${i}]`, 'source reference must be a string', issues);
        return null;
      }
    }
  }

  if (!Array.isArray(ir['inputs'])) {
    issue('IR_FIELD_INVALID', '$.ir.inputs', 'workflow inputs must be an array', issues);
    return null;
  }
  const inputs: PortDeclaration[] = [];
  for (let i = 0; i < (ir['inputs'] as unknown[]).length; i += 1) {
    const declaration = checkPortDeclaration((ir['inputs'] as unknown[])[i], `$.ir.inputs[${i}]`, issues);
    if (declaration === undefined) return null;
    inputs.push(declaration);
  }

  if (!Array.isArray(ir['outputs'])) {
    issue('IR_FIELD_INVALID', '$.ir.outputs', 'workflow outputs must be an array', issues);
    return null;
  }
  const outputs: Array<{ name: string; type: PortType; from: BindingSource }> = [];
  for (let i = 0; i < (ir['outputs'] as unknown[]).length; i += 1) {
    const output = (ir['outputs'] as unknown[])[i];
    const path = `$.ir.outputs[${i}]`;
    if (!isPlainObject(output)) {
      issue('IR_FIELD_INVALID', path, 'workflow output must be an object', issues);
      return null;
    }
    checkExactKeys(output, path, ['name', 'type', 'from'], [], issues);
    const declaration = checkPortDeclaration(output, path, issues, ['from']);
    if (declaration === undefined) return null;
    // workflow outputs bind to workflow inputs or node outputs only
    const from = checkBinding(output['from'], `${path}.from`, issues, new Set(['workflow_input', 'node_output']));
    if (from === undefined) {
      issue('IR_OUTPUT_BINDING_INVALID', `${path}.from`, 'workflow output must bind to a workflow input or a node output', issues);
      return null;
    }
    outputs.push({ ...declaration, from });
  }

  if (!Array.isArray(ir['nodes'])) {
    issue('IR_FIELD_INVALID', '$.ir.nodes', 'nodes must be an array', issues);
    return null;
  }
  const nodes: WorkflowNode[] = [];
  for (let i = 0; i < (ir['nodes'] as unknown[]).length; i += 1) {
    const node = checkNode((ir['nodes'] as unknown[])[i], `$.ir.nodes[${i}]`, issues);
    if (node === undefined) return null;
    nodes.push(node);
  }

  if (!Array.isArray(ir['edges'])) {
    issue('IR_FIELD_INVALID', '$.ir.edges', 'edges must be an array', issues);
    return null;
  }
  const edges: ControlEdge[] = [];
  for (let i = 0; i < (ir['edges'] as unknown[]).length; i += 1) {
    const edge = checkEdge((ir['edges'] as unknown[])[i], `$.ir.edges[${i}]`, issues);
    if (edge === undefined) return null;
    edges.push(edge);
  }

  if (input['presentation'] !== undefined) {
    checkPresentation(input['presentation'], '$.presentation', issues);
  }

  const document: WorkflowIrDocument = {
    objectType: WORKFLOW_IR_OBJECT_TYPE,
    irSchemaVersion,
    compatibility: {
      compatibilityLevel: compatibility['compatibilityLevel'] as 'equivalent' | 'compatible' | 'incompatible',
      inputSurfaceChange: compatibility['inputSurfaceChange'] as 'none' | 'additive' | 'breaking',
      outputSurfaceChange: compatibility['outputSurfaceChange'] as 'none' | 'additive' | 'breaking',
    },
    ir: {
      start: ir['start'],
      inputs,
      outputs,
      nodes,
      edges,
      defaultPlacement,
      provenance: {
        origin: provenance['origin'] as 'authored' | 'compiled' | 'imported',
        ...(Array.isArray(provenance['sourceRefs']) ? { sourceRefs: provenance['sourceRefs'] as string[] } : {}),
      },
    },
    ...(isPlainObject(input['presentation']) ? { presentation: input['presentation'] as never } : {}),
  };
  return document;
}

// ============================================================================
// Stage 2 — semantic validation (graph, control, data, registry conformance)
// ============================================================================

function edgeTriggerKey(trigger: EdgeTrigger): string {
  if (trigger === 'success' || trigger === 'failure') return trigger;
  return `outcome:${trigger.outcome}`;
}

function validateSemantics(document: WorkflowIrDocument, issues: ValidationIssue[]): void {
  const { ir } = document;

  if (ir.nodes.length === 0) {
    issue('IR_NODES_REQUIRED', '$.ir.nodes', 'a workflow must declare at least one node', issues);
    return;
  }

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of ir.nodes) {
    if (nodesById.has(node.id)) {
      issue('IR_NODE_ID_DUPLICATE', `$.ir.nodes.${node.id}`, `duplicate node id "${node.id}"`, issues);
      continue;
    }
    nodesById.set(node.id, node);
  }

  const workflowInputNames = new Set<string>();
  for (const input of ir.inputs) {
    if (workflowInputNames.has(input.name)) {
      issue('IR_PORT_NAME_DUPLICATE', `$.ir.inputs.${input.name}`, `duplicate workflow input "${input.name}"`, issues);
      continue;
    }
    workflowInputNames.add(input.name);
  }

  const workflowOutputNames = new Set<string>();
  for (const output of ir.outputs) {
    if (workflowOutputNames.has(output.name)) {
      issue('IR_PORT_NAME_DUPLICATE', `$.ir.outputs.${output.name}`, `duplicate workflow output "${output.name}"`, issues);
      continue;
    }
    workflowOutputNames.add(output.name);
  }

  for (const node of ir.nodes) {
    const inputNames = new Set<string>();
    for (const port of node.inputs) {
      if (inputNames.has(port.name)) {
        issue('IR_PORT_NAME_DUPLICATE', `$.ir.nodes.${node.id}.inputs.${port.name}`, `duplicate input port "${port.name}"`, issues);
      }
      inputNames.add(port.name);
    }
    const outputNames = new Set<string>();
    for (const port of node.outputs) {
      if (outputNames.has(port.name)) {
        issue('IR_PORT_NAME_DUPLICATE', `$.ir.nodes.${node.id}.outputs.${port.name}`, `duplicate output port "${port.name}"`, issues);
      }
      outputNames.add(port.name);
    }
    // registry conformance of every capability requirement
    for (const requirement of node.capabilityRequirements) {
      if (!isCanonicalCapability(requirement)) {
        issue(
          'IR_CAPABILITY_REQUIREMENT_NON_CANONICAL',
          `$.ir.nodes.${node.id}.capabilityRequirements`,
          `"${requirement}" is not a canonical registry capability name (aliases and platform SDK names are forbidden)`,
          issues,
        );
      }
    }
    // class-specific registry/dependency conformance
    validateInvokedCapability(node, issues);
    validateSubworkflowDependency(node, issues);
  }

  if (!nodesById.has(ir.start)) {
    issue('IR_START_UNKNOWN', '$.ir.start', `start node "${ir.start}" does not exist`, issues);
  }

  // ---- edges: existence, self loops, into-start, duplicates ----
  const edgeKeys = new Set<string>();
  for (const edge of ir.edges) {
    const path = `$.ir.edges.${edge.from}->${edge.to}.${edgeTriggerKey(edge.on)}`;
    if (!nodesById.has(edge.from)) {
      issue('IR_EDGE_NODE_UNKNOWN', path, `edge references unknown source node "${edge.from}"`, issues);
    }
    if (!nodesById.has(edge.to)) {
      issue('IR_EDGE_NODE_UNKNOWN', path, `edge references unknown target node "${edge.to}"`, issues);
    }
    if (edge.from === edge.to) {
      issue('IR_EDGE_SELF_LOOP', path, 'self edges are not valid control semantics', issues);
    }
    if (edge.to === ir.start) {
      issue('IR_EDGE_INTO_START', path, `the start node "${ir.start}" must have no incoming edges`, issues);
    }
    const key = `${edge.from}|${edge.to}|${edgeTriggerKey(edge.on)}`;
    if (edgeKeys.has(key)) {
      issue('IR_EDGE_DUPLICATE', path, 'duplicate control edge', issues);
    }
    edgeKeys.add(key);
  }

  // ---- failure policy vs failure edges; human outcome contracts ----
  for (const node of ir.nodes) {
    const nodeEdges = ir.edges.filter((edge) => edge.from === node.id);
    const failureEdges = nodeEdges.filter((edge) => edge.on === 'failure');
    const successEdges = nodeEdges.filter((edge) => edge.on === 'success');
    const outcomeEdges = nodeEdges.filter((edge) => edge.on !== 'success' && edge.on !== 'failure');

    if (node.failurePolicy.strategy === 'failover') {
      if (failureEdges.length === 0) {
        issue(
          'IR_FAILURE_POLICY_EDGE_REQUIRED',
          `$.ir.nodes.${node.id}.failurePolicy`,
          'failover policy requires exactly one on_failure edge',
          issues,
        );
      } else if (failureEdges.length > 1) {
        issue(
          'IR_FAILURE_POLICY_EDGE_CONFLICT',
          `$.ir.nodes.${node.id}.failurePolicy`,
          `failover policy requires exactly one on_failure edge (found ${failureEdges.length})`,
          issues,
        );
      }
    } else if (failureEdges.length > 0) {
      issue(
        'IR_FAILURE_POLICY_EDGE_CONFLICT',
        `$.ir.nodes.${node.id}.failurePolicy`,
        `failure policy "${node.failurePolicy.strategy}" cannot be combined with on_failure edges`,
        issues,
      );
    }

    if (node.executionClass === 'human' && node.spec.class === 'human') {
      validateHumanNode(node, { failureEdges, successEdges, outcomeEdges }, issues);
    } else {
      for (const edge of outcomeEdges) {
        issue(
          'IR_HUMAN_OUTCOME_UNDECLARED',
          `$.ir.edges.${edge.from}->${edge.to}.${edgeTriggerKey(edge.on)}`,
          'outcome edges are valid only from human approval/decision nodes with that declared outcome',
          issues,
        );
      }
    }
  }

  // ---- reachability: every node reachable from start over control edges ----
  if (nodesById.has(ir.start)) {
    const reachable = new Set<string>([ir.start]);
    const queue = [ir.start];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const edge of ir.edges) {
        if (edge.from === current && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of ir.nodes) {
      if (!reachable.has(node.id)) {
        issue('IR_NODE_UNREACHABLE', `$.ir.nodes.${node.id}`, `node "${node.id}" is not reachable from start "${ir.start}"`, issues);
      }
    }
  }

  // ---- typed data bindings ----
  for (const node of ir.nodes) {
    for (const port of node.inputs) {
      validateBinding(port, node, nodesById, ir, issues);
    }
  }

  for (const output of ir.outputs) {
    const path = `$.ir.outputs.${output.name}`;
    const sourceType = resolveWorkflowOutputSourceType(output, nodesById, workflowInputNames, ir, path, issues);
    if (sourceType !== undefined && !isPortTypeAssignable(sourceType, output.type)) {
      issue(
        'IR_BINDING_TYPE_MISMATCH',
        `${path}.from`,
        `workflow output type ${describePortType(output.type)} does not accept source type ${describePortType(sourceType)}`,
        issues,
      );
    }
  }
}

function validateHumanNode(
  node: WorkflowNode,
  edges: { failureEdges: readonly ControlEdge[]; successEdges: readonly ControlEdge[]; outcomeEdges: readonly ControlEdge[] },
  issues: ValidationIssue[],
): void {
  const spec = node.spec.class === 'human' ? node.spec.human : null;
  if (spec === null) return;

  let declaredOutcomes: string[] = [];
  if (spec.kind === 'approval') {
    declaredOutcomes = ['approved', 'rejected'];
    const approvedPort = node.outputs.find((port) => port.name === 'approved');
    if (approvedPort === undefined || approvedPort.type.kind !== 'boolean') {
      issue(
        'IR_HUMAN_OUTPUT_CONTRACT',
        `$.ir.nodes.${node.id}.outputs`,
        'an approval node must expose a boolean output port named "approved"',
        issues,
      );
    }
  } else if (spec.kind === 'decision') {
    declaredOutcomes = [...spec.options];
    const duplicates = declaredOutcomes.filter((option, index) => declaredOutcomes.indexOf(option) !== index);
    for (const duplicate of duplicates) {
      issue('IR_HUMAN_OPTION_DUPLICATE', `$.ir.nodes.${node.id}.spec.human.options`, `duplicate decision option "${duplicate}"`, issues);
    }
    const selectedPort = node.outputs.find((port) => port.name === 'selected');
    if (selectedPort === undefined || selectedPort.type.kind !== 'string') {
      issue(
        'IR_HUMAN_OUTPUT_CONTRACT',
        `$.ir.nodes.${node.id}.outputs`,
        'a decision node must expose a string output port named "selected"',
        issues,
      );
    }
  } else {
    // information: the provides port IS the node's output
    const providesPort = node.outputs.find(
      (port) => port.name === spec.provides.name && port.type.kind === spec.provides.type.kind,
    );
    if (providesPort === undefined) {
      issue(
        'IR_HUMAN_OUTPUT_CONTRACT',
        `$.ir.nodes.${node.id}.outputs`,
        'an information node must expose its "provides" port as an output',
        issues,
      );
    }
    if (edges.outcomeEdges.length > 0) {
      issue(
        'IR_HUMAN_OUTCOME_UNDECLARED',
        `$.ir.nodes.${node.id}`,
        'information nodes complete via success edges — outcome edges are not valid here',
        issues,
      );
    }
    return;
  }

  // approval/decision: control flows ONLY through declared outcomes
  if (edges.successEdges.length > 0) {
    issue(
      'IR_HUMAN_SUCCESS_EDGE_FORBIDDEN',
      `$.ir.nodes.${node.id}`,
      'approval/decision nodes route control through outcome edges, not success edges',
      issues,
    );
  }
  if (edges.failureEdges.length > 0) {
    issue(
      'IR_HUMAN_FAILURE_EDGE_FORBIDDEN',
      `$.ir.nodes.${node.id}`,
      'approval/decision nodes route control through outcome edges, not failure edges',
      issues,
    );
  }
  const covered = new Set(
    edges.outcomeEdges
      .filter((edge) => edge.on !== 'success' && edge.on !== 'failure')
      .map((edge) => (edge.on as { outcome: string }).outcome),
  );
  for (const outcome of declaredOutcomes) {
    if (!covered.has(outcome)) {
      issue(
        'IR_HUMAN_OUTCOME_UNCOVERED',
        `$.ir.nodes.${node.id}`,
        `declared outcome "${outcome}" has no continuation edge (ambiguous control semantics)`,
        issues,
      );
    }
  }
  for (const outcome of covered) {
    if (!declaredOutcomes.includes(outcome)) {
      issue(
        'IR_HUMAN_OUTCOME_UNDECLARED',
        `$.ir.nodes.${node.id}`,
        `outcome edge references undeclared outcome "${outcome}"`,
        issues,
      );
    }
  }
}

function validateBinding(
  port: PortBinding,
  node: WorkflowNode,
  nodesById: Map<string, WorkflowNode>,
  ir: WorkflowIrDocument['ir'],
  issues: ValidationIssue[],
): void {
  const path = `$.ir.nodes.${node.id}.inputs.${port.name}`;
  const binding = port.binding;
  let sourceType: PortType | undefined;

  switch (binding.kind) {
    case 'workflow_input': {
      const input = ir.inputs.find((candidate) => candidate.name === binding.input);
      if (input === undefined) {
        issue('IR_BINDING_WORKFLOW_INPUT_UNKNOWN', `${path}.binding`, `unknown workflow input "${binding.input}"`, issues);
        return;
      }
      if (input.optional && !port.optional) {
        issue(
          'IR_BINDING_OPTIONALITY_MISMATCH',
          `${path}.binding`,
          `optional workflow input "${binding.input}" cannot satisfy a required input port`,
          issues,
        );
      }
      sourceType = input.type;
      break;
    }
    case 'node_output': {
      const sourceNode = nodesById.get(binding.node);
      if (sourceNode === undefined) {
        issue('IR_BINDING_NODE_UNKNOWN', `${path}.binding`, `unknown source node "${binding.node}"`, issues);
        return;
      }
      const output = sourceNode.outputs.find((candidate) => candidate.name === binding.output);
      if (output === undefined) {
        issue('IR_BINDING_OUTPUT_UNKNOWN', `${path}.binding`, `node "${binding.node}" has no output port "${binding.output}"`, issues);
        return;
      }
      sourceType = output.type;
      break;
    }
    case 'literal': {
      if (port.type.kind === 'secret') {
        issue(
          'IR_SECRET_LITERAL_FORBIDDEN',
          `${path}.binding`,
          'a secret-typed port can only be bound to an opaque secret_ref — inline secret material is forbidden (constitution §16)',
          issues,
        );
        return;
      }
      sourceType = inferLiteralType(binding.value);
      break;
    }
    case 'secret_ref': {
      if (port.type.kind !== 'secret') {
        issue(
          'IR_SECRET_REF_FOR_NON_SECRET_PORT',
          `${path}.binding`,
          'a secret_ref handle can only be bound to a secret-typed port',
          issues,
        );
        return;
      }
      sourceType = { kind: 'secret' };
      break;
    }
    default:
      return;
  }

  if (sourceType !== undefined && !isPortTypeAssignable(sourceType, port.type)) {
    issue(
      'IR_BINDING_TYPE_MISMATCH',
      `${path}.binding`,
      `input port ${describePortType(port.type)} does not accept source type ${describePortType(sourceType)}`,
      issues,
    );
  }
}

function resolveWorkflowOutputSourceType(
  output: { name: string; from: BindingSource },
  nodesById: Map<string, WorkflowNode>,
  _workflowInputNames: Set<string>,
  ir: WorkflowIrDocument['ir'],
  path: string,
  issues: ValidationIssue[],
): PortType | undefined {
  const from = output.from;
  if (from.kind === 'workflow_input') {
    const input = ir.inputs.find((candidate) => candidate.name === from.input);
    if (input === undefined) {
      issue('IR_BINDING_WORKFLOW_INPUT_UNKNOWN', `${path}.from`, `unknown workflow input "${from.input}"`, issues);
      return undefined;
    }
    return input.type;
  }
  if (from.kind === 'node_output') {
    const node = nodesById.get(from.node);
    if (node === undefined) {
      issue('IR_BINDING_NODE_UNKNOWN', `${path}.from`, `unknown source node "${from.node}"`, issues);
      return undefined;
    }
    const port = node.outputs.find((candidate) => candidate.name === from.output);
    if (port === undefined) {
      issue('IR_BINDING_OUTPUT_UNKNOWN', `${path}.from`, `node "${from.node}" has no output port "${from.output}"`, issues);
      return undefined;
    }
    return port.type;
  }
  issue('IR_OUTPUT_BINDING_INVALID', `${path}.from`, 'workflow output must bind to a workflow input or node output', issues);
  return undefined;
}

/** Semantic-stage subworkflow dependency checks (exported for symmetry). */
export function validateSubworkflowDependency(
  node: WorkflowNode,
  issues: ValidationIssue[],
): void {
  if (node.spec.class !== 'subworkflow') return;
  const dependency = node.spec.subworkflow;
  if (dependency.workflowId.length === 0 || dependency.versionRef.length === 0) {
    issue(
      'IR_SUBWORKFLOW_DEPENDENCY_INVALID',
      `$.ir.nodes.${node.id}.spec.subworkflow`,
      'a subworkflow dependency requires non-empty workflowId and versionRef (an immutable version reference)',
      issues,
    );
  }
  if (!node.capabilityRequirements.includes('workflow.execute')) {
    issue(
      'IR_SUBWORKFLOW_CAPABILITY_REQUIRED',
      `$.ir.nodes.${node.id}.capabilityRequirements`,
      'a subworkflow node must declare the canonical capability "workflow.execute"',
      issues,
    );
  }
}

// invoked capability registry conformance (deterministic_api spec)
export function validateInvokedCapability(node: WorkflowNode, issues: ValidationIssue[]): void {
  if (node.spec.class !== 'deterministic_api') return;
  if (!isCanonicalCapability(node.spec.capability)) {
    issue(
      'IR_CAPABILITY_NON_CANONICAL',
      `$.ir.nodes.${node.id}.spec.capability`,
      `"${node.spec.capability}" is not a canonical registry capability name (aliases and platform SDK names are forbidden)`,
      issues,
    );
  }
}
