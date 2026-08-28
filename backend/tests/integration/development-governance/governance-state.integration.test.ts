import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DefaultDevelopmentGovernanceService,
  FileSystemGovernanceStateLoader,
  GovernanceStateValidationError,
  NoResumableStateError,
  UnknownWorkOrderError,
} from '../../../src/development-governance/index.js';
import type { GovernanceModel, ProgramState } from '../../../src/development-governance/index.js';

/**
 * WORK-052 — the repository-resident development-governance control plane.
 *
 * This suite is the FRESH-CHECKOUT PROOF (W052-AC01) plus the fail-closed
 * validation/discrimination proofs (W052-AC02) and the crash/restart/resume
 * proof (W052-AC07): every assertion runs against the REAL repository
 * artifacts at `spec/development-state/` — the same state a brand-new
 * implementer clones — never against mocks of them.
 */
describe('WORK-052 — repository source of truth (fresh-checkout reconstruction + fail-closed validation)', () => {
  // backend/tests/integration/development-governance/ → the repository root.
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const GOVERNANCE_DIR = join(REPO_ROOT, 'spec', 'development-state');

  let realModel: GovernanceModel;
  let realProgram: ProgramState;
  let service: DefaultDevelopmentGovernanceService;

  beforeAll(async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).load();
    realModel = loaded.model;
    realProgram = loaded.program;
    service = DefaultDevelopmentGovernanceService.fromLoadedState(realModel, realProgram);
  });

  // --- W052-AC01: fresh-checkout reconstruction (the seven control questions) --

  it('W052-AC01 — a fresh checkout reconstructs the architecture program (the seven control questions, zero conversational history)', async () => {
    // A FRESH service instance from the repository root only — this is what a
    // brand-new implementer constructs after cloning.
    const fresh = await DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT });

    // Q1 — what architecture version governs?
    const governing = fresh.getGoverningState();
    expect(governing.architectureVersion).toBe('v1.0');
    expect(governing.architectureVersionState).toBe('frozen');
    expect(governing.evolution).toMatch(/§34/);
    expect(governing.controlLoop.map((s) => s.name)).toEqual([
      'sense', 'understand', 'plan', 'check', 'execute', 'verify', 'review', 'release', 'observe', 'learn',
    ]);

    // Q2 — which Work Orders exist?
    const all = fresh.listWorkOrders();
    expect(all.length).toBeGreaterThanOrEqual(52);
    expect(all.map((w) => w.id)).toContain('WORK-051');
    expect(all.map((w) => w.id)).toContain('WORK-052');

    // Q3 — which are complete / in flight / blocked?
    const complete = fresh.listWorkOrders({ status: 'complete' });
    const inFlight = fresh.listWorkOrders({ status: 'in_flight' });
    expect(complete.length).toBeGreaterThanOrEqual(46); // WORK-001..045 + WORK-051 (merged as f2c996c)
    expect(inFlight.map((w) => w.id).sort()).toEqual(['WORK-046', 'WORK-052']);
    // Every completed item carries merge evidence (the truthful record).
    for (const w of complete) {
      expect(w.mergedAs?.pr, `${w.id} must record its merge PR`).toBeGreaterThan(0);
      expect(w.mergedAs?.mergeCommit).toMatch(/^[0-9a-f]{7,40}$/i);
    }
    // The explicit merge-vs-checkpoint rule: WORK-051 is COMPLETE through the
    // merge (f2c996c), and no in-flight item carries merge evidence.
    const w051 = complete.find((w) => w.id === 'WORK-051');
    expect(w051?.mergedAs).toEqual({ pr: 52, mergeCommit: 'f2c996c' });
    for (const w of inFlight) {
      expect(w.mergedAs, `${w.id} (in_flight) must NOT carry merge evidence`).toBeUndefined();
    }

    // Q4 — what can safely run in parallel? (frontier + conflicts)
    const frontier = fresh.getFrontier();
    expect(frontier.inFlight.length).toBe(2);
    // WORK-048's dependencies (040/041/042/044) are all complete → the frontier.
    expect(frontier.dependencyEligible.map((w) => w.id)).toContain('WORK-048');
    // WORK-047 is blocked on the in-flight WORK-046.
    const w047 = frontier.blocked.find((w) => w.id === 'WORK-047');
    expect(w047?.blockedBy).toContain('WORK-046');
    // The KNOWN real-world conflict is reported: WORK-046 and WORK-052 share
    // the static-architecture suite — MUTUALLY coordinated (PR #62 round 1).
    const w052Conflicts = frontier.inFlight.find((w) => w.id === 'WORK-052')?.conflicts ?? [];
    const with046 = w052Conflicts.find((c) => c.with === 'WORK-046');
    expect(with046, 'WORK-052 ↔ WORK-046 shared surfaces are reported').toBeTruthy();
    expect(with046?.sharedSurfaces.some((s) => s.value.includes('static-architecture.test.ts'))).toBe(true);
    expect(with046?.coordinated, 'the conflict is documented as MUTUALLY coordinated').toBe(true);
    // The frontier's item-level coordination flag is TRUTHFUL (PR #62 round 1,
    // BLOCKER 2): both in-flight items have all conflicts mutually coordinated
    // and no incomplete deps — the flag is TRUE here because the FACTS are
    // true (the false case is proven by mutation below).
    for (const item of frontier.inFlight) {
      expect(item.incompleteDependencies).toEqual([]);
      expect(item.conflicts.every((c) => c.coordinated), `${item.id}: every conflict mutually coordinated`).toBe(true);
      expect(item.coordinated, `${item.id}: the item-level flag matches the facts`).toBe(true);
    }

    // Q5 — which checkpoints apply, at which assurance depth?
    const assurance = fresh.resolveAssurance('WORK-052');
    expect(assurance.profile).toBe('CRITICAL');
    expect(assurance.requiredProofClasses).toEqual(['static', 'dynamic', 'discrimination']);
    expect(assurance.architectReviewRecord).toBe(true);
    expect(assurance.applicableContracts.length).toBe(11);
    const light = fresh.getCheckpointApplicability('LIGHT');
    expect(light.length).toBeGreaterThan(0);
    expect(light.length).toBeLessThan(assurance.applicableContracts.length);

    // Q6 — which decisions constrain the work?
    expect(governing.decisions.map((d) => d.id)).toContain('ADR-0001');
    expect(governing.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(6);

    // Q7 — how do I resume interrupted implementation? (WORK-052 has a handoff)
    const resumption = fresh.resumeImplementation('WORK-052');
    expect(resumption.branch).toBe('feat/work-052-development-governance');
    expect(resumption.handoff.lastVerifiedState.length).toBeGreaterThan(0);
    expect(resumption.handoff.nextSteps.length).toBeGreaterThan(0);
  });

  it('W052-AC01 — the governance:status CLI entry answers from the repository alone (the script exists and constructs the service)', async () => {
    // The CLI is exercised end-to-end in CI; here we pin its existence and
    // that it wires the service rather than independent state.
    const cliPath = join(REPO_ROOT, 'backend', 'src', 'development-governance', 'cli.ts');
    const { readFile } = await import('node:fs/promises');
    const cli = await readFile(cliPath, 'utf8');
    expect(cli).toMatch(/DefaultDevelopmentGovernanceService\.create/);
    expect(cli).toMatch(/getFrontier/);
  });

  // --- W052-AC02: fail-closed validation + discrimination ----------------------

  /**
   * Writes mutated copies of the REAL artifacts into a temp governance dir and
   * inspects them against the REAL repository root (enforcement references
   * resolve against the real tree; only the mutated artifact differs).
   */
  const inspectMutated = async (
    mutateModel?: (m: GovernanceModel) => void,
    mutateProgram?: (p: ProgramState) => void,
  ): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-discrimination-'));
    try {
      const model: GovernanceModel = structuredClone(realModel);
      const program: ProgramState = structuredClone(realProgram);
      mutateModel?.(model);
      mutateProgram?.(program);
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(model, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));
      const loaded = await new FileSystemGovernanceStateLoader({
        repoRoot: REPO_ROOT,
        governanceDir: dir,
      }).inspect();
      return loaded.validation.violations;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('W052-AC02 — the BASELINE validates: zero violations against the real repository (the control plane serves the real state)', async () => {
    const loaded = await new FileSystemGovernanceStateLoader({
      repoRoot: REPO_ROOT,
      governanceDir: GOVERNANCE_DIR,
    }).inspect();
    expect(loaded.validation.violations, loaded.validation.violations.join('\n')).toEqual([]);
    expect(loaded.validation.ok).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a weakened self-hosting boundary (removed core prohibition) is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.selfHostingBoundary.coreProhibitions = m.selfHostingBoundary.coreProhibitions.slice(1);
      m.selfHostingBoundary.mayNot = m.selfHostingBoundary.mayNot.filter(
        (x) => x !== m.selfHostingBoundary.coreProhibitions[0],
      );
    });
    expect(violations.some((v) => v.includes('core prohibition REMOVED'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a cyclic dependency DAG is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // WORK-052 → WORK-051 already exists; add WORK-051 → WORK-052 to close a cycle.
      const w051 = p.workOrders.find((w) => w.id === 'WORK-051')!;
      w051.dependencies = [...w051.dependencies, 'WORK-052'];
    });
    expect(violations.some((v) => v.includes('CYCLE'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a completion without merge evidence is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w046 = p.workOrders.find((w) => w.id === 'WORK-046')!;
      w046.status = 'complete';
      delete (w046 as { mergedAs?: unknown }).mergedAs;
    });
    expect(violations.some((v) => v.includes('REQUIRES merge evidence'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: a weakened CRITICAL assurance matrix is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.assuranceProfiles.requirements.CRITICAL!.proofClasses = ['static'];
      m.assuranceProfiles.requirements.CRITICAL!.architectReviewRecord = false;
      m.assuranceProfiles.requirements.CRITICAL!.checkpointKinds = ['pr_conformance'];
    });
    expect(violations.some((v) => v.includes('code-pinned minimum was weakened'))).toBe(true);
    // Dominance also fails: pr_conformance-only no longer covers readiness at high impact.
    expect(violations.some((v) => v.includes('dominance'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: an enforcement reference to a missing file is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.checkpointContracts[0]!.enforcement[0]!.file = 'backend/tests/does-not-exist.test.ts';
    });
    expect(violations.some((v) => v.includes('referenced file does not exist'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: schema drift (unknown field) is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      (p as unknown as Record<string, unknown>).chatContext = 'allowed';
    });
    expect(violations.some((v) => v.includes('unknown field "chatContext"'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION: an assurance profile inconsistent with the deterministic selection is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // WORK-052 declares authorityBoundary surfaces; lie about the profile.
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      w052.assuranceProfile = 'LIGHT';
    });
    expect(violations.some((v) => v.includes('does not match the DETERMINISTIC selection'))).toBe(true);
  });

  // --- PR #62 round-1 discriminations (the architect's three blockers) ----------

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): ONE-SIDED coordination is REJECTED', async () => {
    // Strip WORK-052's coordination record: WORK-046 (in-flight) still
    // declares coordination with WORK-052, which no longer reciprocates.
    const violations = await inspectMutated(undefined, (p) => {
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      delete (w052 as { coordination?: unknown }).coordination;
    });
    expect(
      violations.some((v) => v.includes('ONE-SIDED')),
      'the unreciprocated reference must be rejected as ONE-SIDED',
    ).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): a coordination record that does NOT cover the incomplete dependencies is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      // Start over an incomplete dependency (WORK-047 is blocked/incomplete)
      // while coordinating only with the complete WORK-051 + in-flight WORK-046.
      w052.dependencies = [...w052.dependencies, 'WORK-047'];
    });
    expect(violations.some((v) => v.includes('is NOT covered by the coordination record'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): coordination referencing an UNSTARTED work order is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w052 = p.workOrders.find((w) => w.id === 'WORK-052')!;
      w052.coordination = { ...w052.coordination!, with: ['WORK-048'] };
    });
    expect(violations.some((v) => v.includes('is pending — coordination references started (in_flight) or merged (complete) work orders only'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): an in_flight work order carrying MERGE EVIDENCE is REJECTED (merged-but-in-flight is a lie about the merge)', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w046 = p.workOrders.find((w) => w.id === 'WORK-046')!;
      w046.mergedAs = { pr: 60, mergeCommit: 'deadbeef' };
    });
    expect(violations.some((v) => v.includes('MUST NOT carry merge evidence'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): checkpoint outcomes on an UNSTARTED (pending) work order are REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w048 = p.workOrders.find((w) => w.id === 'WORK-048')!;
      w048.checkpointOutcomes = [
        { contractId: 'AUTH-PRESERVATION', status: 'evidenced', proofClasses: ['static'], evidenceRef: 'claim', at: '2026-08-28T12:00:00Z' },
      ];
    });
    expect(violations.some((v) => v.includes('claims about a STARTED implementation'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): a WEAKENED completion rule (checkpoint outcomes completing work) is REJECTED', async () => {
    const violations = await inspectMutated((m) => {
      m.completionRule.completionEvent = 'checkpoint-outcomes';
    });
    expect(violations.some((v) => v.includes('completionRule.completionEvent must be "architect-merge"'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): a MISSING completion rule is REJECTED (the rule must be explicit machine-readable state)', async () => {
    const violations = await inspectMutated((m) => {
      delete (m as unknown as Record<string, unknown>).completionRule;
    });
    expect(violations.some((v) => v.includes('completionRule: REQUIRED'))).toBe(true);
  });

  it('W052-AC02 — the merge-vs-checkpoint rule is POSITIVE: all outcomes evidenced but NOT merged stays in_flight (the merge is the only completion event)', async () => {
    // WORK-052 itself is the live proof: 11 evidenced checkpoint outcomes and
    // NO merge evidence — the status is in_flight, exactly as recorded.
    const w052 = realProgram.workOrders.find((w) => w.id === 'WORK-052')!;
    expect(w052.status).toBe('in_flight');
    expect((w052.checkpointOutcomes ?? []).length).toBe(11);
    expect(w052.mergedAs).toBeUndefined();
    // And the loader serves it (claims are legal on started items).
    expect(service.listWorkOrders({ status: 'in_flight' }).map((w) => w.id)).toEqual(['WORK-046', 'WORK-052']);
  });

  it('W052-AC02 — the loader REFUSES to serve an invalid state (GovernanceStateValidationError, fail closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-invalid-'));
    try {
      const model: GovernanceModel = structuredClone(realModel);
      model.selfHostingBoundary.coreProhibitions = [];
      model.selfHostingBoundary.mayNot = [];
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(model));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(realProgram));
      await expect(
        DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT, governanceDir: dir }),
      ).rejects.toBeInstanceOf(GovernanceStateValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W052-AC02 — a missing governance directory is a typed failure (never a vacuous empty state)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-empty-'));
    try {
      await expect(
        DefaultDevelopmentGovernanceService.create({ repoRoot: REPO_ROOT, governanceDir: dir }),
      ).rejects.toBeInstanceOf(GovernanceStateValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- W052-AC07: crash/restart/resume -----------------------------------------

  it('W052-AC07 — crash/restart/resume: a fresh control-plane instance reconstructs the resumption view from repository-resident state', async () => {
    // A fixture repository-resident state representing an INTERRUPTED
    // implementation (the "coordinating process" died): the state lives ONLY
    // in the files below — no process memory, no chat context.
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-resume-'));
    try {
      const program: ProgramState = structuredClone(realProgram);
      const w052 = program.workOrders.find((w) => w.id === 'WORK-052')!;
      w052.status = 'in_flight';
      w052.branch = 'feat/work-052-development-governance';
      w052.pr = 63;
      program.resumption.activeHandoffs = [
        {
          workOrderId: 'WORK-052',
          lastVerifiedState: 'step 3 of 5 complete: loader + service + detector implemented; static invariants green',
          nextSteps: ['write the integration tests', 'run the full real-PG sweep', 'open the PR'],
          blockers: [],
          recordedAt: '2026-08-28T11:00:00Z',
          recordedBy: 'the interrupted implementation agent',
        },
      ];
      mkdirSync(join(dir), { recursive: true });
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(realModel, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));

      // "Restart the coordinating process": a NEW service instance from the
      // same repository-resident state.
      const restarted = await DefaultDevelopmentGovernanceService.create({
        repoRoot: REPO_ROOT,
        governanceDir: dir,
      });
      const view = restarted.resumeImplementation('WORK-052');
      expect(view.workOrderId).toBe('WORK-052');
      expect(view.status).toBe('in_flight');
      expect(view.branch).toBe('feat/work-052-development-governance');
      expect(view.handoff.lastVerifiedState).toContain('step 3 of 5');
      expect(view.handoff.nextSteps).toEqual(['write the integration tests', 'run the full real-PG sweep', 'open the PR']);
      // The resumption view carries EVERYTHING a fresh agent needs: the work
      // order reference, the assurance contract, the protocol rules, the
      // governing documents, and the constraining decisions.
      expect(view.workOrderRef).toBe('spec/work-orders/WORK-052.md');
      expect(view.assurance.profile).toBe('CRITICAL');
      expect(view.assurance.architectReviewRecord).toBe(true);
      expect(view.parallelProtocolRules.length).toBeGreaterThanOrEqual(6);
      expect(view.governingDocuments.length).toBeGreaterThanOrEqual(5);
      expect(view.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(6);
      expect(view.dependencies.map((d) => d.id)).toContain('WORK-051');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('W052-AC07 — resuming a work order with no handoff record fails closed (NoResumableStateError)', () => {
    // WORK-048 is pending with no handoff — nothing to resume.
    expect(() => service.resumeImplementation('WORK-048')).toThrow(NoResumableStateError);
  });

  it('W052-AC07 — an unknown work order is a typed error (no nearest-match fallback)', () => {
    expect(() => service.getWorkOrder('WORK-999')).toThrow(UnknownWorkOrderError);
    expect(() => service.getWorkOrder('work-052')).toThrow(UnknownWorkOrderError);
  });
});
