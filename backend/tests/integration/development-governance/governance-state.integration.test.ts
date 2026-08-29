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
    expect(complete.length).toBeGreaterThanOrEqual(48); // WORK-001..045 + WORK-051 (f2c996c) + WORK-052 (47615c2) + WORK-046 (1f2bef9)
    expect(inFlight.map((w) => w.id).sort()).toEqual(['WORK-047']);
    // Every completed item carries merge evidence (the truthful record).
    for (const w of complete) {
      expect(w.mergedAs?.pr, `${w.id} must record its merge PR`).toBeGreaterThan(0);
      expect(w.mergedAs?.mergeCommit).toMatch(/^[0-9a-f]{7,40}$/i);
    }
    // The explicit merge-vs-checkpoint rule: WORK-051, WORK-052, and WORK-046
    // are COMPLETE through their merges, and no in-flight item carries merge
    // evidence.
    const w051 = complete.find((w) => w.id === 'WORK-051');
    expect(w051?.mergedAs).toEqual({ pr: 52, mergeCommit: 'f2c996c' });
    const w052 = complete.find((w) => w.id === 'WORK-052');
    expect(w052?.mergedAs).toEqual({ pr: 62, mergeCommit: '47615c236ec0e194e112efd3d2ef0f432c4bf210' });
    const w046 = complete.find((w) => w.id === 'WORK-046');
    expect(w046?.mergedAs).toEqual({ pr: 60, mergeCommit: '1f2bef93598433c65b874e58701bdec198289404' });
    for (const w of inFlight) {
      expect(w.mergedAs, `${w.id} (in_flight) must NOT carry merge evidence`).toBeUndefined();
    }

    // Q4 — what can safely run in parallel? (frontier + conflicts)
    const frontier = fresh.getFrontier();
    expect(frontier.inFlight.length).toBe(1);
    // WORK-048's dependencies (040/041/042/044) are all complete → the frontier.
    expect(frontier.dependencyEligible.map((w) => w.id)).toContain('WORK-048');
    // WORK-049/050 are blocked on the pending WORK-048; WORK-047 is the
    // in-flight item (activated after the WORK-046 merge — all its
    // dependencies complete, so it blocked on nothing).
    const w049 = frontier.blocked.find((w) => w.id === 'WORK-049');
    expect(w049?.blockedBy).toContain('WORK-048');
    // WORK-047 is the only in-flight item: its former blocking dependency
    // WORK-046 has MERGED — no active conflict (its sharedIntegrationSurfaces
    // collide with no other in-flight item; the historical WORK-046/WORK-052
    // coordination is durable history on both merged records).
    const w047 = frontier.inFlight.find((w) => w.id === 'WORK-047');
    expect(w047?.conflicts).toEqual([]);
    // The frontier's item-level coordination flag is TRUTHFUL (PR #62 round 1,
    // BLOCKER 2): WORK-047 has all conflicts mutually coordinated (vacuously:
    // none) and no incomplete deps — the flag is TRUE because the FACTS are
    // true (the false case is proven by mutation in the parallel suite).
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
    expect(governing.decisions.map((d) => d.id)).toContain('ADR-0007');
    expect(governing.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(7);

    // Q7 — how do I resume interrupted implementation? (WORK-047 — the only
    // in-flight item — has a handoff; WORK-046 and WORK-052 are MERGED: their
    // handoffs were removed by the post-merge finalization, and merged work is
    // NOT resumable.)
    const resumption = fresh.resumeImplementation('WORK-047');
    expect(resumption.branch).toBe('feat/work-047-agent-intelligence');
    expect(resumption.handoff.lastVerifiedState.length).toBeGreaterThan(0);
    expect(resumption.handoff.nextSteps.length).toBeGreaterThan(0);
    expect(() => fresh.resumeImplementation('WORK-052')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-046')).toThrow(NoResumableStateError);
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
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.status = 'complete';
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
      // WORK-047 (the in-flight item) declares its surfaces; lie about the profile.
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.assuranceProfile = 'LIGHT';
    });
    expect(violations.some((v) => v.includes('does not match the DETERMINISTIC selection'))).toBe(true);
  });

  // --- PR #62 round-1 discriminations (the architect's three blockers) ----------

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): ONE-SIDED coordination is REJECTED', async () => {
    // Reconstruct an in-flight pair over the REAL records: WORK-047 (the
    // in-flight item) declares coordination with WORK-046, and WORK-046 is
    // reconstructed as in-flight with its merge evidence removed (that lie
    // would be rejected separately) and WITHOUT a reciprocal coordination
    // record — the reference from WORK-047 is one-sided.
    const violations = await inspectMutated(undefined, (p) => {
      const w046 = p.workOrders.find((w) => w.id === 'WORK-046')!;
      w046.status = 'in_flight';
      delete (w046 as { mergedAs?: unknown }).mergedAs;
      delete (w046 as { coordination?: unknown }).coordination;
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.coordination = { with: ['WORK-046'], reason: 'reconstructed one-sided fixture', adrs: [] };
    });
    expect(
      violations.some((v) => v.includes('ONE-SIDED')),
      'the unreciprocated reference must be rejected as ONE-SIDED',
    ).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): a coordination record that does NOT cover the incomplete dependencies is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      // Start over an incomplete dependency (WORK-049 is blocked on WORK-048)
      // while coordinating only with the merged WORK-046.
      w047.dependencies = [...w047.dependencies, 'WORK-049'];
      w047.coordination = { with: ['WORK-046'], reason: 'covers WORK-046 but not the incomplete WORK-049', adrs: [] };
    });
    expect(violations.some((v) => v.includes('is NOT covered by the coordination record'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): coordination referencing an UNSTARTED work order is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.coordination = { with: ['WORK-048'], reason: 'references the pending WORK-048', adrs: [] };
    });
    expect(violations.some((v) => v.includes('is pending — coordination references started (in_flight) or merged (complete) work orders only'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): an in_flight work order carrying MERGE EVIDENCE is REJECTED (merged-but-in-flight is a lie about the merge)', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w047 = p.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.mergedAs = { pr: 75, mergeCommit: 'deadbeef' };
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

  // --- the post-merge correction discriminations (round 2) ----------------------

  it('W052-AC02 — DISCRIMINATION (post-merge correction, BLOCKER 2): a MISSING post-merge finalization protocol is REJECTED (the protocol must be explicit machine-readable state)', async () => {
    const violations = await inspectMutated((m) => {
      delete (m as unknown as Record<string, unknown>).postMergeFinalization;
    });
    expect(violations.some((v) => v.includes('postMergeFinalization: REQUIRED'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (post-merge correction, BLOCKER 2): a WEAKENED post-merge finalization protocol is REJECTED (wrong trigger / vague obligation / no enforcement / constraint creep)', async () => {
    // A protocol that silent-automates or loses the enforcement reference is
    // a wish, not a mechanism — each essential is code-pinned.
    const wrongTrigger = await inspectMutated((m) => {
      m.postMergeFinalization.trigger = 'implementer-commit';
    });
    expect(wrongTrigger.some((v) => v.includes('postMergeFinalization.trigger must be "architect-merge"'))).toBe(true);

    const vagueObligation = await inspectMutated((m) => {
      m.postMergeFinalization.obligation = 'update the state after merges when convenient';
    });
    expect(vagueObligation.some((v) => v.includes('postMergeFinalization.obligation must mention'))).toBe(true);

    const noEnforcement = await inspectMutated((m) => {
      m.postMergeFinalization.enforcement = 'the architect checks it during review';
    });
    expect(noEnforcement.some((v) => v.includes('postMergeFinalization.enforcement must reference'))).toBe(true);

    const constraintCreep = await inspectMutated((m) => {
      m.postMergeFinalization.constraints = ['automated synchronization from live PR state', 'no new authority'];
    });
    expect(constraintCreep.some((v) => v.includes('postMergeFinalization.constraints must include'))).toBe(true);
  });

  it('W052-AC02 — the merge-vs-checkpoint rule is POSITIVE: outcomes never transition status (the merge is the only completion event)', async () => {
    // WORK-052 itself is the live proof POST-FINALIZATION: 11 evidenced
    // checkpoint outcomes AND the architect's merge — the MERGE completed it;
    // the outcomes are retained implementer claims on the complete record.
    const w052 = realProgram.workOrders.find((w) => w.id === 'WORK-052')!;
    expect(w052.status).toBe('complete');
    expect((w052.checkpointOutcomes ?? []).length).toBe(11);
    expect(w052.mergedAs).toEqual({ pr: 62, mergeCommit: '47615c236ec0e194e112efd3d2ef0f432c4bf210' });
    // Outcomes WITHOUT a merge never complete work: an in-flight item may
    // carry implementer claims and stays in_flight (a synthetic copy — the
    // live program has no such record; the discriminations enforce the rule).
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-claims-only-'));
    try {
      const program: ProgramState = structuredClone(realProgram);
      const w047 = program.workOrders.find((w) => w.id === 'WORK-047')!;
      w047.checkpointOutcomes = [
        { contractId: 'AUTH-PRESERVATION', status: 'evidenced', proofClasses: ['static'], evidenceRef: 'claim', at: '2026-08-29T02:30:00Z' },
      ];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(realModel, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));
      const loaded = await new FileSystemGovernanceStateLoader({ repoRoot: REPO_ROOT, governanceDir: dir }).load();
      const claimsOnly = DefaultDevelopmentGovernanceService.fromLoadedState(loaded.model, loaded.program);
      const stillInFlight = claimsOnly.listWorkOrders({ status: 'in_flight' }).map((w) => w.id);
      expect(stillInFlight).toEqual(['WORK-047']);
      expect(claimsOnly.getWorkOrder('WORK-047').mergedAs).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      delete (w052 as { mergedAs?: unknown }).mergedAs;
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
      expect(view.decisions.filter((d) => d.kind === 'adr').length).toBeGreaterThanOrEqual(7);
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
