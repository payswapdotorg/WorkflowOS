/**
 * Verification domain types (VERIFY-001..003).
 *
 * The /verification module owns VerificationRun, Evidence, evidence→criterion
 * mapping, and deterministic criterion/requirement evaluation. It does NOT:
 * - own CI provider integration (that's /github — GITHUB-006);
 * - own AcceptanceCriterion persistence (that's /requirements — REQ-002);
 * - own canonical workflow state (that's /workflows);
 * - own Architect Reviews (that's /reviews).
 *
 * Boundary ownership (frozen architecture §24, §25; architecture-lock.md §51):
 *   /github     supplies CI evidence (translation + ingestion only).
 *   /verification interprets evidence → derives criterion/requirement status.
 *
 * Authority hierarchy (frozen architecture §2.2, §15, §25):
 *   authoritative evidence (CI results ingested via /github, manual
 *   verification by an authorized reviewer) → MAY produce criterion PASS.
 *   claim evidence (agent-reported tests, LLM/Architect output, GitHub
 *   labels/comments) → NEVER sufficient alone for criterion PASS.
 *
 * Traceability chain (frozen architecture §25):
 *   VerificationRun → Work Item → ArchitectureVersion → Architecture → Project
 */

import type {
  CriterionStatus,
  RequirementStatus,
} from '@modules/requirements/index.js';

// Re-export the criterion/requirement status enums from /requirements so
// /verification code uses the SAME types (no duplicate authority — the enums
// are owned by /requirements per REQ-001/002 + AC-AC-03).
export type { CriterionStatus, RequirementStatus };

// --- VerificationRun lifecycle states ---

export type VerificationRunStatus = 'pending' | 'running' | 'completed' | 'failed';

// --- Evidence ---

/**
 * Authority classification for an Evidence record.
 *
 * - 'authoritative': CI results ingested via /github, manual verification by
 *   an authorized reviewer. MAY produce criterion PASS (when mapped to the
 *   criterion it proves + the evidence result is 'pass').
 * - 'claim': agent-reported test results, LLM/Architect output, GitHub
 *   labels/comments. NEVER sufficient alone for criterion PASS — they may
 *   contribute context but cannot be the sole basis for a PASS verdict
 *   (VERIFY-EVAL-AC-02/03, architecture §15 line 481).
 */
export type EvidenceAuthority = 'authoritative' | 'claim';

/**
 * Provider-independent evidence result (vocabulary owned by /verification).
 *
 * This is the TRANSLATION of a CI run's conclusion / a test's pass-fail / an
 * agent's claim into /verification's canonical vocabulary. The translation
 * layer lives in /github (for CI) or in the caller (for manual/agent
 * evidence) — /verification never interprets raw GitHub-native values.
 *
 * Values:
 * - 'pass': the evidence indicates the check passed.
 * - 'fail': the evidence indicates the check failed.
 * - 'blocked': the evidence indicates a blocked condition (e.g. a required
 *   check could not run).
 * - 'unknown': the evidence has no determinable result (e.g. an in-progress
 *   CI run, or an agent claim with no interpretable content).
 */
export type EvidenceResult = 'pass' | 'fail' | 'blocked' | 'unknown';

