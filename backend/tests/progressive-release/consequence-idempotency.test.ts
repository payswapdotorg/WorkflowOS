import { describe, it, expect } from 'vitest';

/**
 * WORK-069 — the consequence durability protocol proofs (the PR #108
 * architect-review correction, the required regression cases):
 *
 *   1. CONCURRENT HALT deliveries → the consequences execute EXACTLY ONCE
 *      (the loser of the reservation race executes NOTHING);
 *   2. CONCURRENT RECOVER deliveries with the rollback authority BOUND →
 *      the rollback is invoked EXACTLY ONCE (the non-idempotent
 *      consequence is at-most-once per decision identity — both the
 *      insert-race window AND the in-flight window);
 *   3. a CRASH between the consequence execution and the completion
 *      persistence → the record is ALREADY durable (the reservation
 *      preceded the consequences); the re-delivery fails CLOSED with the
 *      typed PR_DECISION_CONSEQUENCES_PENDING and re-executes NOTHING;
 *   4. the PRE-EXISTING duplicate-delivery guarantee is PRESERVED (a
 *      completed decision re-delivered returns the recorded record
 *      verbatim; no consequence is re-executed).
 *
 * The protocol under proof: RESERVE (the durable insert-only claim) →
 * EXECUTE (the reservation owner only) → COMPLETE (the pending →
 * executed transition with the real outcomes). The pre-correction
 * implementation executed the halt/recover consequences BEFORE the
 * decision record was persisted — a crash or a concurrent delivery
 * could repeat the signal emission and, once the rollback authority is
 * bound, repeat the rollback for the same decision identity.
 */
import {
  buildDecisionStack,
  completedPostReleaseRun,
  decisionRequestFixture,
  invokedRollback,
  RecordingRollbackAuthority,
} from './helpers.js';
import {
  InMemoryProgressiveReleaseDecisionRepository,
  DefaultProgressiveReleaseService,
  type DecisionReservation,
  type ProgressiveReleaseDecisionRecord,
  type ProgressiveReleaseDecisionRepository,
  type RollbackAuthority,
  type RollbackInvocationInput,
  type RollbackInvocationResult,
} from '../../src/progressive-release/index.js';

/**
 * The STALE-READ repository: `findById` always returns null (both racing
 * deliveries pass the prior-record check), while `reserve` /
 * `completeDecision` delegate to the REAL in-memory adapter. This
 * deterministically forces the architect's exact window — "two service
 * instances race before either saves" — inside one process: both callers
 * reach the reserve; the adapter's insert (the in-memory analog of the
 * DATABASE constraint) decides the single reservation owner.
 */
class StaleReadDecisionRepository implements ProgressiveReleaseDecisionRepository {
  constructor(private readonly real: InMemoryProgressiveReleaseDecisionRepository) {}
  async reserve(record: ProgressiveReleaseDecisionRecord): Promise<DecisionReservation> {
    return this.real.reserve(record);
  }
  async completeDecision(
    decisionId: string,
    outcomes: Parameters<ProgressiveReleaseDecisionRepository['completeDecision']>[1],
  ): Promise<ProgressiveReleaseDecisionRecord> {
    return this.real.completeDecision(decisionId, outcomes);
  }
  async findById(): Promise<null> {
    // The stale read: the racing delivery sees NO record.
    return null;
  }
  async listForRollout(
    tenantId: string,
    projectId: string,
    releaseRef: string,
  ): Promise<readonly ProgressiveReleaseDecisionRecord[]> {
    return this.real.listForRollout(tenantId, projectId, releaseRef);
  }
}

/**
 * The CRASHING-COMPLETION repository: `reserve` and the reads delegate to
 * the REAL adapter, but `completeDecision` THROWS — the process died
 * between the consequence execution and the completion write. The
 * reservation already happened, so the record IS durable (the exact
 * ordering the correction establishes).
 */
