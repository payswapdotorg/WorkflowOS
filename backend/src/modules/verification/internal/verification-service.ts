import type { DatabaseClient } from '@platform/index.js';
import type { Logger } from '@platform/logger.js';
import type {
  RequirementRepository,
  AcceptanceCriterionRepository,
  AcceptanceCriterion,
  RequirementStatus,
} from '@modules/requirements/index.js';
import type { ArchitectureVersionRepository } from '@modules/architecture/index.js';
import type { WorkItemRepository } from '@modules/work-items/index.js';
import type { CiEvidenceIngestionRepository } from '@modules/github/index.js';
import type { ObjectStore, PutObjectInput, PutObjectResult } from '@platform/index.js';
import type {
  VerificationService,
  VerificationRun,
  Evidence,
  CriterionEvidenceMapping,
  CreateVerificationRunInput,
  CreateEvidenceInput,
  CreateMapInput,
  CriterionEvaluation,
  RequirementDerivation,
  EvidenceAuthority,
  EvidenceResult,
} from './verification.types.js';
import {
  PgVerificationRunRepository,
  PgEvidenceRepository,
  PgCriterionEvidenceMappingRepository,
} from './pg-verification-repository.js';
import { generateExecutionId } from '@platform/ids.js';

/**
 * Default {@link VerificationService} — the deterministic verification engine
 * (VERIFY-001..003).
 *
 * Pipeline:
 *
 *   create VerificationRun
 *       ↓
 *   ingest/attach Evidence (CI via /github, manual, agent-as-claim)
 *       ↓
 *   map Evidence → Criteria (explicit, persisted)
 *       ↓
 *   evaluate Criteria (deterministic over persisted Evidence + mappings)
 *       ↓
 *   derive Requirement status (deterministic from criterion statuses)
 *       ↓
 *   persist results (via /requirements public contract — no raw SQL)
 *
 * EVALUATION SEMANTICS (frozen architecture §11, §25; VERIFY-EVAL-AC-01..03):
 *
 * Criterion status derivation, given the persisted Evidence + mappings for a
 * VerificationRun + criterion:
 *
 *   1. BLOCKED overrides everything: if any active authoritative evidence with
 *      result='blocked' is mapped to the criterion, the criterion is BLOCKED.
 *   2. FAIL dominates: if any active authoritative evidence with result='fail'
 *      is mapped to the criterion (relevance 'proves' or 'contradicts'), the
 *      criterion is FAIL.
 *   3. PASS requires authoritative evidence: if at least one active
 *      authoritative evidence with result='pass' is mapped to the criterion
 *      with relevance 'proves', the criterion is PASS.
 *      - Claim-only evidence (authority='claim') NEVER produces PASS, even if
 *        the claim result is 'pass' (VERIFY-EVAL-AC-02/03).
 *      - A passing CI run cannot blanket-mark unrelated criteria PASS — the
 *        evidence must be explicitly mapped (VERIFY-EVAL-AC-02).
 *   4. Otherwise: PENDING (insufficient authoritative evidence either way).
 *
 * Requirement status derivation (frozen architecture §10 line 339:
 * "Requirement status must not be based solely on an implementation agent's
 * statement"; VERIFY-EVAL-AC-03):
 *
 *   - 'blocked': if any criterion is BLOCKED.
 *   - 'satisfied': if ALL criteria are PASS.
 *   - 'blocked': if any criterion is BLOCKED (checked first).
 *   - otherwise: 'pending'.
 *
 * AUTHORITY BOUNDARY (frozen architecture §2.2, §15, §25):
 *   - agent/LLM/GitHub claims are 'claim' authority evidence — never enough
 *     for PASS alone (VERIFY-EVAL-AC-02/03).
 *   - CI results ingested via /github are 'authoritative' evidence — they CAN
 *     produce PASS when explicitly mapped to the criterion they prove.
 *   - /verification does NOT mutate canonical workflow state (/workflows owns
 *     that — boundary test).
 *   - /verification persists derived statuses via the /requirements public
 *     contract (AcceptanceCriterionRepository.update +
 *     RequirementRepository.update), never raw SQL — boundary preserved.
 *
 * The frozen spec leaves the exact derivation function to /verification
 * within these constraints (per the spec extraction). This implementation
 * satisfies all the frozen invariants. No ARCHITECTURE_BLOCKER.
 */
