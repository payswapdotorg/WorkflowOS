/**
 * WORK-052 — the default development-governance control-plane service.
 *
 * A PURE, QUERY-ONLY function of the validated repository-resident state
 * (ADR-0001): every control-plane answer is derived deterministically from
 * `governance-model.json` + `program-state.json`. The service holds no
 * repository handles, no database, no mutation ports of any kind — the
 * protocol's writes happen on git branches and become canonical through
 * architect PR merges (ADR-0003).
 *
 * Construction = load + validate (fail closed): a state that does not pass the
 * ONE shared validation engine is never served. Re-constructing the service
 * from the same repository root is the crash/restart/resume semantics — the
 * repository is the recovery state, not any process memory (W052-AC07).
 */

import {
  selectAssuranceProfile,
  type AssuranceProfile,
  type ChangeSurfaceFlag,
  type CheckpointContract,
  type CoordinationRecord,
  type GovernanceModel,
  type HandoffRecord,
  type ImpactLevel,
  type ProgramState,
  type ProofClass,
  type WorkOrderRecord,
  type WorkOrderStatus,
} from '../../architecture-checkpoints/index.js';
import {
  NoResumableStateError,
  UnknownWorkOrderError,
  type AssuranceResolution,
  type DevelopmentGovernanceService,
  type FrontierView,
  type GoverningStateView,
  type ParallelEligibilityReport,
  type PostMergeFinalizationReport,
  type ResumptionView,
  type SharedSurface,
} from '../types.js';
import {
  FileSystemGovernanceStateLoader,
  type FileSystemGovernanceStateLoaderOptions,
} from './governance-state-loader.js';
import {
  auditMergedFinalization,
  collectMergeEvidenceFromRepository,
  MergeEvidenceUnavailableError,
  type MergeEvidence,
} from './merged-finalization.js';

export interface DefaultDevelopmentGovernanceServiceDeps {
  loader: FileSystemGovernanceStateLoader;
}

type SurfaceKind = 'modules' | 'appLayer' | 'migrations' | 'reservedMigrations' | 'specDocs' | 'sharedIntegrationSurfaces';

const SURFACE_KINDS: readonly SurfaceKind[] = [
  'modules',
  'appLayer',
  'migrations',
  'reservedMigrations',
  'specDocs',
  'sharedIntegrationSurfaces',
];

/** Migration reservations participate in conflict detection on equal footing with used migrations. */
function migrationSurfaces(w: WorkOrderRecord): string[] {
  return [...(w.surfaces?.migrations ?? []), ...(w.surfaces?.reservedMigrations ?? [])];
}

/**
 * Two declared spec-document surfaces conflict on equality OR directory
 * containment ('docs/adr/' owns everything beneath it).
 */
function specDocsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const withSlash = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  return a.startsWith(withSlash(b)) || b.startsWith(withSlash(a));
}

/** The shared surfaces between two work-order surface declarations (ADR-0003). */
function sharedSurfacesBetween(a: WorkOrderRecord, b: WorkOrderRecord): SharedSurface[] {
  const shared: SharedSurface[] = [];
  for (const kind of SURFACE_KINDS) {
    if (kind === 'migrations' || kind === 'reservedMigrations') continue; // handled normalized below
    const listA = a.surfaces?.[kind] ?? [];
    const listB = b.surfaces?.[kind] ?? [];
    for (const va of listA) {
      for (const vb of listB) {
        if (kind === 'specDocs' ? specDocsConflict(va, vb) : va === vb) {
          shared.push({ kind, value: va });
        }
      }
    }
  }
  const migA = migrationSurfaces(a);
  const migB = migrationSurfaces(b);
  for (const m of migA) {
    if (migB.includes(m)) shared.push({ kind: 'migrations', value: m });
  }
  return shared;
}

