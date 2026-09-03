/**
 * V2-016 — the dependent-step composition precondition admission path.
 *
 * OWNERSHIP (work order V2-016, "Ownership boundary"): this module owns
 * EXACTLY the typed structural validation of caller-supplied
 * `DependentStepPrecondition`s and the canonical causal-parent derivation
 * for admitted dependent steps. It is deliberately NON-AUTHORITATIVE:
 *
 *   - it performs NO cryptographic verification (V2-014 owns that authority;
 *     the precondition currency is the merged verifier's
 *     `VerifiedExecutionFact` — the RESULT of a canonical verification under
 *     the caller's verifier policy, never raw attestation bytes);
 *   - it grants NO authorization and NO capability (the safe-action policy,
 *     placement, and attestation gates apply AFTER admission, unchanged);
 *   - it knows NOTHING about proof-graph topology or WorkflowIR dependency
 *     semantics (V2-015 / V2-003 — dependence is DECLARED here as runtime
 *     configuration + a typed input, never derived from the graph).
 *
 * FAILURE DISCIPLINE: every rejection is typed with a precise reason
 * (fail-closed, never a silent default, never a partial admission). All
 * validation is pure structure — zero host I/O, zero recorder commands —
 * so an invalid precondition set can never produce a side effect of any
 * kind (the runtime raises it at drive entry, before the drive's first
 * recorder command).
 */
import type { WorkflowRun } from '../../workflow-runs/index.js';
import type { VerifiedExecutionFact } from '../../execution-attestation/index.js';
import type { ComputerAgentPolicy, DependentStepPrecondition } from '../types.js';

/**
 * One admitted precondition (the validated form). `causalParentDigests` is
 * the canonical deterministic form: sorted, de-duplicated, exactly the
 * declared set for the (dependent step, predecessor) relationship.
 */
export interface AdmittedStepPrecondition {
  readonly dependentStepId: string;
  readonly predecessorAttestationId: string;
  readonly verifiedPredecessor: VerifiedExecutionFact;
  readonly causalParentDigests: readonly string[];
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: string;
}

/** The typed admission rejection (fail-closed; rendered into the raised error). */
export interface PreconditionRejection {
  readonly reason: string;
}

/** The admission result: the per-dependent-step admitted map, or a typed rejection. */
export type PreconditionAdmission =
  | { readonly ok: true; readonly admitted: ReadonlyMap<string, readonly AdmittedStepPrecondition[]> }
  | { readonly ok: false; readonly rejection: PreconditionRejection };

/** The steps this runtime's dependent-admission policy declares dependent. */
export function dependentStepsOf(policy: ComputerAgentPolicy): ReadonlySet<string> {
  return new Set(policy.dependentStepIds ?? []);
}

/**
 * Structurally validate and admit the supplied composition preconditions
 * for the run being driven. EVERY check is fail-closed and typed:
 *
 *   1. a precondition may only target a step the runtime's
 *      dependent-admission policy declares (configuration consistency);
 *   2. the precondition's declared Run/WorkflowVersion identity must match
 *      the run being driven (cross-run/cross-version substitution);
 *   3. the embedded V2-014-derived fact's statement must bind the SAME run
 *      and the SAME WorkflowVersion (+ semantic digest) — a predecessor
 *      minted for a different execution context is a substitution attack;
 *   4. the relied-upon `predecessorAttestationId` must be the fact's own
 *      attestation identity;
 *   5. the predecessor's statement step must differ from the dependent step
 *      (a step cannot be its own predecessor — wrong relationship binding);
 *   6. `causalParentDigests` must be non-empty ("one or more");
 *   7. per dependent step, the declared causal-parent digests (as a set)
 *      must EQUAL the execution digests of the verified predecessor facts
 *      supplied for that step — the runtime never invents a parent digest
 *      and never silently drops a relied-upon predecessor.
 */
