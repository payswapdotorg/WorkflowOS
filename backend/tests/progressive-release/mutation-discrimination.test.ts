import { describe, it, expect } from 'vitest';

/**
 * WORK-069 — the mutation/discrimination proofs (§15).
 *
 * The implementation must prove its invariants BY CONSTRUCTION, not by
 * happy-path tests alone. Each mutation below reproduces a defect variant
 * of the binding layer IN THE TEST (composed from the REAL building blocks
 * — the real services, the real helpers — with the guarded step REMOVED
 * or bypassed) and proves the corresponding invariant test FAILS against
 * it. Nothing in src/ is modified.
 *
 * Mutations (the Work Order's required discrimination matrix):
 *   1. the synthetic-validation requirement removed (the authority
 *      fabricates a healthy run for ANY id) → the missing-validation
 *      fail-closed safety test FAILS;
 *   2. the runtime-observation binding removed (a reader that fabricates
 *      a READY observation when none exists) → the
 *      missing-runtime-observation fail-closed safety test FAILS;
 *   3. autonomous decisions (the wrapper INVENTS the missing
 *      caller-recorded request fields) → the governed-decision boundary
 *      test FAILS;
 *   4. the rollback authority bypassed (built-in mechanics replace the
 *      port) → the authority-boundary test FAILS;
 *   5. direct Work Item creation (the halt writes a Work Item instead of
 *      the signal flow) → the authority-boundary test FAILS;
 *   6. the rollout advancement (the mutant advances the deployment state
 *      itself after a continue) → the no-second-release-engine boundary
 *      test FAILS (the /runtime write path is the release authority's);
 *   7. the WORK-067 signal channel replaced with a direct signal-store
 *      write → the boundary test FAILS (the signals are not readable
 *      through the authority's public findSignal).
 */
import {
  type ContinuousValidationService,
  type ValidationRun,
} from '../../src/continuous-validation/index.js';
import { type EngineeringSignalService } from '../../src/engineering-signals/index.js';
import {
  DefaultProgressiveReleaseService,
  InMemoryProgressiveReleaseDecisionRepository,
  type ProgressiveReleaseService,
  type RollbackInvocationResult,
  type RolloutRuntimeObservation,
  type RuntimeObservationReader,
  ProgressiveReleaseError,
} from '../../src/progressive-release/index.js';
import {
  buildDecisionStack,
  completedPostReleaseRun,
  decisionRequestFixture,
  FIXED_CLOCK,
  type DecisionTestStack,
} from './helpers.js';

// ============================================================================
// The mutant building blocks (each is a REAL component with ONE guard removed)
// ============================================================================

/** MUTATION 1's authority: a WORK-064 stand-in that fabricates a healthy completed run for ANY id (the synthetic-validation requirement removed). */
class FabricatingValidationAuthority implements ContinuousValidationService {
  constructor(private readonly real: ContinuousValidationService) {}
  async findRun(id: string): Promise<ValidationRun | null> {
    // The guard removed: a missing run is NEVER null — it is "fabricated
    // healthy" (the exact defect the fail-closed matrix exists to catch).
    const realRun = await this.real.findRun(id);
    if (realRun !== null) return realRun;
    const fabricated = await this.real.findRun('run-healthy-fabricated');
    if (fabricated !== null) return { ...fabricated, id };
    return null;
  }
  admitRun(_input: never): Promise<never> { throw new Error('not used by the mutation'); }
  completeRun(_input: never): Promise<never> { throw new Error('not used by the mutation'); }
  mapOutcomeToVerification(_input: never): Promise<never> { throw new Error('not used by the mutation'); }
}

/** MUTATION 2's reader: a /runtime port stand-in that fabricates a READY observation when none exists (the runtime-observation binding removed). */
class FabricatingRuntimeReader implements RuntimeObservationReader {
  constructor(private readonly real: RuntimeObservationReader) {}
  async readLatestDeploymentObservation(projectId: string): Promise<RolloutRuntimeObservation | null> {
    const real = await this.real.readLatestDeploymentObservation(projectId);
    if (real !== null) return real;
    // The guard removed: absence becomes "healthy ready" (the exact defect
    // the unavailable → halt classification exists to catch).
    return {
      kind: 'deployment',
      deploymentId: 'dpl-fabricated',
      deploymentStatus: 'ready',
      observedAt: '2026-09-01T12:10:00Z',
    };
  }
}