class CrashingCompletionRepository implements ProgressiveReleaseDecisionRepository {
  constructor(private readonly real: InMemoryProgressiveReleaseDecisionRepository) {}
  async reserve(record: ProgressiveReleaseDecisionRecord): Promise<DecisionReservation> {
    return this.real.reserve(record);
  }
  async completeDecision(): Promise<never> {
    throw new Error('simulated crash: the completion write did not happen');
  }
  async findById(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null> {
    return this.real.findById(decisionId);
  }
  async listForRollout(
    tenantId: string,
    projectId: string,
    releaseRef: string,
  ): Promise<readonly ProgressiveReleaseDecisionRecord[]> {
    return this.real.listForRollout(tenantId, projectId, releaseRef);
  }
}

/**
 * The GATED rollback authority: the first invocation PARKS on a
 * caller-controlled gate (the reservation owner is mid-consequence), and
 * `gateEntered` resolves the moment it parks — so a second delivery can
 * be issued DURING the in-flight window, observed, and released
 * deterministically. Records every invocation (no dedup — the raw
 * counter is the discriminating proof).
 */
class GatedRollbackAuthority implements RollbackAuthority {
  public readonly invocations: RollbackInvocationInput[] = [];
  private resolveGate: (() => void) | null = null;
  private resolveEntered: (() => void) | null = null;
  /** Resolves once the first invocation has PARKED inside the gate (the in-flight window is open). */
  public readonly gateEntered: Promise<void> = new Promise<void>((resolve) => {
    this.resolveEntered = resolve;
  });
  private readonly gate: Promise<void> = new Promise<void>((resolve) => {
    this.resolveGate = resolve;
  });

  constructor(private readonly result: RollbackInvocationResult) {}

  /** Open the gate (release the parked invocation). */
  release(): void {
    this.resolveGate?.();
  }