/** Mutual coordination: each record references the other in its coordination.with. */
function mutuallyCoordinated(a: WorkOrderRecord, b: WorkOrderRecord): boolean {
  const aRefsB = (a.coordination?.with ?? []).includes(b.id);
  const bRefsA = (b.coordination?.with ?? []).includes(a.id);
  return aRefsB && bRefsA;
}

export class DefaultDevelopmentGovernanceService implements DevelopmentGovernanceService {
  private readonly model: GovernanceModel;
  private readonly program: ProgramState;
  private readonly byId: Map<string, WorkOrderRecord>;
  private readonly repoRoot: string | null;

  private constructor(model: GovernanceModel, program: ProgramState, repoRoot: string | null) {
    this.model = model;
    this.program = program;
    this.byId = new Map(program.workOrders.map((w) => [w.id, w]));
    this.repoRoot = repoRoot;
  }

  /**
   * Load + validate the repository-resident state (fail closed) and construct
   * the service. This is ALSO the crash/restart entry point: a fresh instance
   * from the same repository root reconstructs the entire control-plane view
   * from repository state alone.
   */
  static async create(
    options: FileSystemGovernanceStateLoaderOptions,
  ): Promise<DefaultDevelopmentGovernanceService> {
    const loader = new FileSystemGovernanceStateLoader(options);
    const loaded = await loader.load();
    return new DefaultDevelopmentGovernanceService(loaded.model, loaded.program, loaded.repoRoot);
  }

  /** Construct over already-loaded (validated) state — tests and compositions. */
  static fromLoadedState(model: GovernanceModel, program: ProgramState): DefaultDevelopmentGovernanceService {
    return new DefaultDevelopmentGovernanceService(model, program, null);
  }

  // --- control question 1 + 6: the governing state -------------------------

  getGoverningState(): GoverningStateView {
    const g = this.program.governing;
    return {
      architectureVersion: g.architectureVersion,
      architectureVersionState: g.architectureVersionState,
      evolution: g.evolution,
      governingDocuments: g.governingDocuments,
      activeDesignPackage: g.activeDesignPackage,
      controlLoop: this.model.engineeringControlLoop.stages,
      selfHostingBoundary: this.model.selfHostingBoundary,
      authorityMap: this.model.authorityMap,
      parallelProtocolRules: this.model.parallelProtocol.rules,
      feedbackOrigins: this.model.feedbackOrigins,
      decisions: this.program.decisions,
    };
  }

  // --- control questions 2 + 3: work orders and statuses ---------------------

  listWorkOrders(filter?: { status?: WorkOrderStatus }): readonly WorkOrderRecord[] {
    const all = [...this.program.workOrders].sort((a, b) => a.id.localeCompare(b.id));
    if (!filter?.status) return all;
    return all.filter((w) => w.status === filter.status);
  }

  getWorkOrder(workOrderId: string): WorkOrderRecord {
    const w = this.byId.get(workOrderId);
    if (!w) throw new UnknownWorkOrderError(workOrderId);
    return w;
  }

  // --- control question 4: the frontier + parallel eligibility --------------

  private incompleteDependencies(w: WorkOrderRecord): string[] {
    return (w.dependencies ?? []).filter((d) => this.byId.get(d)?.status !== 'complete');
  }

  private inFlightConflicts(w: WorkOrderRecord): Array<{ with: string; sharedSurfaces: readonly SharedSurface[]; coordinated: boolean }> {
    const conflicts: Array<{ with: string; sharedSurfaces: readonly SharedSurface[]; coordinated: boolean }> = [];
    for (const other of this.program.workOrders) {
      if (other.id === w.id || other.status !== 'in_flight') continue;
      const shared = sharedSurfacesBetween(w, other);
      if (shared.length > 0) {
        conflicts.push({ with: other.id, sharedSurfaces: shared, coordinated: mutuallyCoordinated(w, other) });
      }
    }
    return conflicts;
  }