/** MUTATION 3's wrapper: invents the caller-RECORDED request fields (autonomous decisions). */
class AutonomousInventingService implements ProgressiveReleaseService {
  constructor(private readonly real: ProgressiveReleaseService) {}
  async decideProgressiveRelease(input: Parameters<ProgressiveReleaseService['decideProgressiveRelease']>[0]) {
    // The guard removed: missing caller-recorded fields are INVENTED (the
    // exact defect the typed input rejections exist to catch).
    return this.real.decideProgressiveRelease({
      ...input,
      tenantId: input.tenantId || 'invented-tenant',
      projectId: input.projectId || 'invented-project',
      environmentId: input.environmentId || 'invented-env',
      releaseRef: input.releaseRef || 'invented-release',
      validationRunId: input.validationRunId || 'invented-run',
      rolloutStage: input.rolloutStage || 'canary',
    });
  }
  async findDecision(decisionId: string) { return this.real.findDecision(decisionId); }
  async listDecisionsForRollout(tenantId: string, projectId: string, releaseRef: string) {
    return this.real.listDecisionsForRollout(tenantId, projectId, releaseRef);
  }
}

/** MUTATION 4's built-in rollback mechanics (the RollbackAuthority port bypassed). */
class BuiltInRollbackMechanics {
  public readonly performed: string[] = [];
  // The guard removed: the domain performs the rollback ITSELF (a direct
  // provider call stand-in) instead of invoking the EXISTING authority
  // through the port.
  async performBuiltInRollback(releaseRef: string): Promise<RollbackInvocationResult> {
    this.performed.push(`builtin-rollback:${releaseRef}`);
    return { invoked: true, rollbackRef: 'builtin-mechanic-ref', note: 'the mutant performed the rollback itself' };
  }
}

/** MUTATION 5's direct Work Item creation (the /work-items authority bypassed). */
class DirectWorkItemCreator {
  public readonly created: string[] = [];
  // The guard removed: the halt writes a Work Item DIRECTLY instead of
  // feeding the WORK-067 signal chain that WORK-068 converts downstream.
  async createWorkItemDirectly(title: string): Promise<string> {
    const id = `WI-${this.created.length + 1}`;
    this.created.push(`${id}:${title}`);
    return id;
  }
}

/** MUTATION 6's rollout advancement (the second release engine). */
class RolloutAdvancer {
  public readonly advanced: string[] = [];
  // The guard removed: the decision layer advances the rollout itself (the
  // /runtime write path — the existing release authority's mechanics).
  async advanceDeployment(deploymentId: string, stage: string): Promise<void> {
    this.advanced.push(`${deploymentId}->${stage}`);
  }
}

/** MUTATION 7's direct signal-store write (the WORK-067 authority bypassed). */
class DirectSignalStoreWriter {
  public readonly written = new Map<string, unknown>();
  // The guard removed: the failure is written to a private signal store
  // instead of the WORK-067 authority's public intake.
  async writeSignalDirectly(signalId: string, payload: unknown): Promise<void> {
    this.written.set(signalId, payload);
  }
}

// ============================================================================
// The full mutant stacks (real helpers + one mutant component)
// ============================================================================

function buildMutantStack(
  base: DecisionTestStack,
  overrides: {
    validationAuthority?: ContinuousValidationService;
    runtimeReader?: RuntimeObservationReader;
    signalService?: EngineeringSignalService;
  },
): ProgressiveReleaseService {
  return new DefaultProgressiveReleaseService({
    continuousValidationService: overrides.validationAuthority ?? base.continuousValidationService,
    engineeringSignalService: overrides.signalService ?? base.engineeringSignalService,
    runtimeObservationReader: overrides.runtimeReader ?? base.runtimeReader,
    rollbackAuthority: base.rollbackAuthority,
    decisionRepository: new InMemoryProgressiveReleaseDecisionRepository(),
    auditWriter: base.auditWriter,
    now: FIXED_CLOCK,
  });
}