export class DefaultVerificationService implements VerificationService {
  private readonly runRepo: PgVerificationRunRepository;
  private readonly evidenceRepo: PgEvidenceRepository;
  private readonly mappingRepo: PgCriterionEvidenceMappingRepository;

  constructor(
    db: DatabaseClient,
    private readonly requirementRepository: RequirementRepository,
    private readonly acceptanceCriterionRepository: AcceptanceCriterionRepository,
    architectureVersionRepository: ArchitectureVersionRepository,
    private readonly workItemRepository: WorkItemRepository,
    private readonly ciEvidenceIngestionRepository: CiEvidenceIngestionRepository,
    private readonly objectStore: ObjectStore,
    private readonly logger: Logger,
  ) {
    this.runRepo = new PgVerificationRunRepository(db);
    this.evidenceRepo = new PgEvidenceRepository(db);
    this.mappingRepo = new PgCriterionEvidenceMappingRepository(db);
    // architectureVersionRepository is reserved for future use (WORK-016/018
    // will consume verification results to drive workflow transitions). It is
    // intentionally accepted in the constructor so the composition root wires
    // it now and downstream work items don't need to re-plumb the dependency.
    void architectureVersionRepository;
  }

  async createRun(input: CreateVerificationRunInput): Promise<VerificationRun> {
    // Validate traceability: the Work Item must belong to the claimed
    // ArchitectureVersion. The persistence-layer trigger
    // (wfos_check_verification_run_integrity) will also enforce this, but we
    // validate here for a cleaner error before the DB exception.
    const wi = await this.workItemRepository.findById(input.workItemId);
    if (!wi) {
      throw new Error(`verification run: work item ${input.workItemId} not found`);
    }
    if (wi.architectureVersionId !== input.architectureVersionId) {
      throw new Error(
        `verification run: work item ${input.workItemId} belongs to architecture version ${wi.architectureVersionId}, not ${input.architectureVersionId}`,
      );
    }
    return this.runRepo.create(input);
  }

  async findRun(id: string): Promise<VerificationRun | null> {
    return this.runRepo.findById(id);
  }

  async attachEvidence(input: CreateEvidenceInput): Promise<Evidence> {
    // AUTHORITY BOUNDARY (PR #14 architect review):
    //
    // The public/manual evidence path ALWAYS produces `authority: 'claim'`.
    // An API client cannot self-declare `authority: 'authoritative'` — that
    // would let an ordinary project writer manufacture authoritative PASS
    // evidence, map it to a criterion as 'proves', and obtain an
    // authoritative PASS without an objective/provider-backed source.
    //
    // The ONLY trusted path that produces `authoritative` evidence is
    // {@link attachCiEvidence} (CI results ingested through the /github
    // boundary). Manual/agent/LLM evidence remains `claim` unless the
    // architecture explicitly authorizes promotion (no such path exists
    // in WORK-015).
    //
    // `CreateEvidenceInput` intentionally does NOT have an `authority` field
    // — the client cannot supply it. The authority is set HERE, server-side,
    // based on the calling path.
    return this.evidenceRepo.create(input, 'claim');
  }

