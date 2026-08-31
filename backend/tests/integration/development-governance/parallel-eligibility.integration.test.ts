import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMPACT_CHECKPOINT_MATRIX } from '../../../src/architecture-checkpoints/index.js';
import {
  DefaultDevelopmentGovernanceService,
  FileSystemGovernanceStateLoader,
} from '../../../src/development-governance/index.js';
import type {
  GovernanceModel,
  ProgramState,
  WorkOrderRecord,
} from '../../../src/development-governance/index.js';

/**
 * WORK-052 — the parallel implementation protocol (ADR-0003) and the adaptive
 * assurance profiles (ADR-0002), as DETERMINISTIC functions of the declared
 * repository-resident state:
 *
 *   W052-AC03 — two genuinely independent items are concurrently executable;
 *               a dependent item is rejected; shared migration/authority
 *               conflicts are detected.
 *   W052-AC04 — simple → LIGHT, ordinary → STANDARD, complex → HIGH_ASSURANCE,
 *               critical → CRITICAL; the profile deterministically alters the
 *               required checkpoints/proofs/evidence; dominance over the
 *               WORK-051 impact matrix is preserved.
 */
describe('WORK-052 — parallel eligibility, conflicts, and assurance selection', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');

  let model: GovernanceModel;
  let realProgram: ProgramState;
  let realService: DefaultDevelopmentGovernanceService;

  beforeAll(async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).load();
    model = loaded.model;
    realProgram = loaded.program;
    realService = DefaultDevelopmentGovernanceService.fromLoadedState(model, realProgram);
  });

  // --- fixture work orders over the REAL governance model ----------------------

  const wo = (overrides: Partial<WorkOrderRecord> & Pick<WorkOrderRecord, 'id' | 'status'>): WorkOrderRecord => ({
    title: `fixture ${overrides.id}`,
    dependencies: [],
    surfaces: { modules: [], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
    surfaceFlags: ['documentation'],
    assuranceProfile: 'LIGHT',
    ...overrides,
  });

  const serviceWith = (workOrders: WorkOrderRecord[]): DefaultDevelopmentGovernanceService =>
    DefaultDevelopmentGovernanceService.fromLoadedState(model, {
      ...realProgram,
      workOrders: [...realProgram.workOrders, ...workOrders],
    });

  // --- W052-AC03: parallel eligibility + conflicts -------------------------------

  it('W052-AC03 — two genuinely independent Work Items are recognized as concurrently executable', () => {
    const service = serviceWith([
      wo({ id: 'WORK-901', status: 'pending', dependencies: [], surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT' }),
      wo({ id: 'WORK-902', status: 'pending', dependencies: [], surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT' }),
    ]);
    const report = service.evaluateParallelEligibility(['WORK-901', 'WORK-902']);
    for (const a of report.assessments) {
      expect(a.dependencyEligible, `${a.workOrderId} has no dependencies`).toBe(true);
      expect(a.unsatisfiedDependencies).toEqual([]);
      expect(a.conflictsWith).toEqual([]);
    }
    const pair = report.pairwise.find((p) => (p.a === 'WORK-901' && p.b === 'WORK-902') || (p.a === 'WORK-902' && p.b === 'WORK-901'));
    expect(pair).toBeTruthy();
    expect(pair!.parallelSafe, 'disjoint surfaces + independent deps ⇒ concurrently executable').toBe(true);
    expect(pair!.sharedSurfaces).toEqual([]);
  });

  it('W052-AC03 — a Work Item with an unsatisfied dependency is REJECTED from parallel execution', () => {
    const service = serviceWith([
      wo({ id: 'WORK-903', status: 'in_flight', branch: 'feat/x', surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT' }),
      wo({ id: 'WORK-904', status: 'pending', dependencies: ['WORK-903'], surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT' }),
    ]);
    const report = service.evaluateParallelEligibility(['WORK-903', 'WORK-904']);
    const dependent = report.assessments.find((a) => a.workOrderId === 'WORK-904')!;
    expect(dependent.dependencyEligible).toBe(false);
    expect(dependent.unsatisfiedDependencies).toEqual(['WORK-903']);
    // Even though they are surface-disjoint, the dependency makes the pair
    // non-parallel: the frontier rule gates the dependent item.
    expect(service.getFrontier().dependencyEligible.map((w) => w.id)).not.toContain('WORK-904');
    const blocked = service.getFrontier().blocked.find((w) => w.id === 'WORK-904');
    expect(blocked?.blockedBy).toEqual(['WORK-903']);
  });

  it('W052-AC03 — shared migration surfaces are detected as a conflict', () => {
    const service = serviceWith([
      wo({
        id: 'WORK-905', status: 'in_flight', branch: 'feat/a',
        surfaces: { modules: ['agents'], appLayer: [], migrations: ['0058'], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['schema'], assuranceProfile: 'CRITICAL',
      }),
      wo({
        id: 'WORK-906', status: 'in_flight', branch: 'feat/b',
        surfaces: { modules: ['reviews'], appLayer: [], migrations: ['0058'], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['schema'], assuranceProfile: 'CRITICAL',
      }),
    ]);
    const pair = service.evaluateParallelEligibility(['WORK-905', 'WORK-906']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.sharedSurfaces).toEqual([{ kind: 'migrations', value: '0058' }]);
    expect(pair.coordinated, 'no coordination record was declared').toBe(false);
  });

  it('W052-AC03 — reserved migration numbers participate in conflict detection (the 0057 lesson)', () => {
    const service = serviceWith([
      wo({
        id: 'WORK-907', status: 'in_flight', branch: 'feat/c',
        surfaces: { modules: [], appLayer: [], migrations: ['0059'], reservedMigrations: ['0060'], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['schema'], assuranceProfile: 'CRITICAL',
      }),
      wo({
        id: 'WORK-908', status: 'pending',
        surfaces: { modules: [], appLayer: [], migrations: [], reservedMigrations: ['0060'], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['schema'], assuranceProfile: 'CRITICAL',
      }),
    ]);
    const pair = service.evaluateParallelEligibility(['WORK-907', 'WORK-908']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.sharedSurfaces).toContainEqual({ kind: 'migrations', value: '0060' });
  });

  it('W052-AC03 — shared authority surfaces are detected as a conflict', () => {
    const service = serviceWith([
      wo({
        id: 'WORK-909', status: 'in_flight', branch: 'feat/d',
        surfaces: { modules: ['workflows'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['authorityBoundary'], assuranceProfile: 'CRITICAL',
      }),
      wo({
        id: 'WORK-910', status: 'pending',
        surfaces: { modules: ['workflows', 'verification'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['authorityBoundary'], assuranceProfile: 'CRITICAL',
      }),
    ]);
    const pair = service.evaluateParallelEligibility(['WORK-909', 'WORK-910']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.sharedSurfaces).toEqual([{ kind: 'modules', value: 'workflows' }]);
  });

  it('W052-AC03 — shared spec documents conflict (including directory containment: docs/adr/ owns what is beneath it)', () => {
    const service = serviceWith([
      wo({
        id: 'WORK-911', status: 'in_flight', branch: 'feat/e',
        surfaces: { modules: [], appLayer: [], migrations: [], reservedMigrations: [], specDocs: ['docs/adr/'], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT',
      }),
      wo({
        id: 'WORK-912', status: 'pending',
        surfaces: { modules: [], appLayer: [], migrations: [], reservedMigrations: [], specDocs: ['docs/adr/ADR-0007-x.md'], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['documentation'], assuranceProfile: 'LIGHT',
      }),
    ]);
    const pair = service.evaluateParallelEligibility(['WORK-911', 'WORK-912']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.sharedSurfaces.length).toBeGreaterThan(0);
  });

  it('W052-AC03 — the real program state: the historical WORK-046/WORK-052 shared-surface coordination is DURABLE HISTORY (both merged — no active conflict; the pairwise view still reports the shared surface + the mutual coordination)', () => {
    // WORK-046 merged as 1f2bef9 and WORK-052 as 47615c2: both are complete,
    // so the frontier reports NO active in-flight conflict. The coordination
    // records on both records are durable history (the conflict happened and
    // was mutually coordinated), and the pairwise view still reports the
    // shared surface with coordinated: true.
    const report = realService.evaluateParallelEligibility(['WORK-046', 'WORK-052']);
    const pair = report.pairwise[0]!;
    expect(pair.parallelSafe).toBe(false); // the shared static-architecture suite is still a FACT
    expect(pair.sharedSurfaces.some((s) => s.value.includes('static-architecture.test.ts'))).toBe(true);
    expect(pair.coordinated, 'the coordination is declared on BOTH records (durable history)').toBe(true);
    // Both merged items have ALL dependencies satisfied (complete).
    const a046 = report.assessments.find((a) => a.workOrderId === 'WORK-046')!;
    const a052 = report.assessments.find((a) => a.workOrderId === 'WORK-052')!;
    expect(a046.dependencyEligible).toBe(true);
    expect(a052.dependencyEligible).toBe(true);
    // Evaluating the merged pair as candidates surfaces the ONE live
    // in-flight conflict partner: WORK-067 (Engineering Signal &
    // Regression Correlation — activated 2026-09-01 on
    // feat/WORK-067-signal-regression-correlation, the ADR-0003
    // coordination partner of the former parallel WORK-066, grown from the
    // SAME main 5f0b058; this branch is rebased onto the post-#102 AND
    // post-#104 mainlines) shares the static-architecture suite surface
    // with WORK-046 and WORK-052 — the SAME durable-history surface
    // pattern WORK-064/065/066/071/074 each shared while in flight
    // (WORK-066 was the prior live partner, merged as 0a506b1 via PR #102
    // and finalized by the WORK-066 post-merge finalization PR #104;
    // WORK-065 merged as 5de5e83 via PR #97 and finalized by the WORK-065
    // post-merge finalization; WORK-064 merged c351451 via PR #86, WORK-050
    // merged 8f27cc7, WORK-062 merged f0855d2 via PR #82, WORK-071 merged
    // 8604c8a5 via PR #96, and WORK-074 merged cdedd0ca via PR #99 — all
    // merged items are durable history). The frontier is the authoritative
    // live view: the ONE in-flight item is WORK-067 (it declares the
    // static-architecture suite in sharedIntegrationSurfaces, so the
    // surface flag discipline holds for the live pair).
    expect(a046.conflictsWith.map((c) => c.workOrderId)).toEqual(['WORK-067']);
    expect(a052.conflictsWith.map((c) => c.workOrderId)).toEqual(['WORK-067']);
    const frontier = realService.getFrontier();
    expect(frontier.inFlight.map((w) => w.id)).toEqual(['WORK-067']);
  });

  it('W052-AC03 / PR #62 round 1 BLOCKER 2 — the frontier reports TRUTHFUL coordination (an UNDECLARED in-flight conflict is coordinated: false, never a silent pass)', () => {
    // Two in-flight items sharing modules:agents with NO coordination records
    // at all: the frontier must report the conflict AND coordinated: false.
    const service = serviceWith([
      wo({
        id: 'WORK-960', status: 'in_flight', branch: 'feat/und-a',
        surfaces: { modules: ['fixture-domain-a'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
      }),
      wo({
        id: 'WORK-961', status: 'in_flight', branch: 'feat/und-b',
        surfaces: { modules: ['fixture-domain-a'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
      }),
    ]);
    const frontier = service.getFrontier();
    const a = frontier.inFlight.find((w) => w.id === 'WORK-960')!;
    const b = frontier.inFlight.find((w) => w.id === 'WORK-961')!;
    expect(a.conflicts.map((c) => c.with)).toEqual(['WORK-961']);
    expect(a.conflicts[0]!.coordinated).toBe(false);
    expect(b.conflicts[0]!.coordinated).toBe(false);
    // The item-level flag is FALSE for both — the mere presence of (no)
    // coordination records can never produce a TRUE here.
    expect(a.coordinated).toBe(false);
    expect(b.coordinated).toBe(false);
    // And the pairwise view agrees.
    const pair = service.evaluateParallelEligibility(['WORK-960', 'WORK-961']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.coordinated).toBe(false);
  });

  it('W052-AC03 / PR #62 round 1 BLOCKER 2 — a MUTUALLY declared coordination flips the frontier flags to true (the same fixture + mutual records)', () => {
    const service = serviceWith([
      wo({
        id: 'WORK-962', status: 'in_flight', branch: 'feat/dec-a',
        surfaces: { modules: ['fixture-domain-b'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
        coordination: { with: ['WORK-963'], reason: 'serialized merge order over the shared module', adrs: [] },
      }),
      wo({
        id: 'WORK-963', status: 'in_flight', branch: 'feat/dec-b',
        surfaces: { modules: ['fixture-domain-b'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
        coordination: { with: ['WORK-962'], reason: 'serialized merge order over the shared module', adrs: [] },
      }),
    ]);
    const frontier = service.getFrontier();
    const a = frontier.inFlight.find((w) => w.id === 'WORK-962')!;
    const b = frontier.inFlight.find((w) => w.id === 'WORK-963')!;
    expect(a.conflicts[0]!.coordinated).toBe(true);
    expect(b.conflicts[0]!.coordinated).toBe(true);
    expect(a.coordinated).toBe(true);
    expect(b.coordinated).toBe(true);
    // Still parallelSafe: false — the shared surface is a fact; coordination
    // documents the resolution, it does not erase the conflict.
    const pair = service.evaluateParallelEligibility(['WORK-962', 'WORK-963']).pairwise[0]!;
    expect(pair.parallelSafe).toBe(false);
    expect(pair.coordinated).toBe(true);
  });

  it('W052-AC03 / PR #62 round 1 BLOCKER 2 — the frontier dependency-coordination flag is truthful (an in-flight start over an incomplete, UNCOVERED dependency reports coordinated: false)', () => {
    // Fixture built via fromLoadedState (the validator would reject the
    // uncovered start — proven separately); the frontier must still REPORT
    // the truth rather than assuming coordination.
    const service = serviceWith([
      wo({
        id: 'WORK-964', status: 'in_flight', branch: 'feat/unc',
        dependencies: ['WORK-965'],
        surfaces: { modules: ['notifications'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
        coordination: { with: ['WORK-966'], reason: 'coordinated with the wrong partner — does not cover the incomplete dependency', adrs: [] },
      }),
      wo({
        id: 'WORK-965', status: 'pending',
        surfaces: { modules: ['benchmark'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
      }),
      wo({
        id: 'WORK-966', status: 'in_flight', branch: 'feat/wrong',
        surfaces: { modules: ['runtime'], appLayer: [], migrations: [], reservedMigrations: [], specDocs: [], sharedIntegrationSurfaces: [] },
        surfaceFlags: ['moduleInternals'], assuranceProfile: 'STANDARD',
        coordination: { with: ['WORK-964'], reason: 'mutual with the wrong partner', adrs: [] },
      }),
    ]);
    const frontier = service.getFrontier();
    const item = frontier.inFlight.find((w) => w.id === 'WORK-964')!;
    expect(item.incompleteDependencies).toEqual(['WORK-965']);
    expect(item.coordinated, 'an in-flight start over an uncovered incomplete dependency is NOT coordinated').toBe(false);
  });

  // --- W052-AC04: deterministic assurance selection ------------------------------

  it('W052-AC04 — simple → LIGHT, ordinary → STANDARD, complex → HIGH_ASSURANCE, critical → CRITICAL (deterministic)', () => {
    const cases: Array<{ id: string; flags: WorkOrderRecord['surfaceFlags']; expected: string }> = [
      { id: 'WORK-920', flags: ['documentation'], expected: 'LIGHT' },
      { id: 'WORK-921', flags: ['localBehavior'], expected: 'LIGHT' },
      { id: 'WORK-922', flags: ['moduleInternals'], expected: 'STANDARD' },
      { id: 'WORK-923', flags: ['multiModule'], expected: 'STANDARD' },
      { id: 'WORK-924', flags: ['publicContracts'], expected: 'HIGH_ASSURANCE' },
      { id: 'WORK-925', flags: ['concurrency'], expected: 'HIGH_ASSURANCE' },
      { id: 'WORK-926', flags: ['externalSideEffects'], expected: 'HIGH_ASSURANCE' },
      { id: 'WORK-927', flags: ['schema'], expected: 'CRITICAL' },
      { id: 'WORK-928', flags: ['authorityBoundary'], expected: 'CRITICAL' },
      { id: 'WORK-929', flags: ['securityTenant'], expected: 'CRITICAL' },
      // Mixed surfaces: the MOST severe surface wins (first-match, most severe first).
      { id: 'WORK-930', flags: ['documentation', 'schema'], expected: 'CRITICAL' },
      { id: 'WORK-931', flags: ['documentation', 'publicContracts'], expected: 'HIGH_ASSURANCE' },
      { id: 'WORK-932', flags: ['localBehavior', 'multiModule'], expected: 'STANDARD' },
    ];
    const service = serviceWith(
      cases.map((c) => wo({
        id: c.id,
        status: 'pending',
        surfaceFlags: c.flags,
        assuranceProfile: c.expected as WorkOrderRecord['assuranceProfile'],
      })),
    );
    for (const c of cases) {
      expect(service.resolveAssurance(c.id).profile, `${c.id} surfaces [${c.flags?.join(', ')}]`).toBe(c.expected);
    }
  });

  it('W052-AC04 — the same surfaces ALWAYS select the same profile (pure function, repeated resolution)', () => {
    const service = serviceWith([
      wo({ id: 'WORK-933', status: 'pending', surfaceFlags: ['moduleInternals', 'multiModule'], assuranceProfile: 'STANDARD' }),
    ]);
    const first = service.resolveAssurance('WORK-933');
    const second = service.resolveAssurance('WORK-933');
    const third = service.resolveAssurance('WORK-933');
    expect(first.profile).toBe('STANDARD');
    expect(second.profile).toBe(first.profile);
    expect(third.profile).toBe(first.profile);
    expect(first.requiredCheckpointKinds).toEqual(second.requiredCheckpointKinds);
    expect(first.requiredProofClasses).toEqual(third.requiredProofClasses);
  });

  it('W052-AC04 — the selected profile deterministically alters checkpoint/evidence requirements', () => {
    const light = realService.resolveAssurance('WORK-048'); // STANDARD-class item? resolve by its flags
    void light;
    // Direct per-profile requirement comparison through the service.
    const profiles = ['LIGHT', 'STANDARD', 'HIGH_ASSURANCE', 'CRITICAL'] as const;
    const requirements = profiles.map((p) => ({
      profile: p,
      contracts: realService.getCheckpointApplicability(p),
      resolution: (() => {
        const service = serviceWith([
          wo({
            id: `WORK-94${profiles.indexOf(p)}`,
            status: 'pending',
            surfaceFlags: p === 'LIGHT' ? ['documentation']
              : p === 'STANDARD' ? ['moduleInternals']
              : p === 'HIGH_ASSURANCE' ? ['publicContracts']
              : ['authorityBoundary'],
            assuranceProfile: p,
          }),
        ]);
        return service.resolveAssurance(`WORK-94${profiles.indexOf(p)}`);
      })(),
    }));
    // Checkpoint kinds monotonically expand with depth.
    expect(requirements[0]!.resolution.requiredCheckpointKinds).toEqual(['pr_conformance']);
    expect(requirements[1]!.resolution.requiredCheckpointKinds).toEqual(['work_order', 'pr_conformance']);
    expect(requirements[2]!.resolution.requiredCheckpointKinds).toEqual([
      'readiness', 'work_order', 'pr_conformance', 'verification_entry',
    ]);
    expect(requirements[3]!.resolution.requiredCheckpointKinds).toEqual([
      'readiness', 'work_order', 'pr_conformance', 'verification_entry',
    ]);
    // Proof classes expand; only CRITICAL demands the architect review record.
    expect(requirements[0]!.resolution.requiredProofClasses).toEqual(['static']);
    expect(requirements[1]!.resolution.requiredProofClasses).toEqual(['static', 'dynamic']);
    expect(requirements[2]!.resolution.requiredProofClasses).toEqual(['static', 'dynamic', 'discrimination']);
    expect(requirements[3]!.resolution.requiredProofClasses).toEqual(['static', 'dynamic', 'discrimination']);
    expect(requirements[0]!.resolution.architectReviewRecord).toBe(false);
    expect(requirements[3]!.resolution.architectReviewRecord).toBe(true);
    // Applicable contracts grow with depth: LIGHT < STANDARD < HIGH_ASSURANCE/CRITICAL.
    expect(requirements[0]!.contracts.length).toBeLessThan(requirements[1]!.contracts.length);
    expect(requirements[1]!.contracts.length).toBeLessThanOrEqual(requirements[2]!.contracts.length);
    expect(requirements[2]!.contracts.length).toBe(requirements[3]!.contracts.length);
    // Evidence requirements grow monotonically.
    expect(requirements[0]!.resolution.requiredEvidence.length).toBeLessThan(requirements[3]!.resolution.requiredEvidence.length);
    // CRITICAL demands the architect-review-record evidence by name.
    expect(requirements[3]!.resolution.requiredEvidence).toContain('architect-review-record');
  });

  it('W052-AC04 — profile requirements DOMINATE the WORK-051 impact/checkpoint matrix (assurance adds depth, never subtracts)', () => {
    // For every profile, at every impact level it covers, every checkpoint
    // kind the LIVE matrix applies there must be required by the profile.
    for (const profile of ['LIGHT', 'STANDARD', 'HIGH_ASSURANCE', 'CRITICAL'] as const) {
      const req = model.assuranceProfiles.requirements[profile];
      for (const level of req.impactCoverage) {
        for (const [kind, levels] of Object.entries(IMPACT_CHECKPOINT_MATRIX)) {
          if ((levels as readonly string[]).includes(level)) {
            expect(
              req.checkpointKinds,
              `${profile} covers impact ${level}; matrix kind ${kind} applies there and must be required`,
            ).toContain(kind);
          }
        }
      }
      // Coherence: the impact floor is at least the level the matrix's
      // heaviest covered kind applies at.
      expect(['low', 'medium', 'high']).toContain(req.impactFloor);
    }
    // The impact-floor coherence is enforced by the validation engine on the
    // real state: WORK-052 (CRITICAL) binds runtime impact high.
    const real = realService.resolveAssurance('WORK-052');
    expect(real.impactFloor).toBe('high');
    expect(real.runtimeImpactBinding).toBe('high');
  });

  it('W052-AC04 — unknown/unclassified surfaces fail closed to the HIGH_ASSURANCE floor', async () => {
    const { selectAssuranceProfile } = await import('../../../src/architecture-checkpoints/index.js');
    // No declared surfaces: the fail-closed default (HIGH_ASSURANCE in the canonical model).
    expect(selectAssuranceProfile(model, [])).toBe('HIGH_ASSURANCE');
    // The model's declared default IS the strict floor.
    expect(model.assuranceProfiles.selection.unclassifiedDefault).toBe('HIGH_ASSURANCE');
    // A record with no surfaceFlags resolves through the same floor.
    const service = serviceWith([wo({ id: 'WORK-940', status: 'pending', surfaceFlags: undefined, assuranceProfile: undefined })]);
    expect(service.resolveAssurance('WORK-940').profile).toBe('HIGH_ASSURANCE');
  });

  // --- the real frontier (W052-AC03 applied to the live program) -----------------

  it('W052-AC03 — the REAL frontier: 58 recorded items complete (WORK-074/WORK-071/WORK-065 all COMPLETE since their merges); WORK-067 is the ONE in-flight item; nothing is blocked', () => {
    const frontier = realService.getFrontier();
    expect(frontier.dependencyEligible).toEqual([]);
    // WORK-064 (Continuous Product Validation — the domain/model authority)
    // was ACTIVATED by the architect on 2026-08-30 (the implementation
    // instruction after the approved plan merged as 4018f42), implemented on
    // branch feat/work-064-continuous-validation (PR #86), MERGED by the
    // architect as c351451 on 2026-08-30 (squash-merged at the approved head
    // 524c3f4) and FINALIZED complete per §34.8/ADR-0007. WORK-071 (Local
    // Development Runtime Substrate) was MERGED into main as 8604c8a5 by the
    // architect via PR #96 (2026-08-31) and is recorded complete with its
    // merge evidence — the reconciliation of PR #99 onto the post-#96
    // mainline recomputed the governance state accordingly. WORK-074
    // (Identity & Access Runtime Activation — the WORK-063 RUNTIME) was
    // MERGED by the architect as cdedd0ca via PR #99 (2026-08-31,
    // squash-merged at the approved head 25512f4) and is recorded complete
    // per §34.8/ADR-0007 by the WORK-074 post-merge finalization (PR #100,
    // merged as 1e279a2) — and WORK-065 (Synthetic Browser Validation
    // Agent) was likewise MERGED by the architect as 5de5e83 via PR #97
    // (2026-08-31, squash-merged at the approved head c06a3e3) and is
    // recorded complete per §34.8/ADR-0007 by the WORK-065 post-merge
    // finalization — and WORK-066 (Validation Scheduling &
    // Change Triggers) was likewise MERGED by the architect as 0a506b1 via
    // PR #102 (2026-08-31, squash-merged at the approved head 493ae59) and
    // is recorded complete per §34.8/ADR-0007 by the WORK-066 post-merge
    // finalization (PR #104) — 59/59 recorded work orders complete. The
    // record is 59 complete + ONE in-flight item: WORK-067 (activated
    // 2026-09-01 on feat/WORK-067-signal-regression-correlation — the
    // ADR-0003 coordination partner of the former parallel WORK-066, now
    // durable history; this branch is rebased onto the post-#104 mainline).
    // Nothing is blocked
    // (WORK-053..061 and WORK-068..070 are future-generation items not
    // recorded in program-state; WORK-069's WORK-066 edge is satisfied).
    expect(frontier.inFlight.map((w) => w.id)).toEqual(['WORK-067']);
    expect(frontier.blocked).toEqual([]);
    expect(frontier.complete.length).toBeGreaterThanOrEqual(59);
  });
});