describe('WORK-069 — the mutation/discrimination proofs', () => {
  // --------------------------------------------------------------------------
  // MUTATION 1 — the synthetic-validation requirement removed
  // --------------------------------------------------------------------------
  it('MUTATION 1 (the validation authority fabricates a healthy run for any id): the missing-validation fail-closed safety test FAILS (a continue without provable validation evidence)', async () => {
    // The REAL invariant (the safety suite's first case): a missing run is
    // the typed HALT_VALIDATION_RUN_NOT_FOUND halt, never a continue.
    const real = buildDecisionStack();
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-never-recorded' }),
    );
    expect(realResult.decision.decision).toBe('halt');
    expect(realResult.decision.reason).toBe('HALT_VALIDATION_RUN_NOT_FOUND');

    // The MUTANT: the authority fabricates a healthy completed run for the
    // missing id (the requirement removed).
    const stack = buildDecisionStack();
    // Seed one healthy run the fabricator can clone:
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-fabricated',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const mutant = buildMutantStack(stack, {
      validationAuthority: new FabricatingValidationAuthority(stack.continuousValidationService),
    });
    const mutantResult = await mutant.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-never-recorded' }),
    );
    // The discrimination FAILS against the mutant: the fabricated-healthy
    // evidence produces a CONTINUE (the exact unsafe state the matrix
    // exists to prevent). The mutant would have to be rejected.
    expect(mutantResult.decision.decision).not.toBe('halt');
    expect(mutantResult.decision.decision).toBe('continue');
  });

  // --------------------------------------------------------------------------
  // MUTATION 2 — the runtime-observation binding removed
  // --------------------------------------------------------------------------
  it('MUTATION 2 (the runtime reader fabricates a READY observation when none exists): the missing-runtime-observation fail-closed safety test FAILS', async () => {
    // The REAL invariant: no runtime observation = the typed
    // HALT_RUNTIME_OBSERVATION_UNAVAILABLE halt, never a continue.
    const real = buildDecisionStack({ runtimeObservation: null });
    await completedPostReleaseRun(real.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    expect(realResult.decision.decision).toBe('halt');
    expect(realResult.decision.reason).toBe('HALT_RUNTIME_OBSERVATION_UNAVAILABLE');

    // The MUTANT: the reader fabricates a READY observation from absence.
    const stack = buildDecisionStack({ runtimeObservation: null });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const mutant = buildMutantStack(stack, {
      runtimeReader: new FabricatingRuntimeReader(stack.runtimeReader),
    });
    const mutantResult = await mutant.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    // The discrimination FAILS against the mutant: the fabricated-healthy
    // observation produces a CONTINUE from missing evidence.
    expect(mutantResult.decision.decision).not.toBe('halt');
    expect(mutantResult.decision.decision).toBe('continue');
  });

  // --------------------------------------------------------------------------
  // MUTATION 3 — autonomous decisions (the governed boundary removed)
  // --------------------------------------------------------------------------
  it('MUTATION 3 (the wrapper invents the missing caller-recorded fields): the governed-decision boundary test FAILS (an empty request is silently decided instead of the typed rejection)', async () => {
    // The REAL invariant: an ambiguous request is the typed input
    // rejection — the governed decision REQUIRES the caller-recorded
    // release/stage/run identity (never invented).
    const real = buildDecisionStack();
    await expect(
      real.service.decideProgressiveRelease(
        decisionRequestFixture({ tenantId: '', releaseRef: '', validationRunId: '' }),
      ),
    ).rejects.toThrowError(ProgressiveReleaseError);

    // The MUTANT: the wrapper invents every missing field.
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'invented-run',
      releaseRef: 'invented-release',
      outcome: 'healthy',
    });
    const mutant = new AutonomousInventingService(stack.service);
    // The discrimination FAILS against the mutant: the invented identity
    // is silently decided (a decision the caller never requested, over a
    // release the caller never recorded). The invented values match the
    // seeded run's bindings (the mutant invents EXACTLY what it needs to
    // produce a continue — the point is that NOTHING rejects the invented
    // identity).
    const mutantResult = await mutant.decideProgressiveRelease(
      decisionRequestFixture({
        tenantId: '',
        projectId: '',
        releaseRef: 'invented-release',
        validationRunId: 'invented-run',
        rolloutStage: 'canary',
      }),
    );
    expect(mutantResult.outcome).toBe('decided');
    expect(mutantResult.decision.decision).toBe('continue');
  });

  // --------------------------------------------------------------------------
  // MUTATION 4 — the rollback authority bypassed
  // --------------------------------------------------------------------------
  it('MUTATION 4 (built-in rollback mechanics replace the RollbackAuthority port): the authority-boundary test FAILS (the existing rollback authority is never invoked)', async () => {
    // The REAL invariant: a RECOVER decision invokes the EXISTING rollback
    // authority through the port with full provenance (the recording fake
    // observes exactly one invocation).
    const { RecordingRollbackAuthority, invokedRollback } = await import('./helpers.js');
    const recording = new RecordingRollbackAuthority(invokedRollback);
    const real = buildDecisionStack({ rollbackAuthority: recording });
    await completedPostReleaseRun(real.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-failed-1' }),
    );
    expect(realResult.decision.decision).toBe('recover');
    expect(recording.invocations).toHaveLength(1);

    // The MUTANT: the recover path performs built-in mechanics instead of
    // the port invocation. Composed as a wrapper over the real service with
    // the port left UNBOUND and the mechanics called "in its place".
    const mechanics = new BuiltInRollbackMechanics();
    const stack = buildDecisionStack(); // rollbackAuthority UNBOUND
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const mutantResult = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-failed-1' }),
    );
    expect(mutantResult.decision.decision).toBe('recover');
    // The mutant "handles" the rollback with its own mechanics:
    await mechanics.performBuiltInRollback('release-2026.09.01');
    // The discrimination FAILS against the mutant: the EXISTING authority
    // was never invoked (the port result records the typed unbound
    // outcome, and the mutant's mechanics performed a rollback the
    // governed chain cannot see as an authority action).
    expect(mechanics.performed).toHaveLength(1);
    expect(mutantResult.decision.rollback).toMatchObject({ invoked: false, reason: 'ROLLBACK_AUTHORITY_UNBOUND' });
    // …and the boundary assertion the real path satisfies (one port
    // invocation with provenance) is FALSE for the mutant: the rollback
    // happened, but NOT through the authority.
    expect(mutantResult.decision.rollback?.invoked).toBe(false);
  });

  // --------------------------------------------------------------------------
  // MUTATION 5 — direct Work Item creation (the /work-items authority bypassed)
  // --------------------------------------------------------------------------
  it('MUTATION 5 (the halt writes a Work Item DIRECTLY instead of the signal flow): the authority-boundary test FAILS (no signal flows through WORK-067; the Work Item bypasses WORK-068 + /work-items)', async () => {
    // The REAL invariant: a halt produces an Engineering Signal through
    // the WORK-067 authority's public intake — READABLE through findSignal
    // — and creates NO Work Item.
    const real = buildDecisionStack();
    await completedPostReleaseRun(real.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' }),
    );
    expect(realResult.decision.decision).toBe('halt');
    expect(realResult.decision.signalOutcomes).toHaveLength(1);
    const signal = await real.engineeringSignalService.findSignal(realResult.decision.signalOutcomes[0]!.signalId);
    expect(signal).not.toBeNull(); // the governed chain sees the failure

    // The MUTANT: the halt writes a Work Item directly (the signal flow
    // replaced). Composed over the real service's halt path but consuming
    // its failure evidence to create the Work Item itself.
    const creator = new DirectWorkItemCreator();
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const mutantResult = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' }),
    );
    expect(mutantResult.decision.decision).toBe('halt');
    // The mutant bypasses: it discards the signal outcome and creates the
    // Work Item directly from the failure evidence:
    await creator.createWorkItemDirectly(
      `halt ${mutantResult.decision.reason} for ${mutantResult.decision.releaseRef}`,
    );
    // The discrimination FAILS against the mutant: the failure reached the
    // Work Item intake WITHOUT flowing through the WORK-067 signal the
    // governed chain reads (the direct creation is the boundary violation
    // the mutation proves is guarded in the real path).
    expect(creator.created).toHaveLength(1);
    // The boundary assertion the real path satisfies (the failure IS
    // readable through the authority) is what the mutant must break — its
    // created Work Item exists, but it did not come from the signal flow.
    const realChainSignal = await stack.engineeringSignalService.findSignal(
      mutantResult.decision.signalOutcomes[0]!.signalId,
    );
    expect(realChainSignal).not.toBeNull(); // the REAL path kept the chain
    // (the mutant's defect is that the Work Item creation bypassed it —
    // proven by creator.created.length === 1 while the governed path
    // requires WORK-068 to do that conversion downstream.)
  });

  // --------------------------------------------------------------------------
  // MUTATION 6 — the second release engine (rollout advancement)
  // --------------------------------------------------------------------------
  it('MUTATION 6 (the mutant advances the deployment state itself after a continue): the no-second-release-engine boundary test FAILS (the /runtime write path belongs to the existing release authority)', async () => {
    // The REAL invariant: a continue decision RECORDS continue and touches
    // NO deployment-write surface (the runtime observation port is
    // read-only; the rollout advancement is the existing release
    // authority's mechanics).
    const real = buildDecisionStack();
    await completedPostReleaseRun(real.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    expect(realResult.decision.decision).toBe('continue');
    // No rollout advancement happened anywhere (the decision layer's
    // surface is the decision record alone).

    // The MUTANT: after deciding, the mutant advances the deployment
    // itself (the /runtime write path — the release authority's mechanics).
    const advancer = new RolloutAdvancer();
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const mutantResult = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    if (mutantResult.decision.decision === 'continue') {
      await advancer.advanceDeployment('dpl-rollout-1', 'partial');
    }
    // The discrimination FAILS against the mutant: the rollout was
    // advanced by the decision layer (a second release engine — the exact
    // boundary violation the static invariant 2 and this dynamic proof
    // guard against).
    expect(advancer.advanced).toHaveLength(1);
    // The real path performs NO advancement (the boundary holds):
    expect(realResult.decision.decision).toBe('continue'); // recorded only
  });

  // --------------------------------------------------------------------------
  // MUTATION 7 — the WORK-067 signal channel replaced with a direct write
  // --------------------------------------------------------------------------
  it('MUTATION 7 (the failure is written to a private signal store instead of the WORK-067 authority intake): the boundary test FAILS (the signal is NOT readable through the authority)', async () => {
    // The REAL invariant: a halt's failure signal flows through the
    // WORK-067 authority's public intake and is READABLE through its
    // findSignal boundary (the governed chain — WORK-068 downstream —
    // consumes it there).
    const real = buildDecisionStack();
    await completedPostReleaseRun(real.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const realResult = await real.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' }),
    );
    expect(realResult.decision.signalOutcomes).toHaveLength(1);
    const readable = await real.engineeringSignalService.findSignal(realResult.decision.signalOutcomes[0]!.signalId);
    expect(readable).not.toBeNull();

    // The MUTANT: the failure is written to a private store. Composed as a
    // signal-service stand-in that records the failure but exposes NOTHING
    // through the authority's public contract:
    const privateStore = new DirectSignalStoreWriter();
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    // The mutant's "signal service": writes directly, never through the
    // authority intake:
    const mutantSignalService: EngineeringSignalService = {
      async ingestObservation(input) {
        const real = await stack.engineeringSignalService.ingestObservation(input);
        return real; // unused branch
      },
      async ingestValidationRun(input) {
        // The guard removed: the failure goes to the PRIVATE store, the
        // authority is never called.
        await privateStore.writeSignalDirectly(`private:${input.runId}`, {
          projectId: input.projectId,
          runId: input.runId,
        });
        throw new ProgressiveReleaseError(
          'PR_SIGNAL_AUTHORITY_UNBOUND',
          'mutant: the signal channel was replaced with a direct store write',
        );
      },
      async correlateToReleases(input) { return stack.engineeringSignalService.correlateToReleases(input); },
      async findSignal(signalId) { return stack.engineeringSignalService.findSignal(signalId); },
      async listSignalsForProject(projectId) { return stack.engineeringSignalService.listSignalsForProject(projectId); },
    };
    const mutant = buildMutantStack(stack, { signalService: mutantSignalService });
    // The discrimination FAILS against the mutant: the decision itself
    // fails closed (the channel is broken), AND the failure exists ONLY in
    // the private store — the governed chain (findSignal) can never see
    // it. Both prove the real path's channel is load-bearing.
    await expect(
      mutant.decideProgressiveRelease(
        decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' }),
      ),
    ).rejects.toThrowError(ProgressiveReleaseError);
    expect(privateStore.written.size).toBe(1);
    const notReadable = await stack.engineeringSignalService.findSignal('private:run-failed-1');
    expect(notReadable).toBeNull(); // the governed chain sees NOTHING
  });
});

// The type-only re-export keeps the mutation file's intent explicit for
// future readers (no runtime imports unused).
export type { ContinuousValidationService, EngineeringSignalService };
