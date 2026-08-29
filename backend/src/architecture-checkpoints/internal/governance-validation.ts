/**
 * WORK-052 — the development-governance state contracts + the ONE fail-closed
 * validation engine (ADR-0004).
 *
 * This module is deliberately self-contained inside the architecture-checkpoints
 * subsystem: it is the input contract of the `governance-manifest` detector
 * (ADR-0006) AND the validation core reused by the application-layer control
 * plane (`src/development-governance/`) through the public barrel. ONE engine —
 * the control plane and the checkpoint substrate can never disagree about what
 * a valid governed state is.
 *
 * The canonical state it validates is repository-resident
 * (`spec/development-state/governance-model.json` + `program-state.json`,
 * ADR-0001): the repository — not any chat conversation and not the database —
 * is the durable source of truth for the self-hosting program.
 *
 * Fail-closed principle (WORK-051's central governance rule, carried forward):
 * a governance control must never claim stronger provenance, identity, or
 * boundary guarantees than the underlying authority can actually prove. Every
 * violation below is REJECTING: the caller refuses to serve or to pass a state
 * it cannot prove consistent.
 *
 * The mutable artifact is cross-checked against the CODE-PINNED minimums in
 * this file: weakening the self-hosting boundary, dropping a proof class from
 * a profile, or drifting a vocabulary requires touching BOTH the artifact and
 * this code — a visible, reviewable diff (the no-silent-rewrite property).
 */

import { IMPACT_CHECKPOINT_MATRIX } from '../types.js';

// ---------------------------------------------------------------------------
// Vocabularies (code-pinned — the closed sets the artifacts must match exactly)
// ---------------------------------------------------------------------------

export type AssuranceProfile = 'LIGHT' | 'STANDARD' | 'HIGH_ASSURANCE' | 'CRITICAL';

export type ChangeSurfaceFlag =
  | 'documentation'
  | 'localBehavior'
  | 'moduleInternals'
  | 'multiModule'
  | 'publicContracts'
  | 'schema'
  | 'concurrency'
  | 'externalSideEffects'
  | 'authorityBoundary'
  | 'securityTenant';

export type ProofClass = 'static' | 'dynamic' | 'discrimination';

export type GovernanceCheckpointKind =
  | 'readiness'
  | 'work_order'
  | 'pr_conformance'
  | 'verification_entry';

export type WorkOrderStatus = 'complete' | 'in_flight' | 'blocked' | 'pending';

export type FeedbackOrigin =
  | 'architect'
  | 'maintenance-signal'
  | 'verification-failure'
  | 'user-feedback'
  | 'architecture-drift'
  | 'benchmark-evidence';

export type ImpactLevel = 'low' | 'medium' | 'high';

export const ASSURANCE_PROFILES: readonly AssuranceProfile[] = [
  'LIGHT',
  'STANDARD',
  'HIGH_ASSURANCE',
  'CRITICAL',
];

export const CHANGE_SURFACE_FLAGS: readonly ChangeSurfaceFlag[] = [
  'documentation',
  'localBehavior',
  'moduleInternals',
  'multiModule',
  'publicContracts',
  'schema',
  'concurrency',
  'externalSideEffects',
  'authorityBoundary',
  'securityTenant',
];

export const PROOF_CLASSES: readonly ProofClass[] = ['static', 'dynamic', 'discrimination'];

/** Mirrors the /workflows ArchitectureCheckpointKind contract (pinned equal by static invariants). */
export const GOVERNANCE_CHECKPOINT_KINDS: readonly GovernanceCheckpointKind[] = [
  'readiness',
  'work_order',
  'pr_conformance',
  'verification_entry',
];

export const WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = [
  'complete',
  'in_flight',
  'blocked',
  'pending',
];

export const FEEDBACK_ORIGINS: readonly FeedbackOrigin[] = [
  'architect',
  'maintenance-signal',
  'verification-failure',
  'user-feedback',
  'architecture-drift',
  'benchmark-evidence',
];

/** The Engineering Control Loop stages — pinned, in order (§34.2). */
export const CONTROL_LOOP_STAGES: readonly string[] = [
  'sense',
  'understand',
  'plan',
  'check',
  'execute',
  'verify',
  'review',
  'release',
  'observe',
  'learn',
];

/**
 * The core self-hosting prohibitions (§34.7). The artifact's boundary MUST
 * contain these verbatim — removing one from governance-model.json is a
 * validation failure, not a silent weakening (ADR-0004).
 */
export const CORE_SELF_HOSTING_PROHIBITIONS: readonly string[] = [
  'silently rewrite its frozen governing architecture — changes require the architecture-change/versioning authority (Work Order + new immutable version)',
  'introduce a second workflow engine or lifecycle authority',
  'introduce a second Work Item authority',
  'introduce a second verification or evidence authority',
  'introduce a second architecture authority',
  'weaken tenant isolation or server-side security invariants',
  'weaken concurrency or idempotency guarantees',
  'let a self-hosted worker merge its own governing PR — PR review by the architect is the only merge gate',
];

/**
 * The code-pinned completion rule (the PR #62 round-1 review, BLOCKER 3):
 * the architect's MERGE is the ONLY completion event. Checkpoint outcomes are
 * implementer-recorded claims that support the PR review; they never
 * transition status and never substitute the merge. The artifact's
 * `completionRule` must match these pinned essentials — weakening the rule in
 * governance-model.json is a validation failure, not a silent policy change.
 */
export const CODE_PINNED_COMPLETION_RULE: Readonly<{
  completionEvent: 'architect-merge';
  outcomesAllowedOn: readonly string[];
}> = {
  completionEvent: 'architect-merge',
  outcomesAllowedOn: ['in_flight', 'complete'],
};

/**
 * The code-pinned post-merge finalization protocol (§34.8; ADR-0007; the
 * post-merge review of PR #62, BLOCKER 2): the completion rule defines the
 * completion CONDITION — this protocol defines the finalization MECHANISM
 * that reconciles the canonical state with the architect's merge AFTER it
 * lands. Weakening it in governance-model.json is a validation failure, not
 * a silent policy change.
 */
export const CODE_PINNED_POST_MERGE_FINALIZATION: Readonly<{
  trigger: 'architect-merge';
  obligationMustMention: readonly string[];
  enforcementMustMention: readonly string[];
  constraintsMustInclude: readonly string[];
}> = {
  trigger: 'architect-merge',
  obligationMustMention: ['mergedAs', 'handoff', 'data-only'],
  enforcementMustMention: ['merged-finalization'],
  constraintsMustInclude: ['no new authority', 'no new workflow state', 'no automation'],
};

/**
 * The code-pinned assurance minimums (ADR-0002): every profile's declared
 * requirements must be a SUPERSET of these. These minimums are themselves the
 * dominance floor over the WORK-051 impact/checkpoint matrix (each profile
 * covers impact levels whose matrix kinds it must require), so assurance can
 * only ADD depth, never subtract.
 */
export const CODE_PINNED_PROFILE_MINIMUMS: Readonly<
  Record<AssuranceProfile, { checkpointKinds: readonly GovernanceCheckpointKind[]; proofClasses: readonly ProofClass[]; architectReviewRecord: boolean }>