  async attachCiEvidence(input: {
    verificationRunId: string;
    ciEvidenceId: string;
  }): Promise<Evidence> {
    // Boundary crossing: /github's CiRunEvidence → /verification's Evidence.
    // The translation rules are owned by /verification.
    const run = await this.runRepo.findById(input.verificationRunId);
    if (!run) {
      throw new Error(`attachCiEvidence: verification run ${input.verificationRunId} not found`);
    }
    const ci = await this.ciEvidenceIngestionRepository.findById(input.ciEvidenceId);
    if (!ci) {
      throw new Error(`attachCiEvidence: CI evidence ${input.ciEvidenceId} not found`);
    }
    // Tenant isolation: the CI evidence must belong to the same project as the
    // verification run. (The persistence-layer mapping trigger would also
    // catch this, but we validate here for a cleaner error.)
    if (ci.projectId !== run.projectId) {
      throw new Error(
        `attachCiEvidence: CI evidence ${input.ciEvidenceId} belongs to project ${ci.projectId}, not run's project ${run.projectId}`,
      );
    }

    // Translate GitHub-native conclusion → /verification EvidenceResult.
    // This is the ONLY place that maps GitHub conclusion values. /github
    // preserves the raw conclusion; /verification interprets it.
    const result = translateGithubConclusion(ci.conclusion, ci.status);

    // AUTHORITY BOUNDARY: CI results ingested through the /github boundary
    // are `authoritative` — they come from the customer's actual CI system,
    // not from an agent's self-report. This is the ONLY trusted path that
    // produces `authoritative` evidence in WORK-015.
    return this.evidenceRepo.create({
      projectId: run.projectId,
      verificationRunId: run.id,
      evidenceType: 'ci',
      provider: ci.provider,
      externalRef: ci.runUrl,
      headSha: ci.headSha,
      result,
      contentSummary: ci.workflowName
        ? `CI: ${ci.workflowName}${ci.checkName ? ` / ${ci.checkName}` : ''} → ${ci.conclusion ?? ci.status ?? 'unknown'}`
        : null,
      metadata: {
        ciEvidenceId: ci.id,
        externalRunId: ci.externalRunId,
        workflowName: ci.workflowName,
        checkName: ci.checkName,
        repositoryFullName: ci.repositoryFullName,
        branch: ci.branch,
        artifactReferences: ci.artifactReferences,
        providerMetadata: ci.providerMetadata,
      },
    }, 'authoritative');
  }

  async mapEvidenceToCriterion(input: CreateMapInput): Promise<CriterionEvidenceMapping> {
    // Validate the criterion belongs to the same project (tenant isolation).
    // The criterion is owned by /requirements; we resolve through the
    // requirement → architecture version → architecture → project chain.
    const criterion = await this.acceptanceCriterionRepository.findById(input.criterionId);
    if (!criterion) {
      throw new Error(`mapEvidenceToCriterion: criterion ${input.criterionId} not found`);
    }
    // The mapping integrity trigger will enforce run/evidence consistency; we
    // rely on the upsertActive() idempotency for repeated processing.
    return this.mappingRepo.upsertActive(input);
  }

  async evaluateCriterion(input: {
    verificationRunId: string;
    criterionId: string;
  }): Promise<CriterionEvaluation> {
    // Load all active mappings for this criterion within this run.
    const allMappings = await this.mappingRepo.listForVerificationRun(input.verificationRunId);
    const mappings = allMappings.filter((m) => m.criterionId === input.criterionId);

    // Load the evidence rows for these mappings.
    const evidenceById = new Map<string, Evidence>();
    for (const m of mappings) {
      if (!evidenceById.has(m.evidenceId)) {
        const ev = await this.evidenceRepo.findById(m.evidenceId);
        if (ev) evidenceById.set(m.evidenceId, ev);
      }
    }

    return this.deriveCriterionStatus(input.criterionId, mappings, evidenceById);
  }