  getFrontier(): FrontierView {
    const inFlight = this.listWorkOrders({ status: 'in_flight' }).map((w) => {
      const incomplete = this.incompleteDependencies(w);
      const conflicts = this.inFlightConflicts(w);
      // TRUTHFUL coordination (the PR #62 round-1 review, BLOCKER 2): an item
      // is coordinated ONLY when EVERY reported in-flight conflict is MUTUALLY
      // coordinated AND every incomplete dependency is covered by mutual
      // coordination — never the mere presence of a coordination record.
      // (Within validated state the coverage/mutuality invariants are already
      // enforced; this computes the fact from the record, not the assumption.)
      const depsCoordinated = incomplete.every((d) => {
        const dep = this.byId.get(d);
        return (
          (w.coordination?.with ?? []).includes(d) &&
          (dep?.coordination?.with ?? []).includes(w.id)
        );
      });
      const coordinated = conflicts.every((c) => c.coordinated) && depsCoordinated;
      return {
        id: w.id,
        title: w.title,
        branch: w.branch ?? '',
        pr: w.pr ?? null,
        head: w.head ?? null,
        assuranceProfile: w.assuranceProfile ?? this.profileFor(w),
        coordinated,
        incompleteDependencies: incomplete,
        conflicts,
      };
    });

    const dependencyEligible = this.listWorkOrders({ status: 'pending' })
      .filter((w) => this.incompleteDependencies(w).length === 0)
      .map((w) => ({ id: w.id, title: w.title, assuranceProfile: w.assuranceProfile ?? this.profileFor(w) }));

    const blocked = this.program.workOrders
      .filter((w) => w.status !== 'complete' && w.status !== 'in_flight')
      // Dependency-eligible pending items are the FRONTIER, not blocked.
      .filter((w) => this.incompleteDependencies(w).length > 0 || w.status === 'blocked')
      .map((w) => ({ id: w.id, title: w.title, blockedBy: this.incompleteDependencies(w) }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const complete = this.listWorkOrders({ status: 'complete' }).map((w) => w.id);
    return { inFlight, dependencyEligible, blocked, complete };
  }

  evaluateParallelEligibility(candidateIds?: readonly string[]): ParallelEligibilityReport {
    const candidates = (candidateIds ?? this.program.workOrders.filter((w) => w.status !== 'complete').map((w) => w.id))
      .map((id) => this.getWorkOrder(id));
    const inFlight = this.listWorkOrders({ status: 'in_flight' });

    // Conflict partners: every other active item (in-flight OR a co-candidate).
    const active = new Map<string, WorkOrderRecord>();
    for (const w of [...inFlight, ...candidates]) {
      if (w.status !== 'complete') active.set(w.id, w);
    }

    const assessments = candidates.map((w) => {
      const unsatisfied = this.incompleteDependencies(w);
      const conflictsWith = [...active.values()]
        .filter((other) => other.id !== w.id)
        .map((other) => ({ other, shared: sharedSurfacesBetween(w, other) }))
        .filter(({ shared }) => shared.length > 0)
        .map(({ other, shared }) => ({
          workOrderId: other.id,
          partnerStatus: other.status,
          sharedSurfaces: shared,
          coordinated: mutuallyCoordinated(w, other),
        }));
      return {
        workOrderId: w.id,
        dependencyEligible: unsatisfied.length === 0,
        unsatisfiedDependencies: unsatisfied,
        conflictsWith,
      };
    });

    const pairwise = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!;
        const b = candidates[j]!;
        const shared = sharedSurfacesBetween(a, b);
        pairwise.push({
          a: a.id,
          b: b.id,
          parallelSafe: shared.length === 0,
          sharedSurfaces: shared,
          coordinated: mutuallyCoordinated(a, b),
        });
      }
    }

    return { assessments, pairwise };
  }

  // --- control question 5: assurance resolution ------------------------------

  private profileFor(w: WorkOrderRecord): AssuranceProfile {
    if (w.surfaceFlags && w.surfaceFlags.length > 0) {
      return selectAssuranceProfile(this.model, w.surfaceFlags);
    }
    if (w.assuranceProfile) return w.assuranceProfile;
    // Fail-closed floor: unclassified work derives the strictest default.
    return selectAssuranceProfile(this.model, []);
  }