> = {
  LIGHT: {
    checkpointKinds: ['pr_conformance'],
    proofClasses: ['static'],
    architectReviewRecord: false,
  },
  STANDARD: {
    checkpointKinds: ['work_order', 'pr_conformance'],
    proofClasses: ['static', 'dynamic'],
    architectReviewRecord: false,
  },
  HIGH_ASSURANCE: {
    checkpointKinds: ['readiness', 'work_order', 'pr_conformance', 'verification_entry'],
    proofClasses: ['static', 'dynamic', 'discrimination'],
    architectReviewRecord: false,
  },
  CRITICAL: {
    checkpointKinds: ['readiness', 'work_order', 'pr_conformance', 'verification_entry'],
    proofClasses: ['static', 'dynamic', 'discrimination'],
    architectReviewRecord: true,
  },
};

/** The classification rule order (deterministic first-match, most severe first). */
export const CLASSIFICATION_ORDER: readonly AssuranceProfile[] = [
  'CRITICAL',
  'HIGH_ASSURANCE',
  'STANDARD',
  'LIGHT',
];

// ---------------------------------------------------------------------------
// Artifact shapes (the machine-readable repository-resident state)
// ---------------------------------------------------------------------------

export interface SelectionRule {
  profile: AssuranceProfile;
  whenAny: ChangeSurfaceFlag[];
}

export interface AssuranceRequirements {
  checkpointKinds: GovernanceCheckpointKind[];
  proofClasses: ProofClass[];
  evidence: string[];
  architectReviewRecord: boolean;
  impactCoverage: ImpactLevel[];
  impactFloor: ImpactLevel;
}

export interface EnforcementReference {
  class: ProofClass;
  file: string;
  marker: string;
}

export interface CheckpointContract {
  id: string;
  area: string;
  statement: string;
  severity: 'blocking' | 'advisory';
  proofClasses: ProofClass[];
  enforcement: EnforcementReference[];
}

export interface SelfHostingBoundary {
  may: string[];
  mayNot: string[];
  coreProhibitions: string[];
}

export interface ControlLoopStage {
  name: string;
  authority: string;
  mechanism: string;
}

export interface AuthorityMapEntry {
  authority: string;
  owns: string;
}

export interface GovernanceModel {
  schemaVersion: number;
  artifact: string;
  authority: {
    owner: string;
    designPackage: string;
    specSection: string;
    lockInvariants: string;
    decisions: string[];
  };
  engineeringControlLoop: { stages: ControlLoopStage[]; rule: string };
  assuranceProfiles: {
    vocabulary: AssuranceProfile[];
    surfaceVocabulary: ChangeSurfaceFlag[];
    selection: {
      rule: string;
      classification: SelectionRule[];
      unclassifiedDefault: AssuranceProfile;
      determinism: string;
    };
    proofClassVocabulary: ProofClass[];
    checkpointKindVocabulary: GovernanceCheckpointKind[];
    requirements: Record<AssuranceProfile, AssuranceRequirements>;
    dominanceRule: string;
    authorityRule: string;
  };
  checkpointContracts: CheckpointContract[];
  selfHostingBoundary: SelfHostingBoundary;
  /** The explicit merge-vs-checkpoint completion rule (the PR #62 round-1 review, BLOCKER 3). */
  completionRule: {
    completionEvent: string;
    rule: string;
    checkpointOutcomesAre: string;
    inFlightInvariant: string;
    outcomesAllowedOn: string[];
    historicalNote?: string;
  };
  /** The post-merge finalization protocol (§34.8; ADR-0007; the post-merge review, BLOCKER 2). */
  postMergeFinalization: {
    trigger: string;
    obligation: string;
    enforcement: string;
    constraints: string[];
  };
  parallelProtocol: { authority: string; rules: string[]; surfaceKinds: string[] };
  feedbackOrigins: FeedbackOrigin[];
  feedbackRule: string;
  authorityMap: AuthorityMapEntry[];
  detector: {
    kind: string;
    registry: string;
    defaultModelPath: string;
    defaultProgramPath: string;
    semantics: string;
  };
}

export interface MergeEvidence {
  pr: number;
  mergeCommit: string;
}

export interface WorkOrderSurfaces {
  modules?: string[];
  appLayer?: string[];
  migrations?: string[];
  reservedMigrations?: string[];
  specDocs?: string[];
  sharedIntegrationSurfaces?: string[];
}

export interface CoordinationRecord {
  with: string[];
  reason: string;
  adrs: string[];
}

export interface CheckpointOutcomeRecord {
  contractId: string;
  status: 'evidenced';
  proofClasses: ProofClass[];
  evidenceRef: string;
  at: string;
}

export interface WorkOrderRecord {
  id: string;
  title: string;
  status: WorkOrderStatus;
  dependencies: string[];
  mergedAs?: MergeEvidence;
  branch?: string;
  pr?: number;
  head?: string;
  issue?: number;
  workOrder?: string;
  origin?: FeedbackOrigin;
  surfaces?: WorkOrderSurfaces;
  surfaceFlags?: ChangeSurfaceFlag[];
  assuranceProfile?: AssuranceProfile;
  runtimeImpactBinding?: ImpactLevel;
  coordination?: CoordinationRecord;
  checkpointOutcomes?: CheckpointOutcomeRecord[];
  note?: string;
}

export interface HandoffRecord {
  workOrderId: string;
  lastVerifiedState: string;
  nextSteps: string[];
  blockers: string[];
  recordedAt: string;
  recordedBy: string;
}

export type DecisionKind = 'adr' | 'design' | 'lock' | 'spec' | 'release';

export interface DecisionRecord {
  id: string;
  kind: DecisionKind;
  title: string;
  file: string;
  status: string;
}

export interface ProgramState {
  schemaVersion: number;
  artifact: string;
  protocol: string;
  asOf: string;
  governing: {
    architectureVersion: string;
    architectureVersionState: string;
    evolution: string;
    governingDocuments: string[];
    activeDesignPackage: string;
    authorityOwners: AuthorityMapEntry[];
  };
  workOrders: WorkOrderRecord[];
  resumption: { protocol: string; activeHandoffs: HandoffRecord[] };
  decisions: DecisionRecord[];
}

// ---------------------------------------------------------------------------
// Deterministic assurance selection (ADR-0002 — pure function over the model)
// ---------------------------------------------------------------------------

/**
 * Select the assurance profile from declared change surfaces: the FIRST
 * classification rule (declared most-severe-first, pinned by
 * {@link CLASSIFICATION_ORDER}) whose `whenAny` intersects the declared
 * surfaces. No declared/known surface falls back to the model's
 * `unclassifiedDefault` (fail-closed HIGH_ASSURANCE in the canonical model).
 * Pure: the same surfaces always select the same profile.
 */
export function selectAssuranceProfile(
  model: Pick<GovernanceModel, 'assuranceProfiles'>,
  surfaces: readonly ChangeSurfaceFlag[],
): AssuranceProfile {
  const declared = model.assuranceProfiles.selection.classification;
  for (const rule of declared) {
    if (rule.whenAny.some((f) => surfaces.includes(f))) return rule.profile;
  }
  return model.assuranceProfiles.selection.unclassifiedDefault;
}