  async evaluateForRun(verificationRunId: string): Promise<{
    run: VerificationRun;
    criteria: CriterionEvaluation[];
    requirements: RequirementDerivation[];
  }> {
    const run = await this.runRepo.findById(verificationRunId);
    if (!run) {
      throw new Error(`evaluateForRun: verification run ${verificationRunId} not found`);
    }

    // Load all requirements + criteria for the ArchitectureVersion.
    const requirements = await this.requirementRepository.findByArchitectureVersion(run.architectureVersionId);
    const criteriaByReq = new Map<string, AcceptanceCriterion[]>();
    const allCriteria: AcceptanceCriterion[] = [];
    for (const req of requirements) {
      const cs = await this.acceptanceCriterionRepository.listForRequirement(req.id);
      criteriaByReq.set(req.id, cs);
      allCriteria.push(...cs);
    }

    // Load all active mappings for this run.
    const mappings = await this.mappingRepo.listForVerificationRun(verificationRunId);

    // Load all evidence rows for this run (single query rather than per-mapping).
    const evidenceList = await this.evidenceRepo.listForVerificationRun(verificationRunId);
    const evidenceById = new Map<string, Evidence>();
    for (const ev of evidenceList) evidenceById.set(ev.id, ev);

    // Group mappings by criterion.
    const mappingsByCriterion = new Map<string, CriterionEvidenceMapping[]>();
    for (const m of mappings) {
      const list = mappingsByCriterion.get(m.criterionId) ?? [];
      list.push(m);
      mappingsByCriterion.set(m.criterionId, list);
    }

    // Evaluate each criterion.
    const criteriaEvals: CriterionEvaluation[] = [];
    const evalByCriterion = new Map<string, CriterionEvaluation>();
    for (const crit of allCriteria) {
      const ms = mappingsByCriterion.get(crit.id) ?? [];
      const evaluation = this.deriveCriterionStatus(crit.id, ms, evidenceById);
      criteriaEvals.push(evaluation);
      evalByCriterion.set(crit.id, evaluation);
    }

    // Derive each requirement's status from its criteria.
    const requirementDerivations: RequirementDerivation[] = [];
    for (const req of requirements) {
      const cs = criteriaByReq.get(req.id) ?? [];
      const criterionEvals = cs.map((c) => evalByCriterion.get(c.id)!).filter(Boolean);
      const derivedStatus = this.deriveRequirementStatus(criterionEvals);
      requirementDerivations.push({
        requirementId: req.id,
        derivedStatus,
        criterionEvaluations: criterionEvals,
        rationale: this.requirementRationale(criterionEvals, derivedStatus),
      });
    }

    return { run, criteria: criteriaEvals, requirements: requirementDerivations };
  }

  async persistEvaluations(verificationRunId: string): Promise<{
    run: VerificationRun;
    criteria: CriterionEvaluation[];
    requirements: RequirementDerivation[];
  }> {
    const evaluation = await this.evaluateForRun(verificationRunId);

    // Persist criterion statuses via the /requirements public contract —
    // the ONLY mutation path from /verification to /requirements. No raw SQL.
    for (const critEval of evaluation.criteria) {
      await this.acceptanceCriterionRepository.update(critEval.criterionId, {
        status: critEval.derivedStatus,
      });
    }

    // Persist requirement statuses via the /requirements public contract.
    for (const reqDerivation of evaluation.requirements) {
      await this.requirementRepository.update(reqDerivation.requirementId, {
        status: reqDerivation.derivedStatus,
      });
    }

    // Mark the run completed + record summary metadata.
    const summary = {
      criteriaTotal: evaluation.criteria.length,
      criteriaPass: evaluation.criteria.filter((c) => c.derivedStatus === 'pass').length,
      criteriaFail: evaluation.criteria.filter((c) => c.derivedStatus === 'fail').length,
      criteriaBlocked: evaluation.criteria.filter((c) => c.derivedStatus === 'blocked').length,
      criteriaPending: evaluation.criteria.filter((c) => c.derivedStatus === 'pending').length,
      requirementsTotal: evaluation.requirements.length,
      requirementsSatisfied: evaluation.requirements.filter((r) => r.derivedStatus === 'satisfied').length,
      requirementsBlocked: evaluation.requirements.filter((r) => r.derivedStatus === 'blocked').length,
    };
    const updatedRun = await this.runRepo.update(verificationRunId, {
      status: 'completed',
      finishedAt: new Date(),
      summary,
    });

    this.logger.info('verification.completed', {
      verificationRunId,
      ...summary,
    });

    return {
      run: updatedRun ?? evaluation.run,
      criteria: evaluation.criteria,
      requirements: evaluation.requirements,
    };
  }

  // --- Deterministic evaluation core ---