export function admitDependentPreconditions(
  run: WorkflowRun,
  policy: ComputerAgentPolicy,
  supplied: readonly DependentStepPrecondition[] | undefined,
): PreconditionAdmission {
  const dependentSteps = dependentStepsOf(policy);
  const admitted = new Map<string, AdmittedStepPrecondition[]>();

  for (const precondition of supplied ?? []) {
    const stepId = precondition.dependentStepId;
    // Check 1 — policy consistency (a precondition for a step the runtime
    // does not declare dependent is a caller configuration error: fail
    // closed rather than silently consuming or ignoring it).
    if (!dependentSteps.has(stepId)) {
      return {
        ok: false,
        rejection: {
          reason: `precondition targets step "${stepId}", but the runtime's dependent-admission policy does not declare that step dependent (configuration mismatch — nothing is admitted)`,
        },
      };
    }
    // Check 2 — the declared Run/WorkflowVersion binding.
    if (precondition.runId !== run.id) {
      return {
        ok: false,
        rejection: {
          reason: `precondition for step "${stepId}" is bound to run "${precondition.runId}" but the run being driven is "${run.id}" (cross-run substitution rejected)`,
        },
      };
    }
    if (precondition.workflowVersionId !== run.versionId) {
      return {
        ok: false,
        rejection: {
          reason: `precondition for step "${stepId}" is bound to WorkflowVersion "${precondition.workflowVersionId}" but the run pins "${run.versionId}" (cross-version substitution rejected)`,
        },
      };
    }
    if (precondition.workflowVersionSemanticDigest !== run.versionSemanticDigest) {
      return {
        ok: false,
        rejection: {
          reason: `precondition for step "${stepId}" declares semantic digest "${precondition.workflowVersionSemanticDigest}" but the run pins "${run.versionSemanticDigest}" (version-content substitution rejected)`,
        },
      };
    }
    // Check 3 — the fact's own statement binding (the predecessor must be
    // from the SAME run and the SAME pinned version).
    const statement = precondition.verifiedPredecessor.statement;
    if (statement.runId !== run.id) {
      return {
        ok: false,
        rejection: {
          reason: `the verified predecessor for step "${stepId}" attests run "${statement.runId}" but the run being driven is "${run.id}" (predecessor cross-run substitution rejected)`,
        },
      };
    }
    if (statement.workflowVersionId !== run.versionId) {
      return {
        ok: false,
        rejection: {
          reason: `the verified predecessor for step "${stepId}" attests WorkflowVersion "${statement.workflowVersionId}" but the run pins "${run.versionId}" (predecessor cross-version substitution rejected)`,
        },
      };
    }
    if (statement.workflowVersionSemanticDigest !== run.versionSemanticDigest) {
      return {
        ok: false,
        rejection: {
          reason: `the verified predecessor for step "${stepId}" attests semantic digest "${statement.workflowVersionSemanticDigest}" but the run pins "${run.versionSemanticDigest}" (predecessor version-content substitution rejected)`,
        },
      };
    }
    // Check 4 — the relied-upon attestation identity.
    if (precondition.predecessorAttestationId !== precondition.verifiedPredecessor.attestationId) {
      return {
        ok: false,
        rejection: {
          reason: `precondition for step "${stepId}" relies on attestation "${precondition.predecessorAttestationId}" but the supplied V2-014-derived verified fact is "${precondition.verifiedPredecessor.attestationId}" (identity mismatch rejected)`,
        },
      };
    }
    // Check 5 — the predecessor/dependent relationship (no self-parenting).
    if (statement.stepId === stepId) {
      return {
        ok: false,
        rejection: {
          reason: `the verified predecessor for step "${stepId}" attests step "${String(statement.stepId)}" — a step cannot be its own predecessor (relationship binding rejected)`,
        },
      };
    }
    // Check 6 — "one or more" causal parent digests.
    if (precondition.causalParentDigests.length === 0) {
      return {
        ok: false,
        rejection: {
          reason: `precondition for step "${stepId}" declares NO causal parent digests — a dependent execution declares one or more (empty declaration rejected, never a silent causalParents fallback)`,
        },
      };
    }
    for (const digest of precondition.causalParentDigests) {
      if (typeof digest !== 'string' || digest.length === 0) {
        return {
          ok: false,
          rejection: {
            reason: `precondition for step "${stepId}" declares a malformed causal parent digest (empty or non-string) — rejected`,
          },
        };
      }
    }

    const entry: AdmittedStepPrecondition = {
      dependentStepId: stepId,
      predecessorAttestationId: precondition.predecessorAttestationId,
      verifiedPredecessor: precondition.verifiedPredecessor,
      causalParentDigests: canonicalParentDigests(precondition.causalParentDigests),
      runId: precondition.runId,
      workflowVersionId: precondition.workflowVersionId,
      workflowVersionSemanticDigest: precondition.workflowVersionSemanticDigest,
    };
    const existing = admitted.get(stepId);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      admitted.set(stepId, [entry]);
    }
  }

  // Check 7 — per dependent step, the declared parents must be exactly the
  // supplied verified predecessors' execution digests (set equality both
  // ways: nothing invented, nothing silently dropped).
  for (const [stepId, entries] of admitted) {
    const declared = new Set<string>();
    const factDigests = new Set<string>();
    for (const entry of entries) {
      for (const digest of entry.causalParentDigests) {
        declared.add(digest);
      }
      factDigests.add(entry.verifiedPredecessor.executionDigest.digest);
    }
    for (const digest of declared) {
      if (!factDigests.has(digest)) {
        return {
          ok: false,
          rejection: {
            reason: `step "${stepId}" declares causal parent digest ${digest}, which is not the execution digest of any supplied V2-014-derived verified predecessor (the runtime never invents or accepts unverified parent digests)`,
          },
        };
      }
    }
    for (const digest of factDigests) {
      if (!declared.has(digest)) {
        return {
          ok: false,
          rejection: {
            reason: `step "${stepId}" relies on a verified predecessor with execution digest ${digest} but does not declare it as a causal parent (a relied-upon predecessor cannot be silently dropped from the causal record)`,
          },
        };
      }
    }
  }

  return { ok: true, admitted };
}

/**
 * The canonical deterministic causal-parent form: sorted, de-duplicated.
 * Ordering is deterministic (hex digest sort) and the set semantics are
 * canonical (a repeated declared digest is ONE parent).
 */
export function canonicalParentDigests(digests: readonly string[]): readonly string[] {
  return [...new Set(digests)].sort();
}

/**
 * The causal-parent execution digests for one step's attestation material:
 * exactly the declared parents of the step's ADMITTED preconditions
 * (sorted, de-duplicated), or the empty list for steps without admitted
 * preconditions (non-dependent / zero-parent behavior — unchanged).
 */
export function causalParentsForStep(
  admitted: ReadonlyMap<string, readonly AdmittedStepPrecondition[]>,
  stepId: string,
): readonly string[] {
  const entries = admitted.get(stepId);
  if (entries === undefined || entries.length === 0) {
    return [];
  }
  const declared = new Set<string>();
  for (const entry of entries) {
    for (const digest of entry.causalParentDigests) {
      declared.add(digest);
    }
  }
  return [...declared].sort();
}
