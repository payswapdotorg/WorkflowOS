/**
 * WORK-051 — the default ArchitectureCheckpointService.
 *
 * APPLICATION-LAYER ORCHESTRATION ONLY (issue #51). The evaluation flow:
 *
 *   1. Resolve the Work Item, its ArchitectureVersion, and its Architecture
 *      SERVER-SIDE (work item → version → architecture → project). Caller
 *      identity is never trusted: the expected project is VALIDATED against
 *      the resolved project and a mismatch throws BEFORE any detector runs.
 *   2. Derive the impact profile (metadata.architectureImpact, fail-closed
 *      default 'high') and check checkpoint applicability.
 *   3. Idempotent replay: an identical idempotency key with a recorded
 *      completed checkpoint returns the recorded result (determinism across
 *      signal retries).
 *   4. Revision-bound kinds (pr_conformance, verification_entry) require an
 *      implementation revision — a null revision is 'inconclusive' (fail
 *      closed).
 *   5. The governing version must be FROZEN (immutable) — anything else is
 *      'inconclusive' (fail closed).
 *   6. Evaluate the version's assertion set with the deterministic
 *      detectors (appliesToCheckpoints pre-filter, unknown-detector ⇒
 *      inconclusive).
 *   7. Aggregate: any blocking fail OR blocking inconclusive ⇒ 'blocked'
 *      (fail-closed); else any advisory fail/inconclusive ⇒
 *      'passed_with_advisories'; else 'passed'.
 *   8. Persist the FULL traceability chain through the /verification public
 *      contract (createRun → one Evidence row per assertion → one summary
 *      Evidence row → finalizeOrchestrationRun). Every later checkpoint
 *      creates a NEW revision-bound run — a prior result is never
 *      overwritten.
 *
 * The service NEVER mutates workflow state (no WorkflowEngine, no
 * workflow-transition calls), NEVER writes architecture definitions (the
 * reader ports have no mutation methods), and NEVER issues SQL (evidence
 * flows exclusively through VerificationService).
 */

import type { Logger } from '@platform/logger.js';

import type {
  ArchitectureAssertion,
  ArchitectureCheckpointGateInput,
  ArchitectureCheckpointGateResult,
  ArchitectureCheckpointKind,
  ArchitectureCheckpointResult,
  ArchitectureCheckpointService,
  ArchitectureImpactLevel,
  ArchitectureReader,
  ArchitectureVersionReader,
  AssertionEvaluation,
  DetectorInput,
  DetectorResult,
  VerificationService,
  WorkItemReader,
} from '../types.js';
import { CrossTenantCheckpointAccessError, IMPACT_CHECKPOINT_MATRIX } from '../types.js';

/** The /verification run source that identifies orchestration-produced checkpoint runs. */
export const CHECKPOINT_RUN_SOURCE = 'architecture-checkpoint';

const REVISION_BOUND_KINDS: readonly ArchitectureCheckpointKind[] = [
  'pr_conformance',
  'verification_entry',
];

export interface DefaultArchitectureCheckpointServiceDeps {
  workItemReader: WorkItemReader;
  architectureVersionReader: ArchitectureVersionReader;
  architectureReader: ArchitectureReader;
  assertionReader: {
    listForVersion(architectureVersionId: string): Promise<ArchitectureAssertion[]>;
  };
  verificationService: VerificationService;
  detectors: Map<string, import('../types.js').ArchitectureAssertionDetector>;
  logger?: Logger;
}

export class DefaultArchitectureCheckpointService implements ArchitectureCheckpointService {
  private readonly deps: DefaultArchitectureCheckpointServiceDeps;

  constructor(deps: DefaultArchitectureCheckpointServiceDeps) {
    this.deps = deps;
  }