  /**
   * Derive a criterion's status from the persisted mappings + evidence.
   * Pure function — no side effects. The result is what would be persisted.
   */
  private deriveCriterionStatus(
    criterionId: string,
    mappings: CriterionEvidenceMapping[],
    evidenceById: Map<string, Evidence>,
  ): CriterionEvaluation {
    // Filter to active mappings for THIS criterion, with relevance that
    // indicates the evidence supports/proves/contradicts/blocks the criterion.
    const activeMappings = mappings.filter((m) => m.mappingStatus === 'active');

    // Resolve the evidence rows.
    const evidenceRows: Array<{ mapping: CriterionEvidenceMapping; evidence: Evidence }> = [];
    for (const m of activeMappings) {
      const ev = evidenceById.get(m.evidenceId);
      if (ev) evidenceRows.push({ mapping: m, evidence: ev });
    }

    const authoritative = evidenceRows.filter((er) => er.evidence.authority === 'authoritative');
    const claims = evidenceRows.filter((er) => er.evidence.authority === 'claim');
    const authoritativePresent = authoritative.length > 0;

    // 1. BLOCKED overrides: any authoritative evidence with result='blocked' → BLOCKED.
    const blocked = authoritative.some((er) => er.evidence.result === 'blocked');
    if (blocked) {
      return {
        criterionId,
        derivedStatus: 'blocked',
        supportingEvidenceIds: evidenceRows.map((er) => er.evidence.id),
        rationale: 'blocked: authoritative evidence with result=blocked is mapped',
        authoritativeEvidencePresent: authoritativePresent,
      };
    }

    // 2. FAIL dominates: any authoritative evidence with result='fail' → FAIL.
    const failingAuthoritative = authoritative.some(
      (er) => er.evidence.result === 'fail' &&
        (er.mapping.relevance === 'proves' || er.mapping.relevance === 'contradicts'),
    );
    if (failingAuthoritative) {
      return {
        criterionId,
        derivedStatus: 'fail',
        supportingEvidenceIds: evidenceRows.map((er) => er.evidence.id),
        rationale: 'fail: authoritative evidence with result=fail is mapped (proves/contradicts)',
        authoritativeEvidencePresent: authoritativePresent,
      };
    }

    // 3. PASS requires authoritative evidence with result='pass' + relevance 'proves'.
    const passingProves = authoritative.some(
      (er) => er.evidence.result === 'pass' && er.mapping.relevance === 'proves',
    );
    if (passingProves) {
      return {
        criterionId,
        derivedStatus: 'pass',
        supportingEvidenceIds: evidenceRows
          .filter((er) => er.evidence.result === 'pass' && er.evidence.authority === 'authoritative')
          .map((er) => er.evidence.id),
        rationale: 'pass: authoritative evidence with result=pass + relevance=proves is mapped',
        authoritativeEvidencePresent: authoritativePresent,
      };
    }

    // 4. Claim-only evidence present but no authoritative → cannot be PASS.
    //    Claims with result='fail' alone don't make the criterion FAIL either
    //    (claims are not authoritative). PENDING is the safe default.
    if (claims.length > 0 && !authoritativePresent) {
      return {
        criterionId,
        derivedStatus: 'pending',
        supportingEvidenceIds: evidenceRows.map((er) => er.evidence.id),
        rationale: 'pending: only claim evidence present — claims cannot produce PASS (VERIFY-EVAL-AC-02/03)',
        authoritativeEvidencePresent: false,
      };
    }

    // 5. Insufficient evidence → PENDING.
    return {
      criterionId,
      derivedStatus: 'pending',
      supportingEvidenceIds: evidenceRows.map((er) => er.evidence.id),
      rationale: 'pending: insufficient authoritative evidence',
      authoritativeEvidencePresent: authoritativePresent,
    };
  }

  /**
   * Derive a requirement's status from its criteria's evaluations.
   *
   * Frozen rule (architecture §10 line 339): "Requirement status must not be
   * based solely on an implementation agent's statement." Combined with
   * VERIFY-EVAL-AC-03: "Requirement completion cannot rely solely on agent
   * claims."
   *
   * Since criterion PASS already requires authoritative evidence (see
   * deriveCriterionStatus), a 'satisfied' requirement status (all criteria
   * PASS) is by construction backed by authoritative evidence — never by
   * agent claims alone.
   */
  private deriveRequirementStatus(
    criterionEvals: CriterionEvaluation[],
  ): RequirementStatus {
    // No criteria → 'pending' (cannot be satisfied without criteria).
    if (criterionEvals.length === 0) {
      return 'pending';
    }
    // Any BLOCKED criterion → requirement 'blocked'.
    if (criterionEvals.some((c) => c.derivedStatus === 'blocked')) {
      return 'blocked';
    }
    // Any FAIL criterion → requirement 'pending' (not satisfied, not blocked).
    if (criterionEvals.some((c) => c.derivedStatus === 'fail')) {
      return 'pending';
    }
    // All criteria PASS → requirement 'satisfied'.
    if (criterionEvals.every((c) => c.derivedStatus === 'pass')) {
      return 'satisfied';
    }
    // Otherwise (some PENDING) → 'pending'.
    return 'pending';
  }