  async invokeRollback(input: RollbackInvocationInput): Promise<RollbackInvocationResult> {
    this.invocations.push(input);
    // The in-flight window is open: the reservation owner is parked HERE —
    // the record is durable and PENDING, the rollback is invoked but not
    // returned:
    this.resolveEntered?.();
    await this.gate;
    return this.result;
  }
}

describe('WORK-069 — the consequence durability protocol (the PR #108 architect-review correction)', () => {
  it('REQUIRED CASE 1 — CONCURRENT HALT deliveries: the consequences execute EXACTLY ONCE (the loser of the reservation race is rejected typed and executes NOTHING)', async () => {
    // The stale-read window forces the architect's exact race: both
    // deliveries see "no decision record" and both reach the reserve; the
    // repository insert decides the ONE reservation owner.
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-race',
      releaseRef: 'release-race',
      outcome: 'validation_failure',
    });
    const staleRepo = new StaleReadDecisionRepository(stack.decisionRepository);
    const serviceA = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      decisionRepository: staleRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const serviceB = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      decisionRepository: staleRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-race',
      rolloutStage: 'partial',
      validationRunId: 'run-failed-race',
    });
    const settled = await Promise.allSettled([
      serviceA.decideProgressiveRelease({ ...request }),
      serviceB.decideProgressiveRelease({ ...request }),
    ]);
    // EXACTLY ONE decided; the other is the typed fail-closed pending
    // rejection (it lost the reservation race — it executed NOTHING):
    const decided = settled.filter(
      (s) => s.status === 'fulfilled' && s.value.outcome === 'decided',
    );
    expect(decided).toHaveLength(1);
    const loser = settled.find((s) => s !== decided[0])!;
    if (loser.status !== 'rejected') throw new Error('the racing loser must be rejected');
    expect(String(loser.reason)).toMatch(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
    // …the halt's consequences executed EXACTLY ONCE: one record, one
    // signal, one occurrence, one audit event:
    const decidedRecord =
      decided[0]!.status === 'fulfilled' ? decided[0]!.value.decision : null;
    expect(decidedRecord!.decision).toBe('halt');
    expect(decidedRecord!.consequencePhase).toBe('executed');
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-race');
    expect(history).toHaveLength(1);
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.occurrences).toHaveLength(1);
    expect(
      stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION'),
    ).toHaveLength(1);
  });

  it('REQUIRED CASE 2 — CONCURRENT RECOVER deliveries with the rollback authority BOUND (the insert-race window): the rollback is invoked EXACTLY ONCE', async () => {
    // The shared rollback authority has NO dedup — a repeated invocation
    // is exactly the defect the correction prevents. The stale-read
    // window forces both deliveries to race at the reserve.
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({ rollbackAuthority: rollback });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-race',
      releaseRef: 'release-race',
      outcome: 'validation_failure',
    });
    const staleRepo = new StaleReadDecisionRepository(stack.decisionRepository);
    const serviceA = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      rollbackAuthority: rollback,
      decisionRepository: staleRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const serviceB = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      rollbackAuthority: rollback,
      decisionRepository: staleRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-race',
      rolloutStage: 'canary',
      validationRunId: 'run-failed-race',
    });
    const settled = await Promise.allSettled([
      serviceA.decideProgressiveRelease({ ...request }),
      serviceB.decideProgressiveRelease({ ...request }),
    ]);
    const decided = settled.filter(
      (s) => s.status === 'fulfilled' && s.value.outcome === 'decided',
    );
    expect(decided).toHaveLength(1);
    const loser = settled.find((s) => s !== decided[0])!;
    if (loser.status !== 'rejected') throw new Error('the racing loser must be rejected');
    expect(String(loser.reason)).toMatch(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
    // THE LOAD-BEARING ASSERTION — the rollback (the NON-idempotent
    // consequence) was invoked EXACTLY ONCE for the decision identity:
    expect(rollback.invocations).toHaveLength(1);
    // …and the recorded decision carries the executed rollback:
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-race');
    expect(history).toHaveLength(1);
    expect(history[0]!.decision).toBe('recover');
    expect(history[0]!.consequencePhase).toBe('executed');
    expect(history[0]!.rollback).toMatchObject({ invoked: true });
  });

  it('REQUIRED CASE 2 (the in-flight window) — a SECOND delivery DURING the first delivery\'s consequence execution: it sees the PENDING reservation, is rejected typed, and the rollback still runs EXACTLY ONCE', async () => {
    // The gated rollback blocks the first delivery mid-consequence (the
    // reservation is durable + pending, the rollback is in flight); the
    // second delivery arrives DURING that window.
    const rollback = new GatedRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-inflight',
      releaseRef: 'release-inflight',
      outcome: 'validation_failure',
    });
    const service = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      rollbackAuthority: rollback,
      decisionRepository: stack.decisionRepository,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-inflight',
      rolloutStage: 'canary',
      validationRunId: 'run-failed-inflight',
    });
    // The first delivery runs into the gated rollback invocation and
    // PARKS there — the reservation is durable and PENDING, the rollback
    // invocation is in flight:
    const first = service.decideProgressiveRelease({ ...request });
    await rollback.gateEntered;
    // …and WHILE the first delivery is parked mid-consequence, the SAME
    // identity is re-delivered:
    const second = await service.decideProgressiveRelease({ ...request }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    // The re-delivery does NOT return a clean duplicate and does NOT
    // re-execute anything — it fails closed on the durable PENDING
    // reservation:
    if (second.status !== 'rejected') {
      throw new Error('the in-flight re-delivery must fail closed, not duplicate');
    }
    expect(String(second.reason)).toMatch(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
    // The rollback has been invoked ONCE (by the parked owner) and NOT by
    // the re-delivery:
    expect(rollback.invocations).toHaveLength(1);
    // Release the gate: the first delivery completes:
    rollback.release();
    const firstResult = await first;
    expect(firstResult.outcome).toBe('decided');
    expect(firstResult.decision.decision).toBe('recover');
    expect(firstResult.decision.consequencePhase).toBe('executed');
    // THE LOAD-BEARING ASSERTION: exactly ONE rollback invocation across
    // BOTH deliveries (the re-delivery never reached it):
    expect(rollback.invocations).toHaveLength(1);
    // …and exactly one record exists:
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-inflight');
    expect(history).toHaveLength(1);
  });

  it('REQUIRED CASE 3 — a CRASH between the consequence execution and the completion persistence: the record is ALREADY durable (pending); the re-delivery fails CLOSED and re-executes NOTHING', async () => {
    // The pre-correction defect this case pins: the crash window between
    // "the consequences executed" and "the record persisted". Under the
    // correction the RESERVATION preceded the consequences, so the crash
    // leaves a durable PENDING record — the re-delivery can see it and
    // therefore can NEVER re-execute the consequences.
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({ rollbackAuthority: rollback });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-crash',
      releaseRef: 'release-crash',
      outcome: 'validation_failure',
    });
    const crashingRepo = new CrashingCompletionRepository(stack.decisionRepository);
    const crashingService = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      rollbackAuthority: rollback,
      decisionRepository: crashingRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-crash',
      rolloutStage: 'canary',
      validationRunId: 'run-failed-crash',
    });
    // The first delivery: the consequences EXECUTED (the signal was
    // emitted, the rollback was invoked), then the completion write
    // "crashed":
    await expect(crashingService.decideProgressiveRelease({ ...request })).rejects.toThrowError(
      /simulated crash/,
    );
    // …but the decision record IS ALREADY DURABLE — the reservation
    // preceded the consequences (the exact ordering the correction
    // establishes; the pre-correction implementation left NO record):
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-crash');
    expect(history).toHaveLength(1);
    const pending = history[0]!;
    expect(pending.decision).toBe('recover');
    expect(pending.consequencePhase).toBe('pending');
    // The side effects DID execute before the crash:
    expect(rollback.invocations).toHaveLength(1);
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    // THE LOAD-BEARING ASSERTION — the re-delivery (over the honest
    // repository) fails CLOSED with the typed pending tombstone and
    // re-executes NOTHING (no second signal, no second rollback):
    await expect(stack.service.decideProgressiveRelease({ ...request })).rejects.toThrowError(
      /\[PR_DECISION_CONSEQUENCES_PENDING\]/,
    );
    expect(rollback.invocations).toHaveLength(1);
    expect((await stack.engineeringSignalService.listSignalsForProject('project-1')).length).toBe(1);
    expect(signals[0]!.occurrences).toHaveLength(1);
    // …and NO audit event was fabricated for the crashed delivery (the
    // record stays honest: reserved, consequences unresolved):
    expect(
      stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION'),
    ).toHaveLength(0);
  });

  it('REQUIRED CASE 4 — the PRE-EXISTING duplicate-delivery guarantee is PRESERVED: a COMPLETED decision re-delivered returns the recorded record verbatim (no consequence re-executed, no audit re-emitted)', async () => {
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({ rollbackAuthority: rollback });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-dup',
      releaseRef: 'release-dup',
      outcome: 'validation_failure',
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-dup',
      rolloutStage: 'canary',
      validationRunId: 'run-failed-dup',
    });
    const first = await stack.service.decideProgressiveRelease({ ...request });
    expect(first.outcome).toBe('decided');
    expect(first.decision.decision).toBe('recover');
    expect(first.decision.consequencePhase).toBe('executed');
    // The re-delivery — the recorded decision is returned VERBATIM:
    const second = await stack.service.decideProgressiveRelease({ ...request });
    expect(second.outcome).toBe('duplicate');
    expect(second.decision).toEqual(first.decision);
    expect(second.decision.consequencePhase).toBe('executed');
    // …and NO consequence was re-executed:
    expect(rollback.invocations).toHaveLength(1);
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.occurrences).toHaveLength(1);
    expect(
      stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION'),
    ).toHaveLength(1);
  });

  it('a CONTINUE decision reserves atomically final (no governed consequences → no pending window; concurrent duplicate deliveries converge to duplicates)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-final',
      releaseRef: 'release-final',
      outcome: 'healthy',
    });
    const request = decisionRequestFixture({
      releaseRef: 'release-final',
      validationRunId: 'run-healthy-final',
    });
    const first = await stack.service.decideProgressiveRelease({ ...request });
    expect(first.outcome).toBe('decided');
    expect(first.decision.decision).toBe('continue');
    // A continue carries NO governed consequences — its record is final
    // AT the reservation (atomically executed):
    expect(first.decision.consequencePhase).toBe('executed');
    // …and a concurrent duplicate over the stale-read window converges:
    const staleRepo = new StaleReadDecisionRepository(stack.decisionRepository);
    const racer = new DefaultProgressiveReleaseService({
      continuousValidationService: stack.continuousValidationService,
      engineeringSignalService: stack.engineeringSignalService,
      runtimeObservationReader: stack.runtimeReader,
      decisionRepository: staleRepo,
      auditWriter: stack.auditWriter,
      now: stack.clock,
    });
    const raced = await racer.decideProgressiveRelease({ ...request });
    expect(raced.outcome).toBe('duplicate');
    expect(raced.decision.decisionId).toBe(first.decision.decisionId);
    // exactly ONE record, NO signals, ONE audit event:
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-final');
    expect(history).toHaveLength(1);
    expect((await stack.engineeringSignalService.listSignalsForProject('project-1')).length).toBe(0);
    expect(
      stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION'),
    ).toHaveLength(1);
  });
});
