/**
 * V2-003 — compatibility and version negotiation (deterministic, fail-closed).
 *
 * Two independent decision layers:
 *
 *  1. IR SCHEMA version negotiation (consumer vs offered artifact):
 *     accept (supported), upgrade (a declared safe migration chain reaches a
 *     supported version), reject (schema too new / no safe path / no
 *     supported versions). Never guesses downgrades.
 *
 *  2. WORKFLOW version update negotiation: the candidate's DECLARED
 *     version-affecting compatibility metadata is cross-checked against the
 *     public-surface diff COMPUTED from the two IRs. Inconsistent
 *     declarations are rejected (honest metadata only); consistent
 *     declarations yield accept (drop-in), upgrade (additive-compatible) or
 *     reject (breaking). Adoption policy itself stays with the customer's
 *     installation/deployment policy (constitution §15) — this layer only
 *     classifies compatibility.
 */
import type {
  IrSchemaMigration,
  IrSchemaNegotiationResult,
  PortDeclaration,
  WorkflowOutputBinding,
  WorkflowSurfaceSnapshot,
  WorkflowVersionUpdateDecision,
} from '../types.js';
import { isPortTypeAssignable } from './type-system.js';

// ============================================================================
// §1  IR schema version negotiation
// ============================================================================

export function negotiateIrSchemaVersion(
  consumer: { readonly supportedIrSchemaVersions: readonly number[] },
  offered: { readonly irSchemaVersion: number },
  migrations: readonly IrSchemaMigration[] = [],
): IrSchemaNegotiationResult {
  const supported = [...new Set(consumer.supportedIrSchemaVersions)].filter((version) =>
    Number.isInteger(version),
  );
  if (supported.length === 0) {
    return { decision: 'reject', reason: 'no-supported-versions' };
  }
  if (supported.includes(offered.irSchemaVersion)) {
    return { decision: 'accept', irSchemaVersion: offered.irSchemaVersion };
  }
  const maxSupported = Math.max(...supported);
  if (offered.irSchemaVersion > maxSupported) {
    // the consumer cannot interpret a NEWER schema — fail closed, never guess
    return { decision: 'reject', reason: 'schema-too-new' };
  }
  // offered is older: only a declared safe migration chain may bridge it
  const adjacency = new Map<number, number[]>();
  for (const migration of migrations) {
    if (!migration.upgradeSafe) continue;
    const targets = adjacency.get(migration.from) ?? [];
    targets.push(migration.to);
    adjacency.set(migration.from, targets);
  }
  const reachable = new Set<number>();
  const queue = [offered.irSchemaVersion];
  reachable.add(offered.irSchemaVersion);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  const reachableSupported = supported.filter((version) => reachable.has(version));
  if (reachableSupported.length === 0) {
    return { decision: 'reject', reason: 'no-upgrade-path' };
  }
  return {
    decision: 'upgrade',
    from: offered.irSchemaVersion,
    to: Math.max(...reachableSupported),
  };
}

// ============================================================================
// §2  Workflow version update negotiation
// ============================================================================

type SurfaceChange = 'none' | 'additive' | 'breaking';

export function negotiateWorkflowVersionUpdate(input: {
  readonly installed: WorkflowSurfaceSnapshot;
  readonly candidate: WorkflowSurfaceSnapshot;
}): WorkflowVersionUpdateDecision {
  const inputChange = diffInputSurfaces(input.installed.inputs, input.candidate.inputs);
  const outputChange = diffOutputSurfaces(input.installed.outputs, input.candidate.outputs);
  const declared = input.candidate.compatibility;

  if (declared.inputSurfaceChange !== inputChange || declared.outputSurfaceChange !== outputChange) {
    return {
      decision: 'reject',
      reason: 'compatibility-declaration-inconsistent',
    };
  }

  if (inputChange === 'breaking' || outputChange === 'breaking') {
    if (declared.compatibilityLevel === 'incompatible') {
      return { decision: 'reject', reason: 'breaking-change' };
    }
    return { decision: 'reject', reason: 'compatibility-declaration-inconsistent' };
  }

  const anyAdditive = inputChange === 'additive' || outputChange === 'additive';
  if (!anyAdditive) {
    if (declared.compatibilityLevel === 'equivalent') {
      return { decision: 'accept', reason: 'public-surface-unchanged' };
    }
    return { decision: 'reject', reason: 'compatibility-declaration-inconsistent' };
  }
  if (declared.compatibilityLevel === 'compatible') {
    return { decision: 'upgrade', reason: 'additive-compatible-surface' };
  }
  return { decision: 'reject', reason: 'compatibility-declaration-inconsistent' };
}

function diffInputSurfaces(
  installed: readonly PortDeclaration[],
  candidate: readonly PortDeclaration[],
): SurfaceChange {
  const installedByName = new Map(installed.map((port) => [port.name, port]));
  const candidateByName = new Map(candidate.map((port) => [port.name, port]));
  let change: SurfaceChange = 'none';

  for (const [name, candidatePort] of candidateByName) {
    const installedPort = installedByName.get(name);
    if (installedPort === undefined) {
      // added input: optional is additive (callers may ignore it), required is breaking
      change = combine(change, candidatePort.optional ? 'additive' : 'breaking');
      continue;
    }
    if ((installedPort.optional ?? false) !== (candidatePort.optional ?? false)) {
      if (installedPort.optional && !candidatePort.optional) {
        // optional → required: existing callers may omit it
        change = combine(change, 'breaking');
      } else {
        // required → optional: more permissive, non-breaking extension
        change = combine(change, 'additive');
      }
    }
    if (!isPortTypeAssignable(installedPort.type, candidatePort.type)) {
      // old values are no longer valid inputs
      change = combine(change, 'breaking');
    } else if (!typesIdentical(installedPort.type, candidatePort.type)) {
      // widening: the version accepts strictly more input data
      change = combine(change, 'additive');
    }
  }
  for (const name of installedByName.keys()) {
    if (!candidateByName.has(name)) {
      // removed input: callers that pass it can no longer be served
      change = combine(change, 'breaking');
    }
  }
  return change;
}

function diffOutputSurfaces(
  installed: readonly WorkflowOutputBinding[],
  candidate: readonly WorkflowOutputBinding[],
): SurfaceChange {
  const installedByName = new Map(installed.map((port) => [port.name, port]));
  const candidateByName = new Map(candidate.map((port) => [port.name, port]));
  let change: SurfaceChange = 'none';

  for (const [name, candidatePort] of candidateByName) {
    const installedPort = installedByName.get(name);
    if (installedPort === undefined) {
      // added output: consumers may ignore it
      change = combine(change, 'additive');
      continue;
    }
    if (isPortTypeAssignable(candidatePort.type, installedPort.type)) {
      // the candidate still delivers the promised type (narrowing is fine)
      continue;
    }
    change = combine(change, 'breaking');
  }
  for (const name of installedByName.keys()) {
    if (!candidateByName.has(name)) {
      // removed output: consumers reading it break
      change = combine(change, 'breaking');
    }
  }
  return change;
}

function combine(current: SurfaceChange, next: SurfaceChange): SurfaceChange {
  if (current === 'breaking' || next === 'breaking') return 'breaking';
  if (current === 'additive' || next === 'additive') return 'additive';
  return 'none';
}

function typesIdentical(a: PortDeclaration['type'], b: PortDeclaration['type']): boolean {
  return isPortTypeAssignable(a, b) && isPortTypeAssignable(b, a);
}
