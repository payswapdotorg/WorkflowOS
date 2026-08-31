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
    expect(complete.length).toBeGreaterThanOrEqual(58); // WORK-001..045 + WORK-051 (f2c996c) + WORK-052 (47615c2) + WORK-046 (1f2bef9) + WORK-047 (e2b665c) + WORK-048 (5c48257) + WORK-049 (07ac9cc) + WORK-050 (8f27cc7) + WORK-062 (f0855d2) + WORK-063 (8dac9c4, spec-only) + WORK-064 (c351451) + WORK-071 (8604c8a) + WORK-074 (cdedd0ca) + WORK-065 (5de5e83)
    // WORK-064 (Continuous Product Validation — the domain/model authority)
    // was ACTIVATED by the architect on 2026-08-30, implemented on branch
    // feat/work-064-continuous-validation (PR #86), MERGED by the architect
    // as c351451 on 2026-08-30 and FINALIZED complete per §34.8/ADR-0007.
    // WORK-071 (Local Development Runtime Substrate) was MERGED into main as
    // 8604c8a5 by the architect via PR #96 (2026-08-31) and is recorded
    // complete with its merge evidence — the reconciliation of PR #99 onto
    // the post-#96 mainline recomputed the governance state accordingly.
    // WORK-074 (Identity & Access Runtime Activation — the WORK-063 RUNTIME)
    // was MERGED by the architect as cdedd0ca via PR #99 (2026-08-31,
    // squash-merged at the approved head 25512f4) and is recorded complete
    // per §34.8/ADR-0007 by the WORK-074 post-merge finalization (PR #100,
    // merged as 1e279a2). WORK-065 (Synthetic Browser Validation Agent — the
    // execution mechanism, NOT an authority) was ACTIVATED by the architect
    // on 2026-08-30, MERGED by the architect as 5de5e83 via PR #97
    // (2026-08-31, squash-merged at the approved head c06a3e3 — the
    // post-#100 reconciliation head, the merge tree identical) and is
    // recorded complete per §34.8/ADR-0007 by the WORK-065 post-merge
    // finalization: NOTHING is in flight (58/58 complete).
    expect(inFlight.map((w) => w.id).sort()).toEqual([]);
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
    const w047 = complete.find((w) => w.id === 'WORK-047');
    expect(w047?.mergedAs).toEqual({ pr: 75, mergeCommit: 'e2b665cc63b53558b894ba10000d01e8af139ca0' });
    const w048 = complete.find((w) => w.id === 'WORK-048');
    expect(w048?.mergedAs).toEqual({ pr: 76, mergeCommit: '5c48257c81ba8f4125dbae9465be8d3936067645' });
    const w049 = complete.find((w) => w.id === 'WORK-049');
    expect(w049?.mergedAs).toEqual({ pr: 77, mergeCommit: '07ac9cc68b088c91c17a61cf2b3943d784a2aeb5' });
    const w050 = complete.find((w) => w.id === 'WORK-050');
    expect(w050?.mergedAs).toEqual({ pr: 78, mergeCommit: '8f27cc755a2ffbb27de79c9b1a6e884a222b296b' });
    const w062 = complete.find((w) => w.id === 'WORK-062');
    expect(w062?.mergedAs).toEqual({ pr: 82, mergeCommit: 'f0855d2955dcf2d3edea683e497902ad30778fc8' });
    const w063 = complete.find((w) => w.id === 'WORK-063');
    expect(w063?.mergedAs).toEqual({ pr: 81, mergeCommit: '8dac9c47f7397e22765478520ac71659d37e1783' });
    const w064 = complete.find((w) => w.id === 'WORK-064');
    expect(w064?.mergedAs).toEqual({ pr: 86, mergeCommit: 'c3514512cb5bcf7694f551d1f1bac9b1ee2d3c3b' });
    const w071 = complete.find((w) => w.id === 'WORK-071');
    expect(w071?.mergedAs).toEqual({ pr: 96, mergeCommit: '8604c8a5286b7533caf907c25fcd4dfdeeb662eb' });
    const w074 = complete.find((w) => w.id === 'WORK-074');
    expect(w074?.mergedAs).toEqual({ pr: 99, mergeCommit: 'cdedd0ca3c72821d289d8d9d683f9902ddca480f' });
    const w065 = complete.find((w) => w.id === 'WORK-065');
    expect(w065?.mergedAs).toEqual({ pr: 97, mergeCommit: '5de5e83ac9a3ce2c1613a7b8b83045d0ab1d8916' });
    // No in-flight item exists (the WORK-065 post-merge finalization closed
    // the last in-flight record), so the in-flight merge-evidence rule holds
    // vacuously — the live records ALL carry truthful merge evidence.
    for (const w of inFlight) {
      expect(w.mergedAs, `${w.id} (in_flight) must NOT carry merge evidence`).toBeUndefined();
    }

    // Q4 — what can safely run in parallel? (frontier + conflicts)
    const frontier = fresh.getFrontier();
    // WORK-064 was ACTIVATED 2026-08-30, MERGED by the architect as c351451
    // via PR #86, and FINALIZED complete per §34.8/ADR-0007. WORK-071 was
    // MERGED as 8604c8a5 via PR #96 and recorded complete in the PR #99
    // reconciliation. WORK-074 was MERGED as cdedd0ca via PR #99 (2026-08-31,
    // squash-merged at the approved head 25512f4) and recorded complete per
    // §34.8/ADR-0007 by the WORK-074 post-merge finalization. WORK-065 was
    // MERGED by the architect as 5de5e83 via PR #97 (2026-08-31,
    // squash-merged at the approved head c06a3e3) and recorded complete per
    // §34.8/ADR-0007 by the WORK-065 post-merge finalization — NOTHING is in
    // flight; WORK-053..061 and WORK-066..070 are future-generation items not
    // recorded in program-state (WORK-066 is dependency-eligible on the
    // complete WORK-064 + WORK-065, and WORK-067 on the complete WORK-064 —
    // NOT activated, the architect's authorization is required).
    expect(frontier.inFlight.map((w) => w.id)).toEqual([]);
    expect(frontier.dependencyEligible).toEqual([]);
    expect(frontier.blocked).toEqual([]);
    // The frontier's item-level coordination flag discipline is TRUTHFUL:
    // no live conflict partners exist — the ONLY in-flight-eligible surface
    // partners (WORK-046/WORK-052/WORK-064/WORK-071/WORK-074/WORK-065 on the
    // shared static-architecture suite) are ALL complete durable history
    // (WORK-065 was merged as 5de5e83/PR #97 before this finalization), so
    // the flag discipline holds vacuously (the false case is proven by
    // mutation in the parallel suite).
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

    // Q7 — how do I resume interrupted implementation? (NOTHING recorded is
    // resumable: WORK-046..WORK-050 and WORK-052 are all MERGED — their
    // handoffs were removed by the post-merge finalization, and merged work
    // is NOT resumable. The in-flight WORK-071 records NO active handoff
    // either — its delivery is the live implementation PR itself, not an
    // interrupted handoff. The positive resumption path is covered by the
    // fixture-based tests below; the real state pins the
    // merged-not-resumable + no-vacuous-handoff rules.)
    expect(() => fresh.resumeImplementation('WORK-052')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-047')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-046')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-048')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-049')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-050')).toThrow(NoResumableStateError);
    expect(() => fresh.resumeImplementation('WORK-071')).toThrow(NoResumableStateError);
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
      // WORK-050 is complete WITH evidence (8f27cc7) — strip the evidence
      // while keeping the complete claim: the lie must be rejected.
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      delete (w050 as { mergedAs?: unknown }).mergedAs;
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
      // Reconstruct WORK-050 (merged as 8f27cc7) as a STARTED item — the
      // deterministic-selection invariant guards started work — and lie
      // about the profile against its declared surfaces.
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      delete (w050 as { mergedAs?: unknown }).mergedAs;
      w050.assuranceProfile = 'LIGHT';
    });
    expect(violations.some((v) => v.includes('does not match the DETERMINISTIC selection'))).toBe(true);
  });

  // --- PR #62 round-1 discriminations (the architect's three blockers) ----------

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): ONE-SIDED coordination is REJECTED', async () => {
    // Reconstruct an in-flight pair over the REAL records: WORK-050 (merged
    // as 8f27cc7 — reconstructed as in-flight with its merge evidence
    // removed; that lie would be rejected separately) declares coordination
    // with WORK-049, and WORK-049 is likewise reconstructed as in-flight
    // with its merge evidence removed and WITHOUT a reciprocal coordination
    // record — the reference from WORK-050 is one-sided.
    const violations = await inspectMutated(undefined, (p) => {
      const w049 = p.workOrders.find((w) => w.id === 'WORK-049')!;
      w049.status = 'in_flight';
      delete (w049 as { mergedAs?: unknown }).mergedAs;
      delete (w049 as { coordination?: unknown }).coordination;
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      delete (w050 as { mergedAs?: unknown }).mergedAs;
      w050.coordination = { with: ['WORK-049'], reason: 'reconstructed one-sided fixture', adrs: [] };
    });
    expect(
      violations.some((v) => v.includes('ONE-SIDED')),
      'the unreciprocated reference must be rejected as ONE-SIDED',
    ).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): a coordination record that does NOT cover the incomplete dependencies is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      const w049 = p.workOrders.find((w) => w.id === 'WORK-049')!;
      // Reconstruct WORK-049 as an INCOMPLETE dependency (in-flight, merge
      // evidence removed) that WORK-050 (reconstructed in-flight likewise)
      // starts over, while WORK-050 coordinates only with the merged
      // WORK-048.
      w049.status = 'in_flight';
      delete (w049 as { mergedAs?: unknown }).mergedAs;
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      delete (w050 as { mergedAs?: unknown }).mergedAs;
      w050.dependencies = [...w050.dependencies, 'WORK-049'];
      w050.coordination = { with: ['WORK-048'], reason: 'covers WORK-048 but not the incomplete WORK-049', adrs: [] };
    });
    expect(violations.some((v) => v.includes('is NOT covered by the coordination record'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 1): coordination referencing an UNSTARTED work order is REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // Reconstruct WORK-049 as pending (unstarted) and reference it from the
      // reconstructed in-flight WORK-050's coordination record.
      const w049 = p.workOrders.find((w) => w.id === 'WORK-049')!;
      w049.status = 'pending';
      delete (w049 as { mergedAs?: unknown }).mergedAs;
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      delete (w050 as { mergedAs?: unknown }).mergedAs;
      w050.coordination = { with: ['WORK-049'], reason: 'references the pending WORK-049', adrs: [] };
    });
    expect(violations.some((v) => v.includes('is pending — coordination references started (in_flight) or merged (complete) work orders only'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): an in_flight work order carrying MERGE EVIDENCE is REJECTED (merged-but-in-flight is a lie about the merge)', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // WORK-050 is MERGED (8f27cc7) — reconstruct it as in-flight while
      // keeping (fake) merge evidence: the lie must be rejected.
      const w050 = p.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      w050.mergedAs = { pr: 78, mergeCommit: 'deadbeef' };
    });
    expect(violations.some((v) => v.includes('MUST NOT carry merge evidence'))).toBe(true);
  });

  it('W052-AC02 — DISCRIMINATION (PR #62 round 1, BLOCKER 3): checkpoint outcomes on an UNSTARTED (pending) work order are REJECTED', async () => {
    const violations = await inspectMutated(undefined, (p) => {
      // Reconstruct WORK-049 as pending (unstarted), then claim outcomes on it.
      const w049 = p.workOrders.find((w) => w.id === 'WORK-049')!;
      w049.status = 'pending';
      delete (w049 as { mergedAs?: unknown }).mergedAs;
      w049.checkpointOutcomes = [
        { contractId: 'AUTH-PRESERVATION', status: 'evidenced', proofClasses: ['static'], evidenceRef: 'claim', at: '2026-08-29T04:40:00Z' },
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
    // Outcomes WITHOUT a merge never complete work: a started item may
    // carry implementer claims and stays in_flight (a synthetic copy —
    // WORK-050 is RECONSTRUCTED as started because the live record is
    // complete-and-merged; the discriminations enforce the rule).
    const dir = mkdtempSync(join(tmpdir(), 'wfos-gov-claims-only-'));
    try {
      const program: ProgramState = structuredClone(realProgram);
      // WORK-065 is complete-and-merged in the real program-state and is NOT
      // part of this claims-only discrimination (WORK-050/062/064). Strip
      // it: WORK-065 depends on WORK-064 (which the discrimination
      // reconstructs as in_flight — a complete record with an in-flight
      // dependency would disagree with the fixture's rebuilt pre-merge
      // state and require a coordination record covering WORK-064).
      // WORK-071, WORK-074, and (since the WORK-065 post-merge finalization)
      // WORK-065 are complete-and-merged in the real program-state; their
      // live records carry merge evidence and are NOT reconstructed — they
      // would survive the fixture rebuild untouched except for the
      // dependency-chain disagreement above. The discrimination reconstructs
      // exactly the three intended started items (WORK-050/062/064 — all
      // three are complete-and-merged in the live record, so the
      // discrimination rebuilds the pre-merge state).
      program.workOrders = program.workOrders.filter((w) => w.id !== 'WORK-065');
      const w050 = program.workOrders.find((w) => w.id === 'WORK-050')!;
      w050.status = 'in_flight';
      delete (w050 as { mergedAs?: unknown }).mergedAs;
      w050.checkpointOutcomes = [
        { contractId: 'AUTH-PRESERVATION', status: 'evidenced', proofClasses: ['static'], evidenceRef: 'claim', at: '2026-08-29T04:40:00Z' },
      ];
      // WORK-062 (merged as f0855d2 via PR #82 and finalized complete
      // 2026-08-30) is RECONSTRUCTED the same way: started, carrying claims,
      // with the merge evidence stripped — the live record is
      // complete-and-merged, so the discrimination rebuilds the pre-merge
      // state to prove outcomes never complete work.
      const w062 = program.workOrders.find((w) => w.id === 'WORK-062')!;
      w062.status = 'in_flight';
      delete (w062 as { mergedAs?: unknown }).mergedAs;
      w062.checkpointOutcomes = [
        { contractId: 'AUTH-PRESERVATION', status: 'evidenced', proofClasses: ['static'], evidenceRef: 'claim', at: '2026-08-30T09:00:00Z' },
      ];
      // The REAL WORK-064 entry (complete-and-merged since the §34.8/
      // ADR-0007 finalization) is RECONSTRUCTED as started the same way,
      // with the merge evidence stripped — the live record is
      // complete-and-merged, so the discrimination rebuilds the pre-merge
      // state to prove outcomes never complete work. The fixture
      // additionally reconstructs WORK-050 (a WORK-064 dependency) as
      // started — under the ADR-0003 coordination contract a start over an
      // incomplete dependency REQUIRES a mutual coordination record, so the
      // fixture carries one (the protocol's own answer; the coordination is
      // fixture bookkeeping, not a claim about the live state, where
      // WORK-050 is complete).
      const w064 = program.workOrders.find((w) => w.id === 'WORK-064')!;
      w064.status = 'in_flight';
      delete (w064 as { mergedAs?: unknown }).mergedAs;
      w064.coordination = {
        with: ['WORK-050'],
        reason: 'fixture: WORK-050 reconstructed as started for the claims-only discrimination',
        adrs: [],
      };
      w050.coordination = {
        with: ['WORK-064'],
        reason: 'fixture: mutual coordination for the WORK-064 start over the reconstructed WORK-050',
        adrs: [],
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'governance-model.json'), JSON.stringify(realModel, null, 2));
      writeFileSync(join(dir, 'program-state.json'), JSON.stringify(program, null, 2));
      const loaded = await new FileSystemGovernanceStateLoader({ repoRoot: REPO_ROOT, governanceDir: dir }).load();
      const claimsOnly = DefaultDevelopmentGovernanceService.fromLoadedState(loaded.model, loaded.program);
      const stillInFlight = claimsOnly.listWorkOrders({ status: 'in_flight' }).map((w) => w.id);
      // WORK-050, WORK-062, and the cloned WORK-064 all stay in_flight
      // (outcomes never complete work) — all three are RECONSTRUCTED
      // started items (all three live records are complete-and-merged:
      // WORK-050 by 8f27cc7/PR #78, WORK-062 by f0855d2/PR #82, WORK-064 by
      // c351451/PR #86 — the last finalized by the change under test).
      // WORK-071 (complete-and-merged as 8604c8a5/PR #96 by the PR #99
      // reconciliation) and WORK-074 (complete-and-merged as cdedd0ca/PR #99
      // by the §34.8/ADR-0007 post-merge finalization) are therefore NOT in
      // the rebuilt in-flight set — their live records carry their merge
      // evidence.
      expect(stillInFlight.sort()).toEqual(['WORK-050', 'WORK-062', 'WORK-064']);
      expect(claimsOnly.getWorkOrder('WORK-050').mergedAs).toBeUndefined();
      expect(claimsOnly.getWorkOrder('WORK-062').mergedAs).toBeUndefined();
      expect(claimsOnly.getWorkOrder('WORK-064').mergedAs).toBeUndefined();
      // WORK-071 and WORK-074 are live complete-and-merged records — their
      // merge evidence survives the fixture rebuild untouched.
      expect(claimsOnly.getWorkOrder('WORK-071').mergedAs).toEqual({ pr: 96, mergeCommit: '8604c8a5286b7533caf907c25fcd4dfdeeb662eb' });
      expect(claimsOnly.getWorkOrder('WORK-074').mergedAs).toEqual({ pr: 99, mergeCommit: 'cdedd0ca3c72821d289d8d9d683f9902ddca480f' });
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
    // WORK-049 is merged + finalized — its handoff was removed by the
    // post-merge finalization; nothing to resume.
    expect(() => service.resumeImplementation('WORK-049')).toThrow(NoResumableStateError);
  });

  it('W052-AC07 — an unknown work order is a typed error (no nearest-match fallback)', () => {
    expect(() => service.getWorkOrder('WORK-999')).toThrow(UnknownWorkOrderError);
    expect(() => service.getWorkOrder('work-052')).toThrow(UnknownWorkOrderError);
  });
});