export interface Evidence {
  readonly id: string;
  readonly projectId: string;
  readonly verificationRunId: string;
  /** Evidence type/source classification. */
  readonly evidenceType: string;
  /** Authority classification — see {@link EvidenceAuthority}. */
  readonly authority: EvidenceAuthority;
  /** Provider that produced the evidence ('github', 'agent', 'llm', 'manual'). */
  readonly provider: string;
  /** Provider-native external reference (e.g. GitHub check run URL). */
  readonly externalRef: string | null;
  /** Commit / SHA the evidence applies to (when applicable). */
  readonly headSha: string | null;
  /** Provider-independent result — see {@link EvidenceResult}. */
  readonly result: EvidenceResult;
  /** Content/summary (small, inline). For large bodies use storageKey. */
  readonly contentSummary: string | null;
  /**
   * ObjectStore storage key for the full artifact body. NULL when the evidence
   * has no large body (e.g. a simple CI pass/fail row).
   */
  readonly storageKey: string | null;
  readonly storageProvider: string | null;
  readonly artifactDigest: string | null;
  readonly artifactSizeBytes: number | null;
  readonly artifactContentType: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateEvidenceInput {
  projectId: string;
  verificationRunId: string;
  evidenceType: string;
  /**
   * Provider that produced the evidence ('github', 'agent', 'llm', 'manual').
   *
   * NOTE: `authority` is intentionally NOT in this input type. Authority is
   * determined SERVER-SIDE by the VerificationService based on the trusted
   * source path — never accepted from the client. This prevents the
   * verification-authority bypass (PR #14 architect review): an ordinary
   * project writer cannot manufacture authoritative PASS evidence by
   * self-declaring `authority: 'authoritative'`.
   *
   * The ONLY trusted path that produces `authoritative` evidence is
   * {@link VerificationService.attachCiEvidence} (CI results ingested through
   * the /github boundary). The public/manual {@link VerificationService.attachEvidence}
   * path always produces `claim` evidence.
   */
  provider: string;
  externalRef?: string | null;
  headSha?: string | null;
  result?: EvidenceResult;
  contentSummary?: string | null;
  /** ObjectStore reference for the full artifact body. */
  storageKey?: string | null;
  storageProvider?: string | null;
  artifactDigest?: string | null;
  artifactSizeBytes?: number | null;
  artifactContentType?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EvidenceRepository {
  /**
   * Create an Evidence row. The `authority` parameter is SERVER-SIDE only —
   * it is NOT part of {@link CreateEvidenceInput} and cannot be supplied by
   * API clients. The {@link VerificationService} sets it based on the trusted
   * source path:
   *   - `attachEvidence` (public/manual path) → `authority: 'claim'`
   *   - `attachCiEvidence` (trusted /github CI path) → `authority: 'authoritative'`
   */
  create(input: CreateEvidenceInput, authority: EvidenceAuthority): Promise<Evidence>;
  findById(id: string): Promise<Evidence | null>;
  listForVerificationRun(verificationRunId: string): Promise<Evidence[]>;
}

// --- VerificationRun ---

export interface VerificationRun {
  readonly id: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly workOrderId: string | null;
  readonly architectureVersionId: string;
  /** Source/reference context ('github-actions', 'manual', 'agent'). */
  readonly source: string;
  /** Provider-independent reference (commit SHA, PR ref, etc.). */
  readonly sourceRef: string | null;
  /**
   * WORK-051 round 1 (BLOCKER 4): the durable orchestration identity owned
   * by /verification. When an orchestration-produced run is created with a
   * logical idempotency key, the key is stored here and made UNIQUE by a
   * partial index (migration 0053) — one orchestration run per key,
   * persistence-enforced. Runs created through the ordinary verification
   * pipeline carry null.
   */
  readonly orchestrationKey: string | null;
  /** Lifecycle status — see {@link VerificationRunStatus}. */
  readonly status: VerificationRunStatus;
  /** Execution/correlation ID (architecture §35). */
  readonly executionId: string;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly summary: Record<string, unknown>;
  readonly errorMetadata: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateVerificationRunInput {
  projectId: string;
  workItemId: string;
  workOrderId?: string | null;
  architectureVersionId: string;
  source: string;
  sourceRef?: string | null;
  executionId: string;
  metadata?: Record<string, unknown>;
  /**
   * WORK-051 round 1 (BLOCKER 4): the durable orchestration idempotency
   * identity. Unique across runs (partial unique index). Ordinary
   * verification runs omit it.
   */
  orchestrationKey?: string | null;
}

export interface UpdateVerificationRunInput {
  status?: VerificationRunStatus;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  summary?: Record<string, unknown>;
  errorMetadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface VerificationRunRepository {
  create(input: CreateVerificationRunInput): Promise<VerificationRun>;
  findById(id: string): Promise<VerificationRun | null>;
  listForWorkItem(workItemId: string): Promise<VerificationRun[]>;
  update(id: string, input: UpdateVerificationRunInput): Promise<VerificationRun | null>;
  /**
   * WORK-051 round 1 (BLOCKER 4): find the orchestration run by its durable
   * idempotency identity. Pure read.
   */
  findByOrchestrationKey(orchestrationKey: string): Promise<VerificationRun | null>;
  /**
   * WORK-051 round 1 (BLOCKER 4): the create-or-converge insert.
   * `INSERT ... ON CONFLICT (orchestration_key) DO NOTHING` — concurrent
   * callers with the same key are arbitrated by the unique partial index:
   * exactly one caller's insert lands; every other caller receives the
   * winner's row (created=false). Throws on unique violations against OTHER
   * constraints (never silently swallows errors).
   */
  insertOrGetOrchestrationRun(
    input: CreateVerificationRunInput,
  ): Promise<{ run: VerificationRun; created: boolean }>;
  /**
   * WORK-051 round 1: finalize with a CAS predicate — the terminal
   * transition happens in a single UPDATE guarded by the current status.
   * Returns null when the run is missing; `already-terminal` callers
   * re-read and observe the existing terminal row.
   */
  finalize(
    id: string,
    input: {
      status: 'completed' | 'failed';
      summary: Record<string, unknown>;
      errorMetadata?: Record<string, unknown> | null;
    },
  ): Promise<VerificationRun | null>;
}

// --- CriterionEvidenceMapping ---

export type MappingRelevance = 'proves' | 'supports' | 'contradicts' | 'blocks';
export type MappingStatus = 'active' | 'superseded';

export interface CriterionEvidenceMapping {
  readonly id: string;
  readonly projectId: string;
  readonly verificationRunId: string;
  readonly evidenceId: string;
  readonly criterionId: string;
  readonly relevance: MappingRelevance;
  readonly mappingStatus: MappingStatus;
  readonly source: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateMapInput {
  projectId: string;
  verificationRunId: string;
  evidenceId: string;
  criterionId: string;
  relevance?: MappingRelevance;
  source?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CriterionEvidenceMappingRepository {
  create(input: CreateMapInput): Promise<CriterionEvidenceMapping>;
  /** Idempotent: if an active mapping for (evidenceId, criterionId) exists, return it. */
  upsertActive(input: CreateMapInput): Promise<CriterionEvidenceMapping>;
  listForVerificationRun(verificationRunId: string): Promise<CriterionEvidenceMapping[]>;
  listForEvidence(evidenceId: string): Promise<CriterionEvidenceMapping[]>;
  listForCriterion(criterionId: string): Promise<CriterionEvidenceMapping[]>;
  /** Mark a mapping as superseded (historical preserved, not deleted). */
  supersede(id: string): Promise<CriterionEvidenceMapping | null>;
}

// --- Verification evaluation result ---

/**
 * The result of evaluating a single acceptance criterion against the persisted
 * Evidence + CriterionEvidenceMappings for one VerificationRun.
 *
 * Owned by /verification (VERIFY-003, VERIFY-EVAL-AC-01). The criterion status
 * enum is owned by /requirements (REQ-002); /verification derives the value
 * and writes it back via the {@link AcceptanceCriterionRepository.update}
 * contract.
 */
export interface CriterionEvaluation {
  readonly criterionId: string;
  readonly derivedStatus: CriterionStatus;
  /** Evidence IDs that supported the derivation (traceability). */
  readonly supportingEvidenceIds: string[];
  /** Human-readable rationale for the derived status. */
  readonly rationale: string;
  /**
   * True when the derivation relied on authoritative evidence; false when
   * only claim evidence was available (in which case PASS is impossible).
   */
  readonly authoritativeEvidencePresent: boolean;
}

/**
 * The result of deriving a Requirement's status from its criteria.
 *
 * Owned by /verification (VERIFY-003, VERIFY-EVAL-AC-03). The requirement
 * status enum is owned by /requirements (REQ-001); /verification derives the
 * value and writes it back via the {@link RequirementRepository.update}
 * contract.
 */
export interface RequirementDerivation {
  readonly requirementId: string;
  readonly derivedStatus: RequirementStatus;
  readonly criterionEvaluations: CriterionEvaluation[];
  readonly rationale: string;
}

// --- VerificationService (the deterministic evaluation engine) ---

/**
 * The VerificationService owns the verification pipeline:
 *
 *   create VerificationRun
 *       ↓
 *   ingest/attach Evidence
 *       ↓
 *   map Evidence → Criteria
 *       ↓
 *   evaluate Criteria
 *       ↓
 *   derive Requirement status
 *       ↓
 *   persist results
 *
 * Evaluation is DETERMINISTIC over persisted Evidence + mappings. It does NOT
 * depend on agent/LLM claims as authority (VERIFY-EVAL-AC-02/03). It does NOT
 * mutate canonical workflow state (boundary — /workflows owns that).
 */
export interface VerificationService {
  /** Create a new VerificationRun for a Work Item's implementation attempt. */
  createRun(input: CreateVerificationRunInput): Promise<VerificationRun>;

  /** Find a VerificationRun by id. Returns null when not found. */
  findRun(id: string): Promise<VerificationRun | null>;

  /** Attach an Evidence record to an existing VerificationRun. */
  attachEvidence(input: CreateEvidenceInput): Promise<Evidence>;

  /**
   * Translate a CI evidence row (ingested by /github) into a /verification
   * Evidence record attached to the given VerificationRun.
   *
   * This is the boundary crossing point: /github's CiRunEvidence → /verification's
   * Evidence. The translation rules are owned by /verification.
   */
  attachCiEvidence(input: {
    verificationRunId: string;
    ciEvidenceId: string;
  }): Promise<Evidence>;

  /** Map an Evidence record to a specific acceptance criterion. */
  mapEvidenceToCriterion(input: CreateMapInput): Promise<CriterionEvidenceMapping>;

  /**
   * Evaluate a single acceptance criterion against the persisted Evidence +
   * mappings for the given VerificationRun. Returns the derived criterion
   * status WITHOUT mutating /requirements persistence (read-only evaluation).
   */
  evaluateCriterion(input: {
    verificationRunId: string;
    criterionId: string;
  }): Promise<CriterionEvaluation>;

  /**
   * Evaluate ALL criteria for the requirements under the VerificationRun's
   * ArchitectureVersion. Returns per-criterion + per-requirement derivations.
   * Does NOT mutate /requirements persistence (read-only evaluation).
   */
  evaluateForRun(verificationRunId: string): Promise<{
    run: VerificationRun;
    criteria: CriterionEvaluation[];
    requirements: RequirementDerivation[];
  }>;

  /**
   * Persist the derived criterion/requirement statuses back to /requirements
   * (via the existing AcceptanceCriterionRepository.update +
   * RequirementRepository.update contracts). This is the ONLY mutation path
   * from /verification to /requirements — the boundary is preserved because
   * /verification calls the /requirements public contract, never raw SQL.
   *
   * Returns the persisted evaluation. Does NOT mutate /workflows.
   */
  persistEvaluations(verificationRunId: string): Promise<{
    run: VerificationRun;
    criteria: CriterionEvaluation[];
    requirements: RequirementDerivation[];
  }>;

  /**
   * List every VerificationRun for a Work Item (newest first).
   *
   * WORK-022 (UI2-AC-01): this is the AUTHORITATIVE read path that the web
   * application consumes to render VerificationRun state. It exists so the
   * frontend never has to substitute workflow-convergence metadata for
   * actual verification data (PR #21 issue 3). Pure read — no mutation.
   */
  listRunsForWorkItem(workItemId: string): Promise<VerificationRun[]>;

  /**
   * List every Evidence record attached to a VerificationRun.
   *
   * WORK-022 (UI2-AC-01): authoritative read path for evidence rendering.
   * Pure read — no mutation, no evaluation.
   */
  listEvidenceForRun(verificationRunId: string): Promise<Evidence[]>;

  /**
   * List every Evidence→Criterion mapping for a VerificationRun.
   *
   * WORK-022 (UI2-AC-01): authoritative read path for mapping rendering.
   * Pure read — no mutation, no evaluation.
   */
  listMappingsForRun(verificationRunId: string): Promise<CriterionEvidenceMapping[]>;

  /**
   * WORK-051 — finalize a VerificationRun produced by an application-layer
   * orchestration capability (e.g. the architecture checkpoint subsystem).
   *
   * /verification remains the SOLE evidence authority: this is the ONLY way
   * an orchestration-produced run reaches a terminal state. It records the
   * terminal status + summary through /verification's own repository — the
   * caller never writes verification tables directly.
   *
   * Constraints (fail closed):
   * - the run must exist;
   * - the run must be in a non-terminal state ('pending' | 'running');
   * - the target status must be terminal ('completed' | 'failed').
   *
   * PR #52 round 1 (BLOCKER 4): the terminal transition is a CAS UPDATE
   * (single statement guarded by the current status) — concurrent
   * finalizations are arbitrated by the database: exactly one writer's
   * UPDATE lands; the loser observes the winner's terminal row.
   *
   * This does NOT evaluate criteria, map evidence, derive requirement
   * statuses, or mutate workflow state. Checkpoint evidence attached through
   * {@link attachEvidence} remains `claim`-authority by the frozen evidence
   * hierarchy (§2.2, §15) — machine-produced conformance evidence is traceable
   * context, never authoritative criterion PASS.
   */
  finalizeOrchestrationRun(input: {
    verificationRunId: string;
    status: 'completed' | 'failed';
    summary?: Record<string, unknown>;
    errorMetadata?: Record<string, unknown> | null;
  }): Promise<VerificationRun>;

  /**
   * WORK-051 round 1 (BLOCKER 4) — find an orchestration run by its durable
   * idempotency identity. Pure read owned by /verification; this is the
   * replay lookup for orchestration producers (the checkpoint subsystem no
   * longer scans run metadata — the identity is a first-class, unique,
   * indexed column).
   */
  findOrchestrationRun(orchestrationKey: string): Promise<VerificationRun | null>;

  /**
   * WORK-051 round 1 (BLOCKER 4 + crash safety) — the ATOMIC orchestration
   * record. Everything an orchestration producer (e.g. the architecture
   * checkpoint subsystem) persists for one logical evaluation — the run row
   * (with its durable orchestration identity), every evidence row, and the
   * terminal finalization — is written in ONE database transaction:
   *
   *   create-or-converge the run (UNIQUE orchestration_key arbitrates
   *     concurrent callers: exactly one run per key)
   *   → attach the evidence rows (claim authority — the orchestration path
   *     is never authoritative evidence)
   *   → finalize the run to the requested terminal status.
   *
   * Convergence semantics:
   * - `created: true` — this caller won the create-or-converge race; the
   *   returned run carries THIS evaluation's evidence + terminal summary.
   * - `created: false` — a run already exists for the key:
   *     - terminal → returned unchanged (the caller replays the recorded
   *       result; NOTHING is appended — the existing run is immutable
   *       history);
   *     - non-terminal (a partial reservation left by a pre-transactional
   *       writer or an adopted legacy row) → the transaction ADOPTS it: the
   *       evidence rows are attached and the run is finalized, reconciling
   *       the partial state in one atomic step.
   *
   * A crash at ANY point leaves NOTHING (the transaction aborts) — partial
   * or pending checkpoint evidence cannot persist. The caller never writes
   * verification tables directly.
   */
  recordOrchestrationRun(input: {
    /** Identical to {@link CreateVerificationRunInput} + the durable key. */
    run: CreateVerificationRunInput & { orchestrationKey: string };
    /** Evidence rows attached atomically with the run + finalization. */
    evidence: ReadonlyArray<Omit<CreateEvidenceInput, 'projectId' | 'verificationRunId'>>;
    /** The terminal finalization (status is always terminal). */
    finalize: {
      status: 'completed' | 'failed';
      summary: Record<string, unknown>;
      errorMetadata?: Record<string, unknown> | null;
    };
  }): Promise<{ run: VerificationRun; created: boolean }>;
}