  /** The /workflows lifecycle-gate projection. */
  async evaluate(
    input: ArchitectureCheckpointGateInput,
  ): Promise<ArchitectureCheckpointGateResult> {
    const result = await this.evaluateCheckpoint(input);
    return {
      allowed: result.allowed,
      applicable: result.applicable,
      status: result.status,
      checkpointId: result.checkpointId,
      reasons: [...result.blockingFindings, ...result.advisories],
    };
  }

  /** The full evaluation with per-assertion detector results. */
  async evaluateCheckpoint(
    input: ArchitectureCheckpointGateInput,
  ): Promise<ArchitectureCheckpointResult> {
    // --- 1. Server-side authoritative resolution -------------------------
    const workItem = await this.deps.workItemReader.findById(input.workItemId);
    if (!workItem) {
      throw new Error(`checkpoint: work item ${input.workItemId} not found`);
    }
    const version = await this.deps.architectureVersionReader.findById(
      workItem.architectureVersionId,
    );
    if (!version) {
      throw new Error(
        `checkpoint: architecture version ${workItem.architectureVersionId} not found`,
      );
    }
    const architecture = await this.deps.architectureReader.findById(version.architectureId);
    if (!architecture) {
      throw new Error(`checkpoint: architecture ${version.architectureId} not found`);
    }

    // --- 2. Tenant guard: BEFORE any detector execution ------------------
    // The caller's expected project must match the server-resolved project.
    // A mismatch throws — zero detectors run for a cross-tenant caller.
    if (input.expectedProjectId !== architecture.projectId) {
      throw new CrossTenantCheckpointAccessError(
        input.expectedProjectId,
        architecture.projectId,
        input.workItemId,
      );
    }

    // --- 3. Impact profile + applicability -------------------------------
    const impact = deriveImpact(workItem);
    const applicableKinds = IMPACT_CHECKPOINT_MATRIX[input.checkpointKind];
    const applicable = applicableKinds.includes(impact);
    if (!applicable) {
      // Impact controls FREQUENCY ONLY: a non-applicable checkpoint is not
      // evaluated and leaves no evidence. It never weakens the rules — the
      // kinds that DO run always run at full severity.
      this.deps.logger?.info('checkpoint.not_applicable', {
        workItemId: input.workItemId,
        checkpointKind: input.checkpointKind,
        impact,
      });
      return {
        checkpointKind: input.checkpointKind,
        workItemId: input.workItemId,
        architectureVersionId: version.id,
        implementationRevision: input.implementationRevision ?? null,
        impact,
        applicable: false,
        status: null,
        allowed: true,
        evaluations: [],
        blockingFindings: [],
        advisories: [],
        checkpointId: null,
        replayed: false,
        evaluatedAt: new Date().toISOString(),
      };
    }

    // --- 4. Idempotent replay ---------------------------------------------
    if (input.idempotencyKey) {
      const replay = await this.findRecordedResult(input.workItemId, input.idempotencyKey);
      if (replay) {
        this.deps.logger?.info('checkpoint.replayed', {
          workItemId: input.workItemId,
          checkpointKind: input.checkpointKind,
          idempotencyKey: input.idempotencyKey,
          status: replay.status,
        });
        return replay;
      }
    }

    const implementationRevision = input.implementationRevision ?? null;

    // --- 5. Context guards (fail closed, WITH durable evidence) -----------
    const contextReasons: string[] = [];

    // Revision-bound kinds require the exact implementation revision.
    if (REVISION_BOUND_KINDS.includes(input.checkpointKind) && !implementationRevision) {
      contextReasons.push(
        `${input.checkpointKind} checkpoint requires an implementation revision — none was provided (fail closed)`,
      );
    }

    // The governing version must be FROZEN (immutable). A draft/superseded
    // version is not a valid conformance anchor.
    if (version.state !== 'frozen') {
      contextReasons.push(
        `the governing architecture version is ${version.state}, not frozen — conformance must anchor on an immutable version`,
      );
    }

    if (contextReasons.length > 0) {
      const result: ArchitectureCheckpointResult = {
        checkpointKind: input.checkpointKind,
        workItemId: input.workItemId,
        architectureVersionId: version.id,
        implementationRevision,
        impact,
        applicable: true,
        status: 'inconclusive',
        allowed: false,
        evaluations: [],
        blockingFindings: contextReasons,
        advisories: [],
        checkpointId: null,
        replayed: false,
        evaluatedAt: new Date().toISOString(),
      };
      result.checkpointId = await this.persistCheckpointEvidence(
        architecture.projectId,
        result,
        input,
      );
      return result;
    }

    // --- 6. Evaluate the assertion set ------------------------------------
    const assertions = await this.deps.assertionReader.listForVersion(version.id);
    const evaluations: AssertionEvaluation[] = [];
    for (const assertion of assertions) {
      evaluations.push(
        await this.evaluateAssertion(assertion, input, {
          projectId: architecture.projectId,
          workItemId: input.workItemId,
          architectureVersionId: version.id,
          implementationRevision,
          workOrderId: input.workOrderId ?? null,
        }),
      );
    }

    // --- 7. Aggregate (fail closed) ---------------------------------------
    const blockingFindings: string[] = [];
    const advisories: string[] = [];
    for (const e of evaluations) {
      if (e.status === 'not_applicable' || e.status === 'pass') continue;
      const line = `${e.assertionId} [${e.severity}/${e.status}]: ${e.summary}`;
      if (e.severity === 'blocking') {
        // A blocking assertion that FAILS **or is INCONCLUSIVE** fails
        // closed (design §7) — inconclusive is a denial, never a pass.
        blockingFindings.push(line);
      } else {
        advisories.push(line);
      }
    }
    const status =
      blockingFindings.length > 0
        ? 'blocked'
        : advisories.length > 0
          ? 'passed_with_advisories'
          : 'passed';

    const result: ArchitectureCheckpointResult = {
      checkpointKind: input.checkpointKind,
      workItemId: input.workItemId,
      architectureVersionId: version.id,
      implementationRevision,
      impact,
      applicable: true,
      status,
      allowed: status === 'passed' || status === 'passed_with_advisories',
      evaluations,
      blockingFindings,
      advisories,
      checkpointId: null,
      replayed: false,
      evaluatedAt: new Date().toISOString(),
    };

    // --- 8. Durable evidence through /verification ------------------------
    result.checkpointId = await this.persistCheckpointEvidence(
      architecture.projectId,
      result,
      input,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // Assertion evaluation
  // -------------------------------------------------------------------------

  private async evaluateAssertion(
    assertion: ArchitectureAssertion,
    input: ArchitectureCheckpointGateInput,
    context: DetectorInput['context'],
  ): Promise<AssertionEvaluation> {
    const cfg = assertion.detectorConfig ?? {};

    // Static applicability pre-filter (no detector invocation when the
    // assertion declares it does not apply to this checkpoint kind).
    if (Array.isArray(cfg.appliesToCheckpoints) && cfg.appliesToCheckpoints.length > 0) {
      const kinds = cfg.appliesToCheckpoints as string[];
      if (!kinds.includes(input.checkpointKind)) {
        return {
          assertionId: assertion.assertionId,
          assertionRowId: assertion.id,
          severity: assertion.severity,
          detectorKind: assertion.detectorKind,
          status: 'not_applicable',
          summary: `not applicable at the ${input.checkpointKind} checkpoint`,
          details: {},
        };
      }
    }

    const detector = this.deps.detectors.get(assertion.detectorKind);
    if (!detector) {
      // Unknown detector ⇒ inconclusive ⇒ fail-closed for blocking.
      return {
        assertionId: assertion.assertionId,
        assertionRowId: assertion.id,
        severity: assertion.severity,
        detectorKind: assertion.detectorKind,
        status: 'inconclusive',
        summary: `no detector is registered for kind '${assertion.detectorKind}'`,
        details: {},
      };
    }

    let result: DetectorResult;
    try {
      result = await detector.evaluate({ assertion, checkpointKind: input.checkpointKind, context });
    } catch (err) {
      // A detector crash is an INCONCLUSIVE evaluation — never a pass.
      result = {
        status: 'inconclusive',
        summary: `detector '${assertion.detectorKind}' raised: ${(err as Error).message}`,
      };
    }
    return {
      assertionId: assertion.assertionId,
      assertionRowId: assertion.id,
      severity: assertion.severity,
      detectorKind: assertion.detectorKind,
      status: result.status,
      summary: result.summary,
      details: result.details ?? {},
    };
  }

  // -------------------------------------------------------------------------
  // Evidence persistence (through the /verification public contract ONLY)
  // -------------------------------------------------------------------------

  private async persistCheckpointEvidence(
    projectId: string,
    result: ArchitectureCheckpointResult,
    input: ArchitectureCheckpointGateInput,
  ): Promise<string | null> {
    // The FULL traceability chain (design §9) is carried by the
    // /verification run + its evidence rows:
    //
    //   ArchitectureVersion → WorkItem → implementation revision →
    //     assertion set (one Evidence row per assertion) → checkpoint
    //     result (summary Evidence row + run summary).
    let runId: string | null = null;
    try {
      const run = await this.deps.verificationService.createRun({
        projectId,
        workItemId: result.workItemId,
        workOrderId: input.workOrderId ?? null,
        architectureVersionId: result.architectureVersionId,
        source: CHECKPOINT_RUN_SOURCE,
        sourceRef: result.implementationRevision ?? result.checkpointKind,
        executionId: input.executionId,
        metadata: {
          checkpointKind: result.checkpointKind,
          implementationRevision: result.implementationRevision,
          impact: result.impact,
          checkpointIdempotencyKey: input.idempotencyKey ?? null,
          workOrderId: input.workOrderId ?? null,
        },
      });
      runId = run.id;

      // One Evidence row per assertion evaluation (deterministic order).
      for (const e of result.evaluations) {
        await this.deps.verificationService.attachEvidence({
          projectId,
          verificationRunId: run.id,
          evidenceType: 'architecture-assertion',
          provider: 'architecture-checkpoint',
          externalRef: e.assertionId,
          headSha: result.implementationRevision,
          result: detectorStatusToEvidenceResult(e.status),
          contentSummary: `${e.status}: ${e.summary}`,
          metadata: {
            assertionId: e.assertionId,
            assertionRowId: e.assertionRowId,
            severity: e.severity,
            detectorKind: e.detectorKind,
            detectorStatus: e.status,
            checkpointKind: result.checkpointKind,
            architectureVersionId: result.architectureVersionId,
            details: e.details,
          },
        });
      }

      // The summary Evidence row: the checkpoint result itself.
      await this.deps.verificationService.attachEvidence({
        projectId,
        verificationRunId: run.id,
        evidenceType: 'architecture-checkpoint',
        provider: 'architecture-checkpoint',
        externalRef: result.checkpointKind,
        headSha: result.implementationRevision,
        result: checkpointStatusToEvidenceResult(result.status),
        contentSummary: `${result.status}: ${result.blockingFindings.length} blocking, ${result.advisories.length} advisory`,
        metadata: {
          checkpointKind: result.checkpointKind,
          status: result.status,
          allowed: result.allowed,
          impact: result.impact,
          architectureVersionId: result.architectureVersionId,
          implementationRevision: result.implementationRevision,
          blockingFindings: result.blockingFindings,
          advisories: result.advisories,
          evaluationCount: result.evaluations.length,
        },
      });

      // Finalize the run through /verification — a checkpoint evaluation
      // that completes (even a 'blocked' verdict) is a COMPLETED evaluation
      // whose result lives in the summary. Never re-finalized, never
      // overwritten: the next checkpoint creates a NEW run.
      await this.deps.verificationService.finalizeOrchestrationRun({
        verificationRunId: run.id,
        status: 'completed',
        summary: {
          checkpointKind: result.checkpointKind,
          status: result.status,
          allowed: result.allowed,
          impact: result.impact,
          architectureVersionId: result.architectureVersionId,
          implementationRevision: result.implementationRevision,
          blockingFindings: result.blockingFindings,
          advisories: result.advisories,
          checkpointIdempotencyKey: input.idempotencyKey ?? null,
          evaluationSummaries: result.evaluations.map((e) => ({
            assertionId: e.assertionId,
            severity: e.severity,
            detectorKind: e.detectorKind,
            status: e.status,
            summary: e.summary,
          })),
        },
      });
      return run.id;
    } catch (err) {
      // Fail closed on evidence-persistence errors — but never leave a
      // pending checkpoint run behind (beginVerification's run-reuse query
      // must never adopt an orphaned checkpoint run).
      if (runId) {
        try {
          await this.deps.verificationService.finalizeOrchestrationRun({
            verificationRunId: runId,
            status: 'failed',
            summary: { checkpointKind: result.checkpointKind },
            errorMetadata: { error: (err as Error).message },
          });
        } catch {
          // best-effort cleanup only; the original error propagates
        }
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Idempotent replay
  // -------------------------------------------------------------------------

  private async findRecordedResult(
    workItemId: string,
    idempotencyKey: string,
  ): Promise<ArchitectureCheckpointResult | null> {
    const runs = await this.deps.verificationService.listRunsForWorkItem(workItemId);
    const recorded = runs.find(
      (r) =>
        r.source === CHECKPOINT_RUN_SOURCE &&
        r.status === 'completed' &&
        r.metadata?.checkpointIdempotencyKey === idempotencyKey,
    );
    if (!recorded) return null;
    const s = recorded.summary ?? {};
    return {
      checkpointKind: (s.checkpointKind as ArchitectureCheckpointKind) ?? 'pr_conformance',
      workItemId,
      architectureVersionId: recorded.architectureVersionId,
      implementationRevision: (recorded.metadata?.implementationRevision as string | null) ?? null,
      impact: (s.impact as ArchitectureImpactLevel) ?? 'high',
      applicable: true,
      status: (s.status as ArchitectureCheckpointResult['status']) ?? 'inconclusive',
      allowed: s.allowed === true,
      evaluations: [],
      blockingFindings: Array.isArray(s.blockingFindings) ? (s.blockingFindings as string[]) : [],
      advisories: Array.isArray(s.advisories) ? (s.advisories as string[]) : [],
      checkpointId: recorded.id,
      replayed: true,
      evaluatedAt: recorded.finishedAt
        ? new Date(recorded.finishedAt).toISOString()
        : new Date(recorded.createdAt).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Impact derivation: explicit metadata value or the fail-closed default 'high'. */
export function deriveImpact(workItem: { metadata?: Record<string, unknown> }): ArchitectureImpactLevel {
  const declared = workItem.metadata?.architectureImpact;
  if (declared === 'low' || declared === 'medium' || declared === 'high') {
    return declared;
  }
  return 'high';
}

function detectorStatusToEvidenceResult(
  status: AssertionEvaluation['status'],
): 'pass' | 'fail' | 'unknown' {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    default:
      // 'inconclusive' and 'not_applicable' have no determined result —
      // the exact detector status is preserved in metadata.detectorStatus.
      return 'unknown';
  }
}

function checkpointStatusToEvidenceResult(
  status: ArchitectureCheckpointResult['status'],
): 'pass' | 'fail' | 'unknown' {
  switch (status) {
    case 'passed':
    case 'passed_with_advisories':
      return 'pass';
    case 'blocked':
      return 'fail';
    default:
      return 'unknown';
  }
}
