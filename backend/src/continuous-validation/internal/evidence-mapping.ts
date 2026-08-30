/**
 * WORK-064 Task 7 — the evidence mapping into the EXISTING /verification
 * authority (spec/work-orders/WORK-064.md invariant 7;
 * spec/architecture/v1.1/evidence-provenance-model.md §2–§4).
 *
 * THE CHAIN: raw observation → validation result → FORMAL verification
 * evidence (in /verification). This module is the second arrow — an ADAPTER
 * that calls the existing authority's public boundary
 * (`VerificationService.attachEvidence`), nothing else:
 *
 *   - it creates NO `validation_evidence` table/store — the evidence row
 *     lives in /verification's own store, retrievable through its own
 *     repository;
 *   - synthetic validation is agent-produced (NOT CI-ingested), so it
 *     enters through the public/manual path → `authority: 'claim'` — the
 *     honest server-side classification (the PR #14 authority boundary);
 *   - the mapper NEVER overwrites raw observations or outcomes — it reads
 *     the immutable completed run and creates a NEW derived evidence row
 *     carrying the full validation provenance in its metadata;
 *   - a failed mapping is explicit (the authority's error propagates);
 *     nothing is silently converted to healthy.
 */
import type { EvidenceResult, VerificationService } from '@modules/verification/index.js';
import type { ValidationRun, ValidationOutcomeKind } from '../types.js';
import { ValidationDomainError } from '../types.js';

/** The provenance-preserving reference to the formal evidence row. */
export interface ValidationEvidenceReference {
  readonly validationRunId: string;
  readonly validationJourneyId: string;
  readonly observationIds: readonly string[];
  /** The /verification Evidence row this validation result is bound to. */
  readonly verificationEvidenceId: string;
  /** The authority the /verification service classified the evidence with. */
  readonly verificationEvidenceAuthority: 'claim' | 'authoritative';
  /** The validation outcome kind the evidence records (never flipped). */
  readonly outcomeKind: ValidationOutcomeKind;
}

/** The mapping input: the completed run + the existing verification context. */
export interface MapValidationOutcomeToVerificationInput {
  /** The COMPLETED validation run (outcome required). */
  readonly run: ValidationRun;
  /** The project whose verification run this evidence attaches to. */
  readonly projectId: string;
  /** The EXISTING /verification run id (the mapper never creates one). */
  readonly verificationRunId: string;
}

/**
 * The outcome → EvidenceResult translation (the ONLY place this mapping
 * lives; /verification owns the vocabulary):
 *
 *   healthy              → 'pass'    (the check ran and passed)
 *   validation_failure   → 'fail'    (the check ran and failed)
 *   effect_policy_violation → 'blocked' (the check could not run)
 *   environment_error    → 'blocked' (the check could not run)
 */
export function outcomeToEvidenceResult(outcomeKind: ValidationOutcomeKind): EvidenceResult {
  switch (outcomeKind) {
    case 'healthy':
      return 'pass';
    case 'validation_failure':
      return 'fail';
    case 'effect_policy_violation':
    case 'environment_error':
      return 'blocked';
    default:
      return 'unknown';
  }
}

/**
 * Map a completed validation run's outcome into the EXISTING /verification
 * evidence authority. Deterministic; propagates the authority's errors (a
 * failed mapping is explicit). Throws a typed {@link ValidationDomainError}
 * for domain-level violations (un-finalized run, provenance mismatch).
 */
export async function mapValidationOutcomeToVerification(
  input: MapValidationOutcomeToVerificationInput,
  verificationAuthority: VerificationService,
): Promise<ValidationEvidenceReference> {
  const { run, projectId, verificationRunId } = input;

  if (run.status !== 'completed' || run.outcome === null) {
    throw new ValidationDomainError(
      'FINALIZE_RUN_ALREADY_COMPLETED',
      `run ${run.id} has no finalized outcome to map (only completed runs map into /verification)`,
    );
  }
  if (run.outcome.provenance.runId !== run.id || run.outcome.provenance.journeyId !== run.journeyId) {
    throw new ValidationDomainError(
      'OBSERVATION_PROVENANCE_INVALID',
      `the outcome's provenance does not match run ${run.id} (broken provenance chain is rejected)`,
    );
  }
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new ValidationDomainError(
      'OBSERVATION_PROVENANCE_INVALID',
      'the mapping requires the projectId of the verification context',
    );
  }
  if (typeof verificationRunId !== 'string' || verificationRunId.trim() === '') {
    throw new ValidationDomainError(
      'OBSERVATION_PROVENANCE_INVALID',
      'the mapping requires an EXISTING verificationRunId (the mapper never creates verification runs)',
    );
  }

  const outcome = run.outcome;
  const observationIds = run.observations.map((observation) => observation.id);
  const failureCount =
    outcome.kind === 'validation_failure' ? outcome.failures.length : null;

  // The full validation provenance travels with the evidence row (the
  // evidence-provenance-model §3 chain, machine-readable for WORK-067/068):
  const metadata: Record<string, unknown> = {
    validationRunId: run.id,
    validationJourneyId: run.journeyId,
    validationOutcome: outcome.kind,
    environmentId: run.environmentId,
    environmentKind: run.environmentKind,
    effectPolicy: run.effectPolicy,
    mode: run.mode,
    trigger: run.trigger,
    releaseRef: run.releaseRef,
    observationIds,
    testIdentity: {
      principalClass: run.identity.principalClass,
      tenantId: run.identity.tenantId,
      issuer: run.identity.issuer,
    },
    ...(failureCount !== null ? { failureCount } : {}),
  };

  const contentSummary =
    outcome.kind === 'validation_failure'
      ? `continuous validation run ${run.id} (journey ${run.journeyId}): validation_failure — ${failureCount} failed expectation(s)`
      : `continuous validation run ${run.id} (journey ${run.journeyId}): ${outcome.kind}`;

  // The EXISTING authority's public boundary — server-side authority
  // classification ('claim' for the agent path), its transaction/error
  // semantics, its store. Errors propagate (explicit failure).
  const evidence = await verificationAuthority.attachEvidence({
    projectId,
    verificationRunId,
    evidenceType: 'continuous_validation',
    provider: 'agent',
    externalRef: `continuous-validation:${run.id}`,
    result: outcomeToEvidenceResult(outcome.kind),
    contentSummary,
    metadata,
  });

  return Object.freeze({
    validationRunId: run.id,
    validationJourneyId: run.journeyId,
    observationIds: Object.freeze(observationIds),
    verificationEvidenceId: evidence.id,
    verificationEvidenceAuthority: evidence.authority,
    outcomeKind: outcome.kind,
  });
}