// ---------------------------------------------------------------------------
// The validation engine
// ---------------------------------------------------------------------------

/**
 * Reads a repository-relative file for enforcement-reference validation.
 * Returns null when the path does not exist; may THROW on a read failure
 * (callers fail closed on a throw — the control plane surfaces the error, the
 * detector evaluates 'inconclusive').
 */
export type GovernanceFileReader = (repoRelativePath: string) => Promise<string | null>;

/**
 * Lists a repository-relative directory for work-order identity-surface
 * validation (returns the entry names; `[]` when the directory does not
 * exist). May THROW on a read failure — callers fail closed on a throw,
 * exactly like {@link GovernanceFileReader}.
 */
export type GovernanceDirLister = (repoRelativePath: string) => Promise<readonly string[]>;

/**
 * The ONE authoritative directory for Work Order identity artifacts
 * (code-pinned): `spec/work-orders/` holds exactly the canonical
 * `WORK-NNN.md` files (plus `TEMPLATE.md`). Retired/superseded identity
 * material lives in `spec/archive/` under distinct identities — NEVER here.
 */
export const AUTHORITATIVE_WORK_ORDER_DIR = 'spec/work-orders';

export interface GovernanceValidationResult {
  ok: boolean;
  violations: string[];
}

const IMPACT_RANK: Record<ImpactLevel, number> = { low: 1, medium: 2, high: 3 };

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

function knownKeys(
  value: object,
  allowed: readonly string[],
  path: string,
  violations: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      violations.push(
        `${path}: unknown field "${key}" — schema drift is rejected; bump schemaVersion for deliberate evolution`,
      );
    }
  }
}

/**
 * Validate the repository-resident development-governance state FAIL-CLOSED.
 *
 * Both consumers share this ONE engine:
 *  - the control plane (`src/development-governance/`) refuses to serve a
 *    state that does not pass;
 *  - the `governance-manifest` detector fails the checkpoint when it does not
 *    pass at the evaluated revision.
 */