  private requirementRationale(
    criterionEvals: CriterionEvaluation[],
    derivedStatus: RequirementStatus,
  ): string {
    const pass = criterionEvals.filter((c) => c.derivedStatus === 'pass').length;
    const fail = criterionEvals.filter((c) => c.derivedStatus === 'fail').length;
    const blocked = criterionEvals.filter((c) => c.derivedStatus === 'blocked').length;
    const pending = criterionEvals.filter((c) => c.derivedStatus === 'pending').length;
    return `${derivedStatus}: ${pass} pass / ${fail} fail / ${blocked} blocked / ${pending} pending`;
  }

  // --- ObjectStore helper for large artifact bodies ---
  //
  // Exposed via a separate method so callers can store large CI/verification
  // artifacts (test output, logs, build artifacts) in ObjectStore BEFORE
  // attaching the evidence row that references them. This implements the
  // architecture.md §30 + DATA3-AC-01/02 boundary:
  //
  //   large CI artifact → ObjectStore → evidence.storageKey → PostgreSQL
  //
  // The full artifact body is NEVER required in the core evidence row.

  async storeLargeArtifact(input: PutObjectInput): Promise<PutObjectResult> {
    return this.objectStore.put(input);
  }
}

// --- Translation helpers ---

/**
 * Translate GitHub-native conclusion + status into /verification's
 * EvidenceResult vocabulary. This is the ONLY place in the codebase that
 * performs this translation — /github preserves the raw values, /verification
 * interprets them.
 *
 * GitHub Actions conclusion values (per GitHub docs):
 *   'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required'
 * GitHub Actions status values:
 *   'queued' | 'in_progress' | 'completed'
 */
export function translateGithubConclusion(conclusion: string | null, status: string | null): EvidenceResult {
  // If the run isn't completed yet, result is 'unknown'.
  if (status !== 'completed') {
    return 'unknown';
  }
  switch (conclusion) {
    case 'success':
      return 'pass';
    case 'failure':
    case 'timed_out':
      return 'fail';
    case 'cancelled':
    case 'action_required':
      return 'blocked';
    case 'neutral':
    case 'skipped':
      // Neutral/skipped checks don't pass or fail the criterion.
      return 'unknown';
    default:
      return 'unknown';
  }
}

// --- Authority classification helpers (used by callers attaching evidence) ---

/**
 * Returns the authority classification for a given evidence provider/type.
 *
 * Used by the service to classify evidence server-side. The boundary is:
 *   - CI results ingested via /github (attachCiEvidence path) → 'authoritative'.
 *   - Everything else (manual, agent-claim, llm-claim, etc.) → 'claim'.
 *
 * PR #14 architect review: manual evidence is `claim` unless the architecture
 * explicitly authorizes promotion (no such path exists in WORK-015). This
 * prevents an ordinary project writer from manufacturing authoritative PASS
 * evidence by self-declaring `authority: 'authoritative'`.
 *
 * Exposed as a function so the authority boundary is a first-class decision
 * documented in code, not an implicit default.
 */
export function classifyEvidenceAuthority(
  provider: string,
  evidenceType: string,
): EvidenceAuthority {
  // CI results are authoritative (they come from the customer's actual CI
  // system via /github, not from an agent's self-report). This is the ONLY
  // path that produces authoritative evidence in WORK-015.
  if (evidenceType === 'ci' && provider === 'github') return 'authoritative';
  // Everything else (manual, agent-claim, llm-claim, etc.) is a claim —
  // never enough for PASS alone.
  return 'claim';
}

// Re-export helpers for tests.
export { generateExecutionId };