  private requirementsFor(profile: AssuranceProfile) {
    return this.model.assuranceProfiles.requirements[profile];
  }

  private contractApplicability(profile: AssuranceProfile): AssuranceResolution['applicableContracts'] {
    const requiredProofs = this.requirementsFor(profile).proofClasses as readonly ProofClass[];
    return this.model.checkpointContracts
      .map((c: CheckpointContract) => ({
        contractId: c.id,
        area: c.area,
        severity: c.severity,
        requiredProofClasses: c.proofClasses.filter((p) => requiredProofs.includes(p)),
      }))
      .filter((entry) => entry.requiredProofClasses.length > 0);
  }

  resolveAssurance(workOrderId: string): AssuranceResolution {
    const w = this.getWorkOrder(workOrderId);
    const flags = (w.surfaceFlags ?? []) as readonly ChangeSurfaceFlag[];
    const profile = this.profileFor(w);
    const req = this.requirementsFor(profile);
    return {
      workOrderId: w.id,
      profile,
      selectedFromSurfaces: flags,
      requiredCheckpointKinds: req.checkpointKinds,
      requiredProofClasses: req.proofClasses,
      requiredEvidence: req.evidence,
      architectReviewRecord: req.architectReviewRecord,
      impactFloor: req.impactFloor,
      runtimeImpactBinding: (w.runtimeImpactBinding as ImpactLevel | undefined) ?? null,
      applicableContracts: this.contractApplicability(profile),
    };
  }

  getCheckpointApplicability(profile: AssuranceProfile): AssuranceResolution['applicableContracts'] {
    return this.contractApplicability(profile);
  }

  // --- control question 7: crash/restart/resume -------------------------------

  resumeImplementation(workOrderId: string): ResumptionView {
    const w = this.getWorkOrder(workOrderId);
    const handoff = this.program.resumption.activeHandoffs.find(
      (h: HandoffRecord) => h.workOrderId === workOrderId,
    );
    if (!handoff) throw new NoResumableStateError(workOrderId);
    return {
      workOrderId: w.id,
      title: w.title,
      status: w.status,
      branch: w.branch ?? null,
      pr: w.pr ?? null,
      workOrderRef: w.workOrder ?? null,
      dependencies: (w.dependencies ?? []).map((d) => {
        const dep = this.byId.get(d);
        return { id: d, title: dep?.title ?? d, status: (dep?.status ?? 'pending') as WorkOrderStatus };
      }),
      assurance: this.resolveAssurance(workOrderId),
      handoff,
      coordination: (w.coordination as CoordinationRecord | undefined) ?? null,
      checkpointOutcomes: w.checkpointOutcomes ?? [],
      parallelProtocolRules: this.model.parallelProtocol.rules,
      governingDocuments: this.program.governing.governingDocuments,
      decisions: this.program.decisions,
    };
  }

  // --- the post-merge finalization audit (§34.8; ADR-0007) --------------------

  verifyPostMergeFinalization(evidence?: MergeEvidence): PostMergeFinalizationReport {
    const explicit = evidence !== undefined;
    const used = evidence ?? (this.repoRoot !== null ? collectMergeEvidenceFromRepository(this.repoRoot) : undefined);
    if (!used) {
      throw new MergeEvidenceUnavailableError(
        'no repository root is bound to this service instance — construct via create(repoRoot) or pass explicit merge evidence',
      );
    }
    const audit = auditMergedFinalization(this.program, used);
    return {
      merged: audit.mergedWorkOrderIds.length,
      finalized: audit.mergedWorkOrderIds.length - audit.gaps.length,
      gaps: audit.gaps,
      evidenceSource: explicit
        ? 'explicit merge evidence'
        : `the first-parent merge history of ${this.repoRoot}/origin/main`,
    };
  }
}