export async function validateGovernanceState(
  model: GovernanceModel,
  program: ProgramState,
  readFile: GovernanceFileReader,
  listDir?: GovernanceDirLister,
): Promise<GovernanceValidationResult> {
  const violations: string[] = [];

  // --- (1) schema identity -------------------------------------------------
  if (model.schemaVersion !== 1) violations.push(`governance-model: schemaVersion must be 1 (got ${String(model.schemaVersion)})`);
  if (model.artifact !== 'workflowos-development-state/governance-model') violations.push(`governance-model: artifact mismatch (got ${JSON.stringify(model.artifact)})`);
  if (program.schemaVersion !== 1) violations.push(`program-state: schemaVersion must be 1 (got ${String(program.schemaVersion)})`);
  if (program.artifact !== 'workflowos-development-state/program-state') violations.push(`program-state: artifact mismatch (got ${JSON.stringify(program.artifact)})`);

  if (model && typeof model === 'object') knownKeys(model, [
    '$schema', 'schemaVersion', 'artifact', 'authority', 'engineeringControlLoop', 'assuranceProfiles',
    'checkpointContracts', 'selfHostingBoundary', 'completionRule', 'postMergeFinalization',
    'parallelProtocol', 'feedbackOrigins', 'feedbackRule', 'authorityMap', 'detector',
  ], 'governance-model', violations);

  // --- (2) the control loop is pinned --------------------------------------
  const stages = model.engineeringControlLoop?.stages;
  if (!Array.isArray(stages) || stages.length !== CONTROL_LOOP_STAGES.length) {
    violations.push(`engineeringControlLoop: exactly ${CONTROL_LOOP_STAGES.length} stages required`);
  } else {
    for (let i = 0; i < CONTROL_LOOP_STAGES.length; i++) {
      if (stages[i]?.name !== CONTROL_LOOP_STAGES[i]) {
        violations.push(`engineeringControlLoop.stages[${i}]: expected "${CONTROL_LOOP_STAGES[i]}" (got ${JSON.stringify(stages[i]?.name)})`);
      }
      if (!isNonEmptyString(stages[i]?.authority) || !isNonEmptyString(stages[i]?.mechanism)) {
        violations.push(`engineeringControlLoop.stages[${i}]: authority and mechanism must be non-empty strings`);
      }
    }
  }

  // --- (3) assurance vocabularies match the code-pinned closed sets ---------
  const ap = model.assuranceProfiles;
  if (!ap) {
    violations.push('assuranceProfiles: required');
  } else {
    knownKeys(ap, [
      'vocabulary', 'surfaceVocabulary', 'selection', 'proofClassVocabulary',
      'checkpointKindVocabulary', 'requirements', 'dominanceRule', 'authorityRule',
    ], 'assuranceProfiles', violations);
    const vocab = ap.vocabulary ?? [];
    if (vocab.length !== ASSURANCE_PROFILES.length || !ASSURANCE_PROFILES.every((p) => vocab.includes(p))) {
      violations.push(`assuranceProfiles.vocabulary must be exactly [${ASSURANCE_PROFILES.join(', ')}]`);
    }
    const surfaces = ap.surfaceVocabulary ?? [];
    if (surfaces.length !== CHANGE_SURFACE_FLAGS.length || !CHANGE_SURFACE_FLAGS.every((f) => surfaces.includes(f))) {
      violations.push(`assuranceProfiles.surfaceVocabulary must be exactly the ${CHANGE_SURFACE_FLAGS.length} code-pinned change surfaces`);
    }
    const proofs = ap.proofClassVocabulary ?? [];
    if (proofs.length !== PROOF_CLASSES.length || !PROOF_CLASSES.every((p) => proofs.includes(p))) {
      violations.push(`assuranceProfiles.proofClassVocabulary must be exactly [${PROOF_CLASSES.join(', ')}]`);
    }
    const kinds = ap.checkpointKindVocabulary ?? [];
    if (kinds.length !== GOVERNANCE_CHECKPOINT_KINDS.length || !GOVERNANCE_CHECKPOINT_KINDS.every((k) => kinds.includes(k))) {
      violations.push(`assuranceProfiles.checkpointKindVocabulary must be exactly the /workflows checkpoint kinds [${GOVERNANCE_CHECKPOINT_KINDS.join(', ')}]`);
    }

    // --- (4) selection rules: deterministic first-match, total coverage -----
    const selection = ap.selection;
    if (!selection) {
      violations.push('assuranceProfiles.selection: required');
    } else {
      knownKeys(selection, ['rule', 'classification', 'unclassifiedDefault', 'determinism'], 'assuranceProfiles.selection', violations);
      const classification = selection.classification ?? [];
      const order = classification.map((r) => r?.profile);
      if (order.length !== CLASSIFICATION_ORDER.length || !CLASSIFICATION_ORDER.every((p, i) => order[i] === p)) {
        violations.push(`assuranceProfiles.selection.classification must declare exactly one rule per profile in the order [${CLASSIFICATION_ORDER.join(', ')}] (first-match, most severe first)`);
      }
      const covered = new Set<string>();
      for (const rule of classification) {
        if (!isStringArray(rule?.whenAny) || rule.whenAny.length === 0) {
          violations.push(`selection.classification[${JSON.stringify(rule?.profile)}]: whenAny must be a non-empty surface list`);
        } else {
          for (const f of rule.whenAny) {
            if (!CHANGE_SURFACE_FLAGS.includes(f as ChangeSurfaceFlag)) violations.push(`selection.classification[${rule.profile}]: unknown surface "${f}"`);
            covered.add(f);
          }
        }
      }
      for (const f of CHANGE_SURFACE_FLAGS) {
        if (!covered.has(f)) violations.push(`selection.classification: surface "${f}" is not classified by any rule (selection must be total)`);
      }
      if (!ASSURANCE_PROFILES.includes(selection.unclassifiedDefault)) {
        violations.push(`selection.unclassifiedDefault must be an assurance profile (got ${JSON.stringify(selection.unclassifiedDefault)})`);
      }
    }

    // --- (5) requirements: dominance + code-pinned minimums ----------------
    const requirements = ap.requirements;
    if (!requirements) {
      violations.push('assuranceProfiles.requirements: required');
    } else {
      knownKeys(requirements, ASSURANCE_PROFILES as readonly string[], 'assuranceProfiles.requirements', violations);
      for (const profile of ASSURANCE_PROFILES) {
        const req = requirements[profile] as unknown;
        if (!req || typeof req !== 'object') {
          violations.push(`requirements.${profile}: required`);
          continue;
        }
        knownKeys(req as Record<string, unknown>, ['checkpointKinds', 'proofClasses', 'evidence', 'architectReviewRecord', 'impactCoverage', 'impactFloor'], `requirements.${profile}`, violations);
        const r = req as Partial<AssuranceRequirements>;
        if (!isStringArray(r.checkpointKinds) || r.checkpointKinds.length === 0) {
          violations.push(`requirements.${profile}.checkpointKinds must be a non-empty list`);
        } else {
          for (const k of r.checkpointKinds) {
            if (!GOVERNANCE_CHECKPOINT_KINDS.includes(k as GovernanceCheckpointKind)) violations.push(`requirements.${profile}.checkpointKinds: unknown kind "${k}"`);
          }
        }
        if (!isStringArray(r.proofClasses) || r.proofClasses.length === 0) {
          violations.push(`requirements.${profile}.proofClasses must be a non-empty list`);
        } else {
          for (const p of r.proofClasses) {
            if (!PROOF_CLASSES.includes(p as ProofClass)) violations.push(`requirements.${profile}.proofClasses: unknown class "${p}"`);
          }
        }
        if (!isStringArray(r.evidence) || r.evidence.length === 0) violations.push(`requirements.${profile}.evidence must be a non-empty list`);
        if (!isBoolean(r.architectReviewRecord)) violations.push(`requirements.${profile}.architectReviewRecord must be boolean`);

        const minimum = CODE_PINNED_PROFILE_MINIMUMS[profile];
        const kinds = isStringArray(r.checkpointKinds) ? r.checkpointKinds : [];
        for (const k of minimum.checkpointKinds) {
          if (!kinds.includes(k)) violations.push(`requirements.${profile}: MISSING required checkpoint kind "${k}" — the code-pinned minimum was weakened (ADR-0002)`);
        }
        const proofs = isStringArray(r.proofClasses) ? r.proofClasses : [];
        for (const p of minimum.proofClasses) {
          if (!proofs.includes(p)) violations.push(`requirements.${profile}: MISSING required proof class "${p}" — the code-pinned minimum was weakened (ADR-0002)`);
        }
        if (minimum.architectReviewRecord && r.architectReviewRecord !== true) {
          violations.push(`requirements.${profile}: architectReviewRecord must be true — the code-pinned minimum was weakened (ADR-0002)`);
        }

        // Dominance over the LIVE WORK-051 impact/checkpoint matrix: for every
        // impact level this profile covers, every kind the matrix applies at
        // that level must be required here. Assurance adds depth, never subtracts.
        const coverage = isStringArray(r.impactCoverage) ? r.impactCoverage : [];
        for (const level of coverage) {
          if (!['low', 'medium', 'high'].includes(level)) {
            violations.push(`requirements.${profile}.impactCoverage: unknown impact level "${level}"`);
            continue;
          }
          for (const [kind, levels] of Object.entries(IMPACT_CHECKPOINT_MATRIX)) {
            if ((levels as readonly string[]).includes(level) && !kinds.includes(kind as GovernanceCheckpointKind)) {
              violations.push(`requirements.${profile}: kind "${kind}" is applied by the impact matrix at level "${level}" which this profile covers — the profile must REQUIRE it (dominance, ADR-0002)`);
            }
          }
        }
        if (!isNonEmptyString(r.impactFloor) || !['low', 'medium', 'high'].includes(r.impactFloor ?? '')) {
          violations.push(`requirements.${profile}.impactFloor must be an impact level`);
        }
      }
    }
  }

  // --- (6) checkpoint contracts: ≥11, well-formed, enforcement exists -------
  const contracts = model.checkpointContracts;
  if (!Array.isArray(contracts) || contracts.length < 11) {
    violations.push(`checkpointContracts: at least 11 governed contracts required (got ${Array.isArray(contracts) ? contracts.length : 'none'})`);
  } else {
    const seenIds = new Set<string>();
    const REQUIRED_CONTRACT_AREAS = [
      'authority preservation', 'dependency direction', 'tenant isolation', 'identity / idempotency',
      'concurrency and crash safety', 'external side-effect boundaries', 'exact-revision / provenance integrity',
      'migration / immutability safety', 'forbidden duplicate authorities',
      'implementation completeness against the Work Order', 'self-hosting boundary',
    ];
    const areas = new Set<string>();
    for (const c of contracts) {
      if (!c || typeof c !== 'object') { violations.push('checkpointContracts: malformed entry'); continue; }
      knownKeys(c as unknown as Record<string, unknown>, ['id', 'area', 'statement', 'severity', 'proofClasses', 'enforcement'], `checkpointContracts[${JSON.stringify(c.id ?? '?')}]`, violations);
      if (!isNonEmptyString(c.id) || !/^[A-Z0-9-]+$/.test(c.id ?? '')) violations.push(`checkpointContracts: id must be UPPER-CASE (${JSON.stringify(c.id)})`);
      if (seenIds.has(c.id ?? '')) violations.push(`checkpointContracts: duplicate id "${c.id}"`);
      seenIds.add(c.id ?? '');
      if (!isNonEmptyString(c.area)) violations.push(`checkpointContracts[${c.id}]: area required`);
      else areas.add(c.area);
      if (!isNonEmptyString(c.statement)) violations.push(`checkpointContracts[${c.id}]: statement required`);
      if (c.severity !== 'blocking' && c.severity !== 'advisory') violations.push(`checkpointContracts[${c.id}]: severity must be blocking|advisory`);
      if (!isStringArray(c.proofClasses) || c.proofClasses.length === 0) violations.push(`checkpointContracts[${c.id}]: proofClasses must be non-empty`);
      else for (const p of c.proofClasses) if (!PROOF_CLASSES.includes(p as ProofClass)) violations.push(`checkpointContracts[${c.id}]: unknown proof class "${p}"`);
      if (!Array.isArray(c.enforcement) || c.enforcement.length === 0) {
        violations.push(`checkpointContracts[${c.id}]: enforcement references required`);
      } else {
        for (const e of c.enforcement) {
          if (!e || typeof e !== 'object') { violations.push(`checkpointContracts[${c.id}]: malformed enforcement entry`); continue; }
          knownKeys(e as unknown as Record<string, unknown>, ['class', 'file', 'marker'], `checkpointContracts[${c.id}].enforcement`, violations);
          if (!PROOF_CLASSES.includes(e.class as ProofClass)) violations.push(`checkpointContracts[${c.id}].enforcement: unknown class "${JSON.stringify(e.class)}"`);
          if (!isNonEmptyString(e.file) || !isNonEmptyString(e.marker)) {
            violations.push(`checkpointContracts[${c.id}].enforcement: file and marker required`);
            continue;
          }
          const content = await readFile(e.file);
          if (content === null) {
            violations.push(`checkpointContracts[${c.id}].enforcement: referenced file does not exist in the repository: ${e.file}`);
          } else if (!content.includes(e.marker)) {
            violations.push(`checkpointContracts[${c.id}].enforcement: marker not found in ${e.file}: ${JSON.stringify(e.marker)}`);
          }
        }
        // Coherence: the declared proof classes must be exactly the classes of
        // the enforcement references (a contract may not claim a proof class it
        // does not evidence, nor evidence one it does not require).
        const enforcementClasses = new Set(
          (c.enforcement as unknown[]).filter((e) => e && typeof e === 'object').map((e) => (e as { class?: unknown }).class),
        );
        const declaredClasses = new Set(isStringArray(c.proofClasses) ? c.proofClasses : []);
        for (const cls of declaredClasses) {
          if (!enforcementClasses.has(cls)) violations.push(`checkpointContracts[${c.id}]: proof class "${cls}" is declared but NOT evidenced by any enforcement reference`);
        }
        for (const cls of enforcementClasses) {
          if (!declaredClasses.has(cls as ProofClass)) violations.push(`checkpointContracts[${c.id}]: enforcement evidences proof class "${JSON.stringify(cls)}" that the contract does not declare`);
        }
      }
    }
    for (const area of REQUIRED_CONTRACT_AREAS) {
      if (!areas.has(area)) violations.push(`checkpointContracts: required contract area missing: ${area}`);
    }
  }

  // --- (7) the self-hosting boundary (§34.7, ADR-0004) ----------------------
  const boundary = model.selfHostingBoundary;
  if (!boundary) {
    violations.push('selfHostingBoundary: required');
  } else {
    knownKeys(boundary, ['may', 'mayNot', 'coreProhibitions'], 'selfHostingBoundary', violations);
    if (!isStringArray(boundary.may) || boundary.may.length === 0) violations.push('selfHostingBoundary.may: non-empty list required');
    if (!isStringArray(boundary.mayNot) || boundary.mayNot.length === 0) violations.push('selfHostingBoundary.mayNot: non-empty list required');
    if (!isStringArray(boundary.coreProhibitions) || boundary.coreProhibitions.length === 0) {
      violations.push('selfHostingBoundary.coreProhibitions: non-empty list required');
    } else {
      for (const core of CORE_SELF_HOSTING_PROHIBITIONS) {
        if (!boundary.coreProhibitions.includes(core)) {
          violations.push(`selfHostingBoundary: core prohibition REMOVED — "${core.slice(0, 80)}…" (code-pinned, ADR-0004: weakening the boundary is a validation failure, never a silent pass)`);
        }
      }
      for (const core of boundary.coreProhibitions) {
        if (!(boundary.mayNot ?? []).includes(core)) {
          violations.push('selfHostingBoundary: every core prohibition must also appear in mayNot');
        }
      }
    }
  }

  // --- (8) parallel protocol + feedback + authority map ---------------------
  const protocol = model.parallelProtocol;
  if (!protocol || !isStringArray(protocol.rules) || protocol.rules.length < 6) {
    violations.push('parallelProtocol: at least 6 rules required (one Work Item per branch/PR; dependency eligibility; conflict detection; scope integrity; centralized decisions; merge gate)');
  } else {
    // MUTUALITY is part of the protocol itself (the PR #62 round-1 review):
    // a declared coordination between two in-flight work orders appears on
    // BOTH records — one-sided declarations are invalid state.
    const declaresMutuality = protocol.rules.some((r) => /mutual|both records|one-sided/i.test(r));
    if (!declaresMutuality) {
      violations.push('parallelProtocol.rules: the mutuality rule is REQUIRED (a declared coordination between two in-flight work orders appears on both records; one-sided declarations are invalid state — the PR #62 round-1 review, BLOCKER 1)');
    }
  }
  if (!isStringArray(model.feedbackOrigins) || model.feedbackOrigins.length === 0) {
    violations.push('feedbackOrigins: non-empty vocabulary required');
  } else {
    for (const o of model.feedbackOrigins) if (!FEEDBACK_ORIGINS.includes(o as FeedbackOrigin)) violations.push(`feedbackOrigins: unknown origin "${o}"`);
  }
  if (!isStringArray(model.authorityMap) && !Array.isArray(model.authorityMap)) {
    violations.push('authorityMap: required');
  } else if (Array.isArray(model.authorityMap) && model.authorityMap.length === 0) {
    violations.push('authorityMap: non-empty required');
  }
  if (model.detector?.kind !== 'governance-manifest') violations.push('detector.kind must be "governance-manifest"');

  // --- (8b) the explicit merge-vs-checkpoint completion rule -----------------
  // The architect's MERGE is the ONLY completion event; checkpoint outcomes
  // are implementer claims (the PR #62 round-1 review, BLOCKER 3). The
  // artifact must declare the rule AND match the code-pinned essentials.
  const completion = model.completionRule;
  if (!completion || typeof completion !== 'object') {
    violations.push('completionRule: REQUIRED — the merge-vs-checkpoint completion rule must be explicit machine-readable state (the PR #62 round-1 review, BLOCKER 3)');
  } else {
    knownKeys(completion, ['completionEvent', 'rule', 'checkpointOutcomesAre', 'inFlightInvariant', 'outcomesAllowedOn', 'historicalNote'], 'completionRule', violations);
    if (completion.completionEvent !== CODE_PINNED_COMPLETION_RULE.completionEvent) {
      violations.push(`completionRule.completionEvent must be "${CODE_PINNED_COMPLETION_RULE.completionEvent}" (got ${JSON.stringify(completion.completionEvent)}) — the architect's merge is the ONLY completion event; checkpoint outcomes must NEVER complete a work order (the code-pinned rule was weakened)`);
    }
    if (!isNonEmptyString(completion.rule) || !/mergedAs/.test(completion.rule ?? '')) {
      violations.push('completionRule.rule must state the mergedAs merge-evidence requirement');
    }
    if (!isNonEmptyString(completion.checkpointOutcomesAre) || !/claim/i.test(completion.checkpointOutcomesAre ?? '')) {
      violations.push('completionRule.checkpointOutcomesAre must state that checkpoint outcomes are implementer CLAIMS (never a substitute for the merge)');
    }
    if (!isNonEmptyString(completion.inFlightInvariant)) {
      violations.push('completionRule.inFlightInvariant required');
    }
    if (!isStringArray(completion.outcomesAllowedOn) || completion.outcomesAllowedOn.length !== CODE_PINNED_COMPLETION_RULE.outcomesAllowedOn.length || !CODE_PINNED_COMPLETION_RULE.outcomesAllowedOn.every((s, i) => completion.outcomesAllowedOn[i] === s)) {
      violations.push(`completionRule.outcomesAllowedOn must be exactly [${CODE_PINNED_COMPLETION_RULE.outcomesAllowedOn.join(', ')}] — widening where implementer claims may be recorded weakens the merge-vs-checkpoint separation`);
    }
  }

  // --- (8c) the post-merge finalization protocol (§34.8; ADR-0007) ------------
  // The post-merge review of PR #62 (merged as 47615c2 while the canonical
  // state still said in_flight) exposed the operational gap: the completion
  // rule defines the completion CONDITION; the repository needs an explicit
  // finalization MECHANISM so a merged Work Order can never remain represented
  // as in_flight in canonical state. The protocol is code-pinned like the
  // completion rule itself.
  const finalization = model.postMergeFinalization;
  if (!finalization || typeof finalization !== 'object') {
    violations.push('postMergeFinalization: REQUIRED — the post-merge finalization protocol must be explicit machine-readable state (the post-merge review, BLOCKER 2)');
  } else {
    knownKeys(finalization, ['trigger', 'obligation', 'enforcement', 'constraints'], 'postMergeFinalization', violations);
    if (finalization.trigger !== CODE_PINNED_POST_MERGE_FINALIZATION.trigger) {
      violations.push(`postMergeFinalization.trigger must be "${CODE_PINNED_POST_MERGE_FINALIZATION.trigger}" (got ${JSON.stringify(finalization.trigger)}) — the finalization is triggered by the SAME event that completes the work order (the architect's merge)`);
    }
    for (const word of CODE_PINNED_POST_MERGE_FINALIZATION.obligationMustMention) {
      if (!isNonEmptyString(finalization.obligation) || !finalization.obligation.includes(word)) {
        violations.push(`postMergeFinalization.obligation must mention "${word}" (status → complete with mergedAs recording the ACTUAL merge commit; handoff removal; a data-only change) — a vague obligation cannot be audited`);
      }
    }
    for (const word of CODE_PINNED_POST_MERGE_FINALIZATION.enforcementMustMention) {
      if (!isNonEmptyString(finalization.enforcement) || !finalization.enforcement.includes(word)) {
        violations.push(`postMergeFinalization.enforcement must reference "${word}" (the invariant that binds canonical state to git merge history) — a protocol without enforcement is a wish, not a mechanism`);
      }
    }
    const constraints = finalization.constraints;
    if (!isStringArray(constraints) || !CODE_PINNED_POST_MERGE_FINALIZATION.constraintsMustInclude.every((c) => constraints.some((x) => x.includes(c)))) {
      violations.push(`postMergeFinalization.constraints must include [${CODE_PINNED_POST_MERGE_FINALIZATION.constraintsMustInclude.join(', ')}] — the protocol adds no authority, no workflow state, no automation`);
    }
  }

  // --- (9) the program state -------------------------------------------------
  if (program && typeof program === 'object') knownKeys(program, ['$schema', 'schemaVersion', 'artifact', 'protocol', 'asOf', 'governing', 'workOrders', 'resumption', 'decisions'], 'program-state', violations);
  const governing = program.governing;
  if (!governing) {
    violations.push('governing: required');
  } else {
    knownKeys(governing, ['architectureVersion', 'architectureVersionState', 'evolution', 'governingDocuments', 'activeDesignPackage', 'authorityOwners'], 'governing', violations);
    if (!isNonEmptyString(governing.architectureVersion)) violations.push('governing.architectureVersion required');
    if (governing.architectureVersionState !== 'frozen') violations.push('governing.architectureVersionState must be "frozen" (immutable governing version — the fail-closed state)');
    if (!isStringArray(governing.governingDocuments) || governing.governingDocuments.length === 0) violations.push('governing.governingDocuments: non-empty required');
  }

  const orders = program.workOrders ?? [];
  if (!Array.isArray(orders) || orders.length === 0) {
    violations.push('workOrders: non-empty required');
  } else {
    const byId = new Map<string, WorkOrderRecord>();
    for (const w of orders) {
      if (!w || typeof w !== 'object') { violations.push('workOrders: malformed record'); continue; }
      knownKeys(w as unknown as Record<string, unknown>, [
        'id', 'title', 'status', 'dependencies', 'mergedAs', 'branch', 'pr', 'head', 'issue',
        'workOrder', 'origin', 'surfaces', 'surfaceFlags', 'assuranceProfile',
        'runtimeImpactBinding', 'coordination', 'checkpointOutcomes', 'note',
      ], `workOrders[${JSON.stringify(w.id ?? '?')}]`, violations);
      if (!/^WORK-\d{3}$/.test(w.id ?? '')) violations.push(`workOrders: id must match WORK-\\d{3} (${JSON.stringify(w.id)})`);
      if (byId.has(w.id ?? '')) violations.push(`workOrders: duplicate id "${w.id}"`);
      byId.set(w.id ?? '', w);
      if (!isNonEmptyString(w.title)) violations.push(`workOrders[${w.id}]: title required`);
      if (!WORK_ORDER_STATUSES.includes(w.status)) violations.push(`workOrders[${w.id}]: unknown status "${JSON.stringify(w.status)}"`);
      if (!isStringArray(w.dependencies)) violations.push(`workOrders[${w.id}]: dependencies must be a list`);
      if (w.origin !== undefined && !FEEDBACK_ORIGINS.includes(w.origin)) violations.push(`workOrders[${w.id}]: unknown origin "${w.origin}"`);

      // Evidence-backed status transitions.
      if (w.status === 'complete') {
        if (!w.mergedAs || typeof w.mergedAs.pr !== 'number' || w.mergedAs.pr <= 0 || !/^[0-9a-f]{7,40}$/i.test(w.mergedAs.mergeCommit ?? '')) {
          violations.push(`workOrders[${w.id}]: status "complete" REQUIRES merge evidence (pr + mergeCommit) — completion without evidence is exactly the lie this state must not hold`);
        }
      }
      if (w.status === 'in_flight') {
        if (!isNonEmptyString(w.branch)) violations.push(`workOrders[${w.id}]: status "in_flight" REQUIRES a branch`);
        if (w.pr !== undefined && (typeof w.pr !== 'number' || w.pr <= 0)) violations.push(`workOrders[${w.id}]: pr must be a positive number when present`);
      }

      // Assurance coherence for forward (non-complete) items.
      if (w.status !== 'complete') {
        const flags = w.surfaceFlags;
        if (!isStringArray(flags) || flags.length === 0) {
          violations.push(`workOrders[${w.id}]: surfaceFlags required for ${w.status} items`);
        } else {
          for (const f of flags) {
            if (!CHANGE_SURFACE_FLAGS.includes(f as ChangeSurfaceFlag)) violations.push(`workOrders[${w.id}]: unknown surface flag "${f}"`);
          }
          if (model.assuranceProfiles) {
            const expected = selectAssuranceProfile(model, flags as ChangeSurfaceFlag[]);
            if (w.assuranceProfile !== expected) {
              violations.push(`workOrders[${w.id}]: assuranceProfile "${JSON.stringify(w.assuranceProfile)}" does not match the DETERMINISTIC selection for surfaces [${flags.join(', ')}] — expected "${expected}"`);
            }
          }
        }
        if (!w.surfaces || typeof w.surfaces !== 'object') {
          violations.push(`workOrders[${w.id}]: declared change surfaces required for ${w.status} items (parallel-protocol conflict detection)`);
        } else {
          knownKeys(w.surfaces as unknown as Record<string, unknown>, ['modules', 'appLayer', 'migrations', 'reservedMigrations', 'specDocs', 'sharedIntegrationSurfaces'], `workOrders[${w.id}].surfaces`, violations);
          for (const [kind, list] of Object.entries(w.surfaces)) {
            if (list !== undefined && !isStringArray(list)) violations.push(`workOrders[${w.id}].surfaces.${kind}: must be a list of strings`);
          }
        }
        if (w.runtimeImpactBinding !== undefined) {
          const floor = model.assuranceProfiles?.requirements?.[w.assuranceProfile ?? 'LIGHT']?.impactFloor;
          if (!['low', 'medium', 'high'].includes(w.runtimeImpactBinding)) {
            violations.push(`workOrders[${w.id}]: runtimeImpactBinding must be an impact level`);
          } else if (floor && IMPACT_RANK[w.runtimeImpactBinding] < IMPACT_RANK[floor]) {
            violations.push(`workOrders[${w.id}]: runtimeImpactBinding "${w.runtimeImpactBinding}" is BELOW the "${w.assuranceProfile}" profile's impact floor "${floor}" (ADR-0002 coherence)`);
          }
        }
      }

      // Coordination contract (ADR-0003 + the PR #62 round-1 review, BLOCKER 1):
      //   COVERAGE  — an in-flight item with incomplete dependencies must carry
      //               an explicit coordination record covering EVERY incomplete
      //               dependency (coordinating with someone else is not
      //               coordinating with the dependency you started over).
      //   MUTUALITY — a coordination reference to another IN-FLIGHT work order
      //               must be reciprocated on that work order's record:
      //               ONE-SIDED coordination is invalid state, never accepted.
      //   LIVENESS  — a coordination reference to a pending/blocked work order
      //               is incoherent (nothing started to coordinate with).
      //   HISTORY   — references to COMPLETE work orders are durable history
      //               (the coordination happened; the partner has since
      //               merged) and are exempt from mutuality.
      if (w.status === 'in_flight') {
        const declaredIncomplete = (w.dependencies ?? []).filter(
          (d) => orders.some((o) => o.id === d && o.status !== 'complete'),
        );
        const coordination = w.coordination;
        if (declaredIncomplete.length > 0) {
          if (!coordination || !isStringArray(coordination.with) || coordination.with.length === 0 || !isNonEmptyString(coordination.reason)) {
            violations.push(`workOrders[${w.id}]: in_flight while dependencies are incomplete ([${declaredIncomplete.join(', ')}]) REQUIRES an explicit coordination record (with + reason) — uncoordinated parallel starts are exactly what this protocol exists to prevent`);
          } else {
            for (const dep of declaredIncomplete) {
              if (!coordination.with.includes(dep)) {
                violations.push(`workOrders[${w.id}].coordination: incomplete dependency "${dep}" is NOT covered by the coordination record (with: [${coordination.with.join(', ')}]) — a start over an incomplete dependency must coordinate with THAT dependency`);
              }
            }
          }
        }
        if (coordination && isStringArray(coordination.with)) {
          for (const other of coordination.with) {
            const rec = orders.find((o) => o.id === other);
            if (!rec) {
              violations.push(`workOrders[${w.id}].coordination.with: unknown work order "${other}"`);
            } else if (rec.status === 'pending' || rec.status === 'blocked') {
              violations.push(`workOrders[${w.id}].coordination.with: "${other}" is ${rec.status} — coordination references started (in_flight) or merged (complete) work orders only`);
            } else if (rec.status === 'in_flight') {
              const reciprocal = rec.coordination?.with;
              if (!isStringArray(reciprocal) || !reciprocal.includes(w.id)) {
                violations.push(`workOrders[${w.id}].coordination.with: the coordination with "${other}" is ONE-SIDED — "${other}" does not declare coordination with ${w.id} (coordination is mutual or it is not coordination; the PR #62 round-1 review, BLOCKER 1)`);
              }
            }
          }
        }
      }

      // The explicit merge-vs-checkpoint completion rule (the PR #62 round-1
      // review, BLOCKER 3): the architect's MERGE is the ONLY completion
      // event; checkpoint outcomes are implementer claims that support the
      // review but never substitute the merge.
      if (w.status === 'in_flight' && w.mergedAs) {
        violations.push(`workOrders[${w.id}]: status "in_flight" MUST NOT carry merge evidence (mergedAs) — the merge is the completion event; merged-but-in-flight is a lie about the merge (the explicit merge-vs-checkpoint rule)`);
      }
      if ((w.status === 'pending' || w.status === 'blocked') && w.checkpointOutcomes && w.checkpointOutcomes.length > 0) {
        violations.push(`workOrders[${w.id}]: checkpointOutcomes are implementer claims about a STARTED implementation — status "${w.status}" carries none (the explicit merge-vs-checkpoint rule)`);
      }

      for (const outcome of w.checkpointOutcomes ?? []) {
        if (!outcome || typeof outcome !== 'object') { violations.push(`workOrders[${w.id}]: malformed checkpointOutcome`); continue; }
        knownKeys(outcome as unknown as Record<string, unknown>, ['contractId', 'status', 'proofClasses', 'evidenceRef', 'at'], `workOrders[${w.id}].checkpointOutcomes`, violations);
        if (outcome.status !== 'evidenced') violations.push(`workOrders[${w.id}].checkpointOutcomes: status must be "evidenced"`);
        if (!isNonEmptyString(outcome.contractId)) violations.push(`workOrders[${w.id}].checkpointOutcomes: contractId required`);
        if (!isStringArray(outcome.proofClasses) || outcome.proofClasses.length === 0) violations.push(`workOrders[${w.id}].checkpointOutcomes: proofClasses required`);
        if (!isNonEmptyString(outcome.evidenceRef)) violations.push(`workOrders[${w.id}].checkpointOutcomes: evidenceRef required`);
        if (!isNonEmptyString(outcome.at) || Number.isNaN(Date.parse(outcome.at))) violations.push(`workOrders[${w.id}].checkpointOutcomes: at must be an ISO-8601 timestamp`);
      }
    }

    // Unknown dependency references + DAG acyclicity (Kahn).
    for (const w of orders) {
      for (const d of w.dependencies ?? []) {
        if (!byId.has(d)) violations.push(`workOrders[${w.id}]: dependency "${d}" is not a known Work Order`);
      }
    }
    if (violations.length === 0 || orders.every((w) => (w.dependencies ?? []).every((d) => byId.has(d)))) {
      const indegree = new Map<string, number>();
      const dependents = new Map<string, string[]>();
      for (const w of orders) { indegree.set(w.id, (w.dependencies ?? []).length); }
      for (const w of orders) {
        for (const d of w.dependencies ?? []) {
          dependents.set(d, [...(dependents.get(d) ?? []), w.id]);
        }
      }
      const queue = orders.filter((w) => (indegree.get(w.id) ?? 0) === 0).map((w) => w.id);
      let ordered = 0;
      while (queue.length > 0) {
        const n = queue.shift()!;
        ordered++;
        for (const m of dependents.get(n) ?? []) {
          indegree.set(m, (indegree.get(m) ?? 1) - 1);
          if (indegree.get(m) === 0) queue.push(m);
        }
      }
      if (ordered !== orders.length) {
        violations.push(`workOrders: the dependency DAG contains a CYCLE (only ${ordered}/${orders.length} orders topologically sortable) — a cyclic program state can never resolve a frontier`);
      }
    }

    // Handoff records reference in-flight work orders.
    for (const h of program.resumption?.activeHandoffs ?? []) {
      if (!h || typeof h !== 'object') { violations.push('resumption.activeHandoffs: malformed record'); continue; }
      knownKeys(h as unknown as Record<string, unknown>, ['workOrderId', 'lastVerifiedState', 'nextSteps', 'blockers', 'recordedAt', 'recordedBy'], 'resumption.activeHandoffs', violations);
      const rec = byId.get(h.workOrderId ?? '');
      if (!rec) violations.push(`resumption.activeHandoffs: unknown work order "${h.workOrderId}"`);
      else if (rec.status !== 'in_flight') violations.push(`resumption.activeHandoffs: "${h.workOrderId}" is not in_flight (handoffs exist for interrupted active implementations)`);
      if (!isNonEmptyString(h.lastVerifiedState)) violations.push(`resumption.activeHandoffs[${h.workOrderId}]: lastVerifiedState required`);
      if (!isStringArray(h.nextSteps)) violations.push(`resumption.activeHandoffs[${h.workOrderId}]: nextSteps must be a list`);
      if (!isStringArray(h.blockers)) violations.push(`resumption.activeHandoffs[${h.workOrderId}]: blockers must be a list`);
      if (!isNonEmptyString(h.recordedAt) || Number.isNaN(Date.parse(h.recordedAt))) violations.push(`resumption.activeHandoffs[${h.workOrderId}]: recordedAt must be ISO-8601`);
      if (!isNonEmptyString(h.recordedBy)) violations.push(`resumption.activeHandoffs[${h.workOrderId}]: recordedBy required`);
    }
  }

  // --- (10) decisions index --------------------------------------------------
  const decisions = program.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.length === 0) {
    violations.push('decisions: non-empty index required (durable decisions, §34.6)');
  } else {
    const seen = new Set<string>();
    const files = new Set<string>();
    for (const d of decisions) {
      if (!d || typeof d !== 'object') { violations.push('decisions: malformed record'); continue; }
      knownKeys(d as unknown as Record<string, unknown>, ['id', 'kind', 'title', 'file', 'status'], `decisions[${JSON.stringify(d.id ?? '?')}]`, violations);
      if (seen.has(d.id ?? '')) violations.push(`decisions: duplicate id "${d.id}"`);
      seen.add(d.id ?? '');
      if (!['adr', 'design', 'lock', 'spec', 'release'].includes(d.kind ?? '')) violations.push(`decisions[${d.id}]: unknown kind "${JSON.stringify(d.kind)}"`);
      if (!isNonEmptyString(d.title) || !isNonEmptyString(d.file) || !isNonEmptyString(d.status)) violations.push(`decisions[${d.id}]: title, file and status required`);
      files.add(d.file ?? '');
    }
    // Coordination ADR references must be indexed decisions (recoverability).
    for (const w of orders) {
      for (const adr of w.coordination?.adrs ?? []) {
        if (!files.has(adr)) violations.push(`workOrders[${w.id}].coordination.adrs: "${adr}" is not in the decisions index — coordination rationale must be durably recoverable`);
      }
    }
  }

  // --- (11) the work-order identity surface (the 2026-08-29 resolution) -----
  //
  // Exactly ONE canonical artifact per WORK-NNN identity (the architect's
  // PR #74 REQUEST CHANGES verdict: duplicate Work Order identifiers are
  // duplicate authorities — the DUPLICATE-AUTHORITY contract area). The
  // authoritative directory holds ONLY canonical `WORK-NNN.md` files (+
  // TEMPLATE.md); a variant filename claiming a WORK identity, a duplicated
  // identity, or a program record referencing a non-canonical identity
  // artifact is a REJECTING violation. Retired material belongs in
  // `spec/archive/` under a distinct identity and is never authoritative.
  // Runs whenever the caller can list the repository (the control-plane
  // loader and the revision-bound governance-manifest detector both can);
  // a listing FAILURE propagates so callers fail closed (inconclusive,
  // never a vacuous pass).
  if (listDir) {
    const entries = await listDir(AUTHORITATIVE_WORK_ORDER_DIR);
    const seenIdentities = new Map<string, string>(); // WORK-NNN -> filename
    for (const name of entries) {
      if (name === 'TEMPLATE.md') continue;
      const canonical = /^WORK-(\d{3})\.md$/.exec(name);
      if (canonical) {
        const id = `WORK-${canonical[1]}`;
        const prior = seenIdentities.get(id);
        if (prior) {
          violations.push(
            `work-order identity surface: DUPLICATE Work Order identity "${id}" — "${prior}" and "${name}" both claim it ` +
              `(exactly one canonical artifact per identity; duplicate identifiers are duplicate authorities — the 2026-08-29 identity resolution)`,
          );
        } else {
          seenIdentities.set(id, name);
        }
        continue;
      }
      if (/WORK-\d{3}/.test(name)) {
        violations.push(
          `work-order identity surface: "${name}" claims a WORK identity but is not the canonical "WORK-NNN.md" artifact — ` +
            `variant identity artifacts are rejected from ${AUTHORITATIVE_WORK_ORDER_DIR} ` +
            '(retired material belongs in spec/archive/ under a DISTINCT identity; the 2026-08-29 identity resolution)',
        );
      } else {
        violations.push(
          `work-order identity surface: "${name}" is not a canonical "WORK-NNN.md" artifact — ` +
            `only WORK-NNN.md and TEMPLATE.md belong in ${AUTHORITATIVE_WORK_ORDER_DIR} (the authoritative identity surface is closed)`,
        );
      }
    }
    // A program record must reference its OWN canonical artifact — never a
    // variant identity file (e.g. an em-dash upload-wave file).
    for (const w of orders) {
      const spec = w.workOrder;
      if (!spec) continue;
      const base = spec.split('/').pop() ?? spec;
      if (/WORK-\d{3}/.test(base) && !/^WORK-\d{3}\.md$/.test(base)) {
        violations.push(
          `workOrders[${w.id}].workOrder: references the non-canonical identity artifact "${spec}" — ` +
            `a work order record must reference ${AUTHORITATIVE_WORK_ORDER_DIR}/${w.id}.md (a variant identity artifact is never authoritative)`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
